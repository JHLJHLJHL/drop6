import { closeSync, mkdtempSync, openSync, ftruncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  MINUTE,
  acceptAndDownload,
  advanceServerClock,
  downloadedHash,
  enterCode,
  joinAndReview,
  makeTestFile,
  newReceiverContext,
  resetServer,
  startSending,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

test('serves the app and health check from the same service', async ({ request, page }) => {
  const health = await request.get('/health');
  expect(await health.json()).toEqual({ status: 'ok' });
  const config = await request.get('/api/config');
  expect(await config.json()).toEqual({ iceServers: [] });
  await page.goto('/receive');
  await page.reload(); // SPA refresh on a client-side route
  await expect(page.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeVisible();
});

test('one sender delivers the same file to three receivers (SHA-256 verified)', async ({ browser, page }) => {
  const file = makeTestFile(2 * 1024 * 1024 + 123);
  const code = await startSending(page, file);
  await expect(page.getByText('0 / 3명')).toBeVisible();

  const contexts = await Promise.all([1, 2, 3].map(() => newReceiverContext(browser)));
  const receivers = await Promise.all(contexts.map((context) => context.newPage()));
  for (const receiver of receivers) await joinAndReview(receiver, code);
  await expect(page.getByText('3 / 3명')).toBeVisible();

  // The review screen shows file name, size and type before anything is sent.
  await expect(receivers[0]!.getByText(file.name)).toBeVisible();
  await expect(receivers[0]!.getByText(/2 MB · application\/octet-stream/)).toBeVisible();

  const downloads = await Promise.all(receivers.map((receiver) => acceptAndDownload(receiver)));
  const hashes = await Promise.all(downloads.map(downloadedHash));
  expect(hashes).toEqual([file.hash, file.hash, file.hash]);

  for (const receiver of receivers) {
    await expect(receiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
    await expect(receiver.getByText(/다운로드 폴더/)).toBeVisible();
  }
  await expect(page.getByText('받기를 마쳤어요')).toHaveCount(3);
  const bars = page.getByRole('progressbar');
  await expect(bars).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) await expect(bars.nth(i)).toHaveAttribute('aria-valuenow', '100');
  await Promise.all(contexts.map((context) => context.close()));
});

test('streams to disk through the File System Access API', async ({ browser, page }) => {
  const file = makeTestFile(1024 * 1024 + 7, 'photo.bin');
  const code = await startSending(page, file);

  const context = await newReceiverContext(browser, 'opfs');
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await expect(receiver.getByText('파일 받기를 누르면 브라우저 기본 다운로드 폴더로')).toBeVisible();
  await receiver.getByRole('button', { name: '파일 받기' }).click();
  await expect(receiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await expect(receiver.getByText('선택한 위치에 저장했어요.')).toBeVisible();

  const savedHash = await receiver.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('photo.bin');
    const bytes = await (await handle.getFile()).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  });
  expect(savedHash).toBe(file.hash);
  await context.close();
});

test('a fourth receiver is told the room is full', async ({ browser, page }) => {
  const code = await startSending(page, makeTestFile(64 * 1024));
  const contexts = await Promise.all([1, 2, 3, 4].map(() => newReceiverContext(browser)));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const receiver of pages.slice(0, 3)) await joinAndReview(receiver, code);

  await enterCode(pages[3]!, code);
  await expect(pages[3]!.getByRole('heading', { name: '받는 사람이 가득 찼어요' })).toBeVisible();
  await expect(pages[3]!.getByText(/3명까지/)).toBeVisible();
  await expect(page.getByText('3 / 3명')).toBeVisible();
  await Promise.all(contexts.map((context) => context.close()));
});

