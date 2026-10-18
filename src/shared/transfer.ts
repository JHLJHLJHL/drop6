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

/** Most files one transfer can hold (the zip bundle has the same limit). */
export const MAX_BUNDLE_FILES = 1000;

const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const fileEntrySchema = z.object({
  name: z.string().min(1).max(255),
  size: byteCount,
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

/** Control messages the sender transmits as strings. */
export const senderMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('meta'),
    /** The single file, or the zip that bundles `files`. */
    name: z.string().min(1).max(255),
    size: byteCount,
    mime: z.string().max(255),
    /** Present when the transfer holds several files: the receiver may take them one by one instead of the zip. */
    files: z.array(fileEntrySchema).min(2).max(MAX_BUNDLE_FILES).optional(),
  }),
  z.object({ t: z.literal('complete'), size: byteCount }),
  z.object({ t: z.literal('abort'), reason: z.string().max(100) }),
]);
export type SenderMessage = z.infer<typeof senderMessageSchema>;

/** Control messages the receiver transmits as strings. */
export const receiverMessageSchema = z.discriminatedUnion('t', [
  /**
   * `as: 'files'` asks for the files back to back instead of the zip. Left out, the zip (or the single file) is sent.
   * `from` is how many bytes are already saved when a dropped connection is picked up again: the sender continues there.
   */
  z.object({ t: z.literal('accept'), as: z.enum(['zip', 'files']).optional(), from: byteCount.optional() }),
  z.object({ t: z.literal('reject'), reason: z.enum(['too-large', 'declined']) }),
  z.object({ t: z.literal('ack'), bytes: byteCount }),
  z.object({ t: z.literal('cancel') }),
  z.object({ t: z.literal('error'), reason: z.string().max(100) }),
]);
export type ReceiverMessage = z.infer<typeof receiverMessageSchema>;

/** How the receiver wants a multi-file transfer: the zip, or every file on its own. */
export type Delivery = 'zip' | 'files';

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
  files?: FileEntry[] | undefined;
}

export function canReceiveInMemory(size: number): boolean {
  return size <= MAX_BLOB_BYTES;
}

/** Bytes that travel for the chosen delivery: the zip's size, or the files' sizes added up. */
export function payloadSize(meta: FileMeta, delivery: Delivery): number {
  return delivery === 'files' && meta.files ? meta.files.reduce((sum, file) => sum + file.size, 0) : meta.size;
}
