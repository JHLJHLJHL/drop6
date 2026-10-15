import { hasTurnServer, type IceServerConfig } from '../../shared/ice';
import { MAX_RECEIVERS, type ProgressState, type ServerMessage, type SignalData } from '../../shared/protocol';
import type { FileSource, SeparateSource } from './channel';
import { FileSender, type SendSnapshot } from './fileSender';
import { fetchIceServers } from './iceConfig';
import { CONNECT_TIMEOUT_MS, CandidateQueue, candidateSignal, createPeerConnection } from './rtc';
import { connectSignaling, type SignalingClient } from './signalingClient';
import { SpeedMeter } from './speedMeter';
import { createNamePicker } from './speciesNames';
import { Store } from './store';

export type SenderPeerPhase = 'connecting' | 'waiting' | 'sending' | 'done' | 'rejected' | 'canceled' | 'failed' | 'left';

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
  /** Why the session is closed/errored: an ErrorCode, or a client-side label. */
  reason?: string | undefined;
  hasTurn: boolean;
}

const FINISHED: readonly SenderPeerPhase[] = ['done', 'rejected', 'canceled', 'failed', 'left'];

export function isPeerActive(peer: SenderPeerView): boolean {
  return !FINISHED.includes(peer.phase);
}

interface LinkDeps {
  iceServers: IceServerConfig[];
  file: FileSource;
  separate: SeparateSource | undefined;
  sendSignal(to: string, data: SignalData): void;
  onChange(view: SenderPeerView): void;
}

/** One receiver: its own RTCPeerConnection, DataChannel and FileSender. Failures stay inside this object. */
class PeerLink {
  private readonly pc: RTCPeerConnection;
  private readonly queue: CandidateQueue;
  private readonly meter = new SpeedMeter();
  private transfer: FileSender | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private view: SenderPeerView;

  constructor(
    readonly id: string,
    label: string,
    private readonly deps: LinkDeps,
  ) {
    this.view = { id, label, phase: 'connecting', ackedBytes: 0, totalBytes: deps.file.size, speed: 0 };
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
    this.meter.record(snapshot.ackedBytes);
    const finished = snapshot.phase === 'done' || snapshot.phase === 'rejected' || snapshot.phase === 'canceled' || snapshot.phase === 'failed';
    this.set({
      phase: snapshot.phase,
      ackedBytes: snapshot.ackedBytes,
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

export class SenderSession extends Store<SenderState> {
  private signaling: SignalingClient | undefined;
  private iceServers: IceServerConfig[] = [];
  private readonly links = new Map<string, PeerLink>();
  /** Receivers are shown under fish scientific names instead of numbers. */
  private readonly nextName = createNamePicker();
  private disposed = false;

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
      this.signaling.send({ type: 'create-room' });
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
    for (const link of this.links.values()) link.dispose();
    this.links.clear();
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'room-created':
        this.update({
          phase: 'open',
          code: message.code,
          expiresAt: message.expiresAt,
          clockOffset: message.serverTime - Date.now(),
          maxReceivers: message.maxReceivers,
        });
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
        if (this.getState().phase === 'starting') this.update({ phase: 'error', reason: message.code });
        break;
      case 'room-joined':
        break;
    }
  }

  private addPeer(id: string): void {
    const link = new PeerLink(id, this.nextName(), {
      iceServers: this.iceServers,
      file: this.file,
      separate: this.separate,
      sendSignal: (to, data) => this.signaling?.send({ type: 'signal', to, data }),
      onChange: (view) => this.updatePeer(view),
    });
    this.links.set(id, link);
    this.updatePeer(link.current);
    void link.begin();
  }

  private updatePeer(view: SenderPeerView): void {
    const peers = this.getState().peers;
    const exists = peers.some((peer) => peer.id === view.id);
    this.update({ peers: exists ? peers.map((peer) => (peer.id === view.id ? view : peer)) : [...peers, view] });
  }

  private handleSocketClosed(): void {
    if (this.disposed) return;
    this.closeAll('CONNECTION_LOST');
  }

  /** The room is gone (sender socket lost or server stopping): every transfer ends. */
  private closeAll(reason: string): void {
    for (const link of this.links.values()) link.peerLeft();
    this.links.clear();
    this.update({ phase: 'closed', reason, connectedCount: 0 });
  }
}
