import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../src/app.html', import.meta.url), 'utf8');
test.beforeEach(async ({ page }) => {
  await page.route('**/app', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.route('**/app/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const fixtures = {
      '/app/api/config': { timeZone: 'UTC', categories: ['inbox'], configured: true },
      '/app/api/logs': [{ date: new Date().toISOString().slice(0, 10), content: '- 08:15 Breakfast #food' }],
      '/app/api/reminders': { doneToday: [], firedToday: [], upcoming: [] }
    };
    return route.fulfill({ json: fixtures[path] || {} });
  });
});

test('entry editor opens centered, focuses the entry, and closes with Escape', async ({ page }) => {
  await page.goto('/app#today');
  await page.locator('button.entry').first().click();
  const dialog = page.getByRole('dialog', { name: 'Edit entry' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('What')).toBeFocused();
  const box = await dialog.boundingBox();
  const height = await page.evaluate(() => innerHeight);
  expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('button.entry').first()).toBeFocused();
});

test('entry editor remains inside a short viewport with reachable actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await page.goto('/app#today');
  await page.locator('button.entry').first().click();
  const dialog = page.getByRole('dialog', { name: 'Edit entry' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  const height = await page.evaluate(() => innerHeight);
  expect(box.y).toBeGreaterThanOrEqual(15);
  expect(box.y + box.height).toBeLessThanOrEqual(height - 15);
  await dialog.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
