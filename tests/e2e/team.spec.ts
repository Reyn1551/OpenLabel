import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function loadDemo(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await page.getByRole('button', { name: 'Load demo dataset' }).first().click();
  await page.waitForURL(/\/projects\/[^/]+\/annotate$/, { timeout: 90_000 });
  await expect(page.getByRole('application')).toBeVisible({ timeout: 30_000 });
  return page.url();
}

test('two tabs pair and split the work', async ({ context, page }) => {
  const studioUrl = await loadDemo(page);
  const projectUrl = studioUrl.replace(/\/annotate$/, '');
  const second = await context.newPage();

  await page.goto(`${projectUrl}/team`);
  await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();

  await second.goto(`${projectUrl}/team`);
  await expect(second.getByRole('heading', { name: 'Team' })).toBeVisible();

  // The second tab claims a batch; the first tab must see that assignment even
  // though claims live only in the peer channel, never in the shared project
  // database.
  await second.getByRole('button', { name: /Claim next 10/ }).click();
  await expect(
    second.getByText('Assigned to you').locator('..').getByText('10', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await expect(page.getByText(/· 10$/).first()).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText('Assigned to you').locator('..').getByText('0', { exact: true }),
  ).toBeVisible();

  // Review state converges too.
  await second.getByRole('button', { name: 'Mark done' }).first().click();
  await expect(
    page.getByText('Completed').locator('..').getByText('1', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  await second.close();
});