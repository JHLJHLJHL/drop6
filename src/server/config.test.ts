import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ICE_SERVERS } from '../shared/ice';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('uses safe defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      port: 3000,
      host: '0.0.0.0',
      nodeEnv: 'development',
      testMode: false,
      trustProxyHops: 0,
      iceServers: DEFAULT_ICE_SERVERS,
    });
    expect(config.staticDir).toBe(path.resolve('dist/client'));
  });

  it('reads PORT, HOST and TRUST_PROXY_HOPS', () => {
    const config = loadConfig({ PORT: '10000', HOST: '127.0.0.1', TRUST_PROXY_HOPS: '2' });
    expect(config).toMatchObject({ port: 10000, host: '127.0.0.1', trustProxyHops: 2 });
  });

  it('enables test mode only for NODE_ENV=test', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).testMode).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production' }).testMode).toBe(false);
    expect(loadConfig({ NODE_ENV: 'development' }).testMode).toBe(false);
  });

  it('parses ICE_SERVERS_JSON and accepts an explicit empty list', () => {
    const turn = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }];
    expect(loadConfig({ ICE_SERVERS_JSON: JSON.stringify(turn) }).iceServers).toEqual([
      { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' },
    ]);
    expect(loadConfig({ ICE_SERVERS_JSON: '[]' }).iceServers).toEqual([]);
  });

  it('treats a blank ICE_SERVERS_JSON as unset', () => {
    expect(loadConfig({ ICE_SERVERS_JSON: '  ' }).iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('rejects invalid ICE config without echoing secrets', () => {
    const secret = 'super-secret-credential';
    const bad = JSON.stringify([{ urls: ['http://not-ice.example.com'], username: 'u', credential: secret }]);
    expect(() => loadConfig({ ICE_SERVERS_JSON: bad })).toThrow(/ICE_SERVERS_JSON/);
    expect(() => loadConfig({ ICE_SERVERS_JSON: bad })).not.toThrow(new RegExp(secret));
    expect(() => loadConfig({ ICE_SERVERS_JSON: '{oops' })).toThrow(/not valid JSON/);
    const noCreds = JSON.stringify([{ urls: ['turn:turn.example.com:3478'] }]);
    expect(() => loadConfig({ ICE_SERVERS_JSON: noCreds })).toThrow(/invalid entries/);
  });

  it('rejects a malformed PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});
