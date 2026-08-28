// io/video.js — turn a video file into training photographs, in the browser.
//
// Users film places; they rarely have photo sets. Sample ~10/s, divide the
// complete timeline into uniform windows, pick the sharpest sample in every
// window, then re-capture those winners as JPEG blobs. Temporal coverage comes
// first, so a long sharp pause cannot crowd moving parts of the camera path out.
//
// Two passes over a muted <video>:
//   scan     playback at up to 3x with requestVideoFrameCallback, scoring a
//            downscaled grayscale Laplacian variance per ~0.1s of video time
//            (seek-stepping fallback when rVFC is unavailable)
//   capture  seek to the selected timestamps in order (fast, forward-only
//            decode) and encode full-resolution JPEGs
//
// No dependencies, no DOM attachment; works wherever <video> can decode the
// file (H.264/HEVC .mp4/.mov on Safari and Chrome, plus webm).

export const VIDEO_MAX_FRAMES = 500;

/**
 * @typedef {object} VideoExtractOptions
 * @property {number} [samplesPerSec=10]   sharpness sampling rate (video time)
 * @property {number} [targetFrames]       frames to keep; default scales with
 *   duration: clamp(round(4/s), 24, 140)
 * @property {number} [maxFrameDim]        longest output side in pixels;
 *   0/undefined keeps the original size, and smaller sources never upscale
 * @property {number} [jpegQuality=0.93]
 * @property {(e: {stage: 'scan'|'capture', done: number, total: number}) => void} [onProgress]
 * @property {(msg: string) => void} [log]
 */

const until = (el, ev, err = 'error') => new Promise((res, rej) => {
  const ok = () => { cleanup(); res(); };
  const bad = (e) => { cleanup(); rej(new Error(`video ${err}: ${(e && e.message) || 'decode failed'}`)); };
  const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
  el.addEventListener(ev, ok, { once: true });
  el.addEventListener('error', bad, { once: true });
});

const waitForPresentedFrame = (video, timeoutMs = 2000) => new Promise((resolve) => {
  let callbackId = null;
  let timer = null;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolve();
  };
  callbackId = video.requestVideoFrameCallback(finish);
  if (!settled) {
    timer = setTimeout(() => {
      if (typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(callbackId);
      }
      finish();
    }, timeoutMs);
  }
});

/** Seek and wait until the decoder has presented the requested frame.
 *
 * `seeked` alone is not sufficient in every browser: after playback reaches
 * the end, Chromium can dispatch it while drawImage() still sees the final
 * frame. Registering rVFC before the seek ties capture to the newly presented
 * frame and prevents that stale final frame becoming output frame 1. */
export async function seekToDecodedVideoFrame(video, time) {
  const seeked = until(video, 'seeked');
  // The stale-frame hazard exists when rewinding from EOF. Do not wait for
  // rVFC on every paused seek: Chromium may stop delivering those callbacks
  // after several seeks, which would leave extraction stuck mid-capture.
  const presented = video.ended && typeof video.requestVideoFrameCallback === 'function'
    ? waitForPresentedFrame(video)
    : null;
  video.currentTime = time;
  await seeked;
  if (presented) await presented;
}

/** Laplacian variance of a grayscale buffer (same sharpness measure the
 *  frame decoder uses for blur exclusion). */
function lapVar(gray, w, h) {
  let sum = 0, sq = 0;
  const n = (w - 2) * (h - 2);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap; sq += lap * lap;
    }
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}

/** Pick one sharp winner from each consecutive slice of the sampled timeline.
 *  Slices are based on ordered sample count because browsers may report video
 *  timestamps with small codec-dependent gaps. This guarantees full-path
 *  coverage and deterministic output while retaining local blur rejection. */
export function selectSharpFrameSamples(samples, targetFrames) {
  const ordered = samples
    .filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.s))
    .sort((a, b) => a.t - b.t);
  if (!ordered.length) return [];
  const count = Math.max(1, Math.min(ordered.length, Math.round(targetFrames) || 1));
  const picked = [];
  for (let window = 0; window < count; window++) {
    const begin = Math.floor(window * ordered.length / count);
    const end = Math.max(begin + 1, Math.floor((window + 1) * ordered.length / count));
    let best = ordered[begin];
    for (let i = begin + 1; i < end; i++) {
      if (ordered[i].s > best.s) best = ordered[i];
    }
    picked.push(best);
  }
  return picked;
}

/** Normalize the user-facing FPS/count choice into an extraction target. */
export function planVideoFrames(duration, opts = {}) {
  const seconds = Math.max(0, Number(duration) || 0);
  const mode = opts.mode === 'count' ? 'count' : 'fps';
  const fps = Math.max(0.5, Math.min(10, Number(opts.fps) || 3));
  const requestedCount = Math.max(12, Math.round(Number(opts.count) || 120));
  const count = Math.min(VIDEO_MAX_FRAMES, requestedCount);
  const uncapped = mode === 'count' ? requestedCount : Math.max(1, Math.ceil(seconds * fps));
  const targetFrames = Math.min(VIDEO_MAX_FRAMES, uncapped);
  return {
    mode, fps, count, targetFrames,
    capped: targetFrames < uncapped,
    valid: seconds > 0 && targetFrames >= 12,
  };
}

