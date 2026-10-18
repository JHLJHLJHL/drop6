import { hasTurnServer, type IceServerConfig } from '../../shared/ice';
import { MAX_RECEIVERS, SENDER_GRACE_MS, type ProgressState, type ServerMessage, type SignalData } from '../../shared/protocol';
import type { FileSource, SeparateSource } from './channel';
import { FileSender, type SendSnapshot } from './fileSender';
import { fetchIceServers } from './iceConfig';
import { CONNECT_TIMEOUT_MS, CandidateQueue, candidateSignal, createPeerConnection } from './rtc';
import { connectSignaling, type SignalingClient } from './signalingClient';
import { SpeedMeter } from './speedMeter';
import { createNamePicker } from './speciesNames';
import { Store } from './store';

/** `paused`: the connection to this receiver dropped mid-transfer; it is connected again as soon as possible and continues where it stopped. */
export type SenderPeerPhase = 'connecting' | 'waiting' | 'sending' | 'paused' | 'done' | 'rejected' | 'canceled' | 'failed' | 'left';

export interface SenderPeerView {
  id: string;
  label: string;
  phase: SenderPeerPhase;
  ackedBytes: number;
  totalBytes: number;
  speed: number;
  reason?: string | undefined;
}

export type SenderPhase = 'starting' | 'open' | 'closed' | 'error';

export interface SenderState {
  phase: SenderPhase;
  /** What is offered: the file itself, or the zip bundling several files (a receiver may take those files one by one instead). */
  file: { name: string; size: number };
  /** How many files the user picked (more than 1 means `file` is a zip). */
  fileCount: number;
  code?: string | undefined;
  expiresAt?: number | undefined;
  /** serverTime - Date.now() at room creation, so the countdown follows the server clock. */
  clockOffset: number;
  maxReceivers: number;
  connectedCount: number;
  peers: SenderPeerView[];
  /** The connection to the server dropped and is being re-established; the room (and its code) is still kept. */
  reconnecting: boolean;
  /** Why the session is closed/errored: an ErrorCode, or a client-side label. */
  reason?: string | undefined;
  hasTurn: boolean;
}

const FINISHED: readonly SenderPeerPhase[] = ['done', 'rejected', 'canceled', 'failed', 'left'];

export function isPeerActive(peer: SenderPeerView): boolean {
  return !FINISHED.includes(peer.phase);
}

/** Connecting to one receiver again after a drop: how often in a row that may fail to get any further, and how soon the first try is made. */
const MAX_RELINKS = 5;
const RELINK_DELAY_MS = 1_000;
/** Between attempts to reach the server again, and for how long they go on (the server holds the room that long). */
const RECONNECT_RETRY_MS = 2_000;
const RECONNECT_WINDOW_MS = SENDER_GRACE_MS;

interface LinkDeps {
  iceServers: IceServerConfig[];
  file: FileSource;
  separate: SeparateSource | undefined;
  sendSignal(to: string, data: SignalData): void;
  onChange(view: SenderPeerView): void;
  /** The connection broke mid-transfer; the link keeps what was acked and waits to be replaced. */
  onLost(id: string): void;
}

/** One receiver: its own RTCPeerConnection, DataChannel and FileSender. Failures stay inside this object. */
class PeerLink {
  private readonly pc: RTCPeerConnection;
  private readonly queue: CandidateQueue;
  private readonly meter = new SpeedMeter();
  private transfer: FileSender | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private view: SenderPeerView;
  private retired = false;
  private readonly startAcked: number;
  /** Connections made again in a row without getting any further; reset once bytes move past where this link began. */
  recoveries: number;

