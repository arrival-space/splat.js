// The X-wing: invented to be fast, and to fly like a starfighter — the numbers the sim promises
// (tests pin them), its repulsorlifts, thrusters and S-foils, its model and its film.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import XW from '../src/sim/aircraft/xwing.js';
import { ControlMapper } from '../src/input/controlMapper.js';
import { buildMeigs } from '../src/world/meigs.js';
import { buildXwingModel, cannonTips } from '../src/render/xwingModel.js';
import { INTROS, introAt } from '../src/render/intro.js';
import { Autopilot, fly, casKt } from './lib/pilot.js';
import { DEG, KT } from '../src/sim/units.js';

const AIR = () => ({ h: -1e5, normal: [0, 0, -1], surface: 'asphalt' });

function topMach(alt, throttle, sfoils, seconds) {
  const ac = new Aircraft(XW, { ground: AIR });
  ac.placeInFlight(0, 0, alt, 0, 200);
  ac.controls.sfoils = sfoils; ac.sfoilPos = sfoils;
  fly(ac, new Autopilot(ac), { alt, throttle }, seconds);
  return ac.out.mach;
}

test('fast: Mach ~1.9 on the deck on boost in attack position, faster with the S-foils closed, past Mach 3 high up', () => {
  const open = topMach(300, 1, 1, 60), closed = topMach(300, 1, 0, 60), high = topMach(11000, 1, 0, 120);
  assert.ok(open > 1.75 && open < 2.1, `open M${open.toFixed(2)}`);
  assert.ok(closed > open + 0.05, `closed M${closed.toFixed(2)}`);
  assert.ok(high > 3.1, `high M${high.toFixed(2)}`);
});

test('repulsorlifts: slow and idle it sinks only gently, and the cushion settles it near the ground', () => {
  const w = buildMeigs();
  const ac = new Aircraft(XW, { ground: w.ground, datumMsl: w.elevation });
  const s = w.startPosition();
  ac.placeInFlight(s.n, s.e, w.elevation + 60, 0, 25);
  ac.controls.throttle = 0.25;
  let maxSink = 0;
  for (let t = 0; t < 20; t += 1 / 60) { ac.update(1 / 60); maxSink = Math.max(maxSink, ac.state.vel[2]); }
  assert.ok(maxSink < 4, `sink ${maxSink.toFixed(1)} m/s`);
});

test('parked at idle it sits on its gear; with throttle it lifts off within ~150 m', () => {
  const w = buildMeigs();
  const ac = new Aircraft(XW, { ground: w.ground, datumMsl: w.elevation });
  const s = w.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.setEngineRunning(true);
  for (let i = 0; i < 480; i++) ac.step(1 / 480);
  assert.ok(ac.gear.weightOnWheels > 0.8 * ac.mass * 9.80665, 'its weight on the wheels');
  const m = new ControlMapper({ easy: true, handling: XW.handling });
  m.throttle = 0.75;
  let off = null;
  for (let t = 0; t < 20; t += 1 / 60) {
    m.update({ keys: new Set() }, 1 / 60, ac.controls, ac.flightState());
    ac.update(1 / 60);
    if (!off && !ac.gear.onGround && ac.agl > 5) off = Math.hypot(ac.state.pos[0] - s.n, ac.state.pos[1] - s.e);
  }
  assert.ok(off && off < 150, `off after ${off?.toFixed(0)} m`);
  assert.equal(ac.events.length, 0, ac.events.map((e) => e.e).join(' '));
});

