// Handling: what it takes to fly it. Torque effects at cruise, hands-off
// behaviour, and the keyboard pilot (force model, buffet feel, auto-rudder)
// flying a loop the way a pilot holding the stick back would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { ControlMapper, keyAuthority } from '../src/input/controlMapper.js';
import { Autopilot, fly, casKt } from './lib/pilot.js';
import { DEG } from '../src/sim/units.js';

const AIR = () => ({ h: -1e4, normal: [0, 0, -1], surface: 'asphalt' });
function level(kt, throttle = null) {
  const ac = new Aircraft(EXTRA, { ground: AIR });
  ac.placeInFlight(0, 0, 1500, 0, kt * 0.5144);
  fly(ac, new Autopilot(ac), throttle == null ? { alt: 1500, ias: kt } : { alt: 1500, throttle }, 40);
  return ac;
}
const flight = (ac) => ({ qbar: ac.out.qbar, alpha: ac.out.alpha, beta: ac.out.beta, yawRate: ac.state.omega[2], onGround: ac.gear.onGround });

test('cruise needs almost no rudder or aileron (torque effects fade with speed; tabs rigged for cruise)', () => {
  for (const kt of [120, 150]) {
    const ac = level(kt);
    assert.ok(Math.abs(ac.controls.rudder) < 0.05, `${kt} kt rudder ${ac.controls.rudder}`);
    assert.ok(Math.abs(ac.controls.aileron) < 0.03, `${kt} kt aileron ${ac.controls.aileron}`);
  }
});

test('slipstream swirl at the fin stays a couple of degrees in cruise', () => {
  const ac = level(150);
  const vFin = ac.out.tas + 0.9 * ac.prop.slipDv;
  const angle = Math.atan2(ac.prop.swirl, vFin) / DEG;
  assert.ok(angle < 2.5, `${angle.toFixed(1)}°`);
});

test('hands off at full power, 120 kt: wings stay within 5° for 3 s', () => {
  const ac = level(120, 1);
  ac.controls.aileron = 0; ac.controls.rudder = 0;
  const phi0 = ac.euler.phi;
  for (let i = 0; i < 180; i++) ac.update(1 / 60);
  assert.ok(Math.abs(ac.euler.phi - phi0) < 5 * DEG, `bank ${((ac.euler.phi - phi0) / DEG).toFixed(1)}°`);
});

test('keyboard: a held pull at 170 kt is a firm pilot pull (~4 g), not an instant 9 g stall', () => {
  const ac = level(170);
  const m = new ControlMapper(); m.throttle = ac.controls.throttle;
  let g = 0, stall = 0;
  for (let i = 0; i < 150; i++) {
    m.update({ keys: new Set(['ArrowDown']) }, 1 / 60, ac.controls, flight(ac));
    ac.update(1 / 60);
    g = Math.max(g, ac.out.loadFactor); stall = Math.max(stall, ac.aero.wingStallFraction());
  }
  assert.ok(g > 3.3 && g < 5.5, `${g.toFixed(1)} g`);
  assert.equal(stall, 0);
});

for (const entry of [140, 160]) {
  test(`keyboard loop from ${entry} kt: hold pull, full throttle — round, on line, no stall`, () => {
    const ac = level(entry);
    const m = new ControlMapper(); m.throttle = 1;
    const h0 = ac.altitudeMsl, psi0 = ac.euler.psi;
    let turned = 0, t = 0, minKt = 999, stalledFor = 0;
    while (turned < 2 * Math.PI && t < 20) {
      m.update({ keys: new Set(['ArrowDown']) }, 1 / 60, ac.controls, flight(ac));
      ac.update(1 / 60);
      t += 1 / 60;
      turned += ac.state.omega[1] / 60;
      minKt = Math.min(minKt, casKt(ac));
      if (ac.aero.wingStallFraction() > 0.5) stalledFor += 1 / 60;
    }
    assert.ok(turned >= 2 * Math.PI, 'went all the way round');
    assert.ok(t > 8 && t < 16, `${t.toFixed(1)} s`);
    assert.ok(minKt > 55 && minKt < 95, `over the top at ${minKt.toFixed(0)} kt`);
    assert.ok(stalledFor < 0.3, `stalled for ${stalledFor.toFixed(1)} s`);
    let dpsi = (ac.euler.psi - psi0) / DEG; dpsi = ((dpsi + 540) % 360) - 180;
    assert.ok(Math.abs(dpsi) < 10, `heading drifted ${dpsi.toFixed(0)}°`);
    assert.ok(Math.abs(ac.altitudeMsl - h0) < 120, `altitude change ${(ac.altitudeMsl - h0).toFixed(0)} m`);
  });
}

