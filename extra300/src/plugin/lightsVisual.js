// lightsVisual.js — the airfield's lights in the scene (render/airfieldLights.js): the fixtures, one
// additive glow mesh per colour, and the lights that change: the PAPIs (red or white per box, from
// where the camera's eye is), the REIL strobes, the tower's rotating beacon (green, then white) and
// its red obstruction light.

import { buildAirfieldLights, glowQuads } from '../render/airfieldLights.js';
import { MeshBuilder } from '../render/geometry.js';
import { material, meshEntity, toMesh } from './pcMesh.js';

const COLORS = { white: '#fff6e0', green: '#3dff7a', red: '#ff3a2a', blue: '#3a6dff', amber: '#ffb238' };

let disc = null;
/** A soft disc: a bright core falling off to nothing at the edge. */
export function discTexture(device) {
  if (disc) return disc;
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  disc = new pc.Texture(device, { width: S, height: S, format: pc.PIXELFORMAT_RGBA8, mipmaps: true });
  disc.setSource(c);
  return disc;
}

const mats = new Map();
function glowMaterial(device, color) {
  if (mats.has(color)) return mats.get(color);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0, 0, 0);
  m.emissive = new pc.Color().fromString(color);
  m.emissiveIntensity = 3;
  m.emissiveMap = discTexture(device);
  m.opacityMap = discTexture(device);
  m.opacityMapChannel = 'a';
  m.blendType = pc.BLEND_ADDITIVEALPHA;
  m.depthWrite = false;
  m.useLighting = false;
  m.useFog = false;
  m.cull = pc.CULLFACE_NONE;
  m.update();
  mats.set(color, m);
  return m;
}

export class LightsVisual {
  /**
   * @param {object} app
   * @param {object} parent  the world root
   * @param {object} world   buildMeigs()
   * @param {{ beacon: number[], obstruction: number[] }} tower  render/tower.js
   */
  constructor(app, parent, world, tower) {
    this.root = new pc.Entity('AirfieldLights');
    parent.addChild(this.root);
    const dev = app.graphicsDevice;
    const L = buildAirfieldLights(world);
    meshEntity(app, this.root, 'lightFixtures', L.fixtures, material('#2a2c30'), { castShadows: false });
    for (const [color, mb] of Object.entries(L.glows)) {
      meshEntity(app, this.root, `glow-${color}`, mb, glowMaterial(dev, COLORS[color]), { castShadows: false, receiveShadows: false });
    }
    // the changing ones: one small glow entity each
    const single = (p, r, color) => {
      const mb = new MeshBuilder({ uv: true });
      glowQuads(mb, [0, 0, 0], r);
      const e = new pc.Entity('glow');
      e.addComponent('render', { meshInstances: [new pc.MeshInstance(toMesh(dev, mb), glowMaterial(dev, COLORS[color]))], castShadows: false, receiveShadows: false });
      e.setLocalPosition(p[0], p[1], p[2]);
      this.root.addChild(e);
      return e;
    };
    this.papis = L.papis.map((papi) => ({
      ...papi,
      units: papi.units.map((u) => ({ ...u, white: single(u.pos, 1.1, 'white'), red: single(u.pos, 1.1, 'red') })),
    }));
    this.reils = L.reils.flat().map((p) => single(p, 2.2, 'white'));
    this.beacon = { green: single(tower.beacon, 2.4, 'green'), white: single(tower.beacon, 2.4, 'white') };
    single(tower.obstruction, 0.9, 'red');
    this.t = 0;
  }

  set visible(v) { this.root.enabled = v; }

  /**
   * @param {number} dt
   * @param {number[]|null} eye  the camera, in the world root's render metres
   */
  update(dt, eye) {
    this.t += dt;
    // REILs: a short flash twice a second, the pair together
    const flash = this.t % 0.5 < 0.06;
    for (const r of this.reils) r.enabled = flash;
    // the beacon turns at 12 rpm with a green and a white lens: a flash of each every 5 s
    const ph = (this.t / 5) % 1;
    this.beacon.green.enabled = ph < 0.08;
    this.beacon.white.enabled = ph > 0.5 && ph < 0.58;
    // PAPI: the angle from each box up to the eye decides its colour
    for (const papi of this.papis) {
      for (const u of papi.units) {
        let white = false;
        if (eye) {
          const d = (eye[0] - u.pos[0]) * papi.dir[0] + (eye[2] - u.pos[2]) * papi.dir[1];
          white = d > 0 && Math.atan2(eye[1] - u.pos[1], d) > u.transition;
        }
        u.white.enabled = white;
        u.red.enabled = !white;
      }
    }
  }

  destroy() {
    this.root.destroy();
    for (const m of mats.values()) m.destroy?.();
    mats.clear();
    disc?.destroy?.();
    disc = null;
  }
}
