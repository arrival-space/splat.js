// pcMesh.js — hand MeshBuilder output to PlayCanvas. `pc` is the global the
// Arrival client (and the local harness) provides.

const materialCache = new Map();

export function material(color, { transparent = false, opacity = 1, emissive = null, twoSided = true } = {}) {
  const key = `${color}|${transparent}|${opacity}|${emissive}|${twoSided}`;
  if (materialCache.has(key)) return materialCache.get(key);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color().fromString(color);
  m.useMetalness = true;
  m.metalness = 0.0;
  m.gloss = transparent ? 0.9 : 0.35;
  if (emissive) { m.emissive = new pc.Color().fromString(emissive); }
  if (twoSided) m.cull = pc.CULLFACE_NONE;
  if (transparent) {
    m.blendType = pc.BLEND_NORMAL;
    m.opacity = opacity;
    m.depthWrite = false;
  }
  m.update();
  materialCache.set(key, m);
  return m;
}

export function disposeMaterials() {
  for (const m of materialCache.values()) m.destroy?.();
  materialCache.clear();
}

/** pc.Mesh from a MeshBuilder. */
export function toMesh(device, mb) {
  const mesh = new pc.Mesh(device);
  mesh.setPositions(new Float32Array(mb.positions));
  mesh.setNormals(new Float32Array(mb.normals));
  if (mb.uvs) mesh.setUvs(0, new Float32Array(mb.uvs));
  if (mb.colors) mesh.setColors32(new Uint8Array(mb.colors));
  const idx = mb.vertexCount > 65535 ? new Uint32Array(mb.indices) : new Uint16Array(mb.indices);
  mesh.setIndices(idx);
  mesh.update(pc.PRIMITIVE_TRIANGLES);
  return mesh;
}

/** An entity rendering one MeshBuilder with one material, parented to `parent`. */
export function meshEntity(app, parent, name, mb, mat, { castShadows = true, receiveShadows = true } = {}) {
  const e = new pc.Entity(name);
  if (!mb.vertexCount) { parent.addChild(e); return e; }   // nothing to draw (e.g. no parks in the box)
  const mi = new pc.MeshInstance(toMesh(app.graphicsDevice, mb), mat);
  e.addComponent('render', { meshInstances: [mi], castShadows, receiveShadows });
  parent.addChild(e);
  return e;
}
