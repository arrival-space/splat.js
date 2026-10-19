// The OpenStreetMap pipeline on synthetic data: codec, coastline closing, and the world's land mask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { encodeOsm, decodeOsm, inflateOsm, maskLookup, QUANTUM } from '../src/world/osmCodec.js';
import { closeCoast } from '../scripts/bake-osm.mjs';
import { buildMeigs } from '../src/world/meigs.js';
import { pointInPolygon } from '../src/world/geo.js';

const area = (r) => Math.abs(r.reduce((s, [x, y], i) => { const [x2, y2] = r[(i + 1) % r.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

function sample() {
  const box = { x0: -100, y0: -100, x1: 100, y1: 100 };
  const nx = 50, ny = 50;
  const data = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < 25; i++) data[j * nx + i] = 1;   // west half land
  return {
    header: { attribution: 'test', box, styles: ['brick', 'stone', 'glass', 'dark', 'white', 'plain', 'house'] },
    buildings: [
      { outer: square(-50, -50, 12), holes: [], h: 9, minH: 0, year: 1925, style: 'house', roof: 0, colour: '', name: '' },
      { outer: square(-30, -50, 40), holes: [[[-20, -40], [-20, -20], [0, -20], [0, -40]]], h: 120.5, minH: 0, year: 0, style: 'glass', roof: 0, colour: '#202020', name: 'Test Tower' },
      { outer: square(-80, 20, 20), holes: [], h: 200, minH: 0, year: 2009, style: 'stone', roof: 0, colour: '', name: 'New Tower' },
    ],
    land: [[[-100, -100], [0, -100], [0, 100], [-100, 100]]],
    water: [square(-60, 60, 10)],
    parks: [square(-90, -90, 20)],
    roads: [{ pts: [[-100, 0], [0, 0]], w: 16 }],
    rail: [],
    mask: { nx, ny, data },
  };
}

test('codec: round trip within the quantum, holes, names, colours, years, mask', () => {
  const d = sample();
  const out = decodeOsm(encodeOsm(d));
  assert.equal(out.buildings.length, 3);
  const b = out.buildings[1];
  assert.equal(b.name, 'Test Tower');
  assert.equal(b.colour, '#202020');
  assert.equal(b.style, 'glass');
  assert.ok(Math.abs(b.h - 120.5) < 0.05);
  assert.equal(b.holes.length, 1);
  for (let i = 0; i < 4; i++) for (let k = 0; k < 2; k++) assert.ok(Math.abs(b.outer[i][k] - d.buildings[1].outer[i][k]) <= QUANTUM / 2);
  assert.equal(out.buildings[2].year, 2009);
  assert.equal(out.roads[0].w, 16);
  assert.deepEqual([...out.mask.data], [...d.mask.data]);
});

test('codec: base64 + gzip inflate path used by the plugin', async () => {
  const b64 = gzipSync(encodeOsm(sample())).toString('base64');
  const out = await inflateOsm(b64);
  assert.equal(out.buildings.length, 3);
  const land = maskLookup(out.mask, out.header.box);
  assert.equal(land(-50, 0), true);
  assert.equal(land(50, 0), false);
  assert.equal(land(-500, 0), true, 'west of the box is land (the city goes on)');
  assert.equal(land(500, 0), false, 'east of the box is the lake');
});

test('coastline: a shore running north with land on its left closes into the western land, peninsula included', () => {
  const box = { x0: -100, y0: -100, x1: 100, y1: 100 };
  // runs south → north with a peninsula sticking out east (like Northerly Island)
  const shore = [[0, -150], [0, -20], [60, -20], [60, 20], [0, 20], [0, 150]];
  const polys = closeCoast([shore], box);
  assert.equal(polys.length, 1);
  const p = polys[0];
  assert.ok(pointInPolygon(-50, 0, p), 'mainland');
  assert.ok(pointInPolygon(30, 0, p), 'peninsula');
  assert.ok(!pointInPolygon(30, 50, p), 'lake north of the peninsula');
  assert.ok(Math.abs(area(p) - (100 * 200 + 60 * 40)) < 1, `area ${area(p)}`);
});

test('world: OSM mask decides land and lake', () => {
  const w = buildMeigs();
  w.attachOsm(decodeOsm(encodeOsm(sample())));
  assert.equal(w.ground(0, 0).surface, 'asphalt', 'the runway stays');
  assert.equal(w.ground(-44, -60).surface, 'grass');
});

test('world: past the OSM box the suburbs are land and the lake is lake, out to the horizon', async () => {
  const { CHICAGO_OSM } = await import('../src/world/data/chicagoOsm.js');
  const w = buildMeigs();
  w.attachOsm(await inflateOsm(CHICAGO_OSM));
  const at = (lat, lon) => { const [n, e] = w.frame.toNE(lat, lon); return w.ground(n, e).surface; };
  assert.equal(at(42.05, -87.70), 'grass', 'Evanston');
  assert.equal(at(41.885, -87.79), 'grass', 'Oak Park');
  assert.equal(at(41.80, -87.60), 'grass', 'Hyde Park');
  assert.equal(at(41.58, -87.33), 'grass', 'Gary');
  assert.equal(at(42.05, -87.62), 'water', 'off Evanston');
  assert.equal(at(41.80, -87.55), 'water', 'off Hyde Park');
  assert.equal(at(42.0, -87.3), 'water', 'mid-lake');
  assert.ok(w.farLand.length > 10, 'a shore out to the horizon');
});
