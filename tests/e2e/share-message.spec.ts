import { expect, test, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { makeTestFile, newReceiverContext, resetServer, startSending } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/** Draws the QR code the page shows onto a canvas (as a camera would see it) and decodes it with jsQR. */
async function decodeShownQr(page: Page): Promise<string | undefined> {
  const size = 300;
  const pixels = await page.locator('svg.qr').evaluate(async (svg, side) => {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(side));
    clone.setAttribute('height', String(side));
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = side;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0, side, side);
    return Array.from(context.getImageData(0, 0, side, side).data);
  }, size);
  return jsQR(Uint8ClampedArray.from(pixels), size, size)?.data;
}

test('the sender gets a ready-to-send message and can copy it with the icon', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const code = await startSending(page, makeTestFile(2048));
  const origin = new URL(baseURL!).origin;
  const expected = `${origin} 에 접속해 파일을 다운로드 하세요.😊\n코드는 ${code}`;

  const label = page.locator('.share .section-label');
  expect(await label.innerText()).toBe('메시지 전달하기(복사해 사용하거나 QR코드를 촬영하세요)');
  expect(await page.getByTestId('share-message').innerText()).toBe(expected);

  await page.getByRole('button', { name: '메시지 복사하기' }).click();
  await expect(page.getByRole('button', { name: '복사했어요' })).toHaveCount(1);
  await expect(page.locator('.copy-icon svg.lucide-check')).toBeVisible();
  // Windows clipboards turn line breaks into CRLF, so compare with normalized line breaks
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(expected);

  // the check mark goes back to the copy icon
  await expect(page.getByRole('button', { name: '메시지 복사하기' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.copy-icon svg.lucide-copy')).toBeVisible();
});

test('the big code is still shown, above the message', async ({ page }) => {
  const code = await startSending(page, makeTestFile(2048));
  const big = page.getByTestId('transfer-code');
  await expect(big).toBeVisible();
  expect(await big.innerText()).toBe(`${code.slice(0, 3)} ${code.slice(3)}`);
  // the card itself is the button that copies the code; readers get the plain digits
  await expect(big).toHaveAccessibleName(`전송 코드 ${code.split('').join(' ')} 복사`);
  await expect(page.getByRole('button', { name: '코드 복사하기' })).toHaveCount(0); // no second button just for the code

  const title = await box(page, 'h1');
  const codeBox = await box(page, '[data-testid=transfer-code]');
  const label = await box(page, '.share .section-label');
  const row = await box(page, '.share-row');
  const headcount = (await page.getByText('접속한 사람').boundingBox())!;
  expect(codeBox.y).toBeGreaterThanOrEqual(title.y + title.height);
  expect(label.y).toBeGreaterThanOrEqual(codeBox.y + codeBox.height);
  expect(row.y).toBeGreaterThanOrEqual(label.y + label.height);
  expect(headcount.y).toBeGreaterThanOrEqual(row.y + row.height);
  // the code box is the large type it always was
  await expect(big).toHaveCSS('font-weight', '800');
  expect(parseFloat(await big.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(36);
});

test('the message box is narrower, with a square QR code attached on its right', async ({ page }) => {
  await startSending(page, makeTestFile(2048));
  const message = await box(page, '.message-box');
  const qr = await box(page, 'svg.qr');
  const codeBox = await box(page, '[data-testid=transfer-code]');

  expect(Math.abs(qr.width - qr.height)).toBeLessThanOrEqual(0.5); // square
  expect(qr.width).toBeGreaterThanOrEqual(96);
  expect(qr.x).toBeGreaterThanOrEqual(message.x + message.width); // to the right of the message box
  expect(qr.x - (message.x + message.width)).toBeLessThanOrEqual(20); // attached, not floating away
  expect(Math.abs(qr.y - message.y)).toBeLessThanOrEqual(1); // tops line up
  expect(Math.abs(qr.x + qr.width - (codeBox.x + codeBox.width))).toBeLessThanOrEqual(1); // same right edge as the code box
  expect(message.width).toBeLessThan(codeBox.width - qr.width); // the box gave up the width the QR code takes
});

test('the copy icon appears when the mouse is over the message box', async ({ page }) => {
  await startSending(page, makeTestFile(2048));
  const icon = page.getByRole('button', { name: '메시지 복사하기' });

  await page.mouse.move(2, 2);
  await expect(icon).toHaveCSS('opacity', '0');
  await page.locator('.message-box').hover();
  await expect(icon).toHaveCSS('opacity', '1');
  await page.mouse.move(2, 2);
  await expect(icon).toHaveCSS('opacity', '0');

  // keyboard users get it too
  await icon.focus();
  await expect(icon).toHaveCSS('opacity', '1');

  // it sits in the top right corner of the box, with the 44px touch target
  const message = await box(page, '.message-box');
  const target = (await icon.boundingBox())!;
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(target.x + target.width).toBeGreaterThan(message.x + message.width - 20);
  expect(target.y).toBeLessThan(message.y + 20);
});

test('the QR code opens the receive screen with the code filled in, and connects right away', async ({ page, browser }) => {
  const code = await startSending(page, makeTestFile(2048));
  const link = await decodeShownQr(page);
  const origin = new URL(page.url()).origin;
  expect(link).toBe(`${origin}/receive#code=${code}`);

  // what a phone does after scanning: open the link
  const context = await newReceiverContext(browser);
  const phone = await context.newPage();
  await phone.goto(link!);
  await expect(phone.getByRole('heading', { name: '이 파일을 받을까요?' })).toBeVisible();
  await expect(page.getByText('1 / 3명')).toBeVisible();
  // the code does not stay in the address bar
  await expect.poll(() => new URL(phone.url()).hash).toBe('');
  expect(new URL(phone.url()).pathname).toBe('/receive');
  await context.close();
});

test('a receive link with a wrong code shows the usual explanation', async ({ browser, baseURL }) => {
  const context = await newReceiverContext(browser);
  const phone = await context.newPage();
  await phone.goto(`${baseURL}/receive#code=000000`);
  await expect(phone.getByRole('heading', { name: '없는 코드예요' })).toBeVisible();
  await context.close();
});

test('a receiver can still use the message: its address and code work', async ({ page, browser, baseURL }) => {
  const code = await startSending(page, makeTestFile(2048));
  const message = await page.getByTestId('share-message').innerText();
  const [, address, messageCode] = /^(\S+) 에 접속해 파일을 다운로드 하세요\.😊\n코드는 (\d{6})$/u.exec(message)!;
  expect(address).toBe(new URL(baseURL!).origin);
  expect(messageCode).toBe(code);

  const context = await browser.newContext();
  const receiver = await context.newPage();
  await receiver.goto(`${address}/receive`);
  await receiver.getByLabel('전송 코드').fill(messageCode);
  await receiver.getByRole('button', { name: '연결하기' }).click();
  await expect(receiver.getByRole('heading', { name: '이 파일을 받을까요?' })).toBeVisible();
  await context.close();
});

test.describe('touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the copy icon is always visible, since there is no hover, and copying shows the check mark', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const code = await startSending(page, makeTestFile(2048));
    const icon = page.getByRole('button', { name: '메시지 복사하기' });
    await expect(icon).toHaveCSS('opacity', '1');
    await icon.tap();
    await expect(page.locator('.copy-icon svg.lucide-check')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`코드는 ${code}`);
  });
});

test.describe('360px', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('message box, copy icon and QR code fit side by side', async ({ page }) => {
    await startSending(page, makeTestFile(2048));
    const message = await box(page, '.message-box');
    const qr = await box(page, 'svg.qr');
    const icon = (await page.getByRole('button', { name: '메시지 복사하기' }).boundingBox())!;

    expect(message.x).toBeGreaterThanOrEqual(0);
    expect(qr.x + qr.width).toBeLessThanOrEqual(360);
    expect(qr.x).toBeGreaterThanOrEqual(message.x + message.width);
    expect(Math.abs(qr.width - qr.height)).toBeLessThanOrEqual(0.5);
    expect(qr.width).toBeGreaterThanOrEqual(90); // still big enough for a phone camera
    expect(icon.width).toBeGreaterThanOrEqual(44);
    expect(icon.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // and it still scans
    expect(await decodeShownQr(page)).toMatch(/\/receive#code=\d{6}$/);
  });
});
