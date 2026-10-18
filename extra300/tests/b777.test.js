// The Boeing 777-300ER: the published figures its flight model is tuned to (cruise, top speed, the
// slats-and-flaps stall), what it takes to get it off a short runway hands-off, and the model and
// film that go with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import B777 from '../src/sim/aircraft/b777.js';
import { ControlMapper } from '../src/input/controlMapper.js';
import { buildMeigs } from '../src/world/meigs.js';
import { Autopilot, fly, casKt } from './lib/pilot.js';
import { DEG } from '../src/sim/units.js';
import { fromBody } from '../src/render/geometry.js';
import { buildB777Model } from '../src/render/b777Model.js';
import { INTROS, introAt } from '../src/render/intro.js';

const AIR = () => ({ h: -1e5, normal: [0, 0, -1], surface: 'asphalt' });
const GROUND = () => ({ h: 0, normal: [0, 0, -1], surface: 'asphalt' });

function level(alt, throttle, seconds = 240) {
  const ac = new Aircraft(B777, { ground: AIR, load: { fuelWingsL: 60000, fuelCenterL: 20000 } });
  ac.placeInFlight(0, 0, alt, 0, alt > 5000 ? 240 : 150);
  fly(ac, new Autopilot(ac), { alt, throttle }, seconds);
  return ac;
}

test('FL350: Mach ~0.84 at a cruise setting, no faster than ~0.9 flat out (published 0.84 cruise, MMO 0.89)', () => {
  const cruise = level(10668, 0.8).out.mach, max = level(10668, 1).out.mach;
  assert.ok(cruise > 0.81 && cruise < 0.87, `cruise M${cruise.toFixed(3)}`);
  assert.ok(max > 0.86 && max < 0.92, `max M${max.toFixed(3)}`);
});

test('parked: level on its six-wheel bogies, ~7 % of the weight on the nose wheels', () => {
  const ac = new Aircraft(B777, { ground: GROUND });
  ac.placeOnGround(0, 0, 0);
  ac.setEngineRunning(true);
  for (let i = 0; i < 480 * 4; i++) { ac.controls.parkingBrake = true; ac.step(1 / 480); }
  assert.ok(Math.abs(ac.euler.theta) < 0.5 * DEG, `pitch ${(ac.euler.theta / DEG).toFixed(2)}°`);
  const loads = ac.gear.units.map((u) => u.load), total = loads.reduce((a, b) => a + b, 0);
  const nose = loads[4] / total;
  assert.ok(nose > 0.05 && nose < 0.12, `nose ${(nose * 100).toFixed(1)} %`);
  assert.deepEqual(ac.events.map((e) => e.e), []);
  assert.ok(ac.controls.flaps > 0.99, 'flaps set for take-off');
});

test('phone, hands off, easy: off Meigs\' 1,200 m at ~150 kt without touching its tail, gear and flaps up after', () => {
  const world = buildMeigs();
  const ac = new Aircraft(B777, { ground: world.ground, datumMsl: world.elevation });
  const s = world.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.setEngineRunning(true);
  const m = new ControlMapper({ easy: true, handling: B777.handling }); m.throttle = 1;
  let off = null, maxGroundPitch = 0;
  for (let t = 0; t < 75; t += 1 / 60) {
    m.update({ keys: new Set(), left: null }, 1 / 60, ac.controls, ac.flightState());
    ac.update(1 / 60);
    if (ac.gear.onGround) maxGroundPitch = Math.max(maxGroundPitch, ac.euler.theta);
    if (!off && !ac.gear.onGround && ac.agl > 3) off = { along: Math.hypot(ac.state.pos[0] - s.n, ac.state.pos[1] - s.e), kt: casKt(ac) };
  }
  assert.ok(off, 'it lifted off');
  assert.ok(off.along < 1100, `airborne ${off.along.toFixed(0)} m down the runway`);
  assert.ok(off.kt > 130 && off.kt < 170, `at ${off.kt.toFixed(0)} kt`);
  assert.ok(maxGroundPitch < 8.4 * DEG, `${(maxGroundPitch / DEG).toFixed(1)}° on the wheels`);
  assert.deepEqual(ac.events.map((e) => e.e), [], 'no tail strike');
  assert.ok(ac.agl > 400, `climbing: ${ac.agl.toFixed(0)} m`);
  assert.equal(ac.gearPos, 0, 'gear up');
  assert.ok(ac.controls.flaps < 0.05, 'flaps up');
});

