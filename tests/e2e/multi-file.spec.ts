import { readFileSync } from 'node:fs';
import { expect, test, type Download } from '@playwright/test';
import { unzipSync } from 'fflate';
import {
  acceptAndDownload,
  chooseSaveLocation,
  joinAndReview,
  makeTestFile,
  newReceiverContext,
  PICKED_FOLDER,
  readCode,
  readPickedFolder,
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
  const code = await readCode(page);

  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  const list = receiver.getByRole('list', { name: '파일 목록' });
  for (const file of files) await expect(list.getByText(file.name, { exact: true })).toBeVisible();
  await expect(receiver.getByText('파일 3개', { exact: true })).toBeVisible();

  const download = await acceptAndDownload(receiver, 'zip 하나로 받기');
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
  const code = await readCode(page);

  const context = await newReceiverContext(browser, 'opfs');
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await chooseSaveLocation(receiver);
  await receiver.getByRole('button', { name: 'zip 하나로 받기' }).click();
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
  const code = await readCode(page);

  const contexts = await Promise.all([1, 2, 3].map(() => newReceiverContext(browser)));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const receiver of pages) await joinAndReview(receiver, code);
  const downloads = await Promise.all(pages.map((receiver) => acceptAndDownload(receiver, 'zip 하나로 받기')));
  const zips = await Promise.all(downloads.map(async (d) => readFileSync(await d.path())));
  expect(new Set(zips.map((zip) => sha256(zip))).size).toBe(1);
  for (const file of files) expect(sha256(unzipSync(new Uint8Array(zips[0]!))[file.name]!)).toBe(file.hash);
  await Promise.all(contexts.map((context) => context.close()));
});

test('files can also be downloaded one by one instead of the zip', async ({ browser, page }) => {
  const files = threeFiles();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput(files));
  const code = await readCode(page);

  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);

  const downloads: Download[] = [];
  receiver.on('download', (download) => downloads.push(download));
  await receiver.getByRole('button', { name: '파일 따로 받기' }).click();
  await expect(receiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await expect.poll(() => downloads.length).toBe(files.length);

  expect(downloads.map((d) => d.suggestedFilename())).toEqual(files.map((f) => f.name));
  for (const [i, file] of files.entries()) expect(sha256(readFileSync(await downloads[i]!.path()))).toBe(file.hash);
  await context.close();
});

test('files stream into a chosen folder, each with exactly its own bytes', async ({ browser, page }) => {
  const files = threeFiles();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput(files));
  const code = await readCode(page);

  const context = await newReceiverContext(browser, 'opfs');
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);
  await chooseSaveLocation(receiver);
  await receiver.getByRole('button', { name: '파일 따로 받기' }).click();
  await expect(receiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await expect(receiver.getByText(`'${PICKED_FOLDER}' 폴더에 저장했어요`)).toBeVisible();

  const saved = await readPickedFolder(receiver);
  expect(Object.keys(saved).sort()).toEqual(files.map((f) => f.name).sort());
  for (const file of files) expect(sha256(saved[file.name]!)).toBe(file.hash);
  await context.close();
});

test('the sender sees both finish when one receiver takes the zip and another the files', async ({ browser, page }) => {
  const files = threeFiles();
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput(files));
  const code = await readCode(page);

  const [zipContext, filesContext] = await Promise.all([newReceiverContext(browser), newReceiverContext(browser, 'opfs')]);
  const [zipReceiver, filesReceiver] = await Promise.all([zipContext.newPage(), filesContext.newPage()]);
  await joinAndReview(zipReceiver, code);
  await joinAndReview(filesReceiver, code);
  await chooseSaveLocation(filesReceiver);

  const [zipDownload] = await Promise.all([
    zipReceiver.waitForEvent('download'),
    zipReceiver.getByRole('button', { name: 'zip 하나로 받기' }).click(),
    filesReceiver.getByRole('button', { name: '파일 따로 받기' }).click(),
  ]);
  await expect(zipReceiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await expect(filesReceiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await expect(page.getByText('받기를 마쳤어요')).toHaveCount(2);

  const entries = unzipSync(new Uint8Array(readFileSync(await zipDownload.path())));
  for (const file of files) expect(sha256(entries[file.name]!)).toBe(file.hash);
  const saved = await readPickedFolder(filesReceiver);
  for (const file of files) expect(sha256(saved[file.name]!)).toBe(file.hash);
  await Promise.all([zipContext.close(), filesContext.close()]);
});

test('a single file is still sent as it is, not zipped', async ({ browser, page }) => {
  const file = makeTestFile(100 * 1024, 'plain.bin');
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(toInput([file]));
  const code = await readCode(page);
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

test.describe('a dropped folder is refused without moving anything', () => {
  for (const width of [1280, 360]) {
    test(`the card keeps its height and position (${width}px)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      const card = page.locator('.card');
      const before = (await card.boundingBox())!;
      const footerBefore = (await page.getByRole('contentinfo').boundingBox())!;

      await page.getByTestId('dropzone').evaluate((zone) => {
        const transfer = new DataTransfer();
        const folder = { webkitGetAsEntry: () => ({ isDirectory: true }) };
        Object.defineProperty(transfer, 'items', { value: [folder] });
        zone.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      });

      await expect(page.getByTestId('dropzone').getByRole('alert')).toHaveText('폴더는 보낼 수 없어요. 파일을 골라주세요.');
      const after = (await card.boundingBox())!;
      const footerAfter = (await page.getByRole('contentinfo').boundingBox())!;
      expect(after.height).toBe(before.height);
      expect(after.y).toBe(before.y);
      expect(footerAfter.y).toBe(footerBefore.y);
    });
  }
});

test('clicking the drop field opens the file explorer and allows several files', async ({ page }) => {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('dropzone').click();
  const fileChooser = await chooser;
  expect(fileChooser.isMultiple()).toBe(true);
});
