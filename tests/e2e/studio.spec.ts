import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function loadDemo(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Load demo dataset' }).first().click();
  await page.waitForURL(/\/projects\/[^/]+\/annotate$/, { timeout: 90_000 });
  await expect(page.getByRole('application')).toBeVisible({ timeout: 30_000 });
}

test('dashboard has no accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('demo workflow: annotate, train from ten-plus boxes, auto-label, export', async ({ page }) => {
  await loadDemo(page);

  // Demo seeds 7 annotated images; the auto-label gate must already be met.
  await page.getByRole('tab', { name: 'Auto Label' }).click();
  const train = page.getByRole('button', { name: 'Train model' });
  await expect(train).toBeEnabled({ timeout: 60_000 });
  await train.click();

  await expect(page.getByText('Held-out metrics')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByText(/trained on \d+ annotations/i).first()).toBeVisible();

  const batch = page.getByRole('button', { name: /Label unlabeled images/ });
  await expect(batch).toBeEnabled({ timeout: 30_000 });
  await batch.click();
  await expect(batch).toBeEnabled({ timeout: 180_000 });

  // A version can be frozen and exported without touching the network.
  await page.getByRole('link', { name: 'Dataset versions' }).click();
  await page.getByRole('button', { name: 'New version' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog', { name: /Export dataset/ })).toBeVisible({ timeout: 30_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Download' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});

test('studio has no accessibility violations', async ({ page }) => {
  await loadDemo(page);
  const results = await new AxeBuilder({ page })
    .exclude('[data-radix-popper-content-wrapper]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test('keyboard-only annotation creation and undo', async ({ page }) => {
  await loadDemo(page);
  const canvas = page.getByRole('application');
  await canvas.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Keyboard placement/)).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');

  await expect(page.getByText(/\d+ annotations/).first()).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('status').first()).toBeAttached();
});