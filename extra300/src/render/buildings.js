// buildings.js — procedural Chicago from OpenStreetMap footprints.
//
// Every footprint becomes walls and a roof at load time. Walls get UVs in
// "bays × floors" so one tiny procedural window texture per facade style
// lays out real-looking floors on every building, at any size; a per-building
// tint keeps neighbours apart. Roofs: flat (earcut, courtyards included),
// gabled on small rectangular houses, pyramidal and dome where OSM says so.
// Output is merged per tile and style so the whole city is a few hundred
// draw calls.

import earcut from 'earcut';
import { MeshBuilder } from './geometry.js';

/** Facade styles: tint, window texture cell (bay width × floor height, m), roof tint. */
export const FACADES = {
  brick: { tint: [150, 92, 70], bay: 2.8, floor: 3.3, roof: [92, 88, 84] },
  stone: { tint: [196, 184, 160], bay: 3.0, floor: 3.6, roof: [120, 118, 112] },
  glass: { tint: [92, 118, 140], bay: 1.6, floor: 3.9, roof: [88, 92, 96] },
  dark: { tint: [46, 46, 50], bay: 1.6, floor: 3.9, roof: [40, 40, 44] },
  white: { tint: [226, 224, 216], bay: 2.0, floor: 3.9, roof: [150, 150, 146] },
  plain: { tint: [150, 146, 136], bay: 6.0, floor: 4.0, roof: [110, 108, 104] },
  house: { tint: [176, 150, 120], bay: 3.0, floor: 3.0, roof: [96, 72, 62] },
};

const NAMED = {
  black: [36, 36, 38], white: [232, 230, 224], grey: [150, 150, 150], gray: [150, 150, 150], silver: [180, 184, 188],
  brown: [120, 84, 60], red: [150, 60, 50], beige: [210, 196, 168], tan: [200, 176, 140], yellow: [220, 196, 110],
  blue: [80, 110, 150], green: [90, 120, 90], orange: [200, 120, 60], darkgrey: [80, 80, 82], darkgray: [80, 80, 82],
};
export function parseColour(s) {
  if (!s) return null;
  const t = s.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (NAMED[t]) return NAMED[t];
  const m = t.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function jitter(rgb, seed, amount = 0.12) {
  const k = 1 + (((Math.sin(seed * 12.9898) * 43758.5453) % 1) - 0.5) * 2 * amount;
  return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * k))));
}

/** render space: x = east, y = up, z = -north */
const P = (e, n, y) => [e, y, -n];

function wallQuad(mb, a, b, y0, y1, u0, u1, f, color) {
  // outward normal for a CCW outer ring (or CW hole) in (e, n): right of the edge direction
  const de = b[0] - a[0], dn = b[1] - a[1];
  const L = Math.hypot(de, dn) || 1;
  const n = [dn / L, 0, de / L];
  const v0 = y0 / f.floor, v1 = y1 / f.floor;
  const i = mb.vertex(P(a[0], a[1], y0), n, [u0, v0], color);
  mb.vertex(P(b[0], b[1], y0), n, [u1, v0], color);
  mb.vertex(P(b[0], b[1], y1), n, [u1, v1], color);
  mb.vertex(P(a[0], a[1], y1), n, [u0, v1], color);
  // bottom-a, bottom-b, top-b, top-a is counter-clockwise seen from outside (tests/osm.test.js checks it)
  mb.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
}

function walls(mb, ring, y0, y1, f, color) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.05) continue;
    // snap the bay grid to whole bays per wall so windows don't straddle corners
    const bays = Math.max(1, Math.round(L / f.bay));
    wallQuad(mb, a, b, y0, y1, s, s + bays, f, color);
    s += bays;
  }
}

function flatRoof(mb, outer, holes, y, color, down = false) {
  const flat = [];
  const holeIdx = [];
  for (const p of outer) flat.push(p[0], p[1]);
  for (const h of holes) { holeIdx.push(flat.length / 2); for (const p of h) flat.push(p[0], p[1]); }
  const tri = earcut(flat, holeIdx.length ? holeIdx : null, 2);
  const base = mb.vertexCount;
  const n = down ? [0, -1, 0] : [0, 1, 0];
  for (let i = 0; i < flat.length; i += 2) mb.vertex(P(flat[i], flat[i + 1], y), n, null, color);
  for (let i = 0; i < tri.length; i += 3) pushFacing(mb, base + tri[i], base + tri[i + 1], base + tri[i + 2], n);
}

/** Index a triangle so it is counter-clockwise seen from the side `facing` points to (earcut's
 *  output winding is not guaranteed, so every roof triangle is oriented explicitly). */
