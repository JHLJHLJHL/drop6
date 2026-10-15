import { describe, expect, it } from 'vitest';
import { readCodeFromHash, receiveLink } from './deepLink';

describe('receiveLink', () => {
  it('opens the receive screen with the code in the fragment (never sent to a server)', () => {
    expect(receiveLink('https://drop6.onrender.com', '163960')).toBe('https://drop6.onrender.com/receive#code=163960');
  });

  it('keeps leading zeros', () => {
    expect(receiveLink('http://127.0.0.1:4173', '004200')).toBe('http://127.0.0.1:4173/receive#code=004200');
  });
});

describe('readCodeFromHash', () => {
  it('reads a 6-digit code from the fragment', () => {
    expect(readCodeFromHash('#code=163960')).toBe('163960');
    expect(readCodeFromHash('#code=004200')).toBe('004200');
    expect(readCodeFromHash('#foo=1&code=163960&bar=2')).toBe('163960');
  });

  it('ignores anything that is not a plain 6-digit code', () => {
    for (const hash of ['', '#', '#code=', '#code=12345', '#code=1234567', '#code=abcdef', '#code=12 3456', '#other=163960', '#163960']) {
      expect(readCodeFromHash(hash), hash).toBeUndefined();
    }
  });

  it('round-trips with receiveLink', () => {
    const link = new URL(receiveLink('https://drop6.onrender.com', '482913'));
    expect(link.pathname).toBe('/receive');
    expect(readCodeFromHash(link.hash)).toBe('482913');
  });
});
