import { useEffect, useState, useSyncExternalStore } from 'react';
import { ReceiverSession } from '../lib/receiverSession';
import { ReceiverView } from './ReceiverView';

interface ReceiverScreenProps {
  code: string;
  /** Back to entering a code. */
  onRetry(): void;
}

function Connected({ session, onRetry }: { session: ReceiverSession; onRetry(): void }) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  return (
    <ReceiverView
      state={state}
      onAccept={(delivery) => void session.accept(delivery)}
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
