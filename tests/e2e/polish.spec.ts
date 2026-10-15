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

test('the title has an icon in front, and the 6 has its own accent color', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.brand')).toHaveCSS('color', 'rgb(49, 130, 246)'); // DROP stays Toss blue
  await expect(page.locator('.brand-six')).toHaveCSS('color', 'rgb(234, 88, 12)'); // the 6 is orange

  // the accent still reads on the page background (large text needs 3:1)
  const ratio = await page.evaluate(() => {
    const channels = (css: string) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const luminance = (css: string) => {
      const [r, g, b] = channels(css).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const fg = luminance(getComputedStyle(document.querySelector('.brand-six')!).color);
    const bg = luminance(getComputedStyle(document.body).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(3);

  // the icon sits in front of the letters, as a square mark of a sensible size
  const icon = (await page.locator('.brand .brand-mark').boundingBox())!;
  const text = await page.locator('.brand').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.lastElementChild!);
    const { left, top, bottom } = range.getBoundingClientRect();
    return { left, top, bottom };
  });
  expect(icon.x + icon.width).toBeLessThanOrEqual(text.left);
  expect(icon.width).toBeGreaterThanOrEqual(24);
  expect(icon.width).toBeLessThanOrEqual(32);
  expect(Math.abs(icon.y + icon.height / 2 - (text.top + text.bottom) / 2)).toBeLessThanOrEqual(4); // vertically centered with the letters
  await expect(page.locator('.brand .brand-mark svg')).toHaveCount(1);
  await expect(page.locator('.brand')).toHaveAccessibleName('DROP6 처음으로');
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

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: '360px', width: 360, height: 740 },
]) {
  test(`the gap between the toggle and the card is 40% wider: 8px to 11.2px (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of ['/', '/receive']) {
      await page.goto(route);
      const toggle = (await page.locator('.toggle').boundingBox())!;
      const card = (await page.locator('.card').boundingBox())!;
      const gap = card.y - (toggle.y + toggle.height);
      expect(gap).toBeGreaterThan(11.2 - 0.3);
      expect(gap).toBeLessThan(11.2 + 0.3);
    }
  });
}

test('line breaks in a message are shown as line breaks', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.sub')).toHaveCSS('white-space', 'pre-line');
});
