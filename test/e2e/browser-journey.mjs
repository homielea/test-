// Browser journey: intake → needs review → request changes → approve → handoff copy → business switch → checkpoint.
// Starts its own server on a temp DB. Usage: npm run e2e   (screenshots → docs/screenshots/)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../../src/server.js';

// Use the pre-installed Playwright (resolved via require; not a project dependency).
const { chromium } = createRequire(import.meta.url)('playwright');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-e2e-'));
const shots = path.resolve('docs/screenshots');
fs.mkdirSync(shots, { recursive: true });
const app = createApp({ dbFile: path.join(dir, 'lab.db'), stepDelayMs: 120, checkpointDir: path.join(dir, 'checkpoints'), env: {} });
const port = await app.listen(0);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); throw e; }
};

try {
  await page.goto(base);
  await step('dashboard loads with honest mode labels', async () => {
    await page.getByText('MOCK EXECUTION').waitFor();
    await page.getByText(/Real model: disabled/).waitFor();
    await page.getByText('Notifications: none configured').waitFor();
  });
  await page.screenshot({ path: path.join(shots, '01-dashboard.png') });

  await step('sample NATEA inquiry reaches a reviewable draft', async () => {
    await page.getByRole('button', { name: /Accommodation for 8 workers/ }).click();
    await page.locator('#reviewPanel').waitFor({ timeout: 15000 });
    await page.getByText('Waiting for your decision').waitFor();
    assert.ok(await page.locator('.facts').getByText('8 workers').first().isVisible());
  });
  await page.screenshot({ path: path.join(shots, '02-needs-review.png'), fullPage: true });

  await step('request changes creates attempt 2 with history kept', async () => {
    await page.fill('#reviewNotes', 'Make it shorter, please.');
    await page.getByRole('button', { name: 'Request changes' }).click();
    await page.getByText('Draft versions (2)').waitFor({ timeout: 15000 });
    await page.locator('#reviewPanel').getByText('draft v2').waitFor({ timeout: 15000 });
  });

  await step('approve saves v2 and creates the Maya handoff', async () => {
    await page.getByRole('button', { name: /Approve/ }).click();
    await page.getByText('Copy Markdown').waitFor({ timeout: 15000 });
    await page.getByText(/approved draft v2 saved/i).waitFor();
  });
  await page.screenshot({ path: path.join(shots, '03-completed-handoff.png'), fullPage: true });

  await step('handoff Markdown copies to clipboard', async () => {
    await page.getByRole('button', { name: 'Copy Markdown' }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(clip, /^# Maya handoff — NATEA/);
    assert.match(clip, /SAMPLE DATA/);
    assert.match(clip, /NOT SENT/);
  });

  await step('switching business hides NATEA records', async () => {
    await page.getByRole('button', { name: /^REWIRE/ }).click();
    await page.getByText('No runs in this business yet.').waitFor();
    assert.equal(await page.getByText('Accommodation for 8 workers').count(), 0);
    // Direct URL to a NATEA run under REWIRE is refused by the server.
    const natea = await (await fetch(`${base}/api/b/natea/runs`)).json();
    const r = await fetch(`${base}/api/b/rewire/runs/${natea[0].id}`);
    assert.equal(r.status, 404);
  });
  await page.screenshot({ path: path.join(shots, '04-rewire-separate.png') });

  await step('checkpoint view generates a local checkpoint with one decision', async () => {
    await page.getByRole('button', { name: /^NATEA/ }).click();
    await page.getByRole('button', { name: /International buyer/ }).click();
    await page.locator('#reviewPanel').waitFor({ timeout: 15000 });
    await page.getByRole('link', { name: /Checkpoint/ }).click();
    await page.getByRole('button', { name: 'Generate checkpoint now' }).click();
    await page.getByRole('heading', { name: 'The one decision' }).waitFor();
    await page.getByText(/nobody was notified/).waitFor();
  });
  await page.screenshot({ path: path.join(shots, '05-checkpoint.png'), fullPage: true });

  await step('narrow (phone) layout renders without horizontal scroll', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/natea`);
    await page.getByText('New request').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const offenders = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && e.offsetParent !== null)
      .slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${e.className}`));
    assert.ok(overflow <= 1, `horizontal overflow ${overflow}px: ${offenders.join(', ')}`);
  });
  await page.screenshot({ path: path.join(shots, '06-phone.png') });

  await step('no browser console errors', async () => assert.deepEqual(errors, []));
} finally {
  for (const r of results) console.log(r.join('  '));
  await browser.close();
  await app.close();
}
