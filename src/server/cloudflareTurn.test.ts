import { describe, expect, it, vi } from 'vitest';
import { createCloudflareTurn } from './cloudflareTurn';
import type { Logger } from './logger';

const KEY_ID = 'key-id-123';
const TOKEN = 'super-secret-api-token';

const CLOUDFLARE_RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
      ],
      username: 'generated-user',
      credential: 'generated-credential',
    },
  ],
};

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(responder: () => Response | Promise<Response> = () => jsonResponse(CLOUDFLARE_RESPONSE)) {
  const clock = { time: 1_000_000 };
  const fetchImpl = vi.fn(async () => responder());
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const logger: Logger = {
    info: (event, fields) => logs.push([event, fields]),
    error: (event, fields) => logs.push([event, fields]),
  };
  const get = createCloudflareTurn({
    keyId: KEY_ID,
    apiToken: TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => clock.time,
    logger,
  });
  return { clock, fetchImpl, logs, get };
}

describe('createCloudflareTurn', () => {
  it('asks Cloudflare for short-lived ICE servers with the TURN key', async () => {
    const { get, fetchImpl } = setup();
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 86_400 });
  });

  it('returns validated servers and drops the port 53 URLs browsers block', async () => {
    const servers = await setup().get();
    expect(servers).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
        ],
        username: 'generated-user',
        credential: 'generated-credential',
      },
    ]);
  });

  it('tolerates extra fields and a single string url in the answer', async () => {
    const { get } = setup(() =>
      jsonResponse({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478', region: 'ap', extra: { a: 1 } }],
        requestId: 'abc',
      }),
    );
    expect(await get()).toEqual([{ urls: ['stun:stun.cloudflare.com:3478'] }]);
  });

  it('reuses credentials until half of their lifetime has passed, then refreshes', async () => {
    const { get, fetchImpl, clock } = setup();
    await get();
    clock.time += 12 * 3_600_000 - 1;
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.time += 1;
    await get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    const { get, fetchImpl } = setup();
    const results = await Promise.all([get(), get(), get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[2]);
  });

  it('gives no servers (instead of failing) when Cloudflare rejects the key, and retries after a pause', async () => {
    let status = 401;
    const { get, fetchImpl, clock } = setup(() => (status === 401 ? jsonResponse({ error: 'nope' }, 401) : jsonResponse(CLOUDFLARE_RESPONSE)));
    expect(await get()).toEqual([]);
    expect(await get()).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not hammered while failing

    status = 201;
    clock.time += 30_000;
    expect((await get()).length).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('survives network errors and malformed answers', async () => {
    const network = setup(() => {
      throw new Error('socket hang up');
    });
    expect(await network.get()).toEqual([]);

    const malformed = setup(() => jsonResponse({ iceServers: [{ urls: ['turn:t.example.com:3478'] }] }));
    expect(await malformed.get()).toEqual([]); // TURN without credentials is rejected

    const garbage = setup(() => new Response('<html>oops</html>', { status: 201 }));
    expect(await garbage.get()).toEqual([]);
  });

  it('never writes the API token or the generated credentials to the log', async () => {
    const failing = setup(() => jsonResponse({ error: TOKEN }, 403));
    await failing.get();
    const ok = setup();
    await ok.get();
    const written = JSON.stringify([...failing.logs, ...ok.logs]);
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain('generated-credential');
    expect(written).not.toContain('generated-user');
    expect(written).not.toContain(KEY_ID);
    expect(failing.logs.some(([event]) => event === 'turn_credentials_failed')).toBe(true);
  });
});