test('a receiver who joined in time can finish after the code expired; new receivers are refused', async ({ browser, page, request }) => {
  const file = makeTestFile(512 * 1024);
  const code = await startSending(page, file);

  const early = await newReceiverContext(browser);
  const earlyPage = await early.newPage();
  await joinAndReview(earlyPage, code);

  await advanceServerClock(request, 30 * MINUTE);

  const late = await newReceiverContext(browser);
  const latePage = await late.newPage();
  await enterCode(latePage, code);
  await expect(latePage.getByRole('heading', { name: '코드가 만료됐어요' })).toBeVisible();
  await expect(latePage.getByText(/30분 동안만/)).toBeVisible();

  const download = await acceptAndDownload(earlyPage);
  expect(await downloadedHash(download)).toBe(file.hash);
  await expect(earlyPage.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await Promise.all([early.close(), late.close()]);
});

test('one receiver leaving mid-transfer does not interrupt the others', async ({ browser, page }) => {
  const file = makeTestFile(3 * 1024 * 1024);
  const code = await startSending(page, file);

  // B writes slowly so it is still busy when its tab closes; A and C are fast.
  const [a, b, c] = await Promise.all([
    newReceiverContext(browser),
    newReceiverContext(browser, 'opfs', 120),
    newReceiverContext(browser),
  ]);
  const [pageA, pageB, pageC] = await Promise.all([a, b, c].map((context) => context.newPage()));
  for (const receiver of [pageA!, pageB!, pageC!]) await joinAndReview(receiver, code);

  await pageB!.getByRole('button', { name: '파일 받기' }).click();
  await expect(pageB!.getByRole('heading', { name: '파일을 받는 중이에요' })).toBeVisible();
  await expect
    .poll(async () => Number(await pageB!.getByRole('progressbar').getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);

  const downloads = Promise.all([acceptAndDownload(pageA!), acceptAndDownload(pageC!)]);
  await b.close(); // receiver B drops mid-transfer

  const hashes = await Promise.all((await downloads).map(downloadedHash));
  expect(hashes).toEqual([file.hash, file.hash]);
  await expect(page.getByText('나갔어요')).toHaveCount(1);
  await expect(page.getByText('받기를 마쳤어요')).toHaveCount(2);
  await Promise.all([a.close(), c.close()]);
});

test('a receiver cancelling is shown to the sender and nobody else is affected', async ({ browser, page }) => {
  const file = makeTestFile(2 * 1024 * 1024);
  const code = await startSending(page, file);
  const [a, b] = await Promise.all([newReceiverContext(browser, 'opfs', 120), newReceiverContext(browser)]);
  const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()]);
  await joinAndReview(pageA, code);
  await joinAndReview(pageB, code);

  await pageA.getByRole('button', { name: '파일 받기' }).click();
  await expect(pageA.getByRole('button', { name: '받기 취소' })).toBeVisible();
  await pageA.getByRole('button', { name: '받기 취소' }).click();
  await expect(pageA.getByRole('heading', { name: '받기를 취소했어요' })).toBeVisible();
  await expect(page.getByText('받기를 취소했어요')).toBeVisible();

  const hash = await downloadedHash(await acceptAndDownload(pageB));
  expect(hash).toBe(file.hash);
  await Promise.all([a.close(), b.close()]);
});

test('receivers are told when the sender closes the tab', async ({ browser, page }) => {
  const code = await startSending(page, makeTestFile(64 * 1024));
  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await page.close();
  await expect(receiver.getByRole('heading', { name: '보내는 사람이 창을 닫았어요' })).toBeVisible();
  await context.close();
});

test('a wrong code is explained', async ({ browser }) => {
  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await enterCode(receiver, '000000');
  await expect(receiver.getByRole('heading', { name: '없는 코드예요' })).toBeVisible();
  await receiver.getByRole('button', { name: '코드 다시 입력하기' }).click();
  await expect(receiver.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeVisible();
  await context.close();
});

test('the Blob fallback refuses files over 500MB before anything is sent', async ({ browser, page }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drop6-big-'));
  const bigFile = path.join(dir, 'huge.bin');
  const fd = openSync(bigFile, 'w');
  ftruncateSync(fd, 500 * 1024 * 1024 + 1); // sparse: the browser only reads what is sent
  closeSync(fd);

  try {
    const code = await startSending(page, bigFile);
    const context = await newReceiverContext(browser);
    const receiver = await context.newPage();
    await enterCode(receiver, code);
    await expect(receiver.getByRole('heading', { name: '이 파일은 받을 수 없어요' })).toBeVisible();
    await expect(receiver.getByText(/500MB까지만 받을 수 있어요/)).toBeVisible();
    await expect(receiver.getByRole('button', { name: '파일 받기' })).toHaveCount(0);
    await expect(page.getByText(/500MB까지만 받을 수 있어서 받지 못했어요/)).toBeVisible();
    await context.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the receive review explains the in-memory download limit up front', async ({ browser, page }) => {
  const code = await startSending(page, makeTestFile(32 * 1024));
  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await expect(receiver.getByText(/메모리에 담았다가 다운로드해요. 최대 500MB까지/)).toBeVisible();
  await context.close();
});
