// Splat.js — the app. One screen, four states:
//
//   ready → prep → train → done      (+ Details, on demand, once done)
//
// The interaction model is the v2 mockup's, verbatim; underneath it now sits
// the real library: prep beats are the solver's own progress events, the
// model on the stage is the WebGPU trainer's render, the curve is measured
// PSNR, and Export writes a real .ply. The UI talks to ONE object — the
// splat.js Session — plus the trainer's rendered canvas.

import { createSession, gaussiansToPly, undistortFrames } from '../../src/index.js';
import { extractSharpFrames, isVideoFile } from '../../src/io/video.js';
import { recordCaptureVideo, cameraSupported } from './camera.js';
import { saveLastCapture, loadLastCapture } from './store.js';
import { zipStore } from './zip.js';
import { handleOAuthCallback, sendToArrival, hasToken } from './arrival.js';
import { buildSessionZip, fetchModel } from './session_io.js';
import { PRESETS, REPO, DATA, ownSet } from './data.js';
import { Viewport, camCentre } from './viewport.js';
import { Developer, fitRect } from './develop.js';
import { Chart } from './chart.js';
import { bmp, readyBmp } from './img.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Two front doors, one codebase: the classic view keeps the preset row
// (splat-js), the wall-first redesign leads with community creations
// (splat-js2, or ?v2 anywhere).
const WALL_FIRST = /splat-js2/.test(location.pathname)
  || new URLSearchParams(location.search).has('v2');

// short first run (phones especially) — the done screen offers "+10k cycles"
// which stretches the trainer's schedules and resumes. 20k, not 10k: with a
// 10k horizon the growth phase is squeezed against too few settle iterations
// and the model comes out over-grown for its polish time.
const INITIAL_ITERS = 20000;
const MORE_ITERS = 10000;

// ?perf runs a short instrumented benchmark (default 1000 iterations, or
// ?perf=2500) and offers the frame-loop timing log as a text file — for
// diagnosing devices at arm's length (phones, other people's machines)
const PERF_Q = new URLSearchParams(location.search).get('perf');
const PERF = { on: PERF_Q != null, iters: Math.max(200, parseInt(PERF_Q, 10) || 1000) };

// ?2x trains against a DOUBLE-resolution working buffer (the photos are only
// re-gridded, no new information): the loss then sees and suppresses the
// bright edge ringing that otherwise appears when the view renders above
// training resolution. Costs ~1.7x training time and a little native-res
// PSNR — an experiment flag, off by default.
const BUF2X = new URLSearchParams(location.search).has('2x');

// ?eval runs the standard benchmark protocol: every Nth photo (default 8,
// ?eval=4 etc.) is held out of training and scored together at the end — the
// novel-view PSNR that quality papers report. Normal visitors train on every
// photo; this flag exists for honest measurement.
const EVAL_Q = new URLSearchParams(location.search).get('eval');
const EVAL = { on: EVAL_Q != null, split: Math.max(2, parseInt(EVAL_Q, 10) || 8) };

// ?mcmc + ?iters=N: the experimental optimizer set. STICKY for the browser
// session — preset tiles are real links, so a plain query flag would be shed
// on the first click. ?mcmc=0 clears; the toast fires at boot and at train.
{
  const q = new URLSearchParams(location.search);
  if (q.get('mcmc') === '0') { sessionStorage.removeItem('splatjs_mcmc'); sessionStorage.removeItem('splatjs_iters'); }
  else if (q.has('mcmc')) sessionStorage.setItem('splatjs_mcmc', '1');
  if (q.get('iters')) sessionStorage.setItem('splatjs_iters', q.get('iters'));
}
const MCMC_ON = sessionStorage.getItem('splatjs_mcmc') === '1';
const ITERS_OVERRIDE = parseInt(sessionStorage.getItem('splatjs_iters'), 10) || 0;

// ?dilate=<px2> + ?aniso=<w>: the NEEDLE experimental set — lower the
// screen-space AA dilation floor and/or the isotropy spring so splats may
// train thin (Brush-like strokes). Sticky like ?mcmc; ?dilate=0 clears both.
// In-session view renders with the same kernels (faithful); exports/shares
// still bake and rasterize at the stock 0.3, so needles view fatter there.
{
  const q = new URLSearchParams(location.search);
  if (q.get('dilate') === '0') {
    for (const k of ['splatjs_dilate', 'splatjs_aniso', 'splatjs_minscale']) sessionStorage.removeItem(k);
  } else if (q.get('dilate')) sessionStorage.setItem('splatjs_dilate', q.get('dilate'));
  if (q.get('aniso') != null && q.get('aniso') !== '') sessionStorage.setItem('splatjs_aniso', q.get('aniso'));
  if (q.get('minscale')) sessionStorage.setItem('splatjs_minscale', q.get('minscale'));
}
const DILATE_OVR = parseFloat(sessionStorage.getItem('splatjs_dilate'));
const ANISO_OVR = sessionStorage.getItem('splatjs_aniso') == null ? NaN : parseFloat(sessionStorage.getItem('splatjs_aniso'));
const MINSCALE_OVR = parseFloat(sessionStorage.getItem('splatjs_minscale'));
const NEEDLE_ON = (Number.isFinite(DILATE_OVR) && DILATE_OVR > 0 && DILATE_OVR <= 1)
  || Number.isFinite(ANISO_OVR) || (Number.isFinite(MINSCALE_OVR) && MINSCALE_OVR > 0);

// ?placement=1: the PLACEMENT experimental set — the 2026-09-02 ladder combo
// (docs/plan-placement-2026-09-02.md): base A (mipComp off, anisoReg 0,
// minScale 1e-5, stock dilate 0.3) + refineV2 + growRate 0.1. Truck 30k
// +0.30, garden +0.03 over the MCMC set. Without the Mip compensation the
// trained model IS what PlayCanvas / pcview / SuperSplat rasterize, so the
// export carries no opacity bake (session.exportPlyBlob) and a continued
// share is not un-baked. Sticky like ?mcmc; ?placement=0 clears.
{
  const q = new URLSearchParams(location.search);
  if (q.get('placement') === '0') sessionStorage.removeItem('splatjs_placement');
  else if (q.get('placement')) sessionStorage.setItem('splatjs_placement', '1');
}
const PLACEMENT_ON = sessionStorage.getItem('splatjs_placement') === '1';

// training settings (start-card panel), persisted across visits.
// res 0 = auto, iters 0 = the 20k default, buf = working-buffer scale.
// Phones start from lighter defaults; anything saved wins.
function deviceDefaults() {
  const phone = matchMedia('(any-pointer: coarse)').matches &&
    Math.min(screen.width, screen.height) <= 820;
  return phone
    // 8k cycles: a phone's first run should hit the magic moment in a few
    // minutes — the done screen offers more cycles for anyone who wants them
    ? { v: 2, res: 480, feat: 0, buf: 1, sh: 0, iters: 8000, splats: 0, lod: false, mcmc: false }
    : { v: 2, res: 0, feat: 0, buf: 1, sh: 3, iters: 0, splats: 0, lod: false, mcmc: false };
}
function loadSettings() {
  const d = deviceDefaults();
  try {
    const saved = JSON.parse(localStorage.getItem('splatjs_settings') || 'null');
    // v gates out saves from older panel layouts (e.g. the phone-preset
    // button that wrote sh 0 onto desktops)
    const m = saved && saved.v === 2 ? { ...d, ...saved } : d;
    // saved sh 2 predates the degree-3 default: those sessions were silently
    // training degree 3 (the old `!== 2` guard), so 3 preserves real behavior
    if (m.sh === 2) m.sh = 3;
    // phones: iters 0 (the old 20k default) was never an explicit choice —
    // migrate to the 10k draft default so first runs stay ~5 minutes
    if (d.iters === 10000 && m.iters === 0) m.iters = 10000;
    if (BUF2X) m.buf = 2;
    return m;
  } catch { return d; }
}
function saveSettings() {
  try { localStorage.setItem('splatjs_settings', JSON.stringify(S.settings)); } catch { /* private mode */ }
  // the quick quality dropdown next to Start mirrors every change
  const q = $('q-quick');
  if (q) q.value = qualityOf(S.settings);
}

// quality macros: the one-knob row that drives the individual rows below it.
// Standard = this device's defaults; anything that matches no macro shows as
// Custom. Macros never touch the 2× working buffer (an experiment flag).
const QKEYS = ['res', 'buf', 'sh', 'iters', 'splats'];
function qualityMacros() {
  const d = deviceDefaults();
  return {
    draft:    { res: 480,   buf: 1, sh: 0,    iters: 10000,  splats: 0 },
    standard: { res: d.res, buf: 1, sh: d.sh, iters: 0,      splats: 0 },
    high:     { res: 1280,  buf: 1, sh: 3,    iters: 40000,  splats: 0 },
    showcase: { res: 1280,  buf: 1, sh: 3,    iters: 100000, splats: 0 },
  };
}
function qualityOf(st) {
  for (const [k, m] of Object.entries(qualityMacros())) {
    if (QKEYS.every((f) => st[f] === m[f])) return k;
  }
  return 'custom';
}

const S = {
  state: 'ready',              // ready | prep | train | done
  preset: null,
  session: null,
  photos: [],                  // [{ url, name }] — the strip + overlays
  scene: null,                 // { cams, center, radius, xyz, rgb } for overlays
  sel: 0, atFrame: -1, compare: 'swipe',
  pending: null, picking: false,
  ownUrls: null,
  fade: 0, fadeTo: 0,
  loupe: { x: 0, y: 0, r: 104 }, swipe: .5, rect: null,
  iter: 0, splats: 0, psnrTrain: null, psnrHold: null, itersPerSec: 0,
  minutes: 0, trainT0: 0,
  prep: null,                  // latest solve stage event
  feats: new Map(),            // image -> { n, x, y } (real keypoints)
  lastPairEv: null,            // latest surviving pair with sample matches
  shownPair: null,             // the pair ON STAGE: { ev, a, b, since } — held, never black
  regCams: [],                 // cameras as they register (beat 3)
  solveStats: { pairsChecked: 0, pairsUsable: 0, solveSec: 0 },
  chartEvents: [],             // real refine/growth moments for the curve
  flash: null,
  detailTab: 'score',
  keys: new Set(),             // held WASD keys (camera-relative fly)
  maxIters: INITIAL_ITERS,     // grows when the user continues training
  settings: loadSettings(),    // training knobs from the start-card panel
  gen: 0,                      // run generation — stale async work checks it
};

let vp, dev, chart, dchart, dvp;
// The trainer renders here. The canvas LIVES IN THE DOM, composited under the
// overlay canvas — drawImage from a WebGPU canvas is not safe on iOS Safari
// (it can return either of the last two presented frames, which flickers).
let gpuCanvas = null;

function mountModelCanvas() {
  document.getElementById('cv-model')?.remove();
  gpuCanvas = document.createElement('canvas');
  gpuCanvas.id = 'cv-model';
  $('stage').insertBefore(gpuCanvas, $('cv'));
  S.session.view.attach(gpuCanvas);
  S._viewKey = '';
}

// the OAuth popup lands back on this page with ?code= — report and close
if (!handleOAuthCallback()) boot();

// ── boot ────────────────────────────────────────────────────────────────────
function boot() {
  vp = new Viewport($('cv'));
  vp.onLeave = leaveFrame;
  // The GPU belongs to the view while the user is orbiting: stop submitting
  // training batches (the ~4 queued ones drain in about a second), so the
  // camera answers the finger instead of waiting behind the training queue.
  // Resumes on release; a user-pressed pause is left alone.
  vp.onDragStart = () => {
    stopTour();
    if (S.state === 'train' && S.session && S.session.training) {
      S._dragPaused = true;
      S.session.pause();
    }
  };
  vp.onDragEnd = () => {
    if (!S._dragPaused) return;
    S._dragPaused = false;
    if (S.session && S.state === 'train') S.session.start();
  };
  dev = new Developer();

  $('btn-go').addEventListener('click', async () => {
    if (S.picking) { const p = S.pending || S.preset; closePicker(); await open(p, true); return; }
    if (S.pendingShare) {
      // a community set: its photographs were deliberately NOT loaded with
      // the detail card — resolve the recon now, on the actual start
      const it = S.pendingShare;
      const go = $('btn-go');
      go.disabled = true;
      flash('Fetching the photographs …', 30000);
      try {
        const rj = await fetchShareRecon(it);
        if (!rj.source || !rj.source.urls || !rj.source.urls.length || !rj.source.urls.every(Boolean)) {
          throw new Error('this creation has no public photographs to train from');
        }
        S.preset = { id: '__sample', name: it.title || 'Shared creation' };
        S.photos = rj.source.names.map((n, i) => ({ url: rj.source.urls[i], name: n }));
        S.sel = 0;
        S.pendingShare = null;
      } catch (e) {
        flash(`Could not start: ${e.message}`, 8000);
        go.disabled = false;
        return;
      }
      go.disabled = false;
    }
    startPrep();
  });
  $('btn-new').addEventListener('click', (e) => {
    e.stopPropagation();
    // a shared creation holds nothing precious — Back is simply the way
    // home. When the visitor came from within the app, real history.back()
    // is better: the bfcache restores the feed with its scroll intact.
    if (S.restored) {
      let fromApp = false;
      try {
        const r = document.referrer && new URL(document.referrer);
        fromApp = !!r && r.origin === location.origin;
      } catch (err) { /* opaque referrer -> treat as external */ }
      if (fromApp && history.length > 1) history.back();
      else location.href = 'index.html';
      return;
    }
    // Back from a run leaves the same way the logo does: a page navigation
    // home. The wall is never rendered OVER a live scene — the beforeunload
    // confirm guards a training in progress.
    location.href = 'index.html';
  });
  $('card-x').addEventListener('click', closePicker);
  $('file-input').addEventListener('change', (e) => useOwnPhotos(e.target.files));
  if (cameraSupported()) {
    const rb = $('btn-record');
    rb.hidden = false;
    rb.addEventListener('click', async () => {
      try {
        const got = await recordCaptureVideo();
        if (!got) return;
        if (got.kind === 'video') useOwnVideo(got.file);
        else useOwnPhotos(got.files);   // stills: straight in, no extraction
      } catch (e) {
        console.error(e);
        flash(`Camera unavailable: ${e.message}`, 6000);
      }
    });
  }

  const card = $('start');
  ['dragenter', 'dragover'].forEach((t) => card.addEventListener(t, (e) => {
    e.preventDefault(); card.classList.add('drop');
  }));
  ['dragleave', 'dragend'].forEach((t) => card.addEventListener(t, () => card.classList.remove('drop')));
  card.addEventListener('drop', async (e) => {
    e.preventDefault(); card.classList.remove('drop');
    const files = e.dataTransfer.files;
    // a saved run comes back through the same door as photos
    if (files.length === 1 && /\.(zip|sog|ply)$/i.test(files[0].name)) {
      restoreSession({ bytes: new Uint8Array(await files[0].arrayBuffer()) });
      return;
    }
    useOwnPhotos(files);
  });
  $('d-close').addEventListener('click', closeDetails);
  $('d-prev').addEventListener('click', () => detailFlip(-1));
  $('d-next').addEventListener('click', () => detailFlip(1));

  // the settings panel: values in, values out, persisted
  const st = S.settings;
  const showSettings = () => {
    $('set-res').value = st.res ? String(st.res) : '';
    $('set-feat').value = st.feat ? String(st.feat) : '';
    $('set-buf').value = String(st.buf);
    $('set-sh').value = String(st.sh);
    $('set-iters').value = st.iters ? String(st.iters) : '';
    $('set-splats').value = st.splats ? String(st.splats) : '';
    $('set-q').value = qualityOf(st);
    $('q-quick').value = qualityOf(st);   // the dropdown next to Start
    // LOD levels only make sense from 1M splats up
    const lodOk = st.splats >= 1000000;
    $('set-lod').disabled = !lodOk;
    $('set-lod').value = lodOk && st.lod ? '1' : '';
    $('set-mcmc').value = st.mcmc === '0' ? '0' : '';
  };
  showSettings();
  // the quality knob exists twice — full row in the gear panel, quick
  // dropdown beside Start — one handler, either element
  const pickQuality = (v) => {
    const m = qualityMacros()[v];
    if (!m) return;           // Custom is a display state, not a choice
    Object.assign(st, m);
    showSettings();
    saveSettings();
  };
  $('set-q').addEventListener('change', () => pickQuality($('set-q').value));
  $('q-quick').addEventListener('change', () => pickQuality($('q-quick').value));
  $('btn-settings').addEventListener('click', () => {
    const open = $('settings').hidden;
    // the gear lives on whichever card is showing — start page or detail
    const card = $('detail').hidden ? $('start') : $('detail');
    if (open && matchMedia('(min-width: 641px)').matches) {
      // pin the card's top edge: the panel extends DOWNWARD only, and the
      // card scrolls if it outgrows the screen (full-screen phones skip this)
      const top = Math.max(10, card.getBoundingClientRect().top);
      card.style.top = `${top}px`;
      card.style.margin = '0 auto';
      card.style.bottom = 'auto';
      card.style.maxHeight = `calc(100% - ${top + 12}px)`;
    } else {
      card.style.top = ''; card.style.margin = '';
      card.style.bottom = ''; card.style.maxHeight = '';
    }
    $('settings').hidden = !open;
    $('btn-settings').setAttribute('aria-expanded', String(open));
  });
  const readSettings = () => {
    st.res = parseInt($('set-res').value, 10) || 0;
    st.feat = parseInt($('set-feat').value, 10) || 0;
    st.buf = parseFloat($('set-buf').value) || 1;
    st.sh = parseInt($('set-sh').value, 10);
    st.iters = parseInt($('set-iters').value, 10) || 0;
    st.splats = parseInt($('set-splats').value, 10) || 0;
    st.lod = !!$('set-lod').value && st.splats >= 1000000;
    st.mcmc = $('set-mcmc').value;  // '' Auto | '1' on | '0' off
    showSettings();
    saveSettings();
  };
  for (const id of ['set-res', 'set-feat', 'set-buf', 'set-sh', 'set-iters', 'set-splats', 'set-lod', 'set-mcmc']) {
    $(id).addEventListener('change', readSettings);
  }
  // count slider: live label while dragging, the (cheaper) photo-list rebuild
  // on release; the value label is also the "use all" button
  const countLabel = () => {
    const p = S.preset;
    if (p) $('set-count-v').textContent = `${$('set-count').value} / ${p.maxCount || p.count}`;
  };
  $('set-count').addEventListener('input', countLabel);
  $('set-count').addEventListener('change', () => {
    const p = S.preset;
    if (!p || p.files) return;
    p.useCount = parseInt($('set-count').value, 10) || p.count;
    countLabel();
    applyCount(p);
  });
  $('set-count-v').addEventListener('click', () => {
    const p = S.preset;
    if (!p || p.files) return;
    $('set-count').value = p.maxCount || p.count;
    $('set-count').dispatchEvent(new Event('change'));
  });

  addEventListener('resize', () => { vp.resize(); chart?.resize(); dchart?.resize(); dvp?.resize(); });
  $('cv').addEventListener('wheel', stopTour, { passive: true });
  // Safari's proprietary pinch channel — it ignores user-scalable=no, and the
  // page must never zoom itself (pinch will become a camera control)
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, (e) => e.preventDefault());
  }
  const WASD = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'];
  addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (!$('about').hidden) { if (e.key === 'Escape') $('about').hidden = true; return; }
    if (!$('details').hidden) {
      if (e.key === 'Escape') closeDetails();
      if (S.detailTab === 'marks' && e.key === 'ArrowLeft') detailFlip(-1);
      if (S.detailTab === 'marks' && e.key === 'ArrowRight') detailFlip(1);
      return;
    }
    if (S.picking && e.key === 'Escape') { closePicker(); return; }
    if (e.key === ' ' && S.state === 'train') { e.preventDefault(); toggleTrain(); }
    if (e.key === ' ' && S.state === 'done') {
      // viewing a result: space plays/pauses the capture-path flight
      e.preventDefault();
      if (S.tour) stopTour();
      else { if (S.atFrame >= 0) leaveFrame(); startTour(true); }
    }
    if (e.key === 'ArrowRight') select(S.sel + 1);
    if (e.key === 'ArrowLeft') select(S.sel - 1);
    if (WASD.includes(e.code)) S.keys.add(e.code);
  });
  addEventListener('keyup', (e) => S.keys.delete(e.code));
  addEventListener('blur', () => S.keys.clear());
  wireStage();

  // pointerdown, not click: iOS never synthesises clicks for taps on
  // non-interactive elements (the canvas), so a click listener misses them
  addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.exportwrap')) {
      document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
    }
    if (S.picking && !e.target.closest('#start')) closePicker();
  }, true);

  $('gh').href = REPO;
  $('about-gh').href = REPO;
  // the brand: on the home tile view (nothing open) it tells the story —
  // the About sheet; from inside a scene it stays the way back home
  const openAbout = () => {
    $('about').hidden = false;
    renderAboutGpu();
    // a pushed UI state: the phone's Back closes the sheet, not the app
    if (!(history.state && history.state.sj)) history.pushState({ sj: 'about' }, '');
  };
  $('brand').addEventListener('click', () => {
    const atHome = !$('start').hidden && $('detail').hidden;
    if (atHome) openAbout();
    else location.href = 'index.html';
  });
  $('read-more').addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    openAbout();
  });
  $('about-x').addEventListener('click', () => {
    if (history.state && history.state.sj === 'about') { history.back(); return; }
    $('about').hidden = true;
  });
  $('about').addEventListener('click', (e) => {
    if (!e.target.closest('.about-card')) $('about').hidden = true;
  });

  checkGpu();
  // a refresh mid-run would throw away the model (and, before storage
  // landed, the capture) — ask first
  addEventListener('beforeunload', (e) => {
    if (S.state === 'train' || S.state === 'prep') { e.preventDefault(); e.returnValue = ''; }
  });
  window.__splat = S;          // console access
  window.__vp = () => vp;      // console access (camera state)
  // installable PWA: the worker is a no-op (no caching), the manifest does
  // the rest. Relative URL -> correct scope on every deploy base path.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  showIntro();
  if (MCMC_ON) {
    flash(`MCMC experimental set armed${ITERS_OVERRIDE ? ` · ${ITERS_OVERRIDE.toLocaleString()} cycles` : ''} — sticky this session (?mcmc=0 clears)`, 6000);
  }
  const mp = new URLSearchParams(location.search);
  const viewing = mp.get('space') || mp.get('model');
  if (mp.get('details')) {
    // the sheet's state came with the address (a refresh, or a link sent to
    // someone to read their GPU): open it on that tab — on the wall only the
    // GPU tab has anything to say, a viewer opening below re-renders it
    S.detailTab = mp.get('details');
    S._detailsFromUrl = true;
    if (!viewing) openDetails();
  }
  if (WALL_FIRST) {
    // nothing preselected: the hero asks for photos, the Community wall
    // below offers finished creations to view (and train from there)
    $('btn-go').disabled = true;
    $('start').hidden = false;
    $('start').querySelector('.origin').textContent =
      'Drop in 20–200 overlapping photos of one place, or capture them right ' +
      'here — the camera solve, the training and the export all run in this ' +
      'tab. Or start with a community creation below: view it instantly, ' +
      'then train the same photos yourself.';
  } else {
    // classic: ONE wall — Scenes — official trained benchmarks and community
    // creations side by side; clicking any tile opens the focused DETAIL
    // card, and Start training lives only there. The visitor's own sets
    // (last capture, own shares) live under the wall's Local tab.
    $('start').appendChild($('gallery'));
    $('detail-body').append($('set-desc'), document.querySelector('.startrow'), $('settings'));
    $('detail-back').addEventListener('click', detailClose);
    $('detail-x').addEventListener('click', detailClose);
    // no implicit boot set: nothing loads until the visitor picks — the old
    // truck default sat invisibly behind the start card and leaked into
    // Back navigation ("why is the truck loaded?")
  }
  requestAnimationFrame(loop);

  // a shared result: load it straight into the done-state viewer
  if (mp.get('space')) restoreShared(mp.get('space'));
  else if (mp.get('model')) restoreSession({ url: mp.get('model'), reconUrl: mp.get('recon') });
  else mountWall();
}

// WebGPU probe: navigator.gpu can EXIST while the adapter is unavailable
// (Safari before macOS/iOS 26 keeps it behind a feature flag, Linux builds,
// hardware acceleration switched off). Probe the real adapter and, when it
// fails, say exactly how to switch it on in THIS browser instead of a
// generic shrug. `?nogpu` forces the card for testing.
async function checkGpu() {
  let ok = false;
  try {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    ok = !!adapter;
    // kept for the Details sheet's GPU tab (and its report) — the only
    // source when no session exists yet
    S.gpuProbe = adapter ? { adapter, info: adapter.info || {} } : { failed: true };
  } catch { S.gpuProbe = { failed: true }; }
  if (!$('details').hidden && S.detailTab === 'gpu') renderDetails();
  if (!$('about').hidden) renderAboutGpu();
  if (location.search.includes('nogpu')) ok = false;
  if (ok) return;
  S.noGpu = true;
  $('btn-go').disabled = true;
  const ua = navigator.userAgent;
  const iosLike = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android|Firefox|FxiOS/.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  const linux = /Linux/.test(ua) && !/Android/.test(ua);
  let how;
  if (safari && iosLike) {
    how = 'iOS 26 has it on by default — updating is the easy fix. On earlier iOS: ' +
      '<b>Settings → Apps → Safari → Advanced → Feature Flags</b>, switch on <b>WebGPU</b>, reload this page.';
  } else if (safari) {
    how = 'Safari on macOS 26 has it on by default — updating is the easy fix. On earlier macOS: ' +
      '<b>Safari → Settings → Advanced</b>, tick “Show features for web developers”, then ' +
      '<b>Develop → Feature Flags</b>, switch on <b>WebGPU</b> and reload.';
  } else if (firefox) {
    how = 'Current Firefox ships it on Windows and macOS — updating usually fixes this.' +
      (linux ? ' On Linux, switch <b>dom.webgpu.enabled</b> on in <b>about:config</b> and restart.' : '');
  } else {
    how = 'Update the browser and make sure hardware acceleration is on ' +
      '(<b>Settings → System</b> in Chrome and Edge).' +
      (linux ? ' On Linux, also enable <b>chrome://flags/#enable-unsafe-webgpu</b> and restart.' : '');
  }
  const d = document.createElement('div');
  d.className = 'gpuwarn';
  d.innerHTML = `<b>The GPU is out of reach in this browser</b><span>` +
    `Everything here — the camera solve and the training — runs on WebGPU, ` +
    `and this browser is not exposing it yet. ${how}</span>`;
  $('start').insertBefore(d, $('upload'));
}

