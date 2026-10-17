// carrierApproach.js — the demo pilot's carrier landing: a straight-in final
// to the angled deck, gear, flaps and hook down, on speed and on the 3.5°
// glide slope with the hook aimed between the 2- and 3-wire, no flare. At
// touchdown the throttles go to military power (if the hook skips every wire
// the jet simply flies off the end: a bolter); once a wire has it and it
// has stopped, power to idle, brakes, hook up.
//
// It works the controls a person does, like platzrunde.js. The plugin's demo
// (O, in the F-15) runs it; tests/carrier.test.js flies it in Node.

import { Pid, casKt } from './pid.js';
import { qToEuler } from '../math/quat.js';
import { clamp, DEG, FT } from '../sim/units.js';

const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export const CARRIER_APPROACH = {
  approachKt: 138,          // on speed, gear and flaps down, ~16 t [est]
  startDist: 3200,          // m behind the aim point
};

export class CarrierPilot {
  /** @param {object} ac  the Aircraft; carrier: world/carrier.js buildCarrier() */
  constructor(ac, carrier, opts = {}) {
    this.ac = ac;
    this.carrier = carrier;
    this.P = { ...CARRIER_APPROACH, ...opts };
    this.phase = 'approach';
    this.t = 0;
    this.phaseT = 0;
    this.events = [];
    this.log = [];
    this.roll = new Pid(2.0, 0.15, 0.3);
    this.pitch = new Pid(2.8, 1.2, 0.4);
    this.yaw = new Pid(3.0, 1.0, 0.0);
    this.spd = new Pid(0.03, 0.012, 0, -0.45, 0.35);   // around the approach power below
    this.steer = new Pid(3, 0.3, 0.5);
    this.alphaTrim = null;     // the angle of attack it takes, slowly learnt
    this.touchdown = null;
    this.trap = null;
  }

  get kt() { return casKt(this.ac); }

  setPhase(p) {
    const ac = this.ac;
    this.events.push({ t: +this.t.toFixed(1), phase: p, kt: Math.round(this.kt), along: Math.round(this.carrier.along(ac.state.pos[0], ac.state.pos[1])) });
    this.phase = p;
    this.phaseT = 0;
  }

  attitude(bank, pitch, dt) {
    const ac = this.ac, c = ac.controls, e = qToEuler(ac.state.q);
    c.aileron = this.roll.step(bank - e.phi, dt) - 0.12 * ac.state.omega[0];
    c.elevator = this.pitch.step(pitch - e.theta, dt) - 0.25 * ac.state.omega[1];
    c.rudder = -this.yaw.step(-ac.out.beta, dt);
  }

  step(dt) {
    const ac = this.ac, c = ac.controls, cv = this.carrier, P = this.P;
    this.t += dt; this.phaseT += dt;
    const e = qToEuler(ac.state.q);
    const [n, east] = ac.state.pos;
    const lat = cv.lateral(n, east);
    // the arresting gear: has a wire got it, or did the hook skip them all?
    const arr = ac.arrestor;
    if (arr?.engaged && !this.trap) { this.trap = { wire: arr.engaged.wire.index, kt: Math.round(arr.engaged.v0 / 0.514444) }; this.setPhase('arrested'); }
    if (arr?.bolter && this.phase === 'touchdown') this.setPhase('bolter');
    c.gear = 1; c.hook = 1;

    switch (this.phase) {
      case 'approach': {
        // the hook's height against the glide slope to the aim point
        const tip = ac.hookTip || ac.state.pos;
        const dist = cv.aimAlong - cv.along(tip[0], tip[1]);
        const path = cv.glidePathHeight(dist);
        const hHook = -tip[2] - cv.deckH;
        const gammaCmd = clamp(-cv.data.glideSlope + 0.012 * (path - hHook), -6 * DEG, 1 * DEG);
        const gamma = Math.atan2(-ac.state.vel[2], Math.max(ac.groundSpeed, 20));
        // line-up: back onto the landing centre line, gently in close
        const intercept = clamp(-lat * (dist > 600 ? 0.01 : 0.02), -20 * DEG, 20 * DEG);
        const bank = clamp(1.6 * wrap(cv.bearing + intercept - e.psi), -20 * DEG, 20 * DEG);
        // the stick flies the path: the attitude for the path it wants (α learnt slowly), and a little
        // more for the path it is off by (no flare: the deck comes up on the glide slope)
        this.alphaTrim = this.alphaTrim == null ? ac.out.alpha : this.alphaTrim + (ac.out.alpha - this.alphaTrim) * Math.min(1, dt / 4);
        this.attitude(bank, gammaCmd + this.alphaTrim + 0.8 * (gammaCmd - gamma), dt);
        c.throttle = 0.45 + this.spd.step(P.approachKt - this.kt, dt);
        if (ac.gear.onGround && this.phaseT > 1) {
          const hookAlong = cv.along(tip[0], tip[1]);
          this.touchdown = { kt: Math.round(this.kt), sink: +ac.state.vel[2].toFixed(2), hookAlong: +hookAlong.toFixed(1), lateral: +lat.toFixed(2), deck: ac.gear.units.some((u) => u.surface === 'deck') };
          this.setPhase('touchdown');
        }
        break;
      }
      case 'touchdown': {
        // military power the moment the wheels touch, in case the hook misses
        c.throttle = ac.spec.jet ? ac.spec.jet.abDetent : 1;
        c.rudder = this.steer.step(wrap(cv.bearing - e.psi) - clamp(0.02 * lat, -0.1, 0.1), dt);
        c.aileron = -1.2 * e.phi;
        c.elevator = clamp(2 * (6 * DEG - e.theta), -0.3, 0.3);
        break;
      }
      case 'arrested': {
        c.throttle = this.phaseT < 1.0 ? (ac.spec.jet ? ac.spec.jet.abDetent : 1) : 0;
        c.rudder = this.steer.step(wrap(cv.bearing - e.psi), dt);
        c.aileron = -1.2 * e.phi;
        c.elevator = 0;
        if (ac.groundSpeed < 0.5 && this.phaseT > 1.5) this.setPhase('stopped');
        break;
      }
      case 'stopped': {
        c.throttle = 0;
        c.brakeL = c.brakeR = 1;
        c.elevator = 0; c.aileron = 0; c.rudder = 0;
        // the wire lets go once the hook comes up
        if (this.phaseT > 2) c.hook = 0;
        break;
      }
      case 'bolter': {
        // full power, rotate and fly away to come round again
        c.throttle = ac.spec.jet ? ac.spec.jet.abDetent : 1;
        this.attitude(clamp(1.6 * wrap(cv.bearing - e.psi), -15 * DEG, 15 * DEG), 10 * DEG, dt);
        c.hook = 1;
        break;
      }
      default: break;
    }
    if (Math.round(this.t * 2) !== Math.round((this.t - dt) * 2)) {
      const tip = ac.hookTip || ac.state.pos;
      this.log.push({ t: +this.t.toFixed(1), phase: this.phase, kt: Math.round(this.kt), lat: +lat.toFixed(1),
        dev: +cv.glideDeviation(tip[0], tip[1], -tip[2]).toFixed(2), altFt: Math.round((-ac.state.pos[2] - cv.deckH) / FT), aoa: +(ac.out.alpha / DEG).toFixed(1) });
    }
  }
}
