// airport.js — an airport as a destination: the same interface as buildMeigs() for the sim and the
// plugin (frame, elevation, ground, runway, startPosition …), from the data scripts/bake-airport.mjs
// bakes (OpenStreetMap's paved surfaces, boundary and water, Terrarium heights). Innsbruck and
// Renton are made of it (world/innsbruck.js, world/renton.js).
//
// The ground: the runway, taxiways and aprons are dead level at the runway's height (the datum);
// Google's 3D tiles are flattened there to match (the "flatten" mask below), so the airplane starts
// right on the satellite surface. The grass inside the airport's boundary is level with them too;
// beyond it the ground follows the elevation grids, blended in over 100 m so the boundary has no
// step; lakes and rivers are water at their level.

import { LocalFrame } from './geo.js';

// the drawn runway's pavement (render/icaoRunway.js), over our terrain's own (up to 0.04) and Google's
// flattened ground (0): the wheels roll on it, not 9 cm under it
export const RUNWAY_PAVE_H = 0.09;

const UP = [0, 0, -1];
const CELL = 2.5;          // the airport raster's cell (m)
const FEATHER = 14;        // m: Google's ground eases onto the flattened pavement over this
const BLEND = 100;         // m: the level airfield eases into the terrain beyond its boundary

/** gunzip a base64 string (the baked grids and rasters). */
async function gunzip64(b64) {
  const bin = typeof atob === 'function' ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(b64, 'base64'));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** Decode one baked height grid: heights in metres above sea level, row 0 the south edge. */
export async function inflateGrid(g) {
  const d = new Int16Array(await gunzip64(g.b64));
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

/**
 * Decode an airport's baked grids: the heights, and its water raster if it has one.
 * @returns {Promise<{ near, far, water?: Uint8Array }>}
 */
export async function inflateAirport(dem, osm = null) {
  const out = { near: await inflateGrid(dem.near), far: await inflateGrid(dem.far) };
  if (osm?.water) out.water = new Uint8Array(await gunzip64(osm.water.mask.b64));
  return out;
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

/** Point in polygon (even-odd), (n, e). */
function inPoly(poly, n, e) {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [na, ea] = poly[i], [nb, eb] = poly[j];
    if ((na > n) !== (nb > n) && e < ea + ((n - na) / (nb - na)) * (eb - ea)) r = !r;
  }
  return r;
}

/**
 * An airport as a world (the same interface as buildMeigs()).
 * @param {object} data  its description (world/innsbruck.js INNSBRUCK, world/renton.js RENTON): icao,
 *        elevationM, geoidM, magVar, runway { ident: [low end, high end] }, tower, layout, style,
 *        start ('high': on the high end's runway by default, 'low' on the low end's)
 * @param {object} osm   the baked data (scripts/bake-airport.mjs)
 * @param {{ near, far, water? }|null} dem  inflateAirport(); null: level everywhere (until it's decoded)
 */
export function buildAirport(data, osm, dem = null) {
  const frame = new LocalFrame(osm.centre[0], osm.centre[1]);
  const toNE = ([lat, lon]) => frame.toNE(lat, lon);
  const elevation = data.elevationM;

  // the runway, as OpenStreetMap draws it: from the low end's threshold (A) to the high end's (B)
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

  // water: the baked raster near the field, the shores (less their islands) beyond it
  const W8 = osm.water, level = W8 ? W8.level - elevation : -1e4;
  const shores = W8 ? W8.shores : [], islands = W8 ? W8.islands : [];
  const isWater = (n, e) => {
    if (!W8) return false;
    const m = W8.mask, x = Math.floor((e + m.half) / m.cell), y = Math.floor((n + m.half) / m.cell);
    if (dem?.water && x >= 0 && y >= 0 && x < m.n && y < m.n) return dem.water[y * m.n + x] === 0;
    return shores.some((r) => inPoly(r, n, e)) && !islands.some((r) => inPoly(r, n, e));
  };

  // the drawn runway's slab (its layout: the runway, its shoulders, the pavement past its ends)
  const lay = data.layout;
  const slab = lay ? { half: wid / 2 + lay.shoulder, v0: -len / 2 - lay.before[0], v1: len / 2 + lay.before[1] } : null;
  const onSlab = (n, e) => {
    if (!slab) return false;
    const dn = n - c[0], de = e - c[1];
    const a = dn * dir[0] + de * dir[1], x = -dn * dir[1] + de * dir[0];
    return a >= slab.v0 && a <= slab.v1 && Math.abs(x) <= slab.half;
  };

  const ground = (n, e) => {
    if (onSlab(n, e)) return { h: RUNWAY_PAVE_H, normal: UP, surface: 'asphalt' };
    const k = rasterAt(n, e);
    if (k >= 0 && paved[k]) return { h: 0, normal: UP, surface: 'asphalt' };
    if (k >= 0 && inside[k]) return { h: 0, normal: UP, surface: 'grass' };
    if (isWater(n, e)) return { h: level, normal: UP, surface: 'water' };
    const h = heightAt(n, e);
    // the slope, for the gear on a hillside (NED: up is −z)
    const s = 4;
    const dn = (heightAt(n + s, e) - heightAt(n - s, e)) / (2 * s), de = (heightAt(n, e + s) - heightAt(n, e - s)) / (2 * s);
    const l = Math.hypot(dn, de, 1);
    return { h, normal: [-dn / l, -de / l, -1 / l], surface: 'grass' };
  };

  const tw = toNE(osm.tower || data.tower.at);

  return {
    id: data.id,
    data: { ...data, elevationFt: elevation / 0.3048 },
    frame, elevation,
    water: level,              // the water's surface above the datum (far below: none)
    /** Lake and river for Google's tiles to shade (plugin/waterMask.js): raster near, shores beyond. */
    waterMask: W8 && dem?.water ? {
      near: { nx: W8.mask.n, ny: W8.mask.n, data: dem.water, box: { x0: -W8.mask.half, x1: W8.mask.half, y0: -W8.mask.half, y1: W8.mask.half } },
      shores, islands,
    } : null,
    ground,
    heightAt,
    osm: null,
    carrier: null,
    landmarks: [],
    runway: { centre: c, dir, length: len, width: wid, bearing: brg, thresholds: [A, B], ident: data.runway.ident, layout: data.layout, style: data.style },
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
    /** Lake or river here. */
    isWater,
    attachCarrier() {},
    attachOsm() {},
    /** On the default runway (or the other with alt), lined up just past its threshold. */
    startPosition(alt = false) {
      const back = 60;
      return (data.start === 'low') !== alt
        ? { n: A[0] + dir[0] * back, e: A[1] + dir[1] * back, heading: brg }
        : { n: B[0] - dir[0] * back, e: B[1] - dir[1] * back, heading: brg + Math.PI };
    },
  };
}

