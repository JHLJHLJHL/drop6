import { describe, expect, it, vi } from 'vitest';
import type { Logger } from './logger';
import { createTurnBudget } from './turnBudget';

const ACCOUNT_ID = 'acc0123456789abcdef0123456789abcd';
const KEY_ID = 'key0123456789abcdef0123456789abcd';
const TOKEN = 'analytics-secret-token-value';
const LIMIT_GB = 800;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function usage(...bytes: number[]) {
  return {
    data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: bytes.map((egressBytes) => ({ sum: { egressBytes } })) }] } },
    errors: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(responder: () => Response | Promise<Response> = () => jsonResponse(usage(5e9))) {
  const clock = { time: NOW };
  const fetchImpl = vi.fn(async () => responder());
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const logger: Logger = {
    info: (event, fields) => logs.push([event, fields]),
    error: (event, fields) => logs.push([event, fields]),
  };
  const allowed = createTurnBudget({
    accountId: ACCOUNT_ID,
    keyId: KEY_ID,
    apiToken: TOKEN,
    limitGb: LIMIT_GB,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock.time,
    logger,
  });
  return { clock, fetchImpl, logs, allowed };
}

describe('createTurnBudget', () => {
  it('asks the Cloudflare analytics API for the key egress of the last 31 days', async () => {
    const { allowed, fetchImpl } = setup();
    await allowed();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const { query } = JSON.parse(init.body as string) as { query: string };
    expect(query).toContain('callsTurnUsageAdaptiveGroups');
    expect(query).toContain('egressBytes');
    expect(query).toContain(`accountTag: "${ACCOUNT_ID}"`);
    expect(query).toContain(`keyId: "${KEY_ID}"`);
    expect(query).toContain('date_geq: "2026-09-15"'); // 31 days including today
    expect(query).toContain('date_leq: "2026-10-15"');
  });

  it('allows TURN while the usage is below the limit', async () => {
    expect(await setup(() => jsonResponse(usage(5e9))).allowed()).toBe(true);
    expect(await setup(() => jsonResponse(usage(LIMIT_GB * 1e9 - 1))).allowed()).toBe(true);
  });

  it('stops TURN once the usage reaches the limit', async () => {
    expect(await setup(() => jsonResponse(usage(LIMIT_GB * 1e9))).allowed()).toBe(false);
    expect(await setup(() => jsonResponse(usage(LIMIT_GB * 1e9 + 1))).allowed()).toBe(false);
  });

  it('adds up several groups and treats no data as zero usage', async () => {
    expect(await setup(() => jsonResponse(usage(400e9, 400e9))).allowed()).toBe(false);
    expect(await setup(() => jsonResponse(usage(300e9, 400e9))).allowed()).toBe(true);
    expect(await setup(() => jsonResponse(usage())).allowed()).toBe(true);
  });

  it('checks again only every few minutes, and shares one request between concurrent callers', async () => {
    const { allowed, fetchImpl, clock } = setup();
    await Promise.all([allowed(), allowed(), allowed()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.time += 5 * 60_000 - 1;
    await allowed();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.time += 1;
    await allowed();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('notices when the limit is reached and when usage drops again, logging each change once', async () => {
    let bytes = 5e9;
    const { allowed, clock, logs } = setup(() => jsonResponse(usage(bytes)));
    expect(await allowed()).toBe(true);

    bytes = LIMIT_GB * 1e9 + 5e9;
    clock.time += 5 * 60_000;
    expect(await allowed()).toBe(false);
    clock.time += 5 * 60_000;
    expect(await allowed()).toBe(false);
    expect(logs.filter(([event]) => event === 'turn_limit_reached')).toHaveLength(1);
    expect(logs.find(([event]) => event === 'turn_limit_reached')?.[1]).toMatchObject({ usedGb: 805, limitGb: LIMIT_GB });

    bytes = 100e9; // older days dropped out of the 31 day window
    clock.time += 5 * 60_000;
    expect(await allowed()).toBe(true);
    expect(logs.filter(([event]) => event === 'turn_limit_cleared')).toHaveLength(1);
  });

  it.each([
    ['an HTTP error', () => jsonResponse({ errors: [{ message: 'forbidden' }] }, 403)],
    ['a GraphQL error', () => jsonResponse({ data: null, errors: [{ message: 'unknown field' }] })],
    ['an unknown account', () => jsonResponse({ data: { viewer: { accounts: [] } }, errors: null })],
    ['an unexpected answer', () => jsonResponse({ hello: 'world' })],
    ['a non-JSON answer', () => new Response('<html></html>', { status: 200 })],
    [
      'a network error',
      () => {
        throw new Error('socket hang up');
      },
    ],
  ])('stops TURN (fails closed) on %s and retries after a minute', async (_name, responder) => {
    const { allowed, fetchImpl, clock, logs } = setup(responder);
    expect(await allowed()).toBe(false);
    expect(await allowed()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logs.some(([event]) => event === 'turn_usage_check_failed')).toBe(true);
    clock.time += 60_000;
    await allowed();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('allows TURN again as soon as a later check succeeds', async () => {
    let ok = false;
    const { allowed, clock } = setup(() => (ok ? jsonResponse(usage(1e9)) : jsonResponse({}, 500)));
    expect(await allowed()).toBe(false);
    ok = true;
    clock.time += 60_000;
    expect(await allowed()).toBe(true);
  });

  it('never logs the token, the account id or the key id', async () => {
    const failing = setup(() => jsonResponse({ errors: [{ message: TOKEN }] }, 403));
    await failing.allowed();
    const reached = setup(() => jsonResponse(usage(LIMIT_GB * 1e9 + 1)));
    await reached.allowed();
    const written = JSON.stringify([...failing.logs, ...reached.logs]);
    for (const secret of [TOKEN, ACCOUNT_ID, KEY_ID]) expect(written).not.toContain(secret);
  });

  it('refuses ids that could change the query', () => {
    const make = (accountId: string, keyId: string) =>
      createTurnBudget({ accountId, keyId, apiToken: TOKEN, limitGb: 1, logger: { info() {}, error() {} } });
    expect(() => make('abc" } } evil', KEY_ID)).toThrow(/invalid/);
    expect(() => make(ACCOUNT_ID, 'key"; drop')).toThrow(/invalid/);
    expect(() => make(ACCOUNT_ID, KEY_ID)).not.toThrow();
  });
});
