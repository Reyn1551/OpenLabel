import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:4173/');
await page.getByRole('button', { name: 'Load demo dataset' }).first().click();
await page.waitForURL(/\/projects\/[^/]+\/annotate$/, { timeout: 90000 });
const canvas = page.getByRole('application');
await canvas.waitFor({ timeout: 30000 });
await page.waitForTimeout(1000);

const rect = await canvas.boundingBox();
const sx1 = rect.x + 420, sy1 = rect.y + 260;
await page.keyboard.press('b');
await page.mouse.move(sx1, sy1);
await page.mouse.down();
await page.mouse.move(sx1 + 200, sy1 + 160, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(500);
await page.getByRole('button', { name: 'Select and edit' }).click();
await page.mouse.click(sx1 + 100, sy1 + 80);
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/shot-selected.png' });

// Wiggle pointer over the SE corner then drag.
await page.mouse.move(sx1 + 200, sy1 + 160);
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/shot-hover.png' });
await page.mouse.down();
await page.mouse.move(sx1 + 290, sy1 + 230, { steps: 14 });
await page.mouse.up();
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/shot-after.png' });
const rows = await page.evaluate(async () => {
  const pid = location.pathname.split('/')[2];
  const req = indexedDB.open('openlabel');
  const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
  const tx = db.transaction('annotations', 'readonly');
  const all = await new Promise((r) => { const q = tx.objectStore('annotations').index('by-project').getAll(pid); q.onsuccess = () => r(q.result); });
  db.close();
  return all.filter((a) => a.geometry.kind === 'bbox').map((a) => `${Math.round(a.geometry.x)},${Math.round(a.geometry.y)} ${Math.round(a.geometry.width)}x${Math.round(a.geometry.height)}`);
});
console.log(rows.join('\n'));
await browser.close();
