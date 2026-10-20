// innsbruck.test.js — the Innsbruck destination: the baked data decodes, the airport is level where
// the gear rolls and Google's tiles are flattened, the mountains are where they are, and an airplane
// started there sits on its runway.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInnsbruck, inflateLowiDem, INNSBRUCK } from '../src/world/innsbruck.js';
import { Aircraft } from '../src/sim/aircraft.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';

const dem = await inflateLowiDem();
const w = buildInnsbruck(dem);

test('elevation: the valley floor at the field, the Patscherkofel 1,650 m above it', () => {
  const near = dem.near.h[Math.floor(dem.near.n / 2) * dem.near.n + Math.floor(dem.near.n / 2)];
  assert.ok(Math.abs(near - INNSBRUCK.elevationM) < 15, `field ${near.toFixed(0)} m`);
  const [n, e] = w.frame.toNE(47.2089, 11.4606);
  const h = w.ground(n, e).h + w.elevation;
  assert.ok(h > 2100 && h < 2300, `Patscherkofel ${h.toFixed(0)} m`);
});

test('runway 08/26: about 2 km, bearing 081°, level asphalt at the drawn slab\'s height; the grass beside it level', async () => {
  const { RUNWAY_PAVE_H } = await import('../src/world/airport.js');
  const rw = w.runway;
  assert.ok(Math.abs(rw.length - 1950) < 80, `length ${rw.length.toFixed(0)}`);
  assert.ok(Math.abs((rw.bearing * 180) / Math.PI - 81) < 2, `bearing ${((rw.bearing * 180) / Math.PI).toFixed(1)}`);
  for (const al of [-900, -400, 0, 400, 900]) {
    const g = w.ground(rw.dir[0] * al, rw.dir[1] * al);
    assert.equal(g.surface, 'asphalt');
    assert.equal(g.h, RUNWAY_PAVE_H);   // on render/icaoRunway.js's pavement, not 9 cm under it
  }
  const g = w.ground(-rw.dir[1] * 60, rw.dir[0] * 60);
  assert.equal(g.h, 0, 'the infield');
});

test('flatten mask: full on the runway, nothing far from the pavement', () => {
  const m = w.flattenMask();
  const at = (n, e) => m.data[Math.floor((n - m.box.n[0]) / 2.5) * m.width + Math.floor((e - m.box.e[0]) / 2.5)];
  assert.equal(at(0, 0), 255);
  assert.equal(at(-w.runway.dir[1] * 120, w.runway.dir[0] * 120 + 300), 0);
});

test('flatten mask: the aprons as photographed (their hangars), but levelled under a parked airplane', () => {
  // the main apron's open front, where the 777 stands by default (INNSBRUCK.stands)
  const s = w.startPosition(), f = [Math.cos(s.heading), Math.sin(s.heading)], l = [Math.sin(s.heading), -Math.cos(s.heading)];
  const n = s.n + f[0] * 560 + l[0] * 283, e = s.e + f[1] * 560 + l[1] * 283;
  assert.ok(w.isPaved(n, e), 'on the apron');
  const read = (m) => m.data[Math.floor((n - m.box.n[0]) / 2.5) * m.width + Math.floor((e - m.box.e[0]) / 2.5)];
  assert.equal(read(w.flattenMask()), 0);
  assert.equal(read(w.flattenMask([[n, e, 38]])), 255);
});

test('start: on runway 26 heading west, and 08 the other way; an airplane settles onto it', () => {
  const s = w.startPosition(), s8 = w.startPosition(true);
  assert.ok(Math.abs((((s.heading * 180) / Math.PI) % 360) - 261) < 2);
  assert.ok(Math.abs((s8.heading * 180) / Math.PI - 81) < 2);
  const ac = new Aircraft(EXTRA, { ground: w.ground, datumMsl: w.elevation });
  ac.placeOnGround(s.n, s.e, s.heading);
  for (let i = 0; i < 480 * 2; i++) ac.step(1 / 480);
  assert.ok(ac.gear.onGround, 'on its wheels');
  assert.ok(Math.abs(ac.altitudeMsl - w.elevation - ac.agl) < 0.5, `msl ${ac.altitudeMsl.toFixed(1)}`);
});

