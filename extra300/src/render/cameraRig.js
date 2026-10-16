// cameraRig.js — where the camera is, per view, in render space (metres,
// x east, y up, z south; quaternions [x, y, z, w] as PlayCanvas wants them).
//
//   cockpit  the rear-seat eye point, rolling with the airplane, mouse/stick to look around
//   chase    a spring-lagged follow camera behind and above
//   tower    Meigs tower cab, tracking the airplane and zooming with range
//   flyby    parks ahead of the airplane and lets it pass, then re-parks

import { qMul, qNormalize } from '../math/quat.js';
import { fromBody } from './geometry.js';

export const VIEWS = ['cockpit', 'chase', 'tower', 'flyby'];

/** Sim quaternion [w, x, y, z] (body→NED) to a render-space PlayCanvas quaternion [x, y, z, w]. */
export function simToRenderQuat(q) {
  return [q[2], -q[3], -q[1], q[0]];
}
/** NED position to render position. */
export const nedToRender = (p) => [p[1], -p[2], -p[0]];

// quaternion helpers in [x, y, z, w]
const qmul = (a, b) => {
  // reuse the [w, x, y, z] multiply
  const r = qMul([a[3], a[0], a[1], a[2]], [b[3], b[0], b[1], b[2]]);
  return [r[1], r[2], r[3], r[0]];
};
const axisAngle = (ax, ay, az, ang) => {
  const s = Math.sin(ang / 2);
  return [ax * s, ay * s, az * s, Math.cos(ang / 2)];
};
const rotateVec = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};

/** Rotation whose -Z looks from `eye` toward `target` with world +Y up. */
export function lookRotation(eye, target, up = [0, 1, 0]) {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // camera basis: z = -forward, x = up × z, y = z × x
  const zx = -fx, zy = -fy, zz = -fz;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  // matrix (columns x, y, z) → quaternion
  const tr = xx + yy + zz;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(yz - zy) / s, (zx - xz) / s, (xy - yx) / s, 0.25 * s];
  } else if (xx > yy && xx > zz) {
    const s = Math.sqrt(1 + xx - yy - zz) * 2;
    q = [0.25 * s, (yx + xy) / s, (zx + xz) / s, (yz - zy) / s];
  } else if (yy > zz) {
    const s = Math.sqrt(1 + yy - xx - zz) * 2;
    q = [(yx + xy) / s, 0.25 * s, (zy + yz) / s, (zx - xz) / s];
  } else {
    const s = Math.sqrt(1 + zz - xx - yy) * 2;
    q = [(zx + xz) / s, (zy + yz) / s, 0.25 * s, (xy - yx) / s];
  }
  const n = qNormalize([q[3], q[0], q[1], q[2]]);
  return [n[1], n[2], n[3], n[0]];
}

export class CameraRig {
  constructor({ eye, towerPos }) {
    this.eye = eye;                 // body-axes eye point
    this.towerPos = towerPos;       // render-space tower cab
    this.view = 'cockpit';
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.chasePos = null;
    this.flybyPos = null;
    this.fov = 70;
    this.chaseScale = 1;            // mouse wheel: chase distance ×
    this.fovScale = 1;              // mouse wheel: field of view × in the other views
  }

  /** Mouse wheel: steps > 0 zoom out (the chase camera backs off, the others widen), < 0 zoom in. */
  zoom(steps) {
    const f = Math.pow(1.12, steps);
    if (this.view === 'chase') this.chaseScale = Math.max(0.35, Math.min(6, this.chaseScale * f));
    else this.fovScale = Math.max(0.3, Math.min(1.3, this.fovScale * f));
  }

