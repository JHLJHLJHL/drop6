import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'text';
  loading?: boolean;
}

export function Button({ variant = 'primary', loading = false, disabled, className, children, ...rest }: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, loading ? 'is-loading' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * Page title. Takes focus on mount so screen readers announce each new state.
 * Pass focusOnMount={false} on screens that already focus something better
 * (the code field) or that are the first thing on page load.
 */
export function Heading({ children, focusOnMount = true }: { children: ReactNode; focusOnMount?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  return (
    <h1 className="title" ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}

/** Centered page title with its optional subtitle. */
export function TitleBlock({ title, sub, focusOnMount }: { title: ReactNode; sub?: ReactNode; focusOnMount?: boolean }) {
  return (
    <div className="heading-center">
      <Heading {...(focusOnMount === undefined ? {} : { focusOnMount })}>{title}</Heading>
      {sub && <p className="sub">{sub}</p>}
    </div>
  );
}

export function PrivacyNote() {
  return <p className="note privacy-note">파일은 암호화되어 전송, 서버에 저장하지 않음</p>;
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.floor(percent)));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className="progress-fill" style={{ width: `${value}%` }} />
    </div>
  );
}

export function FileCard({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="file-card">
      <span className="file-name">{name}</span>
      <span className="file-detail">{detail}</span>
    </div>
  );
}

export function Alert({ title, body }: { title: string; body: string }) {
  return (
    <div className="alert" role="alert">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

export function percentOf(done: number, total: number): number {
  if (total <= 0) return done > 0 ? 100 : 0;
  return (done / total) * 100;
}
