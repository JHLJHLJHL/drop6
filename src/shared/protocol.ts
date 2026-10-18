import { z } from 'zod';

export const MAX_RECEIVERS = 3;
export const ROOM_TTL_MS = 30 * 60 * 1000;
/** How long a room waits for its sender to come back after the sender's connection dropped (phone asleep, network change). */
export const SENDER_GRACE_MS = 3 * 60 * 1000;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const CODE_PATTERN = /^\d{6}$/;
export const JOIN_RATE_LIMIT = { max: 20, windowMs: 60_000 } as const;

export const ERROR_CODES = [
  'INVALID_JSON',
  'INVALID_MESSAGE',
  'UNKNOWN_TYPE',
  'BINARY_NOT_SUPPORTED',
  'ROOM_NOT_FOUND',
  'ROOM_EXPIRED',
  'ROOM_FULL',
  'SENDER_AWAY',
  'RATE_LIMITED',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'NOT_ALLOWED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_JSON: '메시지를 읽을 수 없어요.',
  INVALID_MESSAGE: '메시지 형식이 올바르지 않아요.',
  UNKNOWN_TYPE: '알 수 없는 요청이에요.',
  BINARY_NOT_SUPPORTED: '바이너리 데이터는 보낼 수 없어요. 파일은 서버를 거치지 않아요.',
  ROOM_NOT_FOUND: '없는 코드예요. 숫자를 다시 확인해주세요.',
  ROOM_EXPIRED: '코드가 만료됐어요. 보내는 사람에게 새 코드를 받아주세요.',
  ROOM_FULL: '받는 사람이 이미 3명이에요. 잠시 뒤에 다시 시도해주세요.',
  SENDER_AWAY: '보내는 사람의 연결이 잠시 끊겼어요. 잠시 뒤에 다시 시도해주세요.',
  RATE_LIMITED: '시도가 너무 많아요. 잠시 뒤에 다시 시도해주세요.',
  ALREADY_IN_ROOM: '이미 전송 방에 들어와 있어요.',
  NOT_IN_ROOM: '전송 방에 들어와 있지 않아요.',
  NOT_ALLOWED: '허용되지 않은 요청이에요.',
  INTERNAL: '서버에 문제가 생겼어요. 잠시 뒤에 다시 시도해주세요.',
};

const peerId = z.string().regex(/^[0-9a-f]{16}$/);
/** Known only to the sender: proves it is the same sender when it reconnects to its room. */
const resumeSecret = z.string().regex(/^[0-9a-f]{32}$/);
const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const signalDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), sdp: z.string().min(1).max(40_000) }).strict(),
  z.object({ kind: z.literal('answer'), sdp: z.string().min(1).max(40_000) }).strict(),
  z
    .object({
      kind: z.literal('candidate'),
      candidate: z
        .object({
          candidate: z.string().max(2_000),
          sdpMid: z.string().max(256).nullable().optional(),
          sdpMLineIndex: z.number().int().min(0).max(1024).nullable().optional(),
          usernameFragment: z.string().max(256).nullable().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type SignalData = z.infer<typeof signalDataSchema>;

export const PROGRESS_STATES = [
  'connecting',
  'waiting',
  'receiving',
  'completed',
  'failed',
  'canceled',
] as const;
export type ProgressState = (typeof PROGRESS_STATES)[number];

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create-room') }).strict(),
  z.object({ type: z.literal('join-room'), code: z.string().regex(CODE_PATTERN) }).strict(),
  /** The sender is back after its connection dropped: take over the room again. */
  z.object({ type: z.literal('resume-room'), code: z.string().regex(CODE_PATTERN), secret: resumeSecret }).strict(),
  z.object({ type: z.literal('signal'), to: peerId, data: signalDataSchema }).strict(),
  z
    .object({
      type: z.literal('transfer-progress'),
      state: z.enum(PROGRESS_STATES),
      receivedBytes: byteCount,
      totalBytes: byteCount,
    })
    .strict(),
  z.object({ type: z.literal('leave') }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export const CLIENT_MESSAGE_TYPES: readonly string[] = clientMessageSchema.options.map(
  (option) => option.shape.type.value,
);

export const ROOM_CLOSE_REASONS = ['SENDER_LEFT', 'SERVER_SHUTDOWN'] as const;
export type RoomCloseReason = (typeof ROOM_CLOSE_REASONS)[number];

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('room-created'),
    code: z.string().regex(CODE_PATTERN),
    peerId,
    /** Sent to the sender only; it needs it to resume the room. */
    secret: resumeSecret,
    expiresAt: byteCount,
    serverTime: byteCount,
    maxReceivers: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('room-resumed'),
    peerId,
    expiresAt: byteCount,
    serverTime: byteCount,
    maxReceivers: z.number().int().positive(),
    /** The receivers still in the room; the sender connects to each of them again. */
    receiverIds: z.array(peerId),
  }),
  z.object({
    type: z.literal('room-joined'),
    peerId,
    senderId: peerId,
    expiresAt: byteCount,
    serverTime: byteCount,
    receiverCount: z.number().int().nonnegative(),
    maxReceivers: z.number().int().positive(),
  }),
  z.object({ type: z.literal('peer-joined'), peerId, receiverCount: z.number().int().nonnegative() }),
  z.object({ type: z.literal('peer-left'), peerId, receiverCount: z.number().int().nonnegative() }),
  z.object({ type: z.literal('signal'), from: peerId, data: signalDataSchema }),
  z.object({
    type: z.literal('transfer-progress'),
    from: peerId,
    state: z.enum(PROGRESS_STATES),
    receivedBytes: byteCount,
    totalBytes: byteCount,
  }),
  z.object({ type: z.literal('room-closed'), reason: z.enum(ROOM_CLOSE_REASONS) }),
  z.object({ type: z.literal('error'), code: z.enum(ERROR_CODES), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
