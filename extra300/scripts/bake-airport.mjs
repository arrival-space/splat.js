// bake-airport.mjs — an airport destination as the plugin ships it, in src/world/data/<id>.js:
//
//   paved      the runway (and its displaced-threshold stretch), the taxiways and the aprons from
//              OpenStreetMap: where Google's 3D tiles are flattened to the runway's level and the
//              gear rolls on asphalt
//   aerodrome  the airport's boundary: grass, as level as the runway
//   tower      the control tower, where OpenStreetMap has it
//   water      (where there is some) the lakes and rivers round it from OpenStreetMap: a raster
//              near the field and the shores out to the horizon, for Google's tiles to shade as
//              water (plugin/waterMask.js)
//   dem        the ground's height round it, from the Terrarium elevation tiles (Mapzen / AWS open
//              data): a 20 km square at 40 m round the field and a wide one out to the mountains on
//              the horizon; heights in half metres, rows delta-coded, gzipped
//
// Raw downloads are cached in data/<id>/raw/ (not committed).
//
//   node scripts/bake-airport.mjs lowi|krnt [--force]
//
// Data © OpenStreetMap contributors (ODbL 1.0); elevation: Terrarium tiles (Mapzen, AWS Open Data;
// SRTM, EU-DEM, USGS 3DEP and others).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import { LocalFrame } from '../src/world/geo.js';

// what to bake for each airport: the OSM box, the runway's ref, its default width, the DEM grids
// (half-size, step, zoom), the water bodies to fetch whole (OSM relations)
const AIRPORTS = {
  lowi: {
    name: 'Innsbruck Airport (LOWI)', prefix: 'LOWI',
    bbox: { west: 11.325, south: 47.252, east: 11.365, north: 47.266 }, runway: '08/26', width: 45,
    near: [10000, 40, 12], far: [50000, 250, 10],
  },
  krnt: {
    name: 'Renton Municipal Airport (KRNT)', prefix: 'KRNT',
    bbox: { west: -122.232, south: 47.479, east: -122.203, north: 47.505 }, runway: '16/34', width: 61,
    // out to Mount Rainier, 80 km south-east
    near: [10000, 40, 12], far: [90000, 450, 9],
    // Lake Washington, whole; the rivers and ponds in the airport's box come with its map call
    lakes: [2793848],
    water: { half: 6000, cell: 6 },
  },
};
const ID = process.argv.slice(2).find((a) => !a.startsWith('-'));
const A = AIRPORTS[ID];
if (!A) throw new Error(`usage: node scripts/bake-airport.mjs ${Object.keys(AIRPORTS).join('|')} [--force]`);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', ID, 'raw');
const OUT = join(ROOT, 'src', 'world', 'data', `${ID}.js`);
const FORCE = process.argv.includes('--force');
const UA = 'extra300-meigs/0.1 (+https://github.com/arrival-space/splat.js)';
mkdirSync(RAW, { recursive: true });

