import { useState, type FormEvent } from 'react';
import { CODE_PATTERN } from '../../shared/protocol';
import { formatCode } from '../lib/format';
import type { Message } from '../lib/messages';
import { Alert, Button, TitleBlock } from './ui';

interface CodeEntryViewProps {
  onSubmit(code: string): void;
  error?: Message | undefined;
  busy?: boolean;
  initialCode?: string;
}

export function CodeEntryView({ onSubmit, error, busy = false, initialCode = '' }: CodeEntryViewProps) {
  const [digits, setDigits] = useState(initialCode.replace(/\D/g, '').slice(0, 6));
  const valid = CODE_PATTERN.test(digits);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !busy) onSubmit(digits);
  };

  return (
    <section className="card stack">
      <TitleBlock title="전송 코드를 입력해주세요" sub="보내는 사람이 알려준 6자리 코드예요" focusOnMount={false} />

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

    </section>
  );
}
