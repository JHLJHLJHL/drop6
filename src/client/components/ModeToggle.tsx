import type { MouseEvent } from 'react';
import type { Route } from '../route';

interface ModeToggleProps {
  route: Route;
  onSelect(route: Route): void;
}

const OPTIONS: Array<{ route: Route; href: '/' | '/receive'; label: string }> = [
  { route: 'home', href: '/', label: '보내기' },
  { route: 'receive', href: '/receive', label: '받기' },
];

/** Send / receive switch that stays at the top of every screen. */
export function ModeToggle({ route, onSelect }: ModeToggleProps) {
  return (
    <nav className="toggle" aria-label="보내기 또는 받기">
      {OPTIONS.map((option) => (
        <a
          key={option.route}
          href={option.href}
          aria-current={route === option.route ? 'page' : undefined}
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            if (route !== option.route) onSelect(option.route);
          }}
        >
          {option.label}
        </a>
      ))}
    </nav>
  );
}
