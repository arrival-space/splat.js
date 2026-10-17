// aircraftVisual.js — an airplane's entity tree (the Extra's or the F-15's), posed from the simulation.

import { fromBody } from '../render/geometry.js';
import { nedToRender, simToRenderQuat } from '../render/cameraRig.js';
import { material, meshEntity } from './pcMesh.js';
import { flameMaterial, glassMaterial, metalMaterial, paintMaterial } from './finishes.js';

// the exterior paint: the Extra's glossy, the Eagle's satin greys; cockpit trim, tyres, gauges stay matte
const PAINTED = new Set(['white', 'red', 'yellow', 'navRed', 'navGreen']);
const SATIN = new Set(['grey', 'darkGrey', 'radome', 'gearWhite']);
const METAL = new Set(['metal', 'chrome', 'nozzle']);
const GLASS = new Set(['glass', 'hud']);

const STICK_THROW = 0.3;   // rad of stick travel at full deflection [est]
const SPEEDBRAKE_ANGLE = 50 * Math.PI / 180;

export class AircraftVisual {
  /**
   * @param {object} app
   * @param {object} parent  entity
   * @param {object[]} parts  the model (render/extraModel.js buildExtraModel, render/f15Model.js buildF15Model)
   * @param {string} [name]
   */
  constructor(app, parent, parts, name = 'Aircraft') {
    this.root = new pc.Entity(name);
    parent.addChild(this.root);
    this.moving = [];
    this._q = new pc.Quat();
    this._q2 = new pc.Quat();
    this.propAngle = 0;
    const byName = new Map();
    const dev = app.graphicsDevice;
    for (const part of parts) {
      const mat = part.kind === 'abFlame' ? flameMaterial(part.color)
        : part.kind === 'propDisc' ? material('#202226', { transparent: true, opacity: 0.07 })
          : GLASS.has(part.material) || part.name === 'canopy' ? glassMaterial(dev, part.color)
            : PAINTED.has(part.material) ? paintMaterial(dev, part.color)
              : SATIN.has(part.material) ? paintMaterial(dev, part.color, true)
                : METAL.has(part.material) ? metalMaterial(dev, part.color, part.material === 'chrome')
                  : material(part.color, part.transparent ? { transparent: true, opacity: 0.28 } : {});
      if (!part.hinge) {
        meshEntity(app, this.root, part.name, part.mesh, mat);
        continue;
      }
      // a moving part turns about its hinge; one riding on another (a wheel on its folding leg) hangs
      // from that part's pivot
      const up = part.parent ? byName.get(part.parent) : null;
      const pivot = new pc.Entity(`${part.name}Pivot`);
      const rel = up ? part.hinge.map((v, i) => v - up.hinge[i]) : part.hinge;
      const hp = fromBody(rel);
      pivot.setLocalPosition(hp[0], hp[1], hp[2]);
      (up ? up.pivot : this.root).addChild(pivot);
      const glow = part.kind === 'propDisc' || part.kind === 'abFlame';
      const ent = meshEntity(app, pivot, part.name, part.mesh, mat, { castShadows: !glow, receiveShadows: !glow });
      const ax = fromBody(part.axis);
      const l = Math.hypot(ax[0], ax[1], ax[2]);
      const m = { ...part, pivot, ent, axis: new pc.Vec3(ax[0] / l, ax[1] / l, ax[2] / l), rel };
      this.moving.push(m);
      byName.set(part.name, m);
    }
  }

  /** Hide what the pilot's own eye shouldn't see through (canopy and windscreen from inside). */
  setCockpitView(inside) {
    this.inside = inside;
    for (const e of this.root.find((n) => n.name === 'canopy' || n.name === 'windscreen')) e.enabled = !inside;
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
    if (ac.spec.engine) this.propAngle = (this.propAngle + ac.rpm * (360 / 60) * dt * ac.spec.engine.rotation) % 360;
    for (const m of this.moving) {
      let angle = 0;
      switch (m.kind) {
        case 'aileron': angle = defl('aileron', m.side) * m.side; break;
        case 'flap': angle = defl('flaps', m.side) * m.side; break;
        case 'elevator': angle = defl('elevator'); break;
        case 'stabilator': angle = defl('elevator', m.side); break;
        case 'rudder': angle = defl('rudder'); break;
        case 'speedbrake': angle = -SPEEDBRAKE_ANGLE * (ac.speedbrakePos || 0); break;
        case 'hook': angle = ac.hookAngle || 0; break;   // down from stowed, as far as the deck lets it
        case 'gearLeg':
          // folds forward into its bay as the gear comes up; out of sight once stowed
          m.pivot.enabled = ac.gearPos > 0.02;
          angle = ((m.fold || 90) * Math.PI / 180) * (1 - ac.gearPos);
          break;
        case 'abFlame': {
          const ab = ac.engine.ab || 0;
          m.pivot.enabled = ab > 0.03;
          if (ab > 0.03) {
            const f = 0.45 + 0.55 * ab + 0.04 * Math.sin(performance.now() * 0.05 + m.hinge[1] * 7);
            m.pivot.setLocalScale(f, f, f);
          }
          continue;
        }
        case 'prop':
          // once it is turning in earnest the eye sees a disc, not blades
          m.ent.enabled = ac.rpm < 350;
          angle = (this.propAngle * Math.PI) / 180;
          break;
        case 'propDisc':
          m.ent.enabled = ac.rpm > 400;
          break;
        case 'wheel':
        case 'tailwheel':
        case 'steerwheel': {
          const g = ac.gear.units[m.gear];
          const hub = fromBody([m.rel[0], m.rel[1], m.rel[2] - g.compression]);
          m.pivot.setLocalPosition(hub[0], hub[1], hub[2]);
          angle = -g.wheelAngle;
          if (m.kind !== 'wheel') {
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
