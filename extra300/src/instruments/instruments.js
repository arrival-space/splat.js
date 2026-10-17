// instruments.js — what the pilot reads, as opposed to what the airframe does.
//
// Every gauge here is a small physical model of the real instrument fed
// from the flight model, so its errors and lags are the instrument's own:
//   ASI        pitot impact pressure (loses it at high AoA/sideslip), needle lag
//   altimeter  static pressure through a Kollsman window, slight static lag
//   VSI        a capsule with a calibrated leak — the classic 6-second lag
//   G-meter    accelerometer needle with max/min tell-tales and a reset knob
//   compass    pendulous magnetic card: northerly turning and acceleration
//              errors fall out of the dip angle, the card swings in its fluid
//   ball       inclinometer in a curved tube
// Engine gauges read the engine model through their own sender lags.

import { qRotateInv } from '../math/quat.js';
import { casFromImpact, P0, pressureAltitude } from '../sim/atmosphere.js';
import { clamp, DEG, FT, G0, INHG, KT, lag } from '../sim/units.js';

/** Second-order needle (spring + fluid/eddy-current damping). */
export class Needle {
  constructor(wn, zeta, value = 0) { this.wn = wn; this.zeta = zeta; this.x = value; this.v = 0; }
  step(target, dt) {
    // sub-step for stiff needles at low frame rates
    const n = Math.max(1, Math.ceil(dt * this.wn * 4));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = this.wn * this.wn * (target - this.x) - 2 * this.zeta * this.wn * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

// Chicago, 1990s: magnetic variation ~2° W, dip ~70° (NOAA historical model)
export const CHICAGO_FIELD = { declination: -2.0 * DEG, inclination: 70.5 * DEG };

export class Instruments {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.field = opts.field || CHICAGO_FIELD;
    this.kollsman = opts.kollsman ?? P0;          // Pa, altimeter setting
    this.pStatic = null;
    this.vsiCase = null;
    this.asi = new Needle(14, 0.8);
    this.vsiNeedle = new Needle(6, 0.9);
    this.gNeedle = new Needle(16, 0.55, 1);
    this.gMax = 1; this.gMin = 1;
    this.card = { angle: 0, rate: 0 };
    this.ball = new Needle(7, 0.45);
    this.values = {};
    this._compassReady = false;
  }

  resetG() { this.gMax = 1; this.gMin = 1; }

  /** Kollsman window in inHg, as the knob is labelled. */
  setKollsmanInHg(inHg) { this.kollsman = inHg * INHG; }

  /**
   * @param {object} ac  the Aircraft (sim/aircraft.js)
   * @param {number} dt
   */
  update(ac, dt) {
    const o = ac.out;
    const atm = o.atm;
    const v = this.values;

    // ── pitot-static ──────────────────────────────────────────────────────
    // a pitot tube reads the flow component along its axis; past ~25° it
    // stops recovering total pressure altogether
    const vb = o.vAirBody;
    const flowAngle = Math.acos(clamp(vb[0] / Math.max(o.tas, 0.1), -1, 1));
    const recovery = flowAngle < 20 * DEG ? 1 : flowAngle > 55 * DEG ? 0 : Math.cos(((flowAngle - 20 * DEG) / (35 * DEG)) * (Math.PI / 2));
    const M = o.tas / atm.a;
    const qc = Math.max(0, vb[0]) > 0 ? atm.p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1) * recovery : 0;
    const ias = casFromImpact(qc) / KT;
    v.ias = this.asi.step(ias, dt);

    this.pStatic = this.pStatic == null ? atm.p : lag(this.pStatic, atm.p, 0.25, dt);
    const hInd = pressureAltitude(this.pStatic, this.kollsman) / FT;   // ft
    v.altitude = hInd;
    v.kollsmanInHg = this.kollsman / INHG;

    // VSI: the case fills through a calibrated leak (τ ≈ 4 s); the capsule reads the difference
    const tau = 4.0;
    if (this.vsiCase == null) this.vsiCase = hInd;
    this.vsiCase = lag(this.vsiCase, hInd, tau, dt);
    const fpm = ((hInd - this.vsiCase) / tau) * 60;
    v.vsi = this.vsiNeedle.step(clamp(fpm, -6500, 6500), dt);

    // ── accelerometer ─────────────────────────────────────────────────────
    const g = this.gNeedle.step(o.loadFactor, dt);
    v.g = g;
    this.gMax = Math.max(this.gMax, g);
    this.gMin = Math.min(this.gMin, g);
    v.gMax = this.gMax; v.gMin = this.gMin;

    // ── ball ──────────────────────────────────────────────────────────────
    const f = o.specificForce;
    const ballAngle = Math.atan2(-f[1], Math.max(0.5, -f[2]));
    v.ball = clamp(this.ball.step(ballAngle / (14 * DEG), dt), -1, 1);

    // ── magnetic compass ─────────────────────────────────────────────────
    v.compass = this.compass(ac, dt);
    v.heading = ac.euler.psi / DEG;   // true heading, for the HUD only

    // ── air data and attitude for a head-up display ─────────────────────
    v.mach = M;
    v.aoa = o.alpha / DEG;
    const eu = ac.euler;
    v.pitch = eu.theta / DEG;
    v.bank = eu.phi / DEG;
    v.flightPath = Math.atan2(-ac.state.vel[2], Math.max(0.1, Math.hypot(ac.state.vel[0], ac.state.vel[1]))) / DEG;
    v.drift = Math.atan2(vb[1], Math.max(0.1, vb[0])) / DEG;

    // ── engine ───────────────────────────────────────────────────────────
    const e = ac.engine;
    v.rpm = v.rpm == null ? ac.rpm : lag(v.rpm, ac.rpm, 0.12, dt);
    if (ac.jet) {
      // the F-15's engine strip: core speed %, turbine temperature, fuel flow (lb/h), fuel (lb), nozzle
      v.n2 = v.rpm;
      v.ftit = e.ftit;
      const pph = (e.fuelFlow * 3600) / 0.45359237;
      v.fuelFlow = v.fuelFlow == null ? pph : lag(v.fuelFlow, pph, 0.8, dt);
      v.fuelLb = (ac.fuelL * ac.spec.mass.fuelDensity) / 0.45359237;
      v.nozzle = e.nozzle * 100;
      v.ab = e.ab;
      v.oilPress = e.oilPress;
      v.oat = atm.T - 273.15;
      // the AoA tone: once the wing is well into its stall (a thin swept wing rounds over gently)
      v.stallWarning = M * atm.a > 20 && ac.aero.wingStallFraction() > 0.3;
      return v;
    }
    v.mp = v.mp == null ? e.mp / INHG : lag(v.mp, e.mp / INHG, 0.25, dt);
    const gph = (e.fuelFlow / ac.spec.mass.fuelDensity) * 3600 / 3.785411784;
    v.fuelFlow = v.fuelFlow == null ? gph : lag(v.fuelFlow, gph, 0.8, dt);
    v.oilTempF = e.oilTemp * 9 / 5 + 32;
    v.oilPress = e.oilPress;
    v.chtF = e.cht * 9 / 5 + 32;
    v.egtF = e.egt * 9 / 5 + 32;
    v.fuelCenterL = ac.load.fuelCenterL;
    v.fuelWingsL = ac.load.fuelWingsL;
    v.oat = atm.T - 273.15;
    // the vane only speaks with air over it: nothing below ~40 kt (taxiing, tail down, in a gust)
    const casKt = Math.sqrt(2 * Math.max(0, o.qbar) / 1.225) / 0.514444;
    v.stallWarning = casKt > 40 && (ac.aero.wingStallFraction() > 0 || (Math.abs(o.alpha) > 15 * DEG && Math.abs(o.alpha) < 60 * DEG));
    return v;
  }