test('gear and flaps down at 248 t it flies slow and stalls near 115 kt (published Vs ~115-125 kt, flaps 30)', () => {
  const ac = new Aircraft(B777, { ground: AIR, load: { fuelWingsL: 60000, fuelCenterL: 15000 } });
  ac.placeInFlight(0, 0, 1500, 0, 90);
  ac.controls.gear = 1; ac.gearPos = 1; ac.controls.flaps = 1;
  let stallKt = null;
  fly(ac, new Autopilot(ac), (t) => ({ alt: 1500, ias: Math.max(60, 160 - t) }), 120, () => {
    if (stallKt == null && ac.aero.strips.some((st) => st.group === 'wing' && st.out.stalled)) stallKt = casKt(ac);
  });
  assert.ok(stallKt != null && stallKt > 100 && stallKt < 135, `first stall at ${stallKt?.toFixed(0)} kt`);
});

// ── the model and the film ──────────────────────────────────────────────────
test('model: 64.8 m span, 73.9 m long, 18.5 m tall on its wheels (published 64.80 / 73.86 / 18.5)', () => {
  const stat = buildB777Model().filter((p) => !p.hinge).map((p) => p.mesh.bounds());
  const min = [0, 1, 2].map((k) => Math.min(...stat.map((x) => x.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...stat.map((x) => x.max[k])));
  assert.ok(Math.abs(max[0] - min[0] - 64.8) < 0.4, `span ${(max[0] - min[0]).toFixed(2)}`);
  assert.ok(Math.abs(max[2] - min[2] - 73.86) < 0.4, `length ${(max[2] - min[2]).toFixed(2)}`);
  const ground = B777.gear.units[0].pos[2] - 0.12;
  assert.ok(Math.abs(max[1] + ground - 18.5) < 0.4, `height ${(max[1] + ground).toFixed(2)}`);
});

test('model: every part has geometry; the wheels on the bogies\' axles at the gear\'s contact height; the eye behind the windscreen', () => {
  const parts = buildB777Model();
  for (const p of parts) {
    assert.ok(p.mesh.vertexCount > 0 && p.mesh.vertexCount < 65536, p.name);
    assert.ok(p.mesh.positions.every(Number.isFinite), p.name);
  }
  const wheels = parts.filter((p) => (p.kind === 'wheel' || p.kind === 'steerwheel') && !p.name.endsWith('Hub'));
  assert.equal(wheels.length, 14, '12 main wheels, 2 nose wheels');
  for (const w of wheels) {
    const u = B777.gear.units[w.gear];
    assert.ok(Math.abs(w.hinge[2] + u.tyre.radius - u.pos[2]) < 1e-3, `${w.name}: hub + radius = contact`);
    assert.ok(parts.find((p) => p.name === w.parent)?.kind === 'gearLeg', `${w.name} rides on a folding leg`);
  }
  const glass = parts.find((p) => p.name === 'windscreen').mesh.bounds();
  const eye = fromBody(B777.eye);
  assert.ok(eye[2] > glass.min[2], 'the eye behind the windscreen\'s front');
  for (const k of ['flap', 'aileron', 'elevator', 'rudder', 'speedbrake', 'gearLeg', 'throttle', 'stick']) assert.ok(parts.some((p) => p.kind === k), k);
});

test('intro: back-to-back shots with captions, above the ground and outside the airplane until the flight deck', () => {
  const film = INTROS.b777;
  let t = 0;
  for (const s of film.shots) { assert.equal(s.t0, t); assert.ok(film.cards[s.card]); t = s.t1; }
  assert.equal(t, film.length);
  const groundZ = B777.gear.units[0].pos[2] - 0.12;
  for (let t = 0; t < film.length; t += 0.05) {
    const [x, y, z] = introAt(t, film).eye;
    assert.ok(z < groundZ - 0.4, `t ${t.toFixed(2)}: eye near the ground`);
    const inFuselage = x > -38 && x < 35 && Math.hypot(y, z) < 3.3;
    if (t < film.length - 1.5) assert.ok(!inFuselage, `t ${t.toFixed(2)}: inside the fuselage`);
  }
});
