import { MAX_BLOB_BYTES } from '../../shared/transfer';
import type { SenderPeerView } from './senderSession';

export const TURN_MISSING_HINT =
  '중계(TURN) 서버가 설정되지 않아서, 일부 네트워크에서는 연결되지 않을 수 있어요.';

export const MEMORY_LIMIT = `${MAX_BLOB_BYTES / (1024 * 1024)}MB`;

export interface Message {
  title: string;
  body: string;
}

/** Errors the server (or the network) gave when trying to enter a code. */
export function describeJoinError(code: string | undefined): Message {
  switch (code) {
    case 'ROOM_NOT_FOUND':
      return { title: '없는 코드예요', body: '숫자를 다시 확인해주세요\n보내는 사람이 창을 닫았다면 코드도 함께 사라져요' };
    case 'ROOM_EXPIRED':
      return {
        title: '코드가 만료됐어요',
        body: '새로운 사람은 코드가 만들어지고 30분 동안만 들어올 수 있어요. 보내는 사람에게 새 코드를 받아주세요.',
      };
    case 'ROOM_FULL':
      return {
        title: '받는 사람이 가득 찼어요',
        body: '한 번에 3명까지 받을 수 있어요. 다른 사람이 끝난 뒤에 다시 시도해주세요.',
      };
    case 'SENDER_AWAY':
      return { title: '보내는 사람 연결이 잠시 끊겼어요', body: '곧 돌아올 수 있어요. 잠시 뒤에 코드를 다시 입력해주세요.' };
    case 'RATE_LIMITED':
      return { title: '잠시 쉬었다 시도해주세요', body: '짧은 시간에 너무 많이 시도했어요. 1분쯤 뒤에 다시 입력해주세요.' };
    case 'SERVER_UNAVAILABLE':
      return { title: '서버에 연결하지 못했어요', body: '인터넷 연결을 확인하고 다시 시도해주세요.' };
    default:
      return { title: '연결하지 못했어요', body: '잠시 뒤에 다시 시도해주세요.' };
  }
}

function connectBody(hasTurn: boolean): string {
  return hasTurn
    ? '두 기기가 서로 연결되지 못했어요. 다른 네트워크에서 다시 시도해보세요.'
    : `두 기기가 서로 연결되지 못했어요. ${TURN_MISSING_HINT}`;
}

/** Why a receiving attempt that had already joined the room stopped. */
export function describeReceiverFailure(reason: string | undefined, hasTurn: boolean): Message {
  switch (reason) {
    case 'SENDER_LEFT':
    case 'sender-left':
      return { title: '보내는 사람이 창을 닫았어요', body: '전송이 멈췄어요. 보내는 사람에게 다시 보내달라고 부탁해주세요.' };
    case 'sender-aborted':
      return { title: '보내는 사람이 전송을 멈췄어요', body: '보내는 사람에게 다시 보내달라고 부탁해주세요.' };
    case 'SERVER_SHUTDOWN':
      return { title: '서버가 다시 시작됐어요', body: '전송이 멈췄어요. 보내는 사람에게 새 코드를 받아주세요.' };
    case 'CONNECTION_LOST':
      return { title: '서버와 연결이 끊어졌어요', body: '인터넷 연결을 확인하고 코드를 다시 입력해주세요.' };
    case 'connection-lost':
      return {
        title: '연결이 끊어졌어요',
        body: '보내는 사람이 창을 닫았거나 네트워크가 불안정할 수 있어요.\n다시 시도해주세요.',
      };
    case 'connect-timeout':
    case 'ice-failed':
      return { title: '연결하지 못했어요', body: connectBody(hasTurn) };
    case 'storage':
      return { title: '파일을 저장하지 못했어요', body: '저장 공간과 저장 위치를 확인하고 다시 시도해주세요.' };
    default:
      return { title: '전송 중에 문제가 생겼어요', body: '잠시 뒤에 다시 시도해주세요.' };
  }
}

/** One line for a receiver row on the sender screen. */
export function describeSenderPeer(peer: SenderPeerView, hasTurn: boolean): string {
  switch (peer.phase) {
    case 'connecting':
      return '연결하는 중이에요';
    case 'waiting':
      return '받을지 확인하는 중이에요';
    case 'sending':
      return '보내는 중이에요';
    case 'paused':
      return '연결이 끊겨서 다시 연결하는 중이에요';
    case 'done':
      return '받기를 마쳤어요';
    case 'canceled':
      return '받기를 취소했어요';
    case 'left':
      return '나갔어요';
    case 'rejected':
      return peer.reason === 'too-large'
        ? `이 브라우저는 ${MEMORY_LIMIT}까지만 받을 수 있어서 받지 못했어요`
        : '받지 않기로 했어요';
    case 'failed':
      if (peer.reason === 'connect-timeout' || peer.reason === 'ice-failed' || peer.reason === 'receiver-failed') {
        return hasTurn ? '연결하지 못했어요' : `연결하지 못했어요. ${TURN_MISSING_HINT}`;
      }
      if (peer.reason === 'connection-lost') return '연결이 끊어졌어요';
      return '전송 중에 문제가 생겼어요';
  }
}

/** Why several files could not be bundled into one zip. */
export function describeBundleError(reason: string): Message {
  switch (reason) {
    case 'too-many':
      return { title: '파일이 너무 많아요', body: '한 번에 1000개까지 보낼 수 있어요.\n파일 수를 줄여서 다시 골라주세요.' };
    case 'too-large':
      return { title: '파일이 너무 커요', body: '여러 파일은 합쳐서 4GB까지 한 번에 보낼 수 있어요.\n파일을 나눠서 다시 골라주세요.' };
    default:
      return { title: '파일을 읽지 못했어요', body: '파일이 삭제됐거나 다른 곳에서 열려 있는지 확인하고\n다시 골라주세요.' };
  }
}

/** The sender's room is gone: every transfer ended. */
export function describeSenderClosed(reason: string | undefined): Message {
  if (reason === 'SERVER_SHUTDOWN') {
    return { title: '서버가 다시 시작됐어요', body: '전송이 멈췄고 코드도 사라졌어요. 새 코드를 만들어주세요.' };
  }
  return { title: '서버와 연결이 끊어졌어요', body: '전송이 멈췄고 코드도 사라졌어요. 새 코드를 만들어주세요.' };
}

export const MEMORY_DOWNLOAD_NOTICE = `이 브라우저는 파일을 메모리에 담았다가 다운로드해요. 최대 ${MEMORY_LIMIT}까지 받을 수 있어요.`;
