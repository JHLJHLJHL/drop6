import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const TURN = { CLOUDFLARE_TURN_KEY_ID: 'turnkey1234567890', CLOUDFLARE_TURN_API_TOKEN: 'turn-token' };
const USAGE = { CLOUDFLARE_ACCOUNT_ID: 'account1234567890', CLOUDFLARE_ANALYTICS_API_TOKEN: 'analytics-token' };

describe('loadConfig, TURN usage limit', () => {
  it('has no limit unless the analytics credentials are given', () => {
    expect(loadConfig(TURN).cloudflareTurn?.usageLimit).toBeUndefined();
  });

  it('turns the limit on with the account id and analytics token, 800 GB by default', () => {
    const config = loadConfig({ ...TURN, ...USAGE });
    expect(config.cloudflareTurn?.usageLimit).toEqual({
      accountId: 'account1234567890',
      analyticsToken: 'analytics-token',
      limitGb: 800,
    });
  });

  it('reads TURN_MONTHLY_LIMIT_GB, including decimals', () => {
    expect(loadConfig({ ...TURN, ...USAGE, TURN_MONTHLY_LIMIT_GB: '500' }).cloudflareTurn?.usageLimit?.limitGb).toBe(500);
    expect(loadConfig({ ...TURN, ...USAGE, TURN_MONTHLY_LIMIT_GB: '12.5' }).cloudflareTurn?.usageLimit?.limitGb).toBe(12.5);
  });

  it('rejects limits that are not a positive number', () => {
    for (const bad of ['0', '-5', 'abc', '1e3x', 'Infinity']) {
      expect(() => loadConfig({ ...TURN, ...USAGE, TURN_MONTHLY_LIMIT_GB: bad })).toThrow(/TURN_MONTHLY_LIMIT_GB/);
    }
  });

  it('needs both the account id and the analytics token', () => {
    expect(() => loadConfig({ ...TURN, CLOUDFLARE_ACCOUNT_ID: 'account1234567890' })).toThrow(/CLOUDFLARE_ANALYTICS_API_TOKEN/);
    expect(() => loadConfig({ ...TURN, CLOUDFLARE_ANALYTICS_API_TOKEN: 'analytics-token' })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  it('refuses a limit that nothing could enforce, instead of silently running uncapped', () => {
    expect(() => loadConfig({ ...TURN, TURN_MONTHLY_LIMIT_GB: '500' })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => loadConfig({ ...USAGE })).toThrow(/CLOUDFLARE_TURN_KEY_ID/);
  });

  it('only accepts plain ids so they cannot alter the API request or query', () => {
    expect(() => loadConfig({ ...TURN, ...USAGE, CLOUDFLARE_ACCOUNT_ID: 'abc" } evil' })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => loadConfig({ ...USAGE, ...TURN, CLOUDFLARE_TURN_KEY_ID: '../keys/x' })).toThrow(/CLOUDFLARE_TURN_KEY_ID/);
  });

  it('never puts a secret into an error message', () => {
    const secret = 'super-secret-analytics-token';
    try {
      loadConfig({ ...TURN, CLOUDFLARE_ANALYTICS_API_TOKEN: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
