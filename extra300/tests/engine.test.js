import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { Engine } from '../src/sim/engine.js';
import { atmosphere } from '../src/sim/atmosphere.js';
import { HP, INHG } from '../src/sim/units.js';

/** Engine run-up on the parking brake, the way a pilot does it: stick held fully back, so the
 *  slipstream over the raised elevator keeps the tail down against the thrust. */
function runUp(throttle, seconds = 10) {
  const ac = new Aircraft(EXTRA);
  ac.placeOnGround(0, 0, 0);
  ac.engine.running = true;
  ac.rpm = 800;
  ac.controls.parkingBrake = true;
  ac.controls.elevator = 1;
  ac.controls.throttle = throttle;
  for (let i = 0; i < 480 * seconds; i++) ac.step(1 / 480);
  return ac;
}

test('idles near 700 rpm with ~11 inHg (POH idle 700)', () => {
  const ac = runUp(0);
  assert.ok(ac.rpm > 620 && ac.rpm < 820, `idle ${ac.rpm}`);
  const mp = ac.engine.mp / INHG;
  assert.ok(mp > 9 && mp < 14, `idle MP ${mp}`);
});

test('full-throttle static: ~2,600 rpm on the fine stop, ~29 inHg, ~5.5 kN', () => {
  const ac = runUp(1);
  assert.ok(ac.rpm > 2520 && ac.rpm <= 2705, `static rpm ${ac.rpm}`);
  const mp = ac.engine.mp / INHG;
  assert.ok(mp > 28.3 && mp < 29.6, `MP ${mp}`);
  assert.ok(ac.prop.thrust > 4800 && ac.prop.thrust < 6300, `thrust ${ac.prop.thrust}`);
  assert.ok(ac.engine.power / HP > 270 && ac.engine.power / HP < 305, `power ${ac.engine.power / HP} hp`);
});

test('rated power: 300 hp at 2,700 rpm and full-throttle sea-level MP', () => {
  const e = new Engine(EXTRA.engine);
  e.running = true;
  e.update({ throttle: 1, mixture: 1, magnetos: true }, 2700, atmosphere(0), 0, 0, true, 1 / 480);
  assert.ok(Math.abs(e.power / HP - 300) < 3, `${e.power / HP} hp`);
});

test('full-throttle MP falls with altitude (normally aspirated)', () => {
  const e = new Engine(EXTRA.engine);
  const sl = e.manifold(1, 2700, atmosphere(0).p) / INHG;
  const hi = e.manifold(1, 2700, atmosphere(2500).p) / INHG;
  assert.ok(sl - hi > 6, `${sl} → ${hi}`);
});

test('MP drops as rpm rises at a fixed part throttle', () => {
  const e = new Engine(EXTRA.engine);
  const p = atmosphere(0).p;
  assert.ok(e.manifold(0.3, 1500, p) > e.manifold(0.3, 2500, p));
});

test('mixture cut-off stops the engine and the prop winds down', () => {
  const ac = runUp(0.2, 4);
  ac.controls.mixture = 0;
  for (let i = 0; i < 480 * 8; i++) ac.step(1 / 480);
  assert.equal(ac.engine.running, false);
  assert.ok(ac.rpm < 50, `rpm ${ac.rpm}`);
});

test('the starter brings a stopped engine to life', () => {
  const ac = new Aircraft(EXTRA);
  ac.placeOnGround(0, 0, 0);
  ac.controls.starter = true;
  for (let i = 0; i < 480 * 3; i++) ac.step(1 / 480);
  ac.controls.starter = false;
  for (let i = 0; i < 480 * 3; i++) ac.step(1 / 480);
  assert.equal(ac.engine.running, true);
  assert.ok(ac.rpm > 500, `rpm ${ac.rpm}`);
});

test('the governor holds the lever rpm in a cruise climb', () => {
  const ac = new Aircraft(EXTRA, { ground: () => ({ h: -1e4, normal: [0, 0, -1], surface: 'asphalt' }) });
  ac.placeInFlight(0, 0, 1000, 0, 70);
  ac.controls.throttle = 0.85;
  ac.controls.prop = (2400 - 2000) / 700;
  for (let i = 0; i < 480 * 15; i++) ac.step(1 / 480);
  assert.ok(Math.abs(ac.rpm - 2400) < 30, `rpm ${ac.rpm}`);
  assert.ok(ac.prop.governing);
});

test('fuel burns at a believable rate (~20 gph at full power)', () => {
  const ac = runUp(1, 6);
  const gph = (ac.engine.fuelFlow / 0.72) * 3600 / 3.785;
  assert.ok(gph > 15 && gph < 27, `${gph} gph`);
});
