import { describe, expect, it } from 'vitest';
import {
  describeJoinError,
  describeReceiverFailure,
  describeSenderClosed,
  describeSenderPeer,
  TURN_MISSING_HINT,
} from './messages';
import type { SenderPeerView } from './senderSession';

const peer = (patch: Partial<SenderPeerView>): SenderPeerView => ({
  id: 'a'.repeat(16),
  label: '받는 사람 1',
  phase: 'connecting',
  ackedBytes: 0,
  totalBytes: 10,
  speed: 0,
  ...patch,
});

describe('describeJoinError', () => {
  it.each([
    ['ROOM_NOT_FOUND', '없는 코드'],
    ['ROOM_EXPIRED', '만료'],
    ['ROOM_FULL', '가득'],
    ['RATE_LIMITED', '잠시'],
    ['SERVER_UNAVAILABLE', '서버에 연결하지 못했어요'],
  ])('explains %s in Korean', (code, fragment) => {
    const { title, body } = describeJoinError(code);
    expect(title).toContain(fragment);
    expect(body.length).toBeGreaterThan(10);
  });

  it('explains the 30 minute join window on expiry and the 3 person limit when full', () => {
    expect(describeJoinError('ROOM_EXPIRED').body).toContain('30분');
    expect(describeJoinError('ROOM_FULL').body).toContain('3명');
  });

  it('falls back to a generic message for unknown codes', () => {
    expect(describeJoinError('SOMETHING_NEW').title).toBe('연결하지 못했어요');
  });
});

describe('describeReceiverFailure', () => {
  it('tells the receiver the sender closed the window', () => {
    expect(describeReceiverFailure('SENDER_LEFT', true).title).toBe('보내는 사람이 창을 닫았어요');
    expect(describeReceiverFailure('sender-left', true).title).toBe('보내는 사람이 창을 닫았어요');
  });

  it('mentions the missing TURN relay only when none is configured', () => {
    expect(describeReceiverFailure('connect-timeout', false).body).toContain(TURN_MISSING_HINT);
    expect(describeReceiverFailure('ice-failed', true).body).not.toContain('TURN');
  });

  it('covers storage and server restart failures', () => {
    expect(describeReceiverFailure('storage', true).title).toContain('저장');
    expect(describeReceiverFailure('SERVER_SHUTDOWN', true).title).toContain('다시 시작');
  });
});

describe('describeSenderPeer', () => {
  it('describes each phase', () => {
    expect(describeSenderPeer(peer({ phase: 'connecting' }), true)).toContain('연결');
    expect(describeSenderPeer(peer({ phase: 'waiting' }), true)).toContain('확인');
    expect(describeSenderPeer(peer({ phase: 'sending' }), true)).toContain('보내는 중');
    expect(describeSenderPeer(peer({ phase: 'done' }), true)).toContain('마쳤');
    expect(describeSenderPeer(peer({ phase: 'left' }), true)).toContain('나갔');
    expect(describeSenderPeer(peer({ phase: 'canceled' }), true)).toContain('취소');
  });

  it('explains a rejection caused by the 500MB memory limit', () => {
    expect(describeSenderPeer(peer({ phase: 'rejected', reason: 'too-large' }), true)).toContain('500MB');
  });

  it('adds the TURN hint to connection failures only without TURN', () => {
    const failed = peer({ phase: 'failed', reason: 'connect-timeout' });
    expect(describeSenderPeer(failed, false)).toContain('TURN');
    expect(describeSenderPeer(failed, true)).not.toContain('TURN');
  });
});

describe('describeSenderClosed', () => {
  it('explains that the transfers ended and the code is gone', () => {
    expect(describeSenderClosed('CONNECTION_LOST').body).toContain('멈췄');
    expect(describeSenderClosed('SERVER_SHUTDOWN').title).toContain('다시 시작');
  });
});
