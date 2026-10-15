// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import jsQR from 'jsqr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUIET_ZONE } from '../lib/qr';
import { matrixFromPath, rasterizeMatrix } from '../lib/qrTestUtils';
import type { ReceiverState } from '../lib/receiverSession';
import type { SenderPeerView, SenderState } from '../lib/senderSession';
import { CodeEntryView } from './CodeEntryView';
import { HomeView } from './HomeView';
import { ReceiverView } from './ReceiverView';
import { SenderBundleError, SenderPreparing, SenderView } from './SenderView';

afterEach(cleanup);

const MIN = 60_000;

describe('HomeView', () => {
  it('asks which file to send', () => {
    render(<HomeView onFiles={() => {}} />);
    expect(screen.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeInTheDocument();
    expect(screen.getByText('파일을 고르면 6자리 코드를 만들어드려요')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '어떤 파일을 보낼까요?' }).closest('.heading-center')).not.toBeNull();
    // switching sides is the toggle's job, so the card carries no extra links
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('passes the chosen file up', async () => {
    const onFiles = vi.fn();
    render(<HomeView onFiles={onFiles} />);
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    await userEvent.upload(screen.getByLabelText('보낼 파일 선택'), file);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('lets the picker select several files and passes them all up', async () => {
    const onFiles = vi.fn();
    render(<HomeView onFiles={onFiles} />);
    const input = screen.getByLabelText('보낼 파일 선택');
    expect(input).toHaveAttribute('multiple');
    const files = [new File(['1'], '1.txt'), new File(['2'], '2.txt'), new File(['3'], '3.txt')];
    await userEvent.upload(input, files);
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it('takes a single dropped file', () => {
    const onFiles = vi.fn();
    render(<HomeView onFiles={onFiles} />);
    const file = new File(['x'], 'x.txt');
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file], items: [] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('takes several dropped files at once', () => {
    const onFiles = vi.fn();
    render(<HomeView onFiles={onFiles} />);
    const files = [new File(['1'], '1.txt'), new File(['2'], '2.txt')];
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files, items: [] } });
    expect(onFiles).toHaveBeenCalledWith(files);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refuses a dropped folder, even among other files', () => {
    const onFiles = vi.fn();
    render(<HomeView onFiles={onFiles} />);
    const folder = { webkitGetAsEntry: () => ({ isDirectory: true }) };
    const plain = { webkitGetAsEntry: () => ({ isDirectory: false }) };
    fireEvent.drop(screen.getByTestId('dropzone'), {
      dataTransfer: { files: [new File([], 'dir'), new File(['x'], 'x.txt')], items: [folder, plain] },
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('폴더');
  });
});

describe('CodeEntryView', () => {
  it('shows the prompt and keeps the connect button disabled until 6 digits', async () => {
    render(<CodeEntryView onSubmit={() => {}} />);
    expect(screen.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeInTheDocument();
    expect(screen.getByText('보내는 사람이 알려준 6자리 코드예요')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '연결하기' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('전송 코드'), '12345');
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('전송 코드'), '6');
    expect(button).toBeEnabled();
  });

  it('accepts digits only, groups them and submits the raw code with Enter', async () => {
    const onSubmit = vi.fn();
    render(<CodeEntryView onSubmit={onSubmit} />);
    const input = screen.getByLabelText('전송 코드');
    await userEvent.type(input, 'a1b2c3d4e5f6g7{Enter}');
    expect(input).toHaveValue('123 456');
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('takes a pasted code with spaces', async () => {
    const onSubmit = vi.fn();
    render(<CodeEntryView onSubmit={onSubmit} />);
    await userEvent.click(screen.getByLabelText('전송 코드'));
    await userEvent.paste(' 987 654 ');
    await userEvent.click(screen.getByRole('button', { name: '연결하기' }));
    expect(onSubmit).toHaveBeenCalledWith('987654');
  });

  it('announces errors', () => {
    render(<CodeEntryView onSubmit={() => {}} error={{ title: '없는 코드예요', body: '숫자를 다시 확인해주세요.' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('없는 코드예요');
  });

  it('shows a loading state while connecting', () => {
    render(<CodeEntryView onSubmit={() => {}} initialCode="123456" busy />);
    expect(screen.getByRole('button', { name: /연결하는 중/ })).toBeDisabled();
  });
});

function senderState(patch: Partial<SenderState> = {}): SenderState {
  return {
    phase: 'open',
    file: { name: 'report.pdf', size: 5 * 1024 * 1024 },
    fileCount: 1,
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
  label: '파라리크티스 올리바케우스',
  phase: 'sending',
  ackedBytes: 0,
  totalBytes: 100,
  speed: 0,
  ...patch,
});

describe('SenderView', () => {
  const noop = () => {};

  it('shows the big code, the countdown and the 0 / 3 headcount', () => {
    render(<SenderView state={senderState()} now={1_000_000 + 5 * MIN} onLeave={noop} onRenew={noop} />);
    expect(screen.getByRole('heading', { name: '코드를 알려주세요' })).toBeInTheDocument();
    expect(screen.getByTestId('transfer-code')).toHaveTextContent('123 456');
    expect(screen.getByRole('timer')).toHaveTextContent('25:00');
    expect(screen.getByText('0 / 3명')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });

  it('puts the countdown on the right and centers the heading block', () => {
    render(<SenderView state={senderState()} now={1_000_000} onLeave={noop} onRenew={noop} />);
    expect(screen.getByRole('heading', { name: '코드를 알려주세요' }).closest('.heading-center')).not.toBeNull();
    expect(screen.getByRole('timer').closest('.countdown')).not.toBeNull();
  });

  it('shows the code large, as plain digits for screen readers, and has no button just for the code', () => {
    render(<SenderView state={senderState()} now={1_000_000} onLeave={noop} onRenew={noop} />);
    const code = screen.getByTestId('transfer-code');
    expect(code).toHaveClass('code');
    expect(code).toHaveAttribute('aria-label', '전송 코드 1 2 3 4 5 6');
    // a paragraph cannot carry a name, so the digits are read as one labeled figure
    expect(screen.getByRole('img', { name: '전송 코드 1 2 3 4 5 6' })).toBe(code);
    expect(screen.queryByRole('button', { name: '코드 복사하기' })).not.toBeInTheDocument();
  });

  it('shows each receiver with ACK-based progress', () => {
    const state = senderState({
      connectedCount: 2,
      peers: [
        peerView({ ackedBytes: 25, totalBytes: 100, speed: 1_048_576 }),
        peerView({ id: 'b'.repeat(16), label: '세바스테스 슈레겔리', phase: 'connecting' }),
      ],
    });
    render(<SenderView state={state} now={1_000_000} onLeave={noop} onRenew={noop} />);
    expect(screen.getByText('2 / 3명')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: '파라리크티스 올리바케우스 진행률' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText(/1 MB\/s/)).toBeInTheDocument();
    expect(screen.getByText('세바스테스 슈레겔리')).toBeInTheDocument();
  });

  it('after 30 minutes says new people cannot join but running transfers continue', () => {
    const state = senderState({ connectedCount: 1, peers: [peerView({ ackedBytes: 10 })] });
    render(<SenderView state={state} now={1_000_000 + 30 * MIN} onLeave={noop} onRenew={noop} />);
    expect(screen.getByText(/코드가 만료됐어요/)).toBeInTheDocument();
    expect(screen.getByText(/진행 중인 전송은 계속돼요/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 코드 만들기' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '메시지 복사하기' })).not.toBeInTheDocument();
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
  return { phase: 'review', savedBytes: 0, speed: 0, delivery: 'zip', mode: 'file-system', hasTurn: true, ...patch };
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

  describe('several files', () => {
    const files = [
      { name: 'report.hwp', size: 2 * 1024 * 1024 },
      { name: 'photo.png', size: 1024 },
      { name: 'notes.txt', size: 0 },
    ];
    const bundle = { name: 'DROP6 파일 3개.zip', size: 2 * 1024 * 1024 + 2000, mime: 'application/zip', files };

    it('lists every file and offers the zip and the files one by one', async () => {
      const onAccept = vi.fn();
      render(<ReceiverView state={receiverState({ meta: bundle })} onAccept={onAccept} onCancel={noop} onRetry={noop} />);
      const list = screen.getByRole('list', { name: '파일 목록' });
      expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
        'report.hwp2 MB',
        'photo.png1 KB',
        'notes.txt0 B',
      ]);
      expect(screen.getByText('파일 3개')).toBeInTheDocument();

      expect(onAccept).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'zip 하나로 받기' }));
      expect(onAccept).toHaveBeenLastCalledWith('zip');
      await userEvent.click(screen.getByRole('button', { name: '파일 따로 받기' }));
      expect(onAccept).toHaveBeenLastCalledWith('files');
    });

    it('does not show the plain single-file button', () => {
      render(<ReceiverView state={receiverState({ meta: bundle })} onAccept={noop} onCancel={noop} onRetry={noop} />);
      expect(screen.queryByRole('button', { name: '파일 받기' })).not.toBeInTheDocument();
    });

    it('explains the folder to pick when streaming to disk', () => {
      render(<ReceiverView state={receiverState({ meta: bundle })} onAccept={noop} onCancel={noop} onRetry={noop} />);
      expect(screen.getByText(/새 폴더/)).toBeInTheDocument();
    });

    it('warns that every file starts a download of its own in a memory-only browser', () => {
      render(<ReceiverView state={receiverState({ meta: bundle, mode: 'memory' })} onAccept={noop} onCancel={noop} onRetry={noop} />);
      expect(screen.getByText(/파일마다 다운로드가 시작돼요/)).toBeInTheDocument();
    });

    it('offers only the files one by one when the zip is too big for memory', async () => {
      const onAccept = vi.fn();
      const half = 300 * 1024 * 1024;
      const big = { ...bundle, size: half * 2 + 2000, files: [{ name: 'a.bin', size: half }, { name: 'b.bin', size: half }] };
      render(<ReceiverView state={receiverState({ meta: big, mode: 'memory' })} onAccept={onAccept} onCancel={noop} onRetry={noop} />);
      expect(screen.queryByRole('button', { name: 'zip 하나로 받기' })).not.toBeInTheDocument();
      expect(screen.getByText(/zip 전체/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: '파일 따로 받기' }));
      expect(onAccept).toHaveBeenCalledWith('files');
    });

    it('can decline', async () => {
      const onCancel = vi.fn();
      render(<ReceiverView state={receiverState({ meta: bundle })} onAccept={noop} onCancel={onCancel} onRetry={noop} />);
      await userEvent.click(screen.getByRole('button', { name: '받지 않기' }));
      expect(onCancel).toHaveBeenCalled();
    });

    it('measures progress against the files added up, not the zip', () => {
      const state = receiverState({ phase: 'receiving', meta: bundle, delivery: 'files', savedBytes: 1024 * 1024 + 512 });
      render(<ReceiverView state={state} onAccept={noop} onCancel={noop} onRetry={noop} />);
      expect(screen.getByText('파일 3개')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
      expect(screen.getByText(/50% · 1 MB \/ 2 MB/)).toBeInTheDocument();
    });

    it('measures progress against the zip when the zip was chosen', () => {
      const state = receiverState({ phase: 'receiving', meta: bundle, delivery: 'zip', savedBytes: bundle.size / 2 });
      render(<ReceiverView state={state} onAccept={noop} onCancel={noop} onRetry={noop} />);
      expect(screen.getByText('DROP6 파일 3개.zip')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    });

    it('names the folder the files went into', () => {
      const state = receiverState({ phase: 'done', meta: bundle, delivery: 'files', savedBytes: files[0]!.size + files[1]!.size, savedName: 'from-friend' });
      render(<ReceiverView state={state} onAccept={noop} onCancel={noop} onRetry={noop} />);
      expect(screen.getByRole('heading')).toHaveTextContent('다 받았어요');
      expect(screen.getByText(/'from-friend' 폴더에 저장했어요/)).toBeInTheDocument();
      expect(screen.getByText('파일 3개')).toBeInTheDocument();
    });

    it('points to the downloads folder after the files were downloaded one by one', () => {
      const state = receiverState({ phase: 'done', meta: bundle, delivery: 'files', mode: 'memory' });
      render(<ReceiverView state={state} onAccept={noop} onCancel={noop} onRetry={noop} />);
      expect(screen.getByText(/다운로드 폴더/)).toBeInTheDocument();
    });
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

describe('removed copy', () => {
  const REMOVED = [
    '새로운 사람은 30분 동안 들어올 수 있어요.',
    '아직 아무도 들어오지 않았어요. 코드를 알려주세요.',
    '보내는 사람이 창을 닫으면 전송도 멈춰요.',
    '30분이 지나도 진행 중인 전송은 계속돼요.',
    '파일은 암호화되어 전송되며 서버에 저장하지 않아요.',
    '파일은 암호화되어 전송, 서버에 저장하지 않음.',
    '받기를 누르면 파일을 저장할 위치를 물어봐요.',
    '파일을 받으러 오셨나요? 코드 입력하기',
    '파일을 보내러 오셨나요?',
  ];
  const noop = () => {};
  const meta = { name: 'photo.png', size: 3 * 1024 * 1024, mime: 'image/png' };

  it.each([
    ['home', () => <HomeView onFiles={noop} />],
    ['code entry', () => <CodeEntryView onSubmit={noop} />],
    ['sender, waiting for people', () => <SenderView state={senderState()} now={1_000_000} onLeave={noop} onRenew={noop} />],
    [
      'sender, with receivers',
      () => <SenderView state={senderState({ connectedCount: 1, peers: [peerView({ ackedBytes: 10 })] })} now={1_000_000} onLeave={noop} onRenew={noop} />,
    ],
    ['sender, expired', () => <SenderView state={senderState()} now={1_000_000 + 31 * MIN} onLeave={noop} onRenew={noop} />],
    ['receiver, review', () => <ReceiverView state={receiverState({ meta })} onAccept={noop} onCancel={noop} onRetry={noop} />],
    [
      'receiver, receiving',
      () => <ReceiverView state={receiverState({ phase: 'receiving', meta, savedBytes: 10 })} onAccept={noop} onCancel={noop} onRetry={noop} />,
    ],
  ])('%s no longer shows the removed notes', (_name, view) => {
    render(view());
    for (const phrase of REMOVED) expect(screen.queryByText(phrase)).not.toBeInTheDocument();
  });
});

const PRIVACY = '파일은 암호화되어 전송, 서버에 저장하지 않음';

describe('privacy note', () => {
  const noop = () => {};
  const meta = { name: 'photo.png', size: 3 * 1024 * 1024, mime: 'image/png' };

  it.each([
    ['home', () => <HomeView onFiles={noop} />],
    ['sender, waiting for people', () => <SenderView state={senderState()} now={1_000_000} onLeave={noop} onRenew={noop} />],
    ['receiver, review', () => <ReceiverView state={receiverState({ meta })} onAccept={noop} onCancel={noop} onRetry={noop} />],
  ])('%s shows the short wording, centered', (_name, view) => {
    render(view());
    const note = screen.getByText(PRIVACY);
    expect(note).toHaveClass('privacy-note');
  });
});

describe('centered titles', () => {
  const noop = () => {};
  const meta = { name: 'photo.png', size: 3 * 1024 * 1024, mime: 'image/png' };
  const receiver = (patch: Partial<ReceiverState>) => (
    <ReceiverView state={receiverState({ meta, ...patch })} onAccept={noop} onCancel={noop} onRetry={noop} />
  );
  const sender = (patch: Partial<SenderState>, now = 1_000_000) => (
    <SenderView state={senderState(patch)} now={now} onLeave={noop} onRenew={noop} />
  );

  it.each([
    ['home', <HomeView key="h" onFiles={noop} />],
    ['code entry', <CodeEntryView key="c" onSubmit={noop} />],
    ['sender starting', sender({ phase: 'starting', code: undefined })],
    ['sender error', sender({ phase: 'error' })],
    ['sender closed', sender({ phase: 'closed', reason: 'CONNECTION_LOST' })],
    ['sender open', sender({})],
    ['sender expired', sender({}, 1_000_000 + 31 * MIN)],
    ['receiver joining', receiver({ phase: 'joining' })],
    ['receiver connecting', receiver({ phase: 'connecting' })],
    ['receiver review', receiver({ phase: 'review' })],
    ['receiver blocked', receiver({ phase: 'blocked', mode: 'memory' })],
    ['receiver receiving', receiver({ phase: 'receiving', savedBytes: 10 })],
    ['receiver done', receiver({ phase: 'done', savedBytes: meta.size })],
    ['receiver canceled', receiver({ phase: 'canceled' })],
    ['receiver failed', receiver({ phase: 'failed', reason: 'SENDER_LEFT' })],
    ['receiver error', receiver({ phase: 'error', reason: 'ROOM_FULL' })],
  ])('%s centers its title block', (_name, view) => {
    render(view);
    const title = screen.getByRole('heading', { level: 1 });
    const block = title.closest('.heading-center');
    expect(block).not.toBeNull();
    // every subtitle that belongs to the title sits in the same centered block
    for (const sub of document.querySelectorAll('.sub')) expect(block).toContainElement(sub as HTMLElement);
  });
});

describe('receiver names', () => {
  const noop = () => {};

  it('shows each receiver with a Lucide fish icon in front of the name', () => {
    const state = senderState({
      connectedCount: 2,
      peers: [
        peerView({ label: '파라리크티스 올리바케우스' }),
        peerView({ id: 'b'.repeat(16), label: '세바스테스 슈레겔리', phase: 'connecting' }),
      ],
    });
    const { container } = render(<SenderView state={state} now={1_000_000} onLeave={noop} onRenew={noop} />);
    const names = [...container.querySelectorAll('.peer-name')];
    expect(names.map((el) => el.textContent)).toEqual(['파라리크티스 올리바케우스', '세바스테스 슈레겔리']);
    for (const name of names) {
      const icon = name.querySelector('svg.lucide-fish');
      expect(icon).not.toBeNull();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(name.firstElementChild).toBe(icon);
    }
    expect(screen.getByRole('progressbar', { name: '파라리크티스 올리바케우스 진행률' })).toBeInTheDocument();
  });
});

describe('drop zone', () => {
  it('opens the file explorer when the field itself is clicked', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    render(<HomeView onFiles={() => {}} />);
    await userEvent.click(screen.getByTestId('dropzone'));
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('보낼 파일 선택')).toHaveAttribute('type', 'file');
    click.mockRestore();
  });

  it('still has one keyboard-reachable button for the same action', () => {
    render(<HomeView onFiles={() => {}} />);
    expect(screen.getByRole('button', { name: '파일 고르기' })).toBeInTheDocument();
    expect(screen.getByTestId('dropzone')).not.toHaveAttribute('tabindex');
  });
});

describe('receive screens, copy changes', () => {
  const noop = () => {};
  const meta = { name: 'photo.png', size: 1024, mime: 'image/png' };

  it('tells the download folder instead of asking for a save location (disk streaming)', () => {
    render(<ReceiverView state={receiverState({ phase: 'review', meta })} onAccept={noop} onCancel={noop} onRetry={noop} />);
    expect(screen.getByText('파일 받기를 누르면 브라우저 기본 다운로드 폴더로')).toBeInTheDocument();
    expect(screen.queryByText(/저장할 위치/)).not.toBeInTheDocument();
  });

  it('keeps the memory download notice in browsers without disk streaming', () => {
    render(<ReceiverView state={receiverState({ phase: 'review', meta, mode: 'memory' })} onAccept={noop} onCancel={noop} onRetry={noop} />);
    expect(screen.getByText(/메모리에 담았다가 다운로드해요/)).toBeInTheDocument();
    expect(screen.queryByText('파일 받기를 누르면 브라우저 기본 다운로드 폴더로')).not.toBeInTheDocument();
  });

  it('breaks the lost-connection message into two lines', () => {
    render(<ReceiverView state={receiverState({ phase: 'failed', reason: 'connection-lost' })} onAccept={noop} onCancel={noop} onRetry={noop} />);
    const sub = document.querySelector('.sub')!;
    expect(sub.textContent).toBe('보내는 사람이 창을 닫았거나 네트워크가 불안정할 수 있어요.\n다시 시도해주세요.');
  });
});

describe('several files', () => {
  const noop = () => {};

  it('shows the zip and how many files are inside on the sender card', () => {
    const state = senderState({ file: { name: 'DROP6 파일 3개.zip', size: 12 * 1024 * 1024 }, fileCount: 3 });
    render(<SenderView state={state} now={1_000_000} onLeave={noop} onRenew={noop} />);
    expect(screen.getByText('DROP6 파일 3개.zip')).toBeInTheDocument();
    expect(screen.getByText('파일 3개 · 12 MB')).toBeInTheDocument();
  });

  it('keeps the plain size for a single file', () => {
    render(<SenderView state={senderState()} now={1_000_000} onLeave={noop} onRenew={noop} />);
    expect(screen.getByText('5 MB')).toBeInTheDocument();
  });

  it('shows how far the bundling is while zipping', () => {
    render(<SenderPreparing done={2} total={5} onLeave={noop} />);
    expect(screen.getByRole('status')).toHaveTextContent('파일을 하나로 묶고 있어요 (2 / 5)');
    expect(screen.getByRole('heading', { level: 1 }).closest('.heading-center')).not.toBeNull();
  });

  it('explains why bundling failed and goes back', async () => {
    const onLeave = vi.fn();
    render(<SenderBundleError reason="too-many" onLeave={onLeave} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('파일이 너무 많아요');
    await userEvent.click(screen.getByRole('button', { name: '파일 다시 고르기' }));
    expect(onLeave).toHaveBeenCalled();
  });
});

describe('message to hand over', () => {
  const noop = () => {};
  const messageFor = (code: string) => `${window.location.origin} 에 접속해 파일을 다운로드 하세요.\n코드는 ${code} 입니다.😊`;

  function mockClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  const renderSender = (code = '123456', now = 1_000_000) =>
    render(<SenderView state={senderState({ code })} now={now} onLeave={noop} onRenew={noop} />);

  it('is titled with a hint about copying or scanning the QR code', () => {
    const { container } = renderSender();
    expect(screen.getByText('메시지 전달하기')).toBeInTheDocument();
    expect(container.querySelector('.section-label')?.textContent).toBe('메시지 전달하기(복사해 사용하거나 QR코드를 촬영하세요)');
  });

  it('shows a ready-to-send message with the site address, the plain 6-digit code and the emoji', () => {
    renderSender('482913');
    expect(screen.getByTestId('share-message').textContent).toBe(messageFor('482913'));
  });

  it('comes after the title and the big code, and before the headcount', () => {
    renderSender();
    const order = [
      screen.getByRole('heading', { name: '코드를 알려주세요' }),
      screen.getByTestId('transfer-code'),
      screen.getByText('메시지 전달하기'),
      screen.getByText('0 / 3명'),
    ];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('has no text button for copying; a copy icon sits inside the message box', () => {
    const { container } = renderSender();
    expect(screen.queryByText('메시지 복사하기')).not.toBeInTheDocument();
    const copy = screen.getByRole('button', { name: '메시지 복사하기' });
    expect(copy).not.toHaveClass('btn');
    expect(copy.closest('.message-box')).not.toBeNull();
    expect(copy.querySelector('svg.lucide-copy')).not.toBeNull();
    expect(container.querySelector('.share .btn')).toBeNull();
  });

  it('copies the whole message, line break included, and shows a check mark', async () => {
    const writeText = mockClipboard();
    renderSender('482913');
    await userEvent.click(screen.getByRole('button', { name: '메시지 복사하기' }));
    expect(writeText).toHaveBeenCalledWith(messageFor('482913'));
    const done = await screen.findByRole('button', { name: '복사했어요' });
    expect(done.querySelector('svg.lucide-check')).not.toBeNull();
    expect(done.querySelector('svg.lucide-copy')).toBeNull();
  });

  it('goes back to the copy icon after a moment', async () => {
    mockClipboard();
    vi.useFakeTimers();
    try {
      renderSender();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '메시지 복사하기' }));
      });
      expect(screen.getByRole('button', { name: '복사했어요' })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2_100);
      });
      expect(screen.getByRole('button', { name: '메시지 복사하기' }).querySelector('svg.lucide-copy')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks to select the message by hand when copying is not allowed', async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    renderSender();
    await userEvent.click(screen.getByRole('button', { name: '메시지 복사하기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('메시지를 직접 선택해서 복사해주세요');
  });

  it('puts a square QR code to the right of the message box', () => {
    const { container } = renderSender();
    const row = container.querySelector('.share-row')!;
    const box = row.querySelector('.message-box')!;
    const qr = within(row as HTMLElement).getByRole('img', { name: /QR 코드/ });
    expect(box.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const [, , w, h] = qr.getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBe(h); // square
  });

  it('the QR code opens the receive screen with the code already filled in', () => {
    renderSender('482913');
    const qr = screen.getByRole('img', { name: /QR 코드/ });
    const moduleCount = Number(qr.getAttribute('viewBox')!.split(' ')[2]) - QUIET_ZONE * 2;
    const matrix = matrixFromPath(qr.querySelector('path')!.getAttribute('d')!, moduleCount);
    const { data, width } = rasterizeMatrix(matrix);
    expect(jsQR(data, width, width)?.data).toBe(`${window.location.origin}/receive#code=482913`);
  });

  it('is gone once the code expired (it would hand out a dead code)', () => {
    renderSender('123456', 1_000_000 + 31 * MIN);
    expect(screen.queryByText('메시지 전달하기')).not.toBeInTheDocument();
    expect(screen.queryByTestId('share-message')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /QR 코드/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('transfer-code')).not.toBeInTheDocument();
  });
});
