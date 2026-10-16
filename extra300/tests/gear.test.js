// Ground handling: sitting on the gear, taxiing, braking, the tailwheel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { DEG } from '../src/sim/units.js';

const run = (ac, s) => { for (let i = 0; i < Math.round(s * 480); i++) ac.step(1 / 480); };
function parked() {
  const ac = new Aircraft(EXTRA);
  ac.placeOnGround(0, 0, 0);
  run(ac, 3);
  return ac;
}

test('settles three-point at ~10° nose up with ~10 % on the tailwheel', () => {
  const ac = parked();
  const e = ac.euler;
  assert.ok(e.theta > 8.5 * DEG && e.theta < 11.5 * DEG, `pitch ${e.theta / DEG}`);
  assert.ok(Math.abs(e.phi) < 0.5 * DEG, `roll ${e.phi / DEG}`);
  const [l, r, t] = ac.gear.units.map((u) => u.load);
  const w = ac.mass * 9.80665;
  assert.ok(Math.abs(l + r + t - w) / w < 0.01, 'gear carries the weight');
  assert.ok(t / w > 0.05 && t / w < 0.16, `tail share ${t / w}`);
  assert.ok(Math.abs(l - r) / w < 0.02, 'symmetric');
  assert.ok(Math.hypot(...ac.state.vel) < 0.01, 'at rest');
});

test('a 30 cm drop rebounds and settles without bouncing away', () => {
  const ac = parked();
  ac.state.pos[2] -= 0.3;
  let maxUp = 0;
  for (let i = 0; i < 480 * 4; i++) { ac.step(1 / 480); maxUp = Math.max(maxUp, -ac.state.vel[2]); }
  assert.ok(maxUp < 1.5, `rebound ${maxUp} m/s`);
  assert.ok(Math.abs(ac.state.vel[2]) < 0.02, 'settled');
});

test('parking brake holds against idle thrust', () => {
  const ac = parked();
  ac.engine.running = true; ac.rpm = 750; ac.controls.parkingBrake = true;
  const n0 = ac.state.pos[0];
  run(ac, 10);
  assert.ok(Math.abs(ac.state.pos[0] - n0) < 0.05, `crept ${ac.state.pos[0] - n0} m`);
});

test('taxi: rolls at idle-plus, brakes stop it from 30 kt inside 150 m', () => {
  const ac = parked();
  ac.state.vel = [15.4, 0, 0];
  ac.controls.brakeL = ac.controls.brakeR = 1;
  const n0 = ac.state.pos[0];
  run(ac, 15);
  assert.ok(ac.groundSpeed < 0.3, `still moving ${ac.groundSpeed}`);
  assert.ok(ac.state.pos[0] - n0 < 150, `stopping distance ${ac.state.pos[0] - n0}`);
  assert.ok(ac.euler.theta > 0, 'did not nose over');
});

test('right rudder steers the tailwheel right while taxiing', () => {
  const ac = parked();
  ac.engine.running = true; ac.rpm = 900;
  ac.controls.throttle = 0.2;
  ac.controls.rudder = 1;
  run(ac, 8);
  const psi = ac.euler.psi;
  assert.ok(psi > 20 * DEG && psi < 300 * DEG, `heading ${psi / DEG}`);
});

test('a prop strike on a nose-over stops the engine', () => {
  const ac = parked();
  ac.engine.running = true; ac.rpm = 2000;
  // pitch the nose into the ground
  ac.state.omega = [0, -3.5, 0];
  run(ac, 1.5);
  assert.ok(ac.damage.propStrike, 'strike registered');
  run(ac, 2);
  assert.equal(ac.engine.running, false);
});
