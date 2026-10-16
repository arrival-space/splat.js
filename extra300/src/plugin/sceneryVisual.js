// sceneryVisual.js — Meigs Field itself, plus the hand-placed stand-in city
// that shows until (or unless) the OpenStreetMap city is ready.

import { buildScenery } from '../render/scenery.js';
import { material, meshEntity } from './pcMesh.js';

export class SceneryVisual {
  constructor(app, parent, world) {
    this.root = new pc.Entity('MeigsScenery');
    parent.addChild(this.root);
    this.city = new pc.Entity('StandInCity');
    this.root.addChild(this.city);
    for (const part of buildScenery(world)) {
      if (!part.mesh.vertexCount) continue;
      const flat = ['lake', 'mainland', 'island', 'runway', 'markings', 'taxiLine'].includes(part.name);
      let mat = material(part.color);
      if (part.bias) {
        mat = mat.clone();
        mat.depthBias = part.bias;
        mat.slopeDepthBias = part.bias;
        mat.update();
      }
      const e = meshEntity(app, part.layer === 'city' ? this.city : this.root, part.name, part.mesh, mat, { castShadows: !flat, receiveShadows: true });
      if (part.name === 'lake') this.lake = e;
    }
  }
  set visible(v) { this.root.enabled = v; }
  /** Hide the stand-in city once the OpenStreetMap one is up. */
  set standInCity(v) { this.city.enabled = v; }
  /** With Google's tiles only Meigs itself stays; Google's own lake is the water. */
  setGoogle(on) {
    this.city.enabled = !on && this.city.enabled;
    if (this.lake) this.lake.enabled = !on;
  }
  destroy() { this.root.destroy(); }
}
