// session.js — layer 2: the one object a UI talks to.
//
//   const s = createSession();
//   s.on('stage',   e => ...)   // { stage, done, total, detail }
//   s.on('metrics', e => ...)   // { iter, splats, itersPerSec, psnrTrain, psnrHold }
//   s.on('event',   e => ...)   // { kind: 'refine' | 'train-complete', ... }
//   s.on('log',     m => ...)   // prose, for consoles
//
//   await s.load(files);        // File[] / Blob[] -> Frames
//   await s.solve();            // SfM: cameras + sparse points
//   await s.seed();             // Gaussians + WebGPU trainer
//   s.start(); s.pause();       // the training loop (policy lives HERE)
//
//   s.view.attach(canvas);      // render target
//   s.view.lookThrough(i);      // camera = training frame i
//   s.view.setCamera(pose);     // free camera
//   await s.exportPlyBlob();    // standard 3DGS .ply (opacity comp baked)
//
// All numeric policy that used to live in the demo page is here: iteration
// batching, auto-stop, refine cadence, blur exclusion, holdout choice, PSNR
// conversion, and the hidden-tab watchdog.

import { decodeFrames } from './io/frames.js';
import { isEquirect, sliceEquirect, faceSizeFor, probeImageSize, FACE_ROTS } from './io/pano.js';
import { runSfM } from './sfm/sfm.js';
import { initGaussians } from './gs/init.js';
import { GSTrainer } from './gs/trainer.js';
import { createGpu } from './gpu/context.js';
import { gaussiansToPly, bakeOpacityCompensation } from './io/ply.js';

/** world-space position of a camera pose {R, t} */
export function camPosition({ R, t }) {
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/** Undistort training images in place (bilinear resample) so the pinhole
 *  trainer matches BA's distortion-corrected geometry. Returns true when a
 *  resample actually happened (|k| above the noise floor). Out-of-frame
 *  samples get a -1 sentinel the trainer excludes from the loss. */
export function undistortFrames(frames, recon) {
  const { k1, k2 } = recon;
  // below ~0.01 the estimated distortion is noise (synthetic GT k1=0 comes
  // back as ~0.005) and resampling would only soften the targets
  if (Math.abs(k1) < 0.01 && Math.abs(k2) < 0.01) return false;
  for (const im of frames) {
    const f = recon.fFeat * (im.tw / im.fw);
    const cx = im.tw / 2, cy = im.th / 2;
    const src = im.rgb;
    const dst = new Float32Array(src.length);
    for (let y = 0; y < im.th; y++) {
      for (let x = 0; x < im.tw; x++) {
        const xp = (x + 0.5 - cx) / f, yp = (y + 0.5 - cy) / f;
        const r2 = xp * xp + yp * yp;
        const D = 1 + k1 * r2 + k2 * r2 * r2;
        const rx = f * xp * D + cx - 0.5;
        const ry = f * yp * D + cy - 0.5;
        const o = (y * im.tw + x) * 3;
        if (rx < 0 || ry < 0 || rx > im.tw - 1.001 || ry > im.th - 1.001) {
          dst[o] = -1; dst[o + 1] = -1; dst[o + 2] = -1;
          continue;
        }
        const x0 = rx | 0, y0 = ry | 0;
        const fx = rx - x0, fy = ry - y0;
        const i00 = (y0 * im.tw + x0) * 3, i01 = i00 + 3;
        const i10 = i00 + im.tw * 3, i11 = i10 + 3;
        for (let c = 0; c < 3; c++) {
          dst[o + c] =
            src[i00 + c] * (1 - fx) * (1 - fy) + src[i01 + c] * fx * (1 - fy) +
            src[i10 + c] * (1 - fx) * fy + src[i11 + c] * fx * fy;
        }
      }
    }
    im.rgb = dst;
  }
  return true;
}

/**
 * @typedef {object} SessionOptions
 * @property {GPUDevice} [device]        host-owned WebGPU device to share
 * @property {number} [maxIters=60000]   auto-stop; trainer schedules scale to it
 * @property {number} [itersPerFrame=15] training batch per animation frame
 * @property {number} [initTarget=60000] initial Gaussian count (grows during training)
 * @property {number|'auto'|null} [holdout='auto']  frame excluded from training
 *   and scored as the novel-view metric; 'auto' picks a sharp mid-sequence frame
 * @property {number} [evalHoldEvery=4000]  holdout PSNR cadence (iterations)
 * @property {number} [evalSplit=0]  the standard benchmark protocol: every Nth
 *   frame of the input order is excluded from training and scored together via
 *   evalTestPsnr() (papers use N=8); 0 = off
 * @property {object} [sfm]              SfmOptions passed to solve()
 * @property {object} [trainer]          extra GSTrainer options (shDeg, ...)
 * @property {object} [frames]           FrameOptions passed to load()
 */

class Emitter {
  constructor() { this.map = new Map(); }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.map.get(type).delete(fn);
  }
  emit(type, e) {
    const s = this.map.get(type);
    if (s) for (const fn of s) fn(e);
  }
}

