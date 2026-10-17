// groundTextures.js — procedural textures for the airfield, as RGBA pixel arrays
// (engine-free: the plugin uploads them, the tests look at them).
//
// Each surface is two layers, so nothing reads as a repeating tile:
//   detail  a small tileable texture (asphalt grain, grass blades) repeating every
//           couple of metres, grey-centred for PlayCanvas' overlay detail mode
//   macro   one big unique image over the whole field in runway coordinates:
//           paving lanes, tyre marks in the touchdown zones, repair patches,
//           sealed cracks, oil stains; mowing stripes, dry and damp patches
//
// Runway coordinates: u = across (m, east of the centreline positive for 36),
// v = along (m, north positive). Row 0 of an image is v = max (top of the canvas).

// ── noise ──────────────────────────────────────────────────────────────────
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);

/** Value noise in [0, 1]; periodic with period p (lattice cells) when p > 0. */
function vnoise(x, y, seed, p = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = smooth(x - xi), fy = smooth(y - yi);
  const w = (i) => (p ? ((i % p) + p) % p : i);
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal noise in ~[0, 1]: octaves doubling in frequency (periodic if p > 0, p doubling too). */
export function fbm(x, y, seed, octaves = 4, p = 0) {
  let s = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    s += amp * vnoise(x * f, y * f, seed + o * 17, p ? p * f : 0);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function image(w, h, shade) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [r, g, b] = shade(i, j);
      const k = (j * w + i) * 4;
      px[k] = clamp255(r); px[k + 1] = clamp255(g); px[k + 2] = clamp255(b); px[k + 3] = 255;
    }
  }
  return { width: w, height: h, data: px };
}

// ── detail layers (tileable, grey-centred: 128 leaves the macro colour as it is) ──
export function asphaltDetail(S = 256, seed = 7) {
  return image(S, S, (i, j) => {
    const x = (i / S) * 32, y = (j / S) * 32;
    // aggregate: stones a few cm across, some lighter, some darker, in a fine binder
    const stone = vnoise(x * 2, y * 2, seed, 64);
    const grit = vnoise(x * 8, y * 8, seed + 3, 256);
    let v = 128 + (stone - 0.5) * 46 + (grit - 0.5) * 30;
    if (stone > 0.82) v += 26;                 // pale chippings
    if (stone < 0.12) v -= 22;                 // bitumen-rich spots
    return [v, v, v * 1.01];
  });
}

export function grassDetail(S = 256, seed = 11) {
  return image(S, S, (i, j) => {
    const x = (i / S) * 16, y = (j / S) * 16;
    // blades: streaky noise, stretched a little along v, plus clumps and bare specks
    const blades = vnoise(x * 6, y * 2.5, seed, 96) * 0.55 + vnoise(x * 14, y * 6, seed + 1, 224) * 0.45;
    const clump = fbm(x, y, seed + 2, 3, 16);
    let v = 128 + (blades - 0.5) * 70 + (clump - 0.5) * 40;
    const bare = vnoise(x * 3, y * 3, seed + 5, 48) > 0.9;
    return bare ? [v + 18, v + 8, v - 14] : [v - 4, v + 6, v - 8];
  });
}

// ── macro layers ───────────────────────────────────────────────────────────
/**
 * The runway, taxiway and apron, one image in runway coordinates.
 * @param {object} o
 * @param {number[]} o.u  [u0, u1] across range the image covers (m)
 * @param {number[]} o.v  [v0, v1] along range (m)
 * @param {number} o.length  runway length (m)
 * @param {number} o.width   runway width (m)
 * @param {{ u: number[], v: number[], kind: string }[]} o.areas  paved rectangles (runway / taxiway / apron)
 */
