// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { setLeaveGuard } from './lib/leaveGuard';

afterEach(() => {
  cleanup();
  setLeaveGuard(null);
  window.history.pushState(null, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('header and footer', () => {
  it('keeps only the brand in the header and puts the signature in the footer', () => {
    render(<App />);
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'DROP6 처음으로' })).toBeInTheDocument();
    expect(within(header).queryByText('LJH2026')).not.toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: /honeymath/ })).not.toBeInTheDocument();

    const footer = screen.getByRole('contentinfo');
    const name = within(footer).getByText('LJH2026');
    const email = within(footer).getByRole('button', { name: /honeymath\.gbe@gmail\.com/ });
    // name first (left end), email last (right end)
    expect(name.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the footer comes after the page content
    const main = screen.getByRole('main');
    expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts an icon in front of the DROP6 title and marks the 6 for its own color', () => {
    render(<App />);
    const brand = screen.getByRole('link', { name: 'DROP6 처음으로' });
    const icon = brand.querySelector('svg.lucide-arrow-down-to-line');
    const six = brand.querySelector('.brand-six');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(six).toHaveTextContent(/^6$/);
    expect(brand).toHaveTextContent(/^DROP6$/); // the icon adds no text for readers
    expect(icon!.compareDocumentPosition(six!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('copies the email on click and says 복사되었습니다', async () => {
    const writeText = mockClipboard();
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /honeymath\.gbe@gmail\.com/ }));
    expect(writeText).toHaveBeenCalledWith('honeymath.gbe@gmail.com');
    expect(await screen.findByText('복사되었습니다')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('복사되었습니다');
  });

  it('hides the message again after a moment', async () => {
    mockClipboard();
    vi.useFakeTimers();
    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /honeymath\.gbe@gmail\.com/ }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('복사되었습니다');
    act(() => {
      vi.advanceTimersByTime(2_500);
    });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('reports when the clipboard is not available', async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<App />);
    await userEvent.click(screen.getByRole('button', { name: /honeymath\.gbe@gmail\.com/ }));
    expect(await screen.findByText('복사하지 못했어요')).toBeInTheDocument();
  });
});

describe('send / receive toggle', () => {
  it('sits at the top and marks 보내기 as current on the home screen', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: '보내기 또는 받기' });
    expect(screen.getByRole('banner')).toContainElement(nav);
    expect(within(nav).getByRole('link', { name: '보내기' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: '받기' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeInTheDocument();
  });

  it('switches between the send and receive screens', async () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: '보내기 또는 받기' });
    await userEvent.click(within(nav).getByRole('link', { name: '받기' }));
    expect(screen.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/receive');
    expect(within(nav).getByRole('link', { name: '받기' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: '보내기' })).not.toHaveAttribute('aria-current');

    await userEvent.click(within(nav).getByRole('link', { name: '보내기' }));
    expect(screen.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('opens straight on the receive side for /receive', () => {
    window.history.pushState(null, '', '/receive');
    render(<App />);
    expect(screen.getByRole('link', { name: '받기' })).toHaveAttribute('aria-current', 'page');
  });

  it('asks before leaving while a transfer is running and stays if declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    setLeaveGuard('전송 중이에요. 나가면 전송이 멈춰요.');
    await userEvent.click(screen.getByRole('link', { name: '받기' }));
    expect(confirm).toHaveBeenCalledWith('전송 중이에요. 나가면 전송이 멈춰요.');
    expect(window.location.pathname).toBe('/');

    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole('link', { name: '받기' }));
    expect(window.location.pathname).toBe('/receive');
  });
});
