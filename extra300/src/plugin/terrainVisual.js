// terrainVisual.js — a destination's own ground in the scene (render/terrainModel.js), for when
// Google's 3D tiles aren't streaming: the mountains from the elevation grids and the airport's
// pavement on them.

import { buildTerrainModel } from '../render/terrainModel.js';
import { material, meshEntity } from './pcMesh.js';

export class TerrainVisual {
  constructor(app, parent, world, dem) {
    this.root = new pc.Entity('DestinationTerrain');
    parent.addChild(this.root);
    this._owned = [];
    for (const part of buildTerrainModel(world, dem)) {
      let m;
      if (part.vertexColor) {
        m = new pc.StandardMaterial();
        m.diffuse = new pc.Color(1, 1, 1);
        m.diffuseVertexColor = true;
        m.useMetalness = true;
        m.metalness = 0;
        m.gloss = 0.15;
        m.update();
        this._owned.push(m);
      } else {
        m = material(part.color).clone();
        if (part.bias) { m.depthBias = part.bias; m.slopeDepthBias = part.bias; }
        m.update();
        this._owned.push(m);
      }
      meshEntity(app, this.root, part.name, part.mesh, m, { castShadows: part.name !== 'terrain', receiveShadows: true });
    }
  }

  set visible(v) { this.root.enabled = v; }

  destroy() {
    this.root.destroy();
    for (const m of this._owned) m.destroy?.();
  }
}
