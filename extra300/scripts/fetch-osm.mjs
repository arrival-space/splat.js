// fetch-osm.mjs — download the OpenStreetMap data the land/water mask round Meigs is made from
// (the lake shore, the rivers and harbours), from a public Overpass mirror. Raw responses land in
// data/osm/raw/ (not committed); scripts/bake-osm.mjs compacts them into the
// module the plugin ships with.
//
//   node scripts/fetch-osm.mjs            fetch what is missing
//   node scripts/fetch-osm.mjs --force    refetch everything
//   node scripts/fetch-osm.mjs --only land   one layer (land: inland water; shore: the lake's)
//
// Data © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'osm', 'raw');

// The box: South Loop / McCormick Place to the Gold Coast, the lake to Halsted
export const BBOX = { south: 41.838, west: -87.660, north: 41.906, east: -87.592 };

const MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const UA = 'extra300-meigs/0.1 (+https://github.com/arrival-space/splat.js)';

const bb = (b) => `${b.south},${b.west},${b.north},${b.east}`;

const LAYERS = {
  // inland water: rivers, harbours, ponds (Lake Michigan itself comes as `shore`)
  land: (b) => `[out:json][timeout:240];(way["natural"="water"](${bb(b)});relation["natural"="water"]["name"!="Lake Michigan"](${bb(b)}););out geom;`,
  // the lake shore: the member ways of the Lake Michigan multipolygon that cross the box
  // (the relation as a whole is the entire lake), plus any mapped coastline
  shore: (b) => `[out:json][timeout:240];(relation["natural"="water"]["name"="Lake Michigan"];way(r)(${bb(b)});way["natural"="coastline"](${bb(b)}););out geom;`,
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
  return [{ name: 'land', layer: 'land', box: BBOX }, { name: 'shore', layer: 'shore', box: BBOX }];
}

/** Fetch one tile; a tile the mirror chokes on is split into four, twice at most. */
async function fetchTile(t, force, depth = 0) {
  const file = join(RAW, `${t.name}.json`);
  if (existsSync(file) && !force) return;
  const quads = ['a', 'b', 'c', 'd'];
  const alreadySplit = readdirSync(RAW).some((f) => new RegExp(`^${t.name}[a-d]+\\.json$`).test(f));
  if (!alreadySplit || force) {
    try {
      const t0 = Date.now();
      const text = await overpass(LAYERS[t.layer](t.box));
      writeFileSync(file, text);
      console.log(`${t.name}: ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      return;
    } catch (e) {
      if (depth >= 2) throw e;
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
