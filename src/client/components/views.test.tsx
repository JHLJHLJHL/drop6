// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReceiverState } from '../lib/receiverSession';
import type { SenderPeerView, SenderState } from '../lib/senderSession';
import { CodeEntryView } from './CodeEntryView';
import { HomeView } from './HomeView';
import { ReceiverView } from './ReceiverView';
import { SenderView } from './SenderView';

afterEach(cleanup);

const MIN = 60_000;

describe('HomeView', () => {
  it('asks which file to send and offers to receive instead', () => {
    render(<HomeView onFile={() => {}} onOpenReceive={() => {}} />);
    expect(screen.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeInTheDocument();
    expect(screen.getByText('파일을 고르면 6자리 코드를 만들어드려요.')).toBeInTheDocument();
    expect(screen.getByText('파일은 암호화되어 전송되며 서버에 저장하지 않아요.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /코드 입력하기/ })).toHaveAttribute('href', '/receive');
  });

  it('passes the chosen file up', async () => {
    const onFile = vi.fn();
    render(<HomeView onFile={onFile} onOpenReceive={() => {}} />);
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await userEvent.upload(screen.getByLabelText('보낼 파일 선택'), file);
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('takes a single dropped file', () => {
    const onFile = vi.fn();
    render(<HomeView onFile={onFile} onOpenReceive={() => {}} />);
    const file = new File(['x'], 'x.txt');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file], items: [] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it('refuses several dropped files and explains why', () => {
    const onFile = vi.fn();
    render(<HomeView onFile={onFile} onOpenReceive={() => {}} />);
    const files = [new File(['1'], '1.txt'), new File(['2'], '2.txt')];
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files, items: [] } });
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('하나씩');
  });

  it('refuses a dropped folder', () => {
    const onFile = vi.fn();
    render(<HomeView onFile={onFile} onOpenReceive={() => {}} />);
    const folder = { webkitGetAsEntry: () => ({ isDirectory: true }) };
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [new File([], 'dir')], items: [folder] } });
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('폴더');
  });
});

