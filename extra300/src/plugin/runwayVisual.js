// runwayVisual.js — a destination's runway drawn by us (render/icaoRunway.js) over Google's
// photograph of it: the pavement with its own asphalt (runwayMacro in the destination's style), the
// markings, the taxi lines. Under Google's tiles the photo is cut away beneath it (extra300.js
// publishes the box); without them it lies on our own terrain's pavement.

import { buildIcaoRunway } from '../render/icaoRunway.js';
import { PALETTE } from '../render/scenery.js';
import { material, meshEntity } from './pcMesh.js';
import { groundMaterial } from './groundMaterial.js';

export class RunwayVisual {
  /**
   * @param {object} app
   * @param {object} parent  the world root
   * @param {object} rw      the world's runway, with its layout and style
   * @param {string} key     names its painted image (one per destination)
   */
  constructor(app, parent, rw, key) {
    this.root = new pc.Entity('DestinationRunway');
    parent.addChild(this.root);
    const b = buildIcaoRunway(rw, rw.layout);
    this.extent = { u: b.areas[0].u, v: b.areas[0].v };
    const own = { key, u: b.u, v: b.v, areas: b.areas, style: rw.style, size: [512, 4096] };
    const parts = [
      { name: 'runway', mesh: b.asphalt, color: PALETTE.asphalt, bias: -2, paint: null },
      { name: 'markings', mesh: b.paint, color: PALETTE.marking, bias: -3, paint: PALETTE.marking },
      { name: 'taxiLine', mesh: b.yel, color: PALETTE.yellow, bias: -3, paint: PALETTE.yellow },
    ];
    this.materials = [];
    const textured = [];
    for (const p of parts) {
      if (!p.mesh.vertexCount) continue;
      // plain colours while the textures are painted
      const m = material(p.color).clone();
      m.depthBias = p.bias; m.slopeDepthBias = p.bias;
      m.update();
      this.materials.push(m);
      const e = meshEntity(app, this.root, p.name, p.mesh, m, { castShadows: false, receiveShadows: true });
      textured.push({ p, e });
    }
    // one texture a frame (the asphalt's image takes a moment)
    const paint = () => {
      const t = textured.shift();
      if (!t || this._destroyed) return;
      try {
        const m = groundMaterial(app.graphicsDevice, t.p.paint ? 'paint-runway' : 'runway', rw, b.areas, t.p.bias, t.p.paint, own);
        for (const mi of t.e.render?.meshInstances || []) mi.material = m;
        this.materials.push(m);
      } catch (err) {
        console.warn('[extra300] runway texture failed, keeping the plain colour:', err);
      }
      setTimeout(paint, 0);
    };
    setTimeout(paint, 0);
  }

  set visible(v) { this.root.enabled = v; }

  destroy() {
    this._destroyed = true;
    this.root.destroy();
    for (const m of this.materials) { m.diffuseMap?.destroy?.(); m.destroy?.(); }
  }
}
