import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CLIENT_MESSAGE_TYPES,
  MAX_MESSAGE_BYTES,
  clientMessageSchema,
  type ErrorCode,
  type ServerMessage,
} from '../shared/protocol';
import type { Logger } from './logger';
import type { SlidingWindowLimiter } from './rateLimiter';
import { errorMessage, type PeerHandle, type RoomManager } from './rooms';

export interface SignalingOptions {
  manager: RoomManager;
  joinLimiter: SlidingWindowLimiter;
  logger: Logger;
  trustProxyHops: number;
  heartbeatIntervalMs: number;
}

export interface Signaling {
  close(): Promise<void>;
}

interface Connection extends WebSocket {
  isAlive?: boolean;
}

/** Client IP: socket address, or the Nth-from-right X-Forwarded-For entry when behind trusted proxies. */
export function clientIp(req: IncomingMessage, trustProxyHops: number): string {
  const header = req.headers['x-forwarded-for'];
  if (trustProxyHops > 0 && typeof header === 'string') {
    const parts = header.split(',').map((part) => part.trim()).filter(Boolean);
    const picked = parts[Math.max(0, parts.length - trustProxyHops)];
    if (picked) return picked;
  }
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // non-browser clients; still IP rate limited
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function attachSignaling(server: Server, options: SignalingOptions): Signaling {
  const { manager, joinLimiter, logger, trustProxyHops } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/ws') return rejectUpgrade(socket, '404 Not Found');
    if (!isSameOrigin(req)) return rejectUpgrade(socket, '403 Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: Connection, req: IncomingMessage) => {
    const ip = clientIp(req, trustProxyHops);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const send = (message: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const handle: PeerHandle = { send, close: () => ws.close(1000, 'room-closed') };
    const fail = (code: ErrorCode) => send(errorMessage(code));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        fail('BINARY_NOT_SUPPORTED');
        ws.close(1003, 'binary-not-supported');
        return;
      }
      try {
        dispatch(data.toString('utf8'));
      } catch {
        logger.error('message_handler_failed');
        fail('INTERNAL');
      }
    });

    function dispatch(text: string): void {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return fail('INVALID_JSON');
      }
      if (typeof json !== 'object' || json === null || typeof (json as { type?: unknown }).type !== 'string') {
        return fail('INVALID_MESSAGE');
      }
      if (!CLIENT_MESSAGE_TYPES.includes((json as { type: string }).type)) return fail('UNKNOWN_TYPE');

      const parsed = clientMessageSchema.safeParse(json);
      if (!parsed.success) return fail('INVALID_MESSAGE');
      const message = parsed.data;

      let error: ErrorCode | undefined;
      switch (message.type) {
        case 'create-room':
          error = manager.createRoom(handle);
          break;
        case 'join-room':
          error = joinLimiter.hit(ip).allowed ? manager.joinRoom(handle, message.code) : 'RATE_LIMITED';
          break;
        case 'resume-room':
          error = manager.resumeRoom(handle, message.code, message.secret);
          break;
        case 'signal':
          error = manager.relaySignal(handle, message.to, message.data);
          break;
        case 'transfer-progress':
          error = manager.relayProgress(handle, message);
          break;
        case 'leave':
          manager.leave(handle);
          break;
      }
      if (error) fail(error);
    }

    // A sender that just vanished (asleep phone, lost network) gets time to come back; an explicit "leave" does not.
    ws.on('close', () => manager.disconnect(handle));
    ws.on('error', () => ws.terminate());
  });

  // Dead-connection cleanup: terminate anything that missed the previous ping.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients as Set<Connection>) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    joinLimiter.prune();
    manager.sweep();
  }, options.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      manager.closeAll('SERVER_SHUTDOWN');
      for (const ws of wss.clients) ws.close(1001, 'server-shutdown');
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
