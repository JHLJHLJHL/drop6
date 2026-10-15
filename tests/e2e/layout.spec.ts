import { expect, test, type Page } from '@playwright/test';
import { SPECIES_NAMES } from '../../src/client/lib/speciesNames';
import { joinAndReview, makeTestFile, newReceiverContext, resetServer, startSending } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

const PRIVACY = '파일은 암호화되어 전송, 서버에 저장하지 않음';

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
  await expect(page.getByText('파일을 고르면 6자리 코드를 만들어드려요')).toBeVisible();

  await startSending(page, makeTestFile(2048, 'a-long-name-to-check-wrapping.bin'));
  await expect(page.getByRole('heading', { name: '코드를 알려주세요' })).toBeVisible();
  await expect(page.locator('.heading-center')).toHaveCSS('text-align', 'center');
  await expect(page.getByText('받는 사람이 이 코드를 입력하면 연결돼요')).toBeVisible();

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
  await expect(page.getByText(PRIVACY)).toBeVisible();
  await expect(page.getByText(PRIVACY)).toHaveCSS('text-align', 'center');
  await startSending(page, makeTestFile(2048));
  for (const text of removed) await expect(page.getByText(text)).toHaveCount(0);
  await expect(page.getByText(PRIVACY)).toBeVisible();
  await expect(page.getByText(PRIVACY)).toHaveCSS('text-align', 'center');
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

test('receivers show up under fish scientific names with a Lucide fish icon', async ({ browser, page }) => {
  const code = await startSending(page, makeTestFile(64 * 1024));
  const contexts = await Promise.all([1, 2, 3].map(() => newReceiverContext(browser)));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const receiver of pages) await joinAndReview(receiver, code);

  const names = page.locator('.peer-name');
  await expect(names).toHaveCount(3);
  const texts = (await names.allTextContents()).map((text) => text.trim());
  expect(new Set(texts).size).toBe(3);
  for (const text of texts) expect(SPECIES_NAMES).toContain(text);
  for (let i = 0; i < 3; i += 1) {
    const icon = names.nth(i).locator('svg.lucide-fish');
    await expect(icon).toHaveCount(1);
    // the icon is in front of the name
    const iconBox = (await icon.boundingBox())!;
    const nameBox = (await names.nth(i).boundingBox())!;
    expect(iconBox.x).toBeLessThanOrEqual(nameBox.x + 1);
  }
  await Promise.all(contexts.map((context) => context.close()));
});

test('every receive step is centered: review, receiving and canceled', async ({ browser, page }) => {
  const code = await startSending(page, makeTestFile(2 * 1024 * 1024));
  const context = await newReceiverContext(browser, 'opfs', 150);
  const receiver = await context.newPage();
  await joinAndReview(receiver, code);

  const centered = async (heading: string) => {
    const title = receiver.getByRole('heading', { name: heading });
    await expect(title).toBeVisible();
    await expect(receiver.locator('.heading-center')).toHaveCSS('text-align', 'center');
    const block = (await receiver.locator('.heading-center').boundingBox())!;
    const text = (await title.boundingBox())!;
    const card = (await receiver.locator('.card').boundingBox())!;
    // title sits in the middle of the card, not against the left edge
    expect(Math.abs(text.x + text.width / 2 - (card.x + card.width / 2))).toBeLessThan(8);
    expect(block.width).toBeGreaterThan(0);
  };

  await centered('이 파일을 받을까요?');
  await expect(receiver.getByText('보내는 사람이 보낸 파일 정보예요.')).toBeVisible();
  await expect(receiver.getByText(PRIVACY)).toHaveCSS('text-align', 'center');

  await receiver.getByRole('button', { name: '파일 받기' }).click();
  await centered('파일을 받는 중이에요');
  await receiver.getByRole('button', { name: '받기 취소' }).click();
  await centered('받기를 취소했어요');
  await expect(receiver.getByText('다시 받으려면 보내는 사람에게 코드를 받아 입력해주세요.')).toBeVisible();
  await context.close();
});
