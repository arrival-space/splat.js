// platzrunde.js — the demo pilot: one circuit at Meigs, takeoff from
// runway 36, right-hand traffic over the lake, a loop on the downwind leg,
// base, final, flare, three-point landing, braking to a stop.
//
// The pilot works the same controls a person does: stick, pedals, throttle,
// brakes. The loop is flown through the keyboard mapper — holding the pitch
// key, as a player would. The plugin's "Watch a Platzrunde" button runs it;
// tests/flight.test.js flies it in Node as the end-to-end test.

import { Pid, casKt } from './pid.js';
import { ControlMapper } from '../input/controlMapper.js';
import { qToEuler } from '../math/quat.js';
import { clamp, DEG, FT } from '../sim/units.js';

const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export const PATTERN = {
  altitudeAgl: 1000 * FT,     // pattern altitude
  downwindOffset: 1000,       // m east of the centreline (right traffic for 36: the lake side)
  crosswindAgl: 500 * FT,
  climbKt: 85,
  cruiseKt: 120,
  loopEntryKt: 160,
  approachKt: 75,
  finalKt: 72,               // over the fence; the flare bleeds it to ~60 for a three-pointer
  glideDeg: 4,
  aimFromThreshold: 150,      // m past the 36 threshold
};

export class PatternPilot {
  /** @param {object} ac  the Aircraft (sim/aircraft.js); world: buildMeigs() */
  constructor(ac, world) {
    this.ac = ac;
    this.world = world;
    this.rw = world.runway;
    this.phase = 'takeoff';
    this.t = 0;
    this.phaseT = 0;
    this.log = [];
    this.events = [];
    this.roll = new Pid(2.2, 0.2, 0.3);
    this.pitch = new Pid(2.8, 1.2, 0.4);
    this.yaw = new Pid(3.0, 1.0, 0.0);
    this.spd = new Pid(0.08, 0.03, 0, 0, 1);
    this.alt = new Pid(0.006, 0.0006, 0.01, -0.2, 0.3);
    this.steer = new Pid(4, 0.5, 0.6);
    this.mapper = new ControlMapper();
    this.loopTurned = 0;
    this.loopStart = null;
    this.maxG = 0;
    this.minLoopKt = Infinity;
    this.touchdown = null;
  }

  get agl() { return this.ac.agl - 1.2; }               // wheels above the runway (CG ~1.2 m up on the gear)
  get kt() { return casKt(this.ac); }

  setPhase(p) {
    this.events.push({ t: +this.t.toFixed(1), phase: p, n: Math.round(this.ac.state.pos[0]), e: Math.round(this.ac.state.pos[1]), altFt: Math.round((this.ac.altitudeMsl) / FT), kt: Math.round(this.kt) });
    this.phase = p;
    this.phaseT = 0;
  }

  /** Bank toward a heading (rad), with a bank limit. */
  headingTo(psi, maxBank = 30 * DEG) {
    const e = qToEuler(this.ac.state.q);
    return clamp(1.6 * wrap(psi - e.psi), -maxBank, maxBank);
  }

  /** Fly a bank angle, a pitch attitude, and keep the ball centred. */
  attitude(bank, pitch, dt) {
    const ac = this.ac, c = ac.controls, e = qToEuler(ac.state.q);
    c.aileron = this.roll.step(bank - e.phi, dt) - 0.15 * ac.state.omega[0];
    c.elevator = this.pitch.step(pitch - e.theta, dt) - 0.25 * ac.state.omega[1] + 0.2 * Math.abs(Math.sin(e.phi)) * (Math.abs(e.phi) < 80 * DEG ? 1 : 0);
    c.rudder = -this.yaw.step(-ac.out.beta, dt);
  }

