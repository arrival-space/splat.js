// engine.js — Lycoming AEIO-540 as a breathing pump.
//
// Manifold pressure is not a lookup: it is where the air the throttle plate
// lets through equals what the cylinders swallow at this rpm. That one
// balance gives the familiar behaviour for free — MP falls as rpm rises at a
// fixed throttle, full throttle loses MP with altitude, idle MP is low.
// Power then follows MP × rpm above a zero-work line, minus friction.

import { P0, T0 } from './atmosphere.js';
import { clamp, HP, lag, RPM } from './units.js';

const GAMMA = 1.4;
const R_CRIT = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1)); // 0.528

const psiRaw = (r) => Math.sqrt(Math.max(0, Math.pow(r, 2 / GAMMA) - Math.pow(r, (GAMMA + 1) / GAMMA)));
const PSI_MAX = psiRaw(R_CRIT);
/** Normalised compressible orifice flow function: 1 when choked, 0 at no pressure drop. */
export const orificeFlow = (r) => (r <= R_CRIT ? 1 : psiRaw(Math.min(r, 1)) / PSI_MAX);

export class Engine {
  constructor(spec) {
    this.spec = spec;
    // calibrate the throttle body from two published points: full-throttle loss and idle MP
    const rFull = (P0 - spec.intakeLossFull) / P0;
    this.kappa = (rFull * spec.ratedRpm) / orificeFlow(rFull);
    const rIdle = spec.idleMp / P0;
    this.areaIdle = (rIdle * spec.idleRpm) / (this.kappa * orificeFlow(rIdle));
    this.cInd = (spec.ratedPower + spec.frictionPowerRated) / ((P0 - spec.intakeLossFull - spec.mpZeroWork) * spec.ratedRpm);

    this.running = false;
    this.mp = P0;           // Pa
    this.power = 0;         // W at the shaft (negative = engine braking)
    this.torque = 0;        // N m at the shaft
    this.fuelFlow = 0;      // kg/s
    this.oilTemp = 15;      // °C
    this.oilPress = 0;      // psi
    this.cht = 15;          // °C
    this.egt = 15;          // °C
  }

  throttleArea(t) {
    const th = clamp(t, 0, 1);
    return this.areaIdle + (1 - this.areaIdle) * (1 - Math.cos((th * Math.PI) / 2));
  }

  /** Manifold pressure (Pa) where throttle flow equals cylinder demand. */
  manifold(throttle, rpm, pInlet) {
    if (rpm < 1) return pInlet;
    const A = this.throttleArea(throttle);
    // r·rpm = κ·A·ψ(r): left side rises with r, right side falls → bisection
    let lo = 0.02, hi = 1.0;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      if (mid * rpm - this.kappa * A * orificeFlow(mid) > 0) hi = mid; else lo = mid;
    }
    return 0.5 * (lo + hi) * pInlet;
  }

  /**
   * @param {object} c controls { throttle, mixture, magnetos, starter }
   * @param {number} rpm current shaft rpm
   * @param {{p:number, T:number}} atm
   * @param {number} ram  ram pressure recovered at the intake, Pa
   * @param {number} airspeed true airspeed, for cooling
   * @param {boolean} fuelAvailable
   * @param {number} dt
   */
  update(c, rpm, atm, ram, airspeed, fuelAvailable, dt) {
    const s = this.spec;
    const pInlet = atm.p + ram;
    const mixtureOn = (c.mixture ?? 1) > 0.05;
    const ignition = c.magnetos ?? true;

    // starting and stopping
    if (!this.running && ignition && mixtureOn && fuelAvailable && rpm > 150) this.running = true;
    if (this.running && (!ignition || !mixtureOn || !fuelAvailable || rpm < 250)) this.running = false;

    this.mp = this.manifold(c.throttle ?? 0, Math.max(rpm, 1), pInlet);
    const tempCorr = Math.sqrt(T0 / atm.T);
    const pInd = this.running ? Math.max(0, this.cInd * (this.mp - s.mpZeroWork) * rpm * tempCorr) : 0;
    const pFric = s.frictionPowerRated * (rpm / s.ratedRpm) ** 2 + 1.5 * HP * (rpm / s.ratedRpm);
    this.power = pInd - pFric;
    const omega = Math.max(rpm * RPM, 1);
    this.torque = this.power / omega + (c.starter ? s.starterTorque * (rpm < 400 ? 1 : 0) : 0);
    if (!this.running && rpm < 5 && !c.starter) this.torque = 0; // static friction holds a stopped engine

    const lbPerHpH = 0.45359237 / 3600;
    this.fuelFlow = this.running ? s.bsfc * (pInd / HP) * lbPerHpH * (0.85 + 0.15 * clamp(c.mixture ?? 1, 0, 1)) : 0;

    // temperatures: first-order toward an equilibrium set by power and cooling air
    const oat = atm.T - 273.15;
    const pFrac = clamp(pInd / s.ratedPower, 0, 1.2);
    const cooling = 0.55 + 0.45 * clamp(airspeed / 45, 0, 1);
    const chtEq = this.running ? oat + (95 + 160 * pFrac) / cooling : oat;
    const oilEq = this.running ? oat + (45 + 60 * pFrac) / (0.7 + 0.3 * clamp(airspeed / 45, 0, 1)) : oat;
    this.cht = lag(this.cht, chtEq, 70, dt);
    this.oilTemp = lag(this.oilTemp, oilEq, 260, dt);
    this.egt = lag(this.egt, this.running ? 380 + 360 * clamp(pFrac, 0.05, 1) : this.cht, 6, dt);
    const visc = 1 + clamp((s.oil.tempNormal - this.oilTemp) / 160, -0.2, 0.6);
    const pressEq = rpm < 50 ? 0 : Math.min(100, (22 + 58 * Math.pow(rpm / s.ratedRpm, 0.55)) * visc);
    this.oilPress = lag(this.oilPress, pressEq, 0.6, dt);
  }
}
