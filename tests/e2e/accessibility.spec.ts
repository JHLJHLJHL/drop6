import { expect, test, type Page } from '@playwright/test';
import { downloadedHash, makeTestFile, newReceiverContext, resetServer, startSending } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectTouchTargets(page: Page) {
  const small = await page.evaluate(() => {
    const selector = 'button:not(:disabled), a[href], input:not([type=file])';
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((el) => ({ label: el.textContent?.trim() || el.getAttribute('aria-label') || el.tagName, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height < 44 - 0.5 || rect.width < 44 - 0.5)
      .map(({ label, rect }) => `${label} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
  });
  expect(small).toEqual([]);
}

test.describe('360px mobile layout', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('home, receive and sender screens fit without horizontal scroll and keep 44px touch targets', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectTouchTargets(page);

    await page.goto('/receive');
    await expect(page.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeVisible();
    await page.getByLabel('전송 코드').fill('123456');
    await expectNoHorizontalScroll(page);
    await expectTouchTargets(page);

    await startSending(page, makeTestFile(1024));
    await expect(page.getByTestId('transfer-code')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectTouchTargets(page);
    const code = await page.getByTestId('transfer-code').boundingBox();
    expect(code!.x).toBeGreaterThanOrEqual(0);
    expect(code!.x + code!.width).toBeLessThanOrEqual(360);
  });

  test('a receiver in review state fits as well', async ({ browser, page }) => {
    const code = await startSending(page, makeTestFile(1024, 'a-rather-long-file-name-for-a-small-phone-screen-1234567890.bin'));
    const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const receiver = await context.newPage();
    await receiver.goto('/receive');
    await receiver.getByLabel('전송 코드').fill(code);
    await receiver.getByRole('button', { name: '연결하기' }).click();
    await expect(receiver.getByRole('heading', { name: '이 파일을 받을까요?' })).toBeVisible();
    await expectNoHorizontalScroll(receiver);
    await expectTouchTargets(receiver);
    await context.close();
  });
});

test('the whole flow works with the keyboard alone and focus is always visible', async ({ browser, page }) => {
  const file = makeTestFile(256 * 1024);

  // Sender: Tab to the primary button, Enter opens the file chooser.
  await page.goto('/');
  const order: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''));
    if (order.at(-1) === '파일 고르기') break;
  }
  // header (brand, email, 보내기/받기 toggle) comes first, then the card's primary button
  expect(order).toEqual(['DROP6 처음으로', 'honeymath.gbe@gmail.com 복사', '보내기', '받기', '파일 고르기']);
  const pick = page.getByRole('button', { name: '파일 고르기' });
  await expect(pick).toBeFocused();
  const outline = await pick.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);

  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(file);
  await expect(page.getByTestId('transfer-code')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '코드 복사하기' })).toBeFocused();
  const code = ((await page.getByTestId('transfer-code').textContent()) ?? '').replace(/\s/g, '');

  // Receiver: the code field has focus on arrival; Enter submits, Tab reaches 파일 받기.
  const context = await newReceiverContext(browser);
  const receiver = await context.newPage();
  await receiver.goto('/receive');
  await expect(receiver.getByLabel('전송 코드')).toBeFocused();
  await receiver.keyboard.type(code);
  await receiver.keyboard.press('Enter');
  await expect(receiver.getByRole('heading', { name: '이 파일을 받을까요?' })).toBeVisible();
  await receiver.keyboard.press('Tab');
  const accept = receiver.getByRole('button', { name: '파일 받기' });
  await expect(accept).toBeFocused();
  const [download] = await Promise.all([receiver.waitForEvent('download'), receiver.keyboard.press('Enter')]);
  expect(await downloadedHash(download)).toBe(file.hash);
  await expect(receiver.getByRole('heading', { name: '다 받았어요' })).toBeVisible();
  await context.close();
});

test('buttons react to hover and respect reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const button = page.getByRole('button', { name: '파일 고르기' });
  const before = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
  await button.hover();
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);
  const duration = await button.evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThan(0.01);
});
