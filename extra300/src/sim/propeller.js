// propeller.js — constant-speed propeller: one blade-element station at 75 %
// radius, closed with momentum theory for the induced inflow, plus a
// flyweight governor that moves the blade angle to hold the rpm the prop
// lever asks for. Thrust, absorbed torque, slipstream and swirl all come
// from the same few lines, so static thrust, climb thrust, cruise and
// windmilling stay consistent with each other.

import { sectionCoefficients } from './aero.js';
import { clamp, DEG, lerp, RPM } from './units.js';

const BLADE_SECTION = { a: 5.6, stall: 14 * DEG, cd0: 0.011, e: 1, aspect: 1e9 };

export class Propeller {
  constructor(spec) {
    this.spec = spec;
    this.R = spec.diameter / 2;
    // hub blockage and tip losses: the momentum disc is smaller than the swept area
    this.A = Math.PI * this.R * this.R * (spec.discEfficiency ?? 1);
    this.beta = spec.betaFine;
    this.vi = 0;              // induced axial velocity at the disc
    this.thrust = 0;
    this.torque = 0;          // absorbed aerodynamic torque, N m (positive opposes rotation)
    this.slipDv = 0;          // axial slipstream increment downstream, m/s
    this.swirl = 0;           // tangential slipstream velocity at ~0.6 R, m/s
    this.governing = false;
    this.lastRpm = 0;
  }

  setRpmFromLever(lever) {
    const g = this.spec.governor;
    return lerp(g.rpmMin, g.rpmMax, clamp(lever, 0, 1));
  }

  /** Aerodynamics at a given blade angle — pure, used by the governor and the tests. */
  evaluate(Vax, rpm, rho, beta = this.beta, viGuess = this.vi) {
    const s = this.spec;
    const r = 0.75 * this.R;
    const Vt = Math.max(rpm * RPM * r, 0.01);
    const bladeSpan = 0.8 * this.R;       // the working outer part of each blade
    let vi = viGuess;
    let T = 0, Q = 0;
    for (let it = 0; it < 10; it++) {
      const Va = Vax + vi;
      const phi = Math.atan2(Va, Vt);
      const W2 = Va * Va + Vt * Vt;
      const { cl, cd } = sectionCoefficients(beta - phi, BLADE_SECTION);
      const k = s.blades * 0.5 * rho * W2 * s.chord75 * bladeSpan;
      T = k * (cl * Math.cos(phi) - cd * Math.sin(phi));
      Q = k * (cl * Math.sin(phi) + cd * Math.cos(phi)) * r;
      // momentum theory: T = 2ρA(V+vi)vi  (windmilling branch mirrored)
      const V = Math.max(Vax, 0);
      const target = T >= 0
        ? 0.5 * (-V + Math.sqrt(V * V + (2 * T) / (rho * this.A)))
        : -0.5 * (-V + Math.sqrt(V * V + (2 * -T) / (rho * this.A)));
      vi = lerp(vi, clamp(target, -0.5 * Math.max(V, 1), 60), 0.5);
    }
    return { T, Q, vi };
  }

  /**
   * @param {number} Vax  axial airspeed at the disc (m/s, + from ahead)
   * @param {number} rpm
   * @param {number} rho
   * @param {number} lever 0..1 prop lever → rpm setpoint
   * @param {number} dt
   */
  update(Vax, rpm, rho, lever, dt) {
    const g = this.spec.governor;
    const setRpm = this.setRpmFromLever(lever);
    // governor: flyweights see rpm error; oil flow moves the blades. Below
    // ~1,500 rpm there is not enough oil pressure and the blades sit on the fine stop.
    const dRpm = dt > 0 ? (rpm - this.lastRpm) / dt : 0;
    this.lastRpm = rpm;
    if (rpm > 1500) {
      const rate = clamp(g.gain * (rpm - setRpm) + g.damping * dRpm, -g.rateLimit, g.rateLimit);
      this.beta = clamp(this.beta + rate * dt, this.spec.betaFine, this.spec.betaCoarse);
    } else {
      this.beta = Math.max(this.spec.betaFine, this.beta - g.rateLimit * dt);
    }
    this.governing = this.beta > this.spec.betaFine + 0.2 * DEG;

    const { T, Q, vi } = this.evaluate(Vax, rpm, rho);
    this.vi = vi;
    this.thrust = T;
    this.torque = Q;
    this.slipDv = 2 * vi * 0.85;          // fully developed wake, mixing losses
    // swirl from angular momentum: the torque turns the air the disc swallows,
    // ṁ = ρ·A·(V + vi) through the whole swept disc, at ~0.7 R; by the tail the
    // fuselage and the wing have taken out about half of it
    const sweptArea = Math.PI * this.R * this.R;
    const mdot = rho * sweptArea * Math.max(Vax + vi, 1);
    this.swirl = clamp((0.5 * Q) / (mdot * 0.7 * this.R), 0, 15);
  }
}
