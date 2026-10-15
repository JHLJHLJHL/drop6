import { useEffect, useState, useSyncExternalStore } from 'react';
import { SenderSession, isPeerActive } from '../lib/senderSession';
import { SenderView } from './SenderView';
import { useNow } from './useNow';

interface SenderScreenProps {
  file: File;
  onExit(): void;
}

function Connected({ session, onExit, onRenew }: { session: SenderSession; onExit(): void; onRenew(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const now = useNow(1_000);
  const transferring = state.phase === 'open' && state.peers.some(isPeerActive);

  // Closing the tab ends every transfer, so ask first while one is running.
  useEffect(() => {
    if (!transferring) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [transferring]);

  return <SenderView state={state} now={now} onLeave={onExit} onRenew={onRenew} />;
}

/** Owns one SenderSession per attempt: a fresh code means a fresh session. */
export function SenderScreen({ file, onExit }: SenderScreenProps) {
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<SenderSession | null>(null);

  useEffect(() => {
    const created = new SenderSession(file);
    setSession(created);
    void created.start();
    return () => created.dispose();
  }, [file, attempt]);

  if (!session) return null;
  return <Connected key={attempt} session={session} onExit={onExit} onRenew={() => setAttempt((n) => n + 1)} />;
}