  /** Pendulous card: aligns with the field projected onto the plane normal to apparent gravity. */
  compass(ac, dt) {
    const { declination: D, inclination: I } = this.field;
    const Bn = [Math.cos(I) * Math.cos(D), Math.cos(I) * Math.sin(D), Math.sin(I)];
    const B = qRotateInv(ac.state.q, Bn);
    // apparent vertical in body axes, limited by the card's ±18° tilt freedom
    const f = ac.out.specificForce;
    let n = [-f[0], -f[1], -f[2]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    n = nl > 0.5 ? [n[0] / nl, n[1] / nl, n[2] / nl] : [0, 0, 1];
    const tilt = Math.acos(clamp(n[2], -1, 1));
    const maxTilt = 18 * DEG;
    if (tilt > maxTilt) {
      const h = Math.hypot(n[0], n[1]) || 1;
      n = [(n[0] / h) * Math.sin(maxTilt), (n[1] / h) * Math.sin(maxTilt), Math.cos(maxTilt)];
    }
    const bn = B[0] * n[0] + B[1] * n[1] + B[2] * n[2];
    const Bp = [B[0] - bn * n[0], B[1] - bn * n[1], B[2] - bn * n[2]];
    const xn = n[0];
    const e1 = [1 - xn * n[0], -xn * n[1], -xn * n[2]];
    const e1l = Math.hypot(e1[0], e1[1], e1[2]) || 1;
    e1[0] /= e1l; e1[1] /= e1l; e1[2] /= e1l;
    const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    let target = Math.atan2(-(Bp[0] * e2[0] + Bp[1] * e2[1] + Bp[2] * e2[2]), Bp[0] * e1[0] + Bp[1] * e1[1] + Bp[2] * e1[2]);
    if (!this._compassReady) { this.card.angle = target; this._compassReady = true; }
    // card dynamics in its fluid: underdamped, so it swings after a turn
    let err = target - this.card.angle;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const wn = 2.6, zeta = 0.35;
    const n2 = Math.max(1, Math.ceil(dt * 20));
    for (let i = 0; i < n2; i++) {
      const h = dt / n2;
      this.card.rate += (wn * wn * err - 2 * zeta * wn * this.card.rate) * h;
      this.card.angle += this.card.rate * h;
      err -= this.card.rate * h;
    }
    let deg = this.card.angle / DEG;
    deg = ((deg % 360) + 360) % 360;
    return deg;
  }
}

export const G_EARTH = G0;
