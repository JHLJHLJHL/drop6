import { useEffect } from 'react';

/**
 * Keeps the screen from dimming and locking while `active`, so a phone does not put the page to
 * sleep in the middle of a transfer. The browser lets go of the lock whenever the page is hidden
 * (another tab or app, a locked screen), so it is asked for again when the page is visible again.
 * Best effort: a browser without the API, or one that refuses (low power mode), changes nothing.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let requesting = false;
    let stopped = false;

    const acquire = async () => {
      if (stopped || requesting || lock || document.visibilityState !== 'visible') return;
      requesting = true;
      try {
        const granted = await navigator.wakeLock.request('screen');
        if (stopped) {
          void granted.release().catch(() => {});
          return;
        }
        lock = granted;
        granted.addEventListener('release', () => {
          if (lock === granted) lock = undefined;
        });
      } catch {
        // refused (low power mode, ...): the screen simply times out as usual
      } finally {
        requesting = false;
      }
    };

    const onVisibilityChange = () => void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);
    void acquire();

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
