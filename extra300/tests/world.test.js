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
  const sears = w.frame.toNE(41.8789, -87.6359);
  assert.ok(sears[0] > 1800 && sears[0] < 2600);
  assert.ok(sears[1] < -1900 && sears[1] > -2700);
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
  assert.ok(!inside(...w.frame.toNE(41.8789, -87.6359), 100), 'the Sears Tower');
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

test('parked row: left of the airplane lined up, parallel, clear of the runway and of each other', async () => {
  const { parkingSpots } = await import('../src/plugin/parkedAircraft.js');
  // lined up heading west (270°): left is south
  const start = { n: 0, e: 0, heading: 1.5 * Math.PI };
  const planes = [{ span: 8, length: 7 }, { span: 13, length: 20 }, { span: 65, length: 71 }];
  const s = parkingSpots(start, planes, 45);
  for (const [i, p] of s.entries()) {
    assert.ok(Math.abs(p.heading - start.heading) < 1e-12);
    assert.ok(p.n < -(22.5 + planes[i].span / 2), `${i} south of the runway, wingtip clear: ${p.n}`);
  }
  assert.ok(Math.abs(s[0].e) < 1e-9);                                   // the first abreast of the start
  assert.ok(s[1].e < s[0].e - (7 + 20) / 2 && s[2].e < s[1].e - (20 + 71) / 2);   // on westward, nose to tail apart
});

test('parked row on the apron: fuselage and gear on it, the small ones nose to the runway, apart, the left side first', async () => {
  const { apronSpots } = await import('../src/plugin/parkedAircraft.js');
  const { buildInnsbruck } = await import('../src/world/innsbruck.js');
  const w = buildInnsbruck();
  const start = w.startPosition();
  const planes = [{ span: 8, length: 9.5 }, { span: 13, length: 20 }, { span: 65, length: 71 }];
  const spots = apronSpots(start, planes, w.pavement.areas);
  const left = [Math.sin(start.heading), -Math.cos(start.heading)];
  for (const [i, p] of spots.entries()) {
    assert.ok(p, `plane ${i} has a spot`);
    const l = (p.n - start.n) * left[0] + (p.e - start.e) * left[1];
    assert.ok(l > 150, `${i} left of the runway, off it: ${l}`);
    // nose to tail and across the gear's track: paved
    const f = [Math.cos(p.heading), Math.sin(p.heading)], r = [-f[1], f[0]], half = Math.max(6, 0.3 * planes[i].span) / 2;
    for (const x of [-0.5, -0.25, 0, 0.25, 0.5]) for (const y of [-half, 0, half]) {
      const n = p.n + f[0] * x * planes[i].length + r[0] * y, e = p.e + f[1] * x * planes[i].length + r[1] * y;
      assert.ok(w.isPaved(n, e), `${i} paved at ${x},${y}`);
    }
  }
  for (const i of [0, 1]) assert.ok(Math.abs(Math.cos(spots[i].heading - start.heading)) < 1e-9, `${i} nose to the runway`);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(Math.hypot(spots[i].n - spots[j].n, spots[i].e - spots[j].e) > (planes[i].span + planes[j].span) / 2);
  // a square apron too small for the 777
  const sq = [[0, 0], [0, 40], [40, 40], [40, 0]].map(([a, l]) => [start.n + Math.cos(start.heading) * a + left[0] * (l + 100), start.e + Math.sin(start.heading) * a + left[1] * (l + 100)]);
  const s2 = apronSpots(start, planes, [sq]);
  assert.ok(s2[0] && s2[1] && s2[2] === null);
});

test('stands: the smallest first, each on the first free stand wide enough, nose to the runway; none left: null', async () => {
  const { standSpots } = await import('../src/plugin/parkedAircraft.js');
  const start = { n: 0, e: 0, heading: 1.5 * Math.PI };   // west: left is south
  const stands = [{ along: -18, left: 42, span: 12 }, { along: -45, left: 44, span: 20 }];
  const s = standSpots(start, [{ span: 8 }, { span: 13 }, { span: 65 }], stands);
  assert.ok(Math.abs(s[0].n + 42) < 1e-9 && Math.abs(s[0].e - 18) < 1e-9);   // 42 m south, 18 m back (east)
  assert.ok(Math.abs(s[1].n + 44) < 1e-9 && Math.abs(s[1].e - 45) < 1e-9);
  assert.equal(s[2], null);
  assert.ok(Math.abs(Math.cos(s[0].heading)) > 0.999 && Math.cos(s[0].heading) > 0);   // facing north, to the runway
});
