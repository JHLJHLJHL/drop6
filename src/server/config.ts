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
  cloudflareTurn?: CloudflareTurnConfig | undefined;
}

export interface CloudflareTurnConfig {
  keyId: string;
  apiToken: string;
  /** Stops handing out TURN credentials once the key's usage reaches the limit. */
  usageLimit?: { accountId: string; analyticsToken: string; limitGb: number } | undefined;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_TURN_LIMIT_GB = 800;

function loadUsageLimit(env: NodeJS.ProcessEnv, turn: { keyId: string } | undefined): CloudflareTurnConfig['usageLimit'] {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const analyticsToken = env.CLOUDFLARE_ANALYTICS_API_TOKEN?.trim();
  const limitRaw = env.TURN_MONTHLY_LIMIT_GB?.trim();
  if (!accountId && !analyticsToken && !limitRaw) return undefined;

  // A limit nothing could enforce must fail loudly instead of silently running uncapped.
  if (!turn) throw new Error('CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN are required for a TURN usage limit');
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required for the TURN usage limit');
  if (!analyticsToken) throw new Error('CLOUDFLARE_ANALYTICS_API_TOKEN is required for the TURN usage limit');
  if (!ID_PATTERN.test(accountId)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a plain Cloudflare account id');

  let limitGb = DEFAULT_TURN_LIMIT_GB;
  if (limitRaw) {
    if (!/^\d+(\.\d+)?$/.test(limitRaw) || Number(limitRaw) <= 0) throw new Error('TURN_MONTHLY_LIMIT_GB must be a positive number');
    limitGb = Number(limitRaw);
  }
  return { accountId, analyticsToken, limitGb };
}

function loadCloudflareTurn(env: NodeJS.ProcessEnv): Config['cloudflareTurn'] {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId && !apiToken) {
    loadUsageLimit(env, undefined); // throws if a usage limit was configured without TURN
    return undefined;
  }
  if (!keyId) throw new Error('CLOUDFLARE_TURN_KEY_ID is required when CLOUDFLARE_TURN_API_TOKEN is set');
  if (!apiToken) throw new Error('CLOUDFLARE_TURN_API_TOKEN is required when CLOUDFLARE_TURN_KEY_ID is set');
  if (!ID_PATTERN.test(keyId)) throw new Error('CLOUDFLARE_TURN_KEY_ID must be a plain Cloudflare TURN key id');
  return { keyId, apiToken, usageLimit: loadUsageLimit(env, { keyId }) };
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