async function cached(name, url) {
  const path = join(RAW, name);
  if (!FORCE && existsSync(path)) return readFileSync(path);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
      return buf;
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

// ── OpenStreetMap: the airport's ways ───────────────────────────────────────
const BBOX = A.bbox;
const xml = (await cached(`${ID}.osm`, `https://api.openstreetmap.org/api/0.6/map?bbox=${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`)).toString('utf8');
const nodes = new Map();
for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)) nodes.set(m[1], [+m[2], +m[3]]);
const ways = [], allWays = new Map();
const tagsOf = (body) => Object.fromEntries([...body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)].map((t) => [t[1], t[2]]));
for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
  const body = m[2];
  const tags = tagsOf(body);
  const pts = [...body.matchAll(/<nd ref="(\d+)"\/>/g)].map((r) => nodes.get(r[1])).filter(Boolean);
  allWays.set(m[1], { id: m[1], tags, pts });
  if (tags.aeroway) ways.push({ id: m[1], tags, pts });
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const ll = (pts) => pts.map(([a, b]) => [r6(a), r6(b)]);
const mainRunway = ways.find((w) => w.tags.aeroway === 'runway' && w.tags.ref === A.runway);
if (!mainRunway) throw new Error(`no runway ${A.runway} in the OSM data`);
const paved = [];
for (const w of ways) {
  const a = w.tags.aeroway;
  const asphalt = !w.tags.surface || /asphalt|concrete|paved/.test(w.tags.surface);
  if (a === 'runway' && asphalt) paved.push({ kind: 'runway', width: +(w.tags.width || A.width), line: ll(w.pts) });
  else if ((a === 'taxiway' || a === 'taxilane') && asphalt) paved.push({ kind: 'taxiway', width: +(w.tags.width || 18), line: ll(w.pts) });
  else if (a === 'apron') paved.push({ kind: 'apron', area: ll(w.pts) });
}
const aerodrome = ways.find((w) => w.tags.aeroway === 'aerodrome');
const towerWay = [...allWays.values()].find((w) => w.tags.man_made === 'tower' && /aircraft_control/.test(w.tags.service || '') || w.tags.aeroway === 'control_tower');
const tower = towerWay ? towerWay.pts.reduce((s, p) => [s[0] + p[0] / towerWay.pts.length, s[1] + p[1] / towerWay.pts.length], [0, 0]) : null;

// ── elevation: Terrarium tiles ──────────────────────────────────────────────
/** A minimal PNG decoder: 8-bit RGB or RGBA, not interlaced (what the Terrarium tiles are). */
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ch = 3;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG');
      ch = { 2: 3, 6: 4 }[data[9]];
      if (!ch) throw new Error(`unsupported PNG colour type ${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= ch && y ? out[(y - 1) * stride + x - ch] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

const tiles = new Map();
async function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  // the promise is kept: a row asks for the same tile hundreds of times at once
  if (!tiles.has(key)) tiles.set(key, cached(`terrarium-${z}-${x}-${y}.png`, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`).then(decodePng));
  return tiles.get(key);
}
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * 256; };
/** Height (m) at a global pixel position, bilinear. */
async function heightAt(px, py, z) {
  const sample = async (X, Y) => {
    const t = await tile(z, Math.floor(X / 256), Math.floor(Y / 256));
    const i = ((Y % 256) * 256 + (X % 256)) * t.ch;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  };
  const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5), fx = px - 0.5 - x0, fy = py - 0.5 - y0;
  const [a, b, c, d] = await Promise.all([sample(x0, y0), sample(x0 + 1, y0), sample(x0, y0 + 1), sample(x0 + 1, y0 + 1)]);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// the runway's centre is the local frame's origin
const [ra, rb] = [mainRunway.pts[0], mainRunway.pts[mainRunway.pts.length - 1]];
const centre = [(ra[0] + rb[0]) / 2, (ra[1] + rb[1]) / 2];
const frame = new LocalFrame(centre[0], centre[1]);