/** the untouched start card: header static, no selection, no caption */
function showIntro() {
  S.preset = null;
  S.photos = [];
  $('strip').innerHTML = '';
  $('set-desc').hidden = true;
  $('btn-go').disabled = true;
  $('btn-settings').disabled = true;
  $('settings').hidden = true;
  $('btn-settings').setAttribute('aria-expanded', 'false');
  $('start').hidden = false;
}

/** Build an own-photos set from a stored capture record (fetches the record
 *  when none is passed). Records saved before capture-sorting existed replay
 *  in stored order — sorted on the way out, same rules as a fresh pick. */
async function openCaptureSet(rec = null) {
  rec = rec || await loadLastCapture();
  if (!rec || !rec.files || rec.files.length < 2) return null;
  const files = rec.files.map((e) => new File([e.blob], e.name, { type: e.blob.type || 'image/jpeg' }));
  await sortByCapture(files);
  if (S.ownUrls) S.ownUrls.forEach(URL.revokeObjectURL);
  S.ownUrls = files.map((f) => URL.createObjectURL(f));
  const set = ownSet(files, S.ownUrls);
  set.id = '__last';
  set.kind = 'Saved on this device';
  set.origin = `${files.length} frames from your last capture, restored from this browser's ` +
    'own storage. They never left this device.';
  return set;
}

/** the previous own capture, restored from this device's storage — a tile
 *  for the wall's Local tab (null when nothing is stored). Every set lives
 *  on the Scenes wall; PRESETS stay as data: gates, data deploys and the
 *  official samples' sources. */
async function lastCaptureTile() {
  const rec = await loadLastCapture();
  if (!rec || !rec.files || rec.files.length < 2) return null;
  const b = document.createElement('div');
  b.className = 'galtile';
  b.style.cursor = 'pointer';
  b.title = `${rec.files.length} frames, saved on this device`;
  // the badge keeps it apart from the shares — a capture OF a known scene
  // makes the thumbnails near-identical
  const capWhen = rec.created
    ? new Date(rec.created).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  b.innerHTML = `
    <button class="run-menu" title="Options">⋯</button>
    <span class="galname">${rec.files.length} photos</span>
    <span class="galmeta">${capWhen ? `${capWhen} · ` : ''}local</span>`;
  const img = Object.assign(new Image(), { src: URL.createObjectURL(rec.files[0].blob), alt: '' });
  b.prepend(img);
  tileMenu(b.querySelector('.run-menu'), [
    { label: 'Train', act: async () => {
      const set = await openCaptureSet(rec);
      if (!set) return;
      open(set);
      if (!WALL_FIRST) showDetail(set);
    } },
    { label: 'Delete', danger: true, act: async () => {
      const { deleteLastCapture } = await import('./store.js');
      await deleteLastCapture();
      b.remove();
    } },
  ]);
  b.addEventListener('click', async () => {
    if (S.picking) { S.pending = await openCaptureSet(rec); paintCard(S.pending); return; }
    const set = await openCaptureSet(rec);
    if (!set) return;
    open(set);
    if (!WALL_FIRST) showDetail(set);
  });
  return b;
}

/** tiles for the local runs library — every training run this device has
 *  started. Finished runs reopen in the viewer straight from their stored
 *  result; interrupted ones stay listed (and deletable) as a record. */
/** The tile's "⋯" options menu. items: [{ label, act, danger }] — danger
 *  items arm into "Delete?" first; anything else fires and closes. */
function tileMenu(btn, items) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const existing = btn.parentElement.querySelector('.tilemenu');
    document.querySelectorAll('.tilemenu').forEach((x) => x.remove());
    if (existing) return; // second tap on the same ⋯ just closes
    const m = document.createElement('div');
    m.className = 'tilemenu';
    for (const it of items) {
      if (!it) continue;
      const b = document.createElement('button');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (it.danger && b.dataset.armed !== '1') {
          b.dataset.armed = '1';
          b.textContent = 'Delete?';
          b.classList.add('armed');
          setTimeout(() => {
            b.dataset.armed = '';
            b.textContent = it.label;
            b.classList.remove('armed');
          }, 3000);
          return;
        }
        m.remove();
        await it.act();
      });
      m.appendChild(b);
    }
    btn.parentElement.appendChild(m);
    const close = (ev) => {
      if (m.contains(ev.target) || ev.target === btn) return;
      m.remove();
      removeEventListener('pointerdown', close, true);
    };
    addEventListener('pointerdown', close, true);
  });
}

async function localRunTiles() {
  const { listRuns, deleteRun } = await import('./store.js');
  const runs = await listRuns();
  const tiles = [];
  for (const r of runs) {
    const live = S.runId === r.id && S.state === 'train';
    const src = r.recon && r.recon.source;
    const urlSrc = !!(src && Array.isArray(src.urls) && src.urls.length && src.urls.every(Boolean));
    const retrainable = !!(r.ownSrc || urlSrc);
    if (r.status !== 'finished' && !r.sog && !(r.state && r.recon) && !retrainable && !live) {
      // a dead tombstone: nothing to view, resume or retrain — the only
      // possible action was Delete, so do that instead of listing it
      deleteRun(r.id).catch(() => {});
      continue;
    }
    const b = document.createElement('div');
    b.className = 'galtile';
    b.style.cursor = (r.sog || (r.state && r.recon) || retrainable) ? 'pointer' : 'default';
    // finished scenes wear the same sub-header as the preset tiles:
    // splats · dB · MB — a scene is a scene, wherever it was trained
    const state = r.status === 'finished'
      ? `${fmt(r.splats || 0)} splats${r.psnr != null ? ` · ${(+r.psnr).toFixed(1)} dB` : ''}${r.sog ? ` · ${Math.max(1, Math.round(r.sog.size / 1e6))} MB` : ''}`
      : live
        ? `training now · ${fmt(r.iter || 0)} cycles`
        : (r.state && r.recon)
          ? `paused · ${fmt(r.iter || 0)} cycles — tap to continue`
          : `interrupted · ${fmt(r.iter || 0)} cycles — tap to train again`;
    // same anatomy as a preset tile: name, a description referring back to
    // the capture, then the stats line
    const desc = r.status === 'finished'
      ? `Trained on this device from ${r.frames ? `${fmt(r.frames)} photos` : 'your photos'}` +
        `${r.iter ? `, ${fmt(r.iter)} cycles` : ''}${r.minutes ? ` in ${r.minutes} min` : ''}. Never uploaded.`
      : '';
    b.innerHTML = `
      <button class="run-menu" title="Options">⋯</button>
      <span class="galname">${esc(r.name || 'Training run')}</span>
      ${desc ? `<span class="galdesc">${esc(desc)}</span>` : ''}
      <span class="galmeta">${state}</span>`;
    if (r.thumb) b.prepend(Object.assign(new Image(), { src: URL.createObjectURL(r.thumb), alt: '' }));
    const viewFromState = (rec) => {
      S._localRun = rec;
      continueLocalRun(true).catch((e) => {
        console.error(e);
        flash(`Could not open this run: ${e.message}`, 8000);
      });
    };
    const openRun = () => restoreSession({
      url: URL.createObjectURL(r.sog),
      reconUrl: URL.createObjectURL(new Blob([JSON.stringify(r.recon)], { type: 'application/json' })),
      localRun: r,
    });
    const resumeRun = () => {
      S._localRun = r;
      continueLocalRun().catch((e) => {
        console.error(e);
        flash(`Could not continue this run: ${e.message}`, 8000);
      });
    };
    const viewable = !!(r.recon && (r.sog || (r.status === 'finished' && r.state)));
    tileMenu(b.querySelector('.run-menu'), [
      viewable && { label: 'View', act: r.sog ? openRun : () => viewFromState(r) },
      (r.sog || retrainable || (r.state && r.recon)) && { label: 'Train', act: () => { S._localRun = r; trainLocalChoice(); } },
      r.sog && r.recon && { label: 'Share', act: () => shareDialog(r) },
      { label: 'Delete', danger: true, act: async () => { await deleteRun(r.id); b.remove(); } },
    ]);
    b.addEventListener('click', () => {
      if (r.sog && r.recon) {
        restoreSession({
          url: URL.createObjectURL(r.sog),
          reconUrl: URL.createObjectURL(new Blob([JSON.stringify(r.recon)], { type: 'application/json' })),
          localRun: r, // the viewer's Train button reads this
        });
      } else if (r.status === 'finished' && r.state && r.recon) {
        // finished but never compressed: the viewer reopens from the raw
        // state (Compress there turns it into a sog tile)
        viewFromState(r);
      } else if (r.state && r.recon && !(S.runId === r.id && S.state === 'train')) {
        // a pause checkpoint: no sog to view yet, but the run continues
        // exactly where it stopped
        resumeRun();
      } else if (retrainable && !(S.runId === r.id && S.state === 'train')) {
        // interrupted before any result — but the photos are reachable, so
        // the tap leads straight back into training
        S._localRun = r;
        trainLocalChoice();
      }
    });
    tiles.push(b);
  }
  return tiles;
}

/** the first `cnt` photos of a preset, honouring its skip list */
function presetPhotoList(preset, cnt) {
  // a set rebuilt from stored addresses (an interrupted run's record)
  // carries its photo list ready-made
  if (preset.urlList) return preset.urlList.slice(0, cnt || preset.urlList.length);
  const skip = new Set(preset.skip || []);
  const out = [];
  const start = preset.names ? 0 : preset.start;
  const limit = preset.names ? preset.names.length : Infinity;
  for (let k = 0, i = start; k < cnt && i < limit; i++) {
    if (skip.has(i)) continue;
    const url = presetUrl(preset, i);
    out.push({ url, name: url.split('/').pop() });
    k++;
  }
  return out;
}

function presetUrl(p, i) {
  if (p.names) return `${DATA}${p.dir}/${p.names[i]}`;
  return `${DATA}${p.dir}/` +
    p.pattern.replace(/\{i:(\d+)\}/, (_, w) => String(i).padStart(+w, '0'));
}

/** list-based presets fetch their file list once (BOM-tolerant) */
async function loadPresetList(p) {
  if (!p.list || p.names) return;
  const t = await (await fetch(`${DATA}${p.dir}/${p.list}`)).text();
  p.names = JSON.parse(t.replace(/^﻿/, ''));
  p.maxCount = Math.min(p.maxCount || p.names.length, p.names.length);
}

/** mouse drag-to-scroll for the horizontal rows (their scrollbars are
 *  hidden; touch pans natively via touch-action). A real drag captures the
 *  pointer and swallows the click that would otherwise hit a tile. */
function dragScroll(el) {
  let x0 = 0, s0 = 0, moved = 0, down = false;
  // images/tiles must not become native drag payloads — that ate the swipe
  el.addEventListener('dragstart', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    down = true; moved = 0; x0 = e.clientX; s0 = el.scrollLeft;
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - x0;
    if (Math.abs(dx) > 4 && moved <= 4) {
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      el.style.cursor = 'grabbing';
      document.body.style.cursor = 'grabbing';   // capture outlives the row
    }
    moved = Math.max(moved, Math.abs(dx));
    if (moved > 4) el.scrollLeft = s0 - dx;
  });
  const end = () => { down = false; el.style.cursor = ''; document.body.style.cursor = ''; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('click', (e) => {
    if (moved > 4) { e.stopPropagation(); e.preventDefault(); moved = 0; }
  }, true);
}

/** wall-time estimate: each set's measured time at its default count,
 *  scaled for other counts (training is ~fixed, pair matching is O(n²)) */
function approxFor(preset, n) {
  const base = parseInt((preset.approx || '').replace(/\D+/g, ''), 10);
  if (!base || !preset.count || n === preset.count) return preset.approx;
  const q = (n * n) / (preset.count * preset.count);
  return `~${Math.max(2, Math.round(base * (0.4 + 0.6 * q)))} min`;
}

