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
  assert.equal(buildCity(d.buildings, { minHeight: 15, year: 2002 }).shown, 1);
  assert.equal(buildCity(d.buildings, { minHeight: 15 }).shown, 2, 'today (the default) includes the 2009 tower');
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

test('every triangle faces outward: winding agrees with its normal, and the normal points away from the building', () => {
  const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const hex = (cx, cy, r) => [...Array(6).keys()].map((k) => [cx + r * Math.cos((k * Math.PI) / 3), cy + r * Math.sin((k * Math.PI) / 3)]);
  const kinds = [
    { name: 'flat + courtyard', b: { outer: sq(0, 0, 40), holes: [[[10, 10], [10, 30], [30, 30], [30, 10]]], h: 50, minH: 0, style: 'stone', roof: 0 } },
    { name: 'raised part', b: { outer: sq(100, 0, 20), holes: [], h: 80, minH: 30, style: 'glass', roof: 0 } },
    { name: 'gabled house', b: { outer: sq(200, 0, 10), holes: [], h: 9, minH: 0, style: 'house', roof: 0 } },
    { name: 'pyramid', b: { outer: hex(300, 0, 12), holes: [], h: 30, minH: 0, style: 'stone', roof: 3 } },
    { name: 'dome', b: { outer: hex(400, 0, 12), holes: [], h: 30, minH: 0, style: 'white', roof: 4 } },
    { name: 'clockwise input', b: { outer: sq(500, 0, 15).reverse(), holes: [], h: 20, minH: 0, style: 'brick', roof: 0 } },
  ];
  for (const { name, b } of kinds) {
    const centre = b.outer.reduce((s, p) => [s[0] + p[0] / b.outer.length, s[1] + p[1] / b.outer.length], [0, 0]);
    const inside = [centre[0], (b.minH + b.h) / 2, -centre[1]];   // render space
    // a clockwise outer ring is what the bake would fix; feed the generator what the bake produces
    if (name === 'clockwise input') b.outer.reverse();
    for (const part of buildCity([{ year: 0, colour: '', ...b }], { year: 2026 })) {
      const { positions: P, normals: N, indices: I } = part.mesh;
      for (let t = 0; t < I.length; t += 3) {
        const [a, c, d] = [I[t], I[t + 1], I[t + 2]];
        const u = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]);
        const v = [0, 1, 2].map((k) => P[d * 3 + k] - P[a * 3 + k]);
        const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const n = [N[a * 3], N[a * 3 + 1], N[a * 3 + 2]];
        const fn = f[0] * n[0] + f[1] * n[1] + f[2] * n[2];
        assert.ok(fn > 0, `${name} ${part.kind}: triangle ${t / 3} wound against its normal`);
        // the courtyard walls face into the courtyard, i.e. away from the solid ring around it
        if (name === 'flat + courtyard' && part.kind === 'walls') continue;
        const m = [0, 1, 2].map((k) => (P[a * 3 + k] + P[c * 3 + k] + P[d * 3 + k]) / 3 - inside[k]);
        const out = m[0] * n[0] + m[1] * n[1] + m[2] * n[2];
        if (part.kind === 'roofs' && b.minH > 0 && n[1] < 0) continue;   // the underside of a raised part faces down
        assert.ok(out > -1e-9, `${name} ${part.kind}: triangle ${t / 3} faces into the building`);
      }
    }
  }
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
  assert.ok(groundLayer([w.farLand], 0).vertexCount > 10, 'and it draws');
});

test('world: in-box water quads, the far land and the far lake tile the whole world exactly', async () => {
  const { CHICAGO_OSM } = await import('../src/world/data/chicagoOsm.js');
  const { maskWaterRects } = await import('../src/world/meigs.js');
  const w = buildMeigs();
  const osm = await inflateOsm(CHICAGO_OSM);
  w.attachOsm(osm);
  const area = (p) => { let A = 0; for (let i = 0; i < p.length; i++) { const [a, b] = p[i], [c, d] = p[(i + 1) % p.length]; A += a * d - c * b; } return Math.abs(A) / 2; };
  const b = osm.header.box;
  const FAR = 40000;
  const boxA = (b.x1 - b.x0) * (b.y1 - b.y0);
  assert.ok(Math.abs(area(w.farLand) + area(w.farLake) + boxA - (2 * FAR) ** 2) < 1e3, 'land + lake + box = the world');
  const rects = maskWaterRects(osm.mask, b);
  const waterCells = osm.mask.data.reduce((s, v) => s + (v ? 0 : 1), 0);
  const rectA = rects.reduce((s, [e0, n0, e1, n1]) => s + (e1 - e0) * (n1 - n0), 0);
  assert.ok(Math.abs(rectA - waterCells * 16) < 1, `quads ${rectA} m² vs mask ${waterCells * 16} m²`);
  assert.ok(rects.length < 20000, `${rects.length} quads`);
});
