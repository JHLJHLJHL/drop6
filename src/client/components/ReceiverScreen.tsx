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

  useEffect(() => {
    // A phone that wakes up: notice now, not much later, if its server connection died while it slept.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') session.checkConnection();
    };
    // Closing the tab says goodbye right away. A phone that merely fell asleep says nothing: the server
    // keeps the seat for a while and the transfer continues once it is back.
    const leave = (event: PageTransitionEvent) => {
      if (!event.persisted) session.dispose();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', leave);
    };
  }, [session]);

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
