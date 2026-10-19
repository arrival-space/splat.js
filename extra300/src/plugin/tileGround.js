// tileGround.js — the height of Google's 3D tiles under a point, read off their meshes (the vertices
// PlayCanvas keeps on the CPU after upload), as the photogrammetry has it: before any flattening,
// which only moves what is drawn. For lining a found airfield's runway up with Google's ground.

const meshCache = new WeakMap();   // mesh → { pos: Float32Array (local, dequantized), idx: Uint32Array|null }

// a normalized integer position (KHR_mesh_quantization) read raw by the vertex iterator: its scale
const norm = (type) => ({ [pc.TYPE_INT8]: 127, [pc.TYPE_UINT8]: 255, [pc.TYPE_INT16]: 32767, [pc.TYPE_UINT16]: 65535 })[type] || 0;

function geometry(mesh) {
  let g = meshCache.get(mesh);
  if (g) return g;
  const vb = mesh.vertexBuffer;
  const el = vb?.format?.elements?.find((e) => e.name === pc.SEMANTIC_POSITION);
  if (!el) return null;
  const n = vb.numVertices, pos = new Float32Array(n * 3);
  mesh.getVertexStream(pc.SEMANTIC_POSITION, pos);
  const k = el.normalize ? norm(el.dataType) : 0;
  if (k) for (let i = 0; i < pos.length; i++) pos[i] /= k;
  const ib = mesh.indexBuffer?.[0];
  let idx = null;
  if (ib) { idx = []; mesh.getIndices(idx); idx = Uint32Array.from(idx); }
  g = { pos, idx, base: mesh.primitive?.[0]?.base ?? 0, count: mesh.primitive?.[0]?.count ?? (idx ? idx.length : n) };
  meshCache.set(mesh, g);
  return g;
}

/** Where a segment (local space, from o along d, t in 0..1) first meets the mesh's triangles: t, or null. */
function hitT(g, o, d) {
  const P = g.pos, I = g.idx;
  let best = null;
  const tri = (a, b, c) => {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
    const e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return;
    const inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t >= 0 && t <= 1 && (best === null || t < best)) best = t;
  };
  const end = g.base + g.count;
  if (I) for (let i = g.base; i + 2 < end; i += 3) tri(I[i], I[i + 1], I[i + 2]);
  else for (let i = g.base; i + 2 < end; i += 3) tri(i, i + 1, i + 2);
  return best;
}

/**
 * The tiles' ground (world y) under world (x, z), from the finest tile drawn there; null where none
 * is (or none finer than maxHalf, world units, half its footprint). `tiles`: the tiles vibe.
 * @returns {{ y: number, half: number } | null}
 */
export function tileGroundY(tiles, x, z, top, bottom, maxHalf = Infinity) {
  const cands = [];
  for (const rec of tiles?._records?.values() || []) {
    const e = rec.entity;
    if (!e || !e.enabled) continue;
    for (const r of e.findComponents('render')) {
      for (const mi of r.meshInstances) {
        const b = mi.aabb, c = b.center, h = b.halfExtents;
        if (Math.abs(x - c.x) > h.x || Math.abs(z - c.z) > h.z) continue;
        const half = Math.max(h.x, h.z);
        if (half <= maxHalf) cands.push({ mi, half });
      }
    }
  }
  cands.sort((a, b) => a.half - b.half);
  const inv = new pc.Mat4(), p0 = new pc.Vec3(), p1 = new pc.Vec3(), hit = new pc.Vec3();
  for (const { mi, half } of cands) {
    const g = geometry(mi.mesh);
    if (!g) continue;
    const w = mi.node.getWorldTransform();
    inv.copy(w).invert();
    inv.transformPoint(new pc.Vec3(x, top, z), p0);
    inv.transformPoint(new pc.Vec3(x, bottom, z), p1);
    const o = [p0.x, p0.y, p0.z], d = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
    const t = hitT(g, o, d);
    if (t == null) continue;
    w.transformPoint(new pc.Vec3(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t), hit);
    return { y: hit.y, half };
  }
  return null;
}
