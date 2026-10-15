import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Button, Heading, PrivacyNote } from './ui';

interface HomeViewProps {
  onFile(file: File): void;
  onOpenReceive(): void;
}

function containsFolder(items: DataTransferItemList | undefined): boolean {
  return Array.from(items ?? []).some((item) => item.webkitGetAsEntry?.()?.isDirectory === true);
}

export function HomeView({ onFile, onOpenReceive }: HomeViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>();

  const choose = (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    onFile(file);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    choose(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (containsFolder(event.dataTransfer.items)) {
      setError('폴더는 보낼 수 없어요. 파일을 하나 골라주세요.');
    } else if (files.length > 1) {
      setError('파일은 한 번에 하나씩 보낼 수 있어요.');
    } else {
      choose(files[0]);
    }
  };

  return (
    <section className="card stack">
      <div>
        <Heading focusOnMount={false}>어떤 파일을 보낼까요?</Heading>
        <p className="sub">파일을 고르면 6자리 코드를 만들어드려요.</p>
      </div>

      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <p>여기에 파일을 끌어다 놓아도 돼요</p>
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <input ref={inputRef} type="file" className="sr-only" tabIndex={-1} aria-label="보낼 파일 선택" onChange={handleChange} />
      <Button onClick={() => inputRef.current?.click()}>파일 고르기</Button>

      <a
        className="text-link"
        href="/receive"
        onClick={(event) => {
          event.preventDefault();
          onOpenReceive();
        }}
      >
        파일을 받으러 오셨나요? 코드 입력하기
      </a>
      <PrivacyNote />
    </section>
  );
}
