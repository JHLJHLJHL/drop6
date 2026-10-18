import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JOIN_RATE_LIMIT } from '../shared/protocol';
import type { IceServerConfig } from '../shared/ice';
import { createHttpHandler } from './http';
import { consoleLogger, type Logger } from './logger';
import { SlidingWindowLimiter } from './rateLimiter';
import { RoomManager, type Clock } from './rooms';
import { attachSignaling } from './signaling';

export interface AppServerOptions {
  port: number;
  host: string;
  iceServers: IceServerConfig[];
  /** Overrides `iceServers`: asked on every /api/config request (e.g. Cloudflare TURN credentials). */
  getIceServers?: () => Promise<IceServerConfig[]>;
  staticDir: string;
  /** Exposes POST /__test__/* (clock control). Only index.ts sets this, and only for NODE_ENV=test. */
  testMode?: boolean;
  trustProxyHops?: number;
  heartbeatIntervalMs?: number;
  joinRateLimit?: { max: number; windowMs: number };
  generateCode?: () => string;
  /** How long a room waits for a sender whose connection dropped. Defaults to SENDER_GRACE_MS. */
  senderGraceMs?: number;
  logger?: Logger;
}

export interface AppServer {
  /** Starts listening and resolves with the bound port. */
  start(): Promise<number>;
  /** Notifies peers, closes WebSocket and HTTP servers. */
  close(): Promise<void>;
}

/** Wall clock plus a test-controlled offset. The offset stays 0 outside test mode. */
class OffsetClock implements Clock {
  private offset = 0;
  now(): number {
    return Date.now() + this.offset;
  }
  advance(ms: number): void {
    this.offset += ms;
  }
  reset(): void {
    this.offset = 0;
  }
}

const FORCE_CLOSE_AFTER_MS = 2_000;

export function createAppServer(options: AppServerOptions): AppServer {
  const logger = options.logger ?? consoleLogger;
  const clock = new OffsetClock();
  const manager = new RoomManager({ clock, generateCode: options.generateCode, senderGraceMs: options.senderGraceMs });
  const joinLimiter = new SlidingWindowLimiter({ ...(options.joinRateLimit ?? JOIN_RATE_LIMIT), clock });

  const testControls = options.testMode
    ? {
        advanceClock: (ms: number) => {
          clock.advance(ms);
          manager.sweep(); // the heartbeat would only notice at its next tick
        },
        reset: () => {
          clock.reset();
          joinLimiter.reset();
        },
      }
    : undefined;

  const httpServer = createServer(
    createHttpHandler({
      getIceServers: options.getIceServers ?? (async () => options.iceServers),
      staticDir: options.staticDir,
      testControls,
      logger,
    }),
  );
  const signaling = attachSignaling(httpServer, {
    manager,
    joinLimiter,
    logger,
    trustProxyHops: options.trustProxyHops ?? 0,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host, () => {
          httpServer.off('error', reject);
          resolve((httpServer.address() as AddressInfo).port);
        });
      });
    },
    async close() {
      const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      const force = setTimeout(() => httpServer.closeAllConnections(), FORCE_CLOSE_AFTER_MS);
      httpServer.closeIdleConnections();
      await signaling.close();
      await closed;
      clearTimeout(force);
    },
  };
}
