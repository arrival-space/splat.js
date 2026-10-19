// bake-osm.mjs — the land/water mask round Meigs from the raw OpenStreetMap download
// (scripts/fetch-osm.mjs), into src/world/data/chicagoOsm.js, the module the plugin ships with.
//
// Only Lake Michigan's shore is kept (Google's 3D tiles are the city now): the coastline chained
// and closed against the box into land polygons, the rivers cut out of them, rasterised into a 4 m
// land/water mask — the gear's land and lake, and the water Google's tiles are shaded as.
//
// Data © OpenStreetMap contributors (ODbL 1.0).

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFrame, pointInPolygon } from '../src/world/geo.js';
import { MEIGS } from '../src/world/meigs.js';
import { BBOX } from './fetch-osm.mjs';
import { encodeOsm, QUANTUM, MASK_CELL } from '../src/world/osmCodec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'osm', 'raw');
const OUT = join(ROOT, 'src', 'world', 'data', 'chicagoOsm.js');

/** Douglas–Peucker on a closed ring of [e, n]. */
function simplify(ring, tol) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let dmax = 0, idx = -1;
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      // a closed ring starts and ends on the same point: measure from that point instead
      const d = L < 1e-9 ? Math.hypot(ring[i][0] - ax, ring[i][1] - ay) : Math.abs((ring[i][0] - ax) * dy - (ring[i][1] - ay) * dx) / L;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return ring.filter((_, i) => keep[i]);
}

const area2 = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2; };
const centroid = (r) => { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; };

function loadAll() {
  // a layer may have come down whole or in quarters (land, landa, landb …): merge by element id
  const layer = (name) => {
    const byId = new Map();
    for (const f of readdirSync(RAW).filter((f) => new RegExp(`^${name}[a-d]*\\.json$`).test(f))) {
      for (const e of JSON.parse(readFileSync(join(RAW, f), 'utf8')).elements) byId.set(`${e.type}/${e.id}`, e);
    }
    if (!byId.size) throw new Error(`no ${name} data in ${RAW} — run scripts/fetch-osm.mjs`);
    return [...byId.values()];
  };
  const land = layer('land');
  const shore = layer('shore');
  return { land, shore };
}

/** Outer and inner rings (lat/lon) of a way or a multipolygon relation, with ways chained. */
function rings(e) {
  if (e.type === 'way') return e.geometry ? { outer: [e.geometry], inner: [] } : null;
  const outer = chain((e.members || []).filter((m) => m.role !== 'inner' && m.geometry).map((m) => m.geometry));
  const inner = chain((e.members || []).filter((m) => m.role === 'inner' && m.geometry).map((m) => m.geometry));
  return { outer, inner };
}

