/**
 * Refreshes the README screenshot set in docs/assets.
 *
 * Run the dev server first (`npm run dev`), then:
 *
 *     node scripts/readme-shots.mjs
 *
 * Every shot uses the demo dataset and the dark theme. The flows exercise the
 * real app (train, auto-label, freeze a version, pair two tabs), so a failing
 * selector means the README images are the least of the problems.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const OUT = 'docs/assets';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  deviceScaleFactor: 1,
});
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('console.error:', msg.text());
});

const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`saved ${name}.png`);
};

await page.goto(BASE);
await page.getByRole('button', { name: 'Load demo dataset' }).first().click();
await page.waitForURL(/\/projects\/[^/]+\/annotate$/, { timeout: 90_000 });
await page.getByRole('application').waitFor({ timeout: 30_000 });
const studioUrl = page.url();
const projectUrl = studioUrl.replace(/\/annotate$/, '');

// --- Studio with a trained model and pending suggestions ---
await page.getByRole('tab', { name: 'Auto Label' }).click();
await page.getByRole('button', { name: 'Train model' }).click();
await page.getByText('Held-out metrics').waitFor({ timeout: 180_000 });
const batch = page.getByRole('button', { name: /Label unlabeled images/ });
await batch.waitFor({ timeout: 30_000 });
await batch.click();
await batch.waitFor({ state: 'visible' });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Train model' }).or(page.getByRole('button', { name: 'Retrain model' })).first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(1500);

// Pick a freshly auto-labeled image so the canvas shows proposals over pixels.
const rail = page.locator('ul[aria-label="Images"] button');
const rows = await rail.count();
for (let index = 0; index < rows; index += 1) {
  const label = (await rail.nth(index).innerText()).replace(/\s+/gu, ' ').trim();
  if (/auto/u.test(label)) {
    await rail.nth(index).click();
    break;
  }
}
await page.waitForTimeout(1200);
await shot('studio-autolabel');

// --- Dataset health ---
await page.goto(`${projectUrl}/health`);
await page.getByRole('heading', { name: 'Dataset health' }).waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);
await shot('health');

// --- Versions, then the export dialog ---
await page.goto(`${projectUrl}/versions`);
await page.getByRole('button', { name: 'New version' }).first().click();
await page.getByRole('dialog').waitFor();
await page.getByRole('button', { name: 'Create' }).click();
const exportDialog = page.getByRole('dialog', { name: /Export dataset/ });
await exportDialog.waitFor({ timeout: 30_000 });
await page.waitForTimeout(800);
await shot('export');
await page.keyboard.press('Escape');

// --- Team: a second tab in the same profile claims work ---
const peer = await context.newPage();
await page.goto(`${projectUrl}/team`);
await page.getByRole('heading', { name: 'Team' }).waitFor();
await peer.goto(`${projectUrl}/team`);
await peer.getByRole('heading', { name: 'Team' }).waitFor();
await peer.getByRole('button', { name: /Claim next 10/ }).click();
await peer.getByText('Assigned to you').locator('..').getByText('10', { exact: true }).waitFor({ timeout: 20_000 });
await peer.getByRole('button', { name: 'Mark done' }).first().click();
await page.getByText('Completed').locator('..').getByText('1', { exact: true }).waitFor({ timeout: 20_000 });

// The page is taller than the studio viewport; a taller viewport keeps pairing,
// the sync file, and the work split in one frame at the same text scale.
await page.setViewportSize({ width: 1440, height: 1320 });
await page.waitForTimeout(800);
await shot('team');
await page.setViewportSize({ width: 1440, height: 900 });

// --- Run your model (deploy) ---
await page.goto(`${projectUrl}/deploy`);
await page.getByRole('heading', { name: 'Run your model' }).waitFor({ timeout: 30_000 });
const picker = page.getByRole('combobox', { name: 'Use current dataset image' });
const options = ['sample-14.png', 'sample-13.png', 'sample-12.png', 'sample-11.png', 'sample-10.png', 'sample-09.png'];
for (const option of options) {
  await picker.click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await page.getByRole('button', { name: 'Run inference' }).click();
  await page.waitForTimeout(1200);
  const empty = await page.getByText('No suggestions at this threshold.').count();
  if (empty === 0) break;
}
await page.waitForTimeout(600);
await shot('deploy');

await peer.close();

// --- Dashboard, now with progress on the card ---
await page.goto(BASE);
await page.getByRole('heading', { name: 'Your projects' }).waitFor();
await page.waitForTimeout(1200);
await shot('dashboard');

await browser.close();