function paintCard(preset) {
  // the header stays the product's; the selection describes itself in a
  // caption attached to the preset row
  const links = (preset.links || [])
    .map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`).join(' · ');
  const cnt = preset.useCount || preset.count;
  $('set-desc').innerHTML = `<b>${preset.name}</b> — ${preset.origin}` +
    (links ? ` ${links}` : '') +
    `<span class="approx">${approxFor(preset, cnt)} on a fast GPU</span>`;
  $('set-desc').hidden = false;
  // the photo count lives in the settings panel — any fetched set can be
  // trimmed (or extended up to what exists on disk)
  const mx = preset.files ? 0 : (preset.maxCount || preset.count);
  $('row-count').hidden = mx < 3;
  if (mx >= 3) {
    $('set-count').max = mx;
    $('set-count').value = cnt;
    $('set-count-v').textContent = `${cnt} / ${mx}`;
  }
  $('btn-go').textContent = 'Start training';
}

/** re-cut the photo list to the chosen count (only while on the start card
 *  with this preset live — in the mid-run picker the choice applies when the
 *  switch commits through open()) */
function applyCount(preset) {
  const cnt = preset.useCount || preset.count;
  const ap = $('set-desc').querySelector('.approx');
  if (ap) ap.textContent = `${approxFor(preset, cnt)} on a fast GPU`;
  if (S.state === 'ready' && !S.picking && S.preset === preset && !preset.files) {
    S.photos = presetPhotoList(preset, cnt);
    buildStrip(true);   // still behind the card — no thumb fetches yet
  }
}

// (the old mid-run picker — the wall shown OVER a live run — is gone on
// purpose: leaving a run is a page navigation home, never an overlay)

function closePicker() {
  S.picking = false; S.pending = null;
  $('start').hidden = true;
  $('card-x').hidden = true;
  $('btn-go').textContent = 'Start training';
}

/** EXIF DateTimeOriginal (ms since epoch) from a JPEG's APP1 block — null
 *  when absent. lastModified is NOT a substitute on iOS: the picker often
 *  transcodes on selection and stamps THAT moment, shuffling the walk. */
async function exifCaptureTime(file) {
  try {
    const b = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    let p = 2;
    while (p + 4 < b.length) {
      if (b[p] !== 0xff) return null;
      const m = b[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      if (m === 0xda || m === 0xd9) return null; // image data: no EXIF ahead
      const len = (b[p + 2] << 8) | b[p + 3];
      if (m === 0xe1 && len > 10 && b[p + 4] === 0x45 && b[p + 5] === 0x78 &&
          b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
        return tiffDate(b, p + 10, Math.min(len - 8, b.length - (p + 10)));
      }
      p += 2 + len;
    }
    return null;
  } catch { return null; }
}
function tiffDate(b, off, size) {
  if (size < 8) return null;
  const dv = new DataView(b.buffer, b.byteOffset + off, size);
  const le = dv.getUint16(0) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (u16(2) !== 42) return null;
  const scan = (ifdOff, tags) => {
    const out = {};
    if (ifdOff + 2 > size) return out;
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > size) break;
      const tag = u16(e);
      if (tags.includes(tag)) out[tag] = { type: u16(e + 2), count: u32(e + 4), value: u32(e + 8) };
    }
    return out;
  };
  const ifd0 = scan(u32(4), [0x8769, 0x0132]);
  let at = null;
  if (ifd0[0x8769]) {
    const exif = scan(ifd0[0x8769].value, [0x9003, 0x9004]); // DateTimeOriginal, Digitized
    const d = exif[0x9003] || exif[0x9004];
    if (d && d.type === 2 && d.count >= 19) at = d.value;
  }
  if (at == null && ifd0[0x0132] && ifd0[0x0132].type === 2 && ifd0[0x0132].count >= 19) at = ifd0[0x0132].value;
  if (at == null || at + 19 > size) return null;
  let s = '';
  for (let i = 0; i < 19; i++) s += String.fromCharCode(dv.getUint8(at + i));
  const mm = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!mm) return null;
  const t = new Date(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]).getTime();
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** Restore the capture sequence in place. EXIF time rules when present;
 *  when the WHOLE set has none (iOS transcodes on pick and strips EXIF,
 *  stamping mtime with the SELECTION moment — sorting by it preserves the
 *  shuffle), the numeric name order (IMG_0421…, wide_date_time_seq…) is the
 *  trustworthy key. Also feeds the landmarks beat's bottom-right overlay. */
async function sortByCapture(files) {
  const exifs = new Map(await Promise.all(files.map(async (f) => [f, await exifCaptureTime(f)])));
  const anyExif = [...exifs.values()].some((v) => v != null);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  if (anyExif) {
    const stamps = new Map(files.map((f) => [f, exifs.get(f) ?? f.lastModified ?? 0]));
    files.sort((a, b) => (stamps.get(a) - stamps.get(b)) || byName(a, b));
  } else {
    files.sort(byName);
  }
  S.capDates = new Map(files.map((f) => [f.name, exifs.get(f) ?? null]));
  return files;
}

/** Keep the capture on-device, and KNOW whether it worked. The old fire-and-
 *  forget swallowed failures (strict storage, quota, a write starved by the
 *  solve's CPU rush) — the visitor then found no trace of their photos. */
function persistCapture(rec) {
  S._capRec = rec;
  S._capSave = saveLastCapture(rec).then(() => 'ok', (e) => {
    console.warn('capture save failed', e);
    return 'failed';
  });
}

async function useOwnPhotos(list) {
  const all = [...list];
  // video intake is OFF for now — the sharp-frame extraction is not good
  // enough yet. The whole path (useOwnVideo, extractSharpFrames, the camera's
  // video mode) is kept working; re-enable by routing the file again here.
  const video = all.find(isVideoFile);
  const files = all.filter((f) => f.type.startsWith('image/'));
  if (video && files.length < 2) {
    flash('Video input is off for now — take photos instead.', 6000);
    return;
  }
  if (files.length < 2) {
    flash('Pick at least a couple of overlapping photos of the same place.', 4500);
    return;
  }
  // the phone picker hands files over in SELECTION order — restore the
  // capture sequence (shared with the saved-capture restore path)
  await sortByCapture(files);
  if (S.ownUrls) S.ownUrls.forEach(URL.revokeObjectURL);
  S.ownUrls = files.map((f) => URL.createObjectURL(f));
  // survive a refresh: the capture is kept on-device and offered back
  persistCapture({
    kind: 'photos', created: Date.now(),
    files: files.map((f) => ({ name: f.name, blob: f })),
  });
  const set = ownSet(files, S.ownUrls);
  open(set);
  showDetail(set);   // Start training lives on the detail card
}

/** A video: pick its sharpest frames (the server pipeline's policy, run
 *  here) and continue exactly like a photo set. */
async function useOwnVideo(file) {
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'vidcard';
  card.innerHTML = `
    <b>Reading your video</b>
    <div class="prep-sub" id="vid-sub">decoding …</div>
    <div class="prep-meter"><i id="vid-bar" style="width:0%"></i></div>`;
  $('stage').appendChild(card);
  const LABEL = { scan: 'looking for the sharpest frames', capture: 'saving the winners' };
  try {
    const { frames, duration } = await extractSharpFrames(file, {
      log: (m) => console.log('[video]', m),
      onProgress: (e) => {
        const bar = $('vid-bar');
        if (!bar) return;
        const half = e.stage === 'scan' ? 0 : 50;
        bar.style.width = `${half + (e.done / e.total) * 50}%`;
        $('vid-sub').textContent = `${LABEL[e.stage]} · ${e.done} / ${e.total}`;
      },
    });
    if (frames.length < 12) {
      flash('That video is too short — a slow 20+ second pass works best.', 6000);
      return;
    }
    if (S.ownUrls) S.ownUrls.forEach(URL.revokeObjectURL);
    S.ownUrls = frames.map((f) => URL.createObjectURL(f.source));
    // persist the EXTRACTED frames (small JPEGs), not the raw video
    persistCapture({
      kind: 'video', created: Date.now(),
      files: frames.map((f) => ({ name: f.name, blob: f.source })),
    });
    const set = ownSet(frames, S.ownUrls);
    set.kind = 'Your video';
    set.origin = `${frames.length} sharp frames picked from your ${Math.round(duration)}s video, ` +
      'right here in this tab. Blurred moments lost to their sharper neighbours.';
    open(set);
  } catch (e) {
    console.error(e);
    flash(`Could not read that video: ${e.message}`, 8000);
  } finally {
    card.remove();
  }
}

/** reset everything and show a set's start card (autostart commits a switch) */
async function open(preset, autostart = false) {
  document.getElementById('failcard')?.remove();
  if (preset.list && !preset.names) {
    try { await loadPresetList(preset); }
    catch { flash('Could not load that set\'s file list.', 5000); return; }
  }
  S.gen++;
  if (S.session) { S.session.pause(); S.session.dispose(); }
  S.session = null;
  S.preset = preset;
  S.state = 'ready';
  S.picking = false; S.pending = null;
  S.scene = null;
  S.sel = 0; S.atFrame = -1; S.fade = 0; S.fadeTo = 0;
  S.iter = 0; S.splats = 0; S.psnrTrain = null; S.psnrHold = null;
  S.prep = null; S.feats = new Map(); S.lastPairEv = null; S.shownPair = null; S.regCams = [];
  S.regPts = null; S.regPtsCount = 0;
  S.growNote = null;
  S.tour = null;
  S.solveStats = { pairsChecked: 0, pairsUsable: 0, solveSec: 0 };
  S.chartEvents = [];
  S.maxIters = PERF.on ? PERF.iters : INITIAL_ITERS;
  S.perfMetrics = [];
  S.holdHist = [];
  S._lastReady = null;
  S.growthStopped = false;
  S.plyBlob = null; S.sogBlob = null;
  S._fromSpace = null;
  S._thumbsUrl = null; S._thumbPack = null;
  S._recovering = false;
  S._dragPaused = false;
  S._errRender = null;
  S._errRenderBusy = false;
  S._viewKey = '';
  document.getElementById('cv-model')?.remove();
  gpuCanvas = null;
  setStartStyle(true);
  $('btn-go').disabled = !!S.noGpu;
  $('btn-settings').disabled = false;
  $('card-x').hidden = true;
  $('start').hidden = true;
  $('detail').hidden = true;
  $('controls').hidden = true;
  $('btn-new').hidden = true;
  $('strip').innerHTML = '';
  dock('');
  vp.resize();
  vp.lock = null; vp.pose = null; vp.enabled = true; vp.scene = null;
  vp.fpv = false; S.fpvSet = false;

  // the photographs: URLs only — decoding happens when the run starts
  if (preset.files) {
    S.photos = preset.files.map((f, i) => ({ url: preset.urls[i], name: f.name }));
  } else {
    S.photos = presetPhotoList(preset, preset.useCount || preset.count);
  }
  // deferred: the strip sits behind the fullscreen card — its thumbnails
  // load once training starts (or a tile is touched), not now
  buildStrip(true);
  paintCard(preset);
  if (autostart) startPrep();
  else $('start').hidden = false;
}

// ── prep: the solve, live ───────────────────────────────────────────────────
const BEATS = [
  { id: 'decode',   label: 'Reading photographs' },
  { id: 'features', label: 'Finding landmarks' },
  { id: 'matching', label: 'Matching photos' },
  { id: 'cameras',  label: 'Solving positions' },
  { id: 'seed',     label: 'Seeding splats' },
];
const beatIndex = (stage) =>
  ({ decode: 0, features: 1, matching: 2, focal: 3, register: 3, ba: 3, solved: 3, seed: 4 }[stage] ?? 0);

async function startPrep() {
  document.getElementById('failcard')?.remove();
  // consume the detail-card history entry — Back during a run must not
  // resurrect a card that no longer applies
  if (history.state && history.state.sj) history.replaceState(null, '');
  const gen = S.gen;
  $('start').hidden = true;
  $('detail').hidden = true;
  $('btn-new').hidden = false;
  // settle the pick-time capture save: retry once now that the picker rush
  // is over, and SAY SO if the device will not keep the photos
  (async () => {
    if (!S._capSave || (await S._capSave) !== 'failed' || !S._capRec) return;
    persistCapture(S._capRec);
    if ((await S._capSave) === 'failed') {
      flash('The photos could not be kept on this device — export the result before closing this tab.', 9000);
    }
  })().catch(() => {});
  // a fresh solve ALWAYS starts from zero. Paths that arrive here without
  // open() — Train on a shared scene, Start after a failed solve — would
  // otherwise leak the viewed model's numbers into the dock's first paint
  // (seen live: the % born at 50 or 100, jumping down to 1 on the first
  // metrics tick; stale dB and splat counts flash the same way).
  S.iter = 0; S.splats = 0; S.psnrTrain = null; S.psnrHold = null;
  S.itersPerSec = 0; S.minutes = 0; S.etaAt = null;
  S.holdHist = []; S.chartEvents = []; S.growthStopped = false;
  S.feats = new Map(); S.lastPairEv = null; S.shownPair = null; S.regCams = [];
  S.regPts = null; S.regPtsCount = 0; S.growNote = null;
  S.solveStats = { pairsChecked: 0, pairsUsable: 0, solveSec: 0 };
  S.maxIters = PERF.on ? PERF.iters : (S.settings.iters || INITIAL_ITERS);
  S.state = 'prep';
  S.prep = { stage: 'decode', done: 0, total: S.photos.length };
  dock('prep');
  buildStrip();   // the card is gone — the strip is visible now, load live

  try {
    // view buffers sized for the screen at 1x CSS pixels (the stage renders
    // at 1x — splats don't reward supersampling; clamps are pixel-count based)
    const mvW = Math.ceil(screen.width || 1280);
    const mvH = Math.ceil(screen.height || 800);
    S.viewPixBudget = Math.min(
      mvW * mvH,
      16000 * 256, // per-raster tile-grid cap (16k tiles of 16x16)
    );
    // settings -> session options: res caps the input scale, the working
    // buffer scales the supervision grid on top of whatever that yields
    const st = S.settings;
    const frames = (st.res || st.feat || st.buf !== 1 || EVAL.on) ? {
      // benchmark mode pins NATIVE resolution: the adaptive memory budget
      // otherwise downscales big sets silently (truck-251 lands at 645px)
      // and PSNR at reduced resolution reads ~1 dB better than the papers'
      trainMaxDim: st.res || (EVAL.on ? 1600 : undefined),
      trainScale: st.buf !== 1 ? st.buf : undefined,
      ...(st.feat ? { featMaxDim: st.feat } : {}),
    } : undefined;
    // every photo trains by default — held-out scoring is the ?eval
    // benchmark protocol (every Nth photo scored, never learned from)
    const trainerOpts = {};
    // always pass the selected degree — the old `!== 2` guard dated from when
    // the trainer default WAS 2; after the default flipped to 3 it silently
    // trained degree 3 whenever the UI said 2
    if (st.sh != null) trainerOpts.shDeg = st.sh;
    if (st.splats) trainerOpts.maxSplats = st.splats;
    // big budgets: growth must be able to reach the cap even when the sparse
    // cloud can't seed budget/4 (measured: bar panos init ~500k, cap 4M)
    if (st.splats >= 1000000) trainerOpts.capMult = 16;
    // LOD training (opt-in, >= 1M budgets): the model pauses at halving
    // detail levels (250k, 500k, ...) for a polish-and-snapshot before
    // growing on — so it must START below the lowest level
    const lodOn = !!st.lod && st.splats >= 1000000;
    if (lodOn) {
      const levels = [];
      for (let n2 = st.splats; n2 >= 250000; n2 = Math.round(n2 / 2)) levels.unshift(n2);
      // polish scales with the run: every level must be reached AND polished
      // before growth freezes at 0.75x the horizon
      const polish = Math.min(12000, Math.max(3000, Math.floor(S.maxIters * 0.05)));
      S.lodPlan = { levels, idx: 0, holdUntil: null, polish, snaps: [] };
      trainerOpts.capMult = Math.ceil(st.splats / 250000) + 1;
    } else {
      S.lodPlan = null;
    }
    // the ?iters override must land BEFORE anything reads the budget
    if (ITERS_OVERRIDE >= 1000) S.maxIters = ITERS_OVERRIDE;
    // MCMC set: ON by default — measured garden 20k/40k +1.12/+0.61 dB and
    // truck 30k +0.3; the one loss (truck 20k, -0.36) is scene-specific
    // (base growth happened to land near-optimal there). Off in the gear
    // restores the classic schedule.
    const mcmcActive = MCMC_ON || st.mcmc !== '0';
    if (mcmcActive) {
      Object.assign(trainerOpts, {
        growRate: 0.05, mcmcNoise: true, scaleReg: 0.01, moveCap: 0.25,
        ...((st.sh ?? 3) > 0 ? { shLr: 3e-4 } : {}),
      });
      flash('MCMC experimental set active', 5000);
    }
    if (NEEDLE_ON) {
      if (Number.isFinite(DILATE_OVR) && DILATE_OVR > 0 && DILATE_OVR <= 1) trainerOpts.dilate = DILATE_OVR;
      if (Number.isFinite(ANISO_OVR) && ANISO_OVR >= 0) trainerOpts.anisoReg = ANISO_OVR;
      if (Number.isFinite(MINSCALE_OVR) && MINSCALE_OVR > 0 && MINSCALE_OVR < 1e-3) trainerOpts.minScale = MINSCALE_OVR;
      flash(`Needle set active — dilate ${trainerOpts.dilate ?? 0.3}, anisoReg ${trainerOpts.anisoReg ?? 'default'}, minScale ${trainerOpts.minScale ?? '1e-4'} (?dilate=0 clears)`, 6000);
    }
    if (PLACEMENT_ON) {
      // applied after the MCMC set so growRate 0.1 wins over its 0.05
      Object.assign(trainerOpts, { mipComp: false, anisoReg: 0, minScale: 1e-5, refineV2: true, growRate: 0.1 });
      flash('Placement set active — mipComp off, anisoReg 0, minScale 1e-5, refineV2, growRate 0.1 (?placement=0 clears)', 6000);
    }
    // Auto splat budget: sized from the CYCLE budget, not just the solve —
    // the measured capacity law (~15 splats/cycle classic, ~35 under MCMC),
    // clamped to the device class. Explicit user choices always win.
    const phoneClass = matchMedia('(any-pointer: coarse)').matches &&
      Math.min(screen.width, screen.height) <= 820;
    if (!st.splats) {
      trainerOpts.maxSplats = Math.max(150000, Math.min(phoneClass ? 600000 : 2000000,
        Math.round(S.maxIters * (mcmcActive ? 35 : 15))));
      trainerOpts.capMult = 8; // growth must reach the computed cap from a lean seed
    }
    // engine auto-select (measured 2026-08-30): v2 wins short/medium
    // budgets (+0.3..0.6 up to ~75k cycles), v1 wins marathons and stays
    // the phone engine (v2's SSIM passes cost ~1.8x time + GPU memory).
    // ?engine=v1|v2 overrides for A/B.
    const engineQ = new URLSearchParams(location.search).get('engine');
    // AUTO-SELECT DORMANT (2026-08-31): v2 wins live training but the SOG
    // storage tax (-0.95 vs v1's -0.36) eats the gain on stored/shared
    // scenes. Re-enable when the encoder handles unbounded DC.
    const engine = engineQ === 'v2' ? 'v2' : undefined;
    if (engine) { trainerOpts.engine = engine; }
    const session = createSession({
      maxIters: S.maxIters, evalHoldEvery: 2500,
      holdout: -1,
      ...(engine === 'v2' ? { refineEvery: 200 } : (mcmcActive ? { refineEvery: 500 } : {})),
      evalSplit: EVAL.on ? EVAL.split : 0,
      initTarget: lodOn ? 250000 : (st.splats ? Math.round(st.splats / 4) : (phoneClass ? 60000 : undefined)),
      maxViewW: mvW, maxViewH: mvH,
      // phones: iOS jetsams the tab long before the GPU is the limit —
      // decode-to-target (in the library), 720px features, a smaller SIFT
      // worker pool, and dropping gray/rgb once each stage has consumed them
      ...(phoneClass ? {
        lowMem: true,
        // uiYield breaks BA's multi-second synchronous bursts during the
        // solve (10s+ frozen UI on phones). Training is untouched: measured
        // fine on-device, and fenceRing/gpuChunkMs (library opts) would tax
        // throughput for nothing.
        sfm: { workers: 3, uiYield: true },
      } : {}),
      // phones solve at the desktop feature resolution again: 720 was part
      // of the OOM firefight, but the real culprit was the UI bitmap cache —
      // and feature res is the measured pose-precision ceiling
      // phone default 960 — an explicit Solve-resolution choice still wins
      frames: phoneClass ? { featMaxDim: 960, ...(frames || {}) } : frames,
      trainer: Object.keys(trainerOpts).length ? trainerOpts : undefined,
    });
    S.session = session;
    session.on('stage', (e) => { if (S.gen === gen) onStage(e); });
    session.on('metrics', (e) => { if (S.gen === gen) onMetrics(e); });
    session.on('event', (e) => { if (S.gen === gen) onTrainEvent(e); });

    // 1) decode
    let files;
    if (S.preset.files) {
      files = S.preset.files;
    } else {
      files = [];
      for (let i = 0; i < S.photos.length; i++) {
        const r = await fetch(S.photos[i].url);
        if (!r.ok) throw new Error(`could not fetch ${S.photos[i].name}`);
        // url rides along: the session export stores where each image lives
        files.push({ source: await r.blob(), name: S.photos[i].name, url: S.photos[i].url });
        S.prep = { stage: 'decode', done: i + 1, total: S.photos.length };
        if (S.gen !== gen) return;
      }
    }
    S.loadedFiles = files;   // originals, for "Download photos" in export
    await session.load(files);
    if (S.gen !== gen) return;

    // 2) solve — the beats are its real events
    const t0 = performance.now();
    await session.solve({ debug: (d) => { S.internals = d; } });
    if (S.gen !== gen) return;
    S.solveStats.solveSec = (performance.now() - t0) / 1000;

    // No threshold guessing: below 3 placed cameras there is no multi-view
    // problem left to solve — stop with advice. Anything above that trains,
    // and the truth is shown instead: unplaced images carry a red tag in the
    // strip, and a notice says how many made it.
    const placed = session.recon.cams.length;
    const isOwn = S.preset.id && S.preset.id.startsWith('__');
    if (placed < 3) {
      solveFailed(isOwn
        ? `Only ${placed} of ${S.photos.length} photos could be placed — ` +
          'the set doesn\'t connect well enough to reconstruct.'
        : `Only ${placed} of ${S.photos.length} images could be placed — ` +
          'that is unusual for this test set. Reloading the page and retrying usually clears it.');
      S.state = 'ready';
      dock('');
      backToSetup();
      return;
    }
    if (placed < S.photos.length) {
      flash(`${placed} of ${S.photos.length} images placed — the ones tagged in the strip never connected.`, 9000);
    }

    // 3) seed + trainer
    S.prep = { stage: 'seed', done: 0, total: 1 };
    await session.seed();
    if (S.gen !== gen) return;
    if (S.lodPlan) session.trainer.growLimit = S.lodPlan.levels[0];

    buildSceneFromSession();
    mountModelCanvas();
    startTraining();
  } catch (e) {
    if (S.gen !== gen) return;
    console.error(e);
    solveFailed(/parallax|overlap|initialization|matches|register/i.test(e.message)
      ? 'The photos don\'t overlap enough to connect into one scene.'
      : (e.message || 'An unexpected error occurred during reconstruction.'));
    S.state = 'ready';
    dock('');
    backToSetup();
  }
}

/** After a failed solve: back to the setup card the run started from — with
 *  its settings and Start button, so a different resolution is one tap away.
 *  (In classic mode Start lives ON the detail card; the bare start card was
 *  a dead end: upload buttons, no presets, no way to retry.) */
function backToSetup() {
  if (!WALL_FIRST && S.photos.length) showDetail(S.preset || undefined);
  else showHome();
}

/** The home wall, properly: the start card is NEVER revealed without its
 *  scenes mounted — a bare upload card with no presets is a bug, not a
 *  state. Every path that lands on home goes through here. */
function showHome() {
  $('detail').hidden = true;
  $('start').hidden = false;
  mountWall();
}

/** A restore link failed (file gone, share revoked, a CDN edge caching an
 *  old 403): say it in plain words on a card OVER the mounted home — never
 *  a silent toast over a half-built page. */
function loadFailed(what, why) {
  S._viewerOpen = false;
  document.getElementById('share-hero')?.remove();
  dock('');
  showHome();
  document.getElementById('failcard')?.remove();
  const c = document.createElement('div');
  c.className = 'upcard failcard';
  c.id = 'failcard';
  c.innerHTML = `
    <b>${esc(what)}</b>
    <p class="fail-why">${esc(why)}</p>
    <ul class="fail-tips">
      <li><b>The link may be stale.</b> The file behind it moved, expired or is not public.</li>
      <li><b>Reload to retry.</b> A fresh load also clears a stale error cached at the CDN edge.</li>
    </ul>
    <div class="upcard-row"><button class="btn btn-accent" id="fail-ok">Got it</button></div>`;
  document.body.appendChild(c);
  c.querySelector('#fail-ok').addEventListener('click', () => c.remove());
}

/** the solve failed — say so in plain words and teach the capture that works.
 *  GPU/driver failures get their OWN card: telling someone whose graphics
 *  driver stalled to "move sideways" blames their photography for our
 *  hardware trouble (seen in the wild: DXGI_ERROR_DEVICE_REMOVED at
 *  requestDevice, surfaced under capture tips). */
function solveFailed(why) {
  document.getElementById('failcard')?.remove();
  const c = document.createElement('div');
  c.className = 'upcard failcard';
  c.id = 'failcard';
  const gpuTrouble = /DXGI|DEVICE_REMOVED|D3D12|requestDevice|GPUAdapter|WebGPU|graphics device|device lost|Vulkan/i.test(why);
  c.innerHTML = gpuTrouble ? `
    <b>Your graphics device stalled</b>
    <p class="fail-why">${esc(why)}</p>
    <ul class="fail-tips">
      <li><b>Your photos are fine.</b> The graphics driver refused to start — this is the computer, not the capture.</li>
      <li><b>Restart the browser completely</b> (quit, not just the tab) — that clears it in most cases.</li>
      <li><b>Still stuck?</b> Close other GPU-heavy apps and tabs, or restart the machine; on laptops, plug in power.</li>
    </ul>
    <div class="upcard-row"><button class="btn btn-accent" id="fail-ok">Got it</button></div>` : `
    <b>That capture didn't solve</b>
    <p class="fail-why">${esc(why)}</p>
    <ul class="fail-tips">
      <li><b>Move sideways.</b> Depth comes from a change of viewpoint — turning on the spot gives the solver nothing.</li>
      <li><b>Overlap generously.</b> Each photo should share most of its view with the one before.</li>
      <li><b>Pause, then shoot.</b> Motion blur, mirrors and glass are the usual killers.</li>
    </ul>
    <div class="upcard-row"><button class="btn btn-accent" id="fail-ok">Got it</button></div>`;
  document.body.appendChild(c);
  c.querySelector('#fail-ok').addEventListener('click', () => c.remove());
}

function onStage(e) {
  if (S.state !== 'prep') return;
  S.prep = e;
  if (e.stage === 'features' && e.detail) {
    S.feats.set(e.detail.image, e.detail);
    S.sel = e.detail.image;
    // stay ahead of the decoder so the beat shows photos, not black
    for (let k = 1; k <= 3; k++) {
      const nx = S.photos[Math.min(e.detail.image + k, S.photos.length - 1)];
      if (nx && nx.url) bmp(nx.url);
    }
    paintStrip();
  }
  if (e.stage === 'matching' && e.detail) {
    S.solveStats.pairsChecked = e.done;
    S.solveStats.pairsUsable = e.detail.usable;
    if (e.detail.pair) {
      S.lastPairEv = e.detail.pair; S.sel = e.detail.pair.i;
      // start both decodes now so the pair is ready by the time the stage
      // may switch to it (the LRU rarely holds a pair's photos already)
      const p1 = S.photos[e.detail.pair.i], p2 = S.photos[e.detail.pair.j];
      if (p1 && p1.url) bmp(p1.url);
      if (p2 && p2.url) bmp(p2.url);
    }
  }
  if (e.stage === 'register' && e.detail && e.detail.R) {
    const fr = S.session && S.session.frames && S.session.frames[e.detail.image];
    if (fr) {
      S.regCams.push({
        i: e.detail.image, R: e.detail.R, t: e.detail.t, f: e.detail.f,
        w: fr.fw, h: fr.fh, cx: fr.fw / 2, cy: fr.fh / 2, state: 'placed',
      });
    }
    if (e.detail.cloud && e.detail.cloud.length) {
      S.regPts = e.detail.cloud;
      S.regRgb = e.detail.cloudRgb || null;
      S.regPtsCount = e.detail.points || 0;
    }
    // an overview that keeps FOLLOWING the growing reconstruction — framing
    // once at 3 cameras left everything after out of shot
    const cs = S.regCams.map(camCentre);
    if (cs.length) {
      const c = cs.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0])
        .map((v) => v / cs.length);
      let tgt = c;
      if (S.regPts && S.regPts.length) {
        // midpoint of camera ring and cloud puts both in frame
        let px = 0, py = 0, pz = 0;
        const m = S.regPts.length / 3;
        for (let i = 0; i < S.regPts.length; i += 3) {
          px += S.regPts[i]; py += S.regPts[i + 1]; pz += S.regPts[i + 2];
        }
        tgt = [(c[0] + px / m) / 2, (c[1] + py / m) / 2, (c[2] + pz / m) / 2];
      }
      // radius from the CAMERAS only — the cloud has outliers, the ring doesn't
      const r = Math.max(1e-3, ...cs.map((p) => Math.hypot(p[0] - tgt[0], p[1] - tgt[1], p[2] - tgt[2])));
      vp.scene = { center: tgt, radius: r * 1.1, xyz: null, rgb: null };
      if (S.regCams.length === 3) {
        vp.detectUp(S.regCams);
        vp.frameScene();
      } else if (S.regCams.length > 3) {
        vp.detectUp(S.regCams);
        const k = 0.3;   // damped follow: no jumps, just a slow zoom-out
        for (let i = 0; i < 3; i++) vp.target[i] += (tgt[i] - vp.target[i]) * k;
        vp.dist += (r * 2.4 - vp.dist) * k;
        vp.dirty = true;
      }
    }
  }
}

/** the display-side scene: every photograph, placed or not, plus the cloud */
function buildSceneFromSession() {
  const ses = S.session;
  const recon = ses.recon;
  const panoish = !!ses.rigInfo || (ses.frames && ses.frames.length > S.photos.length);
  let cams;
  if (panoish) {
    const best = new Array(S.photos.length).fill(null);
    if (recon && recon.cams) {
      recon.cams.forEach((rc) => {
        const rig = ses.rigInfo ? ses.rigInfo[rc.imgIdx] : null;
        const panoIdx = rig ? rig.id : Math.floor(rc.imgIdx / 6);
        if (panoIdx >= 0 && panoIdx < S.photos.length) {
          const fr = (ses.frames && ses.frames[rc.imgIdx]) || {};
          const m = fr.name && String(fr.name).match(/_f(\d+)$/);
          const face = m ? +m[1] : (rc.imgIdx % 6);
          const ci = ses.trainer && ses.trainer.camMeta
            ? ses.trainer.camMeta.findIndex((meta) => meta.imgIdx === rc.imgIdx) : -1;
          if (!best[panoIdx] || face < best[panoIdx].face) {
            best[panoIdx] = { rc, ci, face };
          }
        }
      });
    }
    cams = S.photos.map((p, i) => {
      const b = best[i];
      if (!b) return { i, ci: -1, R: null, t: null, url: p.url, name: p.name,
                       w: 4, h: 3, cx: 2, cy: 1.5, state: 'unplaced', feats: 0, psnr: null, pano: true };
      const fr = (ses.frames && ses.frames[b.rc.imgIdx]) || {};
      const w = fr.fw || 1000, h = fr.fh || 1000;
      return {
        i, ci: b.ci, R: b.rc.R, t: b.rc.t, f: b.rc.f,
        w, h, cx: w / 2, cy: h / 2,
        url: p.url, name: p.name,
        state: b.ci === ses.holdout || (ses.testCams && ses.testCams.includes(b.ci)) ? 'holdout' : 'placed',
        feats: (S.feats.get(b.rc.imgIdx) || {}).n || 0,
        psnr: null, pano: true,
      };
    });
  } else {
    cams = S.photos.map((p, i) => ({
      i, url: p.url, name: p.name, R: null, t: null, state: 'unplaced', ci: -1, psnr: null,
    }));
    if (ses.trainer && ses.trainer.camMeta) {
      ses.trainer.camMeta.forEach((m, ci) => {
        const c = cams[m.imgIdx];
        if (!c) return;
        const rc = recon && recon.cams && recon.cams.find((r) => r.imgIdx === m.imgIdx);
        const fr = (ses.frames && ses.frames[m.imgIdx]) || {};
        const w = fr.fw || 1000, h = fr.fh || 1000;
        Object.assign(c, {
          R: m.R, t: m.t, f: rc ? rc.f : (m.f || 1000),
          w, h, cx: w / 2, cy: h / 2,
          state: ci === ses.holdout || (ses.testCams && ses.testCams.includes(ci)) ? 'holdout' : 'placed',
          ci,
          feats: (S.feats.get(m.imgIdx) || {}).n || 0,
        });
      });
    }
  }
  const pts = (recon && recon.points) || [];
  const xyz = new Float32Array(pts.length * 3);
  const rgb = new Uint8Array(pts.length * 3);
  pts.forEach((p, k) => {
    if (p.X) xyz.set(p.X, k * 3);
    if (p.rgb) {
      rgb[k * 3] = p.rgb[0] * 255;
      rgb[k * 3 + 1] = p.rgb[1] * 255;
      rgb[k * 3 + 2] = p.rgb[2] * 255;
    }
  });
  S.scene = {
    cams, xyz, rgb,
    center: (ses.model && ses.model.center) || [0, 0, 0],
    radius: (ses.model && ses.model.radius) || 1,
  };
  vp.setScene(S.scene);
  vp.detectUp(cams);
  paintStrip();
}

// ── training ────────────────────────────────────────────────────────────────
function startTraining() {
  S.state = 'train';
  S.trainT0 = performance.now();
  S.etaAt = null;   // the countdown re-anchors on this run's own pace
  // dual-GPU desktops: WebGPU can land on the integrated GPU even when a
  // dedicated card sits idle (seen in the wild: 3 h for a run a 3070 does in
  // minutes — the NVIDIA control panel does NOT govern this). Say so once.
  {
    const gi = (S.session && S.session.gpu && S.session.gpu.info) || {};
    if (/intel/i.test(gi.vendor || '') && !matchMedia('(any-pointer: coarse)').matches &&
        !localStorage.getItem('splatjs_gpu_note')) {
      localStorage.setItem('splatjs_gpu_note', '1');   // once — Intel-only laptops are fine
      flash('Training runs on Intel graphics. If this PC has a dedicated GPU, tell Windows to ' +
        'use it for your browser: Settings → System → Display → Graphics — then reload.', 15000);
    }
  }
  // local library: every run is listed from the moment it starts — a small
  // record now, the finished result later (see finish())
  // a checkpoint resume keeps its run identity — same tile, same slot; only
  // fresh runs (and continuations of FINISHED runs) get a new record
  const resumeId = S._resumeRunId;
  S._resumeRunId = null;
  S.runId = resumeId || `run_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  S._ckptIter = 0;
  (async () => {
    if (resumeId) {
      // the record already exists (thumb, checkpoint, name) — just mark it live
      const { patchRun } = await import('./store.js');
      await patchRun(resumeId, { status: 'training', maxIters: S.maxIters });
      return;
    }
    let thumb = null;
    try {
      const p = S.photos && S.photos[0];
      if (p && p.url) {
        const bmp = await createImageBitmap(await (await fetch(p.url)).blob(), { resizeWidth: 320 });
        const cv = document.createElement('canvas');
        cv.width = bmp.width; cv.height = bmp.height;
        cv.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        thumb = await new Promise((res) => cv.toBlob(res, 'image/webp', 0.8));
      }
    } catch { /* the tile just goes textless */ }
    const { saveRun } = await import('./store.js');
    const pid = String((S.preset && S.preset.id) || '');
    // own scenes are SCENES, not photos — a continued run keeps the name it
    // already carries; the tile's description holds the capture details
    let runName = (S.preset && S.preset.name) || 'Your photos';
    if ((pid === '__own' || pid === '__last') && (runName === 'Your photos' || pid === '__last')) {
      runName = 'Local Scene';
    }
    await saveRun({
      id: S.runId, name: runName,
      status: 'training', createdAt: Date.now(), updatedAt: Date.now(),
      iter: 0, maxIters: S.maxIters, splats: S.splats || 0, psnr: null,
      frames: (S.photos || []).length, thumb,
      // own-photo runs can train again from the device's capture store
      ownSrc: pid === '__own' || pid === '__last',
    });
  })().catch(() => {});
  const first = S.scene.cams.find((c) => c.R && c.state !== 'holdout') || S.scene.cams[0];
  if (first && first.R) {
    S.sel = first.i;
    vp.freeF = null;
    vp.syncTo(first);   // exactly the first photographer's viewpoint
    paintStrip();
  }
  renderControls();
  dock('train');
  S.session.start();
}

function toggleTrain() {
  if (!S.session) return;
  if (S.session.training) S.session.pause();
  else S.session.start();
  const b = $('t-play');
  const on = S.session.training;
  if (b) {
    b.dataset.state = on ? 'pause' : 'play';
    // SVG icons, not font glyphs: the ▶ character carries right-side bearing
    // that drifts it off optical centre — a drawn triangle cannot
    b.innerHTML = on
      ? '<svg viewBox="0 0 24 24" class="pl" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" class="pl" aria-hidden="true"><path d="M8 4.8v14.4l12.4-7.2z"/></svg>';
  }
  const label = on ? 'Training…' : 'Paused';
  const tt = $('t-title');
  if (tt) tt.textContent = label;
  const f = $('t-finish');
  if (f) f.hidden = on;   // paused = the moment "stop here" makes sense
  if (!on) checkpointRun('pause').catch(() => {});
}

// ── crash-safe checkpoint ───────────────────────────────────────────────────
// The raw trainer state — a straight GPU readback, no PLY text, no SOG
// k-means — goes into the run record whenever the user pauses, and (desktop
// only) when the tab goes hidden mid-training. One slot per run, overwritten:
// pausing means the browser may be closed, and the Yours tile continues the
// run bit-exactly from where it stopped. The blob is dropped again the moment
// the run finishes properly — the sog takes over.
async function checkpointRun(reason) {
  if (!S.runId || !S.session || !S.session.trainer) return;
  // 'finish' runs in the done state, BEFORE the export chain: the result is
  // secured even if sog compression or the device dies right after training
  if (reason === 'finish' ? S.state !== 'done' : S.state !== 'train') return;
  const it = S.session.trainer.iter | 0;
  if (it < 200 || S._ckptBusy) return;   // nothing worth keeping yet
  // hidden fires on every tab switch — only rewrite after real progress
  if (reason === 'hidden' && it - (S._ckptIter || 0) < 500) return;
  S._ckptBusy = true;
  const gen = S.gen;
  try {
    const { packState, buildReconJson } = await import('./session_io.js');
    const state = new Blob([await packState(S.session)]);
    if (S.gen !== gen) return;
    const recon = buildReconJson(S);
    const { patchRun } = await import('./store.js');
    await patchRun(S.runId, {
      iter: it, splats: S.splats || S.session.trainer.n,
      psnr: S.psnrHold ?? S.psnrTrain ?? null,
      cap: S.session.trainer.cap || 0,   // growth headroom carries over
      state, recon, ckptAt: Date.now(),
    });
    S._ckptIter = it;
    if (reason === 'pause') flash('Progress saved on this device — safe to close, continue anytime from Yours.', 6000);
  } catch (e) {
    console.warn('checkpoint failed', e);   // best-effort: never disturb a run
  } finally { S._ckptBusy = false; }
}