  /** `resumed`: this link replaces one that dropped, so its progress carries over and the receiver continues from it. */
  constructor(
    readonly id: string,
    label: string,
    private readonly deps: LinkDeps,
    resumed?: { ackedBytes: number; recoveries: number },
  ) {
    this.startAcked = resumed?.ackedBytes ?? 0;
    this.recoveries = resumed?.recoveries ?? 0;
    this.view = { id, label, phase: 'connecting', ackedBytes: this.startAcked, totalBytes: deps.file.size, speed: 0 };
    this.pc = createPeerConnection(deps.iceServers);
    this.queue = new CandidateQueue(this.pc);

    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) deps.sendSignal(id, candidateSignal(candidate));
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed' && this.view.phase === 'connecting') this.fail('ice-failed');
    };

    const channel = this.pc.createDataChannel('file', { ordered: true });
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      clearTimeout(this.timer);
      this.transfer = new FileSender(channel, deps.file, (snapshot) => this.onTransfer(snapshot), deps.separate);
      this.transfer.start();
    };
    this.timer = setTimeout(() => this.fail('connect-timeout'), CONNECT_TIMEOUT_MS);
  }

  get current(): SenderPeerView {
    return this.view;
  }

  /** Nothing more will happen on this link: the transfer finished one way or another, or the receiver left. */
  get settled(): boolean {
    return FINISHED.includes(this.view.phase);
  }

  /** Replaced by a newer link: let go of the connection without reporting anything. */
  retire(): void {
    this.retired = true;
    this.dispose();
  }

  /** Too many drops in a row: stop trying for this receiver. */
  giveUp(): void {
    this.fail('connection-lost');
  }

  async begin(): Promise<void> {
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.deps.sendSignal(this.id, { kind: 'offer', sdp: this.pc.localDescription?.sdp ?? '' });
    } catch {
      this.fail('ice-failed');
    }
  }

  async handleSignal(data: SignalData): Promise<void> {
    try {
      if (data.kind === 'answer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        await this.queue.flush();
      } else if (data.kind === 'candidate') {
        await this.queue.add(data.candidate as RTCIceCandidateInit);
      }
    } catch {
      this.fail('ice-failed');
    }
  }

  /** The receiver reported over signaling; only useful as a failure hint before the DataChannel opened. */
  noteReceiverState(state: ProgressState): void {
    if (this.view.phase === 'connecting' && (state === 'failed' || state === 'canceled')) this.fail('receiver-failed');
  }

  peerLeft(): void {
    if (!FINISHED.includes(this.view.phase)) {
      this.transfer?.cancel();
      this.set({ phase: 'left', speed: 0 });
    }
    this.dispose(); // a finished receiver's connection is released once it leaves
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }

  private fail(reason: string): void {
    if (FINISHED.includes(this.view.phase)) return;
    this.set({ phase: 'failed', reason, speed: 0 });
    this.dispose();
  }

  private onTransfer(snapshot: SendSnapshot): void {
    if (this.retired) return;
    // The connection broke after the receiver was reached: keep what it has and let the session connect again.
    if (snapshot.phase === 'failed' && snapshot.reason === 'connection-lost' && (this.view.phase === 'waiting' || this.view.phase === 'sending')) {
      this.set({ phase: 'paused', speed: 0 });
      this.dispose();
      this.deps.onLost(this.id);
      return;
    }
    // Bytes moved past where this link began: the next drop starts counting from zero again.
    if (snapshot.ackedBytes > this.startAcked) this.recoveries = 0;
    this.meter.record(snapshot.ackedBytes);
    const finished = snapshot.phase === 'done' || snapshot.phase === 'rejected' || snapshot.phase === 'canceled' || snapshot.phase === 'failed';
    this.set({
      phase: snapshot.phase,
      // never backwards: a link that took over from a dropped one starts its own count at zero
      ackedBytes: Math.max(snapshot.ackedBytes, this.view.ackedBytes),
      totalBytes: snapshot.totalBytes,
      speed: finished ? 0 : this.meter.bytesPerSecond,
      reason: snapshot.reason,
    });
    // Rejected / canceled / failed connections are done; a finished one stays until the receiver leaves.
    if (finished && snapshot.phase !== 'done') this.dispose();
  }

  private set(patch: Partial<SenderPeerView>): void {
    this.view = { ...this.view, ...patch };
    this.deps.onChange(this.view);
  }
}

