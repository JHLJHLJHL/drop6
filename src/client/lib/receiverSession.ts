import { hasTurnServer, type IceServerConfig } from '../../shared/ice';
import type { ProgressState, ServerMessage, SignalData } from '../../shared/protocol';
import type { Delivery, FileMeta } from '../../shared/transfer';
import { FileReceiver, type ReceiveSnapshot } from './fileReceiver';
import { fetchIceServers } from './iceConfig';
import { CONNECT_TIMEOUT_MS, CandidateQueue, candidateSignal, createPeerConnection } from './rtc';
import { connectSignaling, type SignalingClient } from './signalingClient';
import { BlobSink, hasFileSystemAccess, memorySplitSink, pickDirectorySink, pickFileSystemSink } from './sink';
import { SpeedMeter } from './speedMeter';
import { Store } from './store';

export type ReceiverPhase =
  | 'joining'
  | 'connecting'
  | 'review'
  | 'blocked'
  | 'receiving'
  | 'done'
  | 'canceled'
  | 'failed'
  | 'error';

export interface ReceiverState {
  phase: ReceiverPhase;
  meta?: FileMeta | undefined;
  savedBytes: number;
  speed: number;
  /** file-system: streams to disk. memory: Blob download, limited to 500MB. */
  mode: 'file-system' | 'memory';
  /** What the user chose for a multi-file transfer: the zip, or every file on its own. */
  delivery: Delivery;
  /** Name the user picked in the save dialog, or of the folder the files go into (file-system mode). */
  savedName?: string | undefined;
  /** An ErrorCode for phase 'error'; a client/transfer reason label for 'failed'. */
  reason?: string | undefined;
  hasTurn: boolean;
}

/** Lets a reject/cancel message reach the sender before the connection is torn down. */
const FLUSH_DELAY_MS = 1_000;

export class ReceiverSession extends Store<ReceiverState> {
  private signaling: SignalingClient | undefined;
  private iceServers: IceServerConfig[] = [];
  private pc: RTCPeerConnection | undefined;
  private queue: CandidateQueue | undefined;
  private receiver: FileReceiver | undefined;
  private senderId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly meter = new SpeedMeter();
  private finished = false;
  private disposed = false;

  constructor(private readonly code: string) {
    super({
      phase: 'joining',
      savedBytes: 0,
      speed: 0,
      delivery: 'zip',
      mode: hasFileSystemAccess() ? 'file-system' : 'memory',
      hasTurn: false,
    });
  }

  async start(): Promise<void> {
    try {
      this.iceServers = await fetchIceServers();
      this.update({ hasTurn: hasTurnServer(this.iceServers) });
      this.signaling = await connectSignaling({
        onMessage: (message) => this.handleMessage(message),
        onClose: () => this.handleSocketClosed(),
      });
      if (this.disposed) {
        this.signaling.close();
        return;
      }
      this.signaling.send({ type: 'join-room', code: this.code });
    } catch {
      if (!this.disposed) this.update({ phase: 'error', reason: 'SERVER_UNAVAILABLE' });
    }
  }

  /**
   * The user confirmed. Must be called straight from the click handler: the
   * save dialog needs user activation, so nothing may be awaited before it.
   */
  async accept(delivery: Delivery = 'zip'): Promise<void> {
    const { meta, phase } = this.getState();
    if (!meta || phase !== 'review' || !this.receiver) return;
    const files = delivery === 'files' ? meta.files : undefined;
    if (delivery === 'files' && !files) return;

    if (!hasFileSystemAccess()) {
      this.update({ delivery });
      this.receiver.accept(files ? memorySplitSink(files) : new BlobSink(meta), delivery);
      return;
    }
    try {
      const picked = files ? await pickDirectorySink(files) : await pickFileSystemSink(meta.name);
      if (!picked) return; // dialog dismissed: stay on the review screen
      this.update({ savedName: picked.savedName, delivery });
      this.receiver.accept(picked.sink, delivery);
    } catch {
      this.receiver.abort('storage');
    }
  }

  /** Stops only this receiver's transfer. */
  cancel(): void {
    this.receiver?.cancel();
  }

