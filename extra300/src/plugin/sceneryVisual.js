// sceneryVisual.js — Meigs Field and the lakefront as PlayCanvas entities.

import { buildScenery } from '../render/scenery.js';
import { material, meshEntity } from './pcMesh.js';

export class SceneryVisual {
  constructor(app, parent, world) {
    this.root = new pc.Entity('MeigsScenery');
    parent.addChild(this.root);
    for (const part of buildScenery(world)) {
      if (!part.mesh.vertexCount) continue;
      const flat = ['lake', 'mainland', 'island', 'runway', 'markings', 'taxiLine'].includes(part.name);
      meshEntity(app, this.root, part.name, part.mesh, material(part.color), { castShadows: !flat, receiveShadows: true });
    }
  }
  set visible(v) { this.root.enabled = v; }
  destroy() { this.root.destroy(); }
}
