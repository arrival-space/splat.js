// The F-15C Eagle: the published figures its flight model is tuned to, and
// what it takes to fly it (easy mode, the one-thumb phone take-off, the gear).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import F15 from '../src/sim/aircraft/f15c.js';
import { ControlMapper } from '../src/input/controlMapper.js';
import { buildMeigs } from '../src/world/meigs.js';
import { Autopilot, fly, casKt } from './lib/pilot.js';
import { DEG, KT } from '../src/sim/units.js';
import { fromBody } from '../src/render/geometry.js';

const AIR = () => ({ h: -1e5, normal: [0, 0, -1], surface: 'asphalt' });
const GROUND = () => ({ h: 0, normal: [0, 0, -1], surface: 'asphalt' });

function topSpeed(alt, throttle, seconds) {
  const ac = new Aircraft(F15, { ground: AIR, load: { fuelCenterL: 4900, fuelWingsL: 2730 } });
  ac.placeInFlight(0, 0, alt, 0, alt > 5000 ? 350 : 250);
  fly(ac, new Autopilot(ac), { alt, throttle }, seconds);
  return ac.out.mach;
}

test('sea level: Mach 0.88-0.96 at military power, 1.18-1.32 with full burner (published ~800 KCAS limit, M 1.2)', () => {
  const dry = topSpeed(300, F15.jet.abDetent, 150);
  const ab = topSpeed(300, 1, 120);
  assert.ok(dry > 0.88 && dry < 0.96, `dry M${dry.toFixed(2)}`);
  assert.ok(ab > 1.18 && ab < 1.32, `burner M${ab.toFixed(2)}`);
});

test('36,000 ft: no supercruise to speak of (≤ M1.05 dry), M2.2+ with the burner (published M2.5)', () => {
  const dry = topSpeed(11000, F15.jet.abDetent, 250);
  const ab = topSpeed(11000, 1, 300);
  assert.ok(dry < 1.05, `dry M${dry.toFixed(2)}`);
  assert.ok(ab > 2.2, `burner M${ab.toFixed(2)}`);
});

test('engines: idle to military in ~4 s, the burner lights after that; 211 kN static, ~12 kg/s fuel', () => {
  const ac = new Aircraft(F15, { ground: GROUND });
  ac.placeOnGround(0, 0, 0);
  ac.setEngineRunning(true);
  ac.controls.parkingBrake = true;
  ac.controls.throttle = 1;
  let tMil = null;
  for (let i = 0; i < 480 * 10; i++) {
    ac.step(1 / 480);
    if (tMil == null && ac.engine.n2 > F15.jet.milN2 - 1) tMil = i / 480;
  }
  assert.ok(tMil > 2.5 && tMil < 5.5, `military at ${tMil.toFixed(1)} s`);
  assert.ok(Math.abs(ac.engine.thrust - 2 * F15.jet.maxThrust) < 3000, `${(ac.engine.thrust / 1000).toFixed(0)} kN`);
  assert.ok(ac.engine.fuelFlow > 10 && ac.engine.fuelFlow < 15, `${ac.engine.fuelFlow.toFixed(1)} kg/s`);
});

test('starter: the jet fuel starter spins a cold core to light-off and it runs up to idle by itself', () => {
  const ac = new Aircraft(F15, { ground: GROUND });
  ac.placeOnGround(0, 0, 0);
  ac.setEngineRunning(false);
  for (let i = 0; i < 480 * 20; i++) { ac.controls.starter = i < 480 * 8; ac.step(1 / 480); }
  assert.ok(ac.engine.running, 'running');
  assert.ok(Math.abs(ac.engine.n2 - F15.jet.idleN2) < 2, `N2 ${ac.engine.n2.toFixed(1)} %`);
});

