import { expect, test } from '@playwright/test';
import { resetServer } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetServer(request);
});

test.describe('touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('tapping 받기 neither focuses the code field nor scrolls the page', async ({ page }) => {
    await page.goto('/');
    // the emulation really looks like a phone to the app
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);

    await page.evaluate(() => {
      const w = window as unknown as { __scrolls: number };
      w.__scrolls = 0;
      window.addEventListener('scroll', () => (w.__scrolls += 1), true);
    });
    await page.getByRole('link', { name: '받기' }).tap();
    await expect(page.getByRole('heading', { name: '전송 코드를 입력해주세요' })).toBeVisible();
    await page.waitForTimeout(600);

    const state = await page.evaluate(() => ({
      scrollY: window.scrollY,
      scrolls: (window as unknown as { __scrolls: number }).__scrolls,
      focusedInput: document.activeElement?.id === 'transfer-code-input',
      viewportOffset: window.visualViewport?.offsetTop ?? 0,
    }));
    expect(state).toEqual({ scrollY: 0, scrolls: 0, focusedInput: false, viewportOffset: 0 });

    // the field still works when the user taps it themselves
    await page.getByLabel('전송 코드').tap();
    await expect(page.getByLabel('전송 코드')).toBeFocused();
  });
});

test('on desktop the code field is still ready to type right away', async ({ page }) => {
  await page.goto('/receive');
  await expect(page.getByLabel('전송 코드')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