export class Session {
  /** @param {SessionOptions} [opts] */
  constructor(opts = {}) {
    this.opts = opts;
    this.frames = [];
    this.recon = null;      // solve() result: { cams, points, k1, k2, ... }
    this.model = null;      // seed() result: { data, n, center, radius }
    this.trainer = null;
    this.gpu = null;
    this.holdout = -1;
    this.testCams = [];
    this.training = false;
    this.lossHistory = [];  // [iter, psnrTrain]
    this._fences = [];      // in-flight batch fences (see _frameLoop)
    // Per-frame loop timings, recorded by default — the cost is a handful of
    // performance.now() calls and one small array row per submitted batch.
    // opts.perf: false disables.
    this.perf = opts.perf === false ? null : { frames: [], marks: [] };
    this._em = new Emitter();
    this._debug = null;     // solver internals (feats/tracks) for UI beats
    this.view = new SessionView(this);
  }

  on(type, fn) { return this._em.on(type, fn); }
  _log(m) { this._em.emit('log', m); }
  _stage(e) { this._em.emit('stage', e); }

  /** Decode photographs into Frames. files: File[]/Blob[]/{source,name}[]
   *  360 equirectangular panos (2:1 aspect) are detected here and sliced
   *  into six-face cubemap rigs — the solver then treats each pano as ONE
   *  camera pose and the trainer sees ordinary pinhole faces. */
  async load(files) {
    this._stage({ stage: 'decode', done: 0, total: files.length });
    const { prepared, rigs, focalNative, faceSize } = await this._slicePanos(files);
    this.frames = await decodeFrames(prepared, {
      ...this.opts.frames, log: (m) => this._log(m),
    });
    this._stage({ stage: 'decode', done: this.frames.length, total: files.length });
    if (this.frames.length < 2) throw new Error('need at least 2 decodable images');
    if (rigs) {
      // the sliced focal is exact but lives in face-native pixels; the
      // solver works at feature scale
      this.rigInfo = rigs;
      this.rigFocalPx = focalNative * this.frames[0].fw / faceSize;
      this._log(`camera rigs active: ${new Set(rigs.filter(Boolean).map((r) => r.id)).size} panos, ` +
        `focal ${this.rigFocalPx.toFixed(1)}px (known from the slice)`);
    }
    return this.frames;
  }

  /** Detect equirect panos in the input and slice them into rig faces.
   *  Detection reads image HEADERS only (probeImageSize) — a normal photo
   *  set pays nothing here; panos are decoded once, sliced, released. */
  async _slicePanos(files) {
    const meta = [];
    let panos = 0, sized = 0, maxW = 0;
    for (const f of files) {
      const src = f && f.source !== undefined ? f.source : f;
      const name = (f && f.name) || (src && src.name) || `image_${meta.length}`;
      const dims = await probeImageSize(src);
      const pano = !!dims && isEquirect(dims.w, dims.h);
      if (dims) sized++;
      if (pano) { panos++; maxW = Math.max(maxW, dims.w); }
      meta.push({ src, name, pano });
    }
    if (!panos) return { prepared: files, rigs: null };
    if (panos < sized) {
      throw new Error('mixed input: 360 panoramas and regular photos in one set are not ' +
        'supported yet — drop either panos or photos, not both');
    }
    // one shared face size + fov for the whole set (the solver's focal is shared)
    const size = faceSizeFor(maxW);
    this._log(`360 input: slicing ${panos} equirectangular panos into ${size}px cubemap rigs`);
    const prepared = [], rigs = [];
    let f = 0, rigId = 0;
    for (const b of meta) {
      const bmp = await createImageBitmap(b.src);
      const sl = sliceEquirect(bmp, size);
      bmp.close?.();
      f = sl.f;
      const base = b.name.replace(/\.[^.]+$/, '');
      sl.faces.forEach((cv, k) => {
        prepared.push({ source: cv, name: `${base}_f${k}` });
        rigs.push({ id: rigId, R: FACE_ROTS[k] });
      });
      rigId++;
      this._stage({ stage: 'decode', done: rigId, total: meta.length });
      await new Promise((r) => setTimeout(r, 0));
    }
    return { prepared, rigs, focalNative: f, faceSize: size };
  }

  /** Use frames prepared elsewhere (e.g. processSource on fetched bitmaps). */
  useFrames(frames) { this.frames = frames; return frames; }

