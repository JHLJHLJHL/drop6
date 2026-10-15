import { useEffect, useRef, useState } from 'react';

const MESSAGE_MS = 2_000;

/** An email address that copies itself when pressed and says so in a short toast. */
export function EmailCopy({ email }: { email: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (text: string) => {
    setMessage(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(email);
      show('복사되었습니다');
    } catch {
      show('복사하지 못했어요');
    }
  };

  return (
    <>
      <button type="button" className="email-button" aria-label={`${email} 복사`} onClick={() => void copy()}>
        {email}
      </button>
      <div className="toast-region" role="status" aria-live="polite">
        {message && <p className="toast">{message}</p>}
      </div>
    </>
  );
}