function onMetrics(m) {
  S.iter = m.iter;
  S.splats = m.splats;
  S.itersPerSec = m.itersPerSec;
  // local library: keep the run record roughly current (survives a closed tab)
  if (S.runId && (!S._runSaveT || performance.now() - S._runSaveT > 20000)) {
    S._runSaveT = performance.now();
    import('./store.js').then(({ patchRun }) => patchRun(S.runId, {
      iter: m.iter, splats: m.splats, psnr: m.psnrTrain ?? null,
    })).catch(() => {});
  }
  // LOD training: hold the model at each detail level for a polish window,
  // snapshot it, then raise the growth limit and move on
  const LP = S.lodPlan;
  if (LP && S.session?.trainer && LP.idx < LP.levels.length - 1) {
    const tr = S.session.trainer;
    if (LP.holdUntil == null && tr.n >= LP.levels[LP.idx]) {
      LP.holdUntil = m.iter + LP.polish;
    } else if (typeof LP.holdUntil === 'number' && m.iter >= LP.holdUntil) {
      LP.holdUntil = 'snapping';
      const lvl = LP.levels[LP.idx];
      S.session.exportPlyBlob().then((blob) => {
        LP.snaps.push({ n: lvl, blob });
        LP.idx++;
        LP.holdUntil = null;
        tr.growLimit = LP.levels[LP.idx];
        flash(`LOD level ${fmt(lvl)} snapshotted — growing on`, 3500);
      }).catch(() => { LP.holdUntil = null; });
    }
  }
  (S.perfMetrics ??= []).push([Math.round(performance.now()), m.iter, m.itersPerSec,
    m.psnrTrain != null ? m.psnrTrain.toFixed(2) : '', m.psnrHold != null ? m.psnrHold.toFixed(2) : '']);
  if (m.psnrTrain != null) S.psnrTrain = m.psnrTrain;
  if (m.psnrHold != null) S.psnrHold = m.psnrHold;
  if (m.psnrHold != null) (S.holdHist ??= []).push([m.iter, m.psnrHold]);
  // the first few hundred cycles rocket from near-nothing to the real curve —
  // charting that ramp squashes the whole run's y-scale into a corner
  if (chart && m.psnrTrain != null && m.iter >= Math.min(500, S.maxIters * 0.02)) {
    chart.push(m.iter, m.psnrTrain, m.psnrHold ?? null);
    chart.maxIter = S.maxIters;
    chart.events = S.chartEvents.map((e) => ({ ...e, at: e.iter / S.maxIters }));
    chart.draw();
  }
  // re-anchor the countdown on every fresh pace measurement
  if (m.itersPerSec > 0 && S.maxIters) {
    const est = performance.now() + Math.max(0, S.maxIters - m.iter) / m.itersPerSec * 1000;
    S.etaAt = S.etaAt == null ? est : S.etaAt + 0.35 * (est - S.etaAt);
  }
  if (S.state === 'train') {
    const el = $('t-iter');
    if (el) {
      el.textContent = pctOf(S.iter);
      $('t-splats').textContent = fmt(S.splats);
      $('t-eta').textContent = etaText();
      $('t-ptrain').textContent = S.psnrTrain != null ? S.psnrTrain.toFixed(2) : '—';
      const ph = $('t-phold');   // only rendered in ?eval benchmark mode
      if (ph) ph.textContent = S.psnrHold != null ? S.psnrHold.toFixed(2) : '—';
    }
  }
}

/** Training progress as the visitor reads it: a percentage of the horizon. */
function pctOf(iter) {
  if (!S.maxIters) return '0%';
  return `${Math.min(100, Math.floor((iter || 0) / S.maxIters * 100))}%`;
}

/** Time remaining as a live 04:32-style countdown (digits only — the static
 *  "ETA" label lives in the template). Metrics re-anchor the estimate
 *  (blended, so a wobbling pace doesn't make the clock stutter); the main
 *  loop ticks the display while training runs. */
function etaText() {
  if (S.etaAt == null) return '—:—';
  const s = Math.max(0, (S.etaAt - performance.now()) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function onTrainEvent(e) {
  if (e.kind === 'refine' && e.grown > 0) {
    S.chartEvents.push({ iter: e.iter, kind: 'grow', label: `Capacity +${fmt(e.grown)}` });
    // shown right under the splat count in the dock, not as a HUD chip
    S.growNote = { text: `+${fmt(e.grown)} splats`, until: performance.now() + 2200 };
  }
  if (e.kind === 'refine' && e.grown === 0 && !S.growthStopped && e.iter > S.maxIters * 0.7) {
    S.growthStopped = true;
    S.chartEvents.push({ iter: e.iter, kind: 'stop', label: 'Growth stops' });
  }
  if (e.kind === 'train-complete') finish();
  if (e.kind === 'device-lost') deviceLostRecovery();
}

/** iOS (and crashing drivers) reclaim the WebGPU device from backgrounded
 *  tabs. The trained splats lived on it; photos + camera solve are CPU-side.
 *  Mid-training: rebuild and train again. Done: the .ply blob was cached at
 *  completion, so export and upload still work. */
async function deviceLostRecovery() {
  if (S._recovering) return;
  const gen = S.gen;
  if (S.state === 'done') {
    flash(S.plyBlob || S.sogBlob
      ? 'The browser reclaimed the graphics device — the finished model is safe, export still works.'
      : S.runId
        ? 'The browser reclaimed the graphics device — the result is saved on this device under Yours.'
        : 'The browser reclaimed the graphics device.', 9000);
    return;
  }
  if (S.state !== 'train') return;
  S._recovering = true;
  document.getElementById('cv-model')?.remove();   // its context died with the device
  gpuCanvas = null;
  flash('The system put the GPU to sleep while the tab was in the background — restarting training. Photos and the camera solve are kept.', 15000);
  try {
    // iOS won't hand out a new device while hidden — wait for the tab back
    if (document.visibilityState === 'hidden') {
      await new Promise((res) => {
        const h = () => {
          if (document.visibilityState !== 'visible') return;
          removeEventListener('visibilitychange', h);
          res();
        };
        addEventListener('visibilitychange', h);
      });
    }
    if (S.gen !== gen) return;
    await S.session.recover();
    if (S.gen !== gen) return;
    S.iter = 0; S.psnrTrain = null; S.psnrHold = null;
    S.holdHist = []; S.chartEvents = []; S.growthStopped = false;
    S.plyBlob = null; S.sogBlob = null;
    buildSceneFromSession();
    mountModelCanvas();
    startTraining();
  } catch (err) {
    console.error(err);
    if (S.gen === gen) {
      solveFailed('The graphics device was lost and could not be brought back — reload the page to train again.');
    }
  } finally {
    S._recovering = false;
  }
}

// ── iOS background guard ────────────────────────────────────────────────────
// iOS purges WebGPU buffer contents from hidden tabs WITHOUT firing
// device-loss: the worker-tick loop then keeps training a zeroed/garbage
// model (seen in the wild: PSNR cliff mid-run, smeared splats, iter count
// intact). On iOS training PAUSES while hidden; on return a params probe
// decides between resuming and an honest restart. Desktop keeps its
// background-training behavior — the corruption is iOS-specific.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (IOS) document.addEventListener('visibilitychange', () => {
  if (!S.session || S.state !== 'train') return;
  if (document.visibilityState === 'hidden') {
    if (S.session.training) {
      S._bgPaused = true;
      S.session.pause();
    }
  } else if (S._bgPaused) {
    S._bgPaused = false;
    const gen = S.gen;
    (async () => {
      const tr = S.session && S.session.trainer;
      const ok = tr && tr.sanityProbe ? await tr.sanityProbe() : true;
      if (S.gen !== gen || S.state !== 'train') return;
      if (ok) {
        S.session.start();
        flash('Welcome back — training resumes.', 3500);
      } else {
        // the buffers didn't survive the background trip
        flash('iOS cleared the model while the tab was hidden — restarting the training run.', 9000);
        deviceLostRecovery();
      }
    })().catch(() => {});
  }
});

// Desktop counterpart: training keeps running while hidden (worker tick), but
// a hidden tab is also where runs die unseen — crash, GPU reset, closed
// window. Snapshot the state when the user switches away; exportRawState is
// serialized against the step loop, so the readback is a consistent frame.
// (iOS stays pause-only above — reading buffers that may already be purged
// could overwrite a good checkpoint with garbage.)
if (!IOS) document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && S.state === 'train') {
    checkpointRun('hidden').catch(() => {});
  }
});

/** The done-state viewer: land at the photographer's view, controls, tour.
 *  Shared by a run finishing live and a finished run reopened from its
 *  state checkpoint (viewOnly continueLocalRun). */
function enterDone() {
  S.state = 'done';
  S.atFrame = -1; S.fadeTo = 0;
  vp.lock = null; vp.freeF = null;
  $('stage').dataset.cursor = 'grab';
  // land roughly where the first photograph was taken — the photographer's
  // view of the result, not an abstract overview
  const first = S.scene.cams.find((c) => c.R && c.state !== 'holdout') || S.scene.cams[0];
  if (first && first.R) {
    vp.syncTo(first);
    vp.dist *= 1.15;   // stepped back just enough for context
  } else {
    vp.frameScene();
  }
  renderControls();
  dock('');
  startTour();
  if (S._detailsFromUrl) { S._detailsFromUrl = false; openDetails(); }   // ?details=<tab> reopens the sheet
}

async function finish() {
  S.iter = S.session.trainer.iter;   // honest count — the run may end early
  S.minutes = Math.max(1, Math.round((performance.now() - S.trainT0) / 60000));
  enterDone();
  const hold = S.psnrHold != null ? ` · ${S.psnrHold.toFixed(1)} dB on the photograph it never saw` : '';
  flash(`Done${hold}`, 6000);
  if (EVAL.on) {
    // the ?eval benchmark verdict: mean PSNR over every held-out photo
    S.session.evalTestPsnr().then((r) => {
      if (!r || S.state !== 'done') return;
      S.psnrTest = r;
      flash(`Test PSNR ${r.psnr.toFixed(2)} dB over ${r.frames.length} held-out photos`, 12000);
    }).catch(() => {});
  }
  S.plyBlob = null; S.sogBlob = null; S._sogJob = null;
  // The result is secured as a RAW STATE checkpoint (a plain readback,
  // seconds) — the same record a pause writes, marked finished. It is
  // viewable and resumable from Yours without anything else. Nothing heavy
  // runs here: the .ply export (an O(splats × cameras) bake on the main
  // thread), the SOG compression (k-means on a second GPU device) and the
  // per-photo scoring used to start right now and left the finished viewer
  // at ~1 fps for minutes — exactly while the creator wanted to look at the
  // result. They are on demand: Compress (or Share / Download .sog) runs the
  // ONE compression job (getSogBlob), scoring runs when Details opens.
  const gen = S.gen;
  while (S._ckptBusy) await new Promise((r) => setTimeout(r, 200));   // a 'hidden' write in flight
  try { await checkpointRun('finish'); } catch { /* best-effort */ }
  if (S.runId && S.gen === gen) {
    try {
      const thumb = await renderShareThumb();
      if (S.gen !== gen) return;
      const { patchRun } = await import('./store.js');
      await patchRun(S.runId, {
        status: 'finished', iter: S.iter, splats: S.splats,
        // app runs train every photo (holdout -1): train PSNR is the number
        psnr: S.psnrHold ?? S.psnrTrain ?? null, minutes: S.minutes,
        ...(thumb ? { thumb } : {}),
      });
      flash('Result saved on this device — it stays under Yours', 5000);
    } catch (e) { console.warn('local save failed', e); }
  }
  if (PERF.on) perfCard();
}

// ── restore: present a saved run without re-training ────────────────────────
// ?model=<url> (a session .zip, .ply or .sog; &recon=<url> adds the camera
// path to bare model files) or a file dropped on the start card. The model
// lands in the exact done-state viewer: tour, orbit, exports — no training.
async function restoreSession(src) {
  try {
    S._localRun = src.localRun || null; // set only by the local runs library
    S._viewerOpen = true;
    // the viewer is a navigable state: Back returns to the wall, never to
    // whatever page happened to precede the app
    if (!(history.state && history.state.sj)) history.pushState({ sj: 'viewer' }, '');
    $('start').hidden = true;
    flash('Loading the model …', 120000);
    // SOG + recon: the lite viewer — the engine renders the compressed splat
    // directly (sorted, WebGL2), nothing decodes to float arrays, and phones
    // without WebGPU can still view. ?nopc forces the trainer view.
    const liteOk = !src.bytes && src.url && /\.sog($|\?)/.test(src.url) && src.reconUrl &&
      !new URLSearchParams(location.search).has('nopc');
    if (liteOk) {
      try {
        const r = await fetch(src.reconUrl);
        if (!r.ok) throw new Error(`recon fetch failed (${r.status})`);
        const buf = new Uint8Array(await r.arrayBuffer());
        let reconJson;
        if (buf[0] === 0x50 && buf[1] === 0x4b) {
          const { unzipStore } = await import('./session_io.js');
          reconJson = JSON.parse(new TextDecoder().decode(unzipStore(buf).get('recon.json')));
        } else {
          reconJson = JSON.parse(new TextDecoder().decode(buf));
        }
        const { createSogView } = await import('./pcview.js');
        const ses = await createSogView(src.url, { radius: reconJson.sceneRadius || 10 });
        ses.frames = (reconJson.frames || []).map((f) => ({ ...f }));
        // the Details sheet reads session.recon (cams/points) — same shape
        // the old view-only path built via useReconstruction()
        ses.recon = {
          cams: (reconJson.cams || []).map((c) => ({ imgIdx: c.imgIdx, R: c.R, t: c.t, f: c.f, cx: c.cx, cy: c.cy })),
          // the Details header counts these; the recon carries a decimated
          // cloud, so at least report its size instead of a flat zero
          points: { length: Math.floor(((reconJson.cloud && reconJson.cloud.xyz) || []).length / 3) },
          k1: reconJson.k1 || 0, k2: reconJson.k2 || 0,
        };
        finishRestore(ses, reconJson, reconJson.splats || 0, false, null);
        return;
      } catch (e) {
        console.warn('sog viewer failed — falling back to the trainer view', e);
      }
    }
    const { decodeModel } = await import('./session_io.js');
    const got = src.bytes
      ? await decodeModel(src.bytes, src.reconUrl)
      : await fetchModel(src.url, src.reconUrl);
    const { gaussians, reconJson, state } = got;
    const iter = (state && state.iter) || (reconJson && reconJson.iter) || 0;
    const ses = createSession({ holdout: -1, maxIters: Math.max(1, iter) });
    if (reconJson) {
      ses.useReconstruction({
        cams: reconJson.cams.map((c) => ({ imgIdx: c.imgIdx, R: c.R, t: c.t, f: c.f, cx: c.cx, cy: c.cy })),
        points: [],
        k1: reconJson.k1 || 0, k2: reconJson.k2 || 0,
        ...(reconJson.fFeat ? { fFeat: reconJson.fFeat } : {}),
      });
      ses.useFrames(reconJson.frames.map((f) => ({ ...f, sampleColor: () => [0.5, 0.5, 0.5] })));
    }
    await ses.seedFrom(gaussians, {
      viewOnly: true,
      sceneRadius: reconJson ? reconJson.sceneRadius : undefined,
      iter,
      trainer: { maxSplats: gaussians.n, capMult: 1 },
    });
    finishRestore(ses, reconJson, gaussians.n, !!state, gaussians);
  } catch (e) {
    console.error(e);
    loadFailed('That model didn\'t load', e.message);
  }
}

/** The shared back half of a restore: viewer state, scene, strip, tour —
 *  works for a real (view-only) session and for the SOG-lite stand-in. */
function finishRestore(ses, reconJson, nSplats, hasState, gaussians) {
  try {
    const iter = (reconJson && reconJson.iter) || 0;
    S.session = ses;
    const stats = (reconJson && reconJson.stats) || {};
    S.restored = { hasState, stats, reconJson };
    S.preset = { id: '__restored', name: (reconJson && reconJson.name) || 'shared splat' };
    S.splats = nSplats;
    S.maxIters = iter || 1;
    S.iter = iter;
    S.minutes = stats.minutes || 0;
    S.psnrTrain = stats.psnrTrain ?? null;
    S.psnrHold = stats.psnrHold ?? null;
    S.plyBlob = null; S.sogBlob = null;
    S.lodPlan = null;
    S.state = 'done';
    const frames = (reconJson && reconJson.frames) || [];
    const source = (reconJson && reconJson.source) || {};
    // the photographs come back too when the session recorded where they
    // live (photo sets: one image per frame) — the strip and the per-photo
    // compare modes then work exactly like after a live run
    const photosBack = Array.isArray(source.urls) && source.urls.length &&
      source.urls.length === frames.length && source.urls.every(Boolean);
    S.isPanoSet = false;
    let cams;
    if (photosBack) {
      S.photos = source.names.map((n, i) => ({ url: source.urls[i], name: n }));
      // camMeta for lookThrough/error-render: train-res intrinsics per
      // registered camera (offset unused outside training)
      const metas = reconJson.cams.map((c) => {
        const fr = frames[c.imgIdx] || {};
        const s2 = (fr.tw || fr.fw || 1000) / (fr.fw || 1000);
        return { imgIdx: c.imgIdx, R: c.R, t: c.t, f: c.f * s2,
                 cx: (fr.tw || 1000) / 2, cy: (fr.th || 1000) / 2,
                 w: fr.tw || 1000, h: fr.th || 1000, offset: 0 };
      });
      ses.trainer.camMeta = metas;
      const byImg = new Map(reconJson.cams.map((c, k) => [c.imgIdx, k]));
      cams = S.photos.map((p, i) => {
        const k = byImg.get(i);
        const fr = frames[i] || {};
        const w = fr.fw || 1000, h = fr.fh || 1000;
        if (k == null) return { i, ci: -1, R: null, t: null, url: p.url, name: p.name,
                                w, h, cx: w / 2, cy: h / 2, state: 'unplaced', feats: 0, psnr: null };
        const c = reconJson.cams[k];
        return { i, ci: k, R: c.R, t: c.t, f: c.f, w, h, cx: w / 2, cy: h / 2,
                 url: p.url, name: p.name, state: 'placed', feats: 0, psnr: null };
      });
    } else {
      // pano rigs: frames are sliced faces (name_fN) of the source
      // panoramas — the strip shows ONE card per pano, and clicking flies
      // to that station (no photo overlay: equirect vs pinhole never match)
      const panoish = Array.isArray(source.urls) && source.urls.length &&
        frames.length > source.names.length && source.urls.every(Boolean) &&
        /_f\d+$/.test(String((frames[0] || {}).name || ''));
      S.isPanoSet = !!panoish;
      if (panoish && reconJson) {
        const baseName = (n) => String(n).replace(/\.[^.]+$/, '');
        const idxOf = new Map(source.names.map((n, i) => [baseName(n), i]));
        const best = new Array(source.names.length).fill(null);   // {k, face}
        reconJson.cams.forEach((c, k) => {
          const m = String((frames[c.imgIdx] || {}).name || '').match(/^(.*)_f(\d+)$/);
          if (!m) return;
          const si = idxOf.get(m[1]);
          if (si == null) return;
          if (!best[si] || +m[2] < best[si].face) best[si] = { k, face: +m[2] };
        });
        S.photos = source.names.map((n, i) => ({ url: source.urls[i], name: n }));
        cams = S.photos.map((p, i) => {
          const b = best[i];
          if (!b) return { i, ci: -1, R: null, t: null, url: p.url, name: p.name,
                           w: 4, h: 3, cx: 2, cy: 1.5, state: 'unplaced', feats: 0, psnr: null };
          const c = reconJson.cams[b.k];
          const fr = frames[c.imgIdx] || {};
          const w = fr.fw || 1000, h = fr.fh || 1000;
          return { i, ci: b.k, R: c.R, t: c.t, f: c.f, w, h, cx: w / 2, cy: h / 2,
                   url: p.url, name: p.name, state: 'placed', feats: 0, psnr: null, pano: true };
        });
      } else {
        S.photos = [];      // bare models: no photographs at all
        cams = (reconJson ? reconJson.cams : []).map((c, ci) => {
          const fr = frames[c.imgIdx] || {};
          const w = fr.fw || 1000, h = fr.fh || 1000;
          return { i: ci, ci, R: c.R, t: c.t, f: c.f, w, h, cx: w / 2, cy: h / 2,
                   state: 'placed', feats: 0, name: c.name };
        });
      }
    }
    // viewer mode: the strip is visible UI — thumbs lazy-load for the tiles
    // in view (deferral is for the card flows, where the strip is covered).
    // A share may carry a packed thumbnail zip: one small fetch feeds the
    // whole strip instead of N full training photographs.
    S._thumbsUrl = (source && source.thumbs) || null;
    S._thumbPack = null;
    buildStrip();
    const cl = (reconJson && reconJson.cloud) || { xyz: [], rgb: [] };
    let center = reconJson && reconJson.center;
    let radius = (reconJson && reconJson.sceneRadius) || ses.model.radius;
    if (!center && gaussians) {
      // bare model files carry no scene metadata — read it off the splats
      const d = gaussians.data, step = Math.max(1, Math.floor(gaussians.n / 20000)) * 16;
      let sx = 0, sy = 0, sz = 0, m = 0;
      for (let o = 0; o < gaussians.n * 16; o += step) { sx += d[o]; sy += d[o + 1]; sz += d[o + 2]; m++; }
      center = [sx / m, sy / m, sz / m];
      // median splat distance ~= the subject's scale; the max is always some
      // far background shell and would frame the camera way outside it
      const dists = [];
      for (let o = 0; o < gaussians.n * 16; o += step) {
        dists.push((d[o] - center[0]) ** 2 + (d[o + 1] - center[1]) ** 2 + (d[o + 2] - center[2]) ** 2);
      }
      dists.sort((a, b) => a - b);
      radius = Math.sqrt(dists[dists.length >> 1]) * 2;
    } else if (!center) {
      center = [0, 0, 0];
    }
    S.scene = {
      cams,
      xyz: Float32Array.from(cl.xyz), rgb: Uint8Array.from(cl.rgb),
      center, radius,
    };
    vp.setScene(S.scene);
    if (cams.length) vp.detectUp(cams);
    mountModelCanvas();
    S.atFrame = -1; S.fadeTo = 0;
    vp.lock = null; vp.freeF = null;
    const first = cams.find((c) => c.R);
    if (first) { vp.syncTo(first); vp.dist *= 1.15; } else vp.frameScene();
    // first person: the set's flag (stamp or recon) — and the DEFAULT for
    // 360 captures, which are made from inside the scene by construction
    vp.fpv = !!(S.fpvSet || (reconJson && reconJson.fpv) || S.isPanoSet);
    if (vp.fpv) vp.dist = Math.max(0.3, ((S.scene && S.scene.radius) || 10) * 0.1);
    $('stage').dataset.cursor = 'grab';
    $('btn-new').hidden = false;   // the way back to the front page
    renderControls();
    dock('');
    // ?frame=<i>(&cmp=): the link was shared from a frame focus — land
    // exactly there instead of flying the intro
    const fq = new URLSearchParams(location.search);
    const fi = parseInt(fq.get('frame'), 10);
    if (Number.isFinite(fi) && S.photos.length && fi >= 0 && fi < S.photos.length) {
      const cmp = fq.get('cmp');
      if (['swipe', 'loupe', 'error'].includes(cmp)) S.compare = cmp;
      select(fi);
    } else if (cams.length > 2) {
      startTour();
    }
    if (S._detailsFromUrl) { S._detailsFromUrl = false; openDetails(); }   // ?details=<tab> reopens the sheet
    // the stand-in hero image fades once the model actually renders — for
    // the SOG-lite viewer that is when the asset finishes streaming
    const hero = document.getElementById('share-hero');
    if (hero) {
      Promise.resolve(ses._boot).then(() => {
        hero.classList.add('gone');
        setTimeout(() => hero.remove(), 700);
      });
    }
    flash(`Loaded ${fmt(nSplats)} splats — ${S.preset.name}.`, 5000);
  } catch (e) {
    console.error(e);
    loadFailed('That model couldn\'t be shown', e.message);
  }
}

// ── ?perf: the timing log as a downloadable text file ───────────────────────
function pctl(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function buildPerfReport() {
  const ses = S.session;
  const gi = (ses.gpu && ses.gpu.info) || {};
  const rows = (ses.perf && ses.perf.frames) || [];
  const marks = (ses.perf && ses.perf.marks) || [];
  const fr0 = ses.frames[0] || {};
  const L = [];
  L.push(`splat.js perf log — ${new Date().toISOString()}`);
  L.push(`url: ${location.href}`);
  L.push(`ua: ${navigator.userAgent}`);
  L.push(`gpu: ${[gi.vendor, gi.architecture, gi.device].filter(Boolean).join(' ') || 'unknown'}`);
  L.push(`screen: ${screen.width}x${screen.height} @dpr ${devicePixelRatio}`);
  L.push(`photos: ${S.photos.length} · placed ${ses.recon ? ses.recon.cams.length : '?'} · training res ${fr0.tw}x${fr0.th}`);
  L.push(`settings: ${JSON.stringify(S.settings)} · preset ${S.preset ? S.preset.id : '?'}`);
  L.push(`splats: ${fmt(S.splats)} · holdout psnr ${S.psnrHold != null ? S.psnrHold.toFixed(2) : '—'} dB`);
  L.push(`tileGrad: ${ses.trainer ? ses.trainer.tileGrad : '?'} · maxIters ${S.maxIters}`);
  if (rows.length > 1) {
    const t0 = rows[0][0], t1 = rows[rows.length - 1][0];
    const iters = rows[rows.length - 1][1] - rows[0][1];
    L.push(`wall: ${((t1 - t0) / 1000).toFixed(1)}s for ${iters} iters -> ${(iters / Math.max(.001, (t1 - t0) / 1000)).toFixed(1)} it/s`);
    const col = (i) => rows.map((r) => r[i]);
    L.push(`per frame (batch med ${pctl(col(2), .5)}):`);
    const stat = (name, i) =>
      L.push(`  ${name} med ${pctl(col(i), .5).toFixed(1)}ms  p90 ${pctl(col(i), .9).toFixed(1)}ms  max ${Math.max(...col(i)).toFixed(1)}ms`);
    stat('encode ', 4);
    stat('view   ', 5);
    stat('fence  ', 6);
    stat('metrics', 7);
    stat('total  ', 8);
  }
  L.push('', 'frames: t_ms iter batch splats enc view fence met total');
  for (const r of rows) L.push('  ' + r.join(' '));
  L.push('', 'refines: t_ms iter ms moved grown');
  for (const m of marks) L.push(`  ${m.t} ${m.iter} ${m.ms} ${m.moved} ${m.grown}`);
  L.push('', 'metrics: t_ms iter it/s psnrTrain psnrHold');
  for (const m of S.perfMetrics || []) L.push('  ' + m.join(' '));
  return L.join('\n');
}

/** clipboard copy with feedback on the button itself — a flash would be
 *  hidden behind the details sheet */
async function copyPerfLog(btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(buildPerfReport());
    btn.textContent = 'Copied ✓';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = old; }, 1600);
}