  /** Structure from motion: camera poses + sparse points from the frames. */
  async solve(extra = {}) {
    const opts = { ...this.opts.sfm, ...extra };
    if (this.rigInfo && !opts.rigs) {
      opts.rigs = this.rigInfo;
      opts.focalPx = opts.focalPx ?? this.rigFocalPx;
      // sliced faces are bilinear resamples of the pano: the upsampled SIFT octave
      // (desktop default -1 since 2026-09-04) finds "features" in the interpolation.
      // MEASURED bar360 30k 2026-09-06: octave -1 19.90-19.95 vs octave 0 20.64-20.69
      // (aspect and the 8000 budget are neutral) — rigs never search below octave 0.
      if ((opts.siftFirstOctave ?? 0) < 0) opts.siftFirstOctave = 0;
      // and their f, k1 = k2 = 0, square pixel are exact by construction: BA refining
      // them only fits noise. MEASURED bar360 30k: lock +0.29 (old solve 20.69 -> 20.98),
      // +0.22 on the octave -1 solve. sfm.lockIntrinsics: false opts out.
      opts.lockIntrinsics = opts.lockIntrinsics ?? true;
    }
    // the GPU matcher shares the session device (created here rather than at
    // seed) — it carries the raised buffer limits big feature sets need
    if (!this.gpu) {
      this.gpu = await createGpu({ device: this.opts.device });
      this.gpu.onLost = (info) => this._deviceLost(info);
    }
    this.recon = await runSfM(
      this.frames,
      (m) => this._log(m),
      (imgIdx, x, y) => this.frames[imgIdx].sampleColor(x, y),
      {
        gpu: this.gpu,
        ...opts,
        onEvent: (e) => { this._stage(e); if (opts.onEvent) opts.onEvent(e); },
        debug: (d) => { this._debug = d; if (opts.debug) opts.debug(d); },
      });
    if (undistortFrames(this.frames, this.recon)) {
      this._log(`undistorted training images (k1 ${this.recon.k1.toFixed(4)}, k2 ${this.recon.k2.toFixed(4)})`);
    }
    if (this.opts.lowMem) {
      // the feature-scale grayscale is solve-only (SIFT + LK); on phones
      // 50 frames of it is ~140MB standing between us and the trainer
      for (const f of this.frames) f.gray = null;
    }
    this._stage({ stage: 'solved', done: 1, total: 1, detail: {
      cams: this.recon.cams.length, points: this.recon.points.length,
      rms: this.recon.rmsBA,
    } });
    return this.recon;
  }

  /** Load a reconstruction obtained elsewhere ({ cams, points, ... }). */
  useReconstruction(recon) {
    this.recon = { k1: 0, k2: 0, fScale: 1, medErr: 0, rmsBA: null, ...recon };
    // stored/external recons (a resumed run, a GT solve) usually lack fFeat.
    // undistortFrames divides by it — undefined turned EVERY target pixel
    // NaN→invalid, so a continued run trained against emptiness and faded
    // itself to transparency. All cams share the solve's feature-scale
    // focal, so the first one serves.
    if (this.recon.fFeat == null && this.recon.cams && this.recon.cams.length) {
      this.recon.fFeat = this.recon.cams[0].f;
    }
    return this.recon;
  }

