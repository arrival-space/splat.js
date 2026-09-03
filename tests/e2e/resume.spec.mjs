// The crash-safety contract: pausing checkpoints the run; a fresh page can
// pick it up bit-true and KEEP LEARNING. The second half is the part history
// says to distrust — the 2026-08-31 fFeat bug restored parameters perfectly
// and then trained the model to transparency against all-invalid targets,
// behind a healthy-looking UI. Hence the target/param/PSNR assertions.
import { test, expect } from '@playwright/test';
import {
  seedCapture, startCaptureRun, togglePlay, runsStore, paramStats, frameStats,
} from './helpers.mjs';

test('pause -> checkpoint -> reload -> resume, model intact and learning', async ({ page }) => {
  // a horizon far away so the run cannot finish under the pause click
  await seedCapture(page, '?iters=200000');
  await startCaptureRun(page);
  await page.waitForFunction(() =>
    window.__splat.state === 'train' && window.__splat.session.trainer &&
    window.__splat.session.trainer.iter >= 3000, null, { timeout: 240_000 });

  // pause -> checkpointRun('pause') persists raw state into the run record
  await togglePlay(page, false);
  await page.waitForFunction(() =>
    (window.__splat._ckptIter || 0) > 0 && !window.__splat._ckptBusy,
  null, { timeout: 60_000 });
  const pre = await paramStats(page);
  expect(pre.nonFinite).toBe(0);

  const rec = (await runsStore(page))[0];
  expect(rec.status).toBe('training');
  expect(rec.stateBytes).toBeGreaterThan(1_000_000);
  expect(rec.cap).toBeGreaterThan(0);
  expect(rec.hasRecon).toBe(true);
  expect(rec.iter).toBeGreaterThanOrEqual(3000);

  // a fresh page: the tile offers the paused run and resumes it in place
  await page.reload();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.galtile')].some((t) => t.textContent.includes('paused')));
  const tileText = await page.evaluate(() =>
    [...document.querySelectorAll('.galtile')].find((t) => t.textContent.includes('paused')).textContent);
  expect(tileText).toContain('tap to continue');
  await page.evaluate(() =>
    [...document.querySelectorAll('.galtile')].find((t) => t.textContent.includes('paused')).click());
  await page.waitForFunction(() => window.__splat.state === 'train', null, { timeout: 240_000 });

  // freeze immediately: the restored model, near-untouched
  await togglePlay(page, false);
  const post = await paramStats(page);
  const resumed = await page.evaluate(() => ({
    runId: window.__splat.runId, maxIters: window.__splat.maxIters, iter: window.__splat.iter,
  }));
  expect(resumed.runId).toBe(rec.id);          // same record, no duplicate tile
  expect(resumed.maxIters).toBe(200000);       // original horizon, not iter+half
  expect(resumed.iter).toBeGreaterThanOrEqual(rec.iter);
  expect(post.n).toBe(pre.n);                  // population survives exactly
  expect(post.dc).toBe(pre.dc);
  expect(post.nonFinite).toBe(0);
  // live splats stay put (dead ones random-walk under the Langevin noise —
  // the all-splat maximum is not a stability signal); the scene radius must
  // come back exactly (resume once fell back to 10: every radius-scaled
  // quantity was wrong, hidden while the resumed trainer lost its noise)
  expect(post.radius).toBeCloseTo(pre.radius, 3);
  expect(post.posAliveMax).toBeGreaterThan(pre.posAliveMax * 0.95);
  expect(post.posAliveMax).toBeLessThan(pre.posAliveMax * 1.05);
  // a few steps of drift are fine; the transparency collapse was 100x
  expect(post.oMean).toBeGreaterThan(pre.oMean * 0.5);
  expect(post.oMean).toBeLessThan(pre.oMean * 2);

  // the resumed session must be training against REAL targets
  const fr = await frameStats(page);
  expect(fr.nanFrac).toBe(0);
  expect(fr.rgbMean).toBeGreaterThan(0.05);
  if (Math.abs(fr.k1) >= 0.01) expect(fr.fFeat).not.toBeNull();

  // ...and actually keep learning: loss metrics come back and read sane
  await togglePlay(page, true);
  await page.waitForFunction(() =>
    window.__splat.psnrTrain != null && window.__splat.psnrTrain > 20,
  null, { timeout: 120_000 });
  const psnr = await page.evaluate(() => window.__splat.psnrTrain);
  expect(psnr).toBeGreaterThan(20);
});