test('roll rate at 350 KCAS, full stick: 170-260 °/s (ailerons and differential stabilators)', () => {
  const ac = new Aircraft(F15, { ground: AIR });
  ac.placeInFlight(0, 0, 3000, 0, 350 * KT);
  fly(ac, new Autopilot(ac), { alt: 3000, ias: 350 }, 5);
  let p = 0;
  for (let i = 0; i < 180; i++) { ac.controls.aileron = 1; ac.update(1 / 60); p = Math.max(p, ac.state.omega[0]); }
  assert.ok(p / DEG > 170 && p / DEG < 260, `${(p / DEG).toFixed(0)} °/s`);
});

test('gear down, flaps out: it stalls gently near 100 KCAS at 17 t and keeps flying nose-high (no departure)', () => {
  const ac = new Aircraft(F15, { ground: AIR });
  ac.placeInFlight(0, 0, 1500, 0, 90);
  ac.controls.gear = 1; ac.gearPos = 1;
  let broke = null, bankMax = 0;
  fly(ac, new Autopilot(ac), { alt: 1500, throttle: 0 }, 60, () => {
    if (broke == null && ac.aero.wingStallFraction() > 0.5) broke = casKt(ac);
    if (broke) bankMax = Math.max(bankMax, Math.abs(ac.euler.phi));
  }, 0.1);
  assert.ok(broke > 90 && broke < 120, `stall ${broke?.toFixed(0)} KCAS`);
  assert.ok(bankMax < 20 * DEG, `bank ${(bankMax / DEG).toFixed(0)}°`);
});

test('gear: comes up in the air, never with weight on the wheels; flaps follow it', () => {
  const ac = new Aircraft(F15, { ground: GROUND });
  ac.placeOnGround(0, 0, 0);
  ac.controls.gear = 0;
  for (let i = 0; i < 480 * 2; i++) ac.step(1 / 480);
  assert.equal(ac.gearPos, 1, 'still down on the ground');
  const air = new Aircraft(F15, { ground: AIR });
  air.placeInFlight(0, 0, 1000, 0, 120);
  assert.equal(air.gearPos, 0, 'a jet starts in the air with the wheels up');
  air.controls.gear = 1;
  fly(air, new Autopilot(air), { alt: 1000, ias: 200 }, 8);
  assert.equal(air.gearPos, 1);
  assert.ok(air.controls.flaps > 0.9, 'flaps out with the gear');
});

// ── easy mode, one thumb ───────────────────────────────────────────────────
function phoneTakeoff(stick, seconds = 40) {
  const world = buildMeigs();
  const ac = new Aircraft(F15, { ground: world.ground, datumMsl: world.elevation });
  const s = world.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.setEngineRunning(true);
  const m = new ControlMapper({ easy: true, handling: F15.handling }); m.throttle = 0.75;
  const log = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    const y = stick(t);
    m.update({ keys: new Set(), left: y ? { x: 0, y } : null }, 1 / 60, ac.controls, ac.flightState());
    ac.update(1 / 60);
    const off = Math.abs((ac.state.pos[1] - s.e) * Math.cos(s.heading) - (ac.state.pos[0] - s.n) * Math.sin(s.heading));
    log.push({ t, along: Math.hypot(ac.state.pos[0] - s.n, ac.state.pos[1] - s.e), off, agl: ac.agl, pitch: ac.euler.theta, kt: casKt(ac), ground: ac.gear.onGround, gear: ac.gearPos });
  }
  return { ac, log };
}

test('phone, hands off, easy: it rolls straight, rotates by itself and is off well inside Meigs\' 1,200 m, gear up after', () => {
  const { ac, log } = phoneTakeoff(() => 0);
  const off = log.find((r) => !r.ground && r.agl > 6);
  assert.ok(off, 'it lifted off');
  assert.ok(off.along < 900, `airborne ${off.along.toFixed(0)} m down the runway`);
  assert.ok(Math.max(...log.filter((r) => r.ground).map((r) => r.off)) < 6, 'kept on the centreline');
  assert.deepEqual(ac.events.map((e) => e.e), []);
  assert.ok(ac.agl > 300, `climbing: ${ac.agl.toFixed(0)} m`);
  assert.equal(ac.gearPos, 0, 'gear up');
  const pitches = log.filter((r) => r.t > 25).map((r) => r.pitch / DEG);
  assert.ok(Math.max(...pitches) < 26, `pitch ${Math.max(...pitches).toFixed(0)}°`);
});