  /** Seed Gaussians from the sparse cloud and set up the WebGPU trainer. */
  async seed(extra = {}) {
    if (!this.recon) throw new Error('solve() first');
    this._stage({ stage: 'seed', done: 0, total: 1 });
    // default seed scales with the solve's point count: the flat 60k
    // default seed-bound capacity (cap = seed x capMult) on point-rich
    // scenes — garden measured +0.4 dB from lifting it. Explicit
    // initTarget (phones pass one) always wins.
    const target = extra.initTarget || this.opts.initTarget ||
      Math.min(250000, Math.max(60000, this.recon.points.length * 8));
    const clones = Math.min(24, Math.max(2, Math.round(target / this.recon.points.length) - 1));
    const v2 = this.opts.trainer && this.opts.trainer.engine === 'v2';
    this.model = initGaussians(this.recon.points, clones, undefined,
      v2 ? { dc: 'sh', randRot: true } : {});
    this._log(`initialized ${this.model.n} Gaussians (scene radius ${this.model.radius.toFixed(2)})`);

    if (!this.gpu) this.gpu = await createGpu({ device: this.opts.device });
    this.gpu.onLost = (info) => this._deviceLost(info);
    const gi = this.gpu.info || {};
    const trainerOpts = {
      maxIters: this.opts.maxIters ?? 60000,
      ...this.opts.trainer, ...extra.trainer,
      gpu: this.gpu,
    };
    this.trainer = await GSTrainer.create(trainerOpts);
    this._log(`GPU: ${gi.vendor || 'unknown'} ${gi.architecture || ''} — ` +
      `${this.trainer.tileGrad ? 'tile-shared' : 'direct'} gradient accumulation`);

    // training-resolution intrinsics (recon poses live at feature scale)
    const cams = this.recon.cams.map((c) => {
      const im = this.frames[c.imgIdx];
      const s = im.tw / im.fw;
      return { ...c, f: c.f * s, ...(c.fy != null ? { fy: c.fy * s } : {}), cx: im.tw / 2, cy: im.th / 2, w: im.tw, h: im.th };
    });
    // output buffers must fit the largest view the host will ever render —
    // interactive canvases are usually LARGER than the training resolution
    const maxW = Math.max(this.opts.maxViewW ?? 2560, ...cams.map((c) => c.w));
    const maxH = Math.max(this.opts.maxViewH ?? 1440, ...cams.map((c) => c.h));
    this.trainer.setup(this.model, cams, this.frames, maxW, maxH, this.model.radius);
    if (this.opts.lowMem) {
      // targets now live on the GPU (packed RGBA8); the float32 CPU copies
      // are 3x that size and nothing reads them after setup
      for (const f of this.frames) { f.rgb = null; f.sampleColor = () => [0.5, 0.5, 0.5]; }
    }

    // blur-aware training: the blurriest frames stay registered (their poses
    // hold the chain together) but are excluded from the loss so the model
    // doesn't learn their motion blur
    const sh = this.trainer.camMeta.map((m) => this.frames[m.imgIdx].sharpness);
    const med = [...sh].sort((a, b) => a - b)[sh.length >> 1];
    this.trainer.excluded = new Set();
    this.trainer.camMeta.forEach((m, i) => {
      if (sh[i] < med * 0.45) this.trainer.excluded.add(i);
    });
    if (this.trainer.excluded.size) {
      this._log(`excluding ${this.trainer.excluded.size} blurry cameras from the training loss ` +
        `(sharpness < 45% of median; poses kept)`);
    }

    // holdout: one sharp mid-sequence frame excluded from training and scored
    // as the honest novel-view metric
    const want = extra.holdout ?? this.opts.holdout ?? 'auto';
    if (want === 'auto') {
      let hi = this.trainer.camMeta.length >> 1;
      for (let k = 0; k < this.trainer.camMeta.length && this.trainer.excluded.has(hi); k++) {
        hi = (hi + 1) % this.trainer.camMeta.length;
      }
      this.holdout = hi;
    } else {
      this.holdout = (want == null || want < 0) ? -1 : want;
    }
    this.trainer.holdout = this.holdout;

    // benchmark protocol: every Nth frame joins the test set — excluded from
    // the loss (poses kept, same as the blur exclusions) and scored together
    // by evalTestPsnr(). The single chart holdout follows a mid-set test
    // frame so live progress tracks the same distribution.
    const split = extra.evalSplit ?? this.opts.evalSplit ?? 0;
    this.testCams = [];
    if (split >= 2) {
      this.trainer.camMeta.forEach((m, i) => {
        if (m.imgIdx % split === 0) { this.trainer.excluded.add(i); this.testCams.push(i); }
      });
      if (this.testCams.length && this.holdout < 0) {
        this.holdout = this.testCams[this.testCams.length >> 1];
        this.trainer.holdout = this.holdout;
      }
      this._log(`evaluation split: ${this.testCams.length} of ${this.trainer.camMeta.length} ` +
        `cameras (every ${split}th) held out of training`);
    }

    this._stage({ stage: 'seed', done: 1, total: 1, detail: { splats: this.model.n } });
    return this.model;
  }

  /**
   * Attach an ALREADY-TRAINED model instead of seeding from the sparse cloud
   * — the loading half of exportPlyBlob / a saved session.
   *
   * gaussians: { data: Float32Array (n*16, the trainer's raw parameter
   * layout), n, sh?: Float32Array (n*shK*3), shK? }.
   *
   * View-only (no frames needed): pass opts.viewOnly and the trainer is set
   * up with zero training cameras — renders, tours and exports work, training
   * does not. For a full resume call useFrames()/load() first and the normal
   * camera wiring happens exactly like seed(); pass opts.iter to continue the
   * schedules where the saved run stopped.
   */
  async seedFrom(gaussians, opts = {}) {
    if (!this.recon && !opts.viewOnly) throw new Error('useReconstruction() first');
    this._stage({ stage: 'seed', done: 0, total: 1 });
    const radius = opts.sceneRadius ?? this.recon?.sceneRadius ?? 10;
    this.model = { data: gaussians.data, n: gaussians.n, radius, dc: gaussians.dc };

    if (!this.gpu) this.gpu = await createGpu({ device: this.opts.device });
    this.gpu.onLost = (info) => this._deviceLost(info);
    const trainerOpts = {
      maxIters: this.opts.maxIters ?? 60000,
      ...this.opts.trainer, ...opts.trainer,
      gpu: this.gpu,
    };
    if (gaussians.shK != null) trainerOpts.shDeg = { 0: 0, 3: 1, 8: 2, 15: 3 }[gaussians.shK] ?? trainerOpts.shDeg;
    this.trainer = await GSTrainer.create(trainerOpts);

    let cams = [];
    if (!opts.viewOnly) {
      cams = this.recon.cams.map((c) => {
        const im = this.frames[c.imgIdx];
        const s = im.tw / im.fw;
        return { ...c, f: c.f * s, ...(c.fy != null ? { fy: c.fy * s } : {}), cx: im.tw / 2, cy: im.th / 2, w: im.tw, h: im.th };
      });
    }
    const maxW = Math.max(this.opts.maxViewW ?? 2560, ...cams.map((c) => c.w));
    const maxH = Math.max(this.opts.maxViewH ?? 1440, ...cams.map((c) => c.h));
    this.trainer.setup(this.model, cams, this.frames || [], maxW, maxH, radius);
    // setup zero-fills SH (view dependence is normally learned) — a restored
    // model brings its own
    if (gaussians.sh && this.trainer.bufSH) {
      this.trainer.device.queue.writeBuffer(this.trainer.bufSH, 0,
        gaussians.sh.buffer, gaussians.sh.byteOffset, gaussians.n * this.trainer.shK * 3 * 4);
    }
    if (opts.iter) { this.trainer.iter = opts.iter; this.trainer.adamT0 = opts.iter; }
    this.trainer.excluded = new Set();
    this.holdout = -1;
    this.trainer.holdout = -1;
    this.testCams = [];
    this._log(`restored ${gaussians.n} Gaussians` +
      (opts.viewOnly ? ' (view only)' : ` at iteration ${opts.iter || 0}`));
    this._stage({ stage: 'seed', done: 1, total: 1, detail: { splats: gaussians.n } });
    return this.model;
  }

