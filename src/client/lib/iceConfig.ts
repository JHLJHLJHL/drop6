import { iceServersSchema, type IceServerConfig } from '../../shared/ice';
import { z } from 'zod';

const configSchema = z.object({ iceServers: iceServersSchema });

/** Fetches the ICE (STUN/TURN) servers the WebRTC connection must use. */
export async function fetchIceServers(): Promise<IceServerConfig[]> {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('config-unavailable');
  return configSchema.parse(await response.json()).iceServers;
}
