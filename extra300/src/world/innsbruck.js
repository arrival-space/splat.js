// innsbruck.js — Innsbruck Airport (LOWI) as a destination: the same interface as buildMeigs() for
// the sim and the plugin (frame, elevation, ground, runway, startPosition …), from the data
// scripts/bake-lowi.mjs bakes (OpenStreetMap's paved surfaces and boundary, Terrarium heights).
//
// The ground: the runway, taxiways and aprons are dead level at the runway's height (the datum);
// Google's 3D tiles are flattened there to match (the "flatten" mask below), so the airplane starts
// right on the satellite surface. The grass inside the airport's boundary is level with them too;
// beyond it the ground rises into the valley and the mountains from the elevation grids, blended in
// over 100 m so the boundary has no step.

import { LocalFrame } from './geo.js';
import { LOWI_DATA, LOWI_DEM } from './data/lowi.js';

export const INNSBRUCK = {
  icao: 'LOWI',
  name: 'Innsbruck Airport',
  elevationM: 581,                 // field elevation (OSM ele, AIP 1906 ft)
  geoidM: 48.0,                    // geoid above the WGS-84 ellipsoid here (EGM2008) [approx]: Google's tiles are in ellipsoid heights
  magVar: 4.5,                     // degrees east (2026)
  runway: { ident: ['08', '26'] },
  // the tower view: over the terminal on the south side [approx: the tower isn't in OSM]
  tower: { at: [47.2583, 11.3476], h: 32 },
};

/**
 * Runway 08/26 as painted (render/icaoRunway.js), measured on basemap.at's 2025 orthophoto: metres
 * in from each threshold (OpenStreetMap's runway ends are the thresholds), across from the centre
 * line (+ to the right landing 08, the south side). Edge-line gaps and the yellow lines are in metres
 * from the 08 threshold.
 */
export const LOWI_LAYOUT = {
  shoulder: 7.5,                   // paved beyond the 45 m runway, each side
  before: [96, 36],                // pavement before the 08 threshold (the turn pad), past the 26 one
  bar: 1.8, edge: 0.9,             // the threshold bar's depth, the edge lines' width
  piano: { n: 6, first: 1.2, pitch: 3.65, width: 1.8, at: 6.6, length: 30 },
  numerals: 49,                    // the designator's foot
  aiming: { at: 227.5, length: 45, c: [9, 15] },
  tdz: { at: [150, 450, 600], length: 22.5, c: [9, 12] },
  centre: { from: 70, stripe: 30, gap: 20, width: 0.9 },
  edgeFrom: [59.5, 0],             // the edge lines from the bar before 08 to the 26 threshold
  edgeGaps: { right: [[40, 48], [349, 441], [1555, 1622], [1826, 1838]], left: [[1258, 1291]] },
  // 08's pre-threshold area: a bar across 59 m out, an arrow down the middle to the threshold
  preThreshold: [{ end: -1, bar: -59, arrow: [-50, -12] }],
  yellow: [
    { bezier: [[100, 0], [62, 0], [33, 30]] },                      // from the taxiway onto 08
    { line: [[-17, 0], [-61, 0]] },                                 // 08's turn pad
    { arc: [-61, 26, 26, -Math.PI / 2, -1.5 * Math.PI] },
    { bezier: [[1770, 0], [1800, 0], [1823, 30]] },                 // from the taxiway onto 26
    { line: [[1870, 0], [1945, 0]] },                               // 26's turn pad
    { arc: [1945, 26, 26, -Math.PI / 2, Math.PI / 2] },
    { line: [[1940, -24], [1973, -24], [1973, 30]] },              // the end of the pavement
  ],
};

const UP = [0, 0, -1];
const CELL = 2.5;          // the airport raster's cell (m)
const FEATHER = 14;        // m: Google's ground eases onto the flattened pavement over this
const BLEND = 100;         // m: the level airfield eases into the terrain beyond its boundary

/** Decode one baked height grid: heights in metres above sea level, row 0 the south edge. */
export async function inflateGrid(g) {
  const bin = typeof atob === 'function' ? Uint8Array.from(atob(g.b64), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(g.b64, 'base64'));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  const d = new Int16Array(await new Response(stream).arrayBuffer());
  const n = g.n, h = new Float32Array(n * n);
  let prev = 0;
  for (let j = 0; j < n; j++) {
    prev = j ? h[(j - 1) * n] * 2 : 0;
    for (let i = 0; i < n; i++) {
      const v = (i ? h[j * n + i - 1] * 2 : prev) + d[j * n + i];
      h[j * n + i] = v / 2;
    }
  }
  return { half: g.half, step: g.step, n, h };
}

