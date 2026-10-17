// The carrier: a deck to land on, a hull to hit, four arresting wires, and the demo pilot's approach
// flown into them in Node, as the plugin's demo (O, in the F-15) flies it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import F15 from '../src/sim/aircraft/f15c.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { buildMeigs } from '../src/world/meigs.js';
import { buildCarrier } from '../src/world/carrier.js';
import { Arrestor } from '../src/sim/arrestor.js';
import { CarrierPilot } from '../src/autopilot/carrierApproach.js';
import { buildCarrierModel, widthAt } from '../src/render/carrierModel.js';
import { KT } from '../src/sim/units.js';

function world() {
  const w = buildMeigs();
  const cv = buildCarrier(w);
  w.attachCarrier(cv);
  return { w, cv };
}

test('the carrier lies in open water, its deck 18.5 m above the lake, the landing area along 360°', () => {
  const { w, cv } = world();
  assert.ok(Math.abs(cv.deckH - (w.water + 18.5)) < 1e-9);
  assert.ok(Math.abs(cv.bearing) < 1e-9, 'angled deck along 360°');
  // everywhere round it is the lake
  for (const [s, t] of [[-80, 0], [400, 0], [150, -90], [150, 90]]) {
    const [n, e] = cv.toNE(s, t);
    assert.equal(w.ground(n, e).surface, 'water', `${s}, ${t}`);
  }
  // the wires and the aim point are on the deck, inside the landing area
  for (const wire of cv.wires) for (const [n, e] of wire.ends) assert.equal(w.ground(n, e).surface, 'deck');
  const [n, e] = cv.onLanding(cv.aimAlong);
  assert.equal(w.ground(n, e).surface, 'deck');
});

test('the deck holds up what is on it; beside the hull, far below the deck, is water; inside it is the ship', () => {
  const { w, cv } = world();
  const [n, e] = cv.toNE(150, 0);
  assert.equal(w.ground(n, e, -cv.deckH).surface, 'deck');
  assert.equal(w.ground(n, e, -(cv.deckH - 10)).surface, 'water', 'a point 10 m under the deck is not on it');
  assert.ok(cv.hullContains(n, e, cv.deckH - 5));
  assert.ok(!cv.hullContains(n, e, cv.deckH + 2));
  const [ni, ei] = cv.toNE(200, 20);
  assert.ok(cv.islandContains(ni, ei, cv.deckH + 10));
});

test('a trap: rolling over the wires at 135 kt with the hook down, a wire stops it on the deck in under 130 m', () => {
  const { w, cv } = world();
  const ac = new Aircraft(F15, { ground: w.ground, datumMsl: w.elevation });
  ac.arrestor = new Arrestor(cv);
  const [n, e] = cv.onLanding(30);
  ac.placeOnGround(n, e, cv.bearing);
  ac.setEngineRunning(true);
  const v = 135 * KT;
  ac.state.vel = [v * cv.axis[0], v * cv.axis[1], 0];
  ac.controls.hook = 1; ac.hookPos = 1; ac.controls.throttle = F15.jet.abDetent;
  let peak = 0;
  for (let t = 0; t < 6; t += 1 / 60) { ac.update(1 / 60); peak = Math.max(peak, -ac.out.specificForce[0] / 9.80665); }
  const trap = ac.events.find((x) => x.e === 'trap'), stop = ac.events.find((x) => x.e === 'stopped');
  assert.ok(trap && stop, ac.events.map((x) => x.e).join(' '));
  assert.ok(stop.runout > 60 && stop.runout < 130, `run-out ${stop.runout.toFixed(0)} m`);
  assert.ok(peak > 2 && peak < 5, `${peak.toFixed(1)} g`);
  assert.ok(ac.groundSpeed < 1 && !ac.damage.crashed);
  assert.equal(ac.gear.units[0].surface, 'deck');
});

