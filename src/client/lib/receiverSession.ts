import { hasTurnServer, type IceServerConfig } from '../../shared/ice';
import { RECEIVER_GRACE_MS, type ProgressState, type ServerMessage, type SignalData } from '../../shared/protocol';
import type { Delivery, FileMeta } from '../../shared/transfer';
import { FileReceiver, type ReceiveSnapshot } from './fileReceiver';
import { fetchIceServers } from './iceConfig';
import { CONNECT_TIMEOUT_MS, CandidateQueue, candidateSignal, createPeerConnection } from './rtc';
import { connectSignaling, type SignalingClient } from './signalingClient';
import { BlobSink, hasFileSystemAccess, memorySplitSink, needsPicker, pickDirectorySink, pickFileSystemSink } from './sink';
import { SpeedMeter } from './speedMeter';
import { Store } from './store';

export type ReceiverPhase =
  | 'joining'
  | 'connecting'
  | 'review'
  | 'blocked'
  | 'receiving'
  /** The connection dropped (the sender's or this one's); waiting for it to come back and continue where this left off. */
  | 'paused'
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

/** Between attempts to reach the server again after this receiver's connection dropped, and for how long (the server keeps the seat that long). */
const REJOIN_RETRY_MS = 2_000;
const REJOIN_WINDOW_MS = RECEIVER_GRACE_MS;
/**
 * Paused with nothing happening for this long: the server connection may have died without either side
 * noticing (a phone that slept). Taking the seat again makes the sender connect again. Longer than one
 * connection attempt, so a slow one is not cut short; only a few times in a row.
 */
const STALL_REJOIN_MS = CONNECT_TIMEOUT_MS + 10_000;
const MAX_STALL_REJOINS = 5;

