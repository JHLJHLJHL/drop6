import { CODE_PATTERN } from '../../shared/protocol';

/**
 * Link that opens the receive screen with the code already filled in (what the QR code holds).
 * The code travels in the fragment, so it is never sent to any server or written to request logs.
 */
export function receiveLink(origin: string, code: string): string {
  return `${origin}/receive#code=${code}`;
}

/** The 6-digit code in a `#code=123456` fragment, or undefined for anything else. */
export function readCodeFromHash(hash: string): string | undefined {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('code');
  return value !== null && CODE_PATTERN.test(value) ? value : undefined;
}
