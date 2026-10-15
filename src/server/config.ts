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
  };
}
