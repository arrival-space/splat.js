// terrainModel.js — a destination's ground when Google's 3D tiles aren't there: the elevation grids
// as a coloured mesh (valley meadows, forest, alpine pasture, rock, snow, by height and slope), and
// the airport's pavement from OpenStreetMap on it, with the runway's edge and centre lines. Render
// space (x east, y up, z south), metres above the datum; vertex colours linear 0–255.

import earcut from 'earcut';
import { fromNE, MeshBuilder, normalize } from './geometry.js';

const BANDS = [            // [height above sea level (m), colour]
  [0, [104, 128, 72]],
  [900, [86, 112, 62]],
  [1300, [52, 78, 46]],     // spruce forest
  [1900, [62, 84, 50]],
  [2050, [118, 124, 92]],   // alpine pasture
  [2300, [128, 122, 112]],  // rock
  [2700, [150, 146, 140]],
  [2900, [236, 238, 242]],  // snow
];
function colourAt(msl, slope) {
  let c = BANDS[BANDS.length - 1][1];
  for (let i = 0; i < BANDS.length - 1; i++) {
    const [h0, c0] = BANDS[i], [h1, c1] = BANDS[i + 1];
    if (msl < h1) { const t = Math.max(0, (msl - h0) / (h1 - h0)); c = c0.map((v, k) => v + (c1[k] - v) * t); break; }
  }
  // steep ground: bare rock
  const rock = Math.min(1, Math.max(0, (slope - 0.7) / 0.5)) * (msl > 900 ? 1 : 0.4);
  // (the engine takes vertex colours as linear)
  return c.map((v, k) => Math.round(255 * Math.pow((v + ([126, 120, 110][k] - v) * rock) / 255, 2.2)));
}

/**
 * One grid as a mesh: every `skip`th sample, heights from h(n, e) (above the datum); cells for which
 * `keep(n, e)` is false are left out (the far grid where the near one lies).
 */
const WATER = [47, 93, 124].map((v) => Math.round(255 * Math.pow(v / 255, 2.2)));

function gridMesh(mb, g, skip, h, elevation, keep = () => true, drop = 0, wet = () => false) {
  const n = Math.floor((g.n - 1) / skip) + 1, s = g.step * skip;
  const N = (j) => -g.half + j * s, E = (i) => -g.half + i * s;
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = h(N(j), E(i));
  const at = (i, j) => H[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
  const base = mb.vertexCount;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const dhe = (at(i + 1, j) - at(i - 1, j)) / (2 * s), dhn = (at(i, j + 1) - at(i, j - 1)) / (2 * s);
    const y = H[j * n + i] - drop;
    // render: x = east, z = −north; the up normal of y = h(e, n)
    const nr = normalize([-dhe, 1, dhn]);
    mb.vertex(fromNE(N(j), E(i), y), nr, null, wet(N(j), E(i)) ? WATER : colourAt(y + drop + elevation, Math.hypot(dhe, dhn)));
  }
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    if (!keep(N(j) + s / 2, E(i) + s / 2)) continue;
    const a = base + j * n + i, b = a + 1, c = a + n, d = c + 1;
    // counter-clockwise from above (y up): north is −z
    mb.indices.push(a, b, d, a, d, c);
  }
}

/**
 * @param {object} world  buildInnsbruck()
 * @param {{ near, far }} dem  inflateLowiDem()
 * @returns {{ name: string, mesh: MeshBuilder, color?: string, vertexColor?: boolean, bias?: number }[]}
 */
export function buildTerrainModel(world, dem) {
  const el = world.elevation;
  const terrain = new MeshBuilder({ color: true });
  const nearHalf = dem.near.half - dem.near.step * 2;
  const wet = world.isWater || (() => false);
  gridMesh(terrain, dem.near, 2, (n, e) => world.heightAt(n, e), el, undefined, 0, wet);
  gridMesh(terrain, dem.far, 2, (n, e) => {
    const k = Math.floor((n + dem.far.half) / dem.far.step), i = Math.floor((e + dem.far.half) / dem.far.step);
    return dem.far.h[Math.min(dem.far.n - 1, Math.max(0, k)) * dem.far.n + Math.min(dem.far.n - 1, Math.max(0, i))] - el;
  }, el, (n, e) => Math.abs(n) > nearHalf || Math.abs(e) > nearHalf, 3, wet);

  // the pavement: strips and aprons, a few centimetres up
  const asphalt = new MeshBuilder(), paint = new MeshBuilder();
  const strip = (mb, a, b, hw, y, ext = 0) => {
    const dn = b[0] - a[0], de = b[1] - a[1], l = Math.hypot(dn, de) || 1;
    const un = dn / l, ue = de / l, pn = -ue * hw, pe = un * hw;
    const A = [a[0] - un * ext, a[1] - ue * ext], B = [b[0] + un * ext, b[1] + ue * ext];
    const q = [fromNE(A[0] + pn, A[1] + pe, y), fromNE(B[0] + pn, B[1] + pe, y), fromNE(B[0] - pn, B[1] - pe, y), fromNE(A[0] - pn, A[1] - pe, y)];
    const up = (q[1][2] - q[0][2]) * (q[2][0] - q[0][0]) - (q[1][0] - q[0][0]) * (q[2][2] - q[0][2]);
    if (up > 0) mb.quad(q[0], q[1], q[2], q[3]); else mb.quad(q[0], q[3], q[2], q[1]);
  };
  for (const [a, b, hw] of world.pavement.strips) strip(asphalt, a, b, hw, 0.04, hw * 0.5);
  for (const area of world.pavement.areas) {
    const flat = area.flatMap(([n, e]) => [e, n]);
    const tri = earcut(flat);
    for (let i = 0; i < tri.length; i += 3) {
      const [p, q, r] = [tri[i], tri[i + 1], tri[i + 2]].map((k) => fromNE(area[k][0], area[k][1], 0.03));
      const up = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]);
      if (up > 0) asphalt.tri(p, q, r); else asphalt.tri(p, r, q);
    }
  }
  // the runway's edge lines and dashed centre line (unless the runway is drawn over it, render/icaoRunway.js)
  const rw = world.runway, d = rw.dir;
  if (rw.layout) {
    return [
      { name: 'terrain', mesh: terrain, vertexColor: true },
      { name: 'pavement', mesh: asphalt, color: '#3c3d40', bias: -1 },
    ];
  }
  const P = (al, ac) => [rw.centre[0] + d[0] * al - d[1] * ac, rw.centre[1] + d[1] * al + d[0] * ac];
  for (const side of [-1, 1]) strip(paint, P(-rw.length / 2, side * (rw.width / 2 - 1)), P(rw.length / 2, side * (rw.width / 2 - 1)), 0.45, 0.07);
  for (let al = -rw.length / 2 + 60; al < rw.length / 2 - 60; al += 50) strip(paint, P(al, 0), P(al + 30, 0), 0.45, 0.07);
  for (const end of [-1, 1]) for (let k = -5; k <= 5; k++) if (k) {
    const ac = k * 3.4 - Math.sign(k) * 1.2;
    strip(paint, P(end * (rw.length / 2 - 6), ac), P(end * (rw.length / 2 - 36), ac), 0.9, 0.07);
  }
  return [
    { name: 'terrain', mesh: terrain, vertexColor: true },
    { name: 'pavement', mesh: asphalt, color: '#3c3d40', bias: -1 },
    { name: 'pavementPaint', mesh: paint, color: '#e8e6df', bias: -2 },
  ];
}

