// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTouchDevice } from '../lib/device';
import { CodeEntryView } from './CodeEntryView';

type MatchMedia = typeof window.matchMedia;

function mockMatchMedia(matches: (query: string) => boolean): void {
  window.matchMedia = ((query: string) => ({ matches: matches(query), media: query })) as unknown as MatchMedia;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { matchMedia?: MatchMedia }).matchMedia;
});

describe('isTouchDevice', () => {
  it('is false when the browser cannot tell (treated as desktop)', () => {
    expect(isTouchDevice()).toBe(false);
  });

  it('is true for a phone-like primary input (no hover, coarse pointer)', () => {
    mockMatchMedia((query) => query === '(hover: none) and (pointer: coarse)');
    expect(isTouchDevice()).toBe(true);
  });

  it('is false for a mouse', () => {
    mockMatchMedia(() => false);
    expect(isTouchDevice()).toBe(false);
  });
});

describe('code field focus', () => {
  it('focuses the field on desktop, without scrolling the page', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<CodeEntryView onSubmit={() => {}} />);
    expect(screen.getByLabelText('전송 코드')).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('does not focus the field on a touch device, so the keyboard stays closed and the page stays put', () => {
    mockMatchMedia((query) => query === '(hover: none) and (pointer: coarse)');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<CodeEntryView onSubmit={() => {}} />);
    expect(screen.getByLabelText('전송 코드')).not.toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
  });

  it('never uses the autofocus attribute, which scrolls the page on iPhone Safari', () => {
    render(<CodeEntryView onSubmit={() => {}} />);
    expect(screen.getByLabelText('전송 코드')).not.toHaveAttribute('autofocus');
  });
});
