import {
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/protocol';

export interface SignalingClient {
  send(message: ClientMessage): void;
  close(): void;
}

export interface SignalingHandlers {
  onMessage(message: ServerMessage): void;
  /** The socket closed (server restart, network loss, or our own close()). */
  onClose(): void;
}

export function signalingUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

/** Opens the same-origin /ws socket; resolves once it is open. Invalid server messages are dropped. */
export function connectSignaling(handlers: SignalingHandlers, url = signalingUrl()): Promise<SignalingClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      resolve({
        send: (message) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        },
        close: () => socket.close(1000, 'client-closed'),
      });
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = serverMessageSchema.safeParse(json);
      if (parsed.success) handlers.onMessage(parsed.data);
    });
    socket.addEventListener('error', () => {
      if (!opened) reject(new Error('signaling-unavailable'));
    });
    socket.addEventListener('close', () => {
      if (opened) handlers.onClose();
      else reject(new Error('signaling-unavailable'));
    });
  });
}
