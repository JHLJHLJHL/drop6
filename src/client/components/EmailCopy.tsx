import { useCopyToast } from './CopyToast';

/** An email address that copies itself when pressed and says so in a short toast. */
export function EmailCopy({ email }: { email: string }) {
  const { copy, toast } = useCopyToast();

  return (
    <>
      <button type="button" className="email-button" aria-label={`${email} 복사`} onClick={() => void copy(email)}>
        {email}
      </button>
      {toast}
    </>
  );
}