describe('CodeEntryView', () => {
  it('shows the prompt and keeps the connect button disabled until 6 digits', async () => {
    render(<CodeEntryView onSubmit={() => {}} onOpenHome={() => {}} />);
    expect(screen.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeInTheDocument();
    expect(screen.getByText('보내는 사람이 알려준 6자리 코드예요.')).toBeInTheDocument();
    expect(screen.getByText('30분이 지나도 진행 중인 전송은 계속돼요.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '연결하기' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('전송 코드'), '12345');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('전송 코드'), '6');
    expect(button).toBeEnabled();
  });

  it('accepts digits only, groups them and submits the raw code with Enter', async () => {
    const onSubmit = vi.fn();
    render(<CodeEntryView onSubmit={onSubmit} onOpenHome={() => {}} />);
    const input = screen.getByLabelText('전송 코드');
    await userEvent.type(input, 'a1b2c3d4e5f6g7{Enter}');
    expect(input).toHaveValue('123 456');
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('takes a pasted code with spaces', async () => {
    const onSubmit = vi.fn();
    render(<CodeEntryView onSubmit={onSubmit} onOpenHome={() => {}} />);
    await userEvent.click(screen.getByLabelText('전송 코드'));
    await userEvent.paste(' 987 654 ');
    await userEvent.click(screen.getByRole('button', { name: '연결하기' }));
    expect(onSubmit).toHaveBeenCalledWith('987654');
  });

  it('announces errors', () => {
    render(<CodeEntryView onSubmit={() => {}} onOpenHome={() => {}} error={{ title: '없는 코드예요', body: '숫자를 다시 확인해주세요.' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('없는 코드예요');
  });

  it('shows a loading state while connecting', () => {
    render(<CodeEntryView onSubmit={() => {}} onOpenHome={() => {}} initialCode="123456" busy />);
    expect(screen.getByRole('button', { name: /연결하는 중/ })).toBeDisabled();
  });
});

function senderState(patch: Partial<SenderState> = {}): SenderState {
  return {
    phase: 'open',
    file: { name: 'report.pdf', size: 5 * 1024 * 1024 },
    code: '123456',
    expiresAt: 1_000_000 + 30 * MIN,
    clockOffset: 0,
    maxReceivers: 3,
    connectedCount: 0,
    peers: [],
    hasTurn: true,
    ...patch,
  };
}

const peerView = (patch: Partial<SenderPeerView>): SenderPeerView => ({
  id: 'a'.repeat(16),
  label: '받는 사람 1',
  phase: 'sending',
  ackedBytes: 0,
  totalBytes: 100,
  speed: 0,
  ...patch,
});

describe('SenderView', () => {
  const noop = () => {};

  it('shows the code, the countdown and the 0 / 3 headcount', () => {
    render(<SenderView state={senderState()} now={1_000_000 + 5 * MIN} onLeave={noop} onRenew={noop} />);
    expect(screen.getByRole('heading', { name: '코드를 알려주세요' })).toBeInTheDocument();
    expect(screen.getByTestId('transfer-code')).toHaveTextContent('123 456');
    expect(screen.getByText('새로운 사람은 30분 동안 들어올 수 있어요.')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('25:00');
    expect(screen.getByText('0 / 3명')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('보내는 사람이 창을 닫으면 전송도 멈춰요.')).toBeInTheDocument();
    expect(screen.getByText('30분이 지나도 진행 중인 전송은 계속돼요.')).toBeInTheDocument();
  });

  it('copies the code and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<SenderView state={senderState()} now={1_000_000} onLeave={noop} onRenew={noop} />);
    await userEvent.click(screen.getByRole('button', { name: '코드 복사하기' }));
    expect(writeText).toHaveBeenCalledWith('123456');
    expect(await screen.findByRole('button', { name: '복사했어요' })).toBeInTheDocument();
  });

  it('shows each receiver with ACK-based progress', () => {
    const state = senderState({
      connectedCount: 2,
      peers: [
        peerView({ ackedBytes: 25, totalBytes: 100, speed: 1_048_576 }),
        peerView({ id: 'b'.repeat(16), label: '받는 사람 2', phase: 'connecting' }),
      ],
    });
    render(<SenderView state={state} now={1_000_000} onLeave={noop} onRenew={noop} />);
    expect(screen.getByText('2 / 3명')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: '받는 사람 1 진행률' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText(/1 MB\/s/)).toBeInTheDocument();
    expect(screen.getByText('받는 사람 2')).toBeInTheDocument();
  });

  it('after 30 minutes says new people cannot join but running transfers continue', () => {
    const state = senderState({ connectedCount: 1, peers: [peerView({ ackedBytes: 10 })] });
    render(<SenderView state={state} now={1_000_000 + 30 * MIN} onLeave={noop} onRenew={noop} />);
    expect(screen.getByText(/코드가 만료됐어요/)).toBeInTheDocument();
    expect(screen.getByText(/진행 중인 전송은 계속돼요/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 코드 만들기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '코드 복사하기' })).not.toBeInTheDocument();
  });

  it('offers a new code after expiry once nothing is running', async () => {
    const onRenew = vi.fn();
    render(<SenderView state={senderState({ peers: [peerView({ phase: 'done' })] })} now={1_000_000 + 31 * MIN} onLeave={noop} onRenew={onRenew} />);
    await userEvent.click(screen.getByRole('button', { name: '새 코드 만들기' }));
    expect(onRenew).toHaveBeenCalled();
  });

  it('explains when the connection to the server was lost', async () => {
    const onRenew = vi.fn();
    render(<SenderView state={senderState({ phase: 'closed', reason: 'CONNECTION_LOST' })} now={1_000_000} onLeave={noop} onRenew={onRenew} />);
    expect(screen.getByRole('heading')).toHaveTextContent('연결이 끊어졌어요');
    await userEvent.click(screen.getByRole('button', { name: '새 코드 만들기' }));
    expect(onRenew).toHaveBeenCalled();
  });

  it('shows a loading state while the code is being made', () => {
    render(<SenderView state={senderState({ phase: 'starting', code: undefined })} now={0} onLeave={noop} onRenew={noop} />);
    expect(screen.getByText(/코드를 만들고 있어요/)).toBeInTheDocument();
  });

  it('lets the sender end the transfer', async () => {
    const onLeave = vi.fn();
    render(<SenderView state={senderState()} now={1_000_000} onLeave={onLeave} onRenew={noop} />);
    await userEvent.click(screen.getByRole('button', { name: '전송 끝내기' }));
    expect(onLeave).toHaveBeenCalled();
  });
});

function receiverState(patch: Partial<ReceiverState> = {}): ReceiverState {
  return { phase: 'review', savedBytes: 0, speed: 0, mode: 'file-system', hasTurn: true, ...patch };
}

describe('ReceiverView', () => {
  const noop = () => {};
  const meta = { name: 'photo.png', size: 3 * 1024 * 1024, mime: 'image/png' };

  it('shows file info first and starts only when the user presses 파일 받기', async () => {
    const onAccept = vi.fn();
    render(<ReceiverView state={receiverState({ meta })} onAccept={onAccept} onCancel={noop} onRetry={noop} />);
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getByText(/3 MB/)).toBeInTheDocument();
    expect(screen.getByText(/image\/png/)).toBeInTheDocument();
    expect(onAccept).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '파일 받기' }));
    expect(onAccept).toHaveBeenCalled();
  });

  it('explains the in-memory download and its 500MB limit before the transfer starts', () => {
    render(<ReceiverView state={receiverState({ meta, mode: 'memory' })} onAccept={noop} onCancel={noop} onRetry={noop} />);
    expect(screen.getByText(/메모리/)).toBeInTheDocument();
    expect(screen.getByText(/500MB/)).toBeInTheDocument();
  });

  it('blocks files over the memory limit with a clear explanation', () => {
    const big = { ...meta, size: 600 * 1024 * 1024 };
    render(<ReceiverView state={receiverState({ phase: 'blocked', meta: big, mode: 'memory', reason: 'too-large' })} onAccept={noop} onCancel={noop} onRetry={noop} />);
    expect(screen.getByRole('heading')).toHaveTextContent('받을 수 없어요');
    expect(screen.queryByRole('button', { name: '파일 받기' })).not.toBeInTheDocument();
    expect(screen.getByText(/500MB/)).toBeInTheDocument();
  });

  it('shows progress and speed and lets the receiver cancel', async () => {
    const onCancel = vi.fn();
    const state = receiverState({ phase: 'receiving', meta, savedBytes: 1.5 * 1024 * 1024, speed: 2 * 1024 * 1024 });
    render(<ReceiverView state={state} onAccept={noop} onCancel={onCancel} onRetry={noop} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText(/2 MB\/s/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '받기 취소' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('tells where the file was saved', () => {
    const state = receiverState({ phase: 'done', meta, savedBytes: meta.size, savedName: 'my-photo.png' });
    render(<ReceiverView state={state} onAccept={noop} onCancel={noop} onRetry={noop} />);
    expect(screen.getByRole('heading')).toHaveTextContent('다 받았어요');
    expect(screen.getByText('my-photo.png')).toBeInTheDocument();
    expect(screen.getByText(/선택한 위치에 저장했어요/)).toBeInTheDocument();
  });

  it('points to the downloads folder after an in-memory download', () => {
    const state = receiverState({ phase: 'done', meta, savedBytes: meta.size, mode: 'memory' });
    render(<ReceiverView state={state} onAccept={noop} onCancel={noop} onRetry={noop} />);
    expect(screen.getByText(/다운로드 폴더/)).toBeInTheDocument();
  });

  it.each([
    ['ROOM_FULL', '가득'],
    ['ROOM_EXPIRED', '만료'],
    ['ROOM_NOT_FOUND', '없는 코드'],
  ])('explains join error %s', async (reason, fragment) => {
    const onRetry = vi.fn();
    render(<ReceiverView state={receiverState({ phase: 'error', reason })} onAccept={noop} onCancel={noop} onRetry={onRetry} />);
    expect(screen.getByRole('heading')).toHaveTextContent(fragment);
    await userEvent.click(screen.getByRole('button', { name: '코드 다시 입력하기' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('tells the receiver when the sender closed the window', () => {
    render(<ReceiverView state={receiverState({ phase: 'failed', reason: 'SENDER_LEFT' })} onAccept={noop} onCancel={noop} onRetry={noop} />);
    expect(screen.getByRole('heading')).toHaveTextContent('보내는 사람이 창을 닫았어요');
  });

  it('shows a connecting state with a way out', async () => {
    const onCancel = vi.fn();
    render(<ReceiverView state={receiverState({ phase: 'connecting' })} onAccept={noop} onCancel={onCancel} onRetry={noop} />);
    expect(within(screen.getByRole('status')).getByText(/연결하고 있어요/)).toBeInTheDocument();
  });
});