  step(dt) {
    const ac = this.ac, c = ac.controls, P = PATTERN, rw = this.rw;
    this.t += dt; this.phaseT += dt;
    const e = qToEuler(ac.state.q);
    const [n, east] = ac.state.pos;
    const fieldMsl = this.world.elevation;
    const altAgl = ac.altitudeMsl - fieldMsl;
    this.maxG = Math.max(this.maxG, ac.out.loadFactor);

    switch (this.phase) {
      case 'takeoff': {
        c.brakeL = c.brakeR = 0;
        c.throttle = Math.min(1, this.phaseT / 3);
        // pedals hold the centreline: heading plus a little cross-track
        const hdgErr = wrap(rw.bearing - e.psi);
        c.rudder = this.steer.step(hdgErr - clamp(0.02 * east, -0.15, 0.15), dt);
        c.aileron = -1.5 * e.phi;
        const kt = this.kt;
        c.elevator = kt < 35 ? 0 : kt < 55 ? 1.5 * (1 * DEG - e.theta) : 3 * (12 * DEG - e.theta);
        if (!ac.gear.onGround && this.agl > 3) this.setPhase('climb');
        break;
      }
      case 'climb': {
        c.throttle = 1;
        const pitchCmd = clamp(0.12 + 0.012 * (this.kt - P.climbKt), 0.02, 0.3);
        this.attitude(this.headingTo(rw.bearing, 10 * DEG), pitchCmd, dt);
        if (altAgl > P.crosswindAgl) this.setPhase('crosswind');
        break;
      }
      case 'crosswind': {   // right turn toward the lake, still climbing
        c.throttle = 1;
        const pitchCmd = clamp(0.1 + 0.012 * (this.kt - P.climbKt), 0.0, 0.25);
        this.attitude(this.headingTo(90 * DEG), altAgl < P.altitudeAgl ? pitchCmd : this.alt.step(P.altitudeAgl - altAgl, dt) + 0.03, dt);
        if (east > P.downwindOffset - 350) this.setPhase('downwind');
        break;
      }
      case 'downwind': {    // heading 180 at pattern altitude, track 1 km east of the centreline
        const trackErr = clamp((east - P.downwindOffset) * 0.004, -0.5, 0.5);
        const psiCmd = Math.PI + trackErr;
        c.throttle = this.spd.step(P.cruiseKt - this.kt, dt);
        this.attitude(this.headingTo(psiCmd, 30 * DEG), this.alt.step(P.altitudeAgl - altAgl, dt) + 0.03, dt);
        if (this.phaseT > 12 && Math.abs(wrap(e.psi - Math.PI)) < 5 * DEG && n < 2400) this.setPhase('loopEntry');
        break;
      }
      case 'loopEntry': {   // full power, ease the nose down until 160 kt, wings level
        c.throttle = 1;
        this.attitude(this.headingTo(Math.PI, 15 * DEG), clamp(-0.06 + 0.004 * (P.loopEntryKt - this.kt), -0.12, 0.05), dt);
        if (this.kt >= P.loopEntryKt) { this.loopStart = { altMsl: ac.altitudeMsl, psi: e.psi }; this.mapper.throttle = 1; this.setPhase('loop'); }
        break;
      }
      case 'loop': {        // hold the pitch-up key, full throttle — as a player would
        this.mapper.update({ keys: new Set(['ArrowDown']) }, dt, c, {
          qbar: ac.out.qbar, alpha: ac.out.alpha, beta: ac.out.beta, yawRate: ac.state.omega[2], onGround: false,
        });
        this.loopTurned += ac.state.omega[1] * dt;
        this.minLoopKt = Math.min(this.minLoopKt, this.kt);
        if (this.loopTurned >= 2 * Math.PI - 15 * DEG) {
          this.loopResult = { seconds: this.phaseT, minKt: this.minLoopKt, altChange: ac.altitudeMsl - this.loopStart.altMsl, headingChange: wrap(e.psi - this.loopStart.psi) / DEG };
          this.roll.i = this.pitch.i = this.alt.i = this.spd.i = 0;
          this.recoverFrom = e.theta;
          this.setPhase('recover');
        }
        break;
      }
      case 'recover': {     // ease the nose back up to the horizon over ~3 s, the way a pilot pulls out
        c.throttle = 0.7;
        const k = Math.min(1, this.phaseT / 3);
        const target = this.recoverFrom + (0.03 - this.recoverFrom) * (k * k * (3 - 2 * k));
        this.attitude(this.headingTo(Math.PI, 15 * DEG), target, dt);
        c.elevator = clamp(c.elevator, -0.4, 0.35);
        if (this.phaseT > 3.5) this.setPhase('downwind2');
        break;
      }
      case 'downwind2': {   // back to pattern altitude and speed, continue past the threshold
        const trackErr = clamp((east - P.downwindOffset) * 0.004, -0.5, 0.5);
        c.throttle = this.spd.step(P.approachKt + 20 - this.kt, dt);
        this.attitude(this.headingTo(Math.PI + trackErr, 30 * DEG), this.alt.step(P.altitudeAgl - altAgl, dt) + 0.03, dt);
        if (n < rw.thr36[0] - 1200) this.setPhase('base');
        break;
      }
      case 'base': {        // right turn to 270 (west), slow to approach speed, descend toward the glide path
        c.throttle = this.spd.step(P.approachKt - this.kt, dt);
        // the height the glide path wants where the final turn will roll out
        const remaining = Math.max(0, east) + (rw.thr36[0] + P.aimFromThreshold - n);
        const targetAgl = Math.max(350 * FT, Math.tan(P.glideDeg * DEG) * remaining);
        this.attitude(this.headingTo(270 * DEG), clamp(this.alt.step(targetAgl - altAgl, dt) + 0.02, -6 * DEG, 8 * DEG), dt);
        if (east < 450) this.setPhase('final');
        break;
      }
      case 'final': {       // intercept the centreline, fly the glide path to the aim point
        const aimN = rw.thr36[0] + P.aimFromThreshold;
        const dist = aimN - n;
        const pathAgl = Math.tan(P.glideDeg * DEG) * dist;
        const intercept = clamp(-east * 0.012, -35 * DEG, 35 * DEG);
        const speedCmd = dist > 600 ? P.approachKt : P.finalKt;
        c.throttle = this.spd.step(speedCmd - this.kt, dt);
        const vsCmd = -Math.tan(P.glideDeg * DEG) * ac.groundSpeed + 0.25 * (pathAgl - this.agl);
        const gamma = clamp(Math.atan2(vsCmd, Math.max(ac.groundSpeed, 20)), -8 * DEG, 0);
        this.attitude(this.headingTo(rw.bearing + intercept, 25 * DEG), gamma + ac.out.alpha * 0.9, dt);
        if (this.agl < 7) this.setPhase('flare');
        break;
      }
      case 'flare': {       // power off, hold it off just above the runway, nose up toward three-point
        c.throttle = 0;
        // exponential flare: sink rate proportional to height, so it floats while the speed bleeds
        if (this.flareSink0 == null) this.flareSink0 = Math.max(ac.state.vel[2], 1);
        const sinkCmd = Math.min(this.flareSink0, Math.max(0.15, 0.35 * Math.max(this.agl - 0.1, 0)));
        const gamma = -Math.atan2(sinkCmd, Math.max(ac.groundSpeed, 15));
        const target = clamp(gamma + ac.out.alpha, 2 * DEG, 10.5 * DEG);   // never past the three-point attitude
        this.attitude(clamp(-0.5 * e.phi, -0.1, 0.1), target, dt);
        c.rudder = this.steer.step(wrap(rw.bearing - e.psi) - clamp(0.02 * east, -0.1, 0.1), dt);
        if (ac.gear.onGround) {
          this.touchdown = { n: Math.round(n), e: +east.toFixed(1), kt: Math.round(this.kt), vs: +(ac.state.vel[2]).toFixed(2), surface: this.world.ground(n, east).surface };
          this.setPhase('rollout');
        }
        break;
      }
      case 'rollout': {     // hold the landing attitude while it still flies, stick back once slow
        c.throttle = 0;
        if (this.kt > 48) {
          this.attitude(clamp(-0.5 * e.phi, -0.1, 0.1), Math.min(e.theta, 10.5 * DEG) - 1 * DEG, dt);
          c.elevator = clamp(c.elevator, -0.3, 0.3);
        } else {
          c.elevator = 1;
        }
        c.aileron = -1.5 * e.phi;
        c.rudder = this.steer.step(wrap(rw.bearing - e.psi) - clamp(0.02 * east, -0.15, 0.15), dt);
        // brake gently, and let go the moment the tail gets light (a pilot feels it through the seat)
        const tailLoad = ac.gear.units[2].load;
        const want = this.kt < 50 ? 0.45 : 0.15;
        this.brake = tailLoad < 350 ? Math.max(0, (this.brake ?? 0) - 3 * dt) : Math.min(want, (this.brake ?? 0) + dt);
        c.brakeL = c.brakeR = this.brake;
        if (ac.groundSpeed < 0.5) this.setPhase('stopped');
        break;
      }
      default:
        c.throttle = 0; c.brakeL = c.brakeR = 1;
    }
    if (Math.round(this.t * 2) !== Math.round((this.t - dt) * 2)) {
      this.log.push({ t: +this.t.toFixed(1), phase: this.phase, n: Math.round(n), e: Math.round(east), altFt: Math.round(altAgl / FT), kt: Math.round(this.kt), g: +ac.out.loadFactor.toFixed(1), stall: ac.aero.wingStallFraction() });
    }
  }
}