async function grid(half, step, z) {
  const n = Math.round((2 * half) / step) + 1;
  const h = new Int16Array(n * n);
  for (let j = 0; j < n; j++) {
    const row = [];
    for (let i = 0; i < n; i++) {
      const [lat, lon] = frame.toLatLon(-half + j * step, -half + i * step);
      row.push(heightAt(lon2x(lon, z), lat2y(lat, z), z));
    }
    const hs = await Promise.all(row);
    for (let i = 0; i < n; i++) h[j * n + i] = Math.round(hs[i] * 2);
    if (j % 50 === 0) process.stdout.write(`  z${z} row ${j}/${n}\r`);
  }
  // rows delta-coded: neighbouring heights differ little, and gzip likes small numbers
  const d = new Int16Array(h.length);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) d[j * n + i] = h[j * n + i] - (i ? h[j * n + i - 1] : j ? h[(j - 1) * n] : 0);
  const b64 = gzipSync(Buffer.from(d.buffer), { level: 9 }).toString('base64');
  console.log(`  ${n}×${n} at ${step} m (z${z}): ${(b64.length / 1024).toFixed(0)} KB`);
  return { half, step, n, b64, h };
}
// ── water: lakes and rivers ──────────────────────────────────────────────────
/** Closed rings from ways that may each be only a part of one (a multipolygon's members). */
function rings(parts) {
  const open = parts.map((p) => p.slice()).filter((p) => p.length > 1), out = [];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  while (open.length) {
    let r = open.pop();
    for (let joined = true; joined && !same(r[0], r[r.length - 1]);) {
      joined = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i], end = r[r.length - 1];
        if (same(p[0], end)) r = r.concat(p.slice(1));
        else if (same(p[p.length - 1], end)) r = r.concat(p.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1); joined = true; break;
      }
    }
    if (same(r[0], r[r.length - 1]) && r.length > 3) out.push(r);
  }
  return out;
}
const isWater = (t) => t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir';
let water = null;
if (A.water) {
  console.log('water');
  const outer = [], inner = [];
  // the big lakes, whole, from their relations
  for (const id of A.lakes || []) {
    const rx = (await cached(`relation-${id}.osm`, `https://api.openstreetmap.org/api/0.6/relation/${id}/full`)).toString('utf8');
    const rn = new Map();
    for (const m of rx.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)) rn.set(m[1], [+m[2], +m[3]]);
    const rw = new Map();
    for (const m of rx.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) rw.set(m[1], [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map((r) => rn.get(r[1])).filter(Boolean));
    const rel = rx.match(new RegExp(`<relation id="${id}"[^>]*>([\\s\\S]*?)<\\/relation>`))[1];
    for (const m of rel.matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"\/>/g)) (m[2] === 'inner' ? inner : outer).push(rw.get(m[1]) || []);
  }
  // and whatever water the airport's own box has: rivers, ponds (closed ways and multipolygons)
  for (const w of allWays.values()) if (isWater(w.tags) && w.pts.length > 3) outer.push(w.pts);
  for (const m of xml.matchAll(/<relation id="(\d+)"[^>]*>([\s\S]*?)<\/relation>/g)) {
    const t = tagsOf(m[2]);
    if (!isWater(t) || (A.lakes || []).includes(+m[1])) continue;
    for (const mm of m[2].matchAll(/<member type="way" ref="(\d+)" role="([^"]*)"\/>/g)) (mm[2] === 'inner' ? inner : outer).push(allWays.get(mm[1])?.pts || []);
  }
  const toNEr = (r) => r.map(([la, lo]) => frame.toNE(la, lo));
  const W = rings(outer).map(toNEr), I = rings(inner).map(toNEr);
  // the raster near the field: 1 = land, as the Chicago one (world/osmCodec.js); row 0 the south edge
  const { half, cell } = A.water, n = Math.round((2 * half) / cell);
  const land = new Uint8Array(n * n).fill(1);
  const fill = (ring, v) => {
    for (let j = 0; j < n; j++) {
      const y = -half + (j + 0.5) * cell, xs = [];
      for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
        const [an, ae] = ring[k], [bn, be] = ring[l];
        if ((an > y) !== (bn > y)) xs.push(ae + ((y - an) / (bn - an)) * (be - ae));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] + half) / cell - 0.5)), i1 = Math.min(n - 1, Math.floor((xs[k + 1] + half) / cell - 0.5));
        for (let i = i0; i <= i1; i++) land[j * n + i] = v;
      }
    }
  };
  for (const r of W) fill(r, 0);
  for (const r of I) fill(r, 1);
  // the shores out to the horizon: the rings, thinned to ~25 m
  const thin = (r, tol = 25) => {
    const keep = (a, b) => {
      let worst = -1, at = -1;
      const [an, ae] = r[a], [bn, be] = r[b], L = Math.hypot(bn - an, be - ae) || 1;
      for (let k = a + 1; k < b; k++) {
        const d = Math.abs((bn - an) * (ae - r[k][1]) - (an - r[k][0]) * (be - ae)) / L;
        if (d > worst) { worst = d; at = k; }
      }
      return worst > tol ? [...keep(a, at), ...keep(at, b).slice(1)] : [r[a], r[b]];
    };
    // a closed ring: split at the point farthest from its start, each half simplified on its own
    let far = 1;
    for (let k = 1; k < r.length; k++) if (Math.hypot(r[k][0] - r[0][0], r[k][1] - r[0][1]) > Math.hypot(r[far][0] - r[0][0], r[far][1] - r[0][1])) far = k;
    return [...keep(0, far), ...keep(far, r.length - 1).slice(1)].map(([a, b]) => [Math.round(a), Math.round(b)]);
  };
  const shores = W.filter((r) => r.length > 8).map((r) => thin(r));
  const lakesInner = I.filter((r) => r.length > 8).map((r) => thin(r));
  water = {
    level: null,    // the surface's height: from the elevation grid where the lake is (below)
    mask: { half, cell, n, b64: gzipSync(Buffer.from(land), { level: 9 }).toString('base64') },
    shores, islands: lakesInner,
  };
  console.log(`  ${W.length} water rings, ${I.length} islands; raster ${n}×${n} at ${cell} m: ${(water.mask.b64.length / 1024).toFixed(0)} KB; shores ${(JSON.stringify(shores).length / 1024).toFixed(0)} KB`);
}

