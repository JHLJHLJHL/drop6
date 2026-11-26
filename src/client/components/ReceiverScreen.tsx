import { useEffect, useState, useSyncExternalStore } from 'react';
import { ReceiverSession, type ReceiverPhase } from '../lib/receiverSession';
import { ReceiverView } from './ReceiverView';
import { useWakeLock } from './useWakeLock';

/**
 * A phone whose screen locks freezes the page (iOS Safari above all), which drops the connection and
 * stops the transfer. Keep the screen on for as long as the connection to the sender matters.
 */
export function keepsReceiverAwake(phase: ReceiverPhase): boolean {
  return phase === 'joining' || phase === 'connecting' || phase === 'review' || phase === 'receiving' || phase === 'paused';
}

interface ReceiverScreenProps {
  code: string;
  /** Back to entering a code. */
  onRetry(): void;
}

function Connected({ session, onRetry }: { session: ReceiverSession; onRetry(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  useWakeLock(keepsReceiverAwake(state.phase));
  return (
    <ReceiverView
      state={state}
      onAccept={(delivery, chooseLocation) => void session.accept(delivery, chooseLocation)}
      onCancel={() => session.cancel()}
      onRetry={onRetry}
    />
  );
}

export function ReceiverScreen({ code, onRetry }: ReceiverScreenProps) {
  const [session, setSession] = useState<ReceiverSession | null>(null);

  useEffect(() => {
    const created = new ReceiverSession(code);
    setSession(created);
    void created.start();
    return () => created.dispose();
  }, [code]);

  if (!session) return null;
  return <Connected session={session} onRetry={onRetry} />;
}
