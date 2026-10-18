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
export function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);

/** Value noise in [0, 1]; periodic with period p (lattice cells) when p > 0. */
export function vnoise(x, y, seed, p = 0) {
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

export function image(w, h, shade) {
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
 * How runways look (runwayMacro): the asphalt's grey (sRGB) and warmth, the paving lanes' width, the
 * rubber in the touchdown zones (centre and width of the zone from the threshold, how dark, how wide
 * the band and where the main-gear tracks run, how much it runs together), the worn centre all
 * along, the shoulders' tone, and the touchdown skids (how many per end, where, which gear tracks).
 */
export const RUNWAY_STYLES = {
  // Meigs: dark compact asphalt, a general-aviation field's light rubber in broken streaks
  meigs: {
    grey: 80, warm: 1.5, tint: [1, 1, 1], lane: 7.62, laneTone: 4,
    rubber: 24, rubberZone: [260, 170], rubberBand: 1, rubberHalf: 5.5, track: 2.4, trackWidth: 1.1, carpet: 0,
    centreWear: 3, shoulder: 0,
    skids: 46, skidFrom: 150, skidSpread: 380, skidTrack: [1.6, 6], twinWheels: 0,
  },
  // Innsbruck (LOWI), as Google's imagery shows it (2026, around our runway): fresh dark asphalt with
  // the satellite's blue cast (~78 79 96 between the wheels and the edges), its paving lanes ~3.7 m
  // wide in stripes of their own shade; a dark band ±6 m round the centre the whole length (~30 %
  // under the sides: rubber, wear, the main gear's tracks ±3.5 m off the centre), a little more in the
  // touchdown zones; shoulders darker than the runway (~59 58 72)
  lowi: {
    grey: 108, warm: 0, tint: [0.94, 0.95, 1.18], lane: 3.7, laneTone: 12,
    rubber: 8, rubberZone: [300, 170], rubberBand: 0.75, rubberHalf: 6, track: 3.5, trackWidth: 1.4, carpet: 0.55,
    centreWear: 30, wearTracks: true, shoulder: -26,
    skids: 120, skidFrom: 120, skidSpread: 520, skidTrack: [3.5, 8], twinWheels: 0.7,
  },
};

/**
 * The runway, taxiway and apron, one image in runway coordinates.
 * @param {object} o
 * @param {number[]} o.u  [u0, u1] across range the image covers (m)
 * @param {number[]} o.v  [v0, v1] along range (m)
 * @param {number} o.length  runway length (m)
 * @param {number} o.width   runway width (m)
 * @param {{ u: number[], v: number[], kind: string }[]} o.areas  paved rectangles (runway / taxiway / apron)
 * @param {object} [o.style]  the runway's look (RUNWAY_STYLES): Meigs' general-aviation strip by default
 */
export function runwayMacro({ u, v, length, width, areas, style }, w = 512, h = 2048, seed = 3) {
  const S = { ...RUNWAY_STYLES.meigs, ...style };
  const du = (u[1] - u[0]) / w, dv = (v[1] - v[0]) / h;
  // repair patches: rectangles of newer (darker) or older (paler) asphalt
  const patches = [];
  for (let k = 0; k < 24; k++) {
    const a = areas[Math.floor(hash(k, 1, seed) * areas.length)];
    const cu = a.u[0] + hash(k, 2, seed) * (a.u[1] - a.u[0]), cv = a.v[0] + hash(k, 3, seed) * (a.v[1] - a.v[0]);
    const su = 1.5 + hash(k, 4, seed) * 9, sv = 2 + hash(k, 5, seed) * 18;
    patches.push({ u0: cu - su / 2, u1: cu + su / 2, v0: cv - sv / 2, v1: cv + sv / 2, tone: hash(k, 6, seed) > 0.4 ? -6 : 5 });
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
    // compact asphalt, dark, its broad tone varying only a few per cent
    const big = fbm(uu / 60, vv / 60, seed, 4);
    const mid = fbm(uu / 9, vv / 9, seed + 1, 3);
    let g = S.grey + (big - 0.5) * 12 + (mid - 0.5) * 6;
    let warm = S.warm + (big - 0.5) * 3;
    if (area?.kind === 'taxiway') { g += 10; warm += 2; }
    if (area?.kind === 'apron') { g += 6; warm += 1; }
    if (area?.kind === 'runway' || !area) {
      // paving lanes: 25 ft strips laid side by side, each its own shade, joints between
      const lane = Math.floor((uu + W2) / S.lane);
      g += (hash(lane, 0, seed) - 0.5) * S.laneTone;
      const inLane = (((uu + W2) % S.lane) + S.lane) % S.lane;
      if (inLane < 0.12 || inLane > S.lane - 0.12) g -= 5;
      // rubber: the touchdown zones of both ends, densest a few hundred metres in, along the wheel tracks
      for (const end of [-1, 1]) {
        const s = end * vv;                          // distance toward this end
        const fromThr = L2 - s;
        if (fromThr > 40 && fromThr < S.rubberZone[0] + 2.4 * S.rubberZone[1]) {
          const zone = Math.exp(-(((fromThr - S.rubberZone[0]) / S.rubberZone[1]) ** 2));
          const across = S.rubberBand * Math.exp(-((uu / S.rubberHalf) ** 2)) + 0.55 * Math.exp(-(((Math.abs(uu) - S.track) / S.trackWidth) ** 2));
          // broken streaks along the runway: thin runs of rubber with cleaner asphalt between (on an
          // airliner runway they run together into a carpet)
          const streak = S.carpet + (1 - S.carpet) * smooth(Math.min(1, Math.max(0, (vnoise(uu * 2.4, vv / 11, seed + 9) - 0.42) / 0.4)))
            * (0.5 + 0.5 * vnoise(uu * 0.7, vv / 40, seed + 10));
          g -= S.rubber * zone * Math.min(1, across) * streak;
          warm -= 2 * zone * across * streak;
        }
      }
      // a polished, slightly darker track down the middle from rolling out (and the rubber and the
      // drips of everything that ever taxied along it), fading in past the thresholds
      if (S.wearTracks) {
        const inside = Math.min(L2 - vv, L2 + vv);
        const wear = S.centreWear * smooth(Math.min(1, Math.max(0, (inside - 30) / 120)));
        g -= wear * Math.min(1, 0.6 * Math.exp(-((uu / 6) ** 2)) + 0.5 * Math.exp(-(((Math.abs(uu) - S.track) / 1.3) ** 2)))
          * (0.75 + 0.25 * vnoise(uu * 0.5, vv / 30, seed + 11));
      } else g -= S.centreWear * Math.exp(-((uu / 3) ** 2));
      if (S.shoulder && Math.abs(uu) > W2) g += S.shoulder;
    }
    // sealed cracks: tar snakes, meandering, mostly across the paving
    const crackField = vnoise(uu / 7 + fbm(uu / 3, vv / 3, seed + 4, 2) * 1.8, vv / 2.2, seed + 5);
    if (Math.abs(crackField - 0.5) < 0.008 && fbm(uu / 25, vv / 25, seed + 6, 2) > 0.6) g = 46;
    // edges of the runway: paler, less traffic
    if (Math.abs(uu) > W2 - 4 && Math.abs(uu) < W2 + 1 && Math.abs(vv) < L2 + 30) g += 3;
    return [(g + warm) * S.tint[0], (g + warm * 0.4) * S.tint[1], (g - warm * 0.6) * S.tint[2]];
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
      for (let k = 0; k < S.skids; k++) {
        const r = (q) => hash(k * 7 + q, end + 5, seed + 21);
        const fromThr = S.skidFrom + S.skidSpread * r(0) ** 1.4;   // past the aiming point, most in the first few hundred metres
        const v0 = end * (L2 - fromThr);                      // touch-down point
        const track = S.skidTrack[0] + r(1) * (S.skidTrack[1] - S.skidTrack[0]);   // main-gear track
        const off = (r(2) - 0.5) * 6;                         // landed off the centreline
        const len = 18 + r(3) * 55;                           // long, fading streaks
        const ang = (r(4) - 0.5) * 0.02;                      // drifting a touch on contact
        const wid = 0.14 + r(5) * 0.16;
        const dark = 12 + r(6) * 20;
        // an airliner's main gear has two wheels a side, a metre apart: a pair of streaks each
        const wheels = r(7) < S.twinWheels ? [-0.46, 0.46] : [0];
        for (const side of [-1, 1]) for (const wo of wheels) {
          const u0 = off + side * track / 2 + wo;
          // along the landing direction: toward the far end (v decreasing for the north end)
          const dirV = -end;
          const vEnd = v0 + dirV * len, uEnd = u0 + ang * len;
          stamp(Math.min(u0, uEnd) - wid, Math.max(u0, uEnd) + wid, Math.min(v0, vEnd), Math.max(v0, vEnd), (uu, vv) => {
            const t = (vv - v0) * dirV / len;                 // 0 at touch-down … 1 at the end
            if (t < 0 || t > 1) return null;
            const dU = Math.abs(uu - (u0 + ang * len * t));
            if (dU > wid) return null;
            // broken: the tyre skipped as it spun up
            const gaps = smooth(Math.min(1, Math.max(0, (vnoise(vv * 0.8, uu * 3, seed + 23) - 0.3) / 0.4)));
            const d = -dark * (1 - t) ** 1.5 * (1 - (dU / wid) ** 2) * (0.7 + 0.3 * vnoise(vv * 2, uu * 9, seed + 22)) * gaps;
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

/**
 * Compact asphalt's surface, tileable over a 2 m tile (S texels across): aggregate chips (5 mm to
 * a centimetre and a half, most grey, some pale, a few dark) bedded in a dark, sandy binder, as maps
 * from the one height field so they agree:
 *   albedo  grey-centred for the overlay detail mode (the macro image carries the colour)
 *   normal  the chips' relief, gentle (a millimetre or two): the sun picks the aggregate out
 *   gloss   (r) the binder dull, the chips' worn faces a little glossier
 *   paint   the albedo under a coat of paint: the chips' shapes, faint
 */
export function asphaltSurface(S = 1024, seed = 7) {
  const N = Math.round(S / 5.4);                 // stone cells per side: ~14 mm apart over the 2 m tile
  const cell = S / N;
  const pts = new Float32Array(N * N * 2), tone = new Float32Array(N * N), size = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    pts[2 * k] = (i + 0.15 + 0.7 * hash(i, j, seed)) * cell;
    pts[2 * k + 1] = (j + 0.15 + 0.7 * hash(i, j, seed + 1)) * cell;
    const r = hash(i, j, seed + 2);
    tone[k] = r > 0.72 ? 0.7 + 0.3 * hash(i, j, seed + 3) : r < 0.12 ? -0.55 : (hash(i, j, seed + 4) - 0.5) * 0.8;
    size[k] = 0.55 + 0.45 * hash(i, j, seed + 5);
  }
  const H = new Float32Array(S * S), T = new Float32Array(S * S), G = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
      // Worley: the nearest and second-nearest chip centres, wrapping round the tile
      let d1 = 1e9, d2 = 1e9, k1 = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = (ci + di + N) % N, jj = (cj + dj + N) % N, k = jj * N + ii;
        const px = pts[2 * k] + (ci + di - ii) * cell, py = pts[2 * k + 1] + (cj + dj - jj) * cell;
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py) / (cell * size[k]);
        if (d < d1) { d2 = d1; d1 = d; k1 = k; } else if (d < d2) d2 = d;
      }
      const grit = hash(x, y, seed + 9);
      // a chip where it stands clear of the gap to its neighbour; the binder between, sandy
      const chip = Math.min(1, Math.max(0, (d2 - d1 - 0.12) / 0.22)) * (d1 < 0.62 ? 1 : 0);
      const i = y * S + x;
      H[i] = chip * (0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - d1 * d1 * 2.2))) + (grit - 0.5) * 0.05;
      T[i] = chip ? tone[k1] * chip : -0.35 + (grit - 0.5) * 0.3;
      G[i] = chip ? 0.18 + 0.08 * chip : 0.09;
    }
  }
  const at = (a, x, y) => a[((y + S) % S) * S + ((x + S) % S)];
  const albedo = image(S, S, (x, y) => {
    const v = 128 + at(T, x, y) * 72;
    return [v, v * 0.995, v * 0.985];
  });
  const strength = 3.2;
  const normal = image(S, S, (x, y) => {
    const dx = (at(H, x + 1, y) - at(H, x - 1, y)) * strength, dy = (at(H, x, y + 1) - at(H, x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [128 + (-dx / l) * 127, 128 + (dy / l) * 127, 128 + (1 / l) * 127];
  });
  const gloss = image(S, S, (x, y) => { const g = at(G, x, y) * 255; return [g, g, g]; });
  // paint fills the binder's pores and lies over the chips: their shapes show through, faintly
  const paint = image(S, S, (x, y) => { const v = 128 + at(T, x, y) * 16; return [v, v, v]; });
  return { albedo, normal, gloss, paint };
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
    // clean asphalt here is ~80: anything darker is rubber, stains or sealant and shows on the paint too
    let f = Math.min(1, Math.pow(luma / 80, 1.6));
    f = 0.78 + 0.22 * f;                       // paint holds its white better than the asphalt round it
    const scuff = fbm(i / 9, j / 9, seed, 3);
    f *= 0.9 + 0.1 * scuff;
    if (vnoise(i / 1.2, j / 1.2, seed + 1) > 0.93) f *= 0.55;  // flaked here and there: asphalt shows through
    const v = 255 * f;
    return [v, v, v];
  });
}
