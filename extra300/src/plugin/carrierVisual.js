// carrierVisual.js — the carrier in the scene (render/carrierModel.js), and
// what moves on it: the arresting wires, drawn taut across the deck or
// pulled out into a V behind a hook that has caught one, and the Fresnel
// lens's ball, which rides above or below the green datum lights as the
// airplane is high or low on the glide slope (red when dangerously low).

import { buildCarrierModel, lensLights } from '../render/carrierModel.js';
import { fromNE, MeshBuilder } from '../render/geometry.js';
import { deckMacro, DECK_UV, hullTexture } from '../render/carrierTextures.js';
import { material, meshEntity } from './pcMesh.js';
import { paintMaterial } from './finishes.js';
import { detail, upload } from './groundMaterial.js';

const WIRE_R = 0.06;    // m: a 1 3/8 in cross-deck pendant, drawn a little thicker to be seen

/** A unit cylinder along +y, from 0 to 1. */
function rod(segs = 6) {
  const mb = new MeshBuilder();
  const ring = (y) => Array.from({ length: segs }, (_, k) => [Math.cos((2 * Math.PI * k) / segs), y, Math.sin((2 * Math.PI * k) / segs)]);
  mb.loft([ring(0), ring(1)], { closeEnds: false });
  return mb;
}

function box() { return new MeshBuilder().box([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]); }

export class CarrierVisual {
  /**
   * @param {object} app
   * @param {object} parent   the world root (render metres)
   * @param {object} carrier  world/carrier.js buildCarrier()
   * @param {number} water    the lake's level
   */
  constructor(app, parent, carrier, water) {
    this.carrier = carrier;
    this.parent = parent;
    this.root = new pc.Entity('Carrier');
    parent.addChild(this.root);
    const [n0, e0] = carrier.toNE(0, 0);
    const o = fromNE(n0, e0, 0);
    this.root.setLocalPosition(o[0], o[1], o[2]);
    this.root.setLocalEulerAngles(0, (-carrier.heading * 180) / Math.PI, 0);
    const dev = app.graphicsDevice;
    this._owned = [];
    for (const part of buildCarrierModel(carrier, water)) {
      const m = this._material(dev, part, carrier, water);
      const flat = part.finish === 'mark';
      meshEntity(app, this.root, part.name, part.mesh, m, { castShadows: !flat && part.finish !== 'deck', receiveShadows: true });
    }
    // the wires: two halves each, so a caught one can be drawn as a V
    const wireMat = material('#2b2d30');
    const rodMesh = rod();
    this.wires = carrier.wires.map((w) => ({
      w,
      halves: [0, 1].map((k) => {
        const e = meshEntity(app, parent, `wire${w.index}${k ? 'R' : 'L'}`, rodMesh, wireMat, { castShadows: false });
        return e;
      }),
    }));
    // the lens: green datum bars either side, the ball's cell in the middle (amber, or red when low)
    const L = lensLights(carrier);
    this.lens = L;
    const green = material('#0a3', { emissive: '#3dff6a' });
    this.amber = material('#320', { emissive: '#ffb020' });
    this.red = material('#300', { emissive: '#ff2a1a' });
    const local = (s, t, h) => [t, h, -s];
    for (const side of [-1, 1]) {
      const bar = meshEntity(app, this.root, `datum${side < 0 ? 'L' : 'R'}`, box(), green, { castShadows: false });
      const p = local(L.s - 0.02, L.t + side * (L.datumHalf[0] + L.datumHalf[1]) / 2, L.h);
      bar.setLocalPosition(p[0], p[1], p[2]);
      bar.setLocalScale(L.datumHalf[1] - L.datumHalf[0], 0.22, 0.12);
    }
    this.ball = meshEntity(app, this.root, 'meatball', box(), this.amber, { castShadows: false });
    this.ball.setLocalScale(0.9, L.cell * 0.9, 0.14);
    this._v = new pc.Vec3();
    this._q = new pc.Quat();
    this.update(null);
  }

