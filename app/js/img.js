// img.js — one decode per URL, shared across the page.
//
// Display bitmaps are CAPPED to what the screen can show and the cache is a
// small LRU: the landmarks beat walks every photo, and an unbounded cache of
// NATIVE-resolution ImageBitmaps (12MP = ~48MB each) was the iPhone OOM —
// 50 photos of it is ~2.4GB. Capped to the device pixel width, a photo is
// ~5MB and the whole cache stays under ~100MB everywhere.
// Evicted bitmaps are NOT closed — callers (the stage's hold-last-frame,
// the compare view) may still be drawing them; dropping the reference and
// letting GC reclaim is bounded and safe.

import { probeImageSize } from '../../src/io/pano.js';

const pending = new Map();
const done = new Map(); // LRU by Map insertion order
const failedUntil = new Map();
const FAILED_RETRY_MS = 30000;
const MAXW = Math.min(1600, Math.round((screen.width || 1280) * (devicePixelRatio || 1)));
const CAP = MAXW > 1400 ? 24 : 10;
const key = (url, w) => (w ? `${url}@${w}` : url);

const remember = (k, b) => {
  done.delete(k);
  done.set(k, b);
  while (done.size > CAP) {
    done.delete(done.keys().next().value);
  }
};

export function bmp(url, w) {
  const k = key(url, w);
  if (done.has(k)) return Promise.resolve(done.get(k));
  if (pending.has(k)) return pending.get(k);
  const retryAt = failedUntil.get(k) || 0;
  if (retryAt > Date.now()) return Promise.resolve(null);
  failedUntil.delete(k);
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`image request failed: ${r.status}`);
    return r.blob();
  })
    .then(async (b) => {
      if (w) return createImageBitmap(b, { resizeWidth: w, resizeQuality: 'medium' });
      // display-res decode: cap the LONG side at MAXW without ever
      // materializing the native bitmap (header probe -> resized decode)
      const dims = await probeImageSize(b);
      if (dims && Math.max(dims.w, dims.h) > MAXW) {
        const rw = Math.round(dims.w * (MAXW / Math.max(dims.w, dims.h)));
        return createImageBitmap(b, { resizeWidth: rw, resizeQuality: 'medium' });
      }
      let bm = await createImageBitmap(b);
      if (Math.max(bm.width, bm.height) > MAXW) {
        const rw = Math.round(bm.width * (MAXW / Math.max(bm.width, bm.height)));
        const s = await createImageBitmap(bm, { resizeWidth: rw, resizeQuality: 'medium' });
        bm.close();
        bm = s;
      }
      return bm;
    })
    .then((b) => {
      pending.delete(k);
      failedUntil.delete(k);
      remember(k, b);
      return b;
    })
    .catch(() => {
      pending.delete(k);
      failedUntil.set(k, Date.now() + FAILED_RETRY_MS);
      return null;
    });
  pending.set(k, p);
  return p;
}

/** the decoded bitmap if it is already here, otherwise null and a load starts */
export function readyBmp(url, w) {
  const k = key(url, w);
  if (done.has(k)) {
    const b = done.get(k);
    remember(k, b); // touch: keep what the UI is actually looking at
    return b;
  }
  if ((failedUntil.get(k) || 0) > Date.now()) return null;
  bmp(url, w);
  return null;
}