test('thrusters: full stick rolls ~190 °/s; a full pull turns at the full rate, no g limit, even at Mach 3 high up', () => {
  const a = new Aircraft(XW, { ground: AIR });
  a.placeInFlight(0, 0, 1000, 0, 200);
  let p = 0;
  for (let t = 0; t < 2; t += 1 / 60) { a.controls.aileron = 1; a.update(1 / 60); p = Math.max(p, a.state.omega[0]); }
  assert.ok(p / DEG > 160 && p / DEG < 230, `${(p / DEG).toFixed(0)} °/s`);
  const b = new Aircraft(XW, { ground: AIR });
  b.placeInFlight(0, 0, 1000, 0, 250);
  let g = 0;
  for (let t = 0; t < 4; t += 1 / 60) { b.controls.elevator = 1; b.update(1 / 60); g = Math.max(g, b.out.loadFactor); }
  assert.ok(g > 12, `${g.toFixed(1)} g`);
  // up high and fast: the nose still comes round at most of the rate, and the flight path follows it
  const c = new Aircraft(XW, { ground: AIR });
  c.placeInFlight(0, 0, 25000, 0, 1000);
  let q = 0;
  for (let t = 0; t < 0.6; t += 1 / 60) { c.controls.elevator = 1; c.update(1 / 60); q = Math.max(q, c.state.omega[1]); }
  c.controls.elevator = 0;
  for (let t = 0; t < 1; t += 1 / 60) c.update(1 / 60);
  assert.ok(q / DEG > 60, `${(q / DEG).toFixed(0)} °/s`);
  const v = c.state.vel, climb = Math.asin(-v[2] / Math.hypot(...v)) / DEG;
  assert.ok(climb > 30, `flight path ${climb.toFixed(0)}° up a second after a 0.6 s pull`);
});

test('S-foils: closed on the ground, they swing into attack position in a second once airborne', () => {
  const w = buildMeigs();
  const ac = new Aircraft(XW, { ground: w.ground, datumMsl: w.elevation });
  const s = w.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.controls.sfoils = 1;
  for (let i = 0; i < 480; i++) ac.step(1 / 480);
  assert.equal(ac.sfoilPos, 0);
  const air = new Aircraft(XW, { ground: AIR });
  air.placeInFlight(0, 0, 500, 0, 150);
  air.controls.sfoils = 1;
  for (let i = 0; i < 480 * 1.2; i++) air.step(1 / 480);
  assert.equal(air.sfoilPos, 1);
  // the cannons spread into the X: two up, two down, 5.3 m out
  const tips = cannonTips(1);
  assert.equal(tips.filter((p) => p[2] < -1).length, 2);
  assert.equal(tips.filter((p) => p[2] > 1).length, 2);
  for (const p of tips) assert.ok(Math.abs(Math.hypot(p[1], p[2] + Math.sign(p[2]) * 0) - 5.25) < 0.4);
});

test('model: 12.5 m long, ~10.6 m between the cannons, four S-foils with their glow, wheels on the contact points', () => {
  const parts = buildXwingModel();
  const stat = parts.filter((p) => !p.hinge).map((p) => p.mesh.bounds());
  const len = Math.max(...stat.map((b) => b.max[2])) - Math.min(...stat.map((b) => b.min[2]));
  assert.ok(len > 11.5 && len < 12.5, `fuselage ${len.toFixed(2)} m`);
  assert.equal(parts.filter((p) => p.kind === 'sfoil' && p.name.startsWith('sfoil') && !p.name.includes('-')).length, 4);
  assert.equal(parts.filter((p) => p.kind === 'engineGlow').length, 4);
  for (const [i, name] of [[0, 'wheelL'], [1, 'wheelR'], [2, 'nosewheel']]) {
    const u = XW.gear.units[i], w = parts.find((p) => p.name === name);
    assert.ok(Math.abs(w.hinge[2] + u.tyre.radius - u.pos[2]) < 1e-6, name);
  }
  for (const p of parts) assert.ok(p.mesh.vertexCount > 0 && p.mesh.positions.every(Number.isFinite), p.name);
});

test('intro: back-to-back shots above the ground and outside the ship, ending in the seat', () => {
  const film = INTROS.xwing;
  let t0 = 0;
  for (const s of film.shots) { assert.equal(s.t0, t0); assert.ok(film.cards[s.card]); t0 = s.t1; }
  for (let t = 0; t < film.length; t += 0.05) {
    const [x, y, z] = introAt(t, film).eye;
    assert.ok(z < 1.7 - 0.4, `t ${t.toFixed(2)} near the ground`);
    const inside = x > -3.5 && x < 9.2 && Math.abs(y) < 1.1 && z > -1.1 && z < 0.7;
    if (t < film.length - 2) assert.ok(!inside, `t ${t.toFixed(2)} inside the fuselage`);
  }
  assert.deepEqual(introAt(film.length - 1e-6, film).eye.map((v) => +v.toFixed(3)), XW.eye.map((v) => +v.toFixed(3)));
});