  /** Leaves the room and closes the connection (also called on unmount). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanup();
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'room-joined':
        this.senderId = message.senderId;
        this.update({ phase: 'connecting' });
        this.timer = setTimeout(() => this.failWith('connect-timeout'), CONNECT_TIMEOUT_MS);
        this.report('connecting');
        break;
      case 'signal':
        if (message.from === this.senderId) void this.handleSignal(message.data);
        break;
      case 'room-closed':
        if (!this.finished) {
          this.receiver?.abort('sender-left');
          this.failWith(message.reason);
        }
        break;
      case 'error':
        if (this.getState().phase === 'joining') {
          this.update({ phase: 'error', reason: message.code });
          this.cleanup();
        }
        break;
      default:
        break;
    }
  }

  private handleSocketClosed(): void {
    if (this.finished || this.disposed) return;
    this.failWith('CONNECTION_LOST');
  }

  private ensurePeerConnection(): { pc: RTCPeerConnection; queue: CandidateQueue } {
    if (this.pc && this.queue) return { pc: this.pc, queue: this.queue };
    const pc = createPeerConnection(this.iceServers);
    this.pc = pc;
    this.queue = new CandidateQueue(pc);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal(candidateSignal(candidate));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.getState().phase === 'connecting') this.failWith('ice-failed');
    };
    pc.ondatachannel = ({ channel }) => {
      channel.binaryType = 'arraybuffer';
      this.receiver = new FileReceiver(channel, { memoryOnly: !hasFileSystemAccess() }, (snapshot) => this.onTransfer(snapshot));
    };
    return { pc, queue: this.queue };
  }

  private async handleSignal(data: SignalData): Promise<void> {
    try {
      const { pc, queue } = this.ensurePeerConnection();
      if (data.kind === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        await queue.flush();
        await pc.setLocalDescription(await pc.createAnswer());
        this.sendSignal({ kind: 'answer', sdp: pc.localDescription?.sdp ?? '' });
      } else if (data.kind === 'candidate') {
        await queue.add(data.candidate as RTCIceCandidateInit);
      }
    } catch {
      this.failWith('ice-failed');
    }
  }

  private sendSignal(data: SignalData): void {
    if (this.senderId) this.signaling?.send({ type: 'signal', to: this.senderId, data });
  }

  private report(state: ProgressState): void {
    const { savedBytes, meta } = this.getState();
    this.signaling?.send({ type: 'transfer-progress', state, receivedBytes: savedBytes, totalBytes: meta?.size ?? 0 });
  }

  private onTransfer(snapshot: ReceiveSnapshot): void {
    if (this.finished) return;
    const { phase, meta, savedBytes } = snapshot;
    switch (phase) {
      case 'review':
        clearTimeout(this.timer);
        this.update({ phase: 'review', meta });
        this.report('waiting');
        break;
      case 'blocked':
        this.update({ phase: 'blocked', meta, reason: 'too-large' });
        this.cleanup(FLUSH_DELAY_MS);
        break;
      case 'receiving':
        this.meter.record(savedBytes);
        this.update({ phase: 'receiving', meta, savedBytes, speed: this.meter.bytesPerSecond });
        break;
      case 'done':
        this.update({ phase: 'done', meta, savedBytes, speed: 0 });
        this.report('completed');
        this.cleanup();
        break;
      case 'canceled':
        this.update({ phase: 'canceled', speed: 0 });
        this.report('canceled');
        this.cleanup(FLUSH_DELAY_MS);
        break;
      case 'failed':
        this.failWith(snapshot.reason ?? 'connection-lost');
        break;
      case 'waiting':
        break;
    }
  }

  private failWith(reason: string): void {
    if (this.finished) return;
    this.update({ phase: 'failed', reason, speed: 0 });
    this.report('failed');
    this.cleanup();
  }

  /** Leaves the room and closes the connection, optionally after letting a last DataChannel message flush. */
  private cleanup(delayMs = 0): void {
    this.finished = true;
    clearTimeout(this.timer);
    const close = () => {
      this.signaling?.send({ type: 'leave' });
      this.signaling?.close();
      if (this.pc) {
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      }
    };
    if (delayMs > 0 && !this.disposed) setTimeout(close, delayMs);
    else close();
  }
}
