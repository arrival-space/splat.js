// bake-osm.mjs — compact the raw OpenStreetMap download (scripts/fetch-osm.mjs)
// into src/world/data/chicagoOsm.js, the module the plugin ships with.
//
// What happens here, once, so the browser only has to extrude:
//   • building outlines and building:parts are deduplicated across tiles; an
//     outline that has parts is hidden (Simple 3D Buildings rule), so towers
//     like Sears get their real setbacks from the parts
//   • heights: OSM height > City of Chicago stories > OSM building:levels >
//     a default by building type; the City's year_built (joined on
//     chicago:building_id) plus a list of post-2003 towers give each
//     building a year, so the plugin can show the skyline of any year
//   • the Lake Michigan coastline is chained and closed against the box into
//     land polygons, and rasterised into a 4 m land/water mask for the gear
//   • rivers, parks, the main roads and the rail lines come along for the ground
//   • footprints are simplified, quantised to 0.25 m in the Meigs local frame,
//     delta + varint coded, gzipped and base64'd
//
// Data © OpenStreetMap contributors (ODbL 1.0) and the City of Chicago data portal.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

// Towers in the box that rose after Meigs closed (31 March 2003), for those the
// City's footprint data has no year for. Matched case-insensitively on OSM name.
export const POST_2003 = [
  ['trump international', 2009], ['aqua', 2009], ['st. regis', 2020], ['st regis', 2020], ['vista tower', 2020],
  ['legacy at millennium park', 2010], ['one museum park', 2009], ['the heritage at millennium park', 2005],
  ['blue cross blue shield', 2010], ['300 north lasalle', 2009], ['150 north riverside', 2017], ['river point', 2017],
  ['110 north wacker', 2020], ['bmo tower', 2022], ['salesforce tower', 2023], ['nema', 2019], ['wolf point', 2016],
  ['coast at lakeshore east', 2013], ['optima chicago center', 2017], ['oneeleven', 2014], ['waldorf astoria', 2010],
  ['353 north clark', 2009], ['hyatt center', 2005], ['111 south wacker', 2005], ['71 south wacker', 2005],
  ['155 north wacker', 2009], ['joffrey tower', 2008], ['the regatta', 2010], ['the tides', 2008], ['the shoreham', 2005],
  ['the lancaster', 2007], ['cirrus', 2022], ['helix', 2022], ['1000m', 2023], ['one bennett park', 2019],
  ['no. 9 walton', 2017], ['one chicago', 2022], ['44 west walton', 2018], ['the paramount', 2009],
  ['huntington bank pavilion', 2005], ['firstmerit bank pavilion', 2005], ['spertus', 2007], ['roosevelt collection', 2010],
  ['museum park', 2008], ['soldier field', 0],
];

