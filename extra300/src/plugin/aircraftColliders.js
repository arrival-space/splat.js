// aircraftColliders.js — the parked airplane, solid to the visitors walking round it: the platform's
// avatar is a physics capsule (Ammo), and a plugin's meshes have no colliders, so it walked straight
// through the airplane. Boxes are made from the model itself: each outside part's bounds, a long part
// (a wing, the fuselage, a 777's anything) cut into slices along its length so the boxes follow its
// taper. Each is a kinematic body riding with the airplane; you can stand on the wings and jump on the
// tail. While flying they are off (the pilot rides it; nobody else is in this space's copy of it).

import { fromBody } from '../render/geometry.js';

// inside the cockpit, or not there to stand on
const SKIP = /seat|harness|buckle|stick|pedal|throttle|knob|panel|dial|bezel|mark|att(Sky|Ground)|toggle|gps|hood|inset|display|screen|lamp|cockpitShell|floor|prop|hud|debug/i;
const SLICE = 0.6;   // m: a long part's slices
const MIN = 0.12;    // m: smaller parts are left out

/** Boxes ({ c: centre, h: half extents }, the airplane's root frame, metres) from its model parts. */
export function colliderBoxes(parts) {
  const boxes = [];
  for (const part of parts) {
    if (SKIP.test(part.name) || part.parent || part.transparent || /prop|flame|glow|stick/i.test(part.kind || '')) continue;
    const p = part.mesh?.positions;
    if (!p?.length) continue;
    // a moving part's mesh is about its hinge
    const o = part.hinge ? fromBody(part.hinge) : [0, 0, 0];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k] + o[k]); hi[k] = Math.max(hi[k], p[i + k] + o[k]); }
    const size = hi.map((v, k) => v - lo[k]);
    if (Math.max(...size) < MIN) continue;
    const ax = size.indexOf(Math.max(...size));
    const n = Math.max(1, Math.min(24, Math.ceil(size[ax] / SLICE)));
    for (let s = 0; s < n; s++) {
      const a0 = lo[ax] + (size[ax] * s) / n, a1 = lo[ax] + (size[ax] * (s + 1)) / n;
      const l = [Infinity, Infinity, Infinity], h = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) {
        const v = p[i + ax] + o[ax];
        if (v < a0 - 1e-6 || v > a1 + 1e-6) continue;
        for (let k = 0; k < 3; k++) { l[k] = Math.min(l[k], p[i + k] + o[k]); h[k] = Math.max(h[k], p[i + k] + o[k]); }
      }
      if (!Number.isFinite(l[0])) continue;
      l[ax] = a0; h[ax] = a1;   // the slice's full length: no gaps between slices
      const half = h.map((v, k) => Math.max(0.02, (v - l[k]) / 2));
      boxes.push({ c: l.map((v, k) => (v + h[k]) / 2), h: half });
    }
  }
  return boxes;
}

export class AircraftColliders {
  /**
   * @param {pc.AppBase} app
   * @param {pc.Entity} root  the airplane's root (metres, under the world's scale)
   * @param {object[]} parts  its model
   * @param {number} ws       the world's scale (primitive colliders ignore entity scale: world units)
   */
  constructor(app, root, parts, ws) {
    Object.assign(this, { app, parent: root, parts, ws, root: null, on: true });
    this.tick();
  }

  /** Built once the platform's physics (Ammo) is there: it may load after us (none in the harness). */
  tick() {
    if (this.root || this.destroyed || !this.app.systems.rigidbody || typeof Ammo === 'undefined') return;
    const ws = this.ws;
    this.root = new pc.Entity('AircraftColliders');
    this.root.enabled = this.on;
    this.parent.addChild(this.root);
    for (const b of colliderBoxes(this.parts)) {
      const e = new pc.Entity('aircraftCollider');
      e.setLocalPosition(b.c[0], b.c[1], b.c[2]);
      e.addComponent('collision', { type: 'box', halfExtents: new pc.Vec3(b.h[0] * ws, b.h[1] * ws, b.h[2] * ws) });
      e.addComponent('rigidbody', { type: pc.BODYTYPE_KINEMATIC, friction: 0.8, restitution: 0 });
      this.root.addChild(e);
    }
  }

  /** Solid while parked, off in flight. */
  set enabled(on) { this.on = on; if (this.root) this.root.enabled = on; }

  destroy() { this.destroyed = true; this.root?.destroy(); this.root = null; }
}
