import { useEffect, useRef, useState } from 'react';

const MESSAGE_MS = 2_000;

/**
 * Copies text to the clipboard and says so in a short toast that fades after a moment.
 * Render `toast` once, anywhere in the view that calls `copy`.
 */
export function useCopyToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (text: string) => {
    setMessage(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      show('복사되었습니다');
    } catch {
      show('복사하지 못했어요');
    }
  };

  const toast = (
    <div className="toast-region" role="status" aria-live="polite">
      {message && <p className="toast">{message}</p>}
    </div>
  );

  return { copy, toast };
}