function pushFacing(mb, i0, i1, i2, facing) {
  const p = mb.positions;
  const ux = p[i1 * 3] - p[i0 * 3], uy = p[i1 * 3 + 1] - p[i0 * 3 + 1], uz = p[i1 * 3 + 2] - p[i0 * 3 + 2];
  const vx = p[i2 * 3] - p[i0 * 3], vy = p[i2 * 3 + 1] - p[i0 * 3 + 1], vz = p[i2 * 3 + 2] - p[i0 * 3 + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * facing[0] + ny * facing[1] + nz * facing[2] >= 0) mb.indices.push(i0, i1, i2);
  else mb.indices.push(i0, i2, i1);
}

/** A flat-shaded triangle facing away from `inside` (a point inside the building). */
function triFlat(mb, a, b, c, color, inside) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const l = Math.hypot(...n) || 1;
  n = n.map((x) => x / l);
  const cx = (a[0] + b[0] + c[0]) / 3 - inside[0], cy = (a[1] + b[1] + c[1]) / 3 - inside[1], cz = (a[2] + b[2] + c[2]) / 3 - inside[2];
  const flip = n[0] * cx + n[1] * cy + n[2] * cz < 0;
  if (flip) n = n.map((x) => -x);
  const i = mb.vertex(a, n, null, color);
  mb.vertex(b, n, null, color);
  mb.vertex(c, n, null, color);
  if (flip) mb.indices.push(i, i + 2, i + 1); else mb.indices.push(i, i + 1, i + 2);
}

/** Gable along the longer axis of a 4-corner footprint; walls stop at the eaves. */
function gabled(wallsMb, roofMb, ring, y0, h, f, wallColor, roofColor) {
  const [a, b, c, d] = ring;
  const lab = Math.hypot(b[0] - a[0], b[1] - a[1]), lbc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  // r0..r3 so that r0→r1 is a long side
  const r = lab >= lbc ? [a, b, c, d] : [b, c, d, a];
  const short = Math.min(lab, lbc);
  const rise = Math.min(0.4 * short, 0.35 * (h - y0));
  const eave = h - rise;
  walls(wallsMb, ring, y0, eave, f, wallColor);
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const m03 = mid(r[0], r[3]), m12 = mid(r[1], r[2]);
  const R0 = P(m03[0], m03[1], h), R1 = P(m12[0], m12[1], h);
  const E = (p) => P(p[0], p[1], eave);
  const cen = mid(mid(r[0], r[2]), mid(r[1], r[3]));
  const inside = P(cen[0], cen[1], y0 + 0.5 * (eave - y0));
  // two slopes and two gable triangles (gables in the wall colour)
  triFlat(roofMb, E(r[0]), E(r[1]), R1, roofColor, inside); triFlat(roofMb, E(r[0]), R1, R0, roofColor, inside);
  triFlat(roofMb, E(r[2]), E(r[3]), R0, roofColor, inside); triFlat(roofMb, E(r[2]), R0, R1, roofColor, inside);
  triFlat(wallsMb, E(r[1]), E(r[2]), R1, wallColor, inside);
  triFlat(wallsMb, E(r[3]), E(r[0]), R0, wallColor, inside);
}

function pointed(wallsMb, roofMb, ring, y0, h, f, wallColor, roofColor, dome) {
  let cx = 0, cy = 0;
  for (const p of ring) { cx += p[0]; cy += p[1]; }
  cx /= ring.length; cy /= ring.length;
  let rmin = Infinity;
  for (const p of ring) rmin = Math.min(rmin, Math.hypot(p[0] - cx, p[1] - cy));
  const rise = Math.min(dome ? rmin : 0.6 * rmin, 0.5 * (h - y0));
  const eave = h - rise;
  walls(wallsMb, ring, y0, eave, f, wallColor);
  const steps = dome ? 4 : 1;
  const inside = P(cx, cy, y0 + 0.5 * (eave - y0));
  let prev = ring.map((p) => [p[0], p[1], eave]);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const k = dome ? Math.cos((t * Math.PI) / 2) : 1 - t;
    const y = dome ? eave + rise * Math.sin((t * Math.PI) / 2) : eave + rise * t;
    const next = ring.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k, y]);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const A = P(prev[i][0], prev[i][1], prev[i][2]), Bq = P(prev[j][0], prev[j][1], prev[j][2]);
      const C = P(next[j][0], next[j][1], next[j][2]), D = P(next[i][0], next[i][1], next[i][2]);
      triFlat(roofMb, A, C, Bq, roofColor, inside);
      if (s < steps) triFlat(roofMb, A, D, C, roofColor, inside);
    }
    prev = next;
  }
}

/**
 * @param {object[]} buildings decoded OSM buildings ({ outer, holes, h, minH, style, roof, colour, year })
 * @param {{ year?: number, minHeight?: number, tile?: number, skip?: (b) => boolean }} [opts]
 * @returns {{ key: string, style: string, kind: 'walls'|'roofs', mesh: MeshBuilder }[]}
 */