/** Join way geometries that share endpoints into rings. */
function chain(parts) {
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const pool = parts.map((p) => p.slice());
  const out = [];
  while (pool.length) {
    let cur = pool.shift();
    let grew = true;
    while (grew && key(cur[0]) !== key(cur[cur.length - 1])) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        if (key(p[0]) === key(cur[cur.length - 1])) cur = cur.concat(p.slice(1));
        else if (key(p[p.length - 1]) === key(cur[cur.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else if (key(p[p.length - 1]) === key(cur[0])) cur = p.concat(cur.slice(1));
        else if (key(p[0]) === key(cur[0])) cur = p.slice().reverse().concat(cur.slice(1));
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    out.push(cur);
  }
  return out;
}

export function bake() {
  const frame = new LocalFrame(MEIGS.runway.centre[0], MEIGS.runway.centre[1]);
  const toEN = (p) => { const [n, e] = frame.toNE(p.lat, p.lon); return [e, n]; };
  const meigsIsland = MEIGS.island.map(([lat, lon]) => { const [n, e] = frame.toNE(lat, lon); return [e, n]; });
  const onMeigs = ([e, n]) => pointInPolygon(e, n, meigsIsland);
  const { land, shore } = loadAll();

  // ── coastline → land polygons ───────────────────────────────────────────
  const [s0, w0] = frame.toNE(BBOX.south, BBOX.west);
  const [n1, e1] = frame.toNE(BBOX.north, BBOX.east);
  const box = { x0: w0, y0: s0, x1: e1, y1: n1 };
  // Lake Michigan's shore ways have no consistent direction; at Chicago the lake is east of the
  // shore, so a shore line running south → north has the land on its left (coastline convention)
  const coast = chain(shore.filter((e) => e.type === 'way' && e.geometry).map((e) => e.geometry)).map((r) => r.map(toEN))
    .map((c) => {
      const closed = c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
      if (closed) return area2(c) > 0 ? c : c.slice().reverse();      // an island: counter-clockwise
      return c[c.length - 1][1] >= c[0][1] ? c : c.slice().reverse();
    });
  const landPolys = closeCoast(coast, box);

  const polysOf = (pred) => {
    const out = [];
    for (const e of land) {
      if (!pred(e.tags || {})) continue;
      const g = rings(e);
      if (!g) continue;
      for (const r of g.outer) {
        let ring = r.map(toEN);
        if (ring.length < 4) continue;
        ring.pop();
        ring = simplify([...ring, ring[0]], 1.0).slice(0, -1);
        if (ring.length < 3 || Math.abs(area2(ring)) < 50) continue;
        if (area2(ring) < 0) ring.reverse();
        const c = centroid(ring);
        if (onMeigs(c)) continue;
        if (!landPolys.some((lp) => pointInPolygon(c[0], c[1], lp))) continue;   // only on land
        out.push(ring);
      }
    }
    return out;
  };
  const water = polysOf((t) => t.natural === 'water');
  const mask = rasterise(landPolys, water, box);

  const header = {
    attribution: '© OpenStreetMap contributors (ODbL)',
    origin: MEIGS.runway.centre, quantum: QUANTUM, maskCell: MASK_CELL, box,
    styles: [], fetched: new Date().toISOString().slice(0, 10),
  };
  const bin = encodeOsm({ header, buildings: [], land: [], water: [], parks: [], roads: [], rail: [], mask });
  const gz = gzipSync(bin, { level: 9 });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `// Generated by scripts/bake-osm.mjs on ${header.fetched} — do not edit.\n`
    + `// ${header.attribution}. The land/water mask: ${mask.nx} × ${mask.ny} cells of ${MASK_CELL} m.\n`
    + `export const CHICAGO_OSM = '${gz.toString('base64')}';\n`);
  return { land: landPolys.length, rivers: water.length, mask: `${mask.nx} × ${mask.ny}`, raw: bin.length, gz: gz.length };
}

/**
 * Close coastline chains (land on the left) against the box into land polygons.
 * Pieces are clipped to the box; from each exit point we walk the box boundary
 * counter-clockwise to the next entry point.
 */
export function closeCoast(chains, box) {
  const inside = ([x, y]) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  // boundary parameter, counter-clockwise from the south-west corner
  const W = box.x1 - box.x0, H = box.y1 - box.y0;
  const tOf = ([x, y]) => {
    const e = 1e-6;
    if (Math.abs(y - box.y0) < e) return (x - box.x0);
    if (Math.abs(x - box.x1) < e) return W + (y - box.y0);
    if (Math.abs(y - box.y1) < e) return W + H + (box.x1 - x);
    return 2 * W + H + (box.y1 - y);
  };
  const corner = (k) => [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]][k];
  const cross = (a, b) => {
    // intersection of segment a-b with the box edge, a inside, b outside
    let lo = 0, hi = 1;
    for (let i = 0; i < 50; i++) {
      const m = (lo + hi) / 2;
      const p = [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m];
      if (inside(p)) lo = m; else hi = m;
    }
    const p = [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
    // snap to the nearest edge
    const d = [Math.abs(p[1] - box.y0), Math.abs(p[0] - box.x1), Math.abs(p[1] - box.y1), Math.abs(p[0] - box.x0)];
    const k = d.indexOf(Math.min(...d));
    if (k === 0) p[1] = box.y0; else if (k === 1) p[0] = box.x1; else if (k === 2) p[1] = box.y1; else p[0] = box.x0;
    return p;
  };
  const closedPolys = [];
  const pieces = [];
  for (let c of chains) {
    const closed = c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
    if (closed && c.every(inside)) { closedPolys.push(c.slice(0, -1)); continue; }
    if (closed && !c.some(inside)) continue;
    if (closed) {
      // start a ring that crosses the box at a point outside it, so every piece runs edge to edge
      const k = c.findIndex((p) => !inside(p));
      c = [...c.slice(k, -1), ...c.slice(0, k + 1)];
    }
    let cur = null;
    for (let i = 0; i < c.length; i++) {
      const p = c[i];
      if (inside(p)) {
        if (!cur) { cur = i > 0 ? [cross(p, c[i - 1])] : [p]; }
        cur.push(p);
      } else if (cur) {
        cur.push(cross(c[i - 1], p));
        pieces.push(cur); cur = null;
      }
    }
    if (cur) pieces.push(cur);
  }
  const polys = [];
  const used = new Set();
  for (let s = 0; s < pieces.length; s++) {
    if (used.has(s)) continue;
    const poly = [];
    let i = s;
    for (let guard = 0; guard < 200; guard++) {
      used.add(i);
      poly.push(...pieces[i]);
      const tExit = tOf(pieces[i][pieces[i].length - 1]);
      // next entry counter-clockwise from the exit
      let best = -1, bestD = Infinity;
      for (let j = 0; j < pieces.length; j++) {
        const tEntry = tOf(pieces[j][0]);
        const d = (tEntry - tExit + 2 * (W + H)) % (2 * (W + H));
        if (d < bestD) { bestD = d; best = j; }
      }
      // corners passed on the way
      const per = 2 * (W + H);
      const corners = [0, W, W + H, 2 * W + H];
      for (let k = 0; k < 4; k++) {
        const d = (corners[k] - tExit + per) % per;
        if (d > 0 && d < bestD) poly.push({ d, p: corner(k) });
      }
      // sort the pushed corners by distance
      const tail = [];
      while (poly.length && !Array.isArray(poly[poly.length - 1])) tail.unshift(poly.pop());
      tail.sort((a, b) => a.d - b.d).forEach((c) => poly.push(c.p));
      if (best === s || used.has(best)) break;
      i = best;
    }
    polys.push(poly);
  }
  return [...polys, ...closedPolys.filter((p) => area2(p) > 0)];
}

/** Land/water raster: 1 = land, 0 = water (lake or river). */
function rasterise(landPolys, water, box) {
  const nx = Math.ceil((box.x1 - box.x0) / MASK_CELL), ny = Math.ceil((box.y1 - box.y0) / MASK_CELL);
  const m = new Uint8Array(nx * ny);
  const fill = (poly, value) => {
    for (let j = 0; j < ny; j++) {
      const y = box.y0 + (j + 0.5) * MASK_CELL;
      const xs = [];
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xa, ya] = poly[a], [xb, yb] = poly[b];
        if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - box.x0) / MASK_CELL - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - box.x0) / MASK_CELL - 0.5));
        for (let i = i0; i <= i1; i++) m[j * nx + i] = value;
      }
    }
  };
  for (const p of landPolys) fill(p, 1);
  for (const p of water) fill(p, 0);
  return { nx, ny, data: m };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(bake());
}