function downloadPerfLog() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buildPerfReport()], { type: 'text/plain' }));
  a.download = `splatjs_perf_${new Date().toISOString().replace(/\W/g, '').slice(0, 15)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function perfCard() {
  document.getElementById('perfcard')?.remove();
  const txt = buildPerfReport();
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'perfcard';
  card.innerHTML = `
    <b>Perf run complete</b>
    <pre class="perfpre">${txt.split('\nframes:')[0].replace(/</g, '&lt;')}</pre>
    <div class="upcard-row">
      <button class="btn btn-quiet" id="perf-close">Close</button>
      <button class="btn btn-quiet" id="perf-copy">Copy</button>
      <button class="btn btn-accent" id="perf-dl">Download log</button>
    </div>`;
  $('stage').appendChild(card);
  card.querySelector('#perf-close').addEventListener('click', () => card.remove());
  card.querySelector('#perf-copy').addEventListener('click', (e) => copyPerfLog(e.currentTarget));
  card.querySelector('#perf-dl').addEventListener('click', downloadPerfLog);
}

/** after the run: an honest per-photograph score, filled in the background */
async function scoreFrames() {
  const gen = S.gen;
  for (const c of S.scene.cams) {
    if (c.ci < 0 || S.gen !== gen || S.state !== 'done') return;
    try {
      c.psnr = await S.session.evalFramePsnr(c.ci);
      paintStrip();
      if (!$('details').hidden) renderDetails();
    } catch { return; }
  }
}

// ── stage controls (train/done) ─────────────────────────────────────────────
function seg(items, active, onPick) {
  const d = document.createElement('div');
  d.className = 'seg';
  items.forEach(([val, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(val === active));
    b.addEventListener('click', () => onPick(val));
    d.appendChild(b);
  });
  return d;
}

const cursorFor = (m) => (m === 'loupe' ? 'loupe' : m === 'swipe' ? 'swipe' : 'grab');

function renderControls() {
  const c = $('controls');
  c.innerHTML = '';
  const live = S.state === 'train' || S.state === 'done';
  c.hidden = !live;
  if (!live) return;

  if (S.atFrame >= 0) {
    c.appendChild(seg([['swipe', 'Swipe'], ['loupe', 'Loupe'], ['error', 'Error']],
      S.compare, (v) => {
        S.compare = v;
        $('stage').dataset.cursor = cursorFor(v);
        renderControls();
        syncFrameUrl();
      }));
  }

  if (S.state !== 'done') return;

  const play = document.createElement('button');
  play.className = 'iconbtn';
  play.id = 'c-play';
  play.title = 'Fly the capture path';
  play.setAttribute('aria-label', 'Fly the capture path');
  play.innerHTML = '<svg viewBox="0 0 24 24" class="pl" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
  play.addEventListener('click', () => {
    if (S.tour) { stopTour(); return; }  // playing -> the same button stops
    if (S.atFrame >= 0) leaveFrame();    // play works from the compare modes too
    startTour(true);
  });
  c.appendChild(play);

  if (!S.restored && !S.sogBlob && S.session && S.session.trainer && S.session.trainer.device) {
    // the web-delivery format is optional and costs real GPU time (k-means
    // on a second device) — the creator starts it, never the finish
    const sog = document.createElement('button');
    sog.className = 'cbtn';
    sog.id = 'c-sog';
    sog.textContent = 'Compress';
    sog.title = 'Compress to .sog — 10-20x smaller, for sharing and the web';
    sog.addEventListener('click', async () => {
      try {
        const blob = await getSogBlob();
        flash(`${fmt(S.splats)} splats compressed to ${(blob.size / 1e6).toFixed(1)} MB — Share and Download .sog are instant now.`, 5000);
      } catch (e) {
        console.error(e);
        flash(`SOG compression failed: ${e.message}`, 6000);
      }
    });
    c.appendChild(sog);
  }

  const stats = document.createElement('button');
  stats.className = 'statchip';
  stats.innerHTML = `<span><b>${fmt(S.splats)}</b> splats</span>` +
    (S.psnrHold != null ? `<span><b>${S.psnrHold.toFixed(1)}</b> dB</span>` : '') +
    '<i>Details ›</i>';
  stats.addEventListener('click', openDetails);
  c.appendChild(stats);
  if (!S.restored) {
    // a restored model has no training targets in this tab — viewing and
    // exporting work, continuing the run does not (yet)
    const more = document.createElement('button');
    more.className = 'cbtn';
    more.textContent = 'Train';
    more.title = 'Continue training — the schedules stretch to the longer run';
    more.addEventListener('click', continueTraining);
    c.appendChild(more);
  }
  if (S.share) {
    // a shared creation is also a walkable arrival space — one click away
    const enter = document.createElement('a');
    enter.className = 'cbtn';
    enter.href = `https://arrival.space/${encodeURIComponent(S.share.id)}`;
    enter.target = '_blank';
    enter.rel = 'noopener';
    // the arrival mark from the top bar leads the label — same place, same sign
    const mark = document.querySelector('.brand-mark svg');
    if (mark) {
      const m = mark.cloneNode(true);
      m.classList.add('enter-mark');
      enter.appendChild(m);
    }
    enter.appendChild(document.createTextNode('Enter space'));
    enter.title = 'Walk this creation on arrival.space';
    c.appendChild(enter);
  }
  const rj = S.restored && S.restored.reconJson;
  if (rj && rj.source && rj.source.urls && rj.source.urls.length && rj.source.urls.every(Boolean)) {
    // the creation carries its photographs — the viewer can become the maker
    const train = document.createElement('button');
    train.className = 'cbtn accent';
    train.textContent = 'Train';
    train.title = `Solve and train the same ${rj.source.urls.length} photographs right here`;
    train.addEventListener('click', trainFromShare);
    c.appendChild(train);
  } else if (S._localRun && S._localRun.ownSrc) {
    // a local run of the visitor's own photos: continue on the model, or
    // start fresh from the capture kept on this device
    const train = document.createElement('button');
    train.className = 'cbtn accent';
    train.textContent = 'Train';
    train.title = 'Keep training this model, or train new from the saved photos';
    train.addEventListener('click', trainLocalChoice);
    c.appendChild(train);
  }
  c.appendChild(buildExport());
}

/** The local-run viewer's Train: continue refining the saved model, or a
 *  fresh solve from the photos in the capture store. */
function trainLocalChoice() {
  document.getElementById('ltchoice')?.remove();
  const r = S._localRun;
  const trainNew = async () => {
    const src = r && r.recon && r.recon.source;
    if (r && r.ownSrc) {
      const set = await openCaptureSet();
      if (!set) { flash('The photos are no longer stored on this device.', 6000); return; }
      stopTour();
      S.restored = null;
      await open(set);
      if (!WALL_FIRST) showDetail(set);
    } else if (src && Array.isArray(src.urls) && src.urls.length && src.urls.every(Boolean)) {
      // URL-backed run (a preset or a shared creation's photos): the set
      // rebuilds from the addresses kept with the record
      stopTour();
      S.restored = null;
      const n = src.urls.length;
      const set = {
        id: src.preset || '__url', name: r.name || 'Training run',
        kind: 'Saved run',
        origin: `${n} photographs kept with this run's record, fetched again to train from scratch.`,
        links: [], blurb: '', count: n,
        approx: n <= 20 ? '~3 min' : n <= 60 ? '~6 min' : '~10 min',
        urlList: src.names.map((nm, i) => ({ url: src.urls[i], name: nm })),
      };
      await open(set);
      if (!WALL_FIRST) showDetail(set);
    } else {
      flash('The photos are no longer stored on this device.', 6000);
    }
  };
  // nothing to continue (no checkpoint, no result): straight to the fresh solve
  if (!(r && (r.sog || (r.state && r.recon)))) { trainNew().catch((e) => { console.error(e); }); return; }
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'ltchoice';
  card.innerHTML = `
    <button class="card-x lt-x" id="lt-x" aria-label="Close">&times;</button>
    <b>Train these photos</b>
    <span class="lt-desc">Keep training refines the saved model further; Train new solves and
    trains from scratch with the photos kept on this device.</span>
    <div class="upcard-row">
      <button class="btn btn-accent" id="lt-cont">Keep training</button>
      <button class="btn btn-outline" id="lt-new">Train new</button>
    </div>`;
  $('stage').appendChild(card);
  $('lt-x').addEventListener('click', () => card.remove());
  $('lt-new').addEventListener('click', () => { card.remove(); trainNew().catch((e) => { console.error(e); }); });
  $('lt-cont').addEventListener('click', () => { card.remove(); continueLocalRun().catch((e) => {
    console.error(e);
    flash(`Could not continue this run: ${e.message}`, 8000);
  }); });
}

/** Continue training a stored local run: decode its sog back into raw
 *  Gaussians (un-baking the Mip opacity compensation — the export bakes it
 *  for standard viewers, the trainer applies it itself), rebuild the session
 *  from the stored camera solve + the capture's photos, and run on. */
/** viewOnly: reopen a FINISHED run from its state checkpoint straight into
 *  the done viewer (same run record, so Compress patches the sog in) */
async function continueLocalRun(viewOnly = false) {
  const lr = S._localRun;
  if (!lr || !lr.recon || !(lr.state || lr.sog)) return;
  const recon = lr.recon;
  let files;
  const srcUrls = (recon.source && recon.source.urls) || [];
  if (!lr.ownSrc && srcUrls.length && srcUrls.every(Boolean)) {
    // preset / shared runs: the photographs live at stable URLs — refetch
    flash('Fetching the photos …', 60000);
    files = await Promise.all(srcUrls.map(async (u, i) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`photo fetch failed (${r.status})`);
      return new File([await r.blob()], recon.source.names[i], { type: 'image/jpeg' });
    }));
  } else {
    const rec = await loadLastCapture();
    if (!rec || !rec.files) { flash('The photos are no longer stored on this device.', 6000); return; }
    // photos matched BY NAME to the run's own frame order — re-sorting could
    // reorder against recon.cams imgIdx, and a newer capture must not sneak in
    const byName = new Map(rec.files.map((e) => [e.name, e]));
    files = (recon.frames || []).map((fr) => {
      const e = byName.get(fr.name);
      return e ? new File([e.blob], e.name, { type: e.blob.type || 'image/jpeg' }) : null;
    });
    if (!files.length || files.some((f) => !f)) {
      flash('The stored photos no longer match this run — Train new instead.', 7000);
      return;
    }
  }
  flash('Preparing to continue training …', 60000);
  let g, engine, stateIter = null;
  if (lr.state) {
    // pause checkpoint: the trainer's raw floats — nothing baked, nothing
    // quantized, tagged with the engine that wrote them. Bit-exact resume.
    const { parseState } = await import('./session_io.js');
    const st = parseState(new Uint8Array(await lr.state.arrayBuffer()));
    g = st.gaussians; engine = st.engine; stateIter = st.iter;
  } else {
    const { decodeModel } = await import('./session_io.js');
    ({ gaussians: g } = await decodeModel(new Uint8Array(await lr.sog.arrayBuffer()), null));
  }
  // un-bake opacity compensation (pure fn of position, mean scale, focal,
  // camera centres — recompute and divide out in logit space); only sog/ply
  // exports carry the baking, the raw checkpoint never does. Under the
  // placement set the trainer has no Mip compensation, so its exports were
  // never baked and there is nothing to divide out (a comp-trained share
  // continued under the set keeps its baked opacities — experimental).
  if (!lr.state && !PLACEMENT_ON) {
    const pos = [];
    for (const c of recon.cams) {
      const R = c.R, t = c.t;
      pos.push(
        -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
        -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
        -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]));
    }
    const fr0 = recon.frames[recon.cams[0].imgIdx];
    const f = recon.cams[0].f * ((fr0.tw || fr0.fw) / fr0.fw);
    const d = g.data;
    for (let i = 0; i < g.n; i++) {
      const b = i * 16;
      let z2 = Infinity;
      for (let c = 0; c < pos.length; c += 3) {
        const dx = d[b] - pos[c], dy = d[b + 1] - pos[c + 1], dz = d[b + 2] - pos[c + 2];
        const q = dx * dx + dy * dy + dz * dz;
        if (q < z2) z2 = q;
      }
      const z = Math.max(1e-3, Math.sqrt(z2));
      const sMean = Math.exp((d[b + 3] + d[b + 4] + d[b + 5]) / 3);
      const s2d = f * sMean / z;
      const comp = (s2d * s2d) / (s2d * s2d + 0.3);
      const opa = 1 / (1 + Math.exp(-d[b + 13]));
      const raw = Math.min(1 - 1e-6, Math.max(1e-6, opa / Math.max(comp, 1e-6)));
      d[b + 13] = Math.log(raw / (1 - raw));
    }
  }
  // tear down the viewer, build the training session (trainFromShare's reset)
  stopTour();
  $('start').hidden = true;   // a paused tile resumes straight from the wall
  try { S.session.dispose(); } catch (e) { /* view-only facade */ }
  document.getElementById('cv-model')?.remove();
  gpuCanvas = null;
  S.gen++;
  const gen = S.gen;
  S.session = null; S.share = null; S.restored = null;
  S._viewerOpen = false;
  S._fromSpace = null;
  S._thumbsUrl = null; S._thumbPack = null;
  if (history.state && history.state.sj) history.replaceState(null, '');
  S.plyBlob = null; S.sogBlob = null;
  // keep the source identity: own captures stay '__own' (the next resume goes
  // back to the capture store), URL-backed runs keep their preset/urls so a
  // pause during THIS run checkpoints a resumable source list again
  S.preset = lr.ownSrc
    ? { id: '__own', name: `${lr.name || 'Your photos'}` }
    : { id: (recon.source && recon.source.preset) || '__url', name: `${lr.name || 'Your photos'}` };
  S.loadedFiles = files.map((f, i) => Object.assign(f, { url: srcUrls[i] || undefined }));
  S.photos = files.map((f, i) => ({ url: URL.createObjectURL(f), name: f.name, i }));
  const baseIter = stateIter ?? (lr.iter || 0);
  // a finished run continues PAST its old horizon; a paused one resumes
  // toward the horizon it was already aiming at
  S.maxIters = lr.status !== 'finished' && lr.maxIters > baseIter
    ? lr.maxIters
    : baseIter + Math.max(10000, Math.round((lr.maxIters || 20000) / 2));
  const fr0 = recon.frames[0] || {};
  const cap = Math.max(g.n, lr.splats || 0, lr.status !== 'finished' ? lr.cap || 0 : 0);
  const ses = createSession({
    maxIters: S.maxIters, holdout: -1,
    frames: { trainMaxDim: Math.max(fr0.tw || 0, fr0.th || 0) || undefined },
    trainer: {
      maxSplats: cap, shDeg: 3,
      capMult: Math.max(2, Math.ceil(cap / Math.max(1, g.n))),
      ...(engine === 'v2' ? { engine: 'v2', refineEvery: 200 } : {}),
    },
  });
  S.session = ses;
  ses.on('stage', (e) => { if (S.gen === gen) onStage(e); });
  ses.on('metrics', (e) => { if (S.gen === gen) onMetrics(e); });
  ses.on('event', (e) => { if (S.gen === gen) onTrainEvent(e); });
  await ses.load(files);
  if (S.gen !== gen) return;
  ses.useReconstruction({
    cams: recon.cams.map((c) => ({ imgIdx: c.imgIdx, R: c.R, t: c.t, f: c.f, cx: c.cx, cy: c.cy })),
    points: [],
    k1: recon.k1 || 0, k2: recon.k2 || 0,
    ...(recon.fFeat ? { fFeat: recon.fFeat } : {}),
  });
  if (undistortFrames(ses.frames, ses.recon)) { /* targets match the original run */ }
  await ses.seedFrom(g, { iter: baseIter });
  if (S.gen !== gen) return;
  S.iter = baseIter;
  S.psnrTrain = null; S.psnrHold = null;
  S.holdHist = []; S.chartEvents = []; S.growthStopped = false;
  buildSceneFromSession();
  mountModelCanvas();
  if (viewOnly) {
    S.maxIters = baseIter;
    S.runId = lr.id;
    S.minutes = lr.minutes || 0;
    S.psnrTrain = lr.psnr ?? null;
    S.splats = g.n;
    S.trainT0 = performance.now();
    enterDone();
    flash(`${fmt(g.n)} splats — Compress turns this into a shareable .sog`, 6000);
    return;
  }
  if (lr.state && lr.status !== 'finished') S._resumeRunId = lr.id;
  startTraining();
  flash(`Continuing from ${fmt(baseIter)} cycles — +${fmt(S.maxIters - baseIter)} more.`, 6000);
}

/** Resume from done: raise the horizon, restore the curve, back to train. */
function continueTraining() {
  if (!S.session || S.state !== 'done') return;
  stopTour();
  S.plyBlob = null; S.sogBlob = null;   // the cached export goes stale the moment training resumes
  S.etaAt = null;
  S.maxIters = S.session.continueFor(MORE_ITERS);
  S.state = 'train';
  S.trainT0 = performance.now() - S.minutes * 60000;   // minutes stay cumulative
  S.growthStopped = false;
  S.atFrame = -1; S.fadeTo = 0;
  vp.lock = null;
  $('stage').dataset.cursor = 'grab';
  renderControls();
  dock('train');
  if (chart) {
    chart.train = S.session.lossHistory.map(([i, v]) => [i, v]);
    chart.hold = (S.holdHist || []).slice();
    chart.maxIter = S.maxIters;
    chart.draw();
  }
  paintStrip();
}

const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" class="dl">' +
  '<path d="M22 15.3333V19.7777C22 20.3671 21.7659 20.9323 21.3491 21.349C20.9324 21.7658 20.3671 21.9999 19.7778 21.9999H4.22222C3.63285 21.9999 3.06762 21.7658 2.65087 21.349C2.23413 20.9323 2 20.3671 2 19.7777V15.3333"/>' +
  '<path d="M6.44449 9.77745L12 15.333M12 15.333L17.5556 9.77745M12 15.333L12 1.99967"/></svg>';

/** The model as a compressed .sog Blob — converted once per run (cached),
 *  with a proper progress card: the compression takes real time on big
 *  models and the writer reports its stages. */
async function getSogBlob() {
  if (S.sogBlob) return S.sogBlob;
  // ONE compression per run: a second request (Download .sog while Share is
  // compressing, or the old auto-compress at finish) used to start a second
  // k-means job on a second GPU device
  if (S._sogJob && S._sogJob.gen === S.gen) return S._sogJob.p;
  const gen = S.gen;
  const p = compressSog(gen).finally(() => { if (S._sogJob && S._sogJob.gen === gen) S._sogJob = null; });
  S._sogJob = { gen, p };
  return p;
}

async function compressSog(gen) {
  // the viewer is not navigable while the compressor owns the GPU — pause
  // the tour instead of rendering into the stall, resume it afterwards
  const wasTour = !!S.tour;
  stopTour();
  const ply = S.plyBlob || await S.session.exportPlyBlob();
  if (S.gen !== gen) throw new Error('run changed');
  S.plyBlob = ply;
  document.getElementById('sogcard')?.remove();
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'sogcard';
  card.innerHTML = `
    <b>Compressing to .sog</b>
    <span class="sog-status" id="sog-status">Reading the model …</span>
    <div class="prep-meter"><i id="sog-bar" style="width:0%"></i></div>`;
  $('stage').appendChild(card);
  try {
    const { plyToSog } = await import('./sog.js');
    const bytes = new Uint8Array(await ply.arrayBuffer());
    const blob = await plyToSog(bytes, {
      onProgress: ({ label, frac }) => {
        const st = document.getElementById('sog-status');
        const bar = document.getElementById('sog-bar');
        if (st && label) st.textContent = label;
        if (bar && frac != null) bar.style.width = `${(frac * 100).toFixed(1)}%`;
      },
    });
    if (S.gen !== gen) throw new Error('run changed');
    S.sogBlob = blob;
    renderControls();   // the Compress button has done its job
    // the library record: sog in, the raw state checkpoint out (10-20x
    // smaller, and the sog is what the wall tile opens)
    if (S.runId) {
      try {
        const { buildReconJson } = await import('./session_io.js');
        const { patchRun } = await import('./store.js');
        await patchRun(S.runId, {
          sog: blob, recon: buildReconJson(S), splats: S.splats,
          psnr: S.psnrHold ?? S.psnrTrain ?? null,
          state: null, ckptAt: null,
        });
      } catch (e) { console.warn('local save failed', e); }
    }
    return blob;
  } finally {
    document.getElementById('sogcard')?.remove();
    if (wasTour && S.gen === gen && S.state === 'done' && !S.tour) startTour(true);
  }
}

