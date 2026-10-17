// lasers.js — the X-wing's four laser cannons: held Space (or a pad's A, or the Fire button on a
// phone) fires them in alternating pairs. A bolt is a red streak that leaves the muzzle at the
// ship's speed plus ~600 m/s and burns out after a second and a half. They are light only: they
// hit nothing.

import { cannonTips } from '../render/xwingModel.js';
import { nedToRender } from '../render/cameraRig.js';
import { MeshBuilder } from '../render/geometry.js';
import { qRotate } from '../math/quat.js';
import { meshEntity } from './pcMesh.js';

const BOLT_SPEED = 600;    // m/s on top of the ship's own
const LIFE = 1.5;          // s
const RATE = 7;            // pairs per second
const POOL = 48;

/** A thin glowing bar along −z (the bolt's direction), 7 m long, its front at 0. */
function boltMesh() {
  const mb = new MeshBuilder();
  mb.box([-0.07, -0.07, 0], [0.07, 0.07, 7]);
  return mb;
}

export class Lasers {
  constructor(app, parent) {
    this.parent = parent;
    const mesh = boltMesh();
    // a solid red glow (an additive one burns out to white against the sky)
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(0, 0, 0);
    mat.emissive = new pc.Color(1, 0.12, 0.08);
    mat.emissiveIntensity = 1.6;
    mat.useLighting = false;
    mat.useFog = false;
    mat.update();
    this.mat = mat;
    this.bolts = Array.from({ length: POOL }, (_, i) => {
      const e = meshEntity(app, parent, `laserBolt${i}`, mesh, mat, { castShadows: false, receiveShadows: false });
      e.enabled = false;
      return { e, life: 0, pos: [0, 0, 0], vel: [0, 0, 0] };
    });
    this.next = 0;
    this.cool = 0;
    this.pair = 0;
    this._q = new pc.Quat();
  }

  /**
   * @param {object} ac  the Aircraft
   * @param {boolean} trigger  held
   * @param {number} dt
   * @returns {number} pairs fired this frame (for the sound)
   */
  update(ac, trigger, dt) {
    let fired = 0;
    this.cool -= dt;
    const ready = (ac.sfoilPos || 0) > 0.9 && ac.engine.running;
    if (trigger && ready && this.cool <= 0) {
      this.cool = 1 / RATE;
      const tips = cannonTips(ac.sfoilPos);
      const pair = this.pair ? [tips[1], tips[2]] : [tips[0], tips[3]];
      this.pair ^= 1;
      const ref = ac.referencePoint();
      const fwd = qRotate(ac.state.q, [1, 0, 0]);
      for (const tip of pair) {
        const o = qRotate(ac.state.q, tip);
        const b = this.bolts[this.next];
        this.next = (this.next + 1) % POOL;
        b.pos = [ref[0] + o[0], ref[1] + o[1], ref[2] + o[2]];
        b.vel = [ac.state.vel[0] + fwd[0] * BOLT_SPEED, ac.state.vel[1] + fwd[1] * BOLT_SPEED, ac.state.vel[2] + fwd[2] * BOLT_SPEED];
        b.life = LIFE;
        b.e.enabled = true;
        // the bolt's −z along its flight: the airplane's own render rotation turns −z onto the nose
        const q = ac.state.q;
        this._q.set(q[2], -q[3], -q[1], q[0]);
        b.e.setLocalRotation(this._q);
      }
      fired = 1;
    }
    for (const b of this.bolts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) { b.e.enabled = false; continue; }
      for (let k = 0; k < 3; k++) b.pos[k] += b.vel[k] * dt;
      const p = nedToRender(b.pos);
      b.e.setLocalPosition(p[0], p[1], p[2]);
    }
    return fired;
  }

  hide() { for (const b of this.bolts) { b.life = 0; b.e.enabled = false; } }
  destroy() { for (const b of this.bolts) b.e.destroy(); this.mat.destroy?.(); }
}
