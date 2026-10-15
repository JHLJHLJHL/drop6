import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { prepareSource, type PreparedSource } from '../lib/bundle';
import { setLeaveGuard } from '../lib/leaveGuard';
import { SenderSession, isPeerActive } from '../lib/senderSession';
import { ZipLimitError } from '../lib/zip';
import { SenderBundleError, SenderPreparing, SenderView } from './SenderView';
import { useNow } from './useNow';

interface SenderScreenProps {
  files: File[];
  onExit(): void;
}

function Connected({ session, onExit, onRenew }: { session: SenderSession; onExit(): void; onRenew(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const now = useNow(1_000);
  const transferring = state.phase === 'open' && state.peers.some(isPeerActive);

  // Closing the tab or switching to 받기 ends every transfer, so ask first while one is running.
  useEffect(() => {
    if (!transferring) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    setLeaveGuard('전송 중이에요. 나가면 전송이 멈춰요.');
    return () => {
      window.removeEventListener('beforeunload', warn);
      setLeaveGuard(null);
    };
  }, [transferring]);

  return <SenderView state={state} now={now} onLeave={onExit} onRenew={onRenew} />;
}

/**
 * Owns one SenderSession per attempt: a fresh code means a fresh session.
 * Several files are bundled into one zip first; that work is kept across attempts.
 */
export function SenderScreen({ files, onExit }: SenderScreenProps) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<SenderSession | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: files.length });
  const [failure, setFailure] = useState<string | null>(null);
  const prepared = useRef<{ files: File[]; result: Promise<PreparedSource> } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let created: SenderSession | undefined;
    setSession(null);
    setFailure(null);

    if (prepared.current?.files !== files) {
      setProgress({ done: 0, total: files.length });
      prepared.current = { files, result: prepareSource(files, (done, total) => setProgress({ done, total })) };
    }
    prepared.current.result.then(
      ({ source, fileCount }) => {
        if (cancelled) return;
        created = new SenderSession(source, fileCount);
        setSession(created);
        void created.start();
      },
      (error: unknown) => {
        if (!cancelled) setFailure(error instanceof ZipLimitError ? error.reason : 'read-failed');
      },
    );
    return () => {
      cancelled = true;
      created?.dispose();
    };
  }, [files, attempt]);

  if (failure) return <SenderBundleError reason={failure} onLeave={onExit} />;
  if (!session) {
    return files.length > 1 ? <SenderPreparing done={progress.done} total={progress.total} onLeave={onExit} /> : null;
  }
  return <Connected key={attempt} session={session} onExit={onExit} onRenew={() => setAttempt((n) => n + 1)} />;
}
