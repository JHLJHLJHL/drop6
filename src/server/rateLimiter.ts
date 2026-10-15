import type { Clock } from './rooms';

export interface LimiterOptions {
  max: number;
  windowMs: number;
  clock?: Clock | undefined;
}

export type HitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Sliding-window counter per key. Blocked attempts are not recorded. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly clock: Clock;

  constructor(options: LimiterOptions) {
    this.max = options.max;
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  get size(): number {
    return this.hits.size;
  }

  hit(key: string): HitResult {
    const now = this.clock.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: recent[0]! + this.windowMs - now };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  /** Drops keys with no hit inside the window so the map cannot grow forever. */
  prune(): void {
    const now = this.clock.now();
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}
