// The OpenStreetMap pipeline on synthetic data: codec, coastline closing,
// procedural buildings, and the world's land mask and building collisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { encodeOsm, decodeOsm, inflateOsm, maskLookup, QUANTUM } from '../src/world/osmCodec.js';
import { closeCoast } from '../scripts/bake-osm.mjs';
import { buildCity, parseColour, groundLayer, ribbons } from '../src/render/buildings.js';
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

test('buildings: walls, flat roofs with courtyards, gabled houses, the skyline year', () => {
  const d = decodeOsm(encodeOsm(sample()));
  const in2002 = buildCity(d.buildings, { year: 2002 });
  const in2026 = buildCity(d.buildings, { year: 2026 });
  assert.equal(in2002.shown, 2, 'the 2009 tower is not there yet');
  assert.equal(in2026.shown, 3);
  const roofs = in2002.filter((p) => p.kind === 'roofs');
  const verts = roofs.reduce((s, p) => s + p.mesh.vertexCount, 0);
  assert.ok(verts > 8, 'roofs built');
  const walls = in2002.find((p) => p.style === 'glass');
  // 4 outer + 4 courtyard walls, 4 verts each
  assert.equal(walls.mesh.vertexCount, 32);
  assert.ok(walls.mesh.uvs.length === 64, 'facade UVs');
  // the glass tower's 120 m in floors of 3.9 m
  const vmax = Math.max(...walls.mesh.uvs.filter((_, i) => i % 2 === 1));
  assert.ok(Math.abs(vmax - 120.5 / 3.9) < 1e-6);
  // the house got a gable: its roof rises above the wall top
  const house = in2002.find((p) => p.style === 'house');
  const ys = house.mesh.positions.filter((_, i) => i % 3 === 1);
  assert.equal(ys.filter((y) => Math.abs(y - 9) < 1e-9).length, 2, 'only the two gable apexes reach the ridge');
  assert.ok(ys.filter((y) => y > 0.1 && y < 8.99).length >= 8, 'the walls stop at the eaves');
  const roofTop = Math.max(...roofs.flatMap((p) => p.mesh.positions.filter((_, i) => i % 3 === 1)).filter((y) => y < 50));
  assert.ok(Math.abs(roofTop - 9) < 1e-9, 'ridge at full height');
});

test('buildings: wall normals point out of the footprint', () => {
  const parts = buildCity([{ outer: square(0, 0, 10), holes: [], h: 30, minH: 0, year: 0, style: 'stone', roof: 0, colour: '' }]);
  const w = parts.find((p) => p.kind === 'walls').mesh;
  for (let v = 0; v < w.vertexCount; v += 4) {
    const cx = (w.positions[v * 3] + w.positions[(v + 1) * 3]) / 2, cz = (w.positions[v * 3 + 2] + w.positions[(v + 1) * 3 + 2]) / 2;
    const out = [cx - 5, cz - -5];   // centre of the footprint in render space is (e=5, z=-5)
    assert.ok(w.normals[v * 3] * out[0] + w.normals[v * 3 + 2] * out[1] > 0);
  }
});

test('buildings: minimum height drops the small stuff, colour tags win', () => {
  const d = decodeOsm(encodeOsm(sample()));
  assert.equal(buildCity(d.buildings, { minHeight: 15 }).shown, 1);
  assert.deepEqual(parseColour('black'), [36, 36, 38]);
  assert.deepEqual(parseColour('#fff'), [255, 255, 255]);
  assert.equal(parseColour('not a colour'), null);
});

test('ground layers and road ribbons triangulate', () => {
  const g = groundLayer([square(0, 0, 10)], 0);
  assert.equal(g.indices.length, 6);
  const r = ribbons([{ pts: [[0, 0], [10, 0], [10, 10]], w: 4 }], 0);
  assert.equal(r.vertexCount, 8);
});

test('world: OSM mask decides land and lake, buildings are solid for their skyline year', () => {
  const w = buildMeigs();
  const d = decodeOsm(encodeOsm(sample()));
  w.attachOsm(d, 2002);
  assert.equal(w.ground(0, 0).surface, 'asphalt', 'the runway stays');
  // (e, n) = (-44, -44) sits in the house; ground there is land
  assert.equal(w.ground(-44, -60).surface, 'grass');
  assert.ok(w.buildingAt(-44, -44, 5), 'inside the house');
  assert.equal(w.buildingAt(-44, -44, 12), null, 'above it');
  assert.equal(w.buildingAt(30, -70, 100), null, 'not in 2002: the 2009 tower');
  w.setSkylineYear(2026);
  assert.ok(w.buildingAt(30, -70, 100));
});
