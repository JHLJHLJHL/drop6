import { expect, test, type Page } from '@playwright/test';
import {
  MINUTE,
  advanceServerClock,
  chooseSaveLocation,
  joinAndReview,
  makeTestFile,
  newReceiverContext,
  PICKED_FOLDER,
  readCode,
  resetServer,
  startSending,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

interface TrackedWindow {
  __sockets: WebSocket[];
  __peers: RTCPeerConnection[];
  __blockSockets: boolean;
}

/** Lets a test cut the page's server connection and peer connections, like a phone falling asleep. */
async function trackConnections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracked = window as unknown as TrackedWindow;
    tracked.__sockets = [];
    tracked.__peers = [];
    tracked.__blockSockets = false;
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (tracked.__blockSockets) throw new Error('offline');
        super(url, protocols);
        tracked.__sockets.push(this);
      }
    };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        tracked.__peers.push(this);
      }
    };
  });
}

/** Cuts everything the page has open. With `stayOffline`, it cannot open a new server connection afterwards. */
async function fallAsleep(page: Page, stayOffline = false): Promise<void> {
  await page.evaluate((offline) => {
    const tracked = window as unknown as TrackedWindow;
    tracked.__blockSockets = offline;
    for (const socket of tracked.__sockets) socket.close();
    for (const peer of tracked.__peers) peer.close();
  }, stayOffline);
}

/** Remembers every control message the page sends over a data channel (accept, ack, ...). */
async function logControlMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sent: Array<Record<string, unknown>> = [];
    (window as unknown as { __controlSent: typeof sent }).__controlSent = sent;
    const nativeSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: never) {
      if (typeof data === 'string') sent.push(JSON.parse(data) as Record<string, unknown>);
      return nativeSend.call(this, data);
    } as typeof RTCDataChannel.prototype.send;
  });
}

const progressOf = async (page: Page) => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'));

test('a transfer whose sender dropped off is picked up where it stopped, with the exact bytes', async ({ browser, page }) => {
  test.setTimeout(120_000);
  const file = makeTestFile(24 * 1024 * 1024, 'big.bin');
  await trackConnections(page);
  const code = await startSending(page, file);

  // the receiver writes slowly, so the transfer is still running when the sender drops off
  const context = await newReceiverContext(browser, 'opfs', 15);
  const receiverPage = await context.newPage();
  await logControlMessages(receiverPage);
  await joinAndReview(receiverPage, code);
  await chooseSaveLocation(receiverPage);
  await receiverPage.getByRole('button', { name: '파일 받기' }).click();
  await expect.poll(() => progressOf(receiverPage), { timeout: 60_000 }).toBeGreaterThanOrEqual(30);

  await fallAsleep(page);

  await expect(receiverPage.getByRole('heading', { name: '다 받았어요' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('받기를 마쳤어요')).toBeVisible();

  // it asked the sender to continue after what it had, instead of starting over
  const accepts = await receiverPage.evaluate(() =>
    (window as unknown as { __controlSent: Array<Record<string, unknown>> }).__controlSent.filter((m) => m.t === 'accept'),
  );
  expect(accepts).toHaveLength(2);
  expect(accepts[0]).not.toHaveProperty('from');
  expect(accepts[1]!.from).toBeGreaterThan(file.buffer.length * 0.2);

  const savedHash = await receiverPage.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('big.bin');
    const bytes = await (await handle.getFile()).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  });
  expect(savedHash).toBe(file.hash);
  await context.close();
});

test('files received one by one into a folder continue across a drop too, each with exactly its own bytes', async ({ browser, page }) => {
  test.setTimeout(120_000);
  const files = [makeTestFile(4 * 1024 * 1024, 'one.bin'), makeTestFile(4 * 1024 * 1024, 'two.bin'), makeTestFile(4 * 1024 * 1024, 'three.bin')];
  await trackConnections(page);
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .setInputFiles(files.map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: file.buffer })));
  const code = await readCode(page);

  const context = await newReceiverContext(browser, 'opfs', 30);
  const receiverPage = await context.newPage();
  await joinAndReview(receiverPage, code);
  await chooseSaveLocation(receiverPage);
  await receiverPage.getByRole('button', { name: '파일 따로 받기' }).click();
  await expect.poll(() => progressOf(receiverPage), { timeout: 60_000 }).toBeGreaterThanOrEqual(40); // inside the second file

  await fallAsleep(page);

  await expect(receiverPage.getByRole('heading', { name: '다 받았어요' })).toBeVisible({ timeout: 90_000 });
  // hashed inside the page: shipping the bytes through the test runner would be slow and heavy
  const saved = await receiverPage.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(folder);
    const hashes: Record<string, string> = {};
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
      const digest = await crypto.subtle.digest('SHA-256', await (await handle.getFile()).arrayBuffer());
      hashes[name] = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return hashes;
  }, PICKED_FOLDER);
  expect(Object.keys(saved).sort()).toEqual(files.map((file) => file.name).sort());
  for (const file of files) expect(saved[file.name]).toBe(file.hash);
  await context.close();
});

test('a sender that lost its server connection gets the same code back and can still be joined', async ({ page, browser }) => {
  await trackConnections(page);
  const code = await startSending(page, makeTestFile(64 * 1024));
  await fallAsleep(page);

  // it reconnects on its own and the code keeps working
  await page.waitForFunction(() => (window as unknown as TrackedWindow).__sockets.length >= 2);
  await expect(page.getByText('연결이 끊겨서 다시 연결하는 중이에요')).toHaveCount(0);
  await expect(page.getByTestId('transfer-code')).toHaveText(`${code.slice(0, 3)} ${code.slice(3)}`);

  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await expect(page.getByText('1 / 3명')).toBeVisible();
  await context.close();
});

test('a receiver waiting for a sender that never comes back is told once the grace period is over', async ({ browser, page }) => {
  test.setTimeout(90_000);
  await trackConnections(page);
  const code = await startSending(page, makeTestFile(24 * 1024 * 1024, 'big.bin'));

  const context = await newReceiverContext(browser, 'opfs', 15);
  const receiverPage = await context.newPage();
  await joinAndReview(receiverPage, code);
  await chooseSaveLocation(receiverPage);
  await receiverPage.getByRole('button', { name: '파일 받기' }).click();
  await expect.poll(() => progressOf(receiverPage), { timeout: 60_000 }).toBeGreaterThanOrEqual(10);

  await fallAsleep(page, true);
  await expect(receiverPage.getByRole('heading', { name: '연결이 끊겼어요' })).toBeVisible();
  await expect(receiverPage.getByText('보내는 사람이 돌아오면 이어서 받아요')).toBeVisible();
  await expect(page.getByText('연결이 끊겨서 다시 연결하는 중이에요').first()).toBeVisible();

  await advanceServerClock(receiverPage.request, 4 * MINUTE);
  await expect(receiverPage.getByRole('heading', { name: '보내는 사람이 창을 닫았어요' })).toBeVisible();
  await context.close();
});
