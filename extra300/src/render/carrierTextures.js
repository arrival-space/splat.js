// carrierTextures.js — the carrier's procedural textures, as RGBA pixel arrays
// (engine-free, like groundTextures.js: the plugin uploads them).
//
//   deck   one image over the whole flight deck in ship metres: non-skid laid
//          in patches with their seams, rubber and tyre marks where the
//          airplanes come down in the landing area, soot in front of the jet
//          blast deflectors, oil along the catapults and where the jets park,
//          grime along the deck edges
//   hull   a strip of the hull's side, repeating along the ship: haze grey
//          plating with its weld seams, rust weeping from the scuppers, the
//          black boot top at the waterline and the red antifouling under it
//
// Row 0 of an image is its v = 1 edge (as the ground textures: the canvas is
// uploaded the right way up).

import { fbm, hash, image, vnoise } from './groundTextures.js';
import { widthAt } from './carrierModel.js';

/** Where the deck image lies, ship metres: t (to starboard) and s (forward from the stern). */
export const DECK_UV = { t: [-46, 40], s: [0, 334] };

/**
 * @param {object} data  world/carrier.js NIMITZ
 */
export function deckMacro(data, w = 512, h = 2048, seed = 31) {
  const [T0, T1] = DECK_UV.t, [S0, S1] = DECK_UV.s;
  const dt = (T1 - T0) / w, ds = (S1 - S0) / h;
  const la = data.landing;
  const ca = Math.cos(data.angle), sa = Math.sin(data.angle);
  // the landing area's frame: d along its centre line from the stern, l to its right
  const toLanding = (s, t) => {
    const x = s - la.origin[0], y = t - la.origin[1];
    return [x * ca - y * sa, x * sa + y * ca];
  };
  const edges = Array.from({ length: h }, (_, j) => widthAt(data.deck, S1 - (j + 0.5) * ds));
  const img = image(w, h, (i, j) => {
    const t = T0 + (i + 0.5) * dt, s = S1 - (j + 0.5) * ds;
    // non-skid, laid in patches a few metres across, each its own shade, the seams between them darker
    const pi = Math.floor((t + 50) / 9.5), pj = Math.floor((s + (pi % 2) * 4) / 13);
    let g = 74 + (hash(pi, pj, seed) - 0.5) * 5;
    const fs = ((s + (pi % 2) * 4) % 13 + 13) % 13, ft = ((t + 50) % 9.5 + 9.5) % 9.5;
    if (fs < 0.12 || ft < 0.12) g -= 4;
    g += (fbm(t / 20, s / 20, seed + 1, 4) - 0.5) * 16 + (fbm(t / 2.5, s / 2.5, seed + 2, 2) - 0.5) * 6;
    // the landing area: rubber laid down along the wheels' tracks, heaviest from touch-down to the wires
    const [d, l] = toLanding(s, t);
    if (d > 10 && d < 230 && Math.abs(l) < la.halfWidth + 2) {
      const zone = Math.exp(-(((d - 75) / 55) ** 2)) + 0.35 * Math.exp(-(((d - 140) / 50) ** 2));
      const across = Math.exp(-((l / 6.5) ** 2));
      const streak = 0.45 + 0.55 * vnoise(l * 2.2, d / 9, seed + 3);
      g -= 30 * zone * across * streak;
      // the hooks' drag: a lighter, scraped band right on the centre line
      g += 6 * zone * Math.exp(-((l / 0.6) ** 2));
    }
    // grime along the deck edges, where nothing scrubs it
    const e = edges[j];
    if (e) {
      const toEdge = Math.min(t - e[0], e[1] - t);
      if (toEdge >= 0 && toEdge < 2.5) g -= 6 * (1 - toEdge / 2.5) * (0.6 + 0.4 * fbm(t / 3, s / 3, seed + 4, 2));
    }
    return [g - 1.5, g, g + 3];
  });

  const stamp = (t0, t1, s0, s1, f) => {
    const i0 = Math.max(0, Math.floor((t0 - T0) / dt)), i1 = Math.min(w - 1, Math.ceil((t1 - T0) / dt));
    const j0 = Math.max(0, Math.floor((S1 - s1) / ds)), j1 = Math.min(h - 1, Math.ceil((S1 - s0) / ds));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const v = f(T0 + (i + 0.5) * dt, S1 - (j + 0.5) * ds);
      if (!v) continue;
      const k = (j * w + i) * 4;
      img.data[k] += v; img.data[k + 1] += v; img.data[k + 2] += v * 0.95;
    }
  };
  const blob = (s, t, r, dark) => stamp(t - r, t + r, s - r, s + r, (tt, ss) => {
    const d2 = ((tt - t) ** 2 + (ss - s) ** 2) / (r * r);
    return d2 < 1 ? -dark * (1 - d2) * (0.6 + 0.4 * vnoise(tt * 2, ss * 2, seed + 5)) : null;
  });
  const fromLanding = (d, l) => [la.origin[0] + d * ca + l * sa, la.origin[1] - d * sa + l * ca];

  // tyre marks: each trap's pair of main-wheel streaks, starting black where they touched and fading
  for (let k = 0; k < 110; k++) {
    const r = (q) => hash(k * 11 + q, 3, seed + 6);
    const d0 = 30 + 85 * r(0) ** 1.2, len = 5 + r(1) * 28;
    const off = (r(2) - 0.5) * 9, track = 2.6 + r(3) * 3, wid = 0.14 + r(4) * 0.12, dark = 7 + r(5) * 16;
    const drift = (r(6) - 0.5) * 0.04;
    for (const side of [-1, 1]) {
      const l0 = off + (side * track) / 2;
      const [sa0, ta0] = fromLanding(d0, l0), [sa1, ta1] = fromLanding(d0 + len, l0 + drift * len);
      stamp(Math.min(ta0, ta1) - 1, Math.max(ta0, ta1) + 1, Math.min(sa0, sa1) - 1, Math.max(sa0, sa1) + 1, (tt, ss) => {
        const [dd, ll] = toLanding(ss, tt);
        const f = (dd - d0) / len;
        if (f < 0 || f > 1) return null;
        const dl = Math.abs(ll - (l0 + drift * len * f));
        return dl < wid ? -dark * (1 - f) ** 1.3 * (1 - (dl / wid) ** 2) : null;
      });
    }
  }
  // soot in front of each jet blast deflector, and oil weeping along the catapult tracks
  const cats = [
    { a: [205, -8], b: [326, -4] }, { a: [205, 7], b: [326, 3.5] },
    { a: fromLanding(118, -7), b: fromLanding(190, -7) }, { a: fromLanding(112, 7), b: fromLanding(184, 7) },
  ];
  for (const c of cats) {
    const [s0, t0] = c.a, [s1, t1] = c.b;
    const L = Math.hypot(s1 - s0, t1 - t0), us = (s1 - s0) / L, ut = (t1 - t0) / L;
    for (let x = 0; x < 16; x += 1.5) blob(s0 + us * (x - 2), t0 + ut * (x - 2), 4.5 - x * 0.2, 14 - x * 0.6);
    stamp(Math.min(t0, t1) - 2, Math.max(t0, t1) + 2, s0, s1, (tt, ss) => {
      const x = (ss - s0) * us + (tt - t0) * ut, y = -(ss - s0) * ut + (tt - t0) * us;
      return x > 0 && x < L && Math.abs(y) < 1.4 ? -7 * (1 - Math.abs(y) / 1.4) * vnoise(x / 3, y * 3, seed + 7) : null;
    });
  }
  // oil and fuel stains where the jets park: the bow, round the island, the elevators
  const spots = [[230, 325, -14, 16], [140, 230, 6, 24], [20, 70, 10, 22]];
  spots.forEach(([s0, s1, t0, t1], a) => {
    for (let k = 0; k < 28; k++) {
      const r = (q) => hash(k * 5 + q, a, seed + 8);
      blob(s0 + r(0) * (s1 - s0), t0 + r(1) * (t1 - t0), 0.4 + r(2) * 1.6, 12 + r(3) * 18);
    }
  });
  return img;
}

