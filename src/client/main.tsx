import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
// Pen-style font for the 6 in the title (only the latin 700 file, ~22KB, served from this site)
import '@fontsource/kalam/latin-700.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