function buildExport() {
  const mb = (S.splats * 164 / 1e6).toFixed(1); // 41 float properties per splat (SH deg 2)
  const sogMb = (S.splats * 164 / 1e6 / 15).toFixed(1); // SOG lands around 1/15th
  const wrap = document.createElement('div');
  wrap.className = 'exportwrap';
  wrap.innerHTML = `
    <button class="iconbtn" title="Export" aria-label="Export">${DL_ICON}</button>
    <div class="menu" hidden>
      ${S.restored ? '' : `<button data-act="share"><b>Share</b><span>One link — viewer, compare and a space to enter</span></button>`}
      <button data-act="arr"><b>Upload to Arrival.Space</b><span>Straight into a space of yours</span></button>
      <button data-act="sog"><b>Download .sog</b><span>Compressed for the web · ~${sogMb} MB</span></button>
      ${S.lodPlan && S.lodPlan.snaps.length ? `<button data-act="lod"><b>Download LOD</b><span>Streamed SOG, ${S.lodPlan.snaps.length + 1} detail levels · zip</span></button>` : ''}
      <button data-act="ply"><b>Download .ply</b><span>Standard splat file · ${mb} MB</span></button>
      ${S.restored ? '' : `<button data-act="session"><b>Download session</b><span>Re-loadable + resumable · sog, poses, raw state</span></button>`}
      <button data-act="imgs"><b>Download photos</b><span>The ${S.loadedFiles ? S.loadedFiles.length : 0} training images · zip</span></button>
    </div>`;

  const menu = wrap.querySelector('.menu');
  wrap.querySelector('.iconbtn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu').forEach((m) => { if (m !== menu) m.hidden = true; });
    menu.hidden = !menu.hidden;
  });
  const download = (blob, ext) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(S.preset.name || 'splat').toLowerCase().replace(/\W+/g, '_')}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  wrap.querySelector('[data-act="ply"]').addEventListener('click', async () => {
    menu.hidden = true;
    download(S.plyBlob || await S.session.exportPlyBlob(), 'ply');
    flash(`${fmt(S.splats)} splats on their way to your downloads.`, 3500);
  });
  wrap.querySelector('[data-act="sog"]').addEventListener('click', async () => {
    menu.hidden = true;
    try {
      const blob = await getSogBlob();
      download(blob, 'sog');
      flash(`${fmt(S.splats)} splats compressed to ${(blob.size / 1e6).toFixed(1)} MB.`, 4000);
    } catch (e) {
      console.error(e);
      flash(`SOG compression failed: ${e.message}`, 6000);
    }
  });
  wrap.querySelector('[data-act="lod"]')?.addEventListener('click', async () => {
    menu.hidden = true;
    try {
      document.getElementById('sogcard')?.remove();
      const card = document.createElement('div');
      card.className = 'upcard';
      card.id = 'sogcard';
      card.innerHTML = `
        <b>Building the streamed LOD</b>
        <span class="sog-status" id="sog-status">Reading the levels …</span>
        <div class="prep-meter"><i id="sog-bar" style="width:0%"></i></div>`;
      $('stage').appendChild(card);
      const { plysToLodEntries } = await import('./sog.js');
      // finest first (LOD 0 = the full model), then the snapshots descending
      const full = S.plyBlob || await S.session.exportPlyBlob();
      const levels = [new Uint8Array(await full.arrayBuffer())];
      for (const snap of [...S.lodPlan.snaps].reverse()) {
        levels.push(new Uint8Array(await snap.blob.arrayBuffer()));
      }
      const entries = await plysToLodEntries(levels, {
        onProgress: ({ label, frac }) => {
          const st2 = document.getElementById('sog-status');
          const bar = document.getElementById('sog-bar');
          if (st2 && label) st2.textContent = label;
          if (bar && frac != null) bar.style.width = `${(frac * 100).toFixed(1)}%`;
        },
      });
      const zip = zipStore(entries.map(([name, data]) => ({ name: name.replace(/^\//, ''), data })));
      document.getElementById('sogcard')?.remove();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip);
      a.download = `${(S.preset.name || 'splat').toLowerCase().replace(/\W+/g, '_')}_lod.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      flash(`Streamed LOD with ${levels.length} levels · ${(zip.size / 1e6).toFixed(1)} MB zipped.`, 5000);
    } catch (e) {
      document.getElementById('sogcard')?.remove();
      console.error(e);
      flash(`LOD build failed: ${e.message}`, 6000);
    }
  });
  wrap.querySelector('[data-act="arr"]').addEventListener('click', () => {
    menu.hidden = true;
    if (!S.uploading) uploadDialog();
  });
  wrap.querySelector('[data-act="share"]')?.addEventListener('click', () => {
    menu.hidden = true;
    if (!S.uploading) shareDialog();
  });
  wrap.querySelector('[data-act="session"]')?.addEventListener('click', async () => {
    menu.hidden = true;
    try {
      const sog = await getSogBlob();
      flash('Packing the session …', 60000);
      const zip = await buildSessionZip(S, sog);
      download(zip, 'session.zip');
      flash(`Session saved · ${(zip.size / 1e6).toFixed(1)} MB. Load it back with ` +
        `?model=<url> or by dropping it on the app.`, 7000);
    } catch (e) {
      console.error(e);
      flash(`Session save failed: ${e.message}`, 6000);
    }
  });
  wrap.querySelector('[data-act="imgs"]').addEventListener('click', async () => {
    menu.hidden = true;
    if (!S.loadedFiles || !S.loadedFiles.length) { flash('No source images in this run.'); return; }
    flash('Packing your photos …', 60000);
    const entries = [];
    for (const f of S.loadedFiles) {
      const blob = f.source || f;
      entries.push({ name: f.name, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const zip = zipStore(entries);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = `${(S.preset.name || 'capture').toLowerCase().replace(/\W+/g, '_')}_photos.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    flash(`${entries.length} photos zipped and on their way.`, 4000);
  });
  return wrap;
}

/** Ask for the space's title (a default is prefilled), then upload. The
 *  sign-in window MUST be opened synchronously inside the Upload click —
 *  after any await it would be popup-blocked. The finished space is
 *  presented as a link, never auto-opened. */
function uploadDialog() {
  document.getElementById('upcard')?.remove();
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'upcard';
  card.innerHTML = `
    <b>Upload to Arrival.Space</b>
    <input id="up-title" type="text" spellcheck="false" maxlength="80">
    <div class="upcard-row">
      <button class="btn btn-quiet" id="up-cancel">Cancel</button>
      <button class="btn btn-accent" id="up-go">Upload</button>
    </div>`;
  $('stage').appendChild(card);
  const input = card.querySelector('#up-title');
  input.value = S.preset.id === '__own' ? 'My splat' : S.preset.name;
  input.focus();
  input.select();
  const close = () => card.remove();
  card.querySelector('#up-cancel').addEventListener('click', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') card.querySelector('#up-go').click();
    if (e.key === 'Escape') close();
  });
  card.querySelector('#up-go').addEventListener('click', async () => {
    const title = input.value.trim() || 'My splat';
    // synchronously, inside the click: the sign-in window (about:blank now,
    // the login page once the auth URL is built)
    const popup = hasToken() ? null : window.open('', 'arrival-oauth', 'width=480,height=720');
    close();
    if (!hasToken() && !popup) {
      flash('The sign-in window was blocked — allow popups for this site and try again.', 8000);
      return;
    }
    S.uploading = true;
    try {
      // uploads are always SOG-compressed — 10-20x smaller on the wire and
      // the space streams it natively
      const blob = await getSogBlob();
      const { spaceUrl } = await sendToArrival(blob, title, {
        ext: 'sog',
        popup,
        onStatus: (m) => flash(m, 120000),
        onProgress: (pct) => flash(`Uploading … ${pct}%`, 120000),
      });
      flash(`${title} is live`, 300000, [
        { label: 'Open your space ↗', href: spaceUrl, blank: true },
      ]);
    } catch (e) {
      console.error(e);
      if (popup && !popup.closed) popup.close();
      flash(`Upload failed: ${e.message}`, 9000);
    } finally {
      S.uploading = false;
    }
  });
}

/** Share the finished run: one link that opens the viewer (tour + compare
 *  + stats) with an arrival space behind it. Same sign-in as Upload. */
function shareDialog(rec = null) {
  // rec: share a STORED local scene (sog + recon + thumb from IndexedDB) —
  // no live session required
  document.getElementById('upcard')?.remove();
  const card = document.createElement('div');
  card.className = 'upcard';
  card.id = 'upcard';
  // preset photographs already live on public URLs — only own captures
  // need uploading for the viewer-side comparison
  const needsPhotos = !rec && (!(S.loadedFiles || []).length || !(S.loadedFiles || []).every((f) => f.url));
  const photoMb = ((S.loadedFiles || []).reduce((a, f) => a + ((f.source || f).size || 0), 0) / 1e6).toFixed(0);
  card.innerHTML = `
    <b>Share this creation</b>
    <input id="sh-title" type="text" spellcheck="false" maxlength="80">
    <label class="upcard-opt"><select id="sh-priv">
      <option value="Public">Public — listed in the gallery</option>
      <option value="Link Only">Anyone with the link</option>
    </select></label>
    ${needsPhotos && (S.loadedFiles || []).length ? `
    <label class="upcard-opt"><input type="checkbox" id="sh-photos">
      Include the ${S.loadedFiles.length} photographs (${photoMb} MB) so viewers can compare</label>` : ''}
    <div class="upcard-row">
      <button class="btn btn-quiet" id="sh-cancel">Cancel</button>
      <button class="btn btn-accent" id="sh-go">Share</button>
    </div>`;
  $('stage').appendChild(card);
  const input = card.querySelector('#sh-title');
  input.value = rec ? (rec.name || 'Local Scene')
    : (S.preset.id === '__own' ? 'My splat' : S.preset.name);
  input.focus();
  input.select();
  const close = () => card.remove();
  card.querySelector('#sh-cancel').addEventListener('click', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') card.querySelector('#sh-go').click();
    if (e.key === 'Escape') close();
  });
  card.querySelector('#sh-go').addEventListener('click', async () => {
    const title = input.value.trim() || 'My splat';
    const privacy = card.querySelector('#sh-priv').value;
    const includePhotos = !!card.querySelector('#sh-photos')?.checked;
    const popup = hasToken() ? null : window.open('', 'arrival-oauth', 'width=480,height=720');
    close();
    if (!hasToken() && !popup) {
      flash('The sign-in window was blocked — allow popups for this site and try again.', 8000);
      return;
    }
    S.uploading = true;
    try {
      const { shareCreation } = await import('./share.js');
      const sog = rec ? rec.sog : await getSogBlob();
      const thumb = rec ? (rec.thumb || null) : ((await photoThumb()) || (await renderShareThumb()));
      const { spaceId, spaceUrl, link } = await shareCreation(S, sog, {
        title, privacy, includePhotos, thumbBlob: thumb, popup,
        ...(rec ? { recon: rec.recon } : {}),
        onStatus: (m) => flash(m, 120000),
        onProgress: (pct) => flash(`Uploading … ${pct}%`, 120000),
      });
      flash(`${title} is shared`, 300000, [
        { label: 'View link', href: link },
        { label: 'Enter the space ↗', href: spaceUrl, blank: true },
        { label: 'Copy link', copy: link },
      ]);
    } catch (e) {
      console.error(e);
      if (popup && !popup.closed) popup.close();
      flash(`Share failed: ${e.message}`, 9000);
    } finally {
      S.uploading = false;
    }
  });
}

/** The gallery hero is the capture's FIRST PHOTOGRAPH, downscaled — the
 *  real image, not a model render. */
async function photoThumb() {
  try {
    const p = S.photos && S.photos[0];
    if (!p) return null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = p.url;
    await img.decode();
    const W = Math.min(640, img.naturalWidth);
    const H = Math.max(1, Math.round(W * img.naturalHeight / img.naturalWidth));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    cv.getContext('2d').drawImage(img, 0, 0, W, H);
    return await new Promise((res) => cv.toBlob(res, 'image/webp', 0.85));
  } catch (e) {
    return null; // tainted canvas / missing photo -> fall back to a render
  }
}

/** Fallback when no photograph is reachable: a ~640px view render from the
 *  first registered camera's pose. */
async function renderShareThumb() {
  try {
    const ses = S.session;
    // the hero is the first registered camera's own view — the shot the
    // creator opened the capture with
    const c = S.scene.cams.find((k) => k.R) || null;
    if (!c) return null;
    // the thumb wears the hero camera's own aspect — a portrait scene
    // rendered into a landscape frame pads itself with unreconstructed
    // darkness that no display-side crop can remove
    const ar = (c.w && c.h) ? c.w / c.h : 1.6;
    const W = ar >= 1 ? 640 : Math.max(240, Math.round(400 * ar));
    const H = Math.round(W / ar);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    ses.view.attach(cv);
    ses.view.setCamera({ R: c.R, t: c.t, f: c.f * (W / c.w), cx: W / 2, cy: H / 2, w: W, h: H });
    ses.view.renderNow();
    await ses.trainer.device.queue.onSubmittedWorkDone();
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    out.getContext('2d').drawImage(cv, 0, 0);
    if (gpuCanvas) { ses.view.attach(gpuCanvas); S._viewKey = ''; }
    return await new Promise((res) => out.toBlob(res, 'image/webp', 0.85));
  } catch (e) {
    console.error(e);
    return null;
  }
}

/** ?space=<id>: a shared creation — resolve it (public endpoint, honors the
 *  space's privacy) and present it like a finished run. */
async function restoreShared(spaceId) {
  try {
    $('start').hidden = true;
    flash('Loading the shared creation …', 120000);
    const { resolveShare } = await import('./share.js');
    const sh = await resolveShare(spaceId);
    S.share = { id: spaceId, title: sh.title };
    // the tile's image is already in the browser cache — let it stand in
    // for the model while the SOG streams
    const heroSrc = (sh.splatjs && sh.splatjs.thumbUrl) || sh.screenshotUrl;
    if (heroSrc) {
      document.getElementById('share-hero')?.remove();
      const hero = Object.assign(new Image(), { src: heroSrc, id: 'share-hero', alt: '' });
      $('stage').insertBefore(hero, $('stage').firstChild);
    }
    S.fpvSet = !!sh.splatjs.fpv;   // per-set: first-person controls
    await restoreSession({ url: sh.splatjs.sogUrl, reconUrl: sh.splatjs.reconUrl });
    renderControls();
  } catch (e) {
    console.error(e);
    S.share = null;
    // boot skips mountWall while a share link loads — loadFailed mounts the
    // feed properly and says what happened on a real card
    loadFailed('That shared creation didn\'t load', e.message);
  }
}

/** Viewing is the detail card's primary action when a trained model exists;
 *  Start training steps back to the outline style there. Cards without a
 *  View button keep Start as the accent. */
function setStartStyle(primary) {
  const b = $('btn-go');
  b.classList.toggle('btn-accent', primary);
  b.classList.toggle('btn-cta', primary);
  b.classList.toggle('big', primary);
  b.classList.toggle('btn-outline', !primary);
  b.textContent = primary ? 'Start training' : 'Train locally';
}

/** The stat strip under the detail hero. Before a run starts it describes
 *  the INPUT — how many photographs, at what resolution — plus at most the
 *  train PSNR of the published model. Facts live in S.detailFacts and the
 *  strip repaints as they trickle in (hero decode, share resolve). */
function paintDetailStats() {
  const el = $('detail-stats');
  const f = S.detailFacts || {};
  const cells = [];
  if (f.frames) cells.push([fmt(f.frames), f.framesLabel || 'photographs']);
  if (f.res) cells.push([f.res, 'resolution']);
  if (f.trainRes) cells.push([f.trainRes, 'trained at']);
  if (f.splats) cells.push([fmt(f.splats), 'splats']);
  if (f.dB) cells.push([`${(+f.dB).toFixed(1)} dB`, f.dBLabel || 'train psnr']);
  el.innerHTML = cells.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  el.hidden = !cells.length;
}

/** The focused detail card: one set, its description, and the only Start
 *  button. Back returns to the front page. Classic mode only. */
function showDetail(setOrPreset) {
  if (WALL_FIRST) return;
  document.getElementById('detail-view')?.remove();
  S.pendingShare = null;   // this card is a set with its photos in hand
  const hero = $('detail-hero');
  const src = (S.photos && S.photos[0] && S.photos[0].url) || null;
  hero.hidden = !src;
  if (src) hero.src = src;
  // input facts: the count is known; the resolution reads off the hero
  // photograph once it decodes (the same image the card displays anyway)
  const facts = S.detailFacts = { frames: (S.photos && S.photos.length) || 0 };
  paintDetailStats();
  if (src) {
    hero.onload = () => {
      if (S.detailFacts !== facts || !hero.naturalWidth) return;
      facts.res = `${hero.naturalWidth} × ${hero.naturalHeight}`;
      paintDetailStats();
    };
  }
  setStartStyle(!(setOrPreset && setOrPreset.spaceId));
  if (setOrPreset && setOrPreset.spaceId) {
    // a trained model of this benchmark is shared — View opens it, and the
    // published model's train PSNR joins the input facts once resolved
    const view = document.createElement('a');
    view.id = 'detail-view';
    view.className = 'btn btn-accent big btn-cta';
    view.href = `index.html?space=${encodeURIComponent(setOrPreset.spaceId)}`;
    view.textContent = 'View';
    document.querySelector('.startrow').prepend(view);
    import('./share.js').then(({ resolveShare }) => resolveShare(setOrPreset.spaceId))
      .then((sh) => {
        if (S.detailFacts !== facts || $('detail').hidden) return;
        const sj = sh.splatjs || {};
        facts.splats = sj.splats;
        facts.dB = sj.psnrTest ? sj.psnrTest.psnr : sj.psnrTrain;
        facts.dBLabel = sj.psnrTest ? 'holdout psnr' : 'train psnr';
        paintDetailStats();
      }).catch(() => {});
  }
  $('btn-go').disabled = !!S.noGpu;
  $('start').hidden = true;
  $('detail').hidden = false;
  // the card is a navigable UI state: Back must close IT, not leave the app
  if (!(history.state && history.state.sj === 'detail')) {
    history.pushState({ sj: 'detail' }, '');
  }
}

// Back closes pushed UI layers (About sheet, the viewer, the detail card)
// instead of navigating away — history walks the same steps the visitor sees
addEventListener('popstate', () => {
  if (!$('about').hidden) { $('about').hidden = true; return; }
  if (S._viewerOpen) { closeViewerToHome(); return; }
  if (!$('detail').hidden) { closeDetailCard(); return; }
  // back during a running solve/training: leave the same way the header
  // Back does — a page navigation home (the wall is never rendered OVER a
  // live scene; beforeunload asks before a training is thrown away)
  if ((S.state === 'prep' || S.state === 'train') && $('start').hidden) {
    location.href = 'index.html';
  }
});

/** The setup card's ‹ and ×: route through history when the card owns an
 *  entry so the phone's Back gesture stays in sync. */
function detailClose() {
  if (history.state && history.state.sj === 'detail') { history.back(); return; }
  closeDetailCard();
}

/** Close the setup card — back INTO the shared scene its Train came from,
 *  otherwise home to the wall. */
function closeDetailCard() {
  document.getElementById('failcard')?.remove();
  S.pendingShare = null;
  $('detail').hidden = true;
  if (S.state === 'ready' && S._fromSpace) {
    const id = S._fromSpace;
    S._fromSpace = null;
    restoreShared(id);
    return;
  }
  showHome();   // fresh — a capture picked moments ago must show its tile
}

/** Tear the restored viewer down and land on the wall — the SPA counterpart
 *  of the old full-page navigation home. */
function closeViewerToHome() {
  stopTour();
  try { S.session && S.session.dispose(); } catch (e) { /* view-only facade */ }
  document.getElementById('cv-model')?.remove();
  document.getElementById('share-hero')?.remove();
  document.getElementById('ltchoice')?.remove();
  gpuCanvas = null;
  S.gen++;
  S.session = null; S.share = null; S.restored = null; S._localRun = null;
  S._viewerOpen = false;
  S._fromSpace = null;
  S._thumbsUrl = null; S._thumbPack = null;
  S.plyBlob = null; S.sogBlob = null;
  S.state = 'ready'; S.preset = null; S.photos = [];
  S.scene = null; S.tour = null;
  $('strip').innerHTML = '';
  $('controls').hidden = true;
  dock('');
  showHome(); // fresh tiles — runs may have finished or been added since
}

/** The creation's recon json (plain or store-zipped) — the photographs and
 *  cameras a "train this yourself" run needs. */
async function fetchShareRecon(it) {
  const { unzipStore } = await import('./session_io.js');
  const r = await fetch(it.splatjs.reconUrl);
  if (!r.ok) throw new Error('recon unavailable');
  const rb = new Uint8Array(await r.arrayBuffer());
  if (rb[0] === 0x50 && rb[1] === 0x4b) {
    return JSON.parse(new TextDecoder().decode(unzipStore(rb).get('recon.json')));
  }
  return JSON.parse(new TextDecoder().decode(rb));
}

/** One creation card, post-style: hero, badge, title, the FULL description
 *  and the key numbers. The whole card is the View action — clicking loads
 *  the creation directly (Train lives in the viewer). */
function creationTile(it, mine) {
  const wrap = document.createElement('a');
  wrap.className = 'galtile';
  const img = (it.splatjs && it.splatjs.thumbUrl) || it.screenshotUrl || '';
  const dB = it.splatjs && (it.splatjs.psnrTest ? it.splatjs.psnrTest.psnr : it.splatjs.psnrTrain);
  // index.html explicitly: a bare "?space=" resolves against <base> to the
  // trailing-slash URL, and the CDN's slash-stripping 301 EATS the query
  wrap.href = `index.html?space=${encodeURIComponent(it.id)}`;
  // an optional corner chip from the stamp (e.g. "360") — same badge the
  // last-capture tile wears
  const badge = it.splatjs && it.splatjs.badge;
  wrap.innerHTML = `<img loading="lazy" src="${esc(img)}" alt="" onerror="this.style.visibility='hidden'">
    ${badge ? `<i class="yours">${esc(badge)}</i>` : ''}
    <span class="galname">${esc(it.title || 'Untitled')}</span>
    ${it.description ? `<span class="galdesc">${esc(it.description)}</span>` : ''}
    <span class="galmeta">${fmt((it.splatjs && it.splatjs.splats) || 0)} splats${dB ? ` · ${(+dB).toFixed(1)} dB` : ''}${it.splatjs && it.splatjs.sogMb ? ` · ${it.splatjs.sogMb} MB` : ''}</span>`;
  return wrap;
}

/** The creation wall on the start card: Scenes (public, everyone) and —
 *  when this device holds anything of the visitor's own — Local: the last
 *  capture from this browser's storage plus, signed in, their shares
 *  (management: privacy, link, delete). An empty wall stays invisible. */
async function mountWall() {
  try {
    const { fetchGallery, fetchMine } = await import('./share.js');
    const [{ items }, capTile, runTiles, myShares] = await Promise.all([
      fetchGallery({ count: 12 }),
      lastCaptureTile().catch(() => null),
      localRunTiles().catch(() => []),
      hasToken() ? fetchMine().catch(() => []) : Promise.resolve([]),
    ]);
    // ONE list, the visitor first: their capture, their runs, their shares
    // always lead; the presets follow behind a slim divider. (The old
    // Presets/Yours tabs became redundant the moment own content led.)
    const own = [];
    if (capTile) own.push(capTile);
    for (const t of runTiles) own.push(t);
    for (const it of (myShares || [])) own.push(creationTile(it, false));
    if ((!items || !items.length) && !own.length) return;
    const host = $('gallery');
    host.innerHTML = `
      <div class="orline"><span>${own.length ? 'This device' : 'Presets'}</span></div>
      <div class="galrow" data-pane="all"></div>`;
    const row = host.querySelector('[data-pane="all"]');
    for (const t of own) row.appendChild(t);
    // official presets (pinned first via splatjs.pin, otherwise newest),
    // then OTHER users' shared scenes — the space id carries its owner
    const OFFICIAL = '42485456_';
    const keyOf = (x) => (String(x.id).startsWith(OFFICIAL)
      ? ((x.splatjs && x.splatjs.pin) || 9e9)
      : 1e12);
    const mineIds = new Set((myShares || []).map((x) => String(x.id)));
    const ordered = (items || []).slice()
      .filter((x) => !mineIds.has(String(x.id)))   // no duplicate of an own share
      .sort((a, b) => keyOf(a) - keyOf(b));
    if (own.length && ordered.length) {
      const sep = document.createElement('div');
      sep.className = 'galsep';
      sep.innerHTML = '<span>Presets</span>';
      row.appendChild(sep);
    }
    for (const it of ordered) row.appendChild(creationTile(it, false));
    dragScroll(row);
    host.hidden = false;
  } catch (e) { /* the wall is decoration — never block the app on it */ }
}

/** From the viewer into the studio: the shared creation's photographs become
 *  the training input — the moment of "I want to make this myself". */
function trainFromShare() {
  const rj = S.restored && S.restored.reconJson;
  if (!rj || !rj.source || !rj.source.urls || !rj.source.urls.every(Boolean)) return;
  stopTour();
  // remember where we came from: ‹ and × on the setup card return INTO this
  // scene instead of dumping the visitor on the front page
  S._fromSpace = S.share ? S.share.id : null;
  // the SHARE's title names the set — the recon carries the original
  // creator's local set name ("Your photos"), meaningless to this visitor
  const name = (S.share && S.share.title) || rj.name || 'Shared sample';
  try { S.session.dispose(); } catch (e) {}
  document.getElementById('cv-model')?.remove();
  gpuCanvas = null;
  S.gen++;
  S.session = null; S.share = null; S.restored = null;
  S._thumbsUrl = null; S._thumbPack = null;
  S._viewerOpen = false;
  S.plyBlob = null; S.sogBlob = null;
  S.state = 'ready';
  S.preset = { id: '__sample', name };
  S.photos = rj.source.names.map((n, i) => ({ url: rj.source.urls[i], name: n }));
  S.sel = 0; S.atFrame = -1; S.fadeTo = 0;
  vp.lock = null; vp.pose = null; vp.scene = null; S.scene = null;
  renderControls();
  buildStrip(true);   // the card covers the strip — thumbs wait for the run
  $('set-desc').innerHTML = `<b>${esc(name)}</b> — ${S.photos.length} photographs from this creation, ready to train. The gear holds quality settings.`;
  $('set-desc').hidden = false;
  setStartStyle(true);
  $('btn-go').disabled = !!S.noGpu;
  $('btn-settings').disabled = false;   // open() normally arms the gear — this path skips it
  if (WALL_FIRST) {
    $('start').hidden = false;
  } else {
    // classic keeps Start on the focused detail card
    document.getElementById('detail-view')?.remove();
    const hero = $('detail-hero');
    hero.src = S.photos[0].url;
    hero.hidden = false;
    $('start').hidden = true;
    $('detail').hidden = false;
  }
  bmp(S.photos[0].url);
  flash('Photographs loaded — press Start training.', 6000);
}

/** The error map needs pixels of the render. The live WebGPU canvas can read
 *  back blank after presentation, so render the frame's exact camera into a
 *  scratch canvas and snapshot it right behind the fence — at training
 *  resolution, which also makes the comparison resolution-fair. */
async function ensureErrRender(key) {
  if ((S._errRender && S._errRender.key === key) || S._errRenderBusy) return;
  if (S.atFrame < 0) return;
  const cam = S.scene.cams[S.atFrame];
  if (!cam || cam.ci < 0) return;
  S._errRenderBusy = true;
  const gen = S.gen;
  try {
    const ses = S.session;
    const meta = ses.trainer.camMeta[cam.ci];
    const cv = (S._errScratch ??= document.createElement('canvas'));
    cv.width = meta.w; cv.height = meta.h;
    ses.view.attach(cv);
    ses.view.lookThrough(cam.ci);
    ses.view.renderNow();
    await ses.trainer.device.queue.onSubmittedWorkDone();
    if (S.gen !== gen) return;
    const snap = (S._errSnap ??= document.createElement('canvas'));
    snap.width = meta.w; snap.height = meta.h;
    snap.getContext('2d').drawImage(cv, 0, 0);
    S._errRender = { key, canvas: snap };
  } catch (e) {
    console.error(e);
  } finally {
    S._errRenderBusy = false;
    // hand the view back to the stage and force a fresh pose render
    if (S.gen === gen && gpuCanvas && S.session) {
      S.session.view.attach(gpuCanvas);
      S._viewKey = '';
    }
  }
}

/** put the camera exactly on a frame's pose and lay its photograph over the model */
/** In a restorable view (share / ?model=) the address mirrors the frame
 *  focus and compare mode — a refresh lands exactly here. */
function syncFrameUrl() {
  if (S.state !== 'done') return;
  const u = new URL(location.href);
  if (!u.searchParams.has('space') && !u.searchParams.has('model')) return;
  if (S.atFrame >= 0) {
    u.searchParams.set('frame', String(S.sel));
    u.searchParams.set('cmp', S.compare);
  } else {
    u.searchParams.delete('frame');
    u.searchParams.delete('cmp');
  }
  history.replaceState(null, '', u);
}

function goToFrame(i) {
  stopTour();
  const cam = S.scene.cams[i];
  if (!cam || !cam.R) { flash('That frame was never placed — there is no viewpoint to jump to.'); return; }
  if (cam.pano) {
    // a 360 station: fly to where it was taken — no photo overlay
    S.sel = i;
    vp.lock = null;
    vp.syncTo(cam);
    S.atFrame = -1; S.fadeTo = 0;
    $('stage').dataset.cursor = 'grab';
    renderControls(); paintStrip();
    return;
  }
  S.sel = i; S.atFrame = i;
  vp.lock = cam;
  bmp(cam.url).then((b) => {
    if (b && S.scene.cams[S.atFrame]?.url === cam.url) dev.setBitmap(b, cam.url);
  });
  S.fadeTo = 1;
  S.loupe.x = $('stage').clientWidth / 2;
  S.loupe.y = $('stage').clientHeight / 2;
  $('stage').dataset.cursor = cursorFor(S.compare);
  renderControls(); paintStrip();
  syncFrameUrl();
}

/** a drag pulls the camera off the frame — same position, same lens, now free */
function leaveFrame() {
  if (S.atFrame < 0) return;
  const cam = S.scene.cams[S.atFrame];
  vp.freeF = cam.f * Math.min(vp.w / cam.w, vp.h / cam.h);
  vp.lock = null;
  vp.syncTo(cam);
  S.atFrame = -1;
  S.fadeTo = 0;
  $('stage').dataset.cursor = 'grab';
  renderControls();
  syncFrameUrl();
}

function select(i) {
  if (!S.photos.length) return;
  S.sel = (i + S.photos.length) % S.photos.length;
  $('strip-scroll')?.children[S.sel]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  if ((S.state === 'train' || S.state === 'done') && S.scene) goToFrame(S.sel);
  paintStrip(); renderControls();
  if (!$('details').hidden) renderDetails();
}

function wireStage() {
  const st = $('stage');
  st.addEventListener('pointermove', (e) => {
    if (S.atFrame < 0) return;
    const r = st.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (S.compare === 'loupe') { S.loupe.x = x; S.loupe.y = y; }
    if (S.compare === 'swipe' && S.rect) S.swipe = clamp((x - S.rect.x) / S.rect.w, 0, 1);
  });
  st.addEventListener('wheel', (e) => {
    if (S.atFrame < 0 || S.compare !== 'loupe') return;
    e.preventDefault();
    S.loupe.r = clamp(S.loupe.r - e.deltaY * .12, 40, 260);
  }, { passive: false });
}

// ── filmstrip ───────────────────────────────────────────────────────────────
function buildStrip(deferPhotos = false) {
  const strip = $('strip');
  strip.innerHTML = '<div class="strip-scroll" id="strip-scroll"></div>';
  const sc = $('strip-scroll');
  dragScroll(sc);
  const fill = async (el) => {
    if (el.dataset.filled) return;
    el.dataset.filled = '1';
    const i = +el.dataset.i;
    const b = (await thumbBmp(i)) || (await bmp(S.photos[i].url, 140));
    if (!b) return;
    const cv = document.createElement('canvas');
    // equirect panoramas crop to the card: the centre 4:3 window (the
    // pano's forward direction) instead of a squeezed 2:1 sliver
    const wide = b.width / b.height > 1.9;
    const sh = wide ? b.height * 0.72 : b.height;
    const sw = wide ? Math.min(b.width, sh * (4 / 3)) : b.width;
    const sx = (b.width - sw) / 2, sy = (b.height - sh) / 2;
    cv.width = Math.max(1, Math.round(sw));
    cv.height = Math.max(1, Math.round(sh));
    cv.getContext('2d').drawImage(b, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    el.querySelector('.ph')?.replaceWith(
      Object.assign(new Image(), { src: cv.toDataURL('image/jpeg', .7) }));
  };
  // viewing a share: the tiles stay placeholders until touched — a shared
  // creation must not pull hundreds of full-size training photos on load
  const io = deferPhotos ? null : new IntersectionObserver((es) => {
    es.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      fill(e.target);
    });
  }, { root: sc, rootMargin: '250px' });

  S.photos.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'frame';
    b.dataset.i = i;
    b.innerHTML = `<div class="ph"></div>
      <span class="frame-tag" hidden></span><div class="frame-bar"><i></i></div>`;
    b.addEventListener('click', () => { fill(b); select(i); });
    sc.appendChild(b);
    if (io) io.observe(b);
  });
  paintStrip();
}

/** A shared creation's packed strip thumbnails: the zip is fetched once,
 *  lazily, and each card decodes its small JPEG — no full photographs are
 *  pulled just to draw 140px tiles. Null (fallback) when the share predates
 *  the pack or the fetch fails. */