test('easy: a full pull at 400 kt stays within its g and α limits', () => {
  const ac = new Aircraft(F15, { ground: AIR });
  ac.placeInFlight(0, 0, 3000, 0, 400 * KT);
  fly(ac, new Autopilot(ac), { alt: 3000, ias: 400 }, 3);
  const m = new ControlMapper({ easy: true, handling: F15.handling });
  m.throttle = 0.8;
  let g = 0, a = 0;
  for (let t = 0; t < 6; t += 1 / 60) {
    m.update({ keys: new Set(), pad: { axes: [0, 1, 0, 0], buttons: [] } }, 1 / 60, ac.controls, ac.flightState());
    ac.update(1 / 60);
    g = Math.max(g, ac.out.loadFactor); a = Math.max(a, ac.out.alpha);
  }
  assert.ok(g < F15.handling.easy.gMax + 0.8, `${g.toFixed(1)} g`);
  assert.ok(a < F15.handling.easy.alphaMax + 3 * DEG, `α ${(a / DEG).toFixed(1)}°`);
});

test('keyboard: a held pull at 350 kt is a firm 5-8 g, not a 10 g overstress', () => {
  const ac = new Aircraft(F15, { ground: AIR });
  ac.placeInFlight(0, 0, 3000, 0, 350 * KT);
  fly(ac, new Autopilot(ac), { alt: 3000, ias: 350 }, 3);
  const m = new ControlMapper({ handling: F15.handling });
  m.throttle = 0.8;
  let g = 0;
  for (let t = 0; t < 3; t += 1 / 60) {
    m.update({ keys: new Set(['ArrowDown']) }, 1 / 60, ac.controls, ac.flightState());
    ac.update(1 / 60);
    g = Math.max(g, ac.out.loadFactor);
  }
  assert.ok(g > 5 && g < 8, `${g.toFixed(1)} g`);
});

// ── the 3D model and the intro film ─────────────────────────────────────────
import { buildF15Model } from '../src/render/f15Model.js';
import { INTROS, introAt } from '../src/render/intro.js';
import { PROFILES } from '../src/plugin/profiles.js';

