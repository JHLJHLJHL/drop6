import { useSyncExternalStore } from 'react';

export type Route = 'home' | 'receive';

export function currentRoute(): Route {
  return window.location.pathname.replace(/\/+$/, '') === '/receive' ? 'receive' : 'home';
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

export function navigate(path: '/' | '/receive'): void {
  if (window.location.pathname !== path) window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, currentRoute);
}
