// pid.js — the small control loops the demo pilot and the test pilot fly with.

import { casFromImpact, impactPressure } from '../sim/atmosphere.js';
import { clamp, KT } from '../sim/units.js';

export class Pid {
  constructor(kp, ki, kd, lo = -1, hi = 1) { Object.assign(this, { kp, ki, kd, lo, hi, i: 0, prev: null }); }
  step(err, dt) {
    const d = this.prev == null ? 0 : (err - this.prev) / dt;
    this.prev = err;
    const ni = this.i + err * dt;
    const u = this.kp * err + this.ki * ni + this.kd * d;
    if (u > this.lo && u < this.hi) this.i = ni; // anti-windup
    return clamp(u, this.lo, this.hi);
  }
}

/** Calibrated airspeed in knots, as the airspeed indicator would show without its errors. */
export const casKt = (ac) => casFromImpact(impactPressure(ac.out.tas, ac.out.atm)) / KT;
