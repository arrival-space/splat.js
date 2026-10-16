// geometry.js — engine-free mesh building: plain arrays of positions,
// normals and indices that the plugin hands to pc.Mesh. Keeping it free of
// PlayCanvas lets the tests check sizes and shapes in Node.
//
// Render space is PlayCanvas's: x right/east, y up, z toward the viewer
// (south). `fromBody` maps aircraft body axes (x fwd, y right, z down) and
// `fromNED` maps the earth frame into it — the same matrix for both.

export const fromBody = (p) => [p[1], -p[2], -p[0]];
export const fromNE = (n, e, up = 0) => [e, up, -n];

export class MeshBuilder {
  /** @param {{ uv?: boolean, color?: boolean }} [opts] optional texture coordinates and vertex colours */
  constructor(opts = {}) {
    this.positions = [];
    this.normals = [];
    this.indices = [];
    this.uvs = opts.uv ? [] : null;
    this.colors = opts.color ? [] : null;
  }

  get vertexCount() { return this.positions.length / 3; }

  vertex(p, n, uv = null, color = null) {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    if (this.uvs) this.uvs.push(uv ? uv[0] : 0, uv ? uv[1] : 0);
    if (this.colors) this.colors.push(color ? color[0] : 255, color ? color[1] : 255, color ? color[2] : 255, 255);
    return this.vertexCount - 1;
  }

  /** Flat-shaded triangle, counter-clockwise seen from outside. */
  tri(a, b, c) {
    const n = faceNormal(a, b, c);
    const i = this.vertex(a, n);
    this.vertex(b, n);
    this.vertex(c, n);
    this.indices.push(i, i + 1, i + 2);
    return this;
  }

  /** Flat quad a-b-c-d, counter-clockwise seen from outside. */
  quad(a, b, c, d) {
    const n = faceNormal(a, b, c);
    const i = this.vertex(a, n);
    this.vertex(b, n);
    this.vertex(c, n);
    this.vertex(d, n);
    this.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }

  /**
   * Smooth-shaded surface through rings of points (a loft). Each ring has the
   * same count; rings are joined in order, and each ring is closed on itself.
   * `outward` flips the winding if the rings run clockwise.
   */
  loft(rings, { closeEnds = true, flip = false } = {}) {
    const m = rings[0].length;
    const base = this.vertexCount;
    // vertex normals by averaging the adjacent face normals
    const acc = rings.map((r) => r.map(() => [0, 0, 0]));
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < m; j++) {
        const j1 = (j + 1) % m;
        const n = faceNormal(rings[i][j], rings[i + 1][j], rings[i + 1][j1]);
        for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j1], [i, j1]]) {
          acc[a][b][0] += n[0]; acc[a][b][1] += n[1]; acc[a][b][2] += n[2];
        }
      }
    }
    for (let i = 0; i < rings.length; i++) {
      for (let j = 0; j < m; j++) {
        const n = normalize(acc[i][j]);
        this.vertex(rings[i][j], flip ? [-n[0], -n[1], -n[2]] : n);
      }
    }
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < m; j++) {
        const j1 = (j + 1) % m;
        const a = base + i * m + j, b = base + (i + 1) * m + j, c = base + (i + 1) * m + j1, d = base + i * m + j1;
        if (flip) this.indices.push(a, c, b, a, d, c);
        else this.indices.push(a, b, c, a, c, d);
      }
    }
    if (closeEnds) {
      this.fan(rings[0], !flip);
      this.fan(rings[rings.length - 1], flip);
    }
    return this;
  }

  /** Flat cap over a ring (fan from its centroid). */
  fan(ring, reverse = false) {
    const c = [0, 0, 0];
    for (const p of ring) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= ring.length; c[1] /= ring.length; c[2] /= ring.length;
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j], b = ring[(j + 1) % ring.length];
      if (reverse) this.tri(c, b, a); else this.tri(c, a, b);
    }
    return this;
  }

  box(min, max) {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +y
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -y
    return this;
  }

  /** Vertical prism over a footprint polygon [[x, z], ...] (counter-clockwise from above). */
  prism(footprint, y0, y1) {
    const n = footprint.length;
    for (let i = 0; i < n; i++) {
      const [ax, az] = footprint[i];
      const [bx, bz] = footprint[(i + 1) % n];
      this.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]);
    }
    this.fan(footprint.map(([x, z]) => [x, y1, z]), true);
    return this;
  }

  /** Append another builder, optionally transforming its points with f(p) and normals with g(n). */
  append(other, f = null, g = null) {
    const base = this.vertexCount;
    for (let i = 0; i < other.positions.length; i += 3) {
      const p = [other.positions[i], other.positions[i + 1], other.positions[i + 2]];
      const n = [other.normals[i], other.normals[i + 1], other.normals[i + 2]];
      this.vertex(f ? f(p) : p, g ? g(n) : n);
    }
    for (const i of other.indices) this.indices.push(base + i);
    return this;
  }

  bounds() {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], this.positions[i + k]);
        max[k] = Math.max(max[k], this.positions[i + k]);
      }
    }
    return { min, max };
  }
}

export function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return normalize([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
}

export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

/** Superellipse ring in a plane: centre c, half sizes (a along u, b along v), exponent e. */
export function ring(c, u, v, a, b, segments = 16, e = 2.5) {
  const pts = [];
  for (let k = 0; k < segments; k++) {
    const t = (k / segments) * Math.PI * 2;
    const ct = Math.cos(t), st = Math.sin(t);
    const x = a * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / e);
    const y = b * Math.sign(st) * Math.pow(Math.abs(st), 2 / e);
    pts.push([c[0] + u[0] * x + v[0] * y, c[1] + u[1] * x + v[1] * y, c[2] + u[2] * x + v[2] * y]);
  }
  return pts;
}

/** Mulberry32 — the same scenery on every load. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
