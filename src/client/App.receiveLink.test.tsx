// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

beforeEach(() => {
  // the receiver session asks the server for ICE servers first; keep it waiting so the screen state is stable
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState(null, '', '/');
});

describe('opening a receive link (what the QR code holds)', () => {
  it('starts connecting right away when the fragment holds a code', () => {
    window.history.pushState(null, '', '/receive#code=163960');
    render(<App />);
    expect(screen.getByText('코드를 확인하고 있어요')).toBeInTheDocument();
    expect(screen.queryByLabelText('전송 코드')).not.toBeInTheDocument();
  });

  it('removes the code from the address bar afterwards, keeping the path', async () => {
    window.history.pushState(null, '', '/receive#code=163960');
    render(<App />);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.pathname).toBe('/receive');
  });

  it('shows the code entry for a fragment that is not a 6-digit code', () => {
    for (const hash of ['#code=12345', '#code=abcdef', '#something']) {
      window.history.pushState(null, '', `/receive${hash}`);
      const { unmount } = render(<App />);
      expect(screen.getByLabelText('전송 코드'), hash).toBeInTheDocument();
      unmount();
    }
  });

  it('leaves the send screen alone', () => {
    window.history.pushState(null, '', '/#code=163960');
    render(<App />);
    expect(screen.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeInTheDocument();
  });

  it('does not connect again when the user backs out and returns to entering a code', async () => {
    window.history.pushState(null, '', '/receive#code=163960');
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: '그만두기' }));
    expect(screen.getByLabelText('전송 코드')).toBeInTheDocument();
    expect(screen.getByLabelText('전송 코드')).toHaveValue('');
  });
});