export async function inflateLowiDem(dem = LOWI_DEM) {
  return { near: await inflateGrid(dem.near), far: await inflateGrid(dem.far) };
}

/** Bilinear height from a grid at (n, e), or null outside it. */
function sampleGrid(g, n, e) {
  const x = (e + g.half) / g.step, y = (n + g.half) / g.step;
  const i = Math.floor(x), j = Math.floor(y);
  if (i < 0 || j < 0 || i >= g.n - 1 || j >= g.n - 1) return null;
  const fx = x - i, fy = y - j, k = j * g.n + i, h = g.h;
  return (h[k] * (1 - fx) + h[k + 1] * fx) * (1 - fy) + (h[k + g.n] * (1 - fx) + h[k + g.n + 1] * fx) * fy;
}

/** Two-pass chamfer distance (in cells) to the cells where `src` is set. */
function distanceField(src, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (x) d[k] = Math.min(d[k], d[k - 1] + 1);
    if (y) {
      d[k] = Math.min(d[k], d[k - w] + 1);
      if (x) d[k] = Math.min(d[k], d[k - w - 1] + D);
      if (x < w - 1) d[k] = Math.min(d[k], d[k - w + 1] + D);
    }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const k = y * w + x;
    if (x < w - 1) d[k] = Math.min(d[k], d[k + 1] + 1);
    if (y < h - 1) {
      d[k] = Math.min(d[k], d[k + w] + 1);
      if (x < w - 1) d[k] = Math.min(d[k], d[k + w + 1] + D);
      if (x) d[k] = Math.min(d[k], d[k + w - 1] + D);
    }
  }
  return d;
}

/**
 * @param {{ near, far }|null} dem  inflateLowiDem(); null: level everywhere (until it's decoded)
 */
