import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { IceServerConfig } from '../shared/ice';
import type { Logger } from './logger';

export interface TestControls {
  advanceClock(ms: number): void;
  reset(): void;
}

export interface HttpHandlerOptions {
  iceServers: IceServerConfig[];
  staticDir: string;
  testControls?: TestControls | undefined;
  logger: Logger;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}

async function readJsonBody(req: IncomingMessage, limit = 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function fileInfo(file: string) {
  try {
    const info = await stat(file);
    return info.isFile() ? info : undefined;
  } catch {
    return undefined;
  }
}

function sendFile(res: ServerResponse, file: string, size: number, cache: string): void {
  res.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': cache,
  });
  if (res.req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeline(createReadStream(file), res, () => res.destroy());
}

async function serveStatic(res: ServerResponse, staticDir: string, pathname: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST' });
    return;
  }
  const root = path.resolve(staticDir);
  const target = path.resolve(root, `.${decoded.replaceAll('\\', '/')}`);
  const inside = target === root || target.startsWith(root + path.sep);

  if (inside && !decoded.includes('\0')) {
    const info = await fileInfo(target);
    if (info) {
      const hashed = decoded.startsWith('/assets/');
      sendFile(res, target, info.size, hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      return;
    }
  }

  // Unknown "page" paths fall back to the SPA shell; unknown files stay 404.
  if (path.extname(decoded) === '') {
    const index = path.join(root, 'index.html');
    const info = await fileInfo(index);
    if (info) {
      sendFile(res, index, info.size, 'no-cache');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Frontend is not built. Run "npm run build", or use "npm run dev" for development.');
    return;
  }
  sendJson(res, 404, { error: 'NOT_FOUND' });
}

async function handleTestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  controls: TestControls,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (pathname === '/__test__/reset') {
    controls.reset();
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (pathname === '/__test__/clock/advance') {
    const body = (await readJsonBody(req)) as { ms?: unknown };
    if (typeof body.ms !== 'number' || !Number.isFinite(body.ms) || body.ms < 0) {
      sendJson(res, 400, { error: 'BAD_REQUEST' });
      return true;
    }
    controls.advanceClock(body.ms);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

export function createHttpHandler(options: HttpHandlerOptions): RequestListener {
  const { iceServers, staticDir, testControls, logger } = options;

  return (req, res) => {
    void (async () => {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', CSP);
      res.setHeader('x-frame-options', 'DENY');

      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      const readOnly = req.method === 'GET' || req.method === 'HEAD';

      if (testControls && pathname.startsWith('/__test__/') && (await handleTestRoute(req, res, pathname, testControls))) {
        return;
      }
      if (readOnly && pathname === '/health') {
        sendJson(res, 200, { status: 'ok' }, { 'cache-control': 'no-store' });
        return;
      }
      if (readOnly && pathname === '/api/config') {
        sendJson(res, 200, { iceServers }, { 'cache-control': 'no-store' });
        return;
      }
      if (pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/__test__/')) {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      if (pathname === '/ws') {
        sendJson(res, 426, { error: 'UPGRADE_REQUIRED' }, { upgrade: 'websocket' });
        return;
      }
      if (!readOnly) {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, HEAD' });
        return;
      }
      await serveStatic(res, staticDir, pathname);
    })().catch(() => {
      // Never leak internals: log a static label, answer with a generic body.
      logger.error('http_handler_failed');
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL' });
      else res.destroy();
    });
  };
}
