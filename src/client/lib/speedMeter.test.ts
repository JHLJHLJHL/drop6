import { describe, expect, it } from 'vitest';
import { SpeedMeter } from './speedMeter';

describe('SpeedMeter', () => {
  it('reports 0 until two samples exist', () => {
    const meter = new SpeedMeter(3_000);
    expect(meter.bytesPerSecond).toBe(0);
    meter.record(0, 0);
    expect(meter.bytesPerSecond).toBe(0);
  });

  it('computes bytes per second over the window', () => {
    const meter = new SpeedMeter(3_000);
    meter.record(0, 0);
    meter.record(1_000_000, 1_000);
    expect(meter.bytesPerSecond).toBe(1_000_000);
    meter.record(3_000_000, 2_000);
    expect(meter.bytesPerSecond).toBe(1_500_000);
  });

  it('forgets samples older than the window so the number follows the current speed', () => {
    const meter = new SpeedMeter(1_000);
    meter.record(0, 0);
    meter.record(1_000_000, 1_000);
    meter.record(1_000_100, 2_000);
    meter.record(1_000_200, 2_500);
    expect(meter.bytesPerSecond).toBeLessThan(300);
  });

  it('reset clears the history', () => {
    const meter = new SpeedMeter(3_000);
    meter.record(0, 0);
    meter.record(100, 1_000);
    meter.reset();
    expect(meter.bytesPerSecond).toBe(0);
  });
});