export function buildInnsbruck(dem = null, data = INNSBRUCK, osm = LOWI_DATA) {
  const frame = new LocalFrame(osm.centre[0], osm.centre[1]);
  const toNE = ([lat, lon]) => frame.toNE(lat, lon);
  const elevation = data.elevationM;

  // the runway: 08 threshold at the west end, 26 at the east
  const [A, B] = osm.runway.ends.map(toNE);
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const dir = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
  const brg = Math.atan2(dir[1], dir[0]);
  const c = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const wid = osm.runway.width;

  // paved strips (runway, taxiways: [a, b, half-width]) and areas (aprons), in (n, e)
  const strips = [], areas = [];
  for (const p of osm.paved) {
    if (p.line) {
      const pts = p.line.map(toNE);
      for (let i = 0; i < pts.length - 1; i++) strips.push([pts[i], pts[i + 1], Math.max(p.width, p.kind === 'runway' ? 45 : 20) / 2]);
    } else areas.push(p.area.map(toNE));
  }
  const boundary = osm.aerodrome ? osm.aerodrome.map(toNE) : null;

  // ── the airport raster: paved, inside the boundary, and the distances out from both ──
  let n0 = Infinity, n1 = -Infinity, e0 = Infinity, e1 = -Infinity;
  const grow = (n, e) => { n0 = Math.min(n0, n); n1 = Math.max(n1, n); e0 = Math.min(e0, e); e1 = Math.max(e1, e); };
  for (const [a, b] of strips) { grow(...a); grow(...b); }
  for (const ar of areas) for (const p of ar) grow(...p);
  if (boundary) for (const p of boundary) grow(...p);
  const M = BLEND + 60;
  n0 -= M; n1 += M; e0 -= M; e1 += M;
  const W = Math.ceil((e1 - e0) / CELL), H = Math.ceil((n1 - n0) / CELL);
  const paved = new Uint8Array(W * H), inside = new Uint8Array(W * H);
  const cellNE = (x, y) => [n0 + (y + 0.5) * CELL, e0 + (x + 0.5) * CELL];
  for (const [a, b, hw] of strips) {
    const dn = b[0] - a[0], de = b[1] - a[1], L2 = dn * dn + de * de || 1;
    const x0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - hw - e0) / CELL)), x1 = Math.min(W - 1, Math.ceil((Math.max(a[1], b[1]) + hw - e0) / CELL));
    const y0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - hw - n0) / CELL)), y1 = Math.min(H - 1, Math.ceil((Math.max(a[0], b[0]) + hw - n0) / CELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const [n, e] = cellNE(x, y);
      const t = Math.max(0, Math.min(1, ((n - a[0]) * dn + (e - a[1]) * de) / L2));
      if (Math.hypot(n - a[0] - t * dn, e - a[1] - t * de) <= hw) paved[y * W + x] = 1;
    }
  }
  // areas and the boundary: scanline fills (even-odd)
  const fill = (poly, out) => {
    for (let y = 0; y < H; y++) {
      const n = n0 + (y + 0.5) * CELL, xs = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [na, ea] = poly[i], [nb, eb] = poly[j];
        if ((na > n) !== (nb > n)) xs.push(ea + ((n - na) / (nb - na)) * (eb - ea));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil((xs[k] - e0) / CELL - 0.5)), xb = Math.min(W - 1, Math.floor((xs[k + 1] - e0) / CELL - 0.5));
        for (let x = xa; x <= xb; x++) out[y * W + x] = 1;
      }
    }
  };
  for (const ar of areas) fill(ar, paved);
  if (boundary) fill(boundary, inside);
  for (let i = 0; i < paved.length; i++) if (paved[i]) inside[i] = 1;
  const dPaved = distanceField(paved, W, H), dInside = distanceField(inside, W, H);

  const rasterAt = (n, e) => {
    const x = Math.floor((e - e0) / CELL), y = Math.floor((n - n0) / CELL);
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  };

  /** The terrain's height above the datum from the elevation grids (0 until they're decoded). */
  const terrain = (n, e) => {
    if (!dem) return 0;
    const h = sampleGrid(dem.near, n, e) ?? sampleGrid(dem.far, n, e);
    return h == null ? 0 : h - elevation;
  };
  const heightAt = (n, e) => {
    const k = rasterAt(n, e);
    if (k < 0) return terrain(n, e);
    const out = dInside[k] * CELL;
    if (out <= 0) return 0;
    const b = Math.min(1, out / BLEND);
    return b * b * (3 - 2 * b) * terrain(n, e);
  };

  const ground = (n, e) => {
    const k = rasterAt(n, e);
    if (k >= 0 && paved[k]) return { h: 0, normal: UP, surface: 'asphalt' };
    if (k >= 0 && inside[k]) return { h: 0, normal: UP, surface: 'grass' };
    const h = heightAt(n, e);
    // the slope, for the gear on a hillside (NED: up is −z)
    const s = 4;
    const dn = (heightAt(n + s, e) - heightAt(n - s, e)) / (2 * s), de = (heightAt(n, e + s) - heightAt(n, e - s)) / (2 * s);
    const l = Math.hypot(dn, de, 1);
    return { h, normal: [-dn / l, -de / l, -1 / l], surface: 'grass' };
  };

  const thr26 = B, thr08 = A;
  const tw = toNE(data.tower.at);

  return {
    id: 'lowi',
    data: { ...data, elevationFt: elevation / 0.3048 },
    frame, elevation,
    water: -1e4,               // no lake here
    ground,
    heightAt,
    osm: null,
    carrier: null,
    landmarks: [],
    runway: { centre: c, dir, length: len, width: wid, bearing: brg, thr08, thr26, ident: data.runway.ident, layout: LOWI_LAYOUT, style: 'lowi' },
    tower: { ne: tw, h: data.tower.h },
    /** The flatten mask for Google's tiles: 1 on the pavement, easing to 0 over FEATHER metres. */
    flattenMask() {
      const img = new Uint8Array(W * H);
      for (let i = 0; i < img.length; i++) {
        const d = dPaved[i] * CELL;
        img[i] = d <= 1 ? 255 : Math.max(0, Math.round(255 * (1 - (d - 1) / FEATHER)));
      }
      return { width: W, height: H, data: img, box: { e: [e0, e0 + W * CELL], n: [n0, n0 + H * CELL] } };
    },
    /** The pavement as drawn when Google's tiles aren't there: strips and areas, (n, e). */
    pavement: { strips, areas },
    isPaved: (n, e) => { const k = rasterAt(n, e); return k >= 0 && paved[k] === 1; },
    attachCarrier() {},
    attachOsm() {},
    setSkylineYear() {},
    buildingAt() { return null; },
    /** On runway 26 (or 08 with alt), lined up just past the threshold. */
    startPosition(alt = false) {
      const back = 60;
      return alt
        ? { n: thr08[0] + dir[0] * back, e: thr08[1] + dir[1] * back, heading: brg }
        : { n: thr26[0] - dir[0] * back, e: thr26[1] - dir[1] * back, heading: brg + Math.PI };
    },
  };
}

