// The gauges behave like their real counterparts: lags, errors and all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Aircraft } from '../src/sim/aircraft.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { Instruments } from '../src/instruments/instruments.js';
import { atmosphere } from '../src/sim/atmosphere.js';
import { qFromEuler, qRotateInv } from '../src/math/quat.js';
import { DEG, FT, G0, INHG, KT } from '../src/sim/units.js';

const AIR = () => ({ h: -1e4, normal: [0, 0, -1], surface: 'asphalt' });

/** A frozen aircraft we can pose by hand: only `out`, `state` and `engine` matter to the gauges. */
function posed({ tas = 60, alt = 1000, alpha = 2 * DEG, beta = 0, pitch = alpha, roll = 0, heading = 0, f = null } = {}) {
  const ac = new Aircraft(EXTRA, { ground: AIR });
  ac.state.pos = [0, 0, -alt];
  ac.state.q = qFromEuler(roll, pitch, heading);
  ac.out.atm = atmosphere(alt);
  ac.out.tas = tas;
  ac.out.vAirBody = [tas * Math.cos(alpha) * Math.cos(beta), tas * Math.sin(beta), tas * Math.sin(alpha)];
  ac.out.alpha = alpha;
  // unaccelerated flight: the specific force is gravity's reaction, expressed in body axes
  ac.out.specificForce = f || qRotateInv(ac.state.q, [0, 0, -G0]);
  ac.out.loadFactor = -(ac.out.specificForce[2]) / G0;
  return ac;
}
const settle = (ins, ac, s = 5) => { let v; for (let i = 0; i < s * 60; i++) v = ins.update(ac, 1 / 60); return v; };

test('ASI reads CAS: 100 kt TAS at sea level reads 100', () => {
  const ac = posed({ tas: 100 * KT, alt: 0 });
  const v = settle(new Instruments(EXTRA), ac);
  assert.ok(Math.abs(v.ias - 100) < 0.5, `${v.ias}`);
});

test('ASI under-reads at extreme angle of attack (pitot loses total pressure)', () => {
  const ins = new Instruments(EXTRA);
  const low = settle(ins, posed({ tas: 35, alpha: 5 * DEG })).ias;
  const ins2 = new Instruments(EXTRA);
  const high = settle(ins2, posed({ tas: 35, alpha: 40 * DEG })).ias;
  assert.ok(high < low * 0.8, `${low} vs ${high}`);
});

test('altimeter reads field elevation at 29.92 on a standard day', () => {
  const ac = posed({ alt: 593 * FT });
  const v = settle(new Instruments(EXTRA), ac);
  assert.ok(Math.abs(v.altitude - 593) < 2, `${v.altitude}`);
});

test('VSI lags: ~6 s to show most of a step climb', () => {
  const ins = new Instruments(EXTRA);
  const ac = posed({ alt: 1000 });
  settle(ins, ac, 10);
  // climb at 2000 fpm
  const rate = 2000 * FT / 60;
  let at2 = 0, at10 = 0;
  for (let i = 1; i <= 600; i++) {
    ac.state.pos[2] -= rate / 60;
    ac.out.atm = atmosphere(-ac.state.pos[2]);
    const v = ins.update(ac, 1 / 60);
    if (i === 120) at2 = v.vsi;
    if (i === 600) at10 = v.vsi;
  }
  assert.ok(at2 < 1600 && at2 > 500, `after 2 s: ${at2}`);
  assert.ok(Math.abs(at10 - 2000) < 250, `after 10 s: ${at10}`);
});

test('g-meter: needle follows load factor, tell-tales keep the extremes until reset', () => {
  const ins = new Instruments(EXTRA);
  settle(ins, posed({ f: [0, 0, -6 * G0] }), 2);
  const v = settle(ins, posed({ f: [0, 0, 2 * G0] }), 2);
  assert.ok(Math.abs(v.g + 2) < 0.1, `needle ${v.g}`);
  assert.ok(v.gMax > 5.8 && v.gMin < -1.9);
  ins.resetG();
  const w = ins.update(posed(), 1 / 60);
  assert.ok(w.gMax < 2 && w.gMin > -2.1);
});

test('compass: reads magnetic heading (≈ true + 2° in Chicago) in steady level flight', () => {
  for (const hdg of [0, 90, 180, 270]) {
    const v = settle(new Instruments(EXTRA), posed({ heading: hdg * DEG }), 8);
    let err = v.compass - (hdg + 2);
    err = ((err + 540) % 360) - 180;
    assert.ok(Math.abs(err) < 1.0, `hdg ${hdg}: compass ${v.compass}`);
  }
});

test('compass: northerly turning error — banked turn through north lags (reads toward the turn less)', () => {
  // heading north, 30° bank coordinated right turn: apparent gravity tilts the card;
  // the classic error is that the compass initially shows a turn the *opposite* way
  const g = G0 / Math.cos(30 * DEG);
  const v = settle(new Instruments(EXTRA), posed({ heading: 0, roll: 30 * DEG, pitch: 0, f: [0, 0, -g] }), 3);
  let reading = ((v.compass + 180) % 360) - 180;
  assert.ok(reading < -5, `reads ${reading.toFixed(1)}° (should swing west of north)`);
});

test('slip ball goes toward the low wing in a slip', () => {
  const v = settle(new Instruments(EXTRA), posed({ f: [0, -2, -G0] }), 2);
  assert.ok(v.ball > 0.3, `ball ${v.ball}`);
});

test('kollsman knob moves the altimeter ~1,000 ft per inch', () => {
  const ins = new Instruments(EXTRA);
  const ac = posed({ alt: 1000 });
  const a = settle(ins, ac).altitude;
  ins.setKollsmanInHg(30.92);
  const b = settle(ins, ac).altitude;
  assert.ok(Math.abs(b - a - 940) < 80, `${b - a}`);
  assert.ok(Math.abs(ins.values.kollsmanInHg - 30.92) < 1e-9);
  void INHG;
});

test('stall warning: sounds at high α in flight, silent below 40 kt (taxiing, tail down)', () => {
  const warn = (kt) => {
    const ac = posed({ tas: kt * KT, alt: 0, alpha: 17 * DEG });
    ac.out.qbar = 0.5 * 1.225 * (kt * KT) ** 2;
    return new Instruments(EXTRA).update(ac, 1 / 60).stallWarning;
  };
  assert.equal(warn(60), true);
  assert.equal(warn(45), true);
  assert.equal(warn(35), false);
  assert.equal(warn(10), false);
});
