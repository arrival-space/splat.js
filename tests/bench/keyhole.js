// keyhole.js — the few-image experiment. A saved orbit (its frames, mattes and
// solved cameras under /scratch/<dir>/) is trained from a handful of its cameras
// only, from a chosen seed, and every OTHER camera is scored inside the person's
// matte. Same photographs, same poses, so the rows compare in dB at real
// viewpoints:
//   ?dir=keyhole&train=1,12,23,34,45,56&seed=cloud&iters=3000&tag=cloud6
//   ?dir=keyhole&train=...&seed=prior_sfm.ply&iters=3000&tag=prior6   (a PLY under /scratch/<dir>/)
//   ?dir=keyhole&seed=model:avatar_full65.ply&tag=full65               (no training: score a finished model)
// Options: &shots=5,30,50 renders those cameras to PNG; &protect=N keeps a
// PLY seed's rows from relocation for N iterations; &freeze=1 pins their
// positions; &shdeg=0; &maxsplats=; &trainmax=1280 (the training grid; must
// reproduce the recon's tw/th).
// Posts /scratch/keyhole_<tag>.json (+ _<cam>.png shots), then _done.json.
// &avatar=1 runs the app's avatar stages on the trained session afterwards
// (landmarks, face pass, cut, body fit, bind, publish) — the publish step draws
// "Use as my avatar" and needs the user's click and sign-in, so run it headed.
import { createSession } from '/src/index.js';
import { decodeFrames } from '/src/io/frames.js';
import { parsePlyGaussians, parseState } from '/app/js/session_io.js';
import { handleOAuthCallback } from '/app/js/arrival.js';
if (handleOAuthCallback()) throw new Error('oauth popup: done');   // the sign-in popup lands on this page with ?code=
const Q = new URLSearchParams(location.search);
const DIR = Q.get('dir') || 'keyhole';
const TAG = Q.get('tag') || 'run';
const post = (name, body) => fetch(`/scratch/${name}`, { method: 'POST', body });
const logEl = document.getElementById('log');
const say = (m) => { logEl.textContent += m + '\n'; console.log('[KEYHOLE]', m); };
const t0 = Date.now();
const min = () => +((Date.now() - t0) / 60000).toFixed(2);
try {
  const recon = await (await fetch(`/scratch/${DIR}/recon.json`)).json();
  const blob = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.blob(); };
  const files = [];
  let masks = 0;
  for (const f of recon.frames) {
    const source = await blob(`/scratch/${DIR}/frames/${f.name}`);
    let mask = null;
    if (Q.get('masks') !== '0') { try { mask = await blob(`/scratch/${DIR}/masks/${f.name.replace(/\.[^.]+$/, '')}.png`); masks++; } catch {} }
    files.push({ name: f.name, source, ...(mask ? { mask } : {}) });
  }
  say(`${files.length} frames, ${masks} mattes, ${recon.cams.length} cameras`);
  const frames = await decodeFrames(files, { trainMaxDim: +(Q.get('trainmax') || 1280), log: say, exif: false });
  frames.forEach((fr, i) => {
    const r = recon.frames[i];
    if (fr.fw !== r.fw || fr.fh !== r.fh || fr.tw !== r.tw || fr.th !== r.th) say(`WARNING frame ${i}: ${fr.fw}x${fr.fh} / ${fr.tw}x${fr.th} but the recon has ${r.fw}x${r.fh} / ${r.tw}x${r.th}`);
  });
  // &test=5,10,...: a fixed test set no row ever trains on — the rows are then
  // comparable whatever they trained on. Without &train the loss runs on every
  // camera outside the test set (the full-orbit ceiling).
  const test = new Set((Q.get('test') || '').split(',').filter(Boolean).map(Number));
  const train = new Set((Q.get('train') || '').split(',').filter(Boolean).map(Number));
  if (!train.size && test.size) for (let i = 0; i < recon.cams.length; i++) if (!test.has(i)) train.add(i);
  for (const i of test) if (train.has(i)) throw new Error(`camera ${i} is in both the training and the test set`);
  const seedSpec = Q.get('seed') || 'cloud';
  const evalOnly = seedSpec.startsWith('model:');
  const ITERS = evalOnly ? 0 : +(Q.get('iters') || 3000);
  // &room=1: the shipped avatar recipe's framing — the person trains as part of
  // the ROOM (maskTraining false: the mattes stay on the frames for the hull and
  // the cut, the targets carry full alpha). The in-trainer PSNR is then
  // full-frame; score inside the matte with tests/bench/masked_psnr.py instead.
  const ROOM = Q.get('room') === '1';
  const ses = createSession({
    holdout: -1, evalSplit: 0, maxIters: Math.max(1, ITERS),
    ...(ROOM ? { maskTraining: false } : {}),
    ...(train.size ? { lossCams: (cam, i) => train.has(i) } : {}),
    trainer: {
      shDeg: +(Q.get('shdeg') ?? 0),
      // &lock=1: the seed's geometry is final — no position/scale/rotation
      // updates, no growth, no relocation; colour and opacity train
      ...(Q.get('lock') === '1' ? { lockGeom: true, growUntil: 0, relocUntil: 0 } : {}),
      // &geomlr=0.1: geometry learns at a tenth of the rate; &nogrow=1: no growth, no relocation
      ...(Q.get('geomlr') != null ? { geomLrScale: +Q.get('geomlr') } : {}),
      // the shipped avatar recipe's regularisers: &needle=0.03 (anisotropy) and
      // &opareg=0.004 (opacity pressure until half the run) — without them the
      // face grows needle splats that PlayCanvas draws as streaks (2026-09-21)
      ...(Q.get('needle') ? { needleReg: +Q.get('needle') } : {}),
      ...(Q.get('opareg') ? { opacityReg: +Q.get('opareg'), opaRegUntil: 0.5 } : {}),
      ...(Q.get('nogrow') === '1' ? { growUntil: 0, relocUntil: 0 } : {}),
      ...(Q.get('maxsplats') ? { maxSplats: +Q.get('maxsplats') } : {}),
      ...(Q.get('capmult') ? { capMult: +Q.get('capmult') } : {}),
    },
  });
  ses.on('log', (m) => say('  ' + m));
  let lastMetric = 0;
  ses.on('metrics', (e) => { if (Date.now() - lastMetric > 10000) { lastMetric = Date.now(); say(`  metrics: iter ${e.iter}, ${e.splats} splats, ${e.itersPerSec != null ? e.itersPerSec.toFixed(1) : '?'} it/s, train ${e.psnrTrain != null ? e.psnrTrain.toFixed(2) : '?'} dB`); } });
  const pts = [];
  if (recon.cloud && recon.cloud.xyz) {
    const xyz = recon.cloud.xyz, rgb = recon.cloud.rgb || [];
    for (let i = 0; i * 3 < xyz.length; i++) {
      pts.push({ X: [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]],
        rgb: [rgb.length ? rgb[i * 3] / 255 : 0.5, rgb.length ? rgb[i * 3 + 1] / 255 : 0.5, rgb.length ? rgb[i * 3 + 2] / 255 : 0.5] });
    }
  }
  ses.useReconstruction({ cams: recon.cams, points: pts, k1: recon.k1 || 0, k2: recon.k2 || 0, sceneRadius: recon.sceneRadius, ...(recon.fFeat ? { fFeat: recon.fFeat } : {}) });
  ses.useFrames(frames);
  let seedNote = seedSpec;
  if (seedSpec === 'cloud' && !Q.get('append')) {
    await ses.seed({});
  } else if (seedSpec === 'cloud' && Q.get('append')) {
    // &seed=cloud&append=<ply>: the room from the SfM cloud, the person from a
    // ready-made body — the PLY's rows are APPENDED to the cloud seed (the
    // app's face-seed mechanism), colours converted from SH-DC to the seed's
    // sigmoid logits; &protect=N keeps them from relocation for N iterations
    const ply = Q.get('append');
    const bytes = new Uint8Array(await (await fetch(`/scratch/${DIR}/${ply}`)).arrayBuffer());
    const g = parsePlyGaussians(bytes);
    const data = new Float32Array(g.data);
    const C0 = 0.28209479177387814, logit = (p) => Math.log(p / (1 - p));
    for (let i = 0; i < g.n; i++) for (let k = 10; k < 13; k++) {
      const c = g.dc === 'sh' ? 0.5 + C0 * data[i * 16 + k] : data[i * 16 + k];
      data[i * 16 + k] = logit(Math.min(0.98, Math.max(0.02, c)));
    }
    await ses.seed({ appendGaussians: { data, n: g.n, note: ply, ...(Q.get('protect') ? { protectIters: +Q.get('protect') } : {}) } });
    seedNote = `cloud + ${ply} (${g.n} rows appended)`;
  } else {
    // a PLY (external viewers' export) or a state.bin (the trainer's raw rows,
    // e.g. the saved full-scene session: the ceiling row in the recon's own frame)
    const ply = evalOnly ? seedSpec.slice(6) : seedSpec;
    const bytes = new Uint8Array(await (await fetch(`/scratch/${DIR}/${ply}`)).arrayBuffer());
    const g = /\.bin$/.test(ply) ? parseState(bytes).gaussians : parsePlyGaussians(bytes);
    seedNote = `${ply} (${g.n} splats, shK ${g.shK})`;
    await ses.seedFrom(g, { sceneRadius: recon.sceneRadius, unbake: Q.get('unbake') === '1',
      trainer: { ...(evalOnly ? { maxSplats: g.n, capMult: 1 } : {}) } });
    // &protect=N / &freeze=1 cover every seed row; &protectfrom=K / &freezefrom=K
    // cover rows K..n only (a seed sorted seen-first by prior_cover.py: the
    // photographs train what they see, the prior keeps the rest)
    const from = +(Q.get('protectfrom') ?? Q.get('freezefrom') ?? 0);
    if (Q.get('protect')) ses.trainer.protect = { from, to: g.n, until: +Q.get('protect') };
    if (Q.get('freeze') === '1' || Q.get('freezefrom')) ses.trainer.setFreezePos(from, g.n);
    if (from) say(`rows ${from}..${g.n} are the unseen part of the seed (${g.n - from} splats)`);
  }
  say(`seeded from ${seedNote}: ${ses.trainer.n} splats; loss on ${train.size || 'all'} cameras; ${min()} min`);
  say(`trainer excludes ${ses.trainer.excluded.size} cameras (blur or not in the training set)`);

  if (ITERS > 0) {
    const done = new Promise((res) => ses.on('event', (e) => { if (e.kind === 'train-complete') res(); }));
    const beat = setInterval(() => { const lh = ses.lossHistory[ses.lossHistory.length - 1]; say(`train ${ses.trainer.iter} it, ${ses.trainer.n} splats, train psnr ${lh ? lh[1].toFixed(2) : '?'}, ${min()} min`); }, 30000);
    ses.start();
    await done;
    clearInterval(beat);
    ses.pause();
    say(`trained ${ses.trainer.iter} iterations in ${min()} min, ${ses.trainer.n} splats`);
  }

  // the score: every camera, inside the matte, held-out and training reported apart
  const per = [];
  for (let i = 0; i < recon.cams.length; i++) {
    const p = await ses.trainer.evalCamPsnr(i);
    per.push({ cam: i, name: recon.frames[recon.cams[i].imgIdx].name, train: train.has(i), psnr: +p.toFixed(3) });
  }
  const mean = (a) => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) : null;
  per.forEach((x) => { x.test = test.size ? test.has(x.cam) : !x.train; });
  const held = per.filter((x) => x.test && Number.isFinite(x.psnr)).map((x) => x.psnr);
  const tr = per.filter((x) => x.train && Number.isFinite(x.psnr)).map((x) => x.psnr);
  const sorted = [...held].sort((a, b) => a - b);
  const out = {
    tag: TAG, dir: DIR, seed: seedNote, iters: ses.trainer.iter, splats: ses.trainer.n,
    train: [...train], test: [...test], nHeld: held.length, psnrHeld: mean(held), psnrHeldMedian: sorted.length ? sorted[sorted.length >> 1] : null,
    psnrHeldMin: sorted[0] ?? null, psnrTrain: mean(tr), minutes: min(), per,
  };
  say(`HELD-OUT ${out.psnrHeld} dB over ${held.length} cams (median ${out.psnrHeldMedian}, min ${out.psnrHeldMin}); training cams ${out.psnrTrain} dB`);
  await post(`keyhole_${TAG}.json`, JSON.stringify(out, null, 1));

  // pictures: chosen cameras rendered at the feature width, the photo's own pose
  if (Q.get('shots')) {
    const cv = document.getElementById('cv');
    const W = +(Q.get('w') || 540);
    for (const vi of Q.get('shots').split(',').map(Number)) {
      const c = recon.cams[vi]; const fr = recon.frames[c.imgIdx];
      const s = W / fr.fw; const H = Math.round(fr.fh * s);
      cv.width = W; cv.height = H;
      ses.view.attach(cv);
      ses.view.setCamera({ R: c.R, t: c.t, f: c.f * s, fy: (c.fy ?? c.f) * s, cx: (c.cx ?? fr.fw / 2) * s, cy: (c.cy ?? fr.fh / 2) * s, w: W, h: H });
      ses.view.renderNow();
      await new Promise((r) => requestAnimationFrame(r));
      ses.view.renderNow();
      const png = await new Promise((r) => cv.toBlob(r, 'image/png'));
      await post(`keyhole_${TAG}_${String(vi).padStart(3, '0')}.png`, png);
    }
  }
  // &avatar=1: the app's own stages on this session — the rig fit, the binding
  // and the account, exactly as the app runs them after training
  if (Q.get('avatar') === '1') {
    const { afterTraining } = await import('/app/avatar/runner.js');
    const { newManifest, setStage } = await import('/app/avatar/manifest.js');
    const manifest = newManifest({ video: Q.get('name') || 'tom_avatar', picks: files.length });
    const cov = frames.reduce((a, f) => a + (1 - (f.emptyFrac || 0)), 0) / frames.length;
    setStage(manifest, 'matte', { status: 'done', coverage: cov, note: `${masks} mattes (SAM2)` });
    let cur = ses;
    const cv = document.getElementById('cv');
    const stage = document.getElementById('stage'), dock = document.getElementById('dock');
    const thumb = async () => {
      const vi = +(Q.get('thumbcam') || 5);
      const c = recon.cams[vi]; const fr = recon.frames[c.imgIdx];
      const W = 540, s = W / fr.fw, H = Math.round(fr.fh * s);
      cv.width = W; cv.height = H;
      cur.view.attach(cv);
      cur.view.setCamera({ R: c.R, t: c.t, f: c.f * s, fy: (c.fy ?? c.f) * s, cx: (c.cx ?? fr.fw / 2) * s, cy: (c.cy ?? fr.fh / 2) * s, w: W, h: H });
      cur.view.renderNow(); await new Promise((r) => requestAnimationFrame(r)); cur.view.renderNow();
      return new Promise((r) => cv.toBlob(r, 'image/png'));
    };
    // &savepkg=1: no publish step — the bound package (ply, binding, fit, rig
    // glb, thumbnail) is posted to /scratch for an upload from elsewhere
    const savepkg = Q.get('savepkg') === '1';
    if (savepkg) setStage(manifest, 'publish', { status: 'skipped', note: 'package saved' });
    // &nocut=1: the model is already the person alone (a GenAI body, a masked
    // run) — the hull cut is built for a person in a room and, on a body made
    // of thin transparent layers, it strips the face's outer layer and the top
    // of the hair (avatar 5816, 2026-09-22)
    if (Q.get('nocut') === '1') setStage(manifest, 'cut', { status: 'skipped', note: 'already isolated' });
    say('avatar stages: landmarks → face → cut → body fit → bind → ' + (savepkg ? 'save' : 'publish'));
    const ctx = {
      session: ses, frames: files, manifest, capture: null,
      log: (m) => say('  ' + m), flash: (m) => say('! ' + m),
      mount: (n) => stage.appendChild(n),
      mountDock: (el) => { dock.innerHTML = ''; dock.appendChild(el); },
      onSession: (s2) => { cur = s2; },
      thumb, persist: () => {},
    };
    await afterTraining(ctx);
    if (savepkg && ctx.plyBlob && ctx.bindingBytes && ctx.fitJson && ctx.rigGlb) {
      // one zip (the dev server's POST takes json/png/ply/zip, not bin/glb)
      const name = Q.get('name') || 'avatar';
      const { zipStore } = await import('/app/js/zip.js');
      let t = null; try { t = await thumb(); } catch (e) { say('thumb: ' + e.message); }
      const zfiles = [
        { name: `${name}.ply`, data: new Uint8Array(await ctx.plyBlob.arrayBuffer()) },
        { name: `${name}_binding.bin`, data: ctx.bindingBytes },
        { name: `${name}_fit.json`, data: new TextEncoder().encode(JSON.stringify(ctx.fitJson, null, 1)) },
        { name: 'rig.glb', data: new Uint8Array(ctx.rigGlb) },
      ];
      if (t) zfiles.push({ name: 'thumb.png', data: new Uint8Array(await t.arrayBuffer()) });
      await post(`${name}_avatar.zip`, zipStore(zfiles));
      // the cut avatar as the client streams it, plus a viewer recon: a ?model=&recon= link for inspection
      try {
        const { plyToSog } = await import('/app/js/sog.js');
        const sog = await plyToSog(new Uint8Array(await ctx.plyBlob.arrayBuffer()), {});
        await post(`${name}_cut.sog`, sog);
        await post(`${name}_cut_recon.json`, JSON.stringify({ ...recon, name, iter: cur.trainer.iter, splats: cur.trainer.n, shK: cur.trainer.shK, cloud: undefined }));
        say(`cut avatar sog ${(sog.size / 1e6).toFixed(2)} MB + recon`);
      } catch (e) { say('cut sog: ' + e.message); }
      say(`package saved: ${name}.ply ${(ctx.plyBlob.size / 1e6).toFixed(1)} MB, binding ${(ctx.bindingBytes.byteLength / 1e6).toFixed(2)} MB, rig ${(ctx.rigGlb.byteLength / 1e6).toFixed(2)} MB`);
    } else if (savepkg) say('package NOT saved: ' + JSON.stringify({ ply: !!ctx.plyBlob, bin: !!ctx.bindingBytes, fit: !!ctx.fitJson, glb: !!ctx.rigGlb }));
    const st = Object.fromEntries(Object.entries(manifest.stages).map(([k, v]) => [k, `${v.status}${v.note ? ' · ' + v.note : ''}`]));
    say('avatar stages: ' + JSON.stringify(st));
    await post(`keyhole_${TAG}_avatar.json`, JSON.stringify({ stages: manifest.stages }, null, 1));
  }

  // &export=1: the trained model as a PLY (external viewers' export) next to the row
  if (Q.get('export') === '1') {
    const blob = await ses.exportPlyBlob();
    await post(`keyhole_${TAG}.ply`, blob);
    say(`exported keyhole_${TAG}.ply (${(blob.size / 1e6).toFixed(1)} MB)`);
    // &sog=1: the compressed model + a viewer recon next to it (what ?model=&recon= opens)
    if (Q.get('sog') === '1') {
      const { plyToSog } = await import('/app/js/sog.js');
      const sog = await plyToSog(new Uint8Array(await blob.arrayBuffer()), {});
      await post(`keyhole_${TAG}.sog`, sog);
      const rj = { ...recon, name: TAG, iter: ses.trainer.iter, splats: ses.trainer.n, shK: ses.trainer.shK, cloud: undefined,
        stats: { ...(recon.stats || {}), psnrTest: { psnr: out.psnrHeld, n: held.length }, keyhole: { seed: seedNote, train: [...train], test: [...test] } } };
      await post(`keyhole_${TAG}_recon.json`, JSON.stringify(rj));
      say(`sog ${(sog.size / 1e6).toFixed(2)} MB + recon`);
    }
  }
  await post(`keyhole_${TAG}_done.json`, JSON.stringify({ ok: true, psnrHeld: out.psnrHeld }));
  say('DONE');
} catch (e) {
  console.error(e);
  say('ERROR ' + (e.stack || e.message));
  await post(`keyhole_${TAG}_done.json`, JSON.stringify({ error: e.message }));
}
