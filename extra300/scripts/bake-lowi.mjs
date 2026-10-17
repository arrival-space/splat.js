// bake-lowi.mjs — Innsbruck Airport (LOWI) as the plugin ships it, in src/world/data/lowi.js:
//
//   paved      the runway (and its displaced-threshold stretch), the taxiways and the aprons from
//              OpenStreetMap: where Google's 3D tiles are flattened to the runway's level and the
//              gear rolls on asphalt
//   aerodrome  the airport's boundary: grass, as level as the runway
//   dem        the ground's height round it, from the Terrarium elevation tiles (Mapzen / AWS open
//              data): a 20 km square at 40 m round the field, a 100 km square at 250 m out to the
//              mountains on the horizon; heights in half metres, rows delta-coded, gzipped
//
// Raw downloads are cached in data/lowi/raw/ (not committed).
//
//   node scripts/bake-lowi.mjs [--force]
//
// Data © OpenStreetMap contributors (ODbL 1.0); elevation: Terrarium tiles (Mapzen, AWS Open Data;
// SRTM, EU-DEM and others).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, inflateSync } from 'node:zlib';
import { LocalFrame } from '../src/world/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'lowi', 'raw');
const OUT = join(ROOT, 'src', 'world', 'data', 'lowi.js');
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
const BBOX = { west: 11.325, south: 47.252, east: 11.365, north: 47.266 };
const xml = (await cached('lowi.osm', `https://api.openstreetmap.org/api/0.6/map?bbox=${BBOX.west},${BBOX.south},${BBOX.east},${BBOX.north}`)).toString('utf8');
const nodes = new Map();
for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)) nodes.set(m[1], [+m[2], +m[3]]);
const ways = [];
for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
  const body = m[2];
  const tags = Object.fromEntries([...body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)].map((t) => [t[1], t[2]]));
  if (!tags.aeroway) continue;
  const pts = [...body.matchAll(/<nd ref="(\d+)"\/>/g)].map((r) => nodes.get(r[1])).filter(Boolean);
  ways.push({ id: m[1], tags, pts });
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const ll = (pts) => pts.map(([a, b]) => [r6(a), r6(b)]);
const mainRunway = ways.find((w) => w.tags.aeroway === 'runway' && w.tags.ref === '08/26');
if (!mainRunway) throw new Error('no runway 08/26 in the OSM data');
const paved = [];
for (const w of ways) {
  const a = w.tags.aeroway;
  const asphalt = !w.tags.surface || /asphalt|concrete|paved/.test(w.tags.surface);
  if (a === 'runway' && asphalt) paved.push({ kind: 'runway', width: +(w.tags.width || 45), line: ll(w.pts) });
  else if ((a === 'taxiway' || a === 'taxilane') && asphalt) paved.push({ kind: 'taxiway', width: +(w.tags.width || 18), line: ll(w.pts) });
  else if (a === 'apron') paved.push({ kind: 'apron', area: ll(w.pts) });
}
const aerodrome = ways.find((w) => w.tags.aeroway === 'aerodrome');

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
  return { half, step, n, b64 };
}
console.log('elevation');
const near = await grid(10000, 40, 12);
const far = await grid(50000, 250, 10);

const src = `// lowi.js — generated by scripts/bake-lowi.mjs, do not edit.
// Innsbruck Airport (LOWI): its paved surfaces and boundary from OpenStreetMap (© OpenStreetMap
// contributors, ODbL 1.0), the ground's height round it from the Terrarium elevation tiles (Mapzen,
// AWS Open Data). Heights: half metres, rows delta-coded, Int16, gzip, base64; grids in metres
// north/east of the runway's centre, row 0 the south edge.

export const LOWI_DATA = ${JSON.stringify({
  centre: [r6(centre[0]), r6(centre[1])],
  runway: { ref: mainRunway.tags.ref, width: +(mainRunway.tags.width || 45), ends: ll([ra, rb]) },
  aerodrome: aerodrome ? ll(aerodrome.pts) : null,
  paved,
})};

export const LOWI_DEM = {
  near: { half: ${near.half}, step: ${near.step}, n: ${near.n}, b64: '${near.b64}' },
  far: { half: ${far.half}, step: ${far.step}, n: ${far.n}, b64: '${far.b64}' },
};
`;
writeFileSync(OUT, src);
console.log(`wrote ${OUT}: ${(src.length / 1024).toFixed(0)} KB; runway ${mainRunway.tags.ref}, ${paved.length} paved ways`);
