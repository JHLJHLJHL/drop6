import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './rateLimiter';

function setup(max = 3, windowMs = 60_000) {
  const clock = { time: 0, now() { return this.time; } };
  return { clock, limiter: new SlidingWindowLimiter({ max, windowMs, clock }) };
}

describe('SlidingWindowLimiter', () => {
  it('allows up to max hits per key inside the window', () => {
    const { limiter } = setup(3);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('tracks keys independently', () => {
    const { limiter } = setup(1);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('reports how long to wait and frees up once the oldest hit leaves the window', () => {
    const { limiter, clock } = setup(2, 60_000);
    limiter.hit('a');
    clock.time = 10_000;
    limiter.hit('a');
    clock.time = 20_000;
    const blocked = limiter.hit('a');
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 40_000 });
    clock.time = 60_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('does not count blocked attempts against the caller', () => {
    const { limiter, clock } = setup(1, 1_000);
    limiter.hit('a');
    for (let i = 0; i < 50; i += 1) limiter.hit('a');
    clock.time = 1_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('forgets idle keys', () => {
    const { limiter, clock } = setup(1, 1_000);
    limiter.hit('a');
    clock.time = 5_000;
    limiter.prune();
    expect(limiter.size).toBe(0);
  });

  it('reset clears all state', () => {
    const { limiter } = setup(1);
    limiter.hit('a');
    limiter.reset();
    expect(limiter.hit('a').allowed).toBe(true);
  });
});
