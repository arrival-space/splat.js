// Full happy path on the 12-photo synthetic set: capture tile -> solve ->
// train to the horizon -> finish secures the result as a state checkpoint ->
// Compress turns it into the sog -> the finished tile reopens in the viewer.
// ?iters=2000 keeps the whole spec fast while giving the model enough cycles
// to clear the broken-pipeline PSNR band.
import { test, expect } from '@playwright/test';
import { seedCapture, startCaptureRun, runsStore } from './helpers.mjs';

test('own-photos run: solve, train, finish, compress, stored, viewable', async ({ page }) => {
  await seedCapture(page, '?iters=2000');
  await startCaptureRun(page);

  // solve + 2000 cycles; 'done' means finish() ran
  await page.waitForFunction(() => window.__splat.state === 'done', null, { timeout: 240_000 });

  const done = await page.evaluate(() => ({
    iter: window.__splat.iter,
    splats: window.__splat.splats,
    psnr: window.__splat.psnrTrain,
  }));
  expect(done.iter).toBeGreaterThanOrEqual(2000);
  expect(done.splats).toBeGreaterThan(10_000);
  // the clean synthetic set reads ~25+ dB by 2k cycles (21.7 measured at 1k);
  // broken pipelines (empty targets, garbage backend) sit near 10 or at null
  expect(done.psnr).not.toBeNull();
  expect(done.psnr).toBeGreaterThan(20);

  // finish() secures ONLY the raw state (seconds) and marks the run finished
  // — nothing heavy runs while the creator inspects the result
  await expect.poll(async () => (await runsStore(page))[0]?.status, { timeout: 60_000 })
    .toBe('finished');
  let rec = (await runsStore(page))[0];
  expect(rec.stateBytes).toBeGreaterThan(10_000);
  expect(rec.sogBytes).toBe(0);
  expect(rec.hasRecon).toBe(true);

  // the sog is on demand: the Compress button runs the one compression job,
  // stores the sog and drops the checkpoint
  await page.waitForSelector('#c-sog');
  await page.click('#c-sog');
  await expect.poll(async () => (await runsStore(page))[0]?.sogBytes, { timeout: 120_000 })
    .toBeGreaterThan(10_000);
  rec = (await runsStore(page))[0];
  expect(rec.status).toBe('finished');
  expect(rec.stateBytes).toBe(0);   // the pause checkpoint yields to the sog
  // the button is gone once the sog exists; Download .sog is instant now
  await expect.poll(() => page.locator('#c-sog').count()).toBe(0);

  // the stored result reopens in the viewer from a fresh page load
  await page.reload();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.galtile')].some((t) => t.textContent.includes('splats')));
  await page.evaluate(() =>
    [...document.querySelectorAll('.galtile')].find((t) => t.textContent.includes('splats')).click());
  await page.waitForFunction(() =>
    window.__splat.state === 'done' && window.__splat.preset &&
    window.__splat.preset.id === '__restored', null, { timeout: 60_000 });
  const view = await page.evaluate(() => ({ splats: window.__splat.splats }));
  // export purges dead splats (alpha < 1/255 — invisible in any 8-bit
  // viewer), so the stored model may be smaller than the live count, never
  // larger, and never by much on a fresh short run
  expect(view.splats).toBeLessThanOrEqual(done.splats);
  expect(view.splats).toBeGreaterThan(done.splats * 0.85);
});
