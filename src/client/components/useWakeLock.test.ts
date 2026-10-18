// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWakeLock } from './useWakeLock';

class FakeSentinel extends EventTarget {
  released = false;
  release = vi.fn(async () => {
    this.released = true;
    this.dispatchEvent(new Event('release'));
  });
}

let sentinels: FakeSentinel[];
let request: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  sentinels = [];
  visibility = 'visible';
  request = vi.fn(async () => {
    const sentinel = new FakeSentinel();
    sentinels.push(sentinel);
    return sentinel;
  });
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
});

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).wakeLock;
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('useWakeLock', () => {
  it('keeps the screen on while active and lets go when it stops being active', async () => {
    const { rerender } = renderHook(({ active }) => useWakeLock(active), { initialProps: { active: true } });
    await settle();
    expect(request).toHaveBeenCalledWith('screen');
    expect(sentinels[0]!.released).toBe(false);

    rerender({ active: false });
    expect(sentinels[0]!.release).toHaveBeenCalled();
  });

  it('asks for nothing while not active', async () => {
    renderHook(() => useWakeLock(false));
    await settle();
    expect(request).not.toHaveBeenCalled();
  });

  it('lets go when the screen unmounts', async () => {
    const { unmount } = renderHook(() => useWakeLock(true));
    await settle();
    unmount();
    expect(sentinels[0]!.release).toHaveBeenCalled();
  });

  it('asks again when the page comes back, since the browser drops the lock while it is hidden', async () => {
    renderHook(() => useWakeLock(true));
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    sentinels[0]!.dispatchEvent(new Event('release')); // the browser took it away
    setVisibility('hidden');
    await settle();
    expect(request).toHaveBeenCalledTimes(1); // nothing to ask for while hidden

    setVisibility('visible');
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not stack locks when the page becomes visible while one is still held', async () => {
    renderHook(() => useWakeLock(true));
    await settle();
    setVisibility('visible');
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does nothing in a browser without the API', async () => {
    delete (navigator as unknown as Record<string, unknown>).wakeLock;
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
  });

  it('shrugs off a refusal (low power mode)', async () => {
    request.mockRejectedValueOnce(new DOMException('low battery', 'NotAllowedError'));
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow();
    await settle();
    expect(sentinels).toHaveLength(0);
  });

  it('gives the lock back at once when it arrives after the screen was already left', async () => {
    const { unmount } = renderHook(() => useWakeLock(true));
    unmount(); // the request is still pending
    await settle();
    expect(sentinels[0]!.release).toHaveBeenCalled();
  });
});