/** Output dimensions for extracted JPEGs, preserving aspect and orientation. */
export function videoFrameDimensions(width, height, maxFrameDim = 0) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const cap = Math.max(0, Math.round(Number(maxFrameDim) || 0));
  if (!cap || Math.max(w, h) <= cap) return [w, h];
  const scale = cap / Math.max(w, h);
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

/** Keep the downstream training and camera caps aligned with extracted video
 * frames without allowing very large 4K/original frames to explode memory. */
export function videoPipelineResolution(width, height, maxDim = 1600) {
  const longest = Math.max(2, Math.round(Math.max(Number(width) || 0, Number(height) || 0)));
  return Math.min(Math.max(2, Math.round(Number(maxDim) || 1600)), longest);
}

/**
 * @param {File|Blob} file
 * @param {VideoExtractOptions} [opts]
 * @returns {Promise<{frames: Array<{source: Blob, name: string}>,
 *   duration: number, sampled: number, videoW: number, videoH: number,
 *   frameW: number, frameH: number}>}
 */
export async function extractSharpFrames(file, opts = {}) {
  const log = opts.log || (() => {});
  const onProgress = opts.onProgress || (() => {});
  const sps = opts.samplesPerSec ?? 10;

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await until(video, 'loadedmetadata');
    if (!isFinite(video.duration)) {
      // streamed/recorded webms report Infinity until forced to the end
      video.currentTime = 1e9;
      await until(video, 'seeked');
      video.currentTime = 0;
      await until(video, 'seeked');
    }
    const duration = video.duration;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !isFinite(duration) || duration <= 0) throw new Error('video has no decodable track');
    log(`video: ${vw}x${vh}, ${duration.toFixed(1)}s`);

    // ---- pass 1: sharpness scan on a small grayscale ----
    const sw = 320, sh = Math.max(2, Math.round(sw * vh / vw));
    const scanCv = mkCanvas(sw, sh);
    const scanCtx = scanCv.getContext('2d', { willReadFrequently: true });
    const gray = new Float32Array(sw * sh);
    const scoreNow = (t) => {
      scanCtx.drawImage(video, 0, 0, sw, sh);
      const d = scanCtx.getImageData(0, 0, sw, sh).data;
      for (let i = 0; i < sw * sh; i++) {
        gray[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
      }
      return { t, s: lapVar(gray, sw, sh) };
    };

    const samples = [];
    const totalSamples = Math.max(2, Math.floor(duration * sps));
    if (typeof video.requestVideoFrameCallback === 'function') {
      // real-time-ish scan: play fast, score presented frames ~1/sps apart
      video.playbackRate = Math.min(3, (video.canPlayType ? 3 : 1));
      let lastT = -1;
      let done = false;
      const onFrame = (_now, meta) => {
        if (done) return;
        const t = meta.mediaTime;
        if (t - lastT >= 1 / sps - 1e-3) {
          lastT = t;
          samples.push(scoreNow(t));
          onProgress({ stage: 'scan', done: Math.min(samples.length, totalSamples), total: totalSamples });
        }
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
      await video.play();
      await until(video, 'ended', 'playback error');
      done = true;
      video.pause();
    } else {
      // fallback: seek-step through the video
      for (let k = 0; k < totalSamples; k++) {
        video.currentTime = Math.min(duration - 0.001, k / sps);
        await until(video, 'seeked');
        samples.push(scoreNow(video.currentTime));
        onProgress({ stage: 'scan', done: k + 1, total: totalSamples });
      }
    }
    if (samples.length < 2) throw new Error('could not decode frames from this video');
    log(`scanned ${samples.length} samples`);

    // ---- selection: uniform timeline coverage, sharpest within each window ----
    const target = opts.targetFrames ??
      Math.max(24, Math.min(140, Math.round(duration * 4)));
    const picked = selectSharpFrameSamples(samples, target);
    log(`selected ${picked.length} coverage-aware sharp frames (target ${target})`);

    // ---- pass 2: capture at the requested pipeline-ready resolution ----
    const [frameW, frameH] = videoFrameDimensions(vw, vh, opts.maxFrameDim);
    log(`extracted frame resolution: ${frameW}x${frameH}`);
    const capCv = mkCanvas(frameW, frameH);
    const capCtx = capCv.getContext('2d');
    const frames = [];
    for (let i = 0; i < picked.length; i++) {
      await seekToDecodedVideoFrame(video, picked[i].t);
      capCtx.drawImage(video, 0, 0, frameW, frameH);
      const blob = await toBlob(capCv, opts.jpegQuality ?? 0.93);
      frames.push({ source: blob, name: `frame_${String(i + 1).padStart(5, '0')}.jpg` });
      onProgress({ stage: 'capture', done: i + 1, total: picked.length });
    }
    return { frames, duration, sampled: samples.length, videoW: vw, videoH: vh, frameW, frameH };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

function toBlob(cv, quality) {
  if (cv.convertToBlob) return cv.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((res, rej) => cv.toBlob(
    (b) => (b ? res(b) : rej(new Error('jpeg encode failed'))), 'image/jpeg', quality));
}

/** Quick sniff: is this file a video the pipeline should extract from? */
export function isVideoFile(f) {
  return /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name || '');
}