async function thumbBmp(i) {
  if (!S._thumbsUrl) return null;
  try {
    S._thumbPack ??= (async () => {
      const r = await fetch(S._thumbsUrl);
      if (!r.ok) throw new Error(`thumbs fetch failed (${r.status})`);
      const { unzipStore } = await import('./session_io.js');
      return unzipStore(new Uint8Array(await r.arrayBuffer()));
    })();
    const data = (await S._thumbPack).get(`${i}.jpg`);
    return data ? await createImageBitmap(new Blob([data], { type: 'image/jpeg' })) : null;
  } catch {
    S._thumbsUrl = null;   // broken pack: every card falls back to the photo
    return null;
  }
}

function paintStrip() {
  const sc = $('strip-scroll');
  if (!sc) return;
  const active = (S.state === 'train' && S.session && S.session.training && S.scene)
    ? (S.scene.cams.find((c) => c.ci === S.session.activeCam) || {}).i : -1;
  S.photos.forEach((p, i) => {
    const b = sc.children[i];
    if (!b) return;
    const c = S.scene ? S.scene.cams[i] : null;
    b.dataset.sel = i === S.sel ? '1' : '0';
    b.dataset.live = i === active ? '1' : '0';
    b.dataset.state = c ? c.state : 'placed';
    const tag = b.querySelector('.frame-tag');
    const t = c && c.state === 'holdout' ? 'held' : c && c.state === 'unplaced' ? 'out' : null;
    tag.hidden = !t;
    if (t) { tag.dataset.t = c.state; tag.textContent = t; }
    const bar = b.querySelector('.frame-bar i');
    const score = c && (c.psnr != null ? c.psnr
      : (S.state !== 'ready' && c.state !== 'unplaced'
        ? (c.state === 'holdout' ? S.psnrHold : S.psnrTrain) : null));
    bar.style.width = score != null ? `${clamp((score - 12) / 22, 0, 1) * 100}%` : '0%';
    bar.style.background = c && c.state === 'holdout' ? '#f2a03f' : '#2fd4c1';
  });
}

// ── dock ────────────────────────────────────────────────────────────────────
function dock(kind) {
  const d = $('dock');
  d.className = 'dock' + (kind ? ` dock-${kind}` : '');
  if (!kind) { d.innerHTML = ''; return; }

  if (kind === 'prep') {
    // the stage sequence IS the header: the current beat reads as the title,
    // the others wait in line around it
    d.innerHTML = `
      <div>
        <div class="prep-stages" id="p-steps">${BEATS.map((s, i) =>
          `<span data-k="${i}">${s.label}</span>`).join('')}</div>
        <div class="prep-sub" id="p-sub">—</div>
        <div class="prep-meter"><i id="p-bar" style="width:0%"></i><span class="prep-live" aria-hidden="true"></span></div>
      </div>`;
    return;
  }

  if (kind === 'train') {
    d.innerHTML = `
      <div class="tcontrols">
        <span class="playwrap"><button class="play" id="t-play" data-state="pause"><svg viewBox="0 0 24 24" class="pl" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg></button><button class="tbtn-sm" id="t-finish" hidden title="End the run here — the model is kept as it is and ready to export">Stop &amp; keep</button></span>
        <div class="tmeta">
          <span class="tmeta-1"><span id="t-iter">${pctOf(S.iter)}</span></span>
          <span class="tmeta-2">ETA <span id="t-eta">${etaText()}</span></span>
        </div>
      </div>
      <div class="chartwrap"><canvas id="chart"></canvas><div class="chart-tip" id="chart-tip" hidden></div></div>
      <div class="tscores">
        <div class="score" data-tone="accent">
          <div class="score-1"><span class="t-state" id="t-title">Training…</span><span class="score-v"><span id="t-ptrain">${S.psnrTrain != null ? S.psnrTrain.toFixed(2) : '—'}</span><small class="unit">dB</small></span></div>
          <div class="score-sub"><span id="t-splats">${S.splats ? fmt(S.splats) : '—'}</span> splats</div>
          <span class="tmeta-grow" id="t-grow">&nbsp;</span>
        </div>
        ${S.session && S.session.holdout >= 0 ? `<div class="score" data-tone="alt"><div class="score-1"><span class="score-v"><span id="t-phold">${S.psnrHold != null ? S.psnrHold.toFixed(2) : '—'}</span><small class="unit">dB</small></span></div><div class="score-sub">held out</div></div>` : ''}
      </div>`;
    $('t-play').addEventListener('click', toggleTrain);
    $('t-finish').addEventListener('click', async () => {
      $('t-finish').disabled = true;
      await S.session.finish();   // emits train-complete -> finish()
    });
    chart = new Chart($('chart'), { onHover: chartTip });
    chart.maxIter = S.maxIters;
    chart.resize();
  }
}

function chartTip(h) {
  const tip = $('chart-tip');
  if (!tip) return;
  if (!h) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.style.left = `${h.xPct}%`;
  tip.style.top = '4px';
  tip.innerHTML = `${fmt(h.iter)} · <b style="color:#2fd4c1">${h.train.toFixed(1)}</b>` +
    (h.hold != null ? ` / <b style="color:#f2a03f">${h.hold.toFixed(1)}</b> dB` : '') +
    (h.event ? `<br><span style="color:#93a1a0">${h.event}</span>` : '');
}

// ── flash ───────────────────────────────────────────────────────────────────
function flash(msg, ms = 2800, links = []) {
  S.flash = { msg: String(msg), links, until: performance.now() + ms };
}

function renderHud() {
  const hud = $('hud');
  const key = S.flash ? JSON.stringify(S.flash) : '';
  if (hud.dataset.k === key) return;
  hud.dataset.k = key;
  const row = document.createElement('div');
  row.className = 'chip-row';
  if (S.flash) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.tone = 'accent';
    chip.textContent = S.flash.msg;
    for (const link of S.flash.links) {
      const a = document.createElement('a');
      a.textContent = link.label;
      if (link.copy != null) {
        a.href = '#';
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          try { await navigator.clipboard.writeText(link.copy); a.textContent = 'Copied'; }
          catch { a.textContent = 'Copy failed'; }
        });
      } else {
        let url;
        try { url = new URL(link.href, location.href); } catch { continue; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        a.href = url.href;
        if (link.blank) { a.target = '_blank'; a.rel = 'noopener'; }
      }
      chip.append(' · ', a);
    }
    row.appendChild(chip);
  }
  hud.replaceChildren(row);
}

// ── screen wake lock ────────────────────────────────────────────────────────
// a long run gets no touches, and phones dim and lock the screen — hold a
// wake lock while the pipeline works (and while the done-tour is playing)
let wakeLock = null;
async function updateWakeLock() {
  const want = document.visibilityState === 'visible' &&
    (S.state === 'prep' || S.state === 'train' || (S.state === 'done' && !!S.tour));
  if (want && !wakeLock && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied (battery saver etc.) — nothing to do */ }
  } else if (!want && wakeLock) {
    try { wakeLock.release(); } catch { /* already gone */ }
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', updateWakeLock);

// ── main loop ───────────────────────────────────────────────────────────────
let lastPulse = 0;
let lastLoopT = performance.now();

// ── done-state intro: glide along the capture path until the user acts ──────
// rotation interpolation: quaternions of the SOLVED camera matrices, so the
// replay carries the photographer's true roll (an orbit camera cannot)
function quatFromR(R) {
  const tr = R[0] + R[4] + R[8];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [(R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s, 0.25 * s];
  }
  if (R[0] > R[4] && R[0] > R[8]) {
    const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
    return [0.25 * s, (R[1] + R[3]) / s, (R[2] + R[6]) / s, (R[7] - R[5]) / s];
  }
  if (R[4] > R[8]) {
    const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
    return [(R[1] + R[3]) / s, 0.25 * s, (R[5] + R[7]) / s, (R[2] - R[6]) / s];
  }
  const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
  return [(R[2] + R[6]) / s, (R[5] + R[7]) / s, 0.25 * s, (R[3] - R[1]) / s];
}

function quatToR(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) {
    const o = a.map((v, i) => v + (bb[i] - v) * t);
    const n = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return o.map((v) => v / n);
  }
  const th = Math.acos(Math.min(1, d)), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [0, 1, 2, 3].map((i) => a[i] * wa + bb[i] * wb);
}

function startTour(fromNearest = false) {
  let cams = S.scene ? S.scene.cams.filter((c) => c.R) : [];
  if (cams.length < 2) return;

  // ---- a stable path needs stable NODES first ----
  // 1) collapse co-located cameras (a pano rig contributes six orientations
  //    at one position — flying "through" them whips the view around)
  const centres = cams.map(camCentre);
  const gaps = [];
  for (let i = 1; i < centres.length; i++) {
    const d = Math.hypot(...[0, 1, 2].map((c) => centres[i][c] - centres[i - 1][c]));
    if (d > 1e-9) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const medGap = gaps[gaps.length >> 1] || 1e-3;
  const dedup = [];
  for (let i = 0; i < cams.length; i++) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(...[0, 1, 2].map((c) => centres[i][c] - camCentre(last)[c])) > 0.15 * medGap) {
      dedup.push(cams[i]);
    }
  }
  // 2) never spline across a real break in the capture (a second walk, a
  //    registration gap): split into segments, fly the longest one
  const segs = [[dedup[0]]];
  for (let i = 1; i < dedup.length; i++) {
    const a = camCentre(dedup[i - 1]), b = camCentre(dedup[i]);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d > 4 * medGap) segs.push([]);
    segs[segs.length - 1].push(dedup[i]);
  }
  cams = segs.reduce((best, s) => (s.length > best.length ? s : best), []);
  const n = cams.length;
  if (n < 2) return;

  // pre-smooth positions over ±3 neighbours — a handheld capture path is
  // jittery, and a spline through jitter is jittery too
  const raw = cams.map(camCentre);
  const smooth3 = (arr) => arr.map((_, i) => {
    const acc = [0, 0, 0];
    let w = 0;
    for (let k = -3; k <= 3; k++) {
      const j = clamp(i + k, 0, arr.length - 1);
      const wt = 4 - Math.abs(k);
      for (let c = 0; c < 3; c++) acc[c] += arr[j][c] * wt;
      w += wt;
    }
    return [acc[0] / w, acc[1] / w, acc[2] / w];
  });
  const pts = smooth3(raw);

  // true rotations, sign-aligned then lightly smoothed towards the midpoint
  // of the neighbours — handheld roll jitter, not the roll itself, goes away
  const qs = cams.map((c) => quatFromR(c.R));
  for (let i = 1; i < qs.length; i++) {
    if (qs[i - 1][0] * qs[i][0] + qs[i - 1][1] * qs[i][1] + qs[i - 1][2] * qs[i][2] + qs[i - 1][3] * qs[i][3] < 0) {
      qs[i] = qs[i].map((v) => -v);
    }
  }
  // two smoothing passes: handheld roll/aim jitter goes, deliberate turns stay
  let sq = qs;
  for (let pass = 0; pass < 2; pass++) {
    sq = sq.map((q, i) => {
      if (i === 0 || i === sq.length - 1) return q;
      return qslerp(q, qslerp(sq[i - 1], sq[i + 1], 0.5), 0.5);
    });
  }

  // Catmull-Rom, densely resampled into an arc-length table: playback walks
  // the table at EXACTLY constant velocity, whatever the gap sizes
  const P = (k) => pts[clamp(k, 0, n - 1)];
  const cr = (i, f) => {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const t2 = f * f, t3 = t2 * f;
    return [0, 1, 2].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * f +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
      (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
  };
  const samples = [], us = [], cum = [0];
  const SUB = 8;
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < SUB; k++) { samples.push(cr(i, k / SUB)); us.push(i + k / SUB); }
  }
  samples.push(cr(n - 2, 1)); us.push(n - 1);
  for (let k = 1; k < samples.length; k++) {
    const a = samples[k - 1], b = samples[k];
    cum.push(cum[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[cum.length - 1] || 1e-6;
  const duration = clamp(1.4 * n, 10, 30);   // one full pass, 30 s at most

  S.tour = { cams, sq, samples, us, cum, total, speed: total / duration, s: 0, k: 0, dir: 1, pd: [] };

  // ALWAYS pick up from wherever the view is — the intro starts at the
  // landing pose (the first camera), replay from wherever the user flew to;
  // either way, no jump-cut into the path
  {
    const { fwd } = vp._basis();
    const eye = [vp.target[0] - fwd[0] * vp.dist, vp.target[1] - fwd[1] * vp.dist, vp.target[2] - fwd[2] * vp.dist];
    let best = 0, bd = Infinity;
    samples.forEach((p, k) => {
      const dd = (p[0] - eye[0]) ** 2 + (p[1] - eye[1]) ** 2 + (p[2] - eye[2]) ** 2;
      if (dd < bd) { bd = dd; best = k; }
    });
    S.tour.s = cum[best];
    S.tour.k = Math.min(best, cum.length - 2);
    // heading outward from a path end plays the return leg first
    if (!fromNearest && S.tour.s > total * 0.5) S.tour.dir = -1;
  }
}

function stopTour() {
  if (!S.tour) return;
  S.tour = null;
  vp.pose = null;   // hand the view back to the orbit (which has no roll)
  vp.dirty = true;
}

function tourStep(dt) {
  const T = S.tour;
  if (!T) return;
  if (S.state !== 'done' || S.atFrame >= 0 || S.picking || !$('details').hidden) return;
  if (S.keys.size) { stopTour(); return; }   // flying takes over

  T.s += dt * T.speed * T.dir;               // constant velocity, ping-pong
  if (T.s >= T.total) { T.s = T.total; T.dir = -1; }
  if (T.s <= 0) { T.s = 0; T.dir = 1; }
  while (T.k < T.cum.length - 2 && T.cum[T.k + 1] < T.s) T.k++;
  while (T.k > 0 && T.cum[T.k] > T.s) T.k--;

  const span = Math.max(1e-9, T.cum[T.k + 1] - T.cum[T.k]);
  const a = (T.s - T.cum[T.k]) / span;
  const A = T.samples[T.k], B = T.samples[T.k + 1];
  const pos = [A[0] + (B[0] - A[0]) * a, A[1] + (B[1] - A[1]) * a, A[2] + (B[2] - A[2]) * a];
  const u = T.us[T.k] + (T.us[T.k + 1] - T.us[T.k]) * a;
  const i = clamp(Math.floor(u), 0, T.cams.length - 2);
  const f = u - i;

  // the TRUE pose, roll included, rendered via the viewport's pose override
  const Rq = quatToR(qslerp(T.sq[i], T.sq[i + 1], f));
  vp.pose = {
    R: Rq,
    t: [
      -(Rq[0] * pos[0] + Rq[1] * pos[1] + Rq[2] * pos[2]),
      -(Rq[3] * pos[0] + Rq[4] * pos[1] + Rq[5] * pos[2]),
      -(Rq[6] * pos[0] + Rq[7] * pos[1] + Rq[8] * pos[2]),
    ],
  };

  // keep the orbit tracking underneath (minus roll) so any user takeover
  // continues seamlessly from here
  const fwd = [Rq[6], Rq[7], Rq[8]];
  const da = (T.pd[i] ??= vp._pivotDist(T.cams[i]));
  const db = (T.pd[i + 1] ??= vp._pivotDist(T.cams[i + 1]));
  const d = da + (db - da) * f;
  vp.target = [pos[0] + fwd[0] * d, pos[1] + fwd[1] * d, pos[2] + fwd[2] * d];
  vp.dist = d;
  const ang = vp.anglesOf(fwd);
  vp.yaw = ang.yaw;
  vp.pitch = clamp(ang.pitch, -1.45, 1.45);
  vp.dirty = true;
}

/** WASD fly: move the orbit target along the camera's own axes */
function flyStep(dt) {
  if (!S.keys.size || !S.scene) return;
  if (S.state !== 'train' && S.state !== 'done') return;
  if (S.picking || !$('details').hidden) return;
  if (S.atFrame >= 0) leaveFrame();   // like a drag, movement leaves the photo
  const { fwd, right, down } = vp._basis();
  const boost = (S.keys.has('ShiftLeft') || S.keys.has('ShiftRight')) ? 3 : 1;
  // speed follows the pivot distance (zoomed in = fine movement, zoomed out
  // = covering ground), floored so a extreme close-up can still move
  const sp = Math.max(vp.dist, S.scene.radius * 0.02) * 1.2 * dt * boost;
  let any = false;
  const move = (v, f) => { for (let i = 0; i < 3; i++) vp.target[i] += v[i] * f; any = true; };
  if (S.keys.has('KeyW')) move(fwd, sp);
  if (S.keys.has('KeyS')) move(fwd, -sp);
  if (S.keys.has('KeyA')) move(right, -sp);
  if (S.keys.has('KeyD')) move(right, sp);
  if (S.keys.has('KeyE')) move(down, -sp);   // up
  if (S.keys.has('KeyQ')) move(down, sp);    // down
  if (any) vp.dirty = true;
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastLoopT) / 1000);
  lastLoopT = now;
  if (S.flash && now > S.flash.until) S.flash = null;
  const wlWant = `${S.state}:${!!S.tour}`;
  if (wlWant !== S._wlKey) { S._wlKey = wlWant; updateWakeLock(); }
  // the tour can stop from any interaction — keep the play button honest
  const tourBtn = $('c-play');
  if (tourBtn && tourBtn.dataset.on !== String(!!S.tour)) {
    tourBtn.dataset.on = String(!!S.tour);
    tourBtn.title = S.tour ? 'Stop the flight' : 'Fly the capture path';
    tourBtn.innerHTML = S.tour
      ? '<svg viewBox="0 0 24 24" class="pl" aria-hidden="true"><rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/></svg>'
      : '<svg viewBox="0 0 24 24" class="pl" aria-hidden="true"><path d="M8.5 5.5v13l10-6.5z"/></svg>';
  }
  const grow = $('t-grow');
  if (grow) {
    // nbsp when quiet: the slot keeps its baseline, so nothing below shifts
    const txt = (S.growNote && now < S.growNote.until) ? S.growNote.text : ' ';
    if (grow.textContent !== txt) grow.textContent = txt;
  }
  // the countdown ticks between metrics events; paused = frozen, honest
  if (S.state === 'train' && S.session && S.session.training && now - (S._etaTick || 0) > 250) {
    S._etaTick = now;
    const eta = $('t-eta');
    if (eta) {
      const txt = etaText();
      if (eta.textContent !== txt) eta.textContent = txt;
    }
  }
  // no fade on the photo overlay — it reads as lag on slow devices
  S.fade = S.fadeTo;
  flyStep(dt);
  tourStep(dt);

  if (S.state === 'prep') paintPrepDock();

  if (S.state === 'train' && now - lastPulse > 300) {
    lastPulse = now;
    paintStrip();          // the pulse on the frame being trained on
  }

  renderHud();
  draw();
  if (!$('details').hidden) drawDetail();
}

function paintPrepDock() {
  const bar = $('p-bar');
  if (!bar || !S.prep) return;
  const bi = beatIndex(S.prep.stage);
  const frac = S.prep.total ? S.prep.done / S.prep.total : 0;
  bar.style.width = `${((bi + Math.min(1, frac)) / BEATS.length) * 100}%`;
  $('p-sub').textContent = prepSub();
  [...$('p-steps').children].forEach((el, k) =>
    el.dataset.on = k < bi ? 'done' : k === bi ? '1' : '0');
}

function prepSub() {
  const e = S.prep;
  if (!e) return '—';
  const n = S.photos.length;
  if (e.stage === 'decode') return `photo ${e.done} of ${e.total}`;
  if (e.stage === 'features') {
    const total = [...S.feats.values()].reduce((a, f) => a + f.n, 0);
    return `${fmt(total)} spots · frame ${e.done} of ${e.total}`;
  }
  if (e.stage === 'matching') {
    return `${fmt(e.done)} of ${fmt(e.total)} pairs · ${fmt(e.detail?.usable ?? 0)} survived the geometry test`;
  }
  if (e.stage === 'focal') return `no lens data in the files — measuring the lens from the geometry · ${e.done + 1} of ${e.total}`;
  if (e.stage === 'register') {
    return `${e.done} of ${e.total} photos placed` +
      (S.regPtsCount ? ` · ${fmt(S.regPtsCount)} points triangulated` : '');
  }
  if (e.stage === 'ba') return 'polishing the geometry (bundle adjustment)';
  if (e.stage === 'solved') return `${e.detail.cams} cameras · ${fmt(e.detail.points)} points · ${e.detail.rms ? e.detail.rms.toFixed(2) + 'px' : ''}`;
  if (e.stage === 'seed') return 'one splat per landmark, plus jittered copies';
  return '—';
}

// ── drawing ─────────────────────────────────────────────────────────────────
function draw() {
  const cv = $('cv');
  const r = cv.getBoundingClientRect();
  if (Math.abs(r.width * (vp.dpr || 1) - cv.width) > 2 || Math.abs(r.height * (vp.dpr || 1) - cv.height) > 2) vp.resize();
  const ctx = vp.ctx, w = vp.w, h = vp.h, dpr = vp.dpr || 1;

  if (S.state === 'ready') { photoStage(ctx, w, h, dpr); return; }

  if (S.state === 'prep') {
    const st = S.prep && S.prep.stage;
    if (st === 'decode' || st === 'features') return photoStage(ctx, w, h, dpr, st === 'features');
    // the focal search draws nothing of its own — keep the last matching
    // frame on stage instead of cutting to black
    if (st === 'matching' || st === 'focal') return pairStage(ctx, w, h, dpr);
    // register / ba / solved / seed: the camera solve, live
    if (S.scene) {
      vp.draw({ points: true, cams: S.scene.cams, showCams: true, showPath: true, sel: S.sel, active: -1 });
    } else if (S.regCams.length) {
      vp.draw({ cams: S.regCams, showCams: true, bright: true, reveal: S.regCams.length, active: -1, sel: -1, cloud: S.regPts, cloudRgb: S.regRgb });
    } else {
      pairStage(ctx, w, h, dpr);   // nothing registered yet — hold the photos
    }
    return;
  }

  // train/done: the model, rendered by the trainer at this exact pose
  // (render capped at the session's view-buffer size, blit scales up)
  const onFrame = S.atFrame >= 0;
  const pose = vp.viewPose();
  if (gpuCanvas && S.session && S.session.trainer) {
    const now = performance.now();
    if (vp.dirty) S._camMovedAt = now;
    const training = S.state === 'train' && S.session.training;
    const moving = vp.dirty || now - (S._camMovedAt || 0) < 250;
    // progressive resolution: reduced while the camera moves or training
    // runs (fluid), the FULL device-pixel canvas once it settles (true
    // retina) — always inside the allocated view buffers / tile-grid budget.
    // The SOG viewer renders far cheaper than the compute rasterizer, so it
    // affords a much higher moving budget (less visible softness while
    // rotating), highest where a mouse implies desktop-class GPU.
    const sogView = !(S.session.trainer && S.session.trainer.device);
    const moveBudget = sogView
      ? (matchMedia('(pointer: fine)').matches ? 2.8e6 : 1.8e6)
      : 1.3e6;
    const budgetPx = Math.min(S.viewPixBudget || 2560 * 1440,
      (training || moving) ? moveBudget : 1e9);
    const sc = Math.min(1, Math.sqrt(budgetPx / (w * h)));
    const gw = Math.max(2, Math.round(w * sc)), gh = Math.max(2, Math.round(h * sc));
    const key = `${gw}x${gh}|${Math.round(pose.f)}|` +
      pose.R.map((v) => Math.round(v * 8192)).join(',') + '|' +
      pose.t.map((v) => Math.round(v * 8192)).join(',');
    // re-render when the view actually changed; while training also refresh
    // the evolving model — 2/s at most, fewer on slow devices (~25
    // iterations' worth of time between refreshes). Each render here also
    // pushes back the session's own auto-refresh, so there is ONE timer.
    const refreshMs = Math.max(500, 25000 / Math.max(1, S.itersPerSec || 100));
    if (key !== S._viewKey || (training && now - (S._lastViewAt || 0) > refreshMs)) {
      S._viewKey = key;
      S._lastViewAt = now;
      if (gpuCanvas.width !== gw || gpuCanvas.height !== gh) {
        gpuCanvas.width = gw; gpuCanvas.height = gh;
        S.session.view.attach(gpuCanvas);
      }
      S.session.view.setCamera({
        R: pose.R, t: pose.t,
        f: pose.f * sc, cx: pose.cx * sc, cy: pose.cy * sc, w: gw, h: gh,
      });
      S.session.view.renderNow();
    }
  }

  vp.draw({
    model: !!gpuCanvas,
    cams: S.scene.cams,
    // on a photograph (compare modes) the overlays read as artefacts in the
    // image — frustums only while moving around freely, never during the
    // intro flight, and hidden entirely in the finished viewer (the drawing
    // path stays; flip this when frustums earn a place there again)
    showCams: S.state !== 'done' && !onFrame && !S.tour,
    showPath: S.state === 'train' && !onFrame,
    faint: S.state === 'done',
    skip: S.atFrame,
    active: S.state === 'train' && S.session.training
      ? (S.scene.cams.find((c) => c.ci === S.session.activeCam) || {}).i : -1,
    sel: S.sel,
    dimOthers: S.state === 'train' && S.session.training,
  });

  if (S.fade > .005 && dev.ready) {
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.globalAlpha = S.fade;
    const errKey = `${S.atFrame}:${S.iter}`;
    if (S.compare === 'error' && S.session && S.session.trainer) ensureErrRender(errKey);
    S.rect = dev.render(ctx, w / dpr, h / dpr, {
      mode: S.compare, loupe: S.loupe, swipe: S.swipe, dpr,
      model: (S._errRender && S._errRender.key === errKey) ? S._errRender.canvas : null,
      key: errKey,
    });
    ctx.restore();
  }
}

/** a photograph filling the stage (ready + the first prep beats) */
function photoStage(ctx, w, h, dpr, marks = false) {
  ctx.fillStyle = '#070909';
  ctx.fillRect(0, 0, w, h);
  if (!S.photos.length || !S.photos[S.sel] || !S.photos[S.sel].url) return; // intro: bare stage
  // fast machines outrun the decoder during the landmarks beat (the selected
  // frame changes every ~90ms, a full-res decode takes longer) — hold the
  // last DECODED photo instead of flashing black, and mark that one
  let img = readyBmp(S.photos[S.sel].url);
  let shownIdx = S.sel;
  if (img) {
    S._lastReady = { img, idx: S.sel };
  } else if (S._lastReady) {
    img = S._lastReady.img;
    shownIdx = S._lastReady.idx;
  }
  if (!img) return;
  const r = fitRect(img.width, img.height, w / dpr, h / dpr, 10);
  ctx.save(); ctx.scale(dpr, dpr);
  ctx.globalAlpha = S.state === 'ready' ? .42 : 1;
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 1;
  if (marks) drawRealMarks(ctx, r, shownIdx);
  ctx.restore();
}

