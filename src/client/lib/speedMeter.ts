interface Sample {
  bytes: number;
  at: number;
}

/** Transfer speed over a short trailing window (cumulative byte counts in, bytes/second out). */
export class SpeedMeter {
  private samples: Sample[] = [];

  constructor(private readonly windowMs = 3_000) {}

  record(bytes: number, at = Date.now()): void {
    this.samples.push({ bytes, at });
    this.samples = this.samples.filter((sample) => sample.at >= at - this.windowMs);
  }

  get bytesPerSecond(): number {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last === first) return 0;
    const span = last.at - first.at;
    return span > 0 ? ((last.bytes - first.bytes) * 1000) / span : 0;
  }

  reset(): void {
    this.samples = [];
  }
}