  // ---- the training loop (policy that used to live in the demo page) ----

  start() {
    if (!this.trainer) throw new Error('seed() first');
    if (this.training) return;
    this.training = true;
    this._stage({ stage: 'train', done: this.trainer.iter, total: this._maxIters() });
    this._ensureScheduler();
    this._scheduleFrame();
  }

  pause() { this.training = false; }

  /** Raise the training horizon by `moreIters` and resume. The trainer's
   *  schedules (pos-lr decay, growth stop) are horizon-relative and stretch
   *  with it — this is a real continued run, not idling at floor lr. */
  continueFor(moreIters) {
    if (!this.trainer) throw new Error('seed() first');
    this.opts.maxIters = (this.opts.maxIters ?? 60000) + moreIters;
    this.trainer.opts.maxIters = this.opts.maxIters;
    this.trainer.horizon = this.opts.maxIters;
    this.start();
    return this.opts.maxIters;
  }

  /** End the run early with the model as it stands: final metrics, then the
   *  same train-complete event an auto-stop emits. */
  async finish() {
    if (!this.trainer) return;
    this.training = false;
    this._log(`training finished early at ${this.trainer.iter} iterations`);
    await this._emitMetrics(true);
    this._em.emit('event', { kind: 'train-complete', iter: this.trainer.iter, splats: this.trainer.n });
  }

  _maxIters() { return this.opts.maxIters ?? 60000; }

  /** The GPU vanished under us (iOS reclaims WebGPU devices from backgrounded
   *  tabs; drivers reset). Training stops — the splats lived on the dead
   *  device — but frames and reconstruction are CPU-side, so recover() can
   *  rebuild and train again without redoing the solve. */
  _deviceLost(info) {
    if (this._lost) return;
    this._lost = true;
    this.training = false;
    this._fences = [];
    this._log(`GPU device lost (${(info && info.reason) || 'unknown'}) — ` +
      `${(info && info.message) || 'reclaimed by the system'}`);
    this._em.emit('event', { kind: 'device-lost', iter: this.trainer ? this.trainer.iter : 0 });
  }

  get deviceLost() { return !!this._lost; }

  /** Rebuild after device loss: a fresh device and trainer from the CPU-side
   *  reconstruction. Training restarts at iteration 0. */
  async recover() {
    if (!this.recon) throw new Error('nothing to recover — no reconstruction');
    this.training = false;
    this._lost = false;
    this._fences = [];
    this._ips = null;
    this._thrT = null;
    this._statsGap = 2000;
    this._lastStats = performance.now();
    this._metricsLock = null;    // readbacks on the dead device never resolve
    this._framePending = false;
    this.lossHistory = [];
    this._lastHold = null;
    this._lastHoldEval = 0;
    this._itersAtStats = 0;
    this.trainer = null;
    if (this.gpu && this.gpu.owned) { try { this.gpu.dispose(); } catch { /* already gone */ } }
    this.gpu = null;
    return this.seed();
  }

