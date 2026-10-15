import { createCloudflareTurn } from './cloudflareTurn';
import { loadConfig } from './config';
import { consoleLogger } from './logger';
import { createAppServer } from './server';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // ICE_SERVERS_JSON (or the default STUN) plus, when configured, short-lived Cloudflare TURN credentials.
  const cloudflare = config.cloudflareTurn ? createCloudflareTurn({ ...config.cloudflareTurn, logger: consoleLogger }) : undefined;
  const server = createAppServer({
    port: config.port,
    host: config.host,
    iceServers: config.iceServers,
    ...(cloudflare ? { getIceServers: async () => [...config.iceServers, ...(await cloudflare())] } : {}),
    staticDir: config.staticDir,
    testMode: config.testMode,
    trustProxyHops: config.trustProxyHops,
  });

  const port = await server.start();
  consoleLogger.info('server_started', { port, env: config.nodeEnv, cloudflareTurn: Boolean(cloudflare) });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    consoleLogger.info('shutdown_started', { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Config errors never include secret values (see parseIceServers).
  consoleLogger.error('startup_failed', { reason: error instanceof Error ? error.message : 'unknown' });
  process.exit(1);
});