console.log('elevation');
const near = await grid(...A.near);
const far = await grid(...A.far);
if (water) {
  // the lake's level: the elevation tiles' most common height over the water near the field
  const counts = new Map(), { n, half, cell } = water.mask, land = new Uint8Array(gunzipSync(Buffer.from(water.mask.b64, "base64")));
  const nh = new Int16Array(near.h.length); for (let k = 0; k < nh.length; k++) nh[k] = near.h[k];
  for (let j = 0; j < near.n; j += 2) for (let i = 0; i < near.n; i += 2) {
    const N = -near.half + j * near.step, E = -near.half + i * near.step;
    const jj = Math.floor((N + half) / cell), ii = Math.floor((E + half) / cell);
    if (jj < 0 || ii < 0 || jj >= n || ii >= n || land[jj * n + ii]) continue;
    const v = nh[j * near.n + i];
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  water.level = mode ? mode[0] / 2 : 0;
  console.log(`  water level ${water.level} m (elevation tiles over the water)`);
}

const src = `// ${ID}.js — generated by scripts/bake-airport.mjs, do not edit.
// ${A.name}: its paved surfaces and boundary${water ? ', its water' : ''} from OpenStreetMap (© OpenStreetMap
// contributors, ODbL 1.0), the ground's height round it from the Terrarium elevation tiles (Mapzen,
// AWS Open Data). Heights: half metres, rows delta-coded, Int16, gzip, base64; grids in metres
// north/east of the runway's centre, row 0 the south edge.${water ? `
// Water: a land raster (1 = land, 0 = water; gzip, base64; row 0 the south edge) round the field,
// the shores beyond it as rings in metres north/east, the surface's height above sea level.` : ''}

export const ${A.prefix}_DATA = ${JSON.stringify({
  centre: [r6(centre[0]), r6(centre[1])],
  runway: { ref: mainRunway.tags.ref, width: +(mainRunway.tags.width || A.width), ends: ll([ra, rb]) },
  aerodrome: aerodrome ? ll(aerodrome.pts) : null,
  ...(tower ? { tower: [r6(tower[0]), r6(tower[1])] } : {}),
  paved,
  ...(water ? { water } : {}),
})};

export const ${A.prefix}_DEM = {
  near: { half: ${near.half}, step: ${near.step}, n: ${near.n}, b64: '${near.b64}' },
  far: { half: ${far.half}, step: ${far.step}, n: ${far.n}, b64: '${far.b64}' },
};
`;
writeFileSync(OUT, src);
console.log(`wrote ${OUT}: ${(src.length / 1024).toFixed(0)} KB; runway ${mainRunway.tags.ref}, ${paved.length} paved ways`);