export function runwayMacro({ u, v, length, width, areas }, w = 512, h = 2048, seed = 3) {
  const du = (u[1] - u[0]) / w, dv = (v[1] - v[0]) / h;
  // repair patches: rectangles of newer (darker) or older (paler) asphalt
  const patches = [];
  for (let k = 0; k < 70; k++) {
    const a = areas[Math.floor(hash(k, 1, seed) * areas.length)];
    const cu = a.u[0] + hash(k, 2, seed) * (a.u[1] - a.u[0]), cv = a.v[0] + hash(k, 3, seed) * (a.v[1] - a.v[0]);
    const su = 1.5 + hash(k, 4, seed) * 9, sv = 2 + hash(k, 5, seed) * 18;
    patches.push({ u0: cu - su / 2, u1: cu + su / 2, v0: cv - sv / 2, v1: cv + sv / 2, tone: hash(k, 6, seed) > 0.4 ? -16 : 12 });
  }
  // oil stains on the apron and at the taxiway hold points
  const stains = [];
  for (const a of areas.filter((x) => x.kind !== 'runway')) {
    const n = a.kind === 'apron' ? 26 : 6;
    for (let k = 0; k < n; k++) {
      stains.push({
        u: a.u[0] + hash(k, 7, seed + stains.length) * (a.u[1] - a.u[0]),
        v: a.v[0] + hash(k, 8, seed + stains.length) * (a.v[1] - a.v[0]),
        r: 0.6 + hash(k, 9, seed + stains.length) * 2.2,
      });
    }
  }
  const L2 = length / 2, W2 = width / 2;
  const img = image(w, h, (i, j) => {
    const uu = u[0] + (i + 0.5) * du, vv = v[1] - (j + 0.5) * dv;
    const area = areas.find((a) => uu >= a.u[0] && uu <= a.u[1] && vv >= a.v[0] && vv <= a.v[1]);
    // base: weathered grey, warmer and paler where older
    const big = fbm(uu / 60, vv / 60, seed, 4);
    const mid = fbm(uu / 9, vv / 9, seed + 1, 3);
    let g = 104 + (big - 0.5) * 34 + (mid - 0.5) * 16;
    let warm = 2 + (big - 0.5) * 6;
    if (area?.kind === 'taxiway') { g += 10; warm += 2; }
    if (area?.kind === 'apron') { g += 6; warm += 1; }
    if (area?.kind === 'runway' || !area) {
      // paving lanes: 25 ft strips laid side by side, each its own shade, joints between
      const lane = Math.floor((uu + W2) / 7.62);
      g += (hash(lane, 0, seed) - 0.5) * 9;
      const inLane = (((uu + W2) % 7.62) + 7.62) % 7.62;
      if (inLane < 0.18 || inLane > 7.62 - 0.18) g -= 10;
      // rubber: the touchdown zones of both ends, densest a few hundred metres in, along the wheel tracks
      for (const end of [-1, 1]) {
        const s = end * vv;                          // distance toward this end
        const fromThr = L2 - s;
        if (fromThr > 40 && fromThr < 650) {
          const zone = Math.exp(-(((fromThr - 260) / 170) ** 2));
          const across = Math.exp(-((uu / 5.5) ** 2)) + 0.55 * Math.exp(-(((Math.abs(uu) - 2.4) / 1.1) ** 2));
          const streak = 0.55 + 0.45 * vnoise(uu * 1.6, vv / 7, seed + 9);
          g -= 34 * zone * Math.min(1, across) * streak;     // a general-aviation field: lighter than an airliner runway
          warm -= 3 * zone * across;
        }
      }
      // a polished, slightly darker track down the middle from rolling out
      g -= 7 * Math.exp(-((uu / 3) ** 2));
    }
    // sealed cracks: tar snakes, meandering, mostly across the paving
    const crackField = vnoise(uu / 7 + fbm(uu / 3, vv / 3, seed + 4, 2) * 1.8, vv / 2.2, seed + 5);
    if (Math.abs(crackField - 0.5) < 0.012 && fbm(uu / 25, vv / 25, seed + 6, 2) > 0.52) g = 52;
    // edges of the runway: paler, less traffic
    if (Math.abs(uu) > W2 - 4 && Math.abs(uu) < W2 + 1 && Math.abs(vv) < L2 + 30) g += 6;
    return [g + warm, g + warm * 0.4, g - warm * 0.6];
  });
  // stamp the patches and stains over their own pixels
  const stamp = (u0, u1, v0, v1, f) => {
    const i0 = Math.max(0, Math.floor((u0 - u[0]) / du)), i1 = Math.min(w - 1, Math.ceil((u1 - u[0]) / du));
    const j0 = Math.max(0, Math.floor((v[1] - v1) / dv)), j1 = Math.min(h - 1, Math.ceil((v[1] - v0) / dv));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = f(u[0] + (i + 0.5) * du, v[1] - (j + 0.5) * dv);
      if (!d) continue;
      const k = (j * w + i) * 4;
      img.data[k] += d[0]; img.data[k + 1] += d[1]; img.data[k + 2] += d[2];
    }
  };
  for (const p of patches) {
    stamp(p.u0, p.u1, p.v0, p.v1, (uu, vv) => (uu > p.u0 && uu < p.u1 && vv > p.v0 && vv < p.v1 ? [p.tone * 0.92, p.tone, p.tone * 1.06] : null));
  }
  // touchdown skids: where the wheels spin up on contact, short black streaks in pairs (one per main
  // wheel), a few metres to either side of the centreline, starting sharp and fading out
  const rw = areas.find((a) => a.kind === 'runway');
  if (rw) {
    for (const end of [-1, 1]) {
      for (let k = 0; k < 46; k++) {
        const r = (q) => hash(k * 7 + q, end + 5, seed + 21);
        const fromThr = 150 + 380 * r(0) ** 1.4;              // past the aiming point, most in the first few hundred metres
        const v0 = end * (L2 - fromThr);                      // touch-down point
        const track = 1.6 + r(1) * 4.4;                       // main-gear track: light aircraft to bizjets
        const off = (r(2) - 0.5) * 6;                         // landed off the centreline
        const len = 18 + r(3) * 55;                           // long, fading streaks
        const ang = (r(4) - 0.5) * 0.02;                      // drifting a touch on contact
        const wid = 0.14 + r(5) * 0.16;
        const dark = 22 + r(6) * 30;
        for (const side of [-1, 1]) {
          const u0 = off + side * track / 2;
          // along the landing direction: toward the far end (v decreasing for the north end)
          const dirV = -end;
          const vEnd = v0 + dirV * len, uEnd = u0 + ang * len;
          stamp(Math.min(u0, uEnd) - wid, Math.max(u0, uEnd) + wid, Math.min(v0, vEnd), Math.max(v0, vEnd), (uu, vv) => {
            const t = (vv - v0) * dirV / len;                 // 0 at touch-down … 1 at the end
            if (t < 0 || t > 1) return null;
            const dU = Math.abs(uu - (u0 + ang * len * t));
            if (dU > wid) return null;
            const d = -dark * (1 - t) ** 1.5 * (1 - (dU / wid) ** 2) * (0.7 + 0.3 * vnoise(vv * 2, uu * 9, seed + 22));
            return [d, d, d * 0.95];
          });
        }
      }
    }
  }
  for (const st of stains) {
    stamp(st.u - st.r, st.u + st.r, st.v - st.r, st.v + st.r, (uu, vv) => {
      const d2 = ((uu - st.u) ** 2 + (vv - st.v) ** 2) / (st.r * st.r);
      if (d2 >= 1) return null;
      const d = -34 * (1 - d2) * (0.6 + 0.4 * vnoise(uu * 3, vv * 3, seed + 8));
      return [d, d, d * 0.9];
    });
  }
  return img;
}

