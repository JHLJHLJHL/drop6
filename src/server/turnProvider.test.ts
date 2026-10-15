import { describe, expect, it, vi } from 'vitest';
import type { IceServerConfig } from '../shared/ice';
import { createTurnProvider } from './turnProvider';

const base: IceServerConfig[] = [{ urls: ['stun:stun.example.com:3478'] }];
const turn: IceServerConfig[] = [{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'c' }];

describe('createTurnProvider', () => {
  it('serves just the configured servers without Cloudflare', async () => {
    expect(await createTurnProvider({ base })()).toEqual(base);
  });

  it('adds the Cloudflare servers to the configured ones', async () => {
    const cloudflare = vi.fn(async () => turn);
    expect(await createTurnProvider({ base, cloudflare })()).toEqual([...base, ...turn]);
    expect(cloudflare).toHaveBeenCalledTimes(1);
  });

  it('adds them while the usage limit allows it', async () => {
    const cloudflare = vi.fn(async () => turn);
    const budget = vi.fn(async () => true);
    expect(await createTurnProvider({ base, cloudflare, budget })()).toEqual([...base, ...turn]);
  });

  it('serves STUN only, and generates no TURN credentials, once the usage limit is reached', async () => {
    const cloudflare = vi.fn(async () => turn);
    let allowed = false;
    const provider = createTurnProvider({ base, cloudflare, budget: async () => allowed });

    expect(await provider()).toEqual(base);
    expect(cloudflare).not.toHaveBeenCalled();

    allowed = true; // checked on every request, so it recovers by itself
    expect(await provider()).toEqual([...base, ...turn]);
  });

  it('keeps serving the configured servers when the budget check itself throws', async () => {
    const provider = createTurnProvider({
      base,
      cloudflare: async () => turn,
      budget: async () => {
        throw new Error('boom');
      },
    });
    expect(await provider()).toEqual(base);
  });
});
