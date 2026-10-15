import { expect, test, type Page } from '@playwright/test';
import { makeTestFile, resetServer, startSending } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

test('owner name and email sit at the right end of the title row', async ({ page }) => {
  await page.goto('/');
  const brand = await box(page, '.brand');
  const owner = await box(page, '.owner');
  const row = await box(page, '.app-header-row');
  expect(Math.abs(brand.y + brand.height / 2 - (owner.y + owner.height / 2))).toBeLessThan(brand.height);
  expect(owner.x).toBeGreaterThan(brand.x + brand.width);
  expect(Math.abs(owner.x + owner.width - (row.x + row.width))).toBeLessThanOrEqual(1);
  await expect(page.locator('.owner')).toHaveCSS('text-align', 'right');
});

test('the send / receive toggle is above the card and switches screens', async ({ page }) => {
  await page.goto('/');
  const toggle = await box(page, '.toggle');
  const card = await box(page, '.card');
  expect(toggle.y + toggle.height).toBeLessThanOrEqual(card.y);

  await page.getByRole('link', { name: '받기' }).click();
  await expect(page.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeVisible();
  await expect(page.getByRole('link', { name: '받기' })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/\/receive$/);
  await page.getByRole('link', { name: '보내기' }).click();
  await expect(page.getByRole('heading', { name: '어떤 파일을 보낼까요?' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('pressing the email copies it and shows 복사되었습니다', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByRole('button', { name: /honeymath\.gbe@gmail\.com/ }).click();
  await expect(page.getByRole('status')).toHaveText('복사되었습니다');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('honeymath.gbe@gmail.com');
  await expect(page.getByRole('status')).toHaveText('', { timeout: 5_000 });
});

test('headings are centered, the countdown is right-aligned and file names are 2px smaller', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.heading-center').first()).toHaveCSS('text-align', 'center');
  await expect(page.getByText('파일을 고르면 6자리 코드를 만들어드려요.')).toBeVisible();

  await startSending(page, makeTestFile(2048, 'a-long-name-to-check-wrapping.bin'));
  await expect(page.getByRole('heading', { name: '코드를 알려주세요' })).toBeVisible();
  await expect(page.locator('.heading-center')).toHaveCSS('text-align', 'center');
  await expect(page.getByText('받는 사람이 이 코드를 입력하면 연결돼요.')).toBeVisible();

  const timer = page.getByRole('timer');
  await expect(timer).toHaveText(/^\d\d:\d\d$/);
  const countdown = await box(page, '.countdown');
  const status = await box(page, '.status-row');
  expect(Math.abs(countdown.x + countdown.width - (status.x + status.width))).toBeLessThanOrEqual(1);
  await expect(page.locator('.countdown')).toHaveCSS('text-align', 'right');

  await expect(page.locator('.file-name')).toHaveCSS('font-size', '14px');
});

test('the removed notes are gone from the send screens', async ({ page }) => {
  const removed = [
    '새로운 사람은 30분 동안 들어올 수 있어요.',
    '아직 아무도 들어오지 않았어요. 코드를 알려주세요.',
    '보내는 사람이 창을 닫으면 전송도 멈춰요.',
    '30분이 지나도 진행 중인 전송은 계속돼요.',
    '파일은 암호화되어 전송되며 서버에 저장하지 않아요.',
  ];
  await page.goto('/');
  for (const text of removed) await expect(page.getByText(text)).toHaveCount(0);
  await startSending(page, makeTestFile(2048));
  for (const text of removed) await expect(page.getByText(text)).toHaveCount(0);
});

test.describe('360px', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test('header, toggle and toast stay inside the screen', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    for (const selector of ['.brand', '.owner', '.toggle', '.email-button']) {
      const b = await box(page, selector);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(360);
    }
    const owner = await box(page, '.owner');
    const header = await box(page, '.app-header');
    expect(owner.x + owner.width).toBeLessThanOrEqual(header.x + header.width + 1);
    await page.getByRole('button', { name: /honeymath/ }).click();
    const toast = await box(page, '.toast');
    expect(toast.x).toBeGreaterThanOrEqual(0);
    expect(toast.x + toast.width).toBeLessThanOrEqual(360);
  });
});