test('keyboard with Shift still pulls through the buffet into a stall', () => {
  const ac = level(110);
  const m = new ControlMapper(); m.throttle = ac.controls.throttle;
  let stall = 0;
  for (let i = 0; i < 180; i++) {
    m.update({ keys: new Set(['ArrowDown', 'Shift']) }, 1 / 60, ac.controls, flight(ac));
    ac.update(1 / 60);
    stall = Math.max(stall, ac.aero.wingStallFraction());
  }
  assert.ok(stall > 0.5, `stall fraction ${stall}`);
});

test('keyboard authority falls with dynamic pressure; full on the ground', () => {
  assert.equal(keyAuthority('elevator', 0), 1);
  assert.ok(keyAuthority('elevator', 4690) < 0.3);
  assert.ok(keyAuthority('elevator', 800) > 0.8);
  assert.ok(keyAuthority('aileron', 4690) < keyAuthority('aileron', 2000));
});

test('auto-rudder: works in the air, off on the ground, any rudder key overrides it', () => {
  const m = new ControlMapper();
  const c = {};
  for (let i = 0; i < 60; i++) m.update({ keys: new Set() }, 1 / 60, c, { qbar: 3000, beta: 3 * DEG });
  assert.ok(c.rudder > 0.1, `air: ${c.rudder}`);
  const g = new ControlMapper();
  for (let i = 0; i < 60; i++) g.update({ keys: new Set() }, 1 / 60, c, { qbar: 3000, beta: 3 * DEG, onGround: true });
  assert.equal(c.rudder, 0);
  for (let i = 0; i < 30; i++) m.update({ keys: new Set(['q']) }, 1 / 60, c, { qbar: 3000, beta: 3 * DEG });
  assert.ok(c.rudder < 0, 'left pedal wins');
  const off = new ControlMapper({ autoRudder: false });
  for (let i = 0; i < 60; i++) off.update({ keys: new Set() }, 1 / 60, c, { qbar: 3000, beta: 3 * DEG });
  assert.equal(c.rudder, 0);
});

// ── easy mode ──────────────────────────────────────────────────────────────
const easyFlight = (ac) => ({
  ...flight(ac), rollRate: ac.state.omega[0], heading: ac.euler.psi, bank: ac.euler.phi, pitch: ac.euler.theta, loadFactor: ac.out.loadFactor,
});
const PULLS = [
  ['Shift pull', { keys: new Set(['ArrowDown', 'Shift']) }],
  ['gamepad full back', { keys: new Set(), pad: { axes: [0, 1, 0, 0], buttons: [] } }],
  ['gamepad full back and rolling', { keys: new Set(), pad: { axes: [0.3, 1, 0, 0], buttons: [] } }],
  ['gamepad full forward', { keys: new Set(), pad: { axes: [0, -1, 0, 0], buttons: [] } }],
];
for (const [name, raw] of PULLS) {
  for (const kt of [100, 170]) {
    test(`easy mode: ${name} at ${kt} kt for 20 s never stalls the wing or passes 7 g`, () => {
      const ac = level(kt);
      const m = new ControlMapper({ easy: true }); m.throttle = 1;
      let stall = 0, g = 1;
      for (let i = 0; i < 60 * 20; i++) {
        m.update(raw, 1 / 60, ac.controls, easyFlight(ac));
        ac.update(1 / 60);
        if (casKt(ac) > 40) stall = Math.max(stall, ac.aero.wingStallFraction());
        g = Math.max(g, Math.abs(ac.out.loadFactor));
      }
      assert.equal(stall, 0, 'the wing stalled');
      assert.ok(g < 7.6, `${g.toFixed(1)} g`);
    });
  }
}

test('easy mode: full power, hands off — the takeoff roll stays straight and the climb wings-level', async () => {
  const { buildMeigs } = await import('../src/world/meigs.js');
  const world = buildMeigs();
  const ac = new Aircraft(EXTRA, { ground: world.ground, datumMsl: world.elevation });
  const s = world.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.engine.running = true; ac.rpm = 750;
  const m = new ControlMapper({ easy: true });
  let hdg = 0, bank = 0;
  for (let t = 0; t < 25; t += 1 / 60) {
    const keys = new Set(['End']);
    if (casKt(ac) > 60) keys.add('s');            // rotate and keep pulling: easy mode holds it off the stall
    m.update({ keys }, 1 / 60, ac.controls, easyFlight(ac));
    ac.update(1 / 60);
    const d = Math.abs(Math.atan2(Math.sin(ac.euler.psi - s.heading), Math.cos(ac.euler.psi - s.heading)));
    if (ac.gear.onGround) hdg = Math.max(hdg, d);
    if (ac.agl > 3 && ac.agl < 50) bank = Math.max(bank, Math.abs(ac.euler.phi));
  }
  assert.deepEqual(ac.events, [], 'nothing hit anything');
  assert.ok(hdg < 4 * DEG, `heading wandered ${(hdg / DEG).toFixed(1)}° on the roll`);
  assert.ok(bank < 10 * DEG, `banked ${(bank / DEG).toFixed(0)}° in the climb-out`);
  assert.ok(ac.agl > 100, `climbing: ${ac.agl.toFixed(0)} m`);
});

