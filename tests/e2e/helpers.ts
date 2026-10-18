import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Download, type Page } from '@playwright/test';

export const MINUTE = 60_000;

export const sha256 = (data: Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex');

export interface TestFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
  hash: string;
}

export function makeTestFile(size = 2 * 1024 * 1024, name = 'drop6-test.bin'): TestFile {
  const buffer = randomBytes(size);
  return { name, mimeType: 'application/octet-stream', buffer, hash: sha256(buffer) };
}

/** Test-only server controls: reset the test clock and the join rate limiter. */
export async function resetServer(request: APIRequestContext): Promise<void> {
  const response = await request.post('/__test__/reset');
  expect(response.ok()).toBe(true);
}

export async function advanceServerClock(request: APIRequestContext, ms: number): Promise<void> {
  const response = await request.post('/__test__/clock/advance', { data: { ms } });
  expect(response.ok()).toBe(true);
}

/** Makes the browser behave like one without the File System Access API (Blob download fallback). */
export async function useBlobDownloads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });
}

/**
 * Replaces the save dialog with an OPFS-backed file so the File System Access
 * streaming path runs for real. `writeDelayMs` slows every write down.
 */
export async function useOpfsSaveDialog(context: BrowserContext, writeDelayMs = 0): Promise<void> {
  await context.addInitScript((delayMs: number) => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async (options: { suggestedName: string }) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(options.suggestedName, { create: true });
      const real = await handle.createWritable();
      const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        name: handle.name,
        createWritable: async () => ({
          write: async (chunk: ArrayBuffer) => {
            if (delayMs) await pause();
            await real.write(chunk);
          },
          close: () => real.close(),
          abort: () => real.abort(),
        }),
      };
    };
  }, writeDelayMs);
}

/** The folder the fake folder dialog "picks"; read it back with readPickedFolder. */
export const PICKED_FOLDER = 'picked-folder';

/**
 * Makes the folder dialog hand back an OPFS folder named PICKED_FOLDER, so files streamed into it can be read back.
 * `writeDelayMs` slows every write down.
 */
export async function useOpfsFolderDialog(context: BrowserContext, writeDelayMs = 0): Promise<void> {
  await context.addInitScript(
    ({ folder, delayMs }: { folder: string; delayMs: number }) => {
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folder, { create: true });
        if (!delayMs) return dir;
        const pause = () => new Promise((resolve) => setTimeout(resolve, delayMs));
        return {
          name: dir.name,
          getFileHandle: async (name: string, options?: { create?: boolean }) => {
            const handle = await dir.getFileHandle(name, options);
            return {
              createWritable: async () => {
                const real = await handle.createWritable();
                return {
                  write: async (chunk: ArrayBuffer) => {
                    await pause();
                    await real.write(chunk);
                  },
                  close: () => real.close(),
                  abort: () => real.abort(),
                };
              },
            };
          },
        };
      };
    },
    { folder: PICKED_FOLDER, delayMs: writeDelayMs },
  );
}

/** Every file in the fake picked folder: name -> bytes. */
export async function readPickedFolder(page: Page): Promise<Record<string, Buffer>> {
  const saved = await page.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(folder);
    const out: Record<string, number[]> = {};
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
      out[name] = Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
    }
    return out;
  }, PICKED_FOLDER);
  return Object.fromEntries(Object.entries(saved).map(([name, bytes]) => [name, Buffer.from(bytes)]));
}

export async function newReceiverContext(browser: Browser, mode: 'blob' | 'opfs' = 'blob', writeDelayMs = 0): Promise<BrowserContext> {
  const context = await browser.newContext();
  if (mode === 'blob') {
    await useBlobDownloads(context);
  } else {
    await useOpfsSaveDialog(context, writeDelayMs);
    await useOpfsFolderDialog(context, writeDelayMs);
  }
  return context;
}

/** Opens the sender page, picks the file and returns the transfer code. */
export async function startSending(page: Page, file: TestFile | string): Promise<string> {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(typeof file === 'string' ? file : { name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  return readCode(page);
}

/** The code is only shown inside the message to hand over ("코드는 123456"). */
export async function readCode(page: Page): Promise<string> {
  const message = page.getByTestId('share-message');
  await expect(message).toBeVisible();
  const match = /코드는 (\d{6})/.exec(await message.innerText());
  expect(match, 'the message contains the 6-digit code').not.toBeNull();
  return match![1]!;
}

export async function enterCode(page: Page, code: string): Promise<void> {
  await page.goto('/receive');
  await page.getByLabel('전송 코드').fill(code);
  await page.getByRole('button', { name: '연결하기' }).click();
}

/** Joins as a receiver and waits until the file info is on screen. */
export async function joinAndReview(page: Page, code: string): Promise<void> {
  await enterCode(page, code);
  await expect(page.getByRole('heading', { name: '이 파일을 받을까요?' })).toBeVisible();
}

/** Turns on 위치 지정 다운로드, so receiving opens the (fake) save dialog instead of a plain download. */
export async function chooseSaveLocation(page: Page): Promise<void> {
  const locationSwitch = page.getByRole('switch', { name: /위치 지정 다운로드/ });
  await locationSwitch.setChecked(true);
  await expect(locationSwitch).toBeChecked();
}

export async function acceptAndDownload(page: Page, button = '파일 받기'): Promise<Download> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button }).click()]);
  return download;
}

export async function downloadedHash(download: Download): Promise<string> {
  const path = await download.path();
  return sha256(readFileSync(path));
}
