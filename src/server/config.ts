import path from 'node:path';
import { DEFAULT_ICE_SERVERS, parseIceServers, type IceServerConfig } from '../shared/ice';

export interface Config {
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
  /** Test-only helpers (clock control) are enabled only when NODE_ENV=test. */
  testMode: boolean;
  iceServers: IceServerConfig[];
  staticDir: string;
  trustProxyHops: number;
  /** Cloudflare Realtime TURN: short-lived credentials generated on the server. */
  cloudflareTurn?: { keyId: string; apiToken: string } | undefined;
}

function loadCloudflareTurn(env: NodeJS.ProcessEnv): Config['cloudflareTurn'] {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId && !apiToken) return undefined;
  if (!keyId) throw new Error('CLOUDFLARE_TURN_KEY_ID is required when CLOUDFLARE_TURN_API_TOKEN is set');
  if (!apiToken) throw new Error('CLOUDFLARE_TURN_API_TOKEN is required when CLOUDFLARE_TURN_KEY_ID is set');
  return { keyId, apiToken };
}

function parseInteger(name: string, value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim()) || Number(value) > max) throw new Error(`${name} must be an integer from 0 to ${max}`);
  return Number(value);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const nodeEnv = env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development';
  const iceJson = env.ICE_SERVERS_JSON?.trim();
  return {
    port: parseInteger('PORT', env.PORT, 3000, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    nodeEnv,
    testMode: nodeEnv === 'test',
    iceServers: iceJson ? parseIceServers(iceJson) : DEFAULT_ICE_SERVERS,
    staticDir: env.STATIC_DIR?.trim() || path.resolve('dist/client'),
    trustProxyHops: parseInteger('TRUST_PROXY_HOPS', env.TRUST_PROXY_HOPS, 0, 10),
    cloudflareTurn: loadCloudflareTurn(env),
  };
}
