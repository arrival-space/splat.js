// Shared page-side helpers for the E2E specs.
//
// The suite judges by NUMBERS, not DOM: the app's UI can look perfectly
// healthy while the model trains against empty targets (the 2026-08-31
// fFeat bug faded resumed models to transparency behind a normal-looking
// dock). Everything here reads real state — window.__splat, GPU readbacks,
// the IndexedDB runs store.

/** Put the 12-photo synthetic capture into the device capture store, then
 *  reload so the wall shows its tile. `query` keeps ?iters etc. */
export async function seedCapture(page, query = '') {
  await page.goto(`/app/${query}`);
  const n = await page.evaluate(async () => {
    const files = [];
    for (let i = 0; i < 12; i++) {
      const name = `synthetic_${String(i).padStart(2, '0')}.png`;
      const r = await fetch(`/data/synthetic/${name}`);
      if (!r.ok) throw new Error(`fetch ${name}: ${r.status}`);
      files.push({ name, blob: await r.blob() });
    }
    const store = await import('/app/js/store.js');
    await store.saveLastCapture({ kind: 'photos', created: Date.now(), files });
    return files.length;
  });
  if (n !== 12) throw new Error(`seeded ${n} photos, expected 12`);
  await page.reload();
}

/** Click the capture tile on the wall and press Start training. */
export async function startCaptureRun(page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.galtile')].some((t) => t.textContent.includes('12 photos')));
  await page.evaluate(() =>
    [...document.querySelectorAll('.galtile')].find((t) => t.textContent.includes('12 photos')).click());
  await page.waitForFunction(() => {
    const b = document.getElementById('btn-go');
    return b && !b.disabled && window.__splat && window.__splat.state === 'ready';
  });
  await page.evaluate(() => document.getElementById('btn-go').click());
}

/** Toggle the dock's play/pause button and wait for the trainer to obey. */
export async function togglePlay(page, wantTraining) {
  await page.evaluate(() => document.getElementById('t-play').click());
  await page.waitForFunction((w) =>
    window.__splat.session && window.__splat.session.training === w, wantTraining);
}

/** The runs library, blobs reduced to sizes. */
export function runsStore(page) {
  return page.evaluate(async () => {
    const d = await new Promise((res, rej) => {
      const r = indexedDB.open('splatjs', 2);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = await new Promise((res) => {
      const q = d.transaction('runs', 'readonly').objectStore('runs').getAll();
      q.onsuccess = () => res(q.result);
    });
    d.close();
    return all.map((r) => ({
      id: r.id, name: r.name, status: r.status, iter: r.iter,
      maxIters: r.maxIters, cap: r.cap || 0,
      stateBytes: r.state ? r.state.size : 0,
      sogBytes: r.sog ? r.sog.size : 0,
      hasRecon: !!r.recon,
    }));
  });
}

/** Aggregate statistics over the trainer's raw parameters — the honest
 *  "is the model intact" signal (opacity mean collapsing to ~0 is how the
 *  empty-target bug showed up). */
export function paramStats(page) {
  return page.evaluate(async () => {
    const { data, n, shK, dc } = await window.__splat.session.exportRawState();
    const sig = (x) => 1 / (1 + Math.exp(-x));
    let oSum = 0, sSum = 0, pMax = 0, pAlive = 0, bad = 0;
    for (let i = 0; i < n; i++) {
      const b = i * 16;
      const o = sig(data[b + 13]);
      oSum += o;
      sSum += (data[b + 3] + data[b + 4] + data[b + 5]) / 3;
      const pm = Math.max(Math.abs(data[b]), Math.abs(data[b + 1]), Math.abs(data[b + 2]));
      pMax = Math.max(pMax, pm);
      // faint splats random-walk under the MCMC Langevin noise (by design —
      // relocation picks the dead ones up; the gate is soft, so big splats
      // up to opacity ~0.1 still get unit-sized kicks): the all-splat
      // maximum is noise. The SOLID population is what must survive a
      // resume in place.
      if (o > 0.2) pAlive = Math.max(pAlive, pm);
      for (let k = 0; k < 16; k++) if (!Number.isFinite(data[b + k])) bad++;
    }
    return {
      n, shK, dc,
      iter: window.__splat.session.trainer.iter,
      oMean: oSum / n,
      logScaleMean: sSum / n,
      posAbsMax: pMax,
      posAliveMax: pAlive,
      // the trainer's scene radius scales position lr, min/max scale and the
      // noise — a resume must rebuild with the ORIGINAL one
      radius: window.__splat.session.model.radius,
      nonFinite: bad,
    };
  });
}

/** Validity of the decoded (possibly undistorted) training frames — all-NaN
 *  rgb here is exactly the fFeat regression this suite exists to catch. */
export function frameStats(page) {
  return page.evaluate(() => {
    const ses = window.__splat.session;
    const f = ses.frames[0];
    let sum = 0, nan = 0;
    const L = Math.min(f.rgb.length, 300000);
    for (let i = 0; i < L; i++) {
      const v = f.rgb[i];
      if (Number.isNaN(v)) nan++; else sum += v;
    }
    return {
      rgbMean: sum / (L - nan || 1),
      nanFrac: nan / L,
      k1: ses.recon.k1,
      fFeat: ses.recon.fFeat ?? null,
    };
  });
}
