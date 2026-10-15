import { useEffect, useRef, useState } from 'react';
import { ROOM_TTL_MS } from '../../shared/protocol';
import { formatBytes, formatCode, formatCountdown, formatSpeed } from '../lib/format';
import { describeSenderClosed, describeSenderPeer } from '../lib/messages';
import { isPeerActive, type SenderPeerView, type SenderState } from '../lib/senderSession';
import { Button, FileCard, Heading, PrivacyNote, ProgressBar, percentOf } from './ui';

interface SenderViewProps {
  state: SenderState;
  /** Current time in ms (Date.now()); passed in so the countdown is testable. */
  now: number;
  onLeave(): void;
  /** Start over with a fresh code for the same file. */
  onRenew(): void;
}

const WINDOW_MINUTES = ROOM_TTL_MS / 60_000;

function PeerRow({ peer, hasTurn }: { peer: SenderPeerView; hasTurn: boolean }) {
  const percent = percentOf(peer.ackedBytes, peer.totalBytes);
  const showProgress = peer.phase === 'sending' || peer.phase === 'done';
  return (
    <li className="peer">
      <div className="peer-head">
        <span className="peer-name">{peer.label}</span>
        <span className="peer-status">{describeSenderPeer(peer, hasTurn)}</span>
      </div>
      {showProgress && (
        <>
          <ProgressBar percent={peer.phase === 'done' ? 100 : percent} label={`${peer.label} 진행률`} />
          <span className="peer-meta">
            {Math.floor(peer.phase === 'done' ? 100 : percent)}%
            {peer.phase === 'sending' && peer.speed > 0 ? ` · ${formatSpeed(peer.speed)}` : ''}
          </span>
        </>
      )}
    </li>
  );
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setFailed(false);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2_000);
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <Button onClick={() => void copy()}>{copied ? '복사했어요' : '코드 복사하기'}</Button>
      {failed && (
        <p className="error-text" role="alert">
          복사하지 못했어요. 코드를 직접 선택해서 복사해주세요.
        </p>
      )}
    </>
  );
}

export function SenderView({ state, now, onLeave, onRenew }: SenderViewProps) {
  const fileCard = <FileCard name={state.file.name} detail={formatBytes(state.file.size)} />;
  const peerList = state.peers.length > 0 && (
    <div>
      <p className="section-label">받는 사람</p>
      <ul className="peers">
        {state.peers.map((peer) => (
          <PeerRow key={peer.id} peer={peer} hasTurn={state.hasTurn} />
        ))}
      </ul>
    </div>
  );

  if (state.phase === 'starting') {
    return (
      <section className="card stack">
        <Heading>잠시만 기다려주세요</Heading>
        <p className="status" role="status">
          <span className="spinner spinner-dark" aria-hidden="true" />
          코드를 만들고 있어요
        </p>
        {fileCard}
        <Button variant="text" onClick={onLeave}>
          그만두기
        </Button>
      </section>
    );
  }

  if (state.phase === 'error') {
    return (
      <section className="card stack">
        <div>
          <Heading>서버에 연결하지 못했어요</Heading>
          <p className="sub">인터넷 연결을 확인하고 다시 시도해주세요.</p>
        </div>
        {fileCard}
        <Button onClick={onRenew}>다시 시도하기</Button>
        <Button variant="text" onClick={onLeave}>
          처음으로
        </Button>
      </section>
    );
  }

  if (state.phase === 'closed') {
    const message = describeSenderClosed(state.reason);
    return (
      <section className="card stack">
        <div>
          <Heading>{message.title}</Heading>
          <p className="sub">{message.body}</p>
        </div>
        {fileCard}
        {peerList}
        <Button onClick={onRenew}>새 코드 만들기</Button>
        <Button variant="text" onClick={onLeave}>
          처음으로
        </Button>
      </section>
    );
  }

  const code = state.code ?? '';
  const remaining = (state.expiresAt ?? 0) - (now + state.clockOffset);
  const expired = remaining <= 0;
  const idle = !state.peers.some(isPeerActive);

  return (
    <section className="card stack">
      {expired ? (
        <div>
          <Heading>코드가 만료됐어요</Heading>
          <p className="sub">
            {idle
              ? '새로운 사람은 더 들어올 수 없어요. 새 코드를 만들어 다시 시작할 수 있어요.'
              : '새로운 사람은 더 들어올 수 없어요. 진행 중인 전송은 계속돼요.'}
          </p>
        </div>
      ) : (
        <div>
          <Heading>코드를 알려주세요</Heading>
          <p className="sub">받는 사람이 이 코드를 입력하면 연결돼요.</p>
        </div>
      )}

      {!expired && (
        <>
          <p className="code" data-testid="transfer-code" aria-label={`전송 코드 ${code.split('').join(' ')}`}>
            {formatCode(code)}
          </p>
          <CopyButton code={code} />
          <div className="facts">
            <p>새로운 사람은 {WINDOW_MINUTES}분 동안 들어올 수 있어요.</p>
            <p>
              남은 시간 <span role="timer">{formatCountdown(remaining)}</span>
            </p>
          </div>
        </>
      )}

      {expired && idle && <Button onClick={onRenew}>새 코드 만들기</Button>}

      <p className="facts" aria-live="polite">
        접속한 사람 <strong>{`${state.connectedCount} / ${state.maxReceivers}명`}</strong>
      </p>

      {fileCard}
      {peerList}
      {state.peers.length === 0 && !expired && <p className="note">아직 아무도 들어오지 않았어요. 코드를 알려주세요.</p>}

      <div className="notes">
        <p className="note">보내는 사람이 창을 닫으면 전송도 멈춰요.</p>
        {!expired && <p className="note">30분이 지나도 진행 중인 전송은 계속돼요.</p>}
        <PrivacyNote />
      </div>

      <Button variant="text" onClick={onLeave}>
        전송 끝내기
      </Button>
    </section>
  );
}