test('easy mode: the held-key loop still goes round', () => {
  const ac = level(160);
  const m = new ControlMapper({ easy: true }); m.throttle = 1;
  let turned = 0, t = 0;
  while (turned < 2 * Math.PI && t < 20) {
    m.update({ keys: new Set(['ArrowDown']) }, 1 / 60, ac.controls, easyFlight(ac));
    ac.update(1 / 60); t += 1 / 60;
    turned += ac.state.omega[1] / 60;
  }
  assert.ok(turned >= 2 * Math.PI, `got ${(turned / DEG).toFixed(0)}° round in ${t.toFixed(0)} s`);
});

// ── easy mode on a phone: one thumb ────────────────────────────────────────
function phoneTakeoff(stick) {
  const world = buildMeigsSync();
  const ac = new Aircraft(EXTRA, { ground: world.ground, datumMsl: world.elevation });
  const s = world.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.engine.running = true; ac.rpm = 750;
  const m = new ControlMapper({ easy: true }); m.throttle = 0.75;   // what the plugin sets on a phone
  const log = [];
  for (let t = 0; t < 40; t += 1 / 60) {
    const y = stick(t);
    m.update({ keys: new Set(), left: y ? { x: 0, y } : null }, 1 / 60, ac.controls, { ...easyFlight(ac), pitchRate: ac.state.omega[1] });
    ac.update(1 / 60);
    log.push({ t, along: ac.state.pos[0] - s.n, agl: ac.agl, pitch: ac.euler.theta, kt: casKt(ac), ground: ac.gear.onGround, events: ac.events.length });
  }
  return { ac, log };
}
import { buildMeigs as buildMeigsSync } from '../src/world/meigs.js';

test('phone, hands off: 75 % power, it rolls straight, rotates by itself and climbs away well inside the runway', () => {
  const { ac, log } = phoneTakeoff(() => 0);
  const off = log.find((r) => !r.ground && r.agl > 3);
  assert.ok(off, 'it lifted off');
  assert.ok(off.along < 450, `airborne ${off.along.toFixed(0)} m down the runway (1,200 m long)`);
  assert.deepEqual(ac.events, []);
  assert.ok(ac.agl > 150, `climbing: ${ac.agl.toFixed(0)} m at 40 s`);
});

test('phone: a thumb pulls, lets go, and the attitude it left is held (as far as the speed allows)', () => {
  const { log } = phoneTakeoff((t) => (t > 14 && t < 15.5 ? -0.4 : 0));   // stick 40 % down (back) for 1.5 s
  const late = log.filter((r) => r.t > 24);
  const p = late.map((r) => r.pitch / DEG);
  assert.ok(Math.max(...p) - Math.min(...p) < 4, `pitch wandered ${Math.min(...p).toFixed(1)}…${Math.max(...p).toFixed(1)}°`);
  assert.ok(Math.min(...late.map((r) => r.kt)) > 65, 'never slower than a safe climb');
  assert.equal(log[log.length - 1].events, 0);
});

test('phone: let go steeply nose-up and slow, it noses over by itself and flies on', () => {
  const ac = level(90);
  const m = new ControlMapper({ easy: true }); m.throttle = 0.75;
  // pull hard for 3 s, then let go
  let minAgl = Infinity;
  for (let t = 0; t < 30; t += 1 / 60) {
    const left = t < 3 ? { x: 0, y: -1 } : null;
    m.update({ keys: new Set(), left }, 1 / 60, ac.controls, { ...easyFlight(ac), pitchRate: ac.state.omega[1] });
    ac.update(1 / 60);
    if (t > 3) minAgl = Math.min(minAgl, ac.altitudeMsl);
  }
  assert.ok(casKt(ac) > 60, `flying at ${casKt(ac).toFixed(0)} kt`);
  assert.ok(Math.abs(ac.euler.theta) < 30 * DEG, `pitch ${(ac.euler.theta / DEG).toFixed(0)}°`);
  assert.ok(ac.aero.wingStallFraction() === 0);
});