test('model: 13.05 m span, 19.4 m long, 5.6 m tall on its wheels (published 13.05 / 19.43 / 5.63)', () => {
  const parts = buildF15Model().filter((p) => p.kind !== 'abFlame');
  const b = parts.map((p) => p.mesh.bounds());
  const min = [0, 1, 2].map((k) => Math.min(...b.map((x) => x.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...b.map((x) => x.max[k])));
  // render axes: x = body y (span), y = −body z (up), z = −body x (aft); moving parts are hinge-relative,
  // so the static parts carry the outline (the stabilators' tips are on their own nodes)
  const stat = parts.filter((p) => !p.hinge).map((p) => p.mesh.bounds());
  const sMin = [0, 1, 2].map((k) => Math.min(...stat.map((x) => x.min[k])));
  const sMax = [0, 1, 2].map((k) => Math.max(...stat.map((x) => x.max[k])));
  assert.ok(Math.abs(sMax[0] - sMin[0] - 13.05) < 0.12, `span ${(sMax[0] - sMin[0]).toFixed(2)}`);
  assert.ok(Math.abs(sMax[2] - sMin[2] - 19.3) < 0.25, `length ${(sMax[2] - sMin[2]).toFixed(2)}`);
  const ground = F15.gear.units[0].pos[2] - 0.12;   // static, the struts compressed
  assert.ok(Math.abs(sMax[1] + ground - 5.63) < 0.12, `height ${(sMax[1] + ground).toFixed(2)}`);
  assert.ok(min.every(Number.isFinite) && max.every(Number.isFinite));
});

test('model: every part has geometry, finite numbers, indices a Uint16 can hold', () => {
  for (const p of buildF15Model()) {
    assert.ok(p.mesh.vertexCount > 0 && p.mesh.vertexCount < 65536, p.name);
    assert.ok(p.mesh.positions.every(Number.isFinite), p.name);
    assert.ok(p.mesh.indices.every((i) => i < p.mesh.vertexCount), p.name);
  }
});

test('model: the wheels sit on the gear model\'s contact points, on legs that fold, the eye under the bubble', () => {
  const parts = buildF15Model();
  for (const [i, name] of [[0, 'wheelL'], [1, 'wheelR'], [2, 'nosewheel']]) {
    const u = F15.gear.units[i];
    const w = parts.find((p) => p.name === name);
    assert.ok(Math.abs(w.hinge[2] + u.tyre.radius - u.pos[2]) < 1e-6, `${name} hub + radius = contact`);
    assert.ok(Math.abs(w.hinge[0] - u.pos[0]) < 1e-6 && Math.abs(w.hinge[1] - u.pos[1]) < 1e-6, name);
    const leg = parts.find((p) => p.name === w.parent);
    assert.ok(leg && leg.kind === 'gearLeg' && leg.fold > 45, `${name} rides on a folding leg`);
  }
  const canopy = parts.find((p) => p.name === 'canopy').mesh.bounds();
  const eye = fromBody(F15.eye);
  assert.ok(eye[1] < canopy.max[1] - 0.1 && eye[2] > canopy.min[2] && eye[2] < canopy.max[2], 'eye inside the canopy');
  for (const k of ['stabilator', 'rudder', 'aileron', 'flap', 'speedbrake', 'abFlame', 'stick']) {
    assert.ok(parts.some((p) => p.kind === k), k);
  }
});

test('intro: back-to-back shots with captions, above the ground and outside the jet until the cockpit', () => {
  const film = INTROS.f15c;
  let t = 0;
  for (const s of film.shots) {
    assert.equal(s.t0, t);
    assert.ok(film.cards[s.card], `card ${s.card}`);
    t = s.t1;
  }
  assert.equal(t, film.length);
  const groundZ = F15.gear.units[0].pos[2] - 0.12;
  for (let t = 0; t < film.length; t += 0.05) {
    const { eye } = introAt(t, film);
    const [x, y, z] = eye;
    assert.ok(z < groundZ - 0.4, `t ${t.toFixed(2)}: eye near the ground`);
    const inside = x > -8.4 && x < 11 && Math.abs(y) < 1.7 && z > -1.5 && z < 0.8;
    if (t < film.length - 2) assert.ok(!inside, `t ${t.toFixed(2)}: eye inside the jet ${eye.map((v) => v.toFixed(2))}`);
  }
  assert.deepEqual(introAt(film.length - 1e-6, film).eye.map((v) => +v.toFixed(3)), F15.eye.map((v) => +v.toFixed(3)));
});

test('intro: the jet fuel starter lights both engines in its window and they run up to idle', () => {
  const film = INTROS.f15c;
  const ac = new Aircraft(F15, { ground: GROUND });
  ac.placeOnGround(0, 0, 0);
  ac.setEngineRunning(false);
  let litAt = null;
  for (let t = 0; t < 15; t += 1 / 60) {
    const c = ac.controls;
    c.throttle = 0; c.parkingBrake = true;
    c.starter = t > film.starter[0] && t < film.starter[1] && !ac.engine.running;
    ac.update(1 / 60);
    if (litAt == null && ac.engine.running) litAt = t;
  }
  assert.ok(litAt != null && litAt < film.starter[1], `lit at ${litAt}`);
  assert.ok(Math.abs(ac.engine.n2 - F15.jet.idleN2) < 2, `N2 ${ac.engine.n2.toFixed(1)} %`);
});

test('profiles: both airplanes have a model, a film, a display, cards and help', () => {
  for (const p of Object.values(PROFILES)) {
    assert.ok(p.buildModel().length > 10, p.id);
    assert.ok(p.intro.length > 15 && p.intro.cards.length === p.intro.shots.length, p.id);
    assert.ok(p.quick.length && p.quickMobile.length && p.help.length, p.id);
    assert.ok(['gauges', 'hud'].includes(p.display), p.id);
  }
});