  _ensureScheduler() {
    if (this._sched) return;
    // Hidden tabs AND occluded windows get their rAF throttled; worker
    // messages are not. The worker tick drives the loop whenever a scheduled
    // frame is >150ms late.
    let tickWorker = null;
    try {
      const src = 'setInterval(() => postMessage(0), 33);';
      tickWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    } catch { /* no Worker: rAF only */ }
    this._framePending = false;
    this._frameScheduledAt = 0;
    const runFrame = () => {
      if (!this._framePending) return;
      this._framePending = false;
      // a readback rejecting mid-flight (device loss) must not become an
      // unhandled rejection — the loop stops, the device-lost event explains
      this._frameLoop().catch((e) => this._log(`frame loop: ${(e && e.message) || e}`));
    };
    if (tickWorker) {
      tickWorker.onmessage = () => {
        if (this._framePending && this.training &&
            performance.now() - this._frameScheduledAt > 150) runFrame();
      };
    }
    this._sched = {
      runFrame, tickWorker,
      raf: typeof requestAnimationFrame === 'function'
        ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16),
    };
    this._frameCount = 0;
    this._lastStats = performance.now();
    this._itersAtStats = 0;
    this._lastHoldEval = 0;
  }

  _scheduleFrame() {
    this._framePending = true;
    this._frameScheduledAt = performance.now();
    this._sched.raf(this._sched.runFrame);
  }

  async _frameLoop() {
    const trainer = this.trainer;
    if (!trainer || !trainer.camMeta || this._lost) return;
    this._frameCount++;

    if (this.training && trainer.iter >= this._maxIters()) {
      this.training = false;
      this._log(`training complete at ${trainer.iter} iterations`);
      await this._emitMetrics(true);
      // emitted AFTER the final readback: listeners typically call metrics()
      // right away, which must not interleave with ours on the staging buffer
      this._em.emit('event', { kind: 'train-complete', iter: trainer.iter, splats: trainer.n });
    }

    if (this.training) {
      // Batch enough iterations per frame to keep the GPU busy. The batch
      // adapts to the device: ~120ms of GPU work per frame keeps a desktop
      // GPU saturated with few submits AND keeps metrics/UI alive on a phone
      // where the same 15 iterations could take seconds.
      const batch = this.opts.itersPerFrame ??
        Math.max(4, Math.min(64, Math.round(this._batch ?? 15)));
      const t0 = performance.now();
      // true throughput, stall time included: Safari's stale fences hide the
      // GPU's real pace from per-frame dt, and a slow GPU otherwise ends up
      // with many seconds of work queued (chunky metrics, laggy pause)
      if (this._thrT == null) {
        this._thrT = t0; this._thrIter = trainer.iter;
      } else if (t0 - this._thrT > 1000) {
        const ips = (trainer.iter - this._thrIter) / (t0 - this._thrT) * 1000;
        this._ips = this._ips == null ? ips : this._ips * 0.5 + ips * 0.5;
        this._thrT = t0; this._thrIter = trainer.iter;
      }
      for (let k = 0; k < batch; k++) trainer.stepOnce();

      const tEnc = performance.now() - t0;

      // periodic refinement: relocate dead splats + grow capacity (MCMC-lite)
      if (trainer.iter > 1500 &&
          trainer.iter - (trainer.lastRefine || 0) >= (this.opts.refineEvery ?? 2500)) {
        trainer.lastRefine = trainer.iter;
        const r0 = performance.now();
        // awaited: refine reads six buffers and writes them all back — steps
        // submitted meanwhile would be silently rewound by that write-back,
        // and the six snapshots would come from six different iterations
        const r = await trainer.refine();
        if (this.perf) {
          this.perf.marks.push({ t: Math.round(r0), kind: 'refine', iter: trainer.iter,
            ms: Math.round(performance.now() - r0), moved: r.moved, grown: r.grown });
        }
        if (r.moved || r.grown) {
          this._log(`refine @${trainer.iter}: relocated ${r.moved}, grew +${r.grown} -> ${r.n} splats`
            + (r.dead != null ? ` (dead ${r.dead}, last round ${r.survived}/${r.lastReloc} survived)` : ''));
          this._em.emit('event', { kind: 'refine', iter: trainer.iter, ...r });
        }
      }

      const now = performance.now();
      let tMet = 0;
      if (now - this._lastStats > (this._statsGap ?? 2000)) {
        const m0 = performance.now();
        await this._emitMetrics();
        tMet = performance.now() - m0;
      }

      const v0 = performance.now();
      this.view._tick(this._frameCount, this.training);
      const tView = performance.now() - v0;

      // Deep pipelining: keep a RING of fences in flight, not one. Safari
      // resolves onSubmittedWorkDone hundreds of ms late even when the GPU is
      // idle; gating each batch on a single fence made that latency the loop
      // period, and the batch adapter — reading the latency as GPU time —
      // shrank the batch into its floor (an iPhone sat at ~15 it/s on a scene
      // it can train at hundreds). With 4 fences outstanding the late fences
      // overlap; the frame period becomes ~latency/4 and the same adapter now
      // GROWS the batch until real GPU work dominates. Prompt-fence devices
      // (desktop) behave as before.
      this._fences.push(trainer.device.queue.onSubmittedWorkDone());
      const s0 = performance.now();
      // fence ring depth trades UI latency for fence-latency overlap
      // (phones run 2: the compositor shares the GPU with training, and
      // 4 x 0.4s of queued dispatches is the "whole system stalls" feel)
      if (this._fences.length > (this.opts.fenceRing ?? 4)) await this._fences.shift();
      const tStall = performance.now() - s0;

      // adapt the batch to the measured cadence (steady-state ~= GPU time of
      // one batch); damped so it settles instead of oscillating
      const dt = Math.max(5, performance.now() - t0);
      const ideal = batch * (120 / dt);
      this._batch = Math.max(4, Math.min(64, (this._batch ?? 15) * 0.7 + ideal * 0.3));
      // throughput cap: ~0.4s of measured GPU work per batch. The dt adapter
      // reads 5ms frames when fences resolve stale and pushes the batch to
      // the clamp — fine on a desktop, ten queued seconds on a phone.
      if (this._ips != null) {
        // gpuChunkMs bounds how much GPU work one batch queues — phones run
        // ~120ms so the compositor (which shares the GPU) gets a slot every
        // frame or two instead of stalling behind 0.4s of dispatches
        const chunk = (this.opts.gpuChunkMs ?? 400) / 1000;
        this._batch = Math.min(this._batch, Math.max(8, Math.round(this._ips * chunk)));
      }
      if (this.perf) {
        this.perf.frames.push([Math.round(now), trainer.iter, batch, trainer.n,
          +tEnc.toFixed(1), +tView.toFixed(1), +tStall.toFixed(1), +tMet.toFixed(1), +dt.toFixed(1)]);
      }
    } else {
      this.view._tick(this._frameCount, this.training);
      await trainer.device.queue.onSubmittedWorkDone();
      this._fences.length = 0;
    }
    if (this.training || this.view._dirty) this._scheduleFrame();
  }

  /** serialize every metric readback: they share the trainer's staging
   *  buffers, and two in flight = "outstanding map pending". On a lost
   *  device readbacks would hang forever — fail fast instead. */
  _locked(fn) {
    const call = () => {
      if (this._lost) throw new Error('GPU device lost');
      return fn();
    };
    const run = (this._metricsLock || Promise.resolve()).then(call, call);
    this._metricsLock = run.catch(() => {});
    return run;
  }

  _emitMetrics(final = false) {
    return this._locked(() => this._emitMetricsInner(final));
  }

  async _emitMetricsInner(final = false) {
    const trainer = this.trainer;
    const now = performance.now();
    const itersPerSec = (trainer.iter - this._itersAtStats) / Math.max(1, now - this._lastStats) * 1000;
    const m = { iter: trainer.iter, splats: trainer.n, itersPerSec: Math.round(itersPerSec) };
    this._lastIps = m.itersPerSec;
    const tRead = performance.now();
    const mse = await trainer.readLoss();
    if (mse != null && mse > 0) {
      m.psnrTrain = -10 * Math.log10(mse);
      this.lossHistory.push([trainer.iter, m.psnrTrain]);
    }
    const holdEvery = this.opts.evalHoldEvery ?? 4000;
    if (this.holdout >= 0 &&
        (final || trainer.iter - this._lastHoldEval >= holdEvery)) {
      this._lastHoldEval = trainer.iter;
      m.psnrHold = await trainer.evalCamPsnr(this.holdout);
      this._lastHold = m.psnrHold;
    } else if (this._lastHold != null) {
      m.psnrHold = this._lastHold;
    }
    // The readbacks above drain every queued batch first — seconds on a slow
    // GPU. Pace the next readout from COMPLETION and by what this one cost,
    // or a fixed 2s cadence turns into back-to-back queue drains.
    const end = performance.now();
    this._lastStats = end;
    this._itersAtStats = trainer.iter;
    this._statsGap = Math.min(8000, Math.max(2000, (end - tRead) * 2.5));
    this._em.emit('metrics', m);
    return m;
  }

  /** One-shot quality readout (used by tests and the done screen). */
  metrics({ refined = false } = {}) {
    return this._locked(async () => {
      const trainer = this.trainer;
      const out = { iter: trainer.iter, splats: trainer.n };
      if (this.holdout >= 0) {
        out.psnrHold = await trainer.evalCamPsnr(this.holdout);
        if (refined) out.psnrHoldRefined = await trainer.evalCamPsnrRefined(this.holdout);
      }
      return out;
    });
  }

  /** PSNR of one training camera against its own photograph (serialized with
   *  the other metric readbacks; safe to call while training). */
  evalFramePsnr(ci) {
    return this._locked(() => this.trainer.evalCamPsnr(ci));
  }

  /** Mean PSNR over the evalSplit test cameras — the number quality papers
   *  report. Resolves null when no eval split was requested. */
  evalTestPsnr() {
    if (!this.testCams || !this.testCams.length) return Promise.resolve(null);
    return this._locked(async () => {
      const frames = [];
      let sum = 0;
      for (const c of this.testCams) {
        const psnr = await this.trainer.evalCamPsnr(c);
        frames.push({ cam: c, imgIdx: this.trainer.camMeta[c].imgIdx, psnr });
        sum += psnr;
      }
      return { psnr: sum / frames.length, frames };
    });
  }

  /** Index of the camera the trainer most recently stepped on (UI pulse). */
  get activeCam() { return this.trainer ? this.trainer.lastCam : -1; }

  /** Standard 3DGS .ply with Mip opacity compensation baked (what external
   *  sorted viewers expect). */
  exportPlyBlob() {
    // shares the trainer's staging buffers with the metric readbacks
    return this._locked(async () => {
      const { data, n, sh, shK } = await this.trainer.readGaussians();
      const meta = this.trainer.camMeta[0];
      // a view-only restore has no training cameras — its model came from an
      // export that already baked the compensation, so pass it through.
      // A trainer without Mip compensation (opts.mipComp false) rendered
      // exactly what external rasterizers render: nothing to bake.
      const baked = (meta && this.trainer.mipComp !== false)
        ? bakeOpacityCompensation(data, n, meta.f,
            Float32Array.from(this.trainer.camMeta.flatMap(camPosition)))
        : data;
      // dead splats — invisible at the smallest 8-bit alpha — are pure
      // file-size and render tax for every viewer. Long classic-era runs
      // accumulated 50%+ of them (opacity-reg ratchet, lab log 2026-09-01):
      // drop them at the door.
      const A_DEAD = Math.log(1 / 254);   // logit of alpha 1/255
      let live = 0;
      for (let i = 0; i < n; i++) if (baked[i * 16 + 13] > A_DEAD) live++;
      let oData = baked, oSh = sh, oN = n;
      if (live < n) {
        oData = new Float32Array(live * 16);
        const shPer = sh ? sh.length / n : 0;
        oSh = sh ? new Float32Array(live * shPer) : sh;
        let w = 0;
        for (let i = 0; i < n; i++) {
          if (baked[i * 16 + 13] <= A_DEAD) continue;
          oData.set(baked.subarray(i * 16, i * 16 + 16), w * 16);
          if (sh) oSh.set(sh.subarray(i * shPer, (i + 1) * shPer), w * shPer);
          w++;
        }
        oN = live;
      }
      return gaussiansToPly(oData, oN, oSh, shK, this.trainer.dcMode);
    });
  }

  /** The trainer's RAW parameter state ({ data, n, sh, shK }) — the exact
   *  floats, no opacity baking or color activation: what seedFrom() takes
   *  back for a bit-identical resume. */
  exportRawState() {
    return this._locked(() => this.trainer.readGaussians());
  }

  dispose() {
    this.training = false;
    if (this._sched && this._sched.tickWorker) this._sched.tickWorker.terminate();
    if (this.gpu && this.gpu.owned) this.gpu.dispose();
    this.trainer = null;
  }
}

