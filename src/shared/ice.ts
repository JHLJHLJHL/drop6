import { z } from 'zod';

const iceUrl = z
  .string()
  .max(512)
  .regex(/^(stun|stuns|turn|turns):\S+$/i);

function isTurn(urls: string[]): boolean {
  return urls.some((url) => /^turns?:/i.test(url));
}

const iceServerSchema = z
  .object({
    urls: z.union([iceUrl, z.array(iceUrl).min(1).max(8)]),
    username: z.string().min(1).max(512).optional(),
    credential: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .transform((server) => ({ ...server, urls: Array.isArray(server.urls) ? server.urls : [server.urls] }))
  .refine((server) => !isTurn(server.urls) || Boolean(server.username && server.credential), {
    message: 'TURN servers need both username and credential',
  });

export const iceServersSchema = z.array(iceServerSchema).max(10);

export interface IceServerConfig {
  urls: string[];
  username?: string | undefined;
  credential?: string | undefined;
}

/** Default when ICE_SERVERS_JSON is unset: one public STUN server, no relay. */
export const DEFAULT_ICE_SERVERS: IceServerConfig[] = [{ urls: ['stun:stun.l.google.com:19302'] }];

export function hasTurnServer(servers: readonly IceServerConfig[]): boolean {
  return servers.some((server) => isTurn(server.urls));
}

/** Parses and validates ICE_SERVERS_JSON. Throws without echoing the value (it may hold credentials). */
export function parseIceServers(json: string): IceServerConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('ICE_SERVERS_JSON is not valid JSON');
  }
  const result = iceServersSchema.safeParse(raw);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new Error(`ICE_SERVERS_JSON has invalid entries at: ${paths}`);
  }
  return result.data;
}