const num = (s) => {
  if (s == null) return NaN;
  const m = String(s).replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return NaN;
  let v = parseFloat(m[0]);
  if (/ft|'/.test(s)) v *= 0.3048;
  return v;
};

const ROOF = { flat: 0, gabled: 1, hipped: 2, pyramidal: 3, dome: 4, skillion: 5 };
export const STYLES = ['brick', 'stone', 'glass', 'dark', 'white', 'plain', 'house'];

function styleFor(t, h, id) {
  const mat = (t['building:material'] || t['building:facade:material'] || '').toLowerCase();
  const col = (t['building:colour'] || '').toLowerCase();
  const kind = t.building || t['building:part'] || 'yes';
  if (/glass/.test(mat)) return 'glass';
  if (/black|#0|#1|#2|dark/.test(col)) return 'dark';
  if (/white|#f|#e/.test(col) || /marble/.test(mat)) return 'white';
  if (/brick/.test(mat)) return 'brick';
  if (/stone|limestone|granite|concrete/.test(mat)) return 'stone';
  if (/^(house|detached|semidetached_house|terrace|garage|garages|shed)$/.test(kind) && h < 14) return 'house';
  if (/^(industrial|warehouse|parking|garage|service|roof|train_station|transportation|hangar)$/.test(kind)) return 'plain';
  const r = hash(id);
  if (h > 90) return r < 0.45 ? 'glass' : r < 0.75 ? 'stone' : r < 0.88 ? 'dark' : 'white';
  if (h > 35) return r < 0.3 ? 'glass' : r < 0.75 ? 'stone' : 'brick';
  return r < 0.65 ? 'brick' : 'stone';
}

function hash(n) {
  let x = (Number(String(n).replace(/\D/g, '').slice(-9)) || 1) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  return (x % 10000) / 10000;
}

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
  const elements = new Map();
  for (const f of readdirSync(RAW).filter((f) => f.startsWith('buildings_'))) {
    for (const e of JSON.parse(readFileSync(join(RAW, f), 'utf8')).elements) elements.set(`${e.type}/${e.id}`, e);
  }
  const land = JSON.parse(readFileSync(join(RAW, 'land.json'), 'utf8')).elements;
  const shore = JSON.parse(readFileSync(join(RAW, 'shore.json'), 'utf8')).elements;
  const city = existsSync(join(RAW, 'chicago_bldgs.json')) ? JSON.parse(readFileSync(join(RAW, 'chicago_bldgs.json'), 'utf8')) : [];
  return { elements: [...elements.values()], land, shore, city };
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
  const { elements, land, shore, city } = loadAll();
  const cityById = new Map(city.map((c) => [c.bldg_id, c]));

  // ── buildings ────────────────────────────────────────────────────────────
  const shapes = [];
  const stats = { elements: elements.length, noGeom: 0, tooSmall: 0, onMeigs: 0, demolished: 0 };
  for (const e of elements) {
    const t = e.tags || {};
    const g = rings(e);
    if (!g || !g.outer.length) { stats.noGeom++; continue; }
    const isPart = !!t['building:part'] && !t.building;
    if (t.building === 'no' || t['building:part'] === 'no') continue;
    const c = cityById.get(t['chicago:building_id']);
    let year = 0;
    const sd = num(t.start_date);
    if (Number.isFinite(sd) && sd > 1700) year = Math.round(sd);
    const cy = c ? parseInt(c.year_built, 10) : 0;
    if (!year && cy > 1700) year = cy;
    const name = (t.name || '').toLowerCase();
    if (name) for (const [k, y] of POST_2003) if (name.includes(k) && y) { year = Math.max(year, y); break; }
    if (c && (c.demolished === 'true' || /DEMOLISH/i.test(c.bldg_statu || ''))) continue;

    const levels = num(t['building:levels']);
    const roofLevels = num(t['roof:levels']) || 0;
    const cityStories = c ? Math.max(num(c.stories) || 0, num(c.no_stories) || 0) : 0;
    let h = num(t.height);
    const floorH = (lv) => (lv > 12 ? 3.9 : 3.4);
    if (!(h > 0) && levels > 0) h = (levels + roofLevels) * floorH(levels);
    if (!(h > 0) && cityStories > 0) h = cityStories * floorH(cityStories);
    const kind = t.building || t['building:part'];
    if (!(h > 0)) h = /^(garage|garages|shed|roof|carport)$/.test(kind) ? 3 : /house|detached|terrace/.test(kind) ? 8 : 9;
    let minH = num(t.min_height);
    if (!(minH >= 0)) minH = (num(t['building:min_level']) || 0) * floorH(levels || 1);
    if (!(minH >= 0) || minH >= h) minH = 0;

    for (let oi = 0; oi < g.outer.length; oi++) {
      let outer = g.outer[oi].map(toEN);
      if (outer.length > 2 && outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1]) outer.pop();
      outer = simplify([...outer, outer[0]], 0.35).slice(0, -1);
      if (outer.length < 3) continue;
      if (area2(outer) < 0) outer.reverse();                       // outer CCW in (e, n)
      if (area2(outer) < 6) { stats.tooSmall++; continue; }          // sheds smaller than 6 m²
      const holes = oi === 0 ? g.inner.map((r) => {
        let h2 = r.map(toEN);
        if (h2.length > 2 && h2[0][0] === h2[h2.length - 1][0]) h2.pop();
        h2 = simplify([...h2, h2[0]], 0.35).slice(0, -1);
        if (area2(h2) > 0) h2.reverse();                            // holes CW
        return h2;
      }).filter((r) => r.length >= 3) : [];
      const cen = centroid(outer);
      if (onMeigs(cen)) { stats.onMeigs++; continue; }               // Meigs gets its own buildings
      shapes.push({
        id: `${e.type}/${e.id}`, isPart, outer, holes, cen, h, minH, year,
        style: styleFor(t, h, e.id),
        roof: ROOF[t['roof:shape']] ?? 0,
        colour: t['building:colour'] || '',
        name: t.name || '',
      });
    }
  }
  // Simple 3D Buildings: an outline with parts inside is drawn by its parts
  const parts = shapes.filter((s) => s.isPart);
  const grid = new Map();
  const cell = 200;
  for (const p of parts) {
    const k = `${Math.floor(p.cen[0] / cell)},${Math.floor(p.cen[1] / cell)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  const buildings = shapes.filter((s) => {
    if (s.isPart) return true;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const [x, y] of s.outer) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
    for (let gx = Math.floor(minx / cell); gx <= Math.floor(maxx / cell); gx++) {
      for (let gy = Math.floor(miny / cell); gy <= Math.floor(maxy / cell); gy++) {
        for (const p of grid.get(`${gx},${gy}`) || []) if (pointInPolygon(p.cen[0], p.cen[1], s.outer)) {
          if (!p.year && s.year) p.year = s.year;
          return false;
        }
      }
    }
    return true;
  });
  // spatial order makes the deltas small
  buildings.sort((a, b) => (Math.floor(a.cen[1] / 250) - Math.floor(b.cen[1] / 250)) || (a.cen[0] - b.cen[0]));

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
  const parks = polysOf((t) => /park|garden|pitch|golf_course/.test(t.leisure || '') || /grass|recreation_ground/.test(t.landuse || ''));
  const lines = (pred, widthOf) => {
    const out = [];
    for (const e of land) {
      if (e.type !== 'way' || !e.geometry || !pred(e.tags || {})) continue;
      const pts = simplify(e.geometry.map(toEN), 0.8);
      if (pts.length < 2) continue;
      if (onMeigs(pts[0]) && onMeigs(pts[pts.length - 1])) continue;
      out.push({ pts, w: widthOf(e.tags) });
    }
    return out;
  };
  const ROADW = { motorway: 22, trunk: 20, primary: 16, secondary: 13, tertiary: 10 };
  const roads = lines((t) => ROADW[t.highway] && t.tunnel !== 'yes' && t.layer !== '-1', (t) => ROADW[t.highway]);
  const rail = lines((t) => t.railway === 'rail' && t.tunnel !== 'yes', () => 4);
  const mask = rasterise(landPolys, water, box);

  const header = {
    attribution: '© OpenStreetMap contributors (ODbL), City of Chicago data portal',
    origin: MEIGS.runway.centre, quantum: QUANTUM, maskCell: MASK_CELL, box,
    styles: STYLES, fetched: new Date().toISOString().slice(0, 10),
  };
  const bin = encodeOsm({ header, buildings, land: landPolys, water, parks, roads, rail, mask });
  const gz = gzipSync(bin, { level: 9 });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `// Generated by scripts/bake-osm.mjs on ${header.fetched} — do not edit.\n`
    + `// ${header.attribution}. ${buildings.length} buildings, ${landPolys.length} land polygons, ${roads.length} roads.\n`
    + `export const CHICAGO_OSM = '${gz.toString('base64')}';\n`);
  return { stats, shapes: shapes.length, buildings: buildings.length, parts: parts.length, land: landPolys.length, water: water.length, parks: parks.length, roads: roads.length, rail: rail.length, raw: bin.length, gz: gz.length,
    tallest: buildings.slice().sort((a, b) => b.h - a.h).slice(0, 12).map((b) => `${b.name || b.id} ${b.h.toFixed(0)}m ${b.year || '?'}`) };
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
