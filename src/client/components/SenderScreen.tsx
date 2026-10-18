import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { prepareSource, type PreparedSource } from '../lib/bundle';
import { setLeaveGuard } from '../lib/leaveGuard';
import { SenderSession, isPeerActive } from '../lib/senderSession';
import { ZipLimitError } from '../lib/zip';
import { SenderBundleError, SenderPreparing, SenderView } from './SenderView';
import { useNow } from './useNow';
import { useWakeLock } from './useWakeLock';

interface SenderScreenProps {
  files: File[];
  onExit(): void;
}

function Connected({ session, onExit, onRenew }: { session: SenderSession; onExit(): void; onRenew(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const now = useNow(1_000);
  const transferring = state.phase === 'open' && state.peers.some(isPeerActive);
  const expired = (state.expiresAt ?? 0) - (now + state.clockOffset) <= 0;

  // A sleeping phone drops the connection, which stops the transfer: keep the screen on while it matters
  // (waiting for receivers, or sending). An expired code with nothing running needs nothing.
  useWakeLock(state.phase === 'open' && (transferring || !expired));

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

  // Closing the tab says goodbye right away. A phone that merely fell asleep says nothing: the server
  // keeps the room for a while and the sender can take it back.
  useEffect(() => {
    const leave = (event: PageTransitionEvent) => {
      if (!event.persisted) session.dispose();
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [session]);

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
      ({ source, fileCount, separate }) => {
        if (cancelled) return;
        created = new SenderSession(source, fileCount, separate);
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
