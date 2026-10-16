import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeigs, MEIGS } from '../src/world/meigs.js';
import { LocalFrame, pointInPolygon, triangulate } from '../src/world/geo.js';

test('local frame: 1° of latitude ≈ 111.1 km, round trip exact', () => {
  const f = new LocalFrame(41.8586, -87.6083);
  const [n] = f.toNE(42.8586, -87.6083);
  assert.ok(Math.abs(n - 111090) < 150, `${n}`);
  const [lat, lon] = f.toLatLon(...f.toNE(41.879, -87.636));
  assert.ok(Math.abs(lat - 41.879) < 1e-12 && Math.abs(lon + 87.636) < 1e-12);
});

test('runway 36 at Meigs: 3,948 × 150 ft, the start position is on it facing north', () => {
  const w = buildMeigs();
  assert.ok(Math.abs(w.runway.length - MEIGS.runway.lengthFt * 0.3048) < 1e-9);
  const s = w.startPosition();
  assert.equal(w.ground(s.n, s.e).surface, 'asphalt');
  assert.ok(Math.abs(s.heading) < 0.05);
  assert.ok(s.n < 0, 'south half of the runway');
});

test('ground: runway on the island, grass beside it, lake off the east shore, Chicago to the west', () => {
  const w = buildMeigs();
  assert.equal(w.ground(0, 0).surface, 'asphalt');
  assert.equal(w.ground(0, -120).surface, 'grass');
  const lake = w.ground(0, 600);
  assert.equal(lake.surface, 'water');
  assert.ok(lake.h < -4 && lake.h > -6, 'lake ~15 ft below the field');
  assert.equal(w.ground(2000, -3000).surface, 'grass'); // mainland (Loop)
});

test('the whole runway lies on Northerly Island', () => {
  const w = buildMeigs();
  for (const t of [-0.5, -0.25, 0, 0.25, 0.5]) {
    for (const c of [-1, 1]) {
      const n = w.runway.centre[0] + t * w.runway.length;
      const e = w.runway.centre[1] + c * w.runway.width / 2;
      assert.ok(pointInPolygon(n, e, w.island), `runway corner (${t}, ${c}) off the island`);
    }
  }
});

test('the Sears Tower is ~2.2 km north and ~2.3 km west of the runway', () => {
  const w = buildMeigs();
  const sears = w.landmarks.find((l) => l.name === 'Sears Tower');
  assert.ok(sears.ne[0] > 1800 && sears.ne[0] < 2600);
  assert.ok(sears.ne[1] < -1900 && sears.ne[1] > -2700);
});

test('triangulation covers a polygon exactly (area preserved)', () => {
  const poly = [[0, 0], [4, 0], [4, 3], [2, 1], [0, 3]];
  const area = (pts) => Math.abs(pts.reduce((s, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
  const tris = triangulate(poly);
  assert.equal(tris.length, poly.length - 2);
  const sum = tris.reduce((s, t) => s + area(t.map((i) => poly[i])), 0);
  assert.ok(Math.abs(sum - area(poly)) < 1e-9);
});

test('the Google-tiles cut-out covers the runway and the island, and stops short of the Loop', async () => {
  const { carveBox } = await import('../src/render/carve.js');
  const w = buildMeigs();
  const { local, half } = carveBox(w.airfieldBox(), -0.3, 400);
  // render-metres point → box-local, by the transpose (the box is a pure rotation + offset)
  const inside = (n, e, h = 0) => {
    const p = [e - local[12], h - local[13], -n - local[14]];
    const l = [0, 4, 8].map((c) => local[c] * p[0] + local[c + 1] * p[1] + local[c + 2] * p[2]);
    return l.every((v, i) => Math.abs(v) <= half[i]);
  };
  const rw = w.runway;
  assert.ok(inside(...rw.thr36) && inside(...rw.thr18) && inside(...rw.centre), 'the runway');
  for (const [n, e] of w.island) assert.ok(inside(n, e), `island ${n.toFixed(0)}, ${e.toFixed(0)}`);
  const sears = w.landmarks.find((l) => /Sears|Willis/.test(l.name));
  if (sears) assert.ok(!inside(...sears.ne, 100));
  assert.ok(!inside(rw.centre[0], rw.centre[1] - 1500), '1.5 km west: the mainland');
});

test('the cut-out leaves Google\'s water: it starts just under the runway, metres above the lake', async () => {
  const { carveBox } = await import('../src/render/carve.js');
  const w = buildMeigs();
  const { local, half } = carveBox(w.airfieldBox(), -0.3, 400);
  const bottom = local[13] - half[1];
  assert.ok(Math.abs(bottom + 0.3) < 1e-9);
  assert.ok(bottom - w.water > 4, `${(bottom - w.water).toFixed(1)} m above the lake`);
});
