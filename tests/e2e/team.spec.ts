import { readFileSync } from 'node:fs';
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
test('team page seeds a project the studio never finished loading', async ({ context, page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load demo dataset' }).first().click();
  await page.waitForURL(/\/projects\/[^/]+\/annotate$/, { timeout: 90_000 });

  // Leave before the studio has painted: the session must seed from IndexedDB,
  // not from the studio store.
  const projectUrl = page.url().replace(/\/annotate$/, '');
  await page.goto(`${projectUrl}/team`);
  await expect(
    page.getByText('Unassigned').locator('..').getByText('16', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  const second = await context.newPage();
  await second.goto(`${projectUrl}/team`);
  await expect(
    second.getByText('Unassigned').locator('..').getByText('16', { exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  await second.getByRole('button', { name: /Claim next 10/ }).click();
  await expect(page.getByText(/· 10$/).first()).toBeVisible({ timeout: 20_000 });
  await second.close();
});

test('two separate devices pair with a link and share the dataset', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const alicePage = await alice.newPage();
  const bobPage = await bob.newPage();

  const studioUrl = await loadDemo(alicePage);
  const projectUrl = studioUrl.replace(/\/annotate$/, '');
  await alicePage.goto(`${projectUrl}/team`);
  await expect(alicePage.getByRole('heading', { name: 'Team' })).toBeVisible();

  // Alice creates the invite link. Nothing about it is hosted: it points at
  // localhost so it opens Bob's own `npx openlabel`.
  await alicePage.getByRole('button', { name: 'Create invite link' }).click();
  const inviteLink = await alicePage.locator('#team-offer').inputValue();
  expect(inviteLink).toContain('/join?c=');
  expect(inviteLink).toContain('127.0.0.1');

  // Bob has never seen this project: opening the link must create it locally and
  // complete the handshake without any manual code editing.
  await bobPage.goto(inviteLink);
  const replyField = bobPage.locator('#join-reply');
  await expect(replyField).toBeVisible({ timeout: 60_000 });
  const replyLink = await replyField.inputValue();
  expect(replyLink).toContain('r=1');

  await alicePage.locator('#team-answer-in').fill(replyLink);
  await alicePage.getByRole('button', { name: 'Finish connection' }).click();

  // Presence converges on the device that invited.
  await expect(alicePage.getByText('Peers online').locator('..').getByText(/[0-9a-f]{8}/)).toBeVisible({
    timeout: 60_000,
  });

  // Bob received the project, its classes and all images, not just presence.
  // In-app navigation matters: a full reload would drop the peer connection,
  // because the offer only lives in the tab that created it.
  await bobPage.getByRole('button', { name: 'Open the team page' }).click();
  await expect(bobPage.getByRole('heading', { name: 'Team' })).toBeVisible({ timeout: 60_000 });
  await expect(bobPage.getByText('Peers online').locator('..').getByText(/[0-9a-f]{8}/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    bobPage.getByText('Unassigned').locator('..').getByText('16', { exact: true }),
  ).toBeVisible({ timeout: 60_000 });

  // The image bytes really arrived: Bob's own IndexedDB now holds the blobs.
  // Checked in place because a full reload would drop the peer connection.
  const blobCount = async () =>
    bobPage.evaluate(async () => {
      const request = indexedDB.open('openlabel');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('blobs', 'readonly');
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const all = tx.objectStore('blobs').getAllKeys();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      db.close();
      return keys.length;
    });

  await expect.poll(blobCount, { timeout: 120_000 }).toBe(16);

  // The offline path: a device can write its whole replica to a file, and that
  // file is what merges on a machine that is never online at the same time.
  const downloadPromise = alicePage.waitForEvent('download');
  await alicePage.getByRole('button', { name: 'Download sync file' }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const syncFile = JSON.parse(readFileSync(path!, 'utf8')) as { projectId: string; ops: unknown[] };
  expect(syncFile.projectId).toBe(projectUrl.split('/').pop());
  expect(syncFile.ops.length).toBeGreaterThan(0);

  await alice.close();
  await bob.close();
});
