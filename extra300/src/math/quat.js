// quat.js — unit quaternions [w, x, y, z] mapping BODY vectors into the
// local EARTH frame (NED: x north, y east, z down). Aerospace conventions
// throughout: body x forward, y right wing, z down; Euler angles are the
// 3-2-1 sequence (yaw psi, pitch theta, roll phi).

import { set } from './vec3.js';

export const qIdentity = () => [1, 0, 0, 0];

export function qMul(a, b, out = [0, 0, 0, 0]) {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  out[0] = aw * bw - ax * bx - ay * by - az * bz;
  out[1] = aw * bx + ax * bw + ay * bz - az * by;
  out[2] = aw * by - ax * bz + ay * bw + az * bx;
  out[3] = aw * bz + ax * by - ay * bx + az * bw;
  return out;
}

export function qNormalize(q, out = q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  out[0] = q[0] / l; out[1] = q[1] / l; out[2] = q[2] / l; out[3] = q[3] / l;
  return out;
}

/** Rotate body vector v into the earth frame. */
export function qRotate(q, v, out = [0, 0, 0]) {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;
  // t = 2 * (q.xyz × v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return set(out, vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx));
}

/** Rotate earth vector v into the body frame (inverse rotation). */
export function qRotateInv(q, v, out = [0, 0, 0]) {
  return qRotate([q[0], -q[1], -q[2], -q[3]], v, out);
}

/** From 3-2-1 Euler angles (radians). */
export function qFromEuler(phi, theta, psi) {
  const cr = Math.cos(phi / 2), sr = Math.sin(phi / 2);
  const cp = Math.cos(theta / 2), sp = Math.sin(theta / 2);
  const cy = Math.cos(psi / 2), sy = Math.sin(psi / 2);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}

/** To 3-2-1 Euler angles { phi, theta, psi } (radians, psi in [0, 2pi)). */
export function qToEuler(q) {
  const [w, x, y, z] = q;
  const phi = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const s = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const theta = Math.asin(s);
  let psi = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  if (psi < 0) psi += 2 * Math.PI;
  return { phi, theta, psi };
}

/** Integrate q by body angular rate w over dt (exact for constant w). */
export function qIntegrate(q, w, dt, out = q) {
  const wl = Math.hypot(w[0], w[1], w[2]);
  if (wl < 1e-12) {
    if (out !== q) { out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; out[3] = q[3]; }
    return out;
  }
  const half = 0.5 * wl * dt;
  const s = Math.sin(half) / wl;
  const dq = [Math.cos(half), w[0] * s, w[1] * s, w[2] * s];
  qMul(q, dq, out);
  return qNormalize(out);
}
