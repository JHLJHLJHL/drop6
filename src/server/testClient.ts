import WebSocket, { type ClientOptions, type RawData } from 'ws';

/** Small ws client used by server tests: queues messages and lets tests await them. */
export class TestClient {
  readonly inbox: Record<string, unknown>[] = [];
  readonly closed: Promise<{ code: number }>;
  private readonly waiters = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: RawData) => {
      this.inbox.push(JSON.parse(data.toString()) as Record<string, unknown>);
      for (const wake of [...this.waiters]) wake();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code: number) => {
        resolve({ code });
        for (const wake of [...this.waiters]) wake();
      });
    });
  }

  static connect(url: string, options?: ClientOptions): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      const client = new TestClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  sendBinary(data: Buffer): void {
    this.ws.send(data, { binary: true });
  }

  /** Resolves with the next unread message (of `type` if given). */
  async next<T = Record<string, unknown>>(type?: string, timeoutMs = 2_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex((m) => type === undefined || m.type === type);
      if (index >= 0) return this.inbox.splice(index, 1)[0] as T;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type ?? 'message'}`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.waiters.add(wake);
      });
    }
  }

  /** Asserts nothing arrives for a short moment. */
  async expectSilence(ms = 100): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.inbox.length > 0) throw new Error(`unexpected message: ${JSON.stringify(this.inbox[0])}`);
  }

  close(): void {
    this.ws.close();
  }
}
