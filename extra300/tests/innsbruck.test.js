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

test('runway 08/26: about 2 km, bearing 081°, level asphalt; the grass beside it level too', () => {
  const rw = w.runway;
  assert.ok(Math.abs(rw.length - 1950) < 80, `length ${rw.length.toFixed(0)}`);
  assert.ok(Math.abs((rw.bearing * 180) / Math.PI - 81) < 2, `bearing ${((rw.bearing * 180) / Math.PI).toFixed(1)}`);
  for (const al of [-900, -400, 0, 400, 900]) {
    const g = w.ground(rw.dir[0] * al, rw.dir[1] * al);
    assert.equal(g.surface, 'asphalt');
    assert.equal(g.h, 0);
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
