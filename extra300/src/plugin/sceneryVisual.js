// sceneryVisual.js — Meigs Field itself: the island, the runway, the tower, the lake round it.

import { buildScenery } from '../render/scenery.js';
import { material, meshEntity } from './pcMesh.js';
import { groundMaterial } from './groundMaterial.js';
import { glassMaterial, metalMaterial } from './finishes.js';

export class SceneryVisual {
  constructor(app, parent, world) {
    this.root = new pc.Entity('MeigsScenery');
    parent.addChild(this.root);
    const parts = buildScenery(world);
    this.tower = parts.tower;            // the beacon's and the obstruction light's places, for the lights
    const textured = [];
    for (const part of parts) {
      if (!part.mesh.vertexCount) continue;
      const flat = ['lake', 'island', 'runway', 'markings', 'taxiLine'].includes(part.name);
      let mat = part.finish === 'glass' ? glassMaterial(app.graphicsDevice, part.color)
        : part.finish === 'metal' ? metalMaterial(app.graphicsDevice, part.color)
          : part.finish === 'mirror' ? metalMaterial(app.graphicsDevice, part.color, true) : material(part.color);
      if (part.bias || part.cullBack) {
        mat = mat.clone();
        if (part.bias) { mat.depthBias = part.bias; mat.slopeDepthBias = part.bias; }
        if (part.cullBack) mat.cull = pc.CULLFACE_BACK;
        mat.update();
      }
      const e = meshEntity(app, this.root, part.name, part.mesh, mat, { castShadows: !flat, receiveShadows: true });
      if (part.name === 'lake') this.lake = e;
      if (part.texture) textured.push({ part, e });
    }
    // the textures take a moment to paint (~1 s in all): one per frame, plain colours meanwhile
    const paint = () => {
      const t = textured.shift();
      if (!t || this._destroyed) return;
      try {
        const m = groundMaterial(app.graphicsDevice, t.part.texture, world.runway, parts.paved, t.part.bias || 0, t.part.paint || null);
        for (const mi of t.e.render?.meshInstances || []) mi.material = m;
        this.materials.push(m);
      } catch (err) {
        console.warn('[extra300] ground texture failed, keeping the plain colour:', err);
      }
      setTimeout(paint, 0);
    };
    this.materials = [];
    setTimeout(paint, 0);
  }
  set visible(v) { this.root.enabled = v; }
  /** With Google's tiles only Meigs itself stays; Google's own lake is the water. */
  setGoogle(on) {
    if (this.lake) this.lake.enabled = !on;
  }
  destroy() {
    this._destroyed = true;
    this.root.destroy();
    for (const m of this.materials) { m.diffuseMap?.destroy?.(); m.destroy?.(); }
  }
}