test('runway overlay: ICAO markings as measured, all on our pavement, which covers the thresholds and turn pads', async () => {
  const { buildIcaoRunway } = await import('../src/render/icaoRunway.js');
  const rw = w.runway, H = rw.length / 2;
  const b = buildIcaoRunway(rw, rw.layout);
  const { u, v } = b.areas[0];
  assert.deepEqual(u, [-30, 30]);
  assert.ok(Math.abs(v[0] + H + 96) < 1e-6 && Math.abs(v[1] - H - 36) < 1e-6);
  // every painted vertex lies on the pavement (uvs are runway metres: across, along)
  for (const mb of [b.paint, b.yel]) {
    for (let i = 0; i < mb.uvs.length; i += 2) {
      assert.ok(Math.abs(mb.uvs[i]) <= 30 + 1e-6 && mb.uvs[i + 1] >= v[0] - 1e-6 && mb.uvs[i + 1] <= v[1] + 1e-6, `${mb.uvs[i]}, ${mb.uvs[i + 1]}`);
    }
  }
  // the 12 piano keys at each end: paint across the 08 end 20 m in, in runs
  const at = -H + 20, across = [];
  for (let i = 0; i < b.paint.uvs.length; i += 2) if (Math.abs(b.paint.uvs[i + 1] - at) < 16) across.push(b.paint.uvs[i]);
  const keys = new Set(across.filter((c) => Math.abs(c) < 22).map((c) => Math.round(Math.abs(c) * 10) / 10));
  assert.ok(keys.has(1.2) && keys.has(3) && keys.has(19.5) && keys.has(21.3), [...keys].join(' '));
});

test('Renton: runway 34 toward the lake, the lake just past 16, and its FAA markings on our pavement', async () => {
  const { buildRenton, inflateRentonDem } = await import('../src/world/renton.js');
  const { buildIcaoRunway } = await import('../src/render/icaoRunway.js');
  const r = buildRenton(await inflateRentonDem());
  const s = r.startPosition();
  assert.ok(Math.abs((((s.heading * 180) / Math.PI) + 360) % 360 - 354) < 2, `${(s.heading * 180) / Math.PI}`);
  const [, north] = r.runway.thresholds, d = r.runway.dir;
  assert.equal(r.ground(north[0] + d[0] * 60, north[1] + d[1] * 60).surface, 'asphalt');
  const lake = r.ground(north[0] + d[0] * 300, north[1] + d[1] * 300);
  assert.equal(lake.surface, 'water');
  assert.ok(lake.h < -1 && lake.h > -5, `${lake.h}`);
  assert.ok(r.waterMask && r.waterMask.shores.length > 0);
  const b = buildIcaoRunway(r.runway, r.runway.layout);
  for (let i = 0; i < b.paint.uvs.length; i += 2) assert.ok(Math.abs(b.paint.uvs[i]) <= 30.5 + 1e-6);
});

test("Renton's sun: high and south-south-east, as its imagery's shadows (the tiles plugin's formula)", async () => {
  const { RENTON } = await import('../src/world/renton.js');
  const { timeUTC, dayOfYear } = RENTON.sun;
  const lat = (47.49 * Math.PI) / 180, lon = -122.21;
  const decl = -0.40928 * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const H = ((timeUTC + lon / 15 - 12) * 15 * Math.PI) / 180;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(sinEl);
  let az = Math.acos((Math.sin(decl) - Math.sin(lat) * sinEl) / (Math.cos(lat) * Math.cos(el)));
  if (H > 0) az = 2 * Math.PI - az;
  assert.ok((el * 180) / Math.PI > 55, `${(el * 180) / Math.PI}`);
  assert.ok(Math.abs((az * 180) / Math.PI - 163) < 8, `${(az * 180) / Math.PI}`);
});
