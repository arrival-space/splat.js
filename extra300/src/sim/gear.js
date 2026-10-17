// gear.js — ground contact: the Extra's taildragger, the F-15's retractable tricycle.
//
// Each wheel is a spring-damper strut along the body z axis with a tyre at
// its end. The strut pushes only along the ground normal; the tyre adds
// rolling resistance, brakes and a slip-angle lateral force inside a
// friction circle. The tail or nose wheel steers with the rudder pedals (a
// nose wheel less and less as the speed builds). Retracted wheels don't touch
// anything; the belly does. Hard points
// (prop tip, wingtips, rudder) scrape when the airframe itself meets the
// ground — the prop strike and the ground loop are part of the model.

import { cross, dot } from '../math/vec3.js';
import { qRotate, qRotateInv } from '../math/quat.js';
import { clamp } from './units.js';

const LOW_SPEED = 0.6; // m/s regularisation for slip angle near standstill

export class Gear {
  constructor(spec) {
    this.units = spec.units.map((u) => ({
      ...u, compression: 0, load: 0, onGround: false, wheelSpeed: 0, wheelAngle: 0, steerAngle: 0, surface: null,
    }));
    this.scrape = spec.scrape.map((s) => ({ ...s, load: 0, touching: false }));
    this.events = [];          // 'propStrike', 'wingtipStrike', 'splash', ... consumed by the caller
  }

  get onGround() { return this.units.some((u) => u.onGround); }
  get weightOnWheels() { return this.units.reduce((s, u) => s + u.load, 0); }