/**
 * The airfield grass, one image in runway coordinates: mowed in stripes along the runway near it,
 * rougher further out, with dry and damp patches and clover.
 */
export function grassMacro({ u, v, width }, w = 512, h = 1024, seed = 5) {
  const du = (u[1] - u[0]) / w, dv = (v[1] - v[0]) / h;
  const W2 = width / 2;
  return image(w, h, (i, j) => {
    const uu = u[0] + (i + 0.5) * du, vv = v[1] - (j + 0.5) * dv;
    const big = fbm(uu / 90, vv / 90, seed, 4);
    const mid = fbm(uu / 14, vv / 14, seed + 1, 3);
    let r = 88, g = 122, b = 58;                                  // well-kept turf
    const t = (big - 0.5) * 2 + (mid - 0.5) * 0.8;
    r += t * 14; g += t * 18; b += t * 8;
    // dry patches: straw-coloured where the soil is thin
    const dry = Math.max(0, fbm(uu / 40 + 3, vv / 40, seed + 2, 4) - 0.6) * 4;
    r += dry * 58; g += dry * 30; b += dry * 6;
    // damp hollows: darker, bluer
    const damp = Math.max(0, 0.38 - fbm(uu / 55, vv / 55 + 9, seed + 3, 3)) * 4;
    r -= damp * 22; g -= damp * 10; b -= damp * 4;
    // clover clumps
    if (vnoise(uu / 2.2, vv / 2.2, seed + 4) > 0.86) { g += 9; r -= 6; }
    // mowing stripes along the runway, out to the strip's edge; the mower's line wanders a little
    const strip = Math.abs(uu) - W2;
    if (strip > 0 && strip < 75) {
      const wob = (fbm(vv / 30, uu / 30, seed + 6, 2) - 0.5) * 1.6;
      const stripe = Math.floor((strip + wob) / 6) % 2 ? 1 : -1;
      const fade = Math.min(1, (75 - strip) / 10);
      r += stripe * 6 * fade; g += stripe * 9 * fade; b += stripe * 3 * fade;
    } else if (strip >= 75) {
      // rough: longer, more mixed
      const rough = fbm(uu / 6, vv / 6, seed + 7, 3) - 0.5;
      r += 6 + rough * 26; g += rough * 20; b += 2 + rough * 10;
    }
    // worn, dusty edge where the runway lights and mowers turn
    if (strip > 0 && strip < 2.5) { r += 18; g += 6; b += 2; }
    return [r, g, b];
  });
}

