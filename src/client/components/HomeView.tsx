import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Button, PrivacyNote, TitleBlock } from './ui';

interface HomeViewProps {
  /** One or more files. Several files are bundled into a single zip before sending. */
  onFiles(files: File[]): void;
}

function containsFolder(items: DataTransferItemList | undefined): boolean {
  return Array.from(items ?? []).some((item) => item.webkitGetAsEntry?.()?.isDirectory === true);
}

export function HomeView({ onFiles }: HomeViewProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string>();

  const choose = (files: File[]) => {
    if (files.length === 0) return;
    setError(undefined);
    onFiles(files);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    choose(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (containsFolder(event.dataTransfer.items)) {
      setError('폴더는 보낼 수 없어요. 파일을 골라주세요.');
    } else {
      choose(Array.from(event.dataTransfer.files));
    }
  };

  return (
    <section className="card stack">
      <TitleBlock title="어떤 파일을 보낼까요?" sub="파일을 고르면 6자리 코드를 만들어드려요" focusOnMount={false} />

      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        {/* The refusal takes the hint's place, so the card keeps its height. */}
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : (
          <p>여기에 파일을 끌어다 놓아도 돼요</p>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="보낼 파일 선택"
        onChange={handleChange}
      />
      <Button onClick={() => inputRef.current?.click()}>파일 고르기</Button>
      <PrivacyNote />
    </section>
  );
}
