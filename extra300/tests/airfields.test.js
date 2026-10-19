// Any airfield found by name (world/airfields.js): OurAirports' tables read, searched by code, name and
// town, the nearest to a place, made into a world to fly from; the EGM96 geoid (world/data/geoid.js);
// the Terrarium terrain grid (world/terrarium.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { airfieldDescriptor, airfieldsFrom, airfieldWorld, distanceM, fold, geoidAt, nearestAirfields, parseCsv, searchAirfields } from '../src/world/airfields.js';
import { terrariumGrid } from '../src/world/terrarium.js';
import { LocalFrame } from '../src/world/geo.js';

// a few rows as OurAirports writes them (only the columns read)
const AIRPORTS = `"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","iso_country","municipality","gps_code","iata_code","local_code","icao_code","keywords"
1,"LOWG","large_airport","Graz Airport",46.991100,15.439600,1115,"AT","Feldkirchen bei Graz","LOWG","GRZ","","LOWG",""
2,"LOGO","small_airport","Flugplatz Niederöblarn",47.478,14.006,2160,"AT","Niederöblarn","LOGO","","","",""
3,"LIRM","medium_airport","Grazzanise Air Base",41.06,14.08,29,"IT","Caserta","LIRM","","","LIRM","Grazzanise"
4,"AT-0001","heliport","Graz Hospital Heliport",47.07,15.45,1200,"AT","Graz","","","","",""
5,"LOWW","large_airport","Vienna International Airport",48.110,16.570,600,"AT","Vienna","LOWW","VIE","","LOWW","Wien, ""Schwechat"""
6,"XX01","small_airport","Short Strip",47.0,15.0,900,"AT","Graz","","","","",""
`;
const RUNWAYS = `"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft"
10,1,"LOWG",9842,148,"ASP",1,0,"16C",47.0045,15.4357,1115,168,,"34C",46.9783,15.4433,1101
11,1,"LOWG",2300,60,"GRS",0,0,"16L",,,,168,,"34R",,,
12,2,"LOGO",2165,59,"ASP",0,0,"07",,,2160,72,,"25",,,
13,3,"LIRM",9800,148,"ASP",1,0,"06",,,,60,,"24",,,
14,4,"AT-0001",60,60,"CON",0,0,"H1",,,,,,"",,,
15,5,"LOWW",11483,148,"ASP",1,0,"11",,,,,,"29",,,
16,5,"LOWW",3000,148,"ASP",1,1,"16",,,,,,"34",,,
17,6,"XX01",600,40,"GRS",0,0,"09",,,,,,"27",,,
`;
const fields = airfieldsFrom(AIRPORTS, RUNWAYS);
const byIdent = (id) => fields.find((a) => a.ident === id);

test('csv: quotes, doubled quotes, commas and newlines inside quotes, CRLF', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n"f\ng",,h\n'), [['a', 'b,c', 'd "e"'], ['f\ng', '', 'h']]);
  assert.deepEqual(parseCsv('x,y'), [['x', 'y']]);
});

test('airfields: land airports with an open runway of 1000 ft or more, paved and longest first', () => {
  assert.deepEqual(fields.map((a) => a.ident).sort(), ['LIRM', 'LOGO', 'LOWG', 'LOWW']);   // no heliport, no 600 ft strip
  const g = byIdent('LOWG');
  assert.deepEqual(g.runways.map((r) => r.le), ['16C', '16L']);
  assert.equal(g.runways[0].paved, true);
  assert.equal(g.runways[1].paved, false);
  assert.ok(Math.abs(g.runways[0].lengthM - 3000) < 1);
  assert.deepEqual(g.runways[0].ends, [[47.0045, 15.4357], [46.9783, 15.4433]]);
  assert.equal(g.runways[0].elevFt, 1108);
  assert.equal(g.runways[1].ends, null);
  assert.deepEqual(byIdent('LOWW').runways.map((r) => r.le), ['11']);                    // the closed one left out
  assert.equal(byIdent('LOGO').runways[0].elevFt, 2160);                                 // only one end's height
  assert.ok(byIdent('LOWG').codes.includes('grz'));
  assert.ok(byIdent('LOWW').words.includes('schwechat'));
  assert.equal(fold('Niederöblarn – Flugplatz'), 'niederoblarn flugplatz');
});

test('search: a code first, then names and towns by word starts, accents and case aside', () => {
  assert.equal(searchAirfields(fields, 'graz')[0].ident, 'LOWG');
  assert.equal(searchAirfields(fields, 'GRZ')[0].ident, 'LOWG');
  assert.equal(searchAirfields(fields, 'lirm')[0].ident, 'LIRM');
  assert.deepEqual(searchAirfields(fields, 'niederoblarn').map((a) => a.ident), ['LOGO']);
  assert.deepEqual(searchAirfields(fields, 'wien').map((a) => a.ident), ['LOWW']);
  assert.deepEqual(searchAirfields(fields, 'vienna intern').map((a) => a.ident), ['LOWW']);
  assert.deepEqual(searchAirfields(fields, 'graz vienna'), []);
  assert.deepEqual(searchAirfields(fields, '  '), []);
});

