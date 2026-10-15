// Prints the Cloudflare TURN usage the server's limit looks at, so the four settings can be tried out
// before they go into the server's environment:
//   CLOUDFLARE_TURN_KEY_ID=... CLOUDFLARE_TURN_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   CLOUDFLARE_ANALYTICS_API_TOKEN=... npm run check:turn-usage
import { loadConfig } from '../src/server/config';
import { fetchTurnUsageBytes } from '../src/server/turnBudget';

const turn = loadConfig(process.env).cloudflareTurn;
if (!turn?.usageLimit) {
  console.error(
    'Set CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_API_TOKEN.',
  );
  process.exit(1);
}

try {
  const used = await fetchTurnUsageBytes({
    accountId: turn.usageLimit.accountId,
    keyId: turn.keyId,
    apiToken: turn.usageLimit.analyticsToken,
  });
  const { limitGb } = turn.usageLimit;
  const usedGb = used / 1e9;
  console.log(`TURN data sent over the last 31 days: ${usedGb.toFixed(3)} GB`);
  console.log(`Limit: ${limitGb} GB -> TURN credentials are ${usedGb < limitGb ? 'handed out' : 'STOPPED'}`);
} catch (error) {
  // Only the failure kind is printed, never the request or any secret.
  console.error(`Could not read the usage: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
