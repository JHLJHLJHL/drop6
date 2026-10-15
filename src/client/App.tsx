import { ArrowDownToLine } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CodeEntryView } from './components/CodeEntryView';
import { EmailCopy } from './components/EmailCopy';
import { HomeView } from './components/HomeView';
import { ModeToggle } from './components/ModeToggle';
import { ReceiverScreen } from './components/ReceiverScreen';
import { SenderScreen } from './components/SenderScreen';
import { confirmLeave } from './lib/leaveGuard';
import { navigate, useRoute, type Route } from './route';

const OWNER_NAME = 'LJH2026';
const CONTACT_EMAIL = 'honeymath.gbe@gmail.com';

export function App() {
  const route = useRoute();
  const [files, setFiles] = useState<File[] | null>(null);
  const [code, setCode] = useState<string | null>(null);

  // Leaving a screen ends its session, so forget what it was working on.
  useEffect(() => {
    if (route !== 'home') setFiles(null);
    if (route !== 'receive') setCode(null);
  }, [route]);

  const goHome = () => {
    if (!confirmLeave()) return;
    setFiles(null);
    navigate('/');
  };

  const select = (next: Route) => {
    if (confirmLeave()) navigate(next === 'home' ? '/' : '/receive');
  };

  let screen;
  if (route === 'receive') {
    screen = code ? (
      <ReceiverScreen code={code} onRetry={() => setCode(null)} />
    ) : (
      <CodeEntryView onSubmit={setCode} />
    );
  } else {
    screen = files ? <SenderScreen files={files} onExit={goHome} /> : <HomeView onFiles={setFiles} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-row">
          <a
            className="brand"
            href="/"
            aria-label="DROP6 처음으로"
            onClick={(event) => {
              event.preventDefault();
              goHome();
            }}
          >
            <span className="brand-mark" aria-hidden="true">
              <ArrowDownToLine size={18} strokeWidth={2.75} aria-hidden="true" />
            </span>
            <span>
              DROP<span className="brand-six">6</span>
            </span>
          </a>
        </div>
        <ModeToggle route={route} onSelect={select} />
      </header>
      <main className="app-main">{screen}</main>
      <footer className="app-footer">
        <span className="owner-name">{OWNER_NAME}</span>
        <EmailCopy email={CONTACT_EMAIL} />
      </footer>
    </div>
  );
}