/**
 * One strip of the hull's side: `along` metres of it (it repeats), from `below` metres under the
 * waterline up to the flight deck, `height` metres in all.
 */
export function hullTexture({ along = 64, height = 20.5, below = 2 }, w = 512, h = 256, seed = 41) {
  const du = along / w, dy = height / h;
  const img = image(w, h, (i, j) => {
    const u = (i + 0.5) * du, y = height - (j + 0.5) * dy;      // y up from the bottom edge
    const wl = y - below;                                          // height above the waterline
    if (wl < -0.8) {
      const g = 0.9 + 0.1 * fbm(u / 4, y / 4, seed, 2, Math.round(along / 4));
      return [118 * g, 40 * g, 34 * g];                            // red antifouling
    }
    if (wl < 1.3) {
      const g = 34 + 8 * fbm(u / 3, y / 3, seed + 1, 2, Math.round(along / 3));
      return [g, g + 1, g + 2];                                    // the black boot top (reaching under the waterline: no red shows above the lake)
    }
    // haze grey plating: plates 8 m long and 2.4 m high, each a slightly different shade
    const plate = hash(Math.floor(u / 8) % (along / 8), Math.floor(y / 2.4), seed + 2);
    let g = 1 + (plate - 0.5) * 0.05 + (fbm(u / 12, y / 12, seed + 3, 3, Math.round(along / 12)) - 0.5) * 0.08;
    const fu = u % 8, fy = y % 2.4;
    if (fu < 0.07 || fy < 0.06) g -= 0.05;                         // weld seams
    // grime just above the boot top, where the lake splashes
    if (wl < 3) g -= 0.1 * (1 - (wl - 1.3) / 1.7) * (0.6 + 0.4 * vnoise(u * 2, y, seed + 4, Math.round(along * 2)));
    return [126 * g, 132 * g, 138 * g];
  });
  // rust weeping down from the scuppers and fittings: streaks, brown, fading downward
  for (let k = 0; k < 46; k++) {
    const r = (q) => hash(k * 7 + q, 9, seed + 5);
    const u0 = r(0) * along, y0 = below + 6 + r(1) * (height - below - 6.5), len = 1.5 + r(2) * 7, wid = 0.08 + r(3) * 0.3;
    const dark = 0.12 + r(4) * 0.22;
    const i0 = Math.floor((u0 - wid) / du), i1 = Math.ceil((u0 + wid) / du);
    const j0 = Math.floor((height - y0) / dy), j1 = Math.min(h - 1, Math.ceil((height - y0 + len) / dy));
    for (let j = Math.max(0, j0); j <= j1; j++) {
      const f = ((j + 0.5) * dy - (height - y0)) / len;            // 0 at the scupper … 1 at its end
      if (f < 0 || f > 1) continue;
      for (let ii = i0; ii <= i1; ii++) {
        const i = ((ii % w) + w) % w;
        const du0 = Math.abs((ii + 0.5) * du - u0) / (wid * (1 + f * 0.6));
        if (du0 > 1) continue;
        const a = dark * (1 - f) ** 1.2 * (1 - du0 * du0) * (0.6 + 0.4 * vnoise(ii * 0.7, j * 0.15, seed + 6));
        const q = (j * w + i) * 4;
        img.data[q] *= 1 - a * 0.6; img.data[q + 1] *= 1 - a * 0.85; img.data[q + 2] *= 1 - a;
      }
    }
  }
  return img;
}
