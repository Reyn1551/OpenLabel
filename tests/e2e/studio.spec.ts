import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function loadDemo(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Load demo dataset' }).first().click();
  await page.waitForURL(/\/projects\/[^/]+\/annotate$/, { timeout: 90_000 });
  await expect(page.getByRole('application')).toBeVisible({ timeout: 30_000 });
}

test('new project dialog keeps focus while typing', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const name = dialog.getByLabel('Project name', { exact: false });
  await name.click();
  await name.pressSequentially('Bearing inspection', { delay: 30 });

  // The input must keep focus and retain every character: a remount would drop
  // focus and reset the value.
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Bearing inspection');
  await expect(dialog).toBeVisible();
});

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

test('light theme keeps contrast and structure', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await loadDemo(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('link', { name: 'Dataset health' }).click();
  await expect(page.getByRole('heading', { name: 'Dataset health' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
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
test('A / D and the prev/next buttons step through images', async ({ page }) => {
  await loadDemo(page);
  const selected = () => page.locator('ul[aria-label="Images"] button[aria-current="true"]');
  await expect(selected()).toHaveCount(1);
  const first = (await selected().innerText()).trim();

  await page.keyboard.press('d');
  await expect.poll(async () => (await selected().innerText()).trim()).not.toBe(first);
  const second = (await selected().innerText()).trim();

  await page.keyboard.press('a');
  await expect.poll(async () => (await selected().innerText()).trim()).toBe(first);

  // The desktop bar's buttons do the same thing. `.last()` picks the visible
  // desktop bar (the mobile bar's duplicate is lg:hidden at this viewport).
  await page.getByRole('button', { name: 'Next image (D)' }).last().click();
  await expect.poll(async () => (await selected().innerText()).trim()).toBe(second);
  await page.getByRole('button', { name: 'Previous image (A)' }).last().click();
  await expect.poll(async () => (await selected().innerText()).trim()).toBe(first);
});

test('switching images keeps the canvas mounted', async ({ page }) => {
  await loadDemo(page);
  await page.getByRole('tab', { name: 'Images', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Similar images' })).toBeVisible();
  const similar = page.locator('aside button[title^="Similarity"]');
  await expect(similar.first()).toBeVisible();
  await similar.first().click();
  await expect(page.getByRole('application')).toBeVisible({ timeout: 15_000 });

  const options = page.getByRole('button', { name: /annotations?$/ });
  if ((await options.count()) > 1) {
    await options.nth(1).click();
    await expect(page.getByRole('application')).toBeVisible({ timeout: 15_000 });
  }
});

test('studio rails collapse and persist', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await loadDemo(page);

  const rail = page.getByRole('heading', { name: /Images \(\d+\)/ });
  await expect(rail).toBeVisible();

  await page.getByRole('button', { name: 'Hide image list' }).click();
  await expect(rail).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show image list' })).toBeVisible();

  await page.getByRole('button', { name: 'Show image list' }).click();
  await expect(rail).toBeVisible();

  // The choice survives a reload.
  await page.getByRole('button', { name: 'Hide image list' }).click();
  await expect(rail).toBeHidden();
  await page.reload();
  await expect(page.getByRole('application')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Show image list' })).toBeVisible();
});

test('mobile layout exposes panels through accessible dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadDemo(page);
  await expect(page.getByRole('application')).toBeVisible();

  await page.getByRole('button', { name: 'Images', exact: true }).click();
  const imagesDialog = page.getByRole('dialog');
  await expect(imagesDialog).toBeVisible();
  await expect(imagesDialog.getByRole('heading', { name: /Images \(\d+\)/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(imagesDialog).toBeHidden();

  await page.getByRole('button', { name: 'Inspector' }).click();
  const inspectorDialog = page.getByRole('dialog');
  await expect(inspectorDialog.getByRole('tab', { name: 'Auto Label' })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