  /**
   * @param {object} st  rigid-body state { pos (NED), vel (NED), q, omega }
   * @param {number[]} cg  CG relative to the reference point (body)
   * @param {object} controls { rudder, brakeL, brakeR, parkingBrake }
   * @param {(n:number, e:number) => {h:number, normal:number[], surface:string}} ground
   * @param {number} dt
   * @returns {{ force: number[], moment: number[] }} body axes about the CG
   */
  compute(st, cg, controls, ground, dt) {
    const F = [0, 0, 0];
    const M = [0, 0, 0];
    const rb = [0, 0, 0];
    const re = [0, 0, 0];
    const vp = [0, 0, 0];
    const strutE = qRotate(st.q, [0, 0, 1]);    // strut axis in earth (NED), pointing down
    const gearDown = controls.gearPos ?? 1;
    const groundSpeed = Math.hypot(st.vel[0], st.vel[1]);

    for (const u of this.units) {
      if (u.retracts && gearDown < 0.98) {
        u.compression = 0; u.load = 0; u.onGround = false;
        u.wheelSpeed *= Math.exp(-dt * 2);
        continue;
      }
      rb[0] = u.pos[0] - cg[0]; rb[1] = u.pos[1] - cg[1]; rb[2] = u.pos[2] - cg[2];
      qRotate(st.q, rb, re);
      const pn = st.pos[0] + re[0], pe = st.pos[1] + re[1], pd = st.pos[2] + re[2];
      const gnd = ground(pn, pe, pd);
      const nUp = gnd.normal;                    // NED, pointing up (z negative)
      // penetration of the fully extended wheel below the surface, along the surface normal
      const depth = (pd + gnd.h) * -nUp[2];      // ground surface at d = -h
      u.surface = gnd.surface;
      if (depth <= 0 || gnd.surface === 'water') {
        u.compression = Math.max(0, u.compression - dt * 2);
        u.load = 0; u.onGround = false;
        if (depth > 0.3 && gnd.surface === 'water') this.events.push('splash');
        u.wheelSpeed *= Math.exp(-dt * 0.3);
        u.wheelAngle += u.wheelSpeed * dt;
        continue;
      }
      // strut compression along its own axis
      const cosTilt = Math.max(0.3, -dot(strutE, nUp));
      let x = depth / cosTilt;

      // contact-point velocity (earth)
      cross(st.omega, rb, vp);
      const vpe = qRotate(st.q, vp);
      vpe[0] += st.vel[0]; vpe[1] += st.vel[1]; vpe[2] += st.vel[2];
      const vn = -dot(vpe, nUp);                 // closing speed into the ground (+ = compressing)

      let k = u.k, c = u.c;
      if (x > u.travel) { k *= 12; c *= 3; }    // bottomed out on the stop
      let N = k * x + c * vn;
      if (N < 0) N = 0;
      x = Math.min(x, u.travel * 1.5);
      u.compression = x; u.load = N; u.onGround = true;

      // tyre frame on the ground plane
      let steer = 0;
      if (u.steer) {
        steer = u.steer.sign * clamp(controls[u.steer.input] || 0, -1, 1) * u.steer.maxAngle;
        if (u.steer.fadeSpeed) steer /= 1 + (groundSpeed / u.steer.fadeSpeed) ** 2;
      }
      u.steerAngle = steer;
      const wheelFwdB = [Math.cos(steer), Math.sin(steer), 0];
      const wf = qRotate(st.q, wheelFwdB);
      const wn = dot(wf, nUp);
      wf[0] -= wn * nUp[0]; wf[1] -= wn * nUp[1]; wf[2] -= wn * nUp[2];
      const wfl = Math.hypot(wf[0], wf[1], wf[2]) || 1;
      wf[0] /= wfl; wf[1] /= wfl; wf[2] /= wfl;
      const wl = cross(nUp, wf);                  // lateral (right-hand, in plane)
      const vLong = dot(vpe, wf);
      const vLat = dot(vpe, wl);

      const mu = u.tyre.mu * (gnd.surface === 'grass' ? 0.75 : 1);
      // rolling resistance and brakes
      let brake = 0;
      if (u.brake) brake = Math.max(controls.parkingBrake ? 1 : 0, u.brake === 'left' ? controls.brakeL || 0 : controls.brakeR || 0);
      const rolling = (u.tyre.rolling * (gnd.surface === 'grass' ? 2.5 : 1)) * N;
      const brakeMax = brake > 0 ? Math.min((u.maxBrakeTorque * brake) / u.tyre.radius, mu * N) : 0;
      // brakes grip almost statically; rolling resistance is softer
      let fLong = -rolling * Math.tanh(vLong / 0.15) - brakeMax * Math.tanh(vLong / 0.03);
      // lateral: slip-angle curve, saturating at μN
      const slip = Math.atan2(vLat, Math.abs(vLong) + LOW_SPEED);
      let fLat = -mu * N * Math.tanh(slip / (7 * Math.PI / 180));
      // friction circle
      const ft = Math.hypot(fLong, fLat);
      const fmax = mu * N;
      if (ft > fmax) { fLong *= fmax / ft; fLat *= fmax / ft; }

      // wheel spin for the visuals (a locked wheel skids)
      const locked = brakeMax >= rolling + 0.98 * mu * N && Math.abs(vLong) > 0.5;
      u.wheelSpeed = locked ? 0 : vLong / u.tyre.radius;
      u.wheelAngle += u.wheelSpeed * dt;

      const fe = [
        N * nUp[0] + fLong * wf[0] + fLat * wl[0],
        N * nUp[1] + fLong * wf[1] + fLat * wl[1],
        N * nUp[2] + fLong * wf[2] + fLat * wl[2],
      ];
      const fb = qRotateInv(st.q, fe);
      F[0] += fb[0]; F[1] += fb[1]; F[2] += fb[2];
      const m = cross(rb, fb);
      M[0] += m[0]; M[1] += m[1]; M[2] += m[2];
    }

    // airframe hard points: stiff, lossy contact with sliding friction
    for (const s of this.scrape) {
      rb[0] = s.pos[0] - cg[0]; rb[1] = s.pos[1] - cg[1]; rb[2] = s.pos[2] - cg[2];
      qRotate(st.q, rb, re);
      const pd = st.pos[2] + re[2];
      const gnd = ground(st.pos[0] + re[0], st.pos[1] + re[1], pd);
      const depth = pd + gnd.h;
      if (depth <= 0) { s.touching = false; s.load = 0; continue; }
      cross(st.omega, rb, vp);
      const vpe = qRotate(st.q, vp);
      vpe[0] += st.vel[0]; vpe[1] += st.vel[1]; vpe[2] += st.vel[2];
      const N = Math.max(0, s.k * depth + s.c * vpe[2]);
      const vh = Math.hypot(vpe[0], vpe[1]) || 1;
      const fr = (s.mu * N) * Math.tanh(vh / 0.3);
      const fe = [-fr * vpe[0] / vh, -fr * vpe[1] / vh, -N];
      const fb = qRotateInv(st.q, fe);
      F[0] += fb[0]; F[1] += fb[1]; F[2] += fb[2];
      const m = cross(rb, fb);
      M[0] += m[0]; M[1] += m[1]; M[2] += m[2];
      if (!s.touching) this.events.push(s.name === 'propTip' ? 'propStrike' : `${s.name}Strike`);
      s.touching = true; s.load = N;
    }
    return { force: F, moment: M };
  }
}
