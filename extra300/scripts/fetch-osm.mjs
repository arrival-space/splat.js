// fetch-osm.mjs — download the OpenStreetMap data the scenery is built from,
// in tiles, from a public Overpass mirror. Raw responses land in
// data/osm/raw/ (not committed); scripts/bake-osm.mjs compacts them into the
// module the plugin ships with.
//
//   node scripts/fetch-osm.mjs            fetch what is missing
//   node scripts/fetch-osm.mjs --force    refetch everything
//   node scripts/fetch-osm.mjs --only land   one tile (land = shore, water, parks, roads)
//
// Data © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'osm', 'raw');

// The scenery box: South Loop / McCormick Place to the Gold Coast, the lake to Halsted
export const BBOX = { south: 41.838, west: -87.660, north: 41.906, east: -87.592 };
const TILES_LAT = 4, TILES_LON = 4;

const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const UA = 'extra300-meigs/0.1 (+https://github.com/arrival-space/splat.js)';

const bb = (b) => `${b.south},${b.west},${b.north},${b.east}`;

const LAYERS = {
  // footprints and parts; parts carry the setbacks of the tall towers
  buildings: (b) => `[out:json][timeout:240];(way["building"](${bb(b)});way["building:part"](${bb(b)});relation["building"](${bb(b)});relation["building:part"](${bb(b)}););out tags geom;`,
  // the lake shore, inland water, green space and the main roads, for the whole box at once
  // ground cover: rivers, harbours, ponds, parks, roads, rail (Lake Michigan itself comes as `shore`)
  land: (b) => `[out:json][timeout:240];(way["natural"="water"](${bb(b)});relation["natural"="water"]["name"!="Lake Michigan"](${bb(b)});way["waterway"="river"](${bb(b)});way["leisure"~"park|garden|pitch|golf_course"](${bb(b)});relation["leisure"="park"](${bb(b)});way["landuse"~"grass|recreation_ground"](${bb(b)});way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](${bb(b)});way["railway"="rail"](${bb(b)}););out geom;`,
  // the lake shore: the member ways of the Lake Michigan multipolygon that cross the box
  // (the relation as a whole is the entire lake), plus any mapped coastline
  shore: (b) => `[out:json][timeout:240];(relation["natural"="water"]["name"="Lake Michigan"];way(r)(${bb(b)});way["natural"="coastline"](${bb(b)}););out geom;`,
  // multipolygon buildings need their members (the tiles above only carry ways' geometry)
  buildingRelations: (b) => `[out:json][timeout:240];(relation["building"](${bb(b)});relation["building:part"](${bb(b)}););out geom;`,
};

async function overpass(query) {
  let last;
  for (const url of MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: `data=${encodeURIComponent(query)}`,
        });
        const text = await res.text();
        // Overpass reports timeouts and memory limits as a 200 with a "remark" and partial data
        const remark = text.slice(-600).match(/"remark":\s*"([^"]*)"/);
        if (res.ok && text.trimStart().startsWith('{') && !(remark && /error|timeout|out of memory/i.test(remark[1]))) return text;
        last = `${url}: HTTP ${res.status} ${text.slice(0, 120)}`;
      } catch (e) {
        last = `${url}: ${e.message}`;
      }
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
  throw new Error(`all Overpass mirrors failed — ${last}`);
}

export function tiles() {
  const out = [];
  const dLat = (BBOX.north - BBOX.south) / TILES_LAT, dLon = (BBOX.east - BBOX.west) / TILES_LON;
  for (let i = 0; i < TILES_LAT; i++) {
    for (let j = 0; j < TILES_LON; j++) {
      out.push({ name: `buildings_${i}_${j}`, layer: 'buildings', box: { south: BBOX.south + i * dLat, north: BBOX.south + (i + 1) * dLat, west: BBOX.west + j * dLon, east: BBOX.west + (j + 1) * dLon } });
    }
  }
  out.push({ name: 'land', layer: 'land', box: BBOX });
  out.push({ name: 'shore', layer: 'shore', box: BBOX });
  out.push({ name: 'buildings_relations', layer: 'buildingRelations', box: BBOX });
  return out;
}

/** Fetch one tile; a tile the mirror chokes on (dense downtown) is split into four, twice at most. */
async function fetchTile(t, force, depth = 0) {
  const file = join(RAW, `${t.name}.json`);
  if (existsSync(file) && !force) return;
  const quads = ['a', 'b', 'c', 'd'];
  const alreadySplit = readdirSync(RAW).some((f) => f.startsWith(t.name) && f !== `${t.name}.json`);
  if (!alreadySplit || force) {
    try {
      const t0 = Date.now();
      const text = await overpass(LAYERS[t.layer](t.box));
      writeFileSync(file, text);
      console.log(`${t.name}: ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      return;
    } catch (e) {
      if (t.layer !== 'buildings' || depth >= 2) throw e;
      console.log(`${t.name}: ${e.message.slice(0, 80)} — splitting`);
    }
  }
  const { south, north, west, east } = t.box;
  const mLat = (south + north) / 2, mLon = (west + east) / 2;
  const sub = [
    { south, north: mLat, west, east: mLon }, { south, north: mLat, west: mLon, east },
    { south: mLat, north, west, east: mLon }, { south: mLat, north, west: mLon, east },
  ];
  for (let i = 0; i < 4; i++) await fetchTile({ name: `${t.name}${quads[i]}`, layer: t.layer, box: sub[i] }, force, depth + 1);
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  const force = process.argv.includes('--force');
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  for (const t of tiles()) if (!only || t.name === only) await fetchTile(t, force);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
