// Benchmark matrix runner: one (dataset, cycle-budget) cell per page load.
// Release-default trainer (MCMC set + auto splat budget = cycles x 35,
// capMult 8, shDeg 3, refineEvery 500), eval8 held-out PSNR, train-only
// timing. ?set=truck&iters=20000 — posts bench_<set>_<iters>.json.
// The bar pano cell rebuilds the split rig-aware (hold every 8th PANO's six
// faces, score the four yaw faces — the stock face split leaks centers).
import { createSession } from '/src/index.js';

const Q = new URLSearchParams(location.search);
const SET = Q.get('set');
const ITERS = +(Q.get('iters') || 20000);
const TAG = `${SET}_${ITERS}` + (Q.has('classic') ? '_classic' : '');
const t0 = Date.now();
const logEl = document.getElementById('log');
const post = (name, body) => fetch(`/scratch/${name}`, { method: 'POST', body });
const St = { set: SET, iters: ITERS, phase: 'boot', t0 };
const say = async (phase, extra = {}) => {
  Object.assign(St, { phase, ...extra, ts: Date.now(), min: +((Date.now() - t0) / 60000).toFixed(1) });
  console.log('[BENCH]', SET, ITERS, phase, JSON.stringify(extra));
  logEl.textContent += `\n${phase} ${JSON.stringify(extra)}`;
  try { await post(`bench_${TAG}_status.json`, JSON.stringify(St)); } catch {}
};

const SETS = {
  // 12 views: eval8 starves training (10 views) — score the classic single
  // mid-sequence holdout instead, like every historical synthetic number
  synthetic: { dir: 'synthetic', holdout1: true, names: () => Array.from({ length: 12 }, (_, i) => `synthetic_${String(i).padStart(2, '0')}.png`) },
  truck:     { dir: 'truck', res: 979, names: () => Array.from({ length: 251 }, (_, i) => `${String(i + 1).padStart(6, '0')}.jpg`) },
  camping:   { dir: 'camping', names: () => Array.from({ length: 113 }, (_, i) => `frame_${String(i + 1).padStart(5, '0')}.jpg`) },
  train:     { dir: 'train', names: () => Array.from({ length: 301 }, (_, i) => `${String(i + 1).padStart(5, '0')}.jpg`) },
  playroom:  { dir: 'playroom', list: true },
  bicycle:   { dir: 'bicycle', list: true },
  garden:    { dir: 'garden', list: true },
  bar360:    { dir: 'bar360/images', res: 912, pano: true, names: () => {
    const n = [];
    for (let i = 0; i <= 150; i += 2) n.push(`0_${String(i).padStart(4, '0')}.jpg`);
    for (let i = 0; i <= 50; i += 2) n.push(`1_${String(i).padStart(4, '0')}.jpg`);
    return n;
  } },
};

try {
  const cfg = SETS[SET];
  if (!cfg) throw new Error(`unknown set ${SET}`);
  let names;
  if (cfg.list) names = await (await fetch(`/data/${cfg.dir}/files.json`)).json();
  else names = cfg.names();
  await say('fetch', { files: names.length });
  const files = [];
  for (const n of names) {
    const r = await fetch(`/data/${cfg.dir}/${n}`);
    if (!r.ok) throw new Error(`missing ${n}`);
    files.push(new File([await r.blob()], n));
  }

  const ses = window.__ses = createSession({
    maxIters: ITERS,
    evalSplit: cfg.holdout1 ? 0 : 8,
    ...(cfg.holdout1 ? { holdout: 'auto' } : {}),
    // benchmark mode pins resolution like ?eval (adaptive budget otherwise
    // shrinks big sets and PSNR at reduced res is not comparable run-to-run)
    frames: { trainMaxDim: cfg.res || 1600 },
    // ?classic=1: pre-MCMC defaults (A/B for small-set anomalies)
    ...(Q.has('classic') ? {} : { refineEvery: 500 }),
    trainer: Q.has('classic')
      ? { maxSplats: Math.min(600000, Math.round(ITERS * 15)), capMult: 8, shDeg: 3 }
      : {
        maxSplats: Math.min(2000000, Math.round(ITERS * 35)), capMult: 8, shDeg: 3,
        growRate: 0.05, mcmcNoise: true, scaleReg: 0.01, moveCap: 0.25, shLr: 3e-4,
      },
  });
  ses.on('log', (m) => console.log('[SES]', m));
  let beat = 0;
  ses.on('stage', (e) => { if (Date.now() - beat > 30000) { beat = Date.now(); say('solve-' + e.stage, { done: e.done, total: e.total }); } });
  await ses.load(files);
  await say('decoded', { frames: ses.frames.length });

  const solveT = Date.now();
  const recon = await ses.solve();
  const solveMin = +((Date.now() - solveT) / 60000).toFixed(1);
  await say('solved', { cams: recon.cams.length, of: ses.frames.length, rms: recon.rmsBA && +recon.rmsBA.toFixed(2), solveMin });

  await ses.seed();
  if (cfg.pano) {
    // rig-aware split (see omni_run.js): all six faces of every 8th pano
    // held out, only the four yaw faces scored
    for (const i of ses.testCams) ses.trainer.excluded.delete(i);
    ses.testCams = [];
    ses.trainer.camMeta.forEach((m, i) => {
      const pano = Math.floor(m.imgIdx / 6), face = m.imgIdx % 6;
      if (pano % 8 === 0) {
        ses.trainer.excluded.add(i);
        if (face < 4) ses.testCams.push(i);
      }
    });
    ses.holdout = ses.testCams[ses.testCams.length >> 1];
    ses.trainer.holdout = ses.holdout;
  }
  await say('seeded', { splats: ses.trainer.n });

  const trainT = Date.now();
  const done = new Promise((res) => ses.on('event', (e) => { if (e.kind === 'train-complete') res(); }));
  const guard = setInterval(() => {
    const lh = ses.lossHistory[ses.lossHistory.length - 1];
    say('train', { iter: ses.trainer.iter, splats: ses.trainer.n, psnr: lh ? +lh[1].toFixed(2) : null });
  }, 60000);
  ses.start();
  await done;
  clearInterval(guard);
  const trainMin = +((Date.now() - trainT) / 60000).toFixed(1);

  let psnrTest = null, heldOut = 0;
  if (cfg.holdout1) {
    psnrTest = +(await ses.trainer.evalCamPsnr(ses.holdout)).toFixed(3);
    heldOut = 1;
  } else {
    const test = await ses.evalTestPsnr();
    psnrTest = test ? +test.psnr.toFixed(3) : null;
    heldOut = test ? test.frames.length : 0;
  }
  const result = {
    set: SET, iters: ITERS,
    psnrTest,
    heldOut,
    protocol: cfg.holdout1 ? 'holdout1' : 'eval8',
    trainMin, solveMin,
    splats: ses.trainer.n,
    cams: recon.cams.length, of: ses.frames.length,
    rms: recon.rmsBA && +recon.rmsBA.toFixed(3),
    res: cfg.res || 1600, ts: new Date().toISOString(),
  };
  await post(`bench_${TAG}_result.json`, JSON.stringify(result));
  await say('DONE', result);
} catch (e) {
  console.error(e);
  await say('ERROR', { message: String((e && e.message) || e) });
}