  /** The material for one of the model's parts, by its finish. */
  _material(dev, part, carrier, water) {
    const own = (m) => { this._owned.push(m); return m; };
    switch (part.finish) {
      case 'hull': {
        // the hull's strip of plating, repeating along the ship, the boot top at the waterline
        const m = new pc.StandardMaterial();
        const tex = upload(dev, hullTexture({ along: 64, height: carrier.deckH - water + 2, below: 2 }), { srgb: true, repeat: true });
        tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
        this._owned.push(tex);
        m.diffuseMap = tex;
        m.useMetalness = true;
        m.metalness = 0;
        m.gloss = 0.42;
        m.update();
        return own(m);
      }
      case 'deck': {
        // the deck's one big image, the non-skid's grit on top as a normal map every 2 m
        const m = new pc.StandardMaterial();
        const tex = upload(dev, deckMacro(carrier.data), { srgb: true, repeat: false });
        this._owned.push(tex);
        m.diffuseMap = tex;
        m.normalMap = detail(dev, 'asphaltNormal');
        m.normalMapTiling = new pc.Vec2((DECK_UV.t[1] - DECK_UV.t[0]) / 2, (DECK_UV.s[1] - DECK_UV.s[0]) / 2);
        m.bumpiness = 0.8;
        m.useMetalness = true;
        m.metalness = 0;
        m.gloss = 0.3;
        m.update();
        return own(m);
      }
      case 'paint': return paintMaterial(dev, part.color, true);
      case 'glass': return paintMaterial(dev, part.color, false);
      case 'emissive': return material(part.color, { emissive: '#ffd890' });
      case 'mark': {
        // the markings lie on the deck: pulled forward in depth so they never flicker into it
        const m = material(part.color).clone();
        m.depthBias = -2; m.slopeDepthBias = -2;
        m.gloss = 0.4;
        m.update();
        return own(m);
      }
      default: return material(part.color);
    }
  }

  set visible(v) {
    this.root.enabled = v;
    for (const w of this.wires) for (const h of w.halves) h.enabled = v;
  }

  /** Lay a half-wire from a to b (NE + height, metres). */
  _span(e, a, b) {
    const pa = fromNE(a[0], a[1], a[2]), pb = fromNE(b[0], b[1], b[2]);
    const d = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const l = Math.hypot(d[0], d[1], d[2]) || 1e-3;
    e.setLocalPosition(pa[0], pa[1], pa[2]);
    // turn +y onto the wire's direction
    const ux = d[0] / l, uy = d[1] / l, uz = d[2] / l;
    const ax = [uz, 0, -ux];                     // up × dir
    const al = Math.hypot(ax[0], ax[2]);
    if (al < 1e-6) this._q.set(0, 0, 0, 1);
    else this._q.setFromAxisAngle(this._v.set(ax[0] / al, 0, ax[2] / al), (Math.acos(Math.max(-1, Math.min(1, uy))) * 180) / Math.PI);
    e.setLocalRotation(this._q);
    e.setLocalScale(WIRE_R, l, WIRE_R);
  }

  /** @param {object|null} ac  the airplane: where its hook is, which wire it holds, how high on the glide slope */
  update(ac) {
    const cv = this.carrier;
    const h = cv.deckH + 0.07;
    const engaged = ac?.arrestor?.engaged;
    for (const { w, halves } of this.wires) {
      if (engaged && engaged.wire === w && ac.hookTip) {
        const tip = [ac.hookTip[0], ac.hookTip[1], Math.max(h, -ac.hookTip[2])];
        this._span(halves[0], [w.ends[0][0], w.ends[0][1], h], tip);
        this._span(halves[1], [w.ends[1][0], w.ends[1][1], h], tip);
      } else {
        this._span(halves[0], [w.ends[0][0], w.ends[0][1], h], [w.centre[0], w.centre[1], h]);
        this._span(halves[1], [w.ends[1][0], w.ends[1][1], h], [w.centre[0], w.centre[1], h]);
      }
    }
    // the ball: one cell per ~0.25° off the glide slope, up to the lens's ends
    const L = this.lens;
    let dev = 0;
    if (ac) {
      const p = ac.hookTip || ac.state.pos;
      const behind = cv.aimAlong - cv.along(p[0], p[1]);
      dev = behind > 30 ? cv.glideDeviation(p[0], p[1], -p[2]) : 0;
    }
    const cells = Math.max(-2.6, Math.min(2.6, dev / 0.25));
    const y = L.h + cells * L.cell;
    this.ball.setLocalPosition(L.t, y, -(L.s - 0.02));
    const low = cells < -2;
    const mi = this.ball.render?.meshInstances?.[0];
    if (mi) mi.material = low ? this.red : this.amber;
  }

  destroy() {
    this.root.destroy();
    for (const m of this._owned) m.destroy?.();
    for (const w of this.wires) for (const h of w.halves) h.destroy();
  }
}