/**
 * A tileable normal map for the asphalt's grain, from the same stones as asphaltDetail: the sun picks out
 * the aggregate, and the paint over it keeps a little of the texture.
 */
export function asphaltNormal(S = 256, seed = 7, strength = 2.2) {
  const hgt = (i, j) => {
    const x = (((i % S) + S) % S) / S * 32, y = (((j % S) + S) % S) / S * 32;
    return vnoise(x * 2, y * 2, seed, 64) * 0.7 + vnoise(x * 8, y * 8, seed + 3, 256) * 0.3;
  };
  return image(S, S, (i, j) => {
    const dx = (hgt(i + 1, j) - hgt(i - 1, j)) * strength, dy = (hgt(i, j + 1) - hgt(i, j - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [128 + (-dx / l) * 127, 128 + (dy / l) * 127, 128 + (1 / l) * 127];
  });
}

/** Mean brightness of an image (0–255), for tests. */
export function meanLuma(img, x0 = 0, y0 = 0, x1 = img.width, y1 = img.height) {
  let s = 0, n = 0;
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
    const k = (j * img.width + i) * 4;
    s += 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2];
    n++;
  }
  return s / n;
}

/**
 * Paint wear over the asphalt below, as a multiplier image (white = clean paint): the paint takes the
 * rubber and skid marks of the macro it lies on, and flakes off here and there.
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} under  the asphalt macro
 */
export function paintWear(under, seed = 13) {
  const { width: w, height: h } = under;
  return image(w, h, (i, j) => {
    const k = (j * w + i) * 4;
    const luma = 0.299 * under.data[k] + 0.587 * under.data[k + 1] + 0.114 * under.data[k + 2];
    // clean asphalt here is ~105: anything darker is rubber, stains or sealant and shows on the paint too
    let f = Math.min(1, Math.pow(luma / 105, 1.6));
    f = 0.78 + 0.22 * f;                       // paint holds its white better than the asphalt round it
    const scuff = fbm(i / 9, j / 9, seed, 3);
    f *= 0.9 + 0.1 * scuff;
    if (vnoise(i / 1.7, j / 1.7, seed + 1) > 0.86) f *= 0.7;   // flaked: asphalt shows through
    const v = 255 * f;
    return [v, v, v];
  });
}
