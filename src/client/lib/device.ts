/**
 * True on phones and tablets (finger as the primary input, no hover).
 * Focusing a text field there opens the keyboard and makes iOS Safari scroll the page,
 * so fields must not grab focus on their own.
 */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}
