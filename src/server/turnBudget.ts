import { z } from 'zod';
import type { Logger } from './logger';

const CHECK_INTERVAL_MS = 5 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** Cloudflare's billing period is at most a month; 31 days never under-counts it. */
const WINDOW_DAYS = 31;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface TurnBudgetOptions {
  accountId: string;
  keyId: string;
  /** API token with "Account Analytics: Read". Not the TURN key's own token. */
  apiToken: string;
  limitGb: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const responseSchema = z.object({
  data: z.object({
    viewer: z.object({
      accounts: z
        .array(
          z.object({
            callsTurnUsageAdaptiveGroups: z.array(z.object({ sum: z.object({ egressBytes: z.number().nonnegative() }) })),
          }),
        )
        .min(1),
    }),
  }),
  errors: z.null().optional(),
});

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface TurnUsageQuery {
  accountId: string;
  keyId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Bytes the TURN key sent to clients over the last 31 days (the billed direction). Throws on any failure. */
export async function fetchTurnUsageBytes(options: TurnUsageQuery): Promise<number> {
  const { accountId, keyId, apiToken } = options;
  if (!ID_PATTERN.test(accountId) || !ID_PATTERN.test(keyId)) throw new Error('invalid Cloudflare account or key id');
  const fetchImpl = options.fetchImpl ?? fetch;
  const today = (options.now ?? Date.now)();
  const query = `query {
  viewer {
    accounts(filter: { accountTag: "${accountId}" }) {
      callsTurnUsageAdaptiveGroups(
        limit: 10000
        filter: { keyId: "${keyId}", date_geq: "${isoDate(today - (WINDOW_DAYS - 1) * 86_400_000)}", date_leq: "${isoDate(today)}" }
      ) {
        sum { egressBytes }
      }
    }
  }
}`;
  const response = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const parsed = responseSchema.parse(await response.json());
  return parsed.data.viewer.accounts[0]!.callsTurnUsageAdaptiveGroups.reduce((sum, group) => sum + group.sum.egressBytes, 0);
}

/**
 * Cost guard for Cloudflare TURN. Returns a function answering "may TURN credentials be handed out now?".
 * It reads how much data the TURN key sent over the last 31 days (the billed direction) and says no once
 * that reaches the limit. If the usage cannot be read it also says no (fails closed) and tries again soon.
 * Nothing secret (token, account id, key id, response bodies) is logged.
 */
export function createTurnBudget(options: TurnBudgetOptions): () => Promise<boolean> {
  const { accountId, keyId, apiToken, limitGb, logger } = options;
  if (!ID_PATTERN.test(accountId) || !ID_PATTERN.test(keyId)) throw new Error('invalid Cloudflare account or key id');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const limitBytes = limitGb * 1e9;

  let state: { allowed: boolean; validUntil: number } | undefined;
  let inFlight: Promise<boolean> | undefined;
  let reached = false;

  async function check(): Promise<boolean> {
    try {
      const used = await fetchTurnUsageBytes({ accountId, keyId, apiToken, fetchImpl, now });
      const allowed = used < limitBytes;
      if (!allowed && !reached) logger.info('turn_limit_reached', { usedGb: Math.round(used / 1e9), limitGb });
      if (allowed && reached) logger.info('turn_limit_cleared', { usedGb: Math.round(used / 1e9), limitGb });
      reached = !allowed;
      state = { allowed, validUntil: now() + CHECK_INTERVAL_MS };
      return allowed;
    } catch {
      logger.error('turn_usage_check_failed');
      state = { allowed: false, validUntil: now() + RETRY_AFTER_FAILURE_MS };
      return false;
    }
  }

  return async () => {
    if (state && now() < state.validUntil) return state.allowed;
    inFlight ??= check().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
