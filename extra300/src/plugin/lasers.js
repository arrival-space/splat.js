// lasers.js — the X-wing's four laser cannons: held Space (or a pad's A, or the Fire button on a
// phone) fires them in alternating pairs. A bolt is a blue streak, far brighter than white (the HDR
// bloom spreads its glow), that leaves the muzzle at the ship's speed plus ~600 m/s and burns out
// after a second and a half, or where it hits something (the ground, the water, a building, the
// ship): there it bursts into a blue flare.

import { discTexture } from './lightsVisual.js';

import { cannonTips } from '../render/xwingModel.js';
import { nedToRender } from '../render/cameraRig.js';
import { MeshBuilder } from '../render/geometry.js';
import { qRotate } from '../math/quat.js';
import { meshEntity } from './pcMesh.js';

const BOLT_SPEED = 600;    // m/s on top of the ship's own
const LIFE = 1.5;          // s
const RATE = 7;            // pairs per second
const POOL = 48;
const FLARES = 16;
const FLARE_LIFE = 0.45;   // s
const FLARE_SIZE = 7;      // m across at its widest
const BLUE = [0.04, 0.22, 1];

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
    // a solid blue glow, many times brighter than white: a white-hot core, blue in the bloom
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(0, 0, 0);
    mat.emissive = new pc.Color(...BLUE);
    mat.emissiveIntensity = 12;
    mat.useLighting = false;
    mat.useFog = false;
    mat.update();
    this.mat = mat;
    this.bolts = Array.from({ length: POOL }, (_, i) => {
      const e = meshEntity(app, parent, `laserBolt${i}`, mesh, mat, { castShadows: false, receiveShadows: false });
      e.enabled = false;
      return { e, life: 0, pos: [0, 0, 0], vel: [0, 0, 0] };
    });
    // the flares: camera-facing quads, an additive soft disc each (each its own material, to fade)
    const dev = app.graphicsDevice;
    const quad = new pc.Mesh(dev);
    quad.setPositions(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]));
    quad.setUvs(0, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
    quad.setIndices(new Uint16Array([0, 1, 2, 0, 2, 3]));
    quad.update(pc.PRIMITIVE_TRIANGLES);
    this._quad = quad;
    this.flares = Array.from({ length: FLARES }, (_, i) => {
      const m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(0, 0, 0);
      m.emissive = new pc.Color(...BLUE);
      m.emissiveMap = discTexture(dev);
      m.emissiveMapChannel = 'a';            // the disc's falloff is in its alpha (its colour is white)
      m.useLighting = false;
      m.useFog = false;
      m.blendType = pc.BLEND_ADDITIVE;
      m.depthWrite = false;
      m.cull = pc.CULLFACE_NONE;
      m.update();
      const e = new pc.Entity(`laserFlare${i}`);
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(quad, m)], castShadows: false, receiveShadows: false });
      e.enabled = false;
      parent.addChild(e);
      return { e, m, life: 0 };
    });
    this.nextFlare = 0;
    this.next = 0;
    this.cool = 0;
    this.pair = 0;
    this._q = new pc.Quat();
  }

  /**
   * @param {object} ac  the Aircraft
   * @param {boolean} trigger  held
   * @param {number} dt
   * @param {(n: number, e: number, h: number) => boolean} [solid]  whether a point is inside something
   * @returns {number} pairs fired this frame (for the sound)
   */
  update(ac, trigger, dt, solid = null) {
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
      const p0 = b.pos.slice();
      for (let k = 0; k < 3; k++) b.pos[k] += b.vel[k] * dt;
      // the bolt's front through something this frame: find where (in steps of a few metres, then
      // halving), flare there and go out
      if (solid) {
        const at = (f) => [p0[0] + (b.pos[0] - p0[0]) * f, p0[1] + (b.pos[1] - p0[1]) * f, p0[2] + (b.pos[2] - p0[2]) * f];
        const inside = (f) => { const q = at(f); return solid(q[0], q[1], -q[2]); };
        const n = Math.max(1, Math.ceil(Math.hypot(b.pos[0] - p0[0], b.pos[1] - p0[1], b.pos[2] - p0[2]) / 4));
        let hit = -1;
        for (let i = 1; i <= n; i++) if (inside(i / n)) { hit = i / n; break; }
        if (hit >= 0) {
          let lo = hit - 1 / n, hi = hit;
          for (let j = 0; j < 5; j++) { const m = (lo + hi) / 2; if (inside(m)) hi = m; else lo = m; }
          this._flare(at(lo));
          b.life = 0;
          b.e.enabled = false;
          continue;
        }
      }
      const p = nedToRender(b.pos);
      b.e.setLocalPosition(p[0], p[1], p[2]);
    }
    this._flaresTick(dt);
    return fired;
  }

  _flare(pos) {
    const f = this.flares[this.nextFlare];
    this.nextFlare = (this.nextFlare + 1) % FLARES;
    f.life = FLARE_LIFE;
    const p = nedToRender(pos);
    f.e.setLocalPosition(p[0], p[1], p[2]);
    f.e.enabled = true;
  }

  /** The flares bloom out and fade, each turned to the camera. */
  _flaresTick(dt) {
    const cam = globalThis.ArrivalSpace?.getCamera?.();
    for (const f of this.flares) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.e.enabled = false; continue; }
      const t = 1 - f.life / FLARE_LIFE;                  // 0 … 1 over its life
      const s = FLARE_SIZE * (0.35 + 0.65 * Math.sqrt(t));
      f.e.setLocalScale(s, s, s);
      if (cam) f.e.setRotation(cam.getRotation());
      f.m.emissiveIntensity = 14 * (1 - t) * (1 - t);
      f.m.update();
    }
  }

  hide() {
    for (const b of this.bolts) { b.life = 0; b.e.enabled = false; }
    for (const f of this.flares) { f.life = 0; f.e.enabled = false; }
  }

  destroy() {
    for (const b of this.bolts) b.e.destroy();
    for (const f of this.flares) { f.e.destroy(); f.m.destroy(); }
    this._quad.destroy();
    this.mat.destroy?.();
  }
}