test('nearest: by distance, paved runways weighing as if a third closer, nothing past 300 km', () => {
  assert.ok(Math.abs(distanceM(47, 15, 48, 15) - 111195) < 10);
  // Leibnitz, south of Graz
  const near = nearestAirfields(fields, 46.78, 15.54);
  assert.equal(near[0].ident, 'LOWG');
  assert.ok(near[0].distanceM > 20000 && near[0].distanceM < 30000);
  assert.ok(!near.some((a) => a.ident === 'LIRM'));
  assert.deepEqual(nearestAirfields(fields, 0, 0), []);
});

test('geoid: EGM96 heights where they are known', async () => {
  // Graz ~47.6 m, the Indian Ocean low ~−105 m, New Guinea high ~+75 m, Chicago ~−34 m
  assert.ok(Math.abs((await geoidAt(47.0, 15.44)) - 47.6) < 2);
  assert.ok((await geoidAt(5, 78)) < -95);
  assert.ok((await geoidAt(-5, 145)) > 60);
  assert.ok(Math.abs((await geoidAt(41.86, -87.61)) + 34) < 3);
  assert.ok(Number.isFinite(await geoidAt(89.9, 179.9)) && Number.isFinite(await geoidAt(-90, -180)));
});

test('descriptor: the longest paved runway, its ends from the table or from the field, the tower to its side', async () => {
  const { data, osm } = await airfieldDescriptor(byIdent('LOWG'));
  assert.equal(data.id, 'af:LOWG');
  assert.deepEqual(data.runway.ident, ['16C', '34C']);
  assert.ok(Math.abs(data.elevationM - 1108 * 0.3048) < 0.01);
  assert.ok(data.sun.timeUTC > 12 && data.sun.timeUTC < 13);   // early afternoon at 15° E
  assert.equal(osm.paved[0].kind, 'runway');
  const f = new LocalFrame(...osm.centre);
  const t = f.toNE(...data.tower.at);
  assert.ok(Math.abs(Math.hypot(...t) - 150) < 1);
  // no ends in the table: laid along its heading, its length, round the field's position
  const lirm = await airfieldDescriptor(byIdent('LIRM'));
  const [a, b] = lirm.osm.runway.ends.map(([lat, lon]) => new LocalFrame(41.06, 14.08).toNE(lat, lon));
  assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 9800 * 0.3048) < 1);
  assert.ok(Math.abs(((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) - 60) < 0.5);
});

// a tile of Terrarium pixels: height = f(global pixel x, y)
const tileOf = (height) => async (z, x, y) => {
  const data = new Uint8ClampedArray(256 * 256 * 4);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
    const v = height(x * 256 + i + 0.5, y * 256 + j + 0.5) + 32768, k = (j * 256 + i) * 4;
    data[k] = Math.floor(v / 256); data[k + 1] = Math.floor(v) % 256; data[k + 2] = Math.round((v % 1) * 256); data[k + 3] = 255;
  }
  return { width: 256, height: 256, data };
};

test('terrarium: tiles decoded and sampled onto a grid round the centre, south row first', async () => {
  let fetched = 0;
  const flat = tileOf(() => 412.5);
  const g = await terrariumGrid([47, 15], { half: 1000, step: 100, z: 10 }, (...a) => { fetched++; return flat(...a); });
  assert.equal(g.n, 21);
  assert.ok(fetched >= 1 && fetched <= 4);
  assert.ok(g.h.every((h) => Math.abs(h - 412.5) < 0.01));
  // heights rising to the south (global y grows southward): row 0 the highest
  const slope = await terrariumGrid([47, 15], { half: 1000, step: 100, z: 10 }, tileOf((x, y) => y / 10));
  assert.ok(slope.h[0] > slope.h[20 * 21]);
});

test('runway level: the runway\'s surveyed ends, whatever the elevation tiles say (a reef runway\'s seabed); flat ground when no tiles', async () => {
  const g = byIdent('LOWG');
  for (const h of [352, -20, 2000]) {
    const w = await airfieldWorld(g, tileOf(() => h));
    assert.ok(Math.abs(w.world.elevation - 1108 * 0.3048) < 0.01, `tiles at ${h} m: ${w.world.elevation}`);
  }
  const w = await airfieldWorld(g, tileOf(() => 352));
  assert.equal(w.world.runway.ident.join('/'), '16C/34C');
  const s = w.world.startPosition();
  assert.equal(w.world.ground(s.n, s.e).surface, 'asphalt');
  const none = await airfieldWorld(g, async () => { throw new Error('offline'); });
  assert.equal(none.dem, null);
  assert.ok(Math.abs(none.world.elevation - 1108 * 0.3048) < 0.01);
});
