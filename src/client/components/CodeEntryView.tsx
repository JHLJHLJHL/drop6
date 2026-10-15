import { useState, type FormEvent } from 'react';
import { CODE_PATTERN } from '../../shared/protocol';
import { formatCode } from '../lib/format';
import type { Message } from '../lib/messages';
import { Alert, Button, Heading } from './ui';

interface CodeEntryViewProps {
  onSubmit(code: string): void;
  onOpenHome(): void;
  error?: Message | undefined;
  busy?: boolean;
  initialCode?: string;
}

export function CodeEntryView({ onSubmit, onOpenHome, error, busy = false, initialCode = '' }: CodeEntryViewProps) {
  const [digits, setDigits] = useState(initialCode.replace(/\D/g, '').slice(0, 6));
  const valid = CODE_PATTERN.test(digits);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !busy) onSubmit(digits);
  };

  return (
    <section className="card stack">
      <div>
        <Heading focusOnMount={false}>전송 코드를 입력해주세요</Heading>
        <p className="sub">보내는 사람이 알려준 6자리 코드예요.</p>
      </div>

      <form className="stack" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="transfer-code-input">
          전송 코드
        </label>
        <input
          id="transfer-code-input"
          className="code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="000 000"
          aria-invalid={error ? true : undefined}
          value={formatCode(digits)}
          onChange={(event) => setDigits(event.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        {error && <Alert title={error.title} body={error.body} />}
        <Button type="submit" loading={busy} disabled={!valid}>
          {busy ? '연결하는 중이에요' : '연결하기'}
        </Button>
      </form>

      <p className="note">30분이 지나도 진행 중인 전송은 계속돼요.</p>
      <a
        className="text-link"
        href="/"
        onClick={(event) => {
          event.preventDefault();
          onOpenHome();
        }}
      >
        파일을 보내러 오셨나요?
      </a>
    </section>
  );
}
