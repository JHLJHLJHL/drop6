import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig, Cloudflare TURN', () => {
  it('is off by default', () => {
    expect(loadConfig({}).cloudflareTurn).toBeUndefined();
  });

  it('reads the TURN key id and API token together', () => {
    const config = loadConfig({ CLOUDFLARE_TURN_KEY_ID: ' abc ', CLOUDFLARE_TURN_API_TOKEN: ' token ' });
    expect(config.cloudflareTurn).toEqual({ keyId: 'abc', apiToken: 'token' });
  });

  it('treats blank values as unset', () => {
    expect(loadConfig({ CLOUDFLARE_TURN_KEY_ID: '', CLOUDFLARE_TURN_API_TOKEN: '  ' }).cloudflareTurn).toBeUndefined();
  });

  it('refuses a half-configured pair without echoing the secret', () => {
    const secret = 'only-the-token-secret';
    expect(() => loadConfig({ CLOUDFLARE_TURN_API_TOKEN: secret })).toThrow(/CLOUDFLARE_TURN_KEY_ID/);
    expect(() => loadConfig({ CLOUDFLARE_TURN_KEY_ID: 'abc' })).toThrow(/CLOUDFLARE_TURN_API_TOKEN/);
    try {
      loadConfig({ CLOUDFLARE_TURN_API_TOKEN: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('keeps ICE_SERVERS_JSON working next to it', () => {
    const config = loadConfig({ ICE_SERVERS_JSON: '[]', CLOUDFLARE_TURN_KEY_ID: 'abc', CLOUDFLARE_TURN_API_TOKEN: 'token' });
    expect(config.iceServers).toEqual([]);
    expect(config.cloudflareTurn).toBeDefined();
  });
});