/** How an attempt to take the room back ended. */
type ResumeOutcome = 'resumed' | 'lost' | 'refused';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SenderSession extends Store<SenderState> {
  private signaling: SignalingClient | undefined;
  private iceServers: IceServerConfig[] = [];
  private readonly links = new Map<string, PeerLink>();
  /** Receivers are shown under fish scientific names instead of numbers. */
  private readonly nextName = createNamePicker();
  private disposed = false;
  /** Given with the room; lets this sender take the room back after its connection dropped. */
  private secret: string | undefined;
  /** Counts sockets so that events of an abandoned one are ignored. */
  private socketGeneration = 0;
  private reconnecting = false;
  private resumeOutcome: ((outcome: ResumeOutcome) => void) | undefined;

  constructor(
    private readonly file: FileSource,
    fileCount = 1,
    private readonly separate?: SeparateSource,
  ) {
    super({
      phase: 'starting',
      file: { name: file.name, size: file.size },
      fileCount,
      clockOffset: 0,
      maxReceivers: MAX_RECEIVERS,
      connectedCount: 0,
      peers: [],
      reconnecting: false,
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
      signaling.send({ type: 'create-room' });
    } catch {
      if (!this.disposed) this.update({ phase: 'error', reason: 'SERVER_UNAVAILABLE' });
    }
  }

  /** Leaves the room: the code stops working and every transfer ends. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signaling?.send({ type: 'leave' });
    this.signaling?.close();
    this.resumeOutcome?.('lost'); // ends a reconnection attempt that is still waiting
    for (const link of this.links.values()) link.dispose();
    this.links.clear();
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
      case 'room-created':
        this.secret = message.secret;
        this.update({
          phase: 'open',
          code: message.code,
          expiresAt: message.expiresAt,
          clockOffset: message.serverTime - Date.now(),
          maxReceivers: message.maxReceivers,
        });
        break;
      case 'room-resumed':
        this.update({
          phase: 'open',
          expiresAt: message.expiresAt,
          clockOffset: message.serverTime - Date.now(),
          maxReceivers: message.maxReceivers,
          connectedCount: message.receiverIds.length,
        });
        this.reconnectReceivers(message.receiverIds);
        this.resumeOutcome?.('resumed');
        break;
      case 'peer-joined':
        this.addPeer(message.peerId);
        this.update({ connectedCount: message.receiverCount });
        break;
      case 'peer-left':
        this.links.get(message.peerId)?.peerLeft();
        this.update({ connectedCount: message.receiverCount });
        break;
      case 'signal':
        void this.links.get(message.from)?.handleSignal(message.data);
        break;
      case 'transfer-progress':
        this.links.get(message.from)?.noteReceiverState(message.state);
        break;
      case 'room-closed':
        this.closeAll(message.reason);
        break;
      case 'error':
        if (this.resumeOutcome) this.resumeOutcome('refused');
        else if (this.getState().phase === 'starting') this.update({ phase: 'error', reason: message.code });
        break;
      case 'room-joined':
        break;
    }
  }

  private linkDeps(): LinkDeps {
    return {
      iceServers: this.iceServers,
      file: this.file,
      separate: this.separate,
      sendSignal: (to, data) => this.signaling?.send({ type: 'signal', to, data }),
      onChange: (view) => this.updatePeer(view),
      onLost: (id) => this.linkLost(id),
    };
  }

  private addPeer(id: string): void {
    const link = new PeerLink(id, this.nextName(), this.linkDeps());
    this.links.set(id, link);
    this.updatePeer(link.current);
    void link.begin();
  }

  /** Connects to a receiver again after the old connection dropped; it continues from what it already saved. */
  private relink(old: PeerLink): void {
    if (old.recoveries >= MAX_RELINKS) {
      old.giveUp();
      return;
    }
    const { id, label, ackedBytes } = old.current;
    old.retire();
    const link = new PeerLink(id, label, this.linkDeps(), { ackedBytes, recoveries: old.recoveries + 1 });
    this.links.set(id, link);
    this.updatePeer(link.current);
    void link.begin();
  }

  /** One connection broke while the server connection is fine: try that receiver again shortly. */
  private linkLost(id: string): void {
    if (this.disposed || this.reconnecting) return; // after a reconnect, every receiver is connected again anyway
    setTimeout(() => {
      const link = this.links.get(id);
      if (this.disposed || this.reconnecting || link?.current.phase !== 'paused') return;
      this.relink(link);
    }, RELINK_DELAY_MS);
  }

  /** The room is ours again: whoever was still connected needs a fresh connection, anyone else left meanwhile. */
  private reconnectReceivers(receiverIds: readonly string[]): void {
    const present = new Set(receiverIds);
    for (const [id, link] of this.links) {
      if (!present.has(id)) link.peerLeft();
    }
    for (const id of receiverIds) {
      const link = this.links.get(id);
      if (!link) this.addPeer(id);
      else if (!link.settled) this.relink(link);
    }
  }

  private updatePeer(view: SenderPeerView): void {
    const peers = this.getState().peers;
    const exists = peers.some((peer) => peer.id === view.id);
    this.update({ peers: exists ? peers.map((peer) => (peer.id === view.id ? view : peer)) : [...peers, view] });
  }

  private handleSocketClosed(): void {
    if (this.disposed) return;
    this.signaling = undefined;
    if (this.resumeOutcome) {
      this.resumeOutcome('lost'); // an attempt to take the room back lost its socket: the loop tries again
      return;
    }
    // The room is kept for a while: a phone that fell asleep or switched networks can take it back.
    if (this.getState().phase === 'open' && this.secret) void this.reconnect();
    else this.closeAll('CONNECTION_LOST');
  }

  /** Reaches the server again and asks for the room back, until it works or the server would have given the room up. */
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.update({ reconnecting: true });
    const code = this.getState().code;
    const deadline = Date.now() + RECONNECT_WINDOW_MS;
    while (!this.disposed && code && this.secret && Date.now() < deadline) {
      const signaling = await this.openSocket().catch(() => undefined);
      if (!signaling) {
        await sleep(RECONNECT_RETRY_MS);
        continue;
      }
      if (this.disposed) {
        signaling.close();
        break;
      }
      this.signaling = signaling;
      const outcome = new Promise<ResumeOutcome>((resolve) => {
        this.resumeOutcome = resolve;
      });
      signaling.send({ type: 'resume-room', code, secret: this.secret });
      const result = await outcome;
      this.resumeOutcome = undefined;
      if (result === 'resumed') {
        this.reconnecting = false;
        this.update({ reconnecting: false });
        return;
      }
      if (result === 'refused') break;
      if (!this.disposed) await sleep(RECONNECT_RETRY_MS);
    }
    this.reconnecting = false;
    if (!this.disposed) this.closeAll('CONNECTION_LOST');
  }

  /** The room is gone (sender socket lost for good or server stopping): every transfer ends. */
  private closeAll(reason: string): void {
    for (const link of this.links.values()) link.peerLeft();
    this.links.clear();
    this.update({ phase: 'closed', reason, connectedCount: 0, reconnecting: false });
  }
}