test('a hook that skips a metre over the deck catches nothing: it rolls on over the wires', () => {
  const { w, cv } = world();
  const ac = new Aircraft(F15, { ground: w.ground, datumMsl: w.elevation });
  ac.arrestor = new Arrestor(cv);
  const [n, e] = cv.onLanding(30);
  ac.placeOnGround(n, e, cv.bearing);
  ac.setEngineRunning(true);
  ac.state.vel = [135 * KT * cv.axis[0], 135 * KT * cv.axis[1], 0];
  ac.controls.throttle = F15.jet.abDetent;
  // the hook skips: down, but held a metre off the deck — then up: no trap either way
  ac.controls.hook = 1; ac.hookPos = 1;
  const real = ac.arrestor.update.bind(ac.arrestor);
  ac.arrestor.update = (tip, ...rest) => real([tip[0], tip[1], tip[2] - 1], ...rest);
  for (let t = 0; t < 1.6; t += 1 / 60) ac.update(1 / 60);
  assert.ok(!ac.events.some((x) => x.e === 'trap'));
});

test('the demo pilot flies the ball from 3.2 km and the hook catches a wire (the 3-wire, as aimed)', () => {
  const { w, cv } = world();
  const ac = new Aircraft(F15, { ground: w.ground, datumMsl: w.elevation, load: { fuelCenterL: 2500, fuelWingsL: 0 } });
  ac.arrestor = new Arrestor(cv);
  const st = cv.approachStart(3200);
  ac.placeInFlight(st.n, st.e, w.elevation + st.h, st.heading, 140 * KT, 8 * Math.PI / 180);
  ac.controls.gear = 1; ac.gearPos = 1; ac.controls.hook = 1; ac.hookPos = 1; ac.controls.flaps = 1;
  const pilot = new CarrierPilot(ac, cv);
  let maxDev = 0;
  for (let t = 0; t < 60; t += 1 / 60) {
    pilot.step(1 / 60); ac.update(1 / 60);
    const tip = ac.hookTip;
    const behind = cv.aimAlong - cv.along(tip[0], tip[1]);
    if (pilot.phase === 'approach' && behind < 2500 && behind > 100) maxDev = Math.max(maxDev, Math.abs(cv.glideDeviation(tip[0], tip[1], -tip[2])));
  }
  assert.ok(pilot.trap, `no trap: ${JSON.stringify(pilot.events)}`);
  assert.ok(pilot.trap.wire >= 2 && pilot.trap.wire <= 4, `${pilot.trap.wire}-wire`);
  assert.ok(maxDev < 0.5, `on the glide slope within ${maxDev.toFixed(2)}°`);
  assert.equal(pilot.phase, 'stopped');
  assert.ok(!ac.damage.crashed && !ac.events.some((x) => /Strike/.test(x.e)), ac.events.map((x) => x.e).join(' '));
  const [n, e] = ac.state.pos;
  assert.equal(w.ground(n, e).surface, 'deck', 'stopped on the deck');
});

test('the Extra, without a hook, can stand on the deck', () => {
  const { w, cv } = world();
  const ac = new Aircraft(EXTRA, { ground: w.ground, datumMsl: w.elevation });
  const [n, e] = cv.onLanding(100);
  ac.placeOnGround(n, e, cv.bearing);
  for (let i = 0; i < 480 * 2; i++) ac.step(1 / 480);
  assert.ok(Math.abs(ac.agl - 1.2) < 0.4, `agl ${ac.agl.toFixed(2)}`);
  assert.ok(ac.altitudeMsl - w.elevation > cv.deckH, 'up on the deck');
});

test('model: the hull follows the deck outline, every part has geometry', () => {
  const { w, cv } = world();
  const parts = buildCarrierModel(cv, w.water);
  for (const p of parts) {
    assert.ok(p.mesh.vertexCount > 0, p.name);
    assert.ok(p.mesh.positions.every(Number.isFinite), p.name);
  }
  const [p0, s0] = widthAt(cv.data.deck, 160);
  assert.ok(s0 - p0 > 60, 'the flight deck is wide abeam the island');
  const b = parts.find((p) => p.name === 'hull').mesh.bounds();
  assert.ok(Math.abs(b.max[2] - b.min[2] - cv.data.length) < 2, `length ${(b.max[2] - b.min[2]).toFixed(1)}`);
});
