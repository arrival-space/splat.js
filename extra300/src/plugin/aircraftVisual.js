// aircraftVisual.js — the Extra's entity tree, posed from the simulation.

import { buildExtraModel } from '../render/extraModel.js';
import { fromBody } from '../render/geometry.js';
import { nedToRender, simToRenderQuat } from '../render/cameraRig.js';
import { material, meshEntity } from './pcMesh.js';
import { glassMaterial } from './glassMaterial.js';

const STICK_THROW = 0.3;   // rad of stick travel at full deflection [est]

export class AircraftVisual {
  constructor(app, parent) {
    this.root = new pc.Entity('Extra300L');
    parent.addChild(this.root);
    this.moving = [];
    this._q = new pc.Quat();
    this._q2 = new pc.Quat();
    this.propAngle = 0;
    for (const part of buildExtraModel()) {
      const mat = part.name === 'canopy' ? glassMaterial(app.graphicsDevice, part.color)
        : material(part.color, part.transparent ? { transparent: true, opacity: part.kind === 'propDisc' ? 0 : 0.28 } : {});
      if (!part.hinge) {
        meshEntity(app, this.root, part.name, part.mesh, mat);
        continue;
      }
      const pivot = new pc.Entity(`${part.name}Pivot`);
      const hp = fromBody(part.hinge);
      pivot.setLocalPosition(hp[0], hp[1], hp[2]);
      this.root.addChild(pivot);
      const ent = meshEntity(app, pivot, part.name, part.mesh, part.kind === 'propDisc' ? material('#202226', { transparent: true, opacity: 0.07 }) : mat, { castShadows: part.kind !== 'propDisc' });
      const ax = fromBody(part.axis);
      const l = Math.hypot(ax[0], ax[1], ax[2]);
      this.moving.push({ ...part, pivot, ent, axis: new pc.Vec3(ax[0] / l, ax[1] / l, ax[2] / l), base: hp });
    }
  }

  /** Hide what the pilot's own eye shouldn't see through (canopy from inside). */
  setCockpitView(inside) {
    this.inside = inside;
    for (const e of this.root.find((n) => n.name === 'canopy')) e.enabled = !inside;
  }

  /** Pose the whole airplane and its moving parts from the sim. */
  update(ac, dt) {
    const p = nedToRender(ac.referencePoint());
    this.root.setLocalPosition(p[0], p[1], p[2]);
    const q = simToRenderQuat(ac.state.q);
    this.root.setLocalRotation(q[0], q[1], q[2], q[3]);

    const strips = ac.aero.strips;
    // surface deflection (rad, trailing edge toward the lift-positive side) from the aero strips
    const defl = (name, side = null) => {
      const s = strips.find((st) => st.control && st.control.input === name && (side == null || st.side === side));
      return s ? s.deflection : 0;
    };
    const RAD = 180 / Math.PI;
    this.propAngle = (this.propAngle + ac.rpm * (360 / 60) * dt * ac.spec.engine.rotation) % 360;
    for (const m of this.moving) {
      let angle = 0;
      switch (m.kind) {
        case 'aileron': angle = defl('aileron', m.side) * m.side; break;
        case 'elevator': angle = defl('elevator'); break;
        case 'rudder': angle = defl('rudder'); break;
        case 'prop':
          // once it is turning in earnest the eye sees a disc, not blades
          m.ent.enabled = ac.rpm < 350;
          angle = (this.propAngle * Math.PI) / 180;
          break;
        case 'propDisc':
          m.ent.enabled = ac.rpm > 400;
          break;
        case 'wheel':
        case 'tailwheel': {
          const g = ac.gear.units[m.gear];
          const hub = fromBody([m.hinge[0], m.hinge[1], m.hinge[2] - g.compression]);
          m.pivot.setLocalPosition(hub[0], hub[1], hub[2]);
          angle = -g.wheelAngle;
          if (m.kind === 'tailwheel') {
            // steer about body z, then spin about the axle
            this._q2.setFromAxisAngle(pc.Vec3.DOWN, g.steerAngle * RAD);
            this._q.setFromAxisAngle(m.axis, angle * RAD);
            this._q2.mul(this._q);
            m.pivot.setLocalRotation(this._q2);
            continue;
          }
          break;
        }
        case 'stick': {
          // the stick follows the controls: back for up elevator, sideways with the ailerons
          const c = ac.controls;
          // about body x (roll: top to the right for right aileron) and body y (pitch: top aft for a pull)
          this._stickRoll ??= new pc.Vec3(...fromBody([1, 0, 0]));
          this._stickPitch ??= new pc.Vec3(...fromBody([0, 1, 0]));
          this._q.setFromAxisAngle(this._stickRoll, (c.aileron || 0) * STICK_THROW * RAD);
          this._q2.setFromAxisAngle(this._stickPitch, (c.elevator || 0) * STICK_THROW * RAD);
          this._q.mul(this._q2);
          m.pivot.setLocalRotation(this._q);
          continue;
        }
        default: break;
      }
      this._q.setFromAxisAngle(m.axis, angle * RAD);
      m.pivot.setLocalRotation(this._q);
    }
  }

  destroy() { this.root.destroy(); }
}
