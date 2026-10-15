import { expect, test } from '@playwright/test';
import { makeTestFile, resetServer, startSending } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

test('the sender can copy a ready-to-send message with the address and the code', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const code = await startSending(page, makeTestFile(2048));
  const expected = `${new URL(baseURL!).origin} 에 접속해 파일을 받으세요.\n코드는 ${code} 입니다.`;

  await expect(page.getByText('메시지 전달하기')).toBeVisible();
  const box = page.getByTestId('share-message');
  await expect(box).toBeVisible();
  expect(await box.innerText()).toBe(expected); // two lines, as shown

  // layout: code button, then the message section, then the headcount
  const copyCode = (await page.getByRole('button', { name: '코드 복사하기' }).boundingBox())!;
  const label = (await page.getByText('메시지 전달하기').boundingBox())!;
  const boxRect = (await box.boundingBox())!;
  const copyMessage = (await page.getByRole('button', { name: '메시지 복사하기' }).boundingBox())!;
  const headcount = (await page.getByText('접속한 사람').boundingBox())!;
  expect(label.y).toBeGreaterThanOrEqual(copyCode.y + copyCode.height);
  expect(boxRect.y).toBeGreaterThanOrEqual(label.y + label.height);
  expect(copyMessage.y).toBeGreaterThanOrEqual(boxRect.y + boxRect.height);
  expect(headcount.y).toBeGreaterThanOrEqual(copyMessage.y + copyMessage.height);

  await page.getByRole('button', { name: '메시지 복사하기' }).click();
  await expect(page.getByRole('button', { name: '복사했어요' })).toHaveCount(1);
  // Windows clipboards turn line breaks into CRLF, so compare with normalized line breaks
  const clipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  expect(await clipboard()).toBe(expected);

  // the code button still copies just the code
  await page.getByRole('button', { name: '코드 복사하기' }).click();
  expect(await clipboard()).toBe(code);
});

test('a receiver can use the message: the address in it opens the app and the code in it works', async ({ page, browser, baseURL }) => {
  const code = await startSending(page, makeTestFile(2048));
  const message = await page.getByTestId('share-message').innerText();
  const [, address, messageCode] = /^(\S+) 에 접속해 파일을 받으세요\.\n코드는 (\d{6}) 입니다\.$/.exec(message)!;
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

test.describe('360px', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('the message box fits and its buttons keep the 44px touch target', async ({ page }) => {
    await startSending(page, makeTestFile(2048));
    const box = (await page.getByTestId('share-message').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    const button = (await page.getByRole('button', { name: '메시지 복사하기' }).boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
