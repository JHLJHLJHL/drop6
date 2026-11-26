import { describe, expect, it } from 'vitest';
import type { ReceiverPhase } from '../lib/receiverSession';
import { keepsReceiverAwake } from './ReceiverScreen';

describe('keepsReceiverAwake', () => {
  it('keeps the screen on while the connection to the sender matters', () => {
    const live: ReceiverPhase[] = ['joining', 'connecting', 'review', 'receiving', 'paused'];
    for (const phase of live) expect(keepsReceiverAwake(phase), phase).toBe(true);
  });

  it('lets the screen sleep once there is nothing left to receive', () => {
    const over: ReceiverPhase[] = ['blocked', 'done', 'canceled', 'failed', 'error'];
    for (const phase of over) expect(keepsReceiverAwake(phase), phase).toBe(false);
  });
});
