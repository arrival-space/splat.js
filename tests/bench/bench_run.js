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
const TAG = `${SET}_${ITERS}` + (Q.has('classic') ? '_classic' : '')
  + (Q.get('dilate') ? `_dil${Q.get('dilate')}` : '')
  + (Q.get('aniso') != null ? `_ar${Q.get('aniso')}` : '')
  + (Q.get('ssim') ? `_ssim${Q.get('ssim')}` : '')
  + (Q.get('maxsplats') ? `_cap${Q.get('maxsplats')}` : '') + (Q.get('capmult') ? `_cm${Q.get('capmult')}` : '')
  + (Q.get('entriescap') ? `_ec${Q.get('entriescap')}` : '')
  + (Q.get('minscale') ? `_ms${Q.get('minscale')}` : '')
  + (Q.get('comp') != null ? `_c${Q.get('comp')}` : '')
  + (Q.get('regvis') ? '_rv' : '') + (Q.get('opafloor') ? `_of${Q.get('opafloor')}` : '')
  + (Q.get('refv2') ? '_rv2' : '') + (Q.get('errdon') ? '_ed' : '') + (Q.get('splitv2') ? '_sv2' : '')
  + (Q.get('growrate') ? `_gr${Q.get('growrate')}` : '') + (Q.get('movecap') ? `_mc${Q.get('movecap')}` : '')
  + (Q.get('refevery') ? `_re${Q.get('refevery')}` : '') + (Q.get('growuntil') ? `_gu${Q.get('growuntil')}` : '')
  + (Q.get('relocuntil') ? `_ru${Q.get('relocuntil')}` : '')
  + (Q.get('poslr') ? `_pl${Q.get('poslr')}` : '') + (Q.get('shramp') === '0' ? '_nsr' : '')
  + (Q.get('opareg') ? `_or${Q.get('opareg')}` : '') + (Q.get('scalereg') ? `_sr${Q.get('scalereg')}` : '')
  + (Q.get('oregref') ? `_orr${Q.get('oregref')}` : '') + (Q.get('oregrefmax') ? `_orm${Q.get('oregrefmax')}` : '')
  + (Q.get('donor') ? `_dw${Q.get('donor')}` : '')
  + (Q.get('deadthr') ? `_dt${Q.get('deadthr')}` : '') + (Q.get('poolmin') != null ? `_pm${Q.get('poolmin')}` : '')
  + (Q.get('opadecay') ? `_od${Q.get('opadecay')}` : '') + (Q.get('ratiocap') ? `_rc${Q.get('ratiocap')}` : '')
  + (Q.get('econ') ? `_e${Q.get('econ')}` : '') + (Q.get('deadtiny') ? '_dtn' : '') + (Q.get('minutes') ? `_m${Q.get('minutes')}` : '')
  + (Q.get('seed') ? `_s${Q.get('seed')}` : '');
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
    ...(Q.get('init') ? { initTarget: +Q.get('init') } : {}),
    maxIters: ITERS,
    evalSplit: cfg.holdout1 ? 0 : 8,
    ...(cfg.holdout1 ? { holdout: 'auto' } : {}),
    // benchmark mode pins resolution like ?eval (adaptive budget otherwise
    // shrinks big sets and PSNR at reduced res is not comparable run-to-run)
    frames: { trainMaxDim: cfg.res || 1600 },
    // ?classic=1: pre-MCMC defaults (A/B for small-set anomalies)
    // refine cadence is a SESSION option: the economy packages carry their
    // own (Brush 200, LichtFeld 100); ?refevery overrides either
    ...(Q.has('classic') ? {} : { refineEvery: +(Q.get('refevery') || (Q.get('econ') === 'brush' ? 200 : Q.get('econ') === 'lf' ? 100 : 500)) }),
    trainer: Q.has('classic')
      ? { maxSplats: Math.min(600000, Math.round(ITERS * 15)), capMult: 8, shDeg: 3 }
      : {
        // cap = min(seed·capMult, maxSplats): truck's 25,141-point seed × 8 × 8
        // is 1.61M, so a true 2M needs ?capmult=16 (what the app uses ≥ 1M)
        maxSplats: +(Q.get('maxsplats') || Math.min(2000000, Math.round(ITERS * 35))), capMult: +(Q.get('capmult') || 8), shDeg: 3,
        growRate: 0.05, mcmcNoise: true, scaleReg: 0.01, moveCap: 0.25, shLr: 3e-4,
        // econ=brush: the Brush economy as ONE package (its pieces never
        // transplanted one at a time): no loss-side reg, decay 0.004/200it,
        // dead below 1/255, every dead splat relocated each refine (200 it),
        // donors ∝ opacity among rendered splats. Individual knobs BELOW
        // override it (attribution cells).
        ...(Q.get('econ') === 'brush' ? { opacityReg: 0, opaDecay: 0.004, deadThr: 1 / 255, poolMin: 0,
          moveCap: 1, donorWeight: 'opavis' } : {}),
        // econ=lf: the LichtFeld MCMC economy — reg kept (0.01, mean-scaled
        // there), dead below 0.005, ALL dead relocated every 100 it, donors
        // ∝ error over the whole population, ratio cap 51, growth 5 %/refine
        ...(Q.get('econ') === 'lf' ? { deadThr: 0.005, poolMin: 0, ratioCap: 51, moveCap: 1,
          growRate: 0.05 } : {}),
        // opacity economy knobs (lab log 2026-09-02, source verdict): dead
        // threshold, donor-pool floor, Brush-style opacity decay (per 200 it)
        ...(Q.get('deadthr') ? { deadThr: +Q.get('deadthr') } : {}),
        ...(Q.get('poolmin') != null ? { poolMin: +Q.get('poolmin') } : {}),
        ...(Q.get('opadecay') ? { opaDecay: +Q.get('opadecay') } : {}),
        ...(Q.get('ratiocap') ? { ratioCap: +Q.get('ratiocap') } : {}),
        ...(Q.get('deadtiny') ? { deadTiny: true } : {}),
        ...(Q.get('maxscale') ? { maxScale: +Q.get('maxscale') } : {}),
        // per-frame (key,id) entry budget (default maxSplats*24); rung 4 probe
        ...(Q.get('entriescap') ? { entriesCap: +Q.get('entriescap') } : {}),
        ...(Q.get('dilate') ? { dilate: +Q.get('dilate') } : {}),
        ...(Q.get('aniso') != null ? { anisoReg: +Q.get('aniso') } : {}),
        ...(Q.get('minscale') ? { minScale: +Q.get('minscale') } : {}),
        ...(Q.get('seed') ? { seed: +Q.get('seed') } : {}),
        ...(Q.get('comp') != null ? { mipComp: Q.get('comp') !== '0' } : {}),
        ...(Q.get('regvis') ? { regVisOnly: true } : {}),
        ...(Q.get('opafloor') ? { opaFloor: +Q.get('opafloor') } : {}),
        // placement knobs (rung 3 of docs/plan-placement-2026-09-02.md)
        ...(Q.get('refv2') ? { refineV2: true } : {}),
        ...(Q.get('errdon') ? { errDonors: true } : {}),
        ...(Q.get('splitv2') ? { splitV2: true } : {}),
        ...(Q.get('growrate') ? { growRate: +Q.get('growrate') } : {}),
        ...(Q.get('movecap') ? { moveCap: +Q.get('movecap') } : {}),
        ...(Q.get('poslr') ? { posLrScale: +Q.get('poslr') } : {}),
        ...(Q.get('shramp') === '0' ? { shRamp: false } : {}),
        // reg weights are per-splat constants (3DGS-MCMC's are mean()-scaled,
        // i.e. 1/n) — rung 4 tests whether they must shrink with capacity
        ...(Q.get('opareg') ? { opacityReg: +Q.get('opareg') } : {}),
        ...(Q.get('scalereg') ? { scaleReg: +Q.get('scalereg') } : {}),
        // opacityReg ∝ 1/n above oregref splats (rung 4: capacity dilution)
        ...(Q.get('oregref') ? { opaRegRefN: +Q.get('oregref') } : {}),
        ...(Q.get('oregrefmax') ? { opaRegRefMax: +Q.get('oregrefmax') } : {}),
        ...(Q.get('donor') ? { donorWeight: Q.get('donor') } : {}),
        ...(Q.get('ssim') ? { ssimWeight: +Q.get('ssim') } : {}),
        ...(Q.get('v2') ? { engine: 'v2' } : {}),
        ...(Q.get('growfrac') ? { growFrac: +Q.get('growfrac') } : {}),
        ...(Q.get('growtau') ? { growTau: +Q.get('growtau') } : {}),
        ...(Q.get('growuntil') ? { growUntil: +Q.get('growuntil') } : {}),
        ...(Q.get('relocuntil') ? { relocUntil: +Q.get('relocuntil') } : {}),
      },
  });
  // refine census lines (dead / relocated / grown per call) are the only
  // record of what the population did mid-run — posted next to the result
  const refineLog = [];
  ses.on('log', (m) => { console.log('[SES]', m); if (/^refine @/.test(m)) refineLog.push(m); });
  let beat = 0;
  ses.on('stage', (e) => { if (Date.now() - beat > 30000) { beat = Date.now(); say('solve-' + e.stage, { done: e.done, total: e.total }); } });
  await ses.load(files);
  await say('decoded', { frames: ses.frames.length });

  const solveT = Date.now();
  let recon;
  if (Q.get('gtrecon')) {
    // externally supplied reconstruction (e.g. COLMAP GT parsed to our
    // format) — poses + cloud swap in, everything else identical
    recon = ses.useReconstruction(await (await fetch(Q.get('gtrecon'))).json());
    await say('gt-recon', { cams: recon.cams.length, points: recon.points.length });
  } else {
    recon = await ses.solve();
  }
  const solveMin = +((Date.now() - solveT) / 60000).toFixed(1);
  await say('solved', { cams: recon.cams.length, of: ses.frames.length, rms: recon.rmsBA && +recon.rmsBA.toFixed(2), solveMin });
  if (Q.get('postrecon')) {
    await post(Q.get('postrecon'), JSON.stringify({
      cams: recon.cams.map((c) => ({
        imgIdx: c.imgIdx, name: ses.frames[c.imgIdx].name,
        R: c.R, t: c.t, f: c.f, cx: c.cx, cy: c.cy,
      })),
      points: recon.points.map((p) => ({ X: p.X, rgb: p.rgb })),
      k1: recon.k1, k2: recon.k2,
    }));
  }

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
  // ?minutes=N: a wall-clock training budget — the run ends at N minutes
  // wherever the iteration count is (the schedule still runs on ?iters, so
  // size that to what fits: ~1 min per 1k at the 2M cap on the 5080)
  let clock = null;
  if (Q.get('minutes')) {
    clock = setInterval(() => {
      if ((Date.now() - trainT) / 60000 >= +Q.get('minutes')) { ses.opts.maxIters = ses.trainer.iter; clearInterval(clock); }
    }, 5000);
  }
  await done;
  clearInterval(guard); if (clock) clearInterval(clock);
  const trainMin = +((Date.now() - trainT) / 60000).toFixed(1);
  // dead census at the horizon (opacity < 1/255: what the export purges)
  let deadPct = null;
  {
    const { data, n } = await ses.trainer.readGaussians();
    let dead = 0;
    for (let i = 0; i < n; i++) if (data[i * 16 + 13] <= Math.log(1 / 254)) dead++;
    deadPct = +(100 * dead / n).toFixed(2);
  }

  let psnrTest = null, heldOut = 0;
  if (cfg.holdout1) {
    psnrTest = +(await ses.trainer.evalCamPsnr(ses.holdout)).toFixed(3);
    heldOut = 1;
  } else {
    const test = await ses.evalTestPsnr();
    psnrTest = test ? +test.psnr.toFixed(3) : null;
    heldOut = test ? test.frames.length : 0;
  }
  if (Q.get('postply')) {
    // dump the trained model for distribution forensics (splat_stats.mjs)
    await say('export-ply');
    const blob = await ses.exportPlyBlob();
    await post(Q.get('postply'), blob);
    await say('ply-posted', { mb: +(blob.size / 1e6).toFixed(0) });
  }
  if (Q.get('postview')) {
    // the viewer's recon JSON (what the app's Share writes): camera path,
    // frames, photo URLs at the deployment's data root, run stats — so a
    // bench export can be published as ?model=<sog>&recon=<this> like the
    // README's signature models. ?viewname= names it.
    const { buildReconJson } = await import('../../app/js/session_io.js');
    const dataRoot = `https://ugc.arrival.space/splatjs/data/${cfg.dir}/`;
    const last = (ses.lossHistory || []).at(-1);
    const S = {
      session: ses, preset: { id: SET, name: Q.get('viewname') || SET },
      loadedFiles: files.map((fl) => ({ name: fl.name, url: dataRoot + fl.name })),
      minutes: Math.round(trainMin), psnrTrain: last ? last[1] : null, psnrHold: null,
      psnrTest: (typeof test !== 'undefined' && test) ? { psnr: psnrTest, frames: test.frames } : null,
      holdHist: [],
    };
    await post(Q.get('postview'), JSON.stringify(buildReconJson(S)));
    await say('view-posted');
  }
  const result = {
    set: SET, iters: ITERS, iterDone: ses.trainer.iter,
    psnrTest,
    heldOut,
    protocol: cfg.holdout1 ? 'holdout1' : 'eval8',
    trainMin, solveMin, deadPct,
    // tiles whose (key,id) entry budget overflowed over the whole run — a
    // non-zero count means whole tiles were silently skipped in training
    overflowTiles: ses.trainer.entryOverflowTiles || 0,
    splats: ses.trainer.n,
    cams: recon.cams.length, of: ses.frames.length,
    rms: recon.rmsBA && +recon.rmsBA.toFixed(3),
    res: cfg.res || 1600, ts: new Date().toISOString(),
  };
  await post(`bench_${TAG}_result.json`, JSON.stringify(result));
  try { await post(`bench_${TAG}_refines.txt`, refineLog.join('\n')); } catch {}
  await say('DONE', result);
} catch (e) {
  console.error(e);
  await say('ERROR', { message: String((e && e.message) || e) });
}
