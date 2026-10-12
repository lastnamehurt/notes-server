import { test, expect } from '@playwright/test';

// Run against an already configured, unlocked test instance.
// NOTES_E2E_PASSWORD is intentionally never committed.
test.describe('Quick Add on a configured Daybook instance', () => {
  test.skip(!process.env.NOTES_E2E_PASSWORD, 'Set NOTES_E2E_PASSWORD and NOTES_BASE_URL to run authenticated scenarios');

  test.beforeEach(async ({ page }) => {
    await page.goto('/app');
    const password = page.locator('input[type="password"]').first();
    if (await password.isVisible()) {
      await password.fill(process.env.NOTES_E2E_PASSWORD!);
      await page.locator('button[type="submit"]').first().click();
    }
    await expect(page.locator('#composer-toggle')).toBeVisible();
    await page.locator('#composer-toggle').click();
  });

  test('offers note, task and log choices on mobile and desktop', async ({ page }) => {
    await expect(page.locator('[data-quick-mode="note"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-quick-mode="task"]').click();
    await expect(page.locator('#logbtn')).toHaveText('Add task');
    await page.locator('[data-quick-mode="log"]').click();
    await expect(page.locator('#chips')).toBeVisible();
    await expect(page.locator('#logbtn')).toHaveText('Log');
  });

  test('captures a note and a task without logging them', async ({ page }) => {
    const unique = 'E2E-' + Date.now();
    await page.locator('#entry').fill(unique + '-note');
    await page.locator('#logbtn').click();
    await expect(page.locator('#entry')).toHaveValue('');
    await page.locator('[data-quick-mode="task"]').click();
    await page.locator('#entry').fill(unique + '-task');
    await page.locator('#logbtn').click();
    await expect(page.locator('#entry')).toHaveValue('');
    await page.goto('/app#reminders');
    await expect(page.getByText(unique + '-task')).toBeVisible();
  });

  test('a task can get a date in one tap and lands under Scheduled', async ({ page }) => {
    const unique = 'E2E-' + Date.now() + '-tomorrow';
    await page.locator('[data-quick-mode="task"]').click();
    await expect(page.locator('[data-quick-when="none"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-quick-when="tomorrow"]').click();
    await page.locator('#entry').fill(unique);
    await page.locator('#logbtn').click();
    await expect(page.locator('.toast').filter({ hasText: 'Added for tomorrow' })).toBeVisible();
    await expect(page.locator('#timebtn')).toBeHidden();
    await page.goto('/app#reminders');
    await expect(page.locator('.rem').filter({ hasText: unique })).toBeVisible();
    // Stored codes like @2026-10-13 or @priority:plan never show on the Tasks page.
    await expect(page.locator('.unified-task, .rem').filter({ hasText: /@\d{4}-\d{2}-\d{2}|@priority:|@daily|@weekdays/ })).toHaveCount(0);
  });
});
