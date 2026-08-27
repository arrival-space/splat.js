// splat.js — Gaussian-splat training that runs entirely in the browser.
// Photographs in, camera poses + a trained 3D Gaussian splat out, no server.
//
// Layer 2 — a UI talks to one object:
//
//   import { createSession } from 'splat.js';
//   const s = createSession();
//   s.on('stage', e => ...); s.on('metrics', e => ...);
//   await s.load(files); await s.solve(); await s.seed();
//   s.view.attach(canvas); s.start();
//   const ply = await s.exportPlyBlob();
//
// Layer 1 — the pieces, for building your own flow:
//
//   const gpu     = await createGpu();          // or { device } you own
//   const frames  = await decodeFrames(files);
//   const recon   = await solve(frames, { onEvent, signal });
//   const model   = seed(recon.points);
//   const trainer = await createTrainer({ gpu });
//   trainer.setup(model, cams, frames, ...);
//   trainer.stepOnce();
//   const bytes   = toPly(await trainer.readGaussians());

export { createSession, Session, undistortFrames, camPosition } from './session.js';
export { createGpu } from './gpu/context.js';
export { decodeFrames, processSource, adaptiveTrainCap, FEAT_MAX_DIM, TRAIN_MAX_DIM } from './io/frames.js';
export {
  extractSharpFrames, selectSharpFrameSamples, planVideoFrames,
  videoFrameDimensions, videoPipelineResolution, isVideoFile,
} from './io/video.js';
export { gaussiansToPly, bakeOpacityCompensation } from './io/ply.js';
export { runSfM } from './sfm/sfm.js';
export { initGaussians } from './gs/init.js';
export { GSTrainer } from './gs/trainer.js';

import { runSfM } from './sfm/sfm.js';
import { initGaussians } from './gs/init.js';
import { GSTrainer } from './gs/trainer.js';

/** Layer-1 alias: SfM over decoded frames.
 *  @param {import('./io/frames.js').Frame[]} frames
 *  @param {object} [opts] SfmOptions (+ log, onEvent, signal, gpu) */
export function solve(frames, opts = {}) {
  return runSfM(
    frames,
    opts.log || (() => {}),
    (imgIdx, x, y) => frames[imgIdx].sampleColor(x, y),
    opts);
}

/** Layer-1 alias: seed Gaussians from a sparse cloud. */
export function seed(points, opts = {}) {
  const target = opts.initTarget || 60000;
  const clones = Math.min(24, Math.max(2, Math.round(target / points.length) - 1));
  return initGaussians(points, clones, opts.maxGaussians);
}

/** Layer-1 alias: a trainer bound to a (shared) GPU context. */
export function createTrainer(opts = {}) {
  return GSTrainer.create(opts);
}
