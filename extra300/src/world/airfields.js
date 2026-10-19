// airfields.js — any airfield on Earth, found by name: the world's airfields from OurAirports (public
// domain, davidmegginson.github.io/ourairports-data; fetched on the first search, ~5 MB gzipped),
// searched by code, name and town, a place that isn't an airfield (a village, a mountain) found with
// OpenStreetMap's Nominatim and its nearest airfield taken. A picked airfield becomes an airport the
// flight vibe can fly from (airfieldWorld): its longest runway laid out from the runway's own ends,
// Google's tiles flattened along it (world/airport.js), the terrain from the Terrarium elevation tiles
// (world/terrarium.js), its height above the ellipsoid from the EGM96 geoid (data/geoid.js).

import { buildAirport } from './airport.js';
import { LocalFrame } from './geo.js';
import { terrariumDem } from './terrarium.js';
import { GEOID } from './data/geoid.js';

const FT = 0.3048;
const SOURCE = 'https://davidmegginson.github.io/ourairports-data/';
export const AIRFIELD_CREDIT = 'Airfields: OurAirports (public domain) · Elevation: Terrarium (Mapzen, AWS Open Data) · Places: © OpenStreetMap contributors';

// what counts as an airfield to fly from: a land airport with a runway at least this long (ft), open
const TYPES = new Set(['small_airport', 'medium_airport', 'large_airport']);
const MIN_FT = 1000;
const PAVED = /ASP|CON|PEM|BIT|TAR|PAV|PSP|MAC|SEAL|ASF|BRI|CEM/i;

/** A CSV text's rows (quoted fields, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += ch;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const table = (text) => {
  const [head, ...rows] = parseCsv(text);
  return rows.filter((r) => r.length >= head.length - 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
};

/** Lower case, accents off, punctuation to spaces: how names are compared. */
export const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The airfields from OurAirports' two tables (airports.csv, runways.csv): land airports with an open
 * runway of MIN_FT or more, their runways longest first.
 * @returns {object[]} { ident, codes, name, town, country, lat, lon, elevFt, type, runways: [{ le, he, lengthM, widthM, paved, ends?, heading?, elevFt? }], words }
 */
export function airfieldsFrom(airportsCsv, runwaysCsv) {
  const runways = new Map();
  for (const r of table(runwaysCsv)) {
    const lengthFt = Number(r.length_ft);
    if (r.closed === '1' || !(lengthFt >= MIN_FT) || !r.le_ident || !r.he_ident) continue;
    const ends = ['le_latitude_deg', 'le_longitude_deg', 'he_latitude_deg', 'he_longitude_deg'].map((k) => Number(r[k]));
    const elev = [r.le_elevation_ft, r.he_elevation_ft].filter((v) => v !== '' && Number.isFinite(Number(v))).map(Number);
    const list = runways.get(r.airport_ref) || [];
    list.push({
      le: r.le_ident, he: r.he_ident, lengthM: lengthFt * FT, widthM: Math.max(10, (Number(r.width_ft) || 60) * FT), paved: PAVED.test(r.surface),
      ends: r.le_latitude_deg && r.he_latitude_deg && ends.every(Number.isFinite) ? [[ends[0], ends[1]], [ends[2], ends[3]]] : null,
      heading: r.le_heading_degT !== '' && Number.isFinite(Number(r.le_heading_degT)) ? Number(r.le_heading_degT) : null,
      elevFt: elev.length ? elev.reduce((a, b) => a + b, 0) / elev.length : null,
    });
    runways.set(r.airport_ref, list);
  }
  const out = [];
  for (const a of table(airportsCsv)) {
    if (!TYPES.has(a.type)) continue;
    const rws = runways.get(a.id);
    if (!rws) continue;
    rws.sort((p, q) => (q.paved - p.paved) || (q.lengthM - p.lengthM));
    const codes = [a.ident, a.icao_code, a.iata_code, a.gps_code, a.local_code].filter(Boolean).map((c) => c.toLowerCase());
    out.push({
      ident: a.icao_code || a.ident, codes: [...new Set(codes)], name: a.name, town: a.municipality, country: a.iso_country,
      lat: Number(a.latitude_deg), lon: Number(a.longitude_deg), elevFt: Number(a.elevation_ft) || 0, type: a.type, runways: rws,
      words: fold(`${a.name} ${a.municipality} ${a.keywords || ''}`).split(' '),
    });
  }
  return out;
}

let loading = null;
/** The world's airfields, fetched and read once (on the first search). */
export function loadAirfields(fetchText = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.text(); })) {
  loading ??= Promise.all([fetchText(`${SOURCE}airports.csv`), fetchText(`${SOURCE}runways.csv`)])
    .then(([a, r]) => airfieldsFrom(a, r))
    .catch((e) => { loading = null; throw e; });
  return loading;
}

const SIZE = { large_airport: 30, medium_airport: 20, small_airport: 0 };
/** How good a field is to fly from, other things equal: its size, its longest paved runway. */
const worth = (a) => SIZE[a.type] + (a.runways[0].paved ? 10 : 0) + Math.min(15, a.runways[0].lengthM / 200);

/**
 * Airfields matching a query: an exact code (LOWG, GRZ) first, then those whose name, town or keywords
 * have every word of it (word starts), the bigger fields first.
 */
