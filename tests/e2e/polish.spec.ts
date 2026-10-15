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
  await expect(page.locator('.app-footer')).toHaveCSS('font-size', '12px'); // was 13px
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.locator('.app-footer')).toHaveCSS('font-size', '11px'); // was 12px
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

test('the header only holds the title now, and the email keeps a 44px touch target in the footer', async ({ page }) => {
  await page.goto('/');
  const header = (await page.locator('.app-header-row').boundingBox())!;
  const brand = (await page.locator('.brand').boundingBox())!;
  expect(header.height).toBeLessThanOrEqual(brand.height + 1);

  const email = (await page.getByRole('button', { name: /honeymath/ }).boundingBox())!;
  expect(email.height).toBeGreaterThanOrEqual(44);
  const footer = (await page.locator('.app-footer').boundingBox())!;
  expect(email.y).toBeGreaterThanOrEqual(footer.y - 1);
  expect(email.y + email.height).toBeLessThanOrEqual(footer.y + footer.height + 1);
});

test('line breaks in a message are shown as line breaks', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sub')).toHaveCSS('white-space', 'pre-line');
});
