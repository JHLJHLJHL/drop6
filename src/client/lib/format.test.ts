import { describe, expect, it } from 'vitest';
import { formatBytes, formatCode, formatCountdown, formatSpeed, sanitizeFileName } from './format';

describe('formatBytes', () => {
  it('uses 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(500 * 1024 * 1024)).toBe('500 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB');
  });
});

describe('formatSpeed', () => {
  it('appends /s and shows a dash while unknown', () => {
    expect(formatSpeed(1_572_864)).toBe('1.5 MB/s');
    expect(formatSpeed(0)).toBe('-');
  });
});

describe('formatCountdown', () => {
  it('formats mm:ss and never goes negative', () => {
    expect(formatCountdown(30 * 60 * 1000)).toBe('30:00');
    expect(formatCountdown(61_000)).toBe('01:01');
    expect(formatCountdown(999)).toBe('00:00');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
  });
});

describe('formatCode', () => {
  it('groups the code as 123 456', () => {
    expect(formatCode('123456')).toBe('123 456');
    expect(formatCode('12')).toBe('12');
  });
});

describe('sanitizeFileName', () => {
  it('removes path separators and control characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFileName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeFileName('line\nbreak.txt')).toBe('line_break.txt');
  });

  it('falls back to a default name and caps the length', () => {
    expect(sanitizeFileName('   ')).toBe('drop6-file');
    expect(sanitizeFileName('a'.repeat(300)).length).toBe(200);
  });
});