  cycle() {
    this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length];
    this.chasePos = null;
    this.flybyPos = null;
    return this.view;
  }

  look(dYaw, dPitch) {
    // the chase camera orbits all the way round; the pilot's head turns only so far
    this.lookYaw = this.view === 'chase' ? (this.lookYaw + dYaw) % (2 * Math.PI) : Math.max(-2.6, Math.min(2.6, this.lookYaw + dYaw));
    this.lookPitch = Math.max(-1.2, Math.min(1.3, this.lookPitch + dPitch));
  }
  centre() { this.lookYaw = 0; this.lookPitch = 0; }

  /**
   * @param {object} ac  aircraft (sim) — state.pos (NED), state.q, state.vel
   * @param {number} dt
   * @returns {{ pos: number[], rot: number[], fov: number }} render space, metres
   */
  update(ac, dt, cg = [0, 0, 0]) {
    const st = ac.state;
    const pos = nedToRender(st.pos);
    const rot = simToRenderQuat(st.q);
    if (this.view === 'cockpit') {
      const e = fromBody([this.eye[0] - cg[0], this.eye[1] - cg[1], this.eye[2] - cg[2]]);
      const eo = rotateVec(rot, e);
      const look = qmul(axisAngle(0, 1, 0, this.lookYaw), axisAngle(1, 0, 0, this.lookPitch));
      return { pos: [pos[0] + eo[0], pos[1] + eo[1], pos[2] + eo[2]], rot: qmul(rot, look), fov: 72 * this.fovScale };
    }
    if (this.view === 'chase') {
      // behind along the velocity (or the nose when slow), a little above
      const v = nedToRender(st.vel);
      const sp = Math.hypot(v[0], v[1], v[2]);
      const nose = rotateVec(rot, [0, 0, -1]);
      const dir = sp > 8 ? [v[0] / sp, v[1] / sp, v[2] / sp] : nose;
      const D = 14 * this.chaseScale, H = 3.2 * this.chaseScale;
      const want = [pos[0] - dir[0] * D, pos[1] - dir[1] * D + H, pos[2] - dir[2] * D];
      if (!this.chasePos) this.chasePos = want;
      const k = 1 - Math.exp(-dt * 4.5);
      for (let i = 0; i < 3; i++) this.chasePos[i] += (want[i] - this.chasePos[i]) * k;
      // dragging orbits the camera round the airplane (not round itself): turn the lagged offset
      // about the airplane, in azimuth by the look yaw and in elevation by the look pitch
      const off = [this.chasePos[0] - pos[0], this.chasePos[1] - pos[1], this.chasePos[2] - pos[2]];
      const r = Math.hypot(off[0], off[1], off[2]);
      const az = Math.atan2(off[0], off[2]) + this.lookYaw;
      const el = Math.max(-0.05, Math.min(1.45, Math.asin(off[1] / r) - this.lookPitch));
      const cam = [pos[0] + r * Math.cos(el) * Math.sin(az), pos[1] + r * Math.sin(el), pos[2] + r * Math.cos(el) * Math.cos(az)];
      // keep the lens from sinking under the runway
      cam[1] = Math.max(cam[1], 1.0);
      return { pos: cam, rot: lookRotation(cam, pos), fov: 60 };
    }
    if (this.view === 'tower') {
      const t = this.towerPos;
      const d = Math.hypot(pos[0] - t[0], pos[1] - t[1], pos[2] - t[2]);
      // zoom so the airplane stays a readable size: ~8 m span fills ~1/6 of the view at 8 deg
      const fov = Math.max(2, Math.min(80, ((2 * Math.atan(30 / Math.max(d, 1)) * 180) / Math.PI) * this.fovScale));
      return { pos: t.slice(), rot: lookRotation(t, pos), fov };
    }
    // fly-by
    const v = nedToRender(st.vel);
    const sp = Math.hypot(v[0], v[1], v[2]);
    const reset = !this.flybyPos || Math.hypot(pos[0] - this.flybyPos[0], pos[2] - this.flybyPos[2]) > Math.max(200, sp * 6);
    if (reset) {
      const lead = Math.max(60, sp * 4);
      const dir = sp > 5 ? [v[0] / sp, 0, v[2] / sp] : rotateVec(rot, [0, 0, -1]);
      this.flybyPos = [pos[0] + dir[0] * lead + dir[2] * 18, Math.max(1.5, pos[1] + 4), pos[2] + dir[2] * lead - dir[0] * 18];
    }
    return { pos: this.flybyPos.slice(), rot: lookRotation(this.flybyPos, pos), fov: 50 * this.fovScale };
  }
}
