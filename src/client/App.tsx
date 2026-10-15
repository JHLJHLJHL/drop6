import { useEffect, useState } from 'react';
import { CodeEntryView } from './components/CodeEntryView';
import { HomeView } from './components/HomeView';
import { ReceiverScreen } from './components/ReceiverScreen';
import { SenderScreen } from './components/SenderScreen';
import { navigate, useRoute } from './route';

export function App() {
  const route = useRoute();
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState<string | null>(null);

  // Leaving a screen ends its session, so forget what it was working on.
  useEffect(() => {
    if (route !== 'home') setFile(null);
    if (route !== 'receive') setCode(null);
  }, [route]);

  const goHome = () => {
    setFile(null);
    navigate('/');
  };

  let screen;
  if (route === 'receive') {
    screen = code ? (
      <ReceiverScreen code={code} onRetry={() => setCode(null)} />
    ) : (
      <CodeEntryView onSubmit={setCode} onOpenHome={goHome} />
    );
  } else {
    screen = file ? (
      <SenderScreen file={file} onExit={goHome} />
    ) : (
      <HomeView onFile={setFile} onOpenReceive={() => navigate('/receive')} />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <a
          className="brand"
          href="/"
          aria-label="DROP6 처음으로"
          onClick={(event) => {
            event.preventDefault();
            goHome();
          }}
        >
          DROP6
        </a>
      </header>
      <main className="app-main">{screen}</main>
    </div>
  );
}