export function buildCity(buildings, opts = {}) {
  const year = opts.year ?? 2026;
  const minHeight = opts.minHeight ?? 0;
  const tile = opts.tile ?? 1200;
  const out = new Map();
  const get = (key, style, kind) => {
    const k = `${key}|${style}|${kind}`;
    if (!out.has(k)) out.set(k, { key, style, kind, mesh: new MeshBuilder({ uv: kind === 'walls', color: true }) });
    return out.get(k).mesh;
  };
  let shown = 0;
  buildings.forEach((b, idx) => {
    if (b.year && b.year > year) return;
    if (b.h < minHeight) return;
    if (opts.skip && opts.skip(b)) return;
    const f = FACADES[b.style] || FACADES.stone;
    const own = parseColour(b.colour);
    const wallColor = jitter(own || f.tint, idx + 1, own ? 0.05 : 0.14);
    const roofColor = jitter(f.roof, idx + 7, 0.1);
    const c = b.outer[0];
    const key = `${Math.floor(c[0] / tile)},${Math.floor(c[1] / tile)}`;
    const W = get(key, b.style, 'walls');
    const R = get(key, 'roof', 'roofs');
    const y0 = b.minH;
    if (b.outer.length === 4 && !b.holes.length && (b.roof === 1 || (b.style === 'house' && b.roof === 0 && b.h < 14))) {
      gabled(W, R, b.outer, y0, b.h, f, wallColor, b.style === 'house' ? roofColor : jitter([110, 96, 88], idx));
    } else if ((b.roof === 3 || b.roof === 4) && !b.holes.length) {
      pointed(W, R, b.outer, y0, b.h, f, wallColor, roofColor, b.roof === 4);
    } else {
      walls(W, b.outer, y0, b.h, f, wallColor);
      for (const h of b.holes) walls(W, h, y0, b.h, f, wallColor);
      flatRoof(R, b.outer, b.holes, b.h, roofColor);
      if (y0 > 0.5) flatRoof(R, b.outer, b.holes, y0, roofColor, true);
    }
    shown++;
  });
  const parts = [...out.values()].filter((p) => p.mesh.vertexCount);
  parts.shown = shown;
  return parts;
}

/** Flat ground layers (land, parks, inland water) as one mesh each, at height y. */
export function groundLayer(polys, y) {
  const mb = new MeshBuilder();
  for (const poly of polys) {
    if (poly.length < 3) continue;
    const flat = [];
    for (const p of poly) flat.push(p[0], p[1]);
    const tri = earcut(flat, null, 2);
    const base = mb.vertexCount;
    for (let i = 0; i < flat.length; i += 2) mb.vertex(P(flat[i], flat[i + 1], y), [0, 1, 0]);
    for (let i = 0; i < tri.length; i += 3) pushFacing(mb, base + tri[i], base + tri[i + 1], base + tri[i + 2], [0, 1, 0]);
  }
  return mb;
}

/** Road / rail ribbons: one quad per segment, square ends overlapping at the joints. */
export function ribbons(lines, y, widthScale = 1) {
  const mb = new MeshBuilder();
  for (const { pts, w } of lines) {
    const hw = (w * widthScale) / 2;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ae, an] = pts[i], [be, bn] = pts[i + 1];
      const de = be - ae, dn = bn - an, L = Math.hypot(de, dn);
      if (L < 0.1) continue;
      const oe = (-dn / L) * hw, on = (de / L) * hw;
      const xe = (de / L) * hw * 0.5, xn = (dn / L) * hw * 0.5;   // overlap into the next segment
      const i0 = mb.vertex(P(ae + oe - xe, an + on - xn, y), [0, 1, 0]);
      mb.vertex(P(ae - oe - xe, an - on - xn, y), [0, 1, 0]);
      mb.vertex(P(be - oe + xe, bn - on + xn, y), [0, 1, 0]);
      mb.vertex(P(be + oe + xe, bn + on + xn, y), [0, 1, 0]);
      mb.indices.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }
  }
  return mb;
}

/** Seawall: vertical faces along the shore polygons' edges, skipping the edges on the box. */
export function seawalls(polys, box, yBottom, yTop) {
  const mb = new MeshBuilder();
  const onBox = (p) => Math.abs(p[0] - box.x0) < 1 || Math.abs(p[0] - box.x1) < 1 || Math.abs(p[1] - box.y0) < 1 || Math.abs(p[1] - box.y1) < 1;
  const f = { floor: 1 };
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (onBox(a) && onBox(b)) continue;
      wallQuad(mb, a, b, yBottom, yTop, 0, 0, f, null);
    }
  }
  return mb;
}
