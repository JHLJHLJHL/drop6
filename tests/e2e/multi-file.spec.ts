import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import {
  acceptAndDownload,
  joinAndReview,
  makeTestFile,
  newReceiverContext,
  resetServer,
  sha256,
  type TestFile,
} from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

const ZIP_NAME = 'DROP6 파일 3개.zip';

function threeFiles(): TestFile[] {
  return [
    makeTestFile(700 * 1024 + 5, '붙임.2026학년도 보고서(울릉중).hwp'),
    makeTestFile(1234, 'notes.txt'),
    { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0), hash: sha256(Buffer.alloc(0)) },
  ];
}

const toInput = (files: TestFile[]) => files.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }));

test('several files arrive as one zip that holds every file unchanged', async ({ browser, page }) => {
  const files = threeFiles();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput(files));
  await expect(page.getByText(ZIP_NAME)).toBeVisible();
  await expect(page.getByText(/파일 3개 · /)).toBeVisible();
  const code = ((await page.getByTestId('transfer-code').textContent()) ?? '').replace(/\s/g, '');

  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await expect(receiver.getByText(ZIP_NAME)).toBeVisible();
  await expect(receiver.getByText(/application\/zip/)).toBeVisible();

  const download = await acceptAndDownload(receiver);
  expect(download.suggestedFilename()).toBe(ZIP_NAME);

  const entries = unzipSync(new Uint8Array(readFileSync(await download.path())));
  expect(Object.keys(entries).sort()).toEqual(files.map((f) => f.name).sort());
  for (const file of files) expect(sha256(entries[file.name]!)).toBe(file.hash);
  await expect(receiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await context.close();
});

test('the zip also streams to disk through the File System Access API', async ({ browser, page }) => {
  const files = threeFiles();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput(files));
  const code = ((await page.getByTestId('transfer-code').textContent()) ?? '').replace(/\s/g, '');

  const context = await newReceiverContext(browser, 'opfs');
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await receiver.getByRole('button', { name: '파일 받기' }).click();
  await expect(receiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();

  const saved = await receiver.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  }, ZIP_NAME);
  const entries = unzipSync(new Uint8Array(saved));
  for (const file of files) expect(sha256(entries[file.name]!)).toBe(file.hash);
  await context.close();
});

test('three receivers each get the same zip', async ({ browser, page }) => {
  const files = threeFiles();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput(files));
  const code = ((await page.getByTestId('transfer-code').textContent()) ?? '').replace(/\s/g, '');

  const contexts = await Promise.all([1, 2, 3].map(() => newReceiverContext(browser)));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const receiver of pages) await joinAndReview(receiver, code);
  const downloads = await Promise.all(pages.map((receiver) => acceptAndDownload(receiver)));
  const zips = await Promise.all(downloads.map(async (d) => readFileSync(await d.path())));
  expect(new Set(zips.map((zip) => sha256(zip))).size).toBe(1);
  for (const file of files) expect(sha256(unzipSync(new Uint8Array(zips[0]!))[file.name]!)).toBe(file.hash);
  await Promise.all(contexts.map((context) => context.close()));
});

test('a single file is still sent as it is, not zipped', async ({ browser, page }) => {
  const file = makeTestFile(100 * 1024, 'plain.bin');
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput([file]));
  const code = ((await page.getByTestId('transfer-code').textContent()) ?? '').replace(/\s/g, '');
  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  const download = await acceptAndDownload(receiver);
  expect(download.suggestedFilename()).toBe('plain.bin');
  expect(sha256(readFileSync(await download.path()))).toBe(file.hash);
  await context.close();
});

test('more than 1000 files are refused with a clear message', async ({ page }) => {
  await page.goto('/');
  const many = Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from('x') }));
  await page.locator('input[type=file]').setInputFiles(many);
  await expect(page.getByRole('heading', { name: '파일이 너무 많아요' })).toBeVisible();
  await expect(page.getByText(/1000개까지/)).toBeVisible();
  await page.getByRole('button', { name: '파일 다시 고르기' }).click();
  await expect(page.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeVisible();
});

test('clicking the drop field opens the file explorer and allows several files', async ({ page }) => {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('dropzone').click();
  const fileChooser = await chooser;
  expect(fileChooser.isMultiple()).toBe(true);
});
