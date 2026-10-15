import { z } from 'zod';

/** File body chunk size sent over the DataChannel. */
export const CHUNK_SIZE = 64 * 1024;
/** The sender never lets RTCDataChannel.bufferedAmount exceed this. */
export const MAX_BUFFERED_AMOUNT = 1024 * 1024;
/** `bufferedamountlow` fires (and sending resumes) once the buffer drains to this. */
export const BUFFERED_LOW_THRESHOLD = 256 * 1024;
/** Sent-but-not-yet-saved bytes the receiver may owe before the sender pauses. */
export const MAX_UNACKED_BYTES = 8 * 1024 * 1024;
/** The receiver acks saved bytes at least this often. */
export const ACK_INTERVAL_BYTES = 256 * 1024;
/** Largest file the in-memory Blob download fallback accepts (500 MB). */
export const MAX_BLOB_BYTES = 500 * 1024 * 1024;

const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Control messages the sender transmits as strings. */
export const senderMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('meta'),
    name: z.string().min(1).max(255),
    size: byteCount,
    mime: z.string().max(255),
  }),
  z.object({ t: z.literal('complete'), size: byteCount }),
  z.object({ t: z.literal('abort'), reason: z.string().max(100) }),
]);
export type SenderMessage = z.infer<typeof senderMessageSchema>;

/** Control messages the receiver transmits as strings. */
export const receiverMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('accept') }),
  z.object({ t: z.literal('reject'), reason: z.enum(['too-large', 'declined']) }),
  z.object({ t: z.literal('ack'), bytes: byteCount }),
  z.object({ t: z.literal('cancel') }),
  z.object({ t: z.literal('error'), reason: z.string().max(100) }),
]);
export type ReceiverMessage = z.infer<typeof receiverMessageSchema>;

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
}

export function canReceiveInMemory(size: number): boolean {
  return size <= MAX_BLOB_BYTES;
}
