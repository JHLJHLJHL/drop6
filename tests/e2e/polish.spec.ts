import { expect, test } from '@playwright/test';
import { resetServer } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

test('the email is plain text that only gets an underline on hover (no box)', async ({ page }) => {
  await page.goto('/');
  const email = page.getByRole('button', { name: /honeymath\.gbe@gmail\.com/ });
  await expect(email).toHaveCSS('text-decoration-line', 'none');
  await expect(email).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await email.hover();
  await expect(email).toHaveCSS('text-decoration-line', 'underline');
  await expect(email).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(email).toHaveCSS('border-top-width', '0px');
  await expect(email).toHaveCSS('box-shadow', 'none');
});

test('the signature font is 1px smaller than before', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.owner')).toHaveCSS('font-size', '12px'); // was 13px
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.locator('.owner')).toHaveCSS('font-size', '11px'); // was 12px
});

test('the cards no longer carry extra links; the toggle switches sides', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('파일을 받으러 오셨나요?')).toHaveCount(0);
  await expect(page.getByText('코드 입력하기')).toHaveCount(0);
  await page.getByRole('link', { name: '받기' }).click();
  await expect(page.getByText('파일을 보내러 오셨나요?')).toHaveCount(0);
  // only the brand and the two toggle links remain
  await expect(page.locator('a[href]')).toHaveCount(3);
});

test('subtitles and notes have no trailing period', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('파일을 고르면 6자리 코드를 만들어드려요', { exact: true })).toBeVisible();
  await expect(page.getByText('파일은 암호화되어 전송, 서버에 저장하지 않음', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '받기' }).click();
  await expect(page.getByText('보내는 사람이 알려준 6자리 코드예요', { exact: true })).toBeVisible();
});

test('the DROP6 title is 3px bigger', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.brand')).toHaveCSS('font-size', '23px'); // was 20px
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.locator('.brand')).toHaveCSS('font-size', '23px');
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: '360px', width: 360, height: 740 },
]) {
  test(`the signature is two right-aligned lines: name above email (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');

    // text extents (not the padded boxes) so the right edges can be compared exactly
    const extent = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const { top, bottom, left, right } = range.getBoundingClientRect();
        return { top, bottom, left, right };
      });
    const name = await extent('.owner-name');
    const email = await extent('.email-button');
    const row = (await page.locator('.app-header-row').boundingBox())!;
    const brand = (await page.locator('.brand').boundingBox())!;

    expect(name.bottom).toBeLessThanOrEqual(email.top + 1); // LJH2026 sits on the line above the email
    expect(Math.abs(name.right - email.right)).toBeLessThanOrEqual(1); // both end at the same right edge
    expect(name.left).toBeGreaterThan(email.left); // the shorter name is pushed to the right, not left-aligned
    expect(email.right).toBeLessThanOrEqual(row.x + row.width + 1);
    expect(email.left).toBeGreaterThan(brand.x + brand.width); // still on the title row, right of DROP6
  });
}

test('the whole signature stays a 44px touch target', async ({ page }) => {
  await page.goto('/');
  const box = (await page.getByRole('button', { name: /honeymath/ }).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // the name is drawn over the top of that target instead of making the header taller
  const header = (await page.locator('.app-header-row').boundingBox())!;
  expect(header.height).toBeLessThanOrEqual(box.height + 1);
});

test('line breaks in a message are shown as line breaks', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sub')).toHaveCSS('white-space', 'pre-line');
});