/** How an attempt to take the seat back ended. */
type RejoinOutcome = 'rejoined' | 'lost' | 'refused';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  /** Given with the seat; lets this receiver take it back after its connection dropped. */
  private peerId: string | undefined;
  private secret: string | undefined;
  /** Counts sockets so that events of an abandoned one are ignored. */
  private socketGeneration = 0;
  private rejoining = false;
  private rejoinOutcome: ((outcome: RejoinOutcome) => void) | undefined;
  private stallTimer: ReturnType<typeof setTimeout> | undefined;
  private stallRejoins = 0;

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
      const signaling = await this.openSocket();
      if (this.disposed) {
        signaling.close();
        return;
      }
      this.signaling = signaling;
      signaling.send({ type: 'join-room', code: this.code });
    } catch {
      if (!this.disposed) this.update({ phase: 'error', reason: 'SERVER_UNAVAILABLE' });
    }
  }

  /**
   * The user confirmed. Must be called straight from the click handler: the
   * save dialog needs user activation, so nothing may be awaited before it.
   * `chooseLocation` asks for the save dialog; otherwise the browser downloads into its downloads folder.
   */
  async accept(delivery: Delivery = 'zip', chooseLocation = false): Promise<void> {
    const { meta, phase } = this.getState();
    if (!meta || phase !== 'review' || !this.receiver) return;
    const files = delivery === 'files' ? meta.files : undefined;
    if (delivery === 'files' && !files) return;

    if (!needsPicker(meta, delivery, chooseLocation)) {
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

  /**
   * The page is visible again (a phone woke up). A server connection that died meanwhile may still look
   * open; sending on it makes it fail right away, which starts taking the seat back.
   */
  checkConnection(): void {
    if (this.finished || this.disposed || this.rejoining || !this.canRejoin()) return;
    const { phase } = this.getState();
    this.report(phase === 'connecting' ? 'connecting' : phase === 'review' ? 'waiting' : 'receiving');
  }

  private openSocket(): Promise<SignalingClient> {
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    return connectSignaling({
      onMessage: (message) => {
        if (generation === this.socketGeneration) this.handleMessage(message);
      },
      onClose: () => {
        if (generation === this.socketGeneration) this.handleSocketClosed();
      },
    });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'room-rejoined':
        this.senderId = message.senderId;
        this.rejoinOutcome?.('rejoined');
        break;
      case 'room-joined':
        this.senderId = message.senderId;
        this.peerId = message.peerId;
        this.secret = message.secret;
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
        if (this.rejoinOutcome) {
          this.rejoinOutcome('refused');
        } else if (this.getState().phase === 'joining') {
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
    this.signaling = undefined;
    if (this.rejoinOutcome) {
      this.rejoinOutcome('lost'); // an attempt to take the seat back lost its socket: the loop tries again
      return;
    }
    // The server keeps the seat for a while: a phone that fell asleep takes it back and continues where it stopped.
    if (this.canRejoin()) void this.rejoin();
    else this.failWith('CONNECTION_LOST');
  }

  /** There is a seat to take back, and something on it worth continuing. */
  private canRejoin(): boolean {
    const { phase } = this.getState();
    return (
      this.peerId !== undefined &&
      this.secret !== undefined &&
      (phase === 'connecting' || phase === 'review' || phase === 'receiving' || phase === 'paused')
    );
  }

  /**
   * Reaches the server again and takes the seat back, until it works or the server would have given the
   * seat up. The sender then connects again and the transfer continues after what is already saved.
   */
  private async rejoin(): Promise<void> {
    if (this.rejoining) return;
    this.rejoining = true;
    this.clearStallTimer();
    const deadline = Date.now() + REJOIN_WINDOW_MS;
    let refused = false;
    while (!this.finished && !this.disposed && this.peerId && this.secret && Date.now() < deadline) {
      const signaling = await this.openSocket().catch(() => undefined);
      if (!signaling) {
        await sleep(REJOIN_RETRY_MS);
        continue;
      }
      if (this.finished || this.disposed) {
        signaling.close();
        break;
      }
      this.signaling = signaling;
      const outcome = new Promise<RejoinOutcome>((resolve) => {
        this.rejoinOutcome = resolve;
      });
      signaling.send({ type: 'rejoin-room', code: this.code, peerId: this.peerId, secret: this.secret });
      const result = await outcome;
      this.rejoinOutcome = undefined;
      if (result === 'rejoined') {
        this.rejoining = false;
        if (this.getState().phase === 'paused') this.armStallTimer();
        return;
      }
      if (result === 'refused') {
        refused = true;
        break;
      }
      if (!this.finished && !this.disposed) await sleep(REJOIN_RETRY_MS);
    }
    this.rejoining = false;
    if (this.finished || this.disposed) return;
    // Away too long, or the sender ended the transfer: what was received so far is let go.
    this.failWith(refused ? 'rejoin-refused' : 'CONNECTION_LOST');
    this.receiver?.abort('connection-lost');
  }

  /** Waits a while for a paused transfer to pick up again; if nothing happens, takes the seat again. */
  private armStallTimer(): void {
    clearTimeout(this.stallTimer);
    if (this.stallRejoins >= MAX_STALL_REJOINS) return;
    this.stallTimer = setTimeout(() => this.recoverStall(), STALL_REJOIN_MS);
  }

  private clearStallTimer(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  private recoverStall(): void {
    this.stallTimer = undefined;
    if (this.finished || this.disposed || this.rejoining || this.getState().phase !== 'paused') return;
    this.stallRejoins += 1;
    // Closing the socket starts taking the seat back (see handleSocketClosed).
    if (this.signaling) this.signaling.close();
    else void this.rejoin();
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
      if (this.receiver?.isPaused) {
        this.receiver.resume(channel); // the sender is back: continue after what is already saved
        return;
      }
      this.receiver = new FileReceiver(channel, { memoryOnly: !hasFileSystemAccess() }, (snapshot) => this.onTransfer(snapshot));
    };
    return { pc, queue: this.queue };
  }

  /**
   * The sender starts over with a new connection (it came back, or its old one broke). What was being
   * received is kept and picked up on the new connection; a transfer that never began is simply replaced.
   */
  private replaceConnection(): void {
    if (!this.pc) return;
    this.receiver?.suspend();
    if (this.receiver && !this.receiver.isPaused) {
      this.receiver.detach();
      this.receiver = undefined;
    }
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    this.pc.close();
    this.pc = undefined;
    this.queue = undefined;
  }

  private async handleSignal(data: SignalData): Promise<void> {
    try {
      if (data.kind === 'offer') {
        this.replaceConnection();
        // A new attempt to continue: give it its full time before taking the seat again.
        if (this.getState().phase === 'paused' && !this.rejoining) this.armStallTimer();
      }
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
        if (this.stallTimer !== undefined || this.stallRejoins > 0) {
          this.clearStallTimer();
          this.stallRejoins = 0;
        }
        this.meter.record(savedBytes);
        this.update({ phase: 'receiving', meta, savedBytes, speed: this.meter.bytesPerSecond });
        break;
      case 'paused':
        this.update({ phase: 'paused', meta, savedBytes, speed: 0 });
        if (!this.rejoining) this.armStallTimer();
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
    this.clearStallTimer();
    this.rejoinOutcome?.('lost'); // ends an attempt to take the seat back that is still waiting
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
