import type { IceServerConfig } from '../shared/ice';

export interface TurnProviderOptions {
  /** ICE_SERVERS_JSON, or the default STUN server. Always served. */
  base: IceServerConfig[];
  /** Cloudflare TURN credentials (cached by the provider itself). */
  cloudflare?: (() => Promise<IceServerConfig[]>) | undefined;
  /** "May TURN be handed out right now?" (usage limit). Asked before every credential request. */
  budget?: (() => Promise<boolean>) | undefined;
}

/**
 * Builds the answer of GET /api/config: the configured servers, plus Cloudflare TURN while the
 * usage limit allows it. Over the limit, no TURN credentials are generated at all, so the service
 * keeps working on STUN alone.
 */
export function createTurnProvider(options: TurnProviderOptions): () => Promise<IceServerConfig[]> {
  const { base, cloudflare, budget } = options;
  return async () => {
    if (!cloudflare) return base;
    let allowed = true;
    try {
      if (budget) allowed = await budget();
    } catch {
      allowed = false;
    }
    return allowed ? [...base, ...(await cloudflare())] : base;
  };
}
