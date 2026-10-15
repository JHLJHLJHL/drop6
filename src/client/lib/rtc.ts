import type { IceServerConfig } from '../../shared/ice';
import type { SignalData } from '../../shared/protocol';

export const CONNECT_TIMEOUT_MS = 30_000;

export function createPeerConnection(iceServers: IceServerConfig[]): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: iceServers.map((server) => ({ ...server })) });
}

export function candidateSignal(candidate: RTCIceCandidate): SignalData {
  const { candidate: line, sdpMid, sdpMLineIndex, usernameFragment } = candidate.toJSON();
  return {
    kind: 'candidate',
    candidate: {
      candidate: line ?? '',
      sdpMid: sdpMid ?? null,
      sdpMLineIndex: sdpMLineIndex ?? null,
      usernameFragment: usernameFragment ?? null,
    },
  };
}

/** Holds ICE candidates that arrive before the remote description is set. */
export class CandidateQueue {
  private pending: RTCIceCandidateInit[] = [];
  private ready = false;

  constructor(private readonly pc: RTCPeerConnection) {}

  async add(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.ready) {
      this.pending.push(candidate);
      return;
    }
    await this.apply(candidate);
  }

  async flush(): Promise<void> {
    this.ready = true;
    const queued = this.pending;
    this.pending = [];
    for (const candidate of queued) await this.apply(candidate);
  }

  private async apply(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // a stale or duplicate candidate must not break the connection
    }
  }
}
