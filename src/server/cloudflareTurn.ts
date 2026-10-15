import { z } from 'zod';
import { iceServersSchema, type IceServerConfig } from '../shared/ice';
import type { Logger } from './logger';

const TTL_SECONDS = 86_400;
const RETRY_AFTER_FAILURE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// Lenient about what Cloudflare adds around the fields we need; the strict ICE schema still checks the result.
const responseSchema = z.object({
  iceServers: z.array(
    z.object({
      urls: z.union([z.string(), z.array(z.string())]),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
});

/** Browsers block port 53, so those URLs only add a timeout. */
function withoutPort53(servers: IceServerConfig[]): IceServerConfig[] {
  return servers
    .map((server) => ({ ...server, urls: server.urls.filter((url) => !/:53(\?|$)/.test(url)) }))
    .filter((server) => server.urls.length > 0);
}

/**
 * Cloudflare Realtime TURN: the key and API token stay on the server, browsers only ever
 * receive short-lived credentials. Credentials are reused for half their lifetime.
 * A failure never throws: it yields no servers (STUN-only) and is retried after a pause.
 * Nothing secret (token, key id, generated credentials, response bodies) is logged.
 */
export function createCloudflareTurn(options: CloudflareTurnOptions): () => Promise<IceServerConfig[]> {
  const { keyId, apiToken, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { servers: IceServerConfig[]; validUntil: number } | undefined;
  let inFlight: Promise<IceServerConfig[]> | undefined;

  async function request(): Promise<IceServerConfig[]> {
    try {
      const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.error('turn_credentials_failed', { status: response.status });
        cached = { servers: [], validUntil: now() + RETRY_AFTER_FAILURE_MS };
        return [];
      }
      const servers = withoutPort53(iceServersSchema.parse(responseSchema.parse(await response.json()).iceServers));
      cached = { servers, validUntil: now() + (TTL_SECONDS * 1000) / 2 };
      return servers;
    } catch {
      logger.error('turn_credentials_failed', { status: 0 });
      cached = { servers: [], validUntil: now() + RETRY_AFTER_FAILURE_MS };
      return [];
    }
  }

  return async () => {
    if (cached && now() < cached.validUntil) return cached.servers;
    inFlight ??= request().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
