// The control conventions and the classic static/dynamic stability signs,
// measured on the build-up the way a wind tunnel would: freeze the airplane
// at a condition, perturb one thing, look at the moment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aero, sectionCoefficients, flapTau } from '../src/sim/aero.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { massProperties } from '../src/sim/massprops.js';
import { DEG } from '../src/sim/units.js';

const cg = massProperties(EXTRA.mass, { fuelCenterL: 60 }).cg;
const V = 60;
function moments({ alpha = 2 * DEG, beta = 0, omega = [0, 0, 0], controls = {} } = {}) {
  const aero = new Aero(EXTRA);
  const vAir = [V * Math.cos(alpha) * Math.cos(beta), V * Math.sin(beta), V * Math.sin(alpha) * Math.cos(beta)];
  // settle the downwash lag
  let r;
  for (let i = 0; i < 400; i++) {
    r = aero.compute({ vAir, omega, cg, rho: 1.225, controls: { aileron: 0, elevator: 0, rudder: 0, ...controls }, slip: { dv: 0, swirl: 0, rot: 1 }, dt: 1 / 480 });
  }
  return r;
}

test('stick right rolls right, stick back pitches up, right pedal yaws right', () => {
  const base = moments();
  assert.ok(moments({ controls: { aileron: 0.5 } }).moment[0] - base.moment[0] > 500, 'roll');
  assert.ok(moments({ controls: { elevator: 0.5 } }).moment[1] - base.moment[1] > 500, 'pitch');
  assert.ok(moments({ controls: { rudder: 0.5 } }).moment[2] - base.moment[2] > 200, 'yaw');
});

test('static longitudinal stability: Cm_alpha < 0 (nose-down moment as alpha rises)', () => {
  const m1 = moments({ alpha: 0 }).moment[1];
  const m2 = moments({ alpha: 6 * DEG }).moment[1];
  assert.ok(m2 < m1, `${m1} → ${m2}`);
});

test('weathercock stability: Cn_beta > 0 (nose turns into a sideslip)', () => {
  const n = moments({ beta: 5 * DEG }).moment[2];
  assert.ok(n > 0, `Cn ${n}`);
});

test('roll, pitch and yaw rates are damped', () => {
  assert.ok(moments({ omega: [1, 0, 0] }).moment[0] < -1000, 'roll damping');
  assert.ok(moments({ omega: [0, 0.5, 0] }).moment[1] < -500, 'pitch damping');
  assert.ok(moments({ omega: [0, 0, 0.5] }).moment[2] < -100, 'yaw damping');
});

test('lift equals weight near 3.5° at 60 m/s (117 kt) — CL ≈ 0.33', () => {
  const lift = -moments({ alpha: 3.6 * DEG }).force[2];
  const w = 795 * 9.81;
  assert.ok(lift > 0.85 * w && lift < 1.15 * w, `lift ${lift} N vs weight ${w}`);
});

test('section: linear range, stall break, flat plate at 90°, reversed flow', () => {
  const g = EXTRA.aero.groupData.wing;
  const a10 = sectionCoefficients(10 * DEG, g);
  assert.ok(Math.abs(a10.cl - g.a * 10 * DEG) < 1e-9);
  const pre = sectionCoefficients(g.stall, g).cl;
  const post = sectionCoefficients(g.stall + 4 * DEG, g).cl;
  assert.ok(post < pre * 0.85, 'lift drops past the stall');
  const ninety = sectionCoefficients(90 * DEG, g);
  assert.ok(Math.abs(ninety.cl) < 0.05 && ninety.cd > 1.8, 'plate broadside');
  const back = sectionCoefficients(Math.PI - 5 * DEG, g);
  assert.ok(back.cl < 0, 'flying backwards a positive geometric AoA lifts the wrong way');
  assert.ok(sectionCoefficients(-10 * DEG, g).cl === -a10.cl, 'symmetric section');
});

test('flap effectiveness: 30 % chord ≈ 0.66 (thin-airfoil theory)', () => {
  assert.ok(Math.abs(flapTau(0.3) - 0.66) < 0.01);
});
