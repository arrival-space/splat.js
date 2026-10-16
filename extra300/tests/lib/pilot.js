// pilot.js — a test pilot: small PID loops that fly the model the way a
// flight-test card would (hold altitude, hold airspeed, keep the ball
// centred), so the performance tests measure the airframe, not the pilot.

import { qToEuler } from '../../src/math/quat.js';
import { clamp } from '../../src/sim/units.js';

export { Pid, casKt } from '../../src/autopilot/pid.js';
import { Pid, casKt } from '../../src/autopilot/pid.js';

/** Wings level + ball centred + pitch toward a target pitch attitude. */
export class Autopilot {
  constructor(ac) {
    this.ac = ac;
    this.roll = new Pid(2.0, 0.3, 0.25);
    this.yaw = new Pid(3.0, 1.0, 0.0);
    this.pitch = new Pid(2.5, 1.5, 0.35);
    this.alt = new Pid(0.004, 0.0004, 0.006, -0.25, 0.35);  // m → pitch target (rad)
    this.spd = new Pid(0.08, 0.02, 0, 0, 1);                  // kt → throttle
    this.bankTarget = 0;
  }
  /** One control update; mode = { alt?, pitch?, ias?, throttle? } */
  fly(mode, dt) {
    const ac = this.ac;
    const c = ac.controls;
    const e = qToEuler(ac.state.q);
    c.aileron = this.roll.step(this.bankTarget - e.phi, dt) - 0.15 * ac.state.omega[0];
    c.rudder = this.yaw.step(-ac.out.beta, dt) * -1 + 0;
    let pitchTarget = mode.pitch;
    if (mode.alt != null) pitchTarget = this.alt.step(mode.alt - ac.altitudeMsl, dt) + 0.04;
    if (pitchTarget != null) c.elevator = this.pitch.step(pitchTarget - e.theta, dt) - 0.2 * ac.state.omega[1];
    if (mode.ias != null) c.throttle = this.spd.step(mode.ias - casKt(ac), dt);
    if (mode.throttle != null) c.throttle = mode.throttle;
  }
}

/** Run `seconds` of flight, calling the pilot at 60 Hz; returns samples every `every` s. */
export function fly(ac, ap, mode, seconds, onSample, every = 0.5) {
  const frame = 1 / 60;
  let t = 0, next = 0;
  while (t < seconds) {
    if (typeof mode === 'function') ap.fly(mode(t), frame); else ap.fly(mode, frame);
    ac.update(frame);
    t += frame;
    if (onSample && t >= next) { onSample(t); next += every; }
  }
}