/** the solver's actual keypoints, appearing as they are found */
function drawRealMarks(ctx, r, imgIdx) {
  const f = S.feats.get(imgIdx);
  const fr = S.session && S.session.frames && S.session.frames[imgIdx];
  if (!f || !fr || !f.x || !f.y) return;
  const sx = r.w / (fr.fw || 1), sy = r.h / (fr.fh || 1);
  ctx.fillStyle = 'rgba(47,212,193,.8)';
  const n = Math.min(f.n || 0, 1200);
  for (let k = 0; k < n; k++) {
    if (f.x[k] != null && f.y[k] != null) {
      ctx.fillRect(r.x + f.x[k] * sx - 1, r.y + f.y[k] * sy - 1, 2, 2);
    }
  }
  ctx.fillStyle = '#93a1a0';
  ctx.font = '500 10px "Spline Sans Mono", monospace';
  ctx.fillText(`${fmt(f.n)} LANDMARKS`, r.x + 4, r.y + r.h + 14);
  // capture-order debugging: the photo's EXIF time, bottom-right — a walk
  // must read as a monotonic clock here; n/a = no EXIF (name order decides)
  const name = (S.photos[imgIdx] || {}).name || '';
  const cap = S.capDates && S.capDates.get(name);
  const pad2 = (v) => String(v).padStart(2, '0');
  const label = cap
    ? `${pad2(new Date(cap).getHours())}:${pad2(new Date(cap).getMinutes())}:${pad2(new Date(cap).getSeconds())}`
    : name; // no EXIF: the file name IS the ordering key — show it instead
  ctx.textAlign = 'right';
  ctx.fillText(label, r.x + r.w - 4, r.y + r.h + 14);
  ctx.textAlign = 'left';
}

/** two photographs, and the matches that survived between them.
 *  The stage HOLDS what it shows: a newer pair replaces the current one only
 *  when both of its bitmaps are decoded and the current pair has had its
 *  PAIR_HOLD on screen. Matching emits many pairs a second and the display
 *  LRU rarely holds both photos of a fresh pair, so switching on every
 *  event was a black frame per decode and a photo swap per event (flicker,
 *  "hardly see the photos"). Evicted bitmaps are never closed (img.js), so
 *  keeping references here is safe. Before the first pair is ready, the
 *  single-photo stage stands in — never black. */
const PAIR_HOLD = 700;
function pairStage(ctx, w, h, dpr) {
  const now = performance.now();
  const cand = S.lastPairEv;
  let sp = S.shownPair;
  if (cand && (!sp || (cand !== sp.ev && now - sp.since >= PAIR_HOLD))) {
    const p1 = S.photos && S.photos[cand.i];
    const p2 = S.photos && S.photos[cand.j];
    const a = p1 && p1.url ? readyBmp(p1.url) : null;
    const b = p2 && p2.url ? readyBmp(p2.url) : null;
    if (a && b) sp = S.shownPair = { ev: cand, a, b, since: now };
  }
  if (!sp) return photoStage(ctx, w, h, dpr, true);
  ctx.fillStyle = '#070909';
  ctx.fillRect(0, 0, w, h);
  const { ev, a, b } = sp;
  const half = w / dpr / 2;
  ctx.save(); ctx.scale(dpr, dpr);
  const r1 = fitRect(a.width, a.height, half, h / dpr, 14);
  const r2 = fitRect(b.width, b.height, half, h / dpr, 14);
  r2.x += half;
  ctx.globalAlpha = .7;
  ctx.drawImage(a, r1.x, r1.y, r1.w, r1.h);
  ctx.drawImage(b, r2.x, r2.y, r2.w, r2.h);
  ctx.globalAlpha = 1;

  const fa = S.feats.get(ev.i), fb = S.feats.get(ev.j);
  const f1 = S.session && S.session.frames && S.session.frames[ev.i];
  const f2 = S.session && S.session.frames && S.session.frames[ev.j];
  if (fa && fb && f1 && f2 && fa.x && fb.x && ev.sample) {
    ctx.strokeStyle = 'rgba(47,212,193,.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k + 1 < ev.sample.length * 2 && k < 100; k += 2) {
      const pair = ev.sample[k / 2];
      if (!pair) continue;
      const [ia, ib] = pair;
      if (ia == null || ib == null || fa.x[ia] == null || fb.x[ib] == null) continue;
      const x1 = r1.x + fa.x[ia] * (r1.w / (f1.fw || 1)), y1 = r1.y + fa.y[ia] * (r1.h / (f1.fh || 1));
      const x2 = r2.x + fb.x[ib] * (r2.w / (f2.fw || 1)), y2 = r2.y + fb.y[ib] * (r2.h / (f2.fh || 1));
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#93a1a0';
  ctx.font = '500 10px "Spline Sans Mono", monospace';
  ctx.fillText(`FRAME ${ev.i + 1}`, r1.x + 4, r1.y - 6);
  ctx.fillText(`FRAME ${ev.j + 1}`, r2.x + 4, r2.y - 6);
  ctx.restore();
}

// ── details sheet ───────────────────────────────────────────────────────────
const DTABS = [['score', 'Score'], ['marks', 'Landmarks'], ['matches', 'Matching'], ['cams', 'Cameras'], ['perf', 'Timing'], ['gpu', 'GPU']];

// ── GPU facts: what this device is, for the Details sheet and bug reports ──
// The adapter probed at boot serves the wall (no session yet); a live
// session's own adapter/device replaces it (its limits are the ones granted).
function gpuFacts() {
  const g = S.session && S.session.gpu;
  const adapter = (g && g.adapter) || (S.gpuProbe && S.gpuProbe.adapter) || null;
  const device = (g && g.device) || null;
  const info = (g && g.info) || (adapter && adapter.info) || (S.gpuProbe && S.gpuProbe.info) || {};
  const lim = (device && device.limits) || (adapter && adapter.limits) || null;
  const feats = device ? [...device.features] : adapter ? [...adapter.features] : [];
  const gb = (v) => v ? `${(v / (1 << 30)).toFixed(v >= (1 << 30) ? 1 : 2)} GB` : '—';
  const nav = navigator;
  return {
    ready: !!(adapter || device || S.gpuProbe),
    name: [info.vendor, info.architecture, info.device].filter(Boolean).join(' ') || (S.gpuProbe && S.gpuProbe.failed ? 'no WebGPU adapter' : '…'),
    description: info.description || '',
    vendor: info.vendor || '—', architecture: info.architecture || '—', device: info.device || '—',
    granted: !!device,
    features: feats.filter((f) => /subgroups|shader-f16|timestamp-query|float32-filterable|bgra8unorm-storage/.test(f)),
    maxBufferSize: lim ? gb(lim.maxBufferSize) : '—',
    maxStorageBinding: lim ? gb(lim.maxStorageBufferBindingSize) : '—',
    workgroupStorage: lim ? `${(lim.maxComputeWorkgroupStorageSize / 1024).toFixed(0)} KB` : '—',
    invocations: lim ? String(lim.maxComputeInvocationsPerWorkgroup) : '—',
    texture2d: lim ? String(lim.maxTextureDimension2D) : '—',
    ua: nav.userAgent,
    platform: (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '—',
    cores: nav.hardwareConcurrency || '—',
    memory: nav.deviceMemory ? `${nav.deviceMemory} GB` : '—',
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}`,
    ips: S.itersPerSec || 0,
  };
}

/** the about card's "This device" line — filled when the card opens and
 *  again when the boot probe lands */
function renderAboutGpu() {
  const el = $('about-gpu');
  if (!el) return;
  const g = gpuFacts();
  el.hidden = false;
  const bits = [g.name];
  if (g.maxBufferSize !== '—') bits.push(`${g.maxBufferSize} buffers`);
  if (g.features.length) bits.push(g.features.filter((f) => /subgroups|shader-f16/.test(f)).join(', '));
  if (g.ips) bits.push(`${fmt(g.ips)} cycles/s`);
  $('about-gpu-txt').textContent = bits.filter(Boolean).join(' · ');
  const btn = $('about-gpu-copy');
  if (!btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => copyGpuReport(btn));
  }
}

/** the GPU tab of the Details sheet (stat: the sheet's row builder) */
function gpuTab(stat) {
  const g = gpuFacts();
  return {
    cap: 'The graphics adapter this browser gives the trainer, and the limits it granted.',
    title: g.name,
    body: [
      g.description ? esc(g.description) : 'Vendor, architecture and device as WebGPU reports them; browsers deliberately keep this coarse.',
      'Training speed is mostly memory bandwidth: the same photos train at identical quality on ' +
      'a phone and a desktop card, dozens of times apart in cycles per second. Copy the report ' +
      'below when something trains slower than expected, or fails to start.',
    ],
    rows: [
      stat('Vendor', esc(g.vendor)),
      stat('Architecture', esc(g.architecture)),
      stat('Device', esc(g.device)),
      stat('Buffer limit', g.maxBufferSize, 'accent'),
      stat('Storage binding', g.maxStorageBinding),
      stat('Workgroup memory', g.workgroupStorage),
      stat('Features', g.features.length ? esc(g.features.join(', ')) : '—'),
      g.ips ? stat('Speed', `${fmt(g.ips)} <small>cycles/s</small>`) : '',
      stat('Screen', esc(g.screen)),
      stat('CPU cores', esc(String(g.cores))),
    ].filter(Boolean),
    btns: [{ label: 'Copy GPU report', fn: copyGpuReport }],
  };
}

function buildGpuReport() {
  const g = gpuFacts();
  const L = [];
  L.push(`splat.js gpu report — ${new Date().toISOString()}`);
  L.push(`url: ${location.href}`);
  L.push(`ua: ${g.ua}`);
  L.push(`platform: ${g.platform} · cores ${g.cores} · memory ${g.memory}`);
  L.push(`screen: ${g.screen}`);
  L.push(`gpu: ${g.name}${g.description ? ` — ${g.description}` : ''}`);
  L.push(`limits: maxBufferSize ${g.maxBufferSize} · maxStorageBufferBindingSize ${g.maxStorageBinding} · workgroup storage ${g.workgroupStorage} · invocations ${g.invocations} · texture2d ${g.texture2d}`);
  L.push(`features: ${g.features.join(', ') || 'none of interest'}${g.granted ? ' (device granted)' : ' (adapter)'}`);
  if (S.session) {
    L.push(`session: ${S.state} · ${fmt(S.splats || 0)} splats · ${fmt(S.iter || 0)} cycles${g.ips ? ` · ${fmt(g.ips)} cycles/s` : ''}`);
    L.push(`settings: ${JSON.stringify(S.settings)} · preset ${S.preset ? S.preset.id : '?'}`);
  }
  return L.join('\n');
}

async function copyGpuReport(btn) {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(buildGpuReport());
    btn.textContent = 'Copied ✓';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = old; }, 1600);
}

/** the sheet's state lives in the address: ?details=<tab> — a refresh keeps
 *  it open, and the link hands the same tab (GPU, say) to whoever it is sent
 *  to, on THEIR device */
function syncDetailsUrl() {
  const u = new URL(location.href);
  const was = u.searchParams.get('details');
  const now = $('details').hidden ? null : S.detailTab;
  if ((was || null) === now) return;
  if (now) u.searchParams.set('details', now); else u.searchParams.delete('details');
  history.replaceState(history.state, '', u);
}

function closeDetails() {
  $('details').hidden = true;
  syncDetailsUrl();
}

function openDetails() {
  $('details').hidden = false;
  if (!S.session) {
    // the wall: only the device itself has facts to show
    S.detailTab = 'gpu';
    renderDetails();
    syncDetailsUrl();
    return;
  }
  // per-photo scores: one render + readback per camera, started the first
  // time the sheet asks for them (not at finish, where they stole the GPU
  // from the viewer)
  if (S.state === 'done' && S.session && S.session.trainer && S.session.trainer.device &&
      S.scene && S._scoredGen !== S.gen) {
    S._scoredGen = S.gen;
    scoreFrames().catch(() => {});
  }
  $('d-export').replaceChildren(buildExport());
  renderDetails();
  syncDetailsUrl();
}

function renderDetails() {
  if (!S.session) return renderDetailsNoSession();
  const ses = S.session, recon = ses.recon;
  const n = S.photos.length;
  const placed = recon.cams.length;
  $('d-sub').textContent = `${S.preset.name} · ` +
    // pano sets have no 1:1 photograph list — count placed views instead
    (n ? `${n} photographs · ${placed} placed · ` : `${placed} views placed · `) +
    `${fmt(recon.points.length)} points · ${fmt(S.splats)} splats`;

  // a restored share never ran the solve here — tabs whose stats are empty
  // (landmarks, matching, timing) simply don't appear
  const have = {
    marks: S.feats.size > 0,
    matches: S.solveStats.pairsChecked > 0,
    perf: !!(ses.perf && ses.perf.frames && ses.perf.frames.length),
  };
  const tabs = DTABS.filter(([id]) => have[id] !== false);
  if (!tabs.some(([id]) => id === S.detailTab)) S.detailTab = 'score';
  const segHost = $('d-seg');
  segHost.innerHTML = '';
  tabs.forEach(([id, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('aria-pressed', String(S.detailTab === id));
    b.addEventListener('click', () => { S.detailTab = id; renderDetails(); syncDetailsUrl(); });
    segHost.appendChild(b);
  });

  const stat = (k, v, tone) =>
    `<div class="stat"><span class="stat-k">${k}</span>
     <span class="stat-v"${tone ? ` data-tone="${tone}"` : ''}>${v}</span></div>`;

  const featsTotal = [...S.feats.values()].reduce((a, f) => a + f.n, 0);
  const selFeats = (S.feats.get(S.sel) || {}).n;
  const survived = S.solveStats.pairsChecked
    ? Math.round(100 * S.solveStats.pairsUsable / S.solveStats.pairsChecked) : 0;

  const gap = (S.psnrTrain != null && S.psnrHold != null) ? S.psnrTrain - S.psnrHold : null;
  const pf = (ses.perf && ses.perf.frames) || [];
  const colv = (i) => pf.map((r) => r[i]);
  const ipsAll = pf.length > 1
    ? (pf[pf.length - 1][1] - pf[0][1]) / Math.max(.001, (pf[pf.length - 1][0] - pf[0][0]) / 1000) : 0;
  const metCosts = colv(7).filter((v) => v > 0);
  const bench = !!(S.session && S.session.holdout >= 0);   // ?eval mode

  const T = {
    score: {
      cap: bench
        ? 'Turquoise: the photos it trained on. Amber: the held-out test photos.'
        : 'How closely the splats match the photographs.',
      title: 'Score over the run',
      body: [
        'Each cycle renders the splats from one photo\'s viewpoint and nudges them to ' +
        'shrink the difference to that photograph. Higher dB is better; +3 dB halves the error.',
        bench
          ? 'The amber photos never trained the model, so their score only rises when the 3D is ' +
            'actually right — the turquoise curve can also rise by memorising.'
          : 'Every photo trains the model here. Add ?eval to the address to hold every 8th ' +
            'photo out of training and score those instead — the honest benchmark number.',
      ],
      rows: [
        stat('Cycles', fmt(S.iter)),
        S.psnrTrain != null ? stat('Trained photos', `${S.psnrTrain.toFixed(1)} <small>dB</small>`, 'accent') : '',
        S.psnrHold != null ? stat('Hidden photo', `${S.psnrHold.toFixed(1)} <small>dB</small>`, 'alt') : '',
        S.psnrTest != null ? stat(`Test photos (${S.psnrTest.frames.length})`, `${S.psnrTest.psnr.toFixed(2)} <small>dB</small>`, 'alt') : '',
        gap != null ? stat('Gap', `${gap.toFixed(1)} <small>dB</small>`, Math.abs(gap) < 1.5 ? 'accent' : undefined) : '',
        stat('Splats', fmt(S.splats)),
        stat('Exported file', `${(S.splats * 164 / 1e6).toFixed(1)} <small>MB</small>`),
        stat('Time', `${S.minutes} <small>min</small>`),
      ].filter(Boolean),
      btns: bench ? [{
        label: 'Look at a frame it never saw',
        fn: () => {
          const h = S.scene.cams.find((c) => c.state === 'holdout');
          closeDetails();
          S.compare = 'swipe';
          select(h ? h.i : S.sel);
        },
      }] : [],
    },
    marks: {
      cap: `Photo ${S.sel + 1} of ${n} — flat sky and plain walls stay empty.`,
      title: 'Spots worth remembering',
      body: [
        'Before there is any 3D, every photo is scanned for places that could be recognised ' +
        'again from another angle: corners, texture, edges. Each one gets a short numeric ' +
        'fingerprint of its surroundings.',
        'Smooth surfaces produce nothing, which is exactly why blank walls, water and sky are ' +
        'hard for this kind of reconstruction.',
      ],
      rows: [
        stat('Marks on this frame', selFeats != null ? fmt(selFeats) : '—'),
        stat('Average per photo', fmt(featsTotal / Math.max(1, S.feats.size))),
        stat('Across the set', fmt(featsTotal)),
      ],
    },
    matches: {
      cap: 'The pairings that survived the geometry test, drawn between two frames.',
      title: 'The same spot, twice',
      body: [
        'Fingerprints are compared photo against photo. Plenty of pairings are wrong, so every ' +
        'candidate set is tested against geometry: only pairings that could be explained by one ' +
        'rigid scene seen from two positions survive.',
        'What survives is a chain — a spot tracked through many photos at once — and that chain ' +
        'is what makes a position solvable.',
      ],
      rows: [
        stat('Pairs compared', fmt(S.solveStats.pairsChecked)),
        stat('Survived the test', `${fmt(S.solveStats.pairsUsable)} · ${survived}%`, 'accent'),
      ],
    },
    cams: {
      cap: 'The sparse cloud and the position of every photograph. Drag to orbit.',
      title: 'Where the camera was',
      body: [
        'A spot seen from two known directions fixes a point in space; a photo with enough known ' +
        'points fixes a camera. Solved together they give both — the positions, and a sparse ' +
        'cloud of a few thousand points.',
        'That cloud is far too coarse to look at. Its job is to say roughly where surfaces are, ' +
        'so the splats do not start from nothing.',
      ],
      rows: [
        stat('Placed', `${placed} <small>/ ${n}</small>`, placed === n ? 'accent' : 'red'),
        stat('Points', fmt(recon.points.length)),
        stat('Reprojection error', recon.rmsBA ? `${recon.rmsBA.toFixed(2)} <small>px</small>` : '—',
          recon.rmsBA && recon.rmsBA < 1 ? 'accent' : undefined),
        stat('Focal length', `${Math.round(recon.cams[0].f)} <small>px, solved — no lens data was read</small>`),
        stat('Solve time', `${Math.round(S.solveStats.solveSec)} <small>s</small>`),
      ],
    },
    perf: {
      cap: 'Every submitted batch: encode, view render, GPU wait, score readback — in milliseconds.',
      title: 'Where the time went',
      body: [
        'The loop times itself as it runs: how long each batch of cycles takes to encode, how ' +
        'long the GPU makes it wait, and what the score readbacks cost — a readback has to ' +
        'drain everything queued before it can measure.',
        'Speeds differ mostly by memory bandwidth: a phone GPU sits dozens of times below a ' +
        'desktop card, at identical quality. The downloaded log is the file to attach when ' +
        'something is slower than it should be.',
      ],
      rows: [
        stat('GPU', (() => {
          const gi = (S.session && S.session.gpu && S.session.gpu.info) || {};
          return esc([gi.vendor, gi.architecture].filter(Boolean).join(' ')) || '—';
        })()),
        stat('Speed', ipsAll ? `${fmt(ipsAll)} <small>cycles/s</small>` : '—', 'accent'),
        stat('GPU per cycle', ipsAll ? `${(1000 / ipsAll).toFixed(1)} <small>ms</small>` : '—'),
        stat('Cycles per submit', pf.length ? fmt(pctl(colv(2), .5)) : '—'),
        stat('Score readback', metCosts.length ? `${Math.round(pctl(metCosts, .5))} <small>ms median</small>` : '—'),
        stat('GPU wait', pf.length ? `${Math.round(pctl(colv(6), .9))} <small>ms p90</small>` : '—'),
      ],
      btns: [
        { label: 'Download log', fn: downloadPerfLog },
        { label: 'Copy to clipboard', fn: copyPerfLog },
      ],
    },
    gpu: S.detailTab === 'gpu' ? gpuTab(stat) : null,
  }[S.detailTab];

  $('d-prev').hidden = $('d-next').hidden = S.detailTab !== 'marks';

  // the visual slot: the photo/pair/cameras canvas, the score chart, or the log
  const vis = (S.detailTab === 'perf' || S.detailTab === 'gpu') ? 'perf' : S.detailTab === 'score' ? 'chart' : 'cv';
  $('d-cv').hidden = vis !== 'cv';
  $('d-chart').hidden = vis !== 'chart';
  $('d-perf').hidden = vis !== 'perf';
  if (vis === 'perf') $('d-perf').textContent = S.detailTab === 'gpu' ? buildGpuReport() : buildPerfReport();
  if (vis === 'chart') {
    if (!dchart) dchart = new Chart($('d-chart'), {});
    dchart.maxIter = S.maxIters;
    // a restored share has no live loss history — its recorded training
    // curve (recon stats) is the same line, saved at share time
    const rstats = (S.restored && S.restored.stats) || {};
    const hist = (S.session.lossHistory && S.session.lossHistory.length)
      ? S.session.lossHistory : (rstats.chart || []);
    dchart.train = hist.map(([i, v]) => [i, v]);
    dchart.hold = chart ? chart.hold : ((S.holdHist && S.holdHist.length ? S.holdHist : rstats.holds) || []).slice();
    dchart.events = S.chartEvents.map((e) => ({ ...e, at: e.iter / S.maxIters }));
    dchart.resize();
    dchart.draw();
  }

  $('d-cap').textContent = T.cap;
  $('d-txt').innerHTML =
    `<h3>${T.title}</h3>${T.body.map((p) => `<p>${p}</p>`).join('')}<div class="grp">${T.rows.join('')}</div>` +
    (T.btns ? `<div class="tabbtns">${T.btns.map((b, i) =>
      `<button class="btn btn-quiet" data-bi="${i}">${b.label}</button>`).join('')}</div>` : '');
  if (T.btns) {
    $('d-txt').querySelectorAll('[data-bi]').forEach((el) =>
      el.addEventListener('click', () => T.btns[el.dataset.bi].fn(el)));
  }

  if (S.detailTab === 'cams' && !dvp) {
    dvp = new Viewport($('d-cv'));
    dvp.setScene(S.scene);
    dvp.setUp(vp.up);
    // frame the CAMERA PATH, not the whole cloud — the cloud's far shell
    // would push the rig to a speck
    const placed = S.scene.cams.filter((c) => c.R).map(camCentre);
    if (placed.length) {
      const ctr = [0, 1, 2].map((k) => placed.reduce((a, p) => a + p[k], 0) / placed.length);
      const rad = Math.sqrt(placed.reduce((a, p) =>
        Math.max(a, (p[0] - ctr[0]) ** 2 + (p[1] - ctr[1]) ** 2 + (p[2] - ctr[2]) ** 2), 0));
      dvp.target = ctr;
      dvp.dist = Math.max(0.5, rad * 2.6);
    }
  }
  if (dvp) dvp.resize();
}

/** the sheet on the wall, before any run: the GPU tab alone */
function renderDetailsNoSession() {
  S.detailTab = 'gpu';
  $('d-sub').textContent = 'This device · no run open';
  $('d-export').replaceChildren();
  const segHost = $('d-seg');
  segHost.innerHTML = '';
  const b = document.createElement('button');
  b.textContent = 'GPU';
  b.setAttribute('aria-pressed', 'true');
  segHost.appendChild(b);
  const stat = (k, v, tone) =>
    `<div class="stat"><span class="stat-k">${k}</span>
     <span class="stat-v"${tone ? ` data-tone="${tone}"` : ''}>${v}</span></div>`;
  const T = gpuTab(stat);
  $('d-prev').hidden = $('d-next').hidden = true;
  $('d-cv').hidden = true;
  $('d-chart').hidden = true;
  $('d-perf').hidden = false;
  $('d-perf').textContent = buildGpuReport();
  $('d-cap').textContent = T.cap;
  $('d-txt').innerHTML =
    `<h3>${T.title}</h3>${T.body.map((p) => `<p>${p}</p>`).join('')}<div class="grp">${T.rows.join('')}</div>` +
    `<div class="tabbtns">${T.btns.map((b2, i) => `<button class="btn btn-quiet" data-bi="${i}">${b2.label}</button>`).join('')}</div>`;
  $('d-txt').querySelectorAll('[data-bi]').forEach((el) =>
    el.addEventListener('click', () => T.btns[el.dataset.bi].fn(el)));
}

/** Landmarks tab: step through the photos (the filmstrip is under the sheet) */
function detailFlip(dir) {
  const n = S.photos.length;
  if (!n) return;
  S.sel = (S.sel + dir + n) % n;
  if (S.photos[S.sel]?.url) bmp(S.photos[S.sel].url);                                  // decode now
  const next = (S.sel + dir + n) % n;
  if (S.photos[next]?.url) bmp(S.photos[next].url);                  // prefetch onward
  renderDetails();
}

function drawDetail() {
  // score = the chart canvas, perf/gpu = the log pre — none repaints per frame
  if (S.detailTab === 'perf' || S.detailTab === 'gpu' || S.detailTab === 'score' || !S.session) return;
  const cv = $('d-cv');
  if (!cv.clientWidth) return;
  if (S.detailTab === 'cams') {
    if (!dvp) return;
    const r = cv.getBoundingClientRect();
    if (Math.abs(r.width * (dvp.dpr || 1) - cv.width) > 2) dvp.resize();
    dvp.draw({ points: true, cams: S.scene.cams, showCams: true, showPath: true, sel: S.sel, active: -1 });
    return;
  }
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(cv.clientWidth * dpr)) {
    cv.width = Math.round(cv.clientWidth * dpr);
    cv.height = Math.round(cv.clientHeight * dpr);
  }
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  if (S.detailTab === 'marks') {
    ctx.fillStyle = '#070909'; ctx.fillRect(0, 0, w, h);
    const p = S.photos && S.photos[S.sel];
    if (!p || !p.url) return;
    const img = readyBmp(p.url);
    if (!img) return;
    const r = fitRect(img.width, img.height, w / dpr, h / dpr, 6);
    ctx.save(); ctx.scale(dpr, dpr);
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    drawRealMarks(ctx, r, S.sel);
    ctx.restore();
  } else {
    pairStage(ctx, w, h, dpr);
  }
}
