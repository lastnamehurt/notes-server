import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Test the local UI without credentials or a notes repository.
const html = await readFile(new URL('../../src/app.html', import.meta.url), 'utf8');
test.beforeEach(async ({ page }) => {
  await page.route('**/app', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/app/api/**', route => route.fulfill({ status: 401, json: {} }));
});

async function choose(page, theme) {
  await page.locator('#theme-toggle').click();
  await page.getByRole('button', { name: theme[0].toUpperCase() + theme.slice(1), exact: true }).click();
  await expect(page.locator('#appearance')).not.toHaveAttribute('open', '');
}

test('explicit appearance overrides the device and survives reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/app');
  const picker = page.locator('#theme-toggle');
  await expect(picker).toHaveAttribute('aria-label', 'Appearance: System');
  await choose(page, 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 245, 242)');
  await page.reload();
  await expect(picker).toHaveAttribute('aria-label', 'Appearance: Light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 245, 242)');
  await choose(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(25, 26, 35)');
  await page.reload();
  await expect(picker).toHaveAttribute('aria-label', 'Appearance: Dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(25, 26, 35)');
  const browserColors = await page.locator('meta[name="theme-color"]').evaluateAll(nodes => nodes.map(n => n.content));
  expect(browserColors).toEqual(['#191A23', '#191A23']);
});

test('System follows device changes and can be restored after an override', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/app');
  const picker = page.locator('#theme-toggle');
  await choose(page, 'dark');
  await choose(page, 'system');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 245, 242)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(25, 26, 35)');
  await page.reload();
  await expect(picker).toHaveAttribute('aria-label', 'Appearance: System');
});

test('appearance remains usable when storage is unavailable', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
  });
  await page.goto('/app');
  await choose(page, 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(25, 26, 35)');
  expect(errors).toEqual([]);
});

test('appearance choices support the keyboard and dismiss without changing theme', async ({ page }) => {
  await page.goto('/app');
  const toggle = page.locator('#theme-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).not.toBeVisible();
  await toggle.click();
  await page.locator('#date').click();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).not.toBeVisible();
  await expect(toggle).toHaveAttribute('aria-label', 'Appearance: System');
});