export function searchAirfields(fields, query, limit = 8) {
  const q = fold(query);
  if (!q) return [];
  const words = q.split(' ');
  const hits = [];
  for (const a of fields) {
    let score = 0;
    if (a.codes.includes(q)) score = 1000;
    else if (words.every((w) => a.words.some((x) => x.startsWith(w)))) {
      score = 100 + (words.every((w) => a.words.includes(w)) ? 20 : 0) + (fold(a.town) === q ? 25 : 0);
    }
    if (score) hits.push([score + worth(a), a]);
  }
  return hits.sort((p, q2) => q2[0] - p[0]).slice(0, limit).map(([, a]) => a);
}

/** Great-circle distance (m). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

/** The airfields nearest a point (paved runways weigh as if a third closer), with their distance. */
export function nearestAirfields(fields, lat, lon, limit = 5) {
  return fields
    .map((a) => ({ a, d: distanceM(lat, lon, a.lat, a.lon) }))
    .filter((x) => x.d < 300000)
    .sort((p, q) => p.d * (p.a.runways[0].paved ? 0.67 : 1) - q.d * (q.a.runways[0].paved ? 0.67 : 1))
    .slice(0, limit)
    .map(({ a, d }) => ({ ...a, distanceM: d }));
}

/** A place's position from OpenStreetMap's Nominatim (a village, a mountain, an address), or null. */
export async function geocode(query, fetchJson = (u) => fetch(u).then((r) => r.json())) {
  const res = await fetchJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`);
  const p = Array.isArray(res) ? res[0] : null;
  return p ? { lat: Number(p.lat), lon: Number(p.lon), name: p.display_name } : null;
}

let geoid = null;
async function geoidGrid() {
  if (geoid) return geoid;
  const bin = typeof atob === 'function' ? Uint8Array.from(atob(GEOID.b64), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(GEOID.b64, 'base64'));
  const buf = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  geoid = new Int8Array(buf);
  return geoid;
}

/** The geoid's height above the ellipsoid (m) at a point: EGM96, 1° grid, bilinear. */
export async function geoidAt(lat, lon) {
  const g = await geoidGrid(), W = GEOID.w;
  const x = ((((lon + 180) % 360) + 360) % 360), y = Math.max(0, Math.min(179.999, lat + 90));
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const v = (jj, ii) => g[jj * W + Math.min(360, ii)];
  return (v(j, i) * (1 - fx) + v(j, i + 1) * fx) * (1 - fy) + (v(j + 1, i) * (1 - fx) + v(j + 1, i + 1) * fx) * fy;
}

/**
 * An airfield as world/airport.js wants it: the description and its "OpenStreetMap" data, made from
 * its longest runway (its ends where OurAirports has them, else from the field's position, the
 * runway's heading and its length). No drawn markings: Google's photo of the runway, flattened.
 */
export async function airfieldDescriptor(a) {
  const rw = a.runways[0];
  let ends = rw.ends;
  if (!ends) {
    const f = new LocalFrame(a.lat, a.lon);
    const hdg = ((rw.heading ?? (parseInt(rw.le, 10) * 10 || 0)) * Math.PI) / 180;
    const h = rw.lengthM / 2;
    ends = [f.toLatLon(-Math.cos(hdg) * h, -Math.sin(hdg) * h), f.toLatLon(Math.cos(hdg) * h, Math.sin(hdg) * h)];
  }
  const mid = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
  // the runway's surveyed ends (the field's elevation where they're not given); Google's ground is
  // lined up with it once its tiles are in (plugin/extra300.js _alignToGoogle)
  const elevationM = (rw.elevFt ?? a.elevFt) * FT;
  // the tower view: off the runway's middle, 150 m to the side
  const f = new LocalFrame(mid[0], mid[1]);
  const [an, ae] = f.toNE(...ends[0]), [bn, be] = f.toNE(...ends[1]);
  const L = Math.hypot(bn - an, be - ae) || 1;
  const tower = f.toLatLon((-(be - ae) / L) * 150, ((bn - an) / L) * 150);
  return {
    data: {
      id: `af:${a.ident}`, icao: a.ident, name: a.name, elevationM, geoidM: await geoidAt(mid[0], mid[1]),
      magVar: 0, runway: { ident: [rw.le, rw.he] }, tower: { at: tower, h: 20 }, layout: null, style: null, start: 'low',
      // early afternoon, local sun time (the space's own time is set for Chicago)
      sun: { timeUTC: (((13.5 - mid[1] / 15) % 24) + 24) % 24 },
    },
    osm: {
      centre: mid,
      runway: { ends, width: rw.widthM },
      paved: [{ kind: 'runway', line: ends, width: rw.widthM }],
      aerodrome: null, water: null, tower: null,
    },
  };
}

/** The airfield as a world to fly from, its terrain fetched (flat where it can't be). */
export async function airfieldWorld(a, fetchTile) {
  const { data, osm } = await airfieldDescriptor(a);
  let dem = null;
  try { dem = await terrariumDem(osm.centre, fetchTile); } catch (e) { console.warn('[airfields] no terrain, flat ground:', e); }
  return { dem, world: buildAirport(data, osm, dem) };
}
