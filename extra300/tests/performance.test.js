// Flight-test card: the published Extra 300L numbers the model is tuned to.
// A small autopilot (tests/lib/pilot.js) flies each point so the result
// measures the airframe, not stick technique.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { buildMeigs } from '../src/world/meigs.js';
import { Autopilot, fly, casKt, Pid } from './lib/pilot.js';
import { DEG, KT } from '../src/sim/units.js';

const AIR = () => ({ h: -1e4, normal: [0, 0, -1], surface: 'asphalt' });
const make = (load) => new Aircraft(EXTRA, { ground: AIR, load });

test('max level speed at 1,000 ft: 180-195 KTAS (published ~185 kt)', () => {
  const ac = make();
  ac.placeInFlight(0, 0, 300, 0, 85);
  fly(ac, new Autopilot(ac), { alt: 300, throttle: 1 }, 120);
  const ktas = ac.out.tas / KT;
  assert.ok(ktas > 180 && ktas < 195, `${ktas.toFixed(1)} KTAS`);
});

test('full-power climb at 85 KCAS: 2,500-3,500 fpm (published 3,200 fpm)', () => {
  const ac = make();
  ac.placeInFlight(0, 0, 300, 0, 45);
  const ap = new Autopilot(ac);
  let pitch = 0.15, h0 = null;
  fly(ac, ap, () => ({ pitch, throttle: 1 }), 40, (t) => {
    pitch = Math.max(-0.1, Math.min(0.45, pitch + 0.004 * (casKt(ac) - 85)));
    if (t >= 20 && h0 == null) h0 = ac.altitudeMsl;
  }, 0.1);
  const fpm = ((ac.altitudeMsl - h0) / 20) * 196.85;
  assert.ok(fpm > 2500 && fpm < 3500, `${fpm.toFixed(0)} fpm at ${casKt(ac).toFixed(0)} KCAS`);
});

function stallSpeed(load) {
  const ac = make(load);
  ac.placeInFlight(0, 0, 1500, 0, 45);
  let broke = null;
  fly(ac, new Autopilot(ac), { alt: 1500, throttle: 0 }, 60, () => {
    if (broke == null && ac.aero.wingStallFraction() > 0.5) broke = casKt(ac);
  }, 0.05);
  return { kcas: broke, mass: ac.mass };
}

test('power-off stall at 950 kg: 55-62 KCAS (published 55 KIAS)', () => {
  const { kcas, mass } = stallSpeed({ passenger: 85, fuelWingsL: 100 });
  assert.ok(mass > 930 && mass < 970, `mass ${mass}`);
  assert.ok(kcas > 55 && kcas < 62, `stall ${kcas}`);
});

test('stall speed scales with √weight', () => {
  const light = stallSpeed({});
  const heavy = stallSpeed({ passenger: 85, fuelWingsL: 100 });
  const ratio = heavy.kcas / light.kcas;
  const expect = Math.sqrt(heavy.mass / light.mass);
  assert.ok(Math.abs(ratio - expect) < 0.04, `${ratio} vs ${expect}`);
});

test('full-aileron roll rate at 160 KCAS: 340-460 °/s (published ~400)', () => {
  const ac = make();
  ac.placeInFlight(0, 0, 1500, 0, 85);
  fly(ac, new Autopilot(ac), { alt: 1500, ias: 160 }, 40);
  let pmax = 0;
  for (let i = 0; i < 90; i++) { ac.controls.aileron = 1; ac.update(1 / 60); pmax = Math.max(pmax, ac.state.omega[0]); }
  const dps = pmax / DEG;
  assert.ok(dps > 340 && dps < 460, `${dps.toFixed(0)} °/s`);
});

test('pulls 6 g at 160 KCAS without reaching the stall', () => {
  const ac = make();
  ac.placeInFlight(0, 0, 1500, 0, 85);
  fly(ac, new Autopilot(ac), { alt: 1500, ias: 160 }, 40);
  let gmax = 0;
  for (let i = 0; i < 60; i++) { ac.controls.elevator = 0.75; ac.update(1 / 60); gmax = Math.max(gmax, ac.out.loadFactor); }
  assert.ok(gmax > 6, `${gmax.toFixed(1)} g`);
});

test('takeoff from Meigs runway 36: stays on the runway, wheels clear in < 250 m', () => {
  const world = buildMeigs();
  const ac = new Aircraft(EXTRA, { ground: world.ground, datumMsl: world.elevation });
  const s = world.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.engine.running = true; ac.rpm = 750;
  for (let i = 0; i < 480; i++) ac.step(1 / 480);
  const n0 = ac.state.pos[0];
  const steer = new Pid(4, 0.5, 0.6);
  const lateral = new Pid(0.02, 0, 0.04, -0.15, 0.15);
  let liftoff = null, maxCross = 0;
  const frame = 1 / 60;
  for (let t = 0; t < 40 && liftoff == null; t += frame) {
    const c = ac.controls;
    c.throttle = Math.min(1, t / 3);              // smooth throttle-up, as taught
    const kias = casKt(ac);
    const e = ac.euler;
    // pedal to hold the centreline: heading error plus a little cross-track
    let hdgErr = s.heading - e.psi; if (hdgErr > Math.PI) hdgErr -= 2 * Math.PI; if (hdgErr < -Math.PI) hdgErr += 2 * Math.PI;
    const cross = ac.state.pos[1] - s.e;
    c.rudder = steer.step(hdgErr - lateral.step(cross, frame), frame);
    c.aileron = -1.5 * e.phi;
    // tail up at ~35 kt, hold a level attitude, rotate to ~12° at 55 kt (lift-off CL ≈ 1.1)
    c.elevator = kias < 35 ? 0 : kias < 55 ? 1.5 * (1 * DEG - e.theta) : 3 * (12 * DEG - e.theta);
    ac.update(frame);
    maxCross = Math.max(maxCross, Math.abs(cross));
    if (!ac.gear.onGround && ac.agl > 2.0) liftoff = ac.state.pos[0] - n0;
  }
  assert.ok(liftoff != null, 'got airborne');
  assert.ok(liftoff < 250, `roll + rotation ${liftoff.toFixed(0)} m`);
  assert.ok(maxCross < world.runway.width / 2 - 4, `wandered ${maxCross.toFixed(1)} m off the centreline`);
});