/** The session's render target: one canvas, one camera. */
class SessionView {
  constructor(session) {
    this.s = session;
    this.canvas = null;
    this.ctx = null;
    this.camera = null;   // { R, t, f, cx, cy, w, h } at canvas resolution
    this._dirty = false;
    this._offset = 0;     // training-target offset when looking through a frame
  }

  attach(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.ctx.configure({
      device: this.s.trainer.device,
      format: this.s.trainer.canvasFormat,
      alphaMode: 'opaque',
    });
    this._dirty = true;
    if (!this.s.training) this.s._ensureScheduler(), this.s._scheduleFrame();
  }

  /** Point the camera at training frame i (exact pose + intrinsics). Returns
   *  the camera meta so the UI can overlay the photograph. */
  lookThrough(i) {
    const meta = this.s.trainer.camMeta[i];
    this.setCamera({ ...meta });
    this._offset = meta.offset;
    return meta;
  }

  /** Free camera: { R, t, f, cx, cy, w, h }. */
  setCamera(cam) {
    this.camera = cam;
    this._offset = 0;
    this._dirty = true;
    if (!this.s.training && this.s._sched) this.s._scheduleFrame();
  }

  renderNow() {
    if (!this.ctx || !this.camera) return;
    this.s.trainer.renderView(this.camera, this.ctx, 0, this._offset);
    this._dirty = false;
    // any render satisfies the auto-refresh — a host that renders on its own
    // cadence keeps pushing this back and the tick below never double-fires
    this._lastAuto = performance.now();
  }

  _tick(frameCount, training) {
    if (!this.ctx || !this.camera) return;
    if (this._dirty) { this.renderNow(); return; }
    // during training, refresh the (unchanged-camera) view sparingly — every
    // render is a full raster pass stolen from the optimiser (~2/s at most,
    // fewer on slow devices: ~25 iterations between refreshes)
    const ips = this.s._itersAtStats && this.s._lastStats
      ? Math.max(1, this.s._lastIps || 100) : 100;
    const interval = Math.max(500, 25000 / ips);
    if (training && performance.now() - (this._lastAuto || 0) > interval) {
      this.renderNow();
    }
  }
}

/** @param {SessionOptions} [opts] */
export function createSession(opts = {}) { return new Session(opts); }
