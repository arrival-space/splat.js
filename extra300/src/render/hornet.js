// hornet.js — a parked F/A-18 Hornet, low-poly, for the carrier's deck: the
// fuselage with its leading-edge extensions, the wings folded up at the
// hinge, the canted twin fins, stabilators, the canopy, the gear and the two
// nozzles. Not flown, only parked: a few hundred triangles each.
//
// Built in its own frame (x forward from the middle, y to the right, z up from
// the deck, metres) and handed to `place(p)`, which turns a point into the
// scene's frame; normals are recomputed there, so any rigid placement works.

import { faceNormal, MeshBuilder } from './geometry.js';

/** A flat slab through four coplanar corners (counter-clockwise from its top), `th` thick. */
export function slab(mb, pts, th) {
  const n = faceNormal(pts[0], pts[1], pts[2]);
  const off = (p, k) => [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k];
  const top = pts.map((p) => off(p, th / 2)), bot = pts.map((p) => off(p, -th / 2));
  const c = pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
  mb.quadOut(top[0], top[1], top[2], top[3], c);
  mb.quadOut(bot[0], bot[1], bot[2], bot[3], c);
  for (let k = 0; k < 4; k++) mb.quadOut(top[k], top[(k + 1) % 4], bot[(k + 1) % 4], bot[k], c);
  return mb;
}

/** An elliptical ring at x: half-width a, half-height b, centred at height zc. */
const ring = (x, a, b, zc, n = 10) => Array.from({ length: n }, (_, k) => {
  const t = (2 * Math.PI * k) / n;
  return [x, a * Math.cos(t), zc + b * Math.sin(t)];
});

/**
 * @param {MeshBuilder} paint  the grey airframe
 * @param {MeshBuilder} dark   canopy, tyres, nozzles, intakes
 * @param {(p: number[]) => number[]} place  its frame → the scene's
 */
export function buildHornet(paint, dark, place) {
  const body = new MeshBuilder(), blk = new MeshBuilder();
  const Z = 2.0;    // the fuselage's axis above the deck
  // fuselage: nose to tail, the rings flattening and widening aft over the engines
  body.loft([
    ring(8.6, 0.06, 0.06, Z + 0.1),
    ring(7.6, 0.38, 0.4, Z + 0.1),
    ring(6.0, 0.62, 0.68, Z + 0.15),
    ring(4.0, 0.85, 0.85, Z + 0.2),
    ring(1.5, 1.25, 0.82, Z + 0.15),
    ring(-2.0, 1.35, 0.78, Z + 0.1),
    ring(-5.5, 1.2, 0.7, Z + 0.05),
    ring(-7.6, 0.95, 0.55, Z),
  ]);
  // the leading-edge extensions along the forward fuselage, and the wings out to the fold
  for (const s of [-1, 1]) {
    slab(body, s > 0
      ? [[5.6, 0.7, Z + 0.25], [1.5, 1.3, Z + 0.2], [1.5, 2.2, Z + 0.15], [3.0, 1.6, Z + 0.2]]
      : [[5.6, -0.7, Z + 0.25], [3.0, -1.6, Z + 0.2], [1.5, -2.2, Z + 0.15], [1.5, -1.3, Z + 0.2]], 0.12);
    const yr = s * 1.2, yf = s * 3.4;
    slab(body, s > 0
      ? [[1.8, yr, Z + 0.1], [-3.4, yr, Z + 0.1], [-3.0, yf, Z + 0.12], [0.6, yf, Z + 0.12]]
      : [[1.8, yr, Z + 0.1], [0.6, yf, Z + 0.12], [-3.0, yf, Z + 0.12], [-3.4, yr, Z + 0.1]], 0.2);
    // the outer panels folded up at the hinge, a little past vertical
    const zt = Z + 0.12 + 2.4;
    const yo = yf - s * 0.35;
    slab(body, s > 0
      ? [[0.6, yf, Z + 0.12], [-3.0, yf, Z + 0.12], [-2.6, yo, zt], [-0.6, yo, zt]]
      : [[0.6, yf, Z + 0.12], [-0.6, yo, zt], [-2.6, yo, zt], [-3.0, yf, Z + 0.12]], 0.14);
    // the fins: canted outward, swept
    const yb = s * 0.95, ytp = s * 1.9;
    slab(body, s > 0
      ? [[-3.6, yb, Z + 0.6], [-7.0, yb, Z + 0.5], [-7.6, ytp, Z + 3.4], [-5.8, ytp, Z + 3.4]]
      : [[-3.6, yb, Z + 0.6], [-5.8, ytp, Z + 3.4], [-7.6, ytp, Z + 3.4], [-7.0, yb, Z + 0.5]], 0.12);
    // stabilators
    slab(body, s > 0
      ? [[-5.6, s * 1.1, Z], [-8.2, s * 1.1, Z], [-8.4, s * 3.3, Z - 0.1], [-7.4, s * 3.3, Z - 0.1]]
      : [[-5.6, s * 1.1, Z], [-7.4, s * 3.3, Z - 0.1], [-8.4, s * 3.3, Z - 0.1], [-8.2, s * 1.1, Z]], 0.1);
    // intakes under the leading-edge extensions, nozzles at the tail
    blk.box([2.2, s > 0 ? 0.75 : -1.35, Z - 0.75], [2.4, s > 0 ? 1.35 : -0.75, Z - 0.1]);
    blk.loft([ring(-7.55, 0.42, 0.42, Z, 8).map((p) => [p[0], p[1] + s * 0.48, p[2]]), ring(-8.4, 0.38, 0.38, Z, 8).map((p) => [p[0], p[1] + s * 0.48, p[2]])]);
    // main gear: a leg and a wheel each side
    body.box([-1.0, s * 1.6 - 0.08, 0.4], [-0.84, s * 1.6 + 0.08, Z - 0.5]);
    blk.box([-1.35, s * 1.6 - 0.16, 0], [-0.5, s * 1.6 + 0.16, 0.82]);
  }
  // the canopy: a bubble over the cockpit
  blk.loft([
    ring(6.4, 0.08, 0.05, Z + 0.75, 8),
    ring(5.4, 0.45, 0.42, Z + 0.72, 8),
    ring(3.6, 0.52, 0.5, Z + 0.72, 8),
    ring(2.2, 0.3, 0.3, Z + 0.68, 8),
  ]);
  // nose gear
  body.box([5.2, -0.06, 0.3], [5.36, 0.06, Z - 0.5]);
  blk.box([4.95, -0.14, 0], [5.6, 0.14, 0.6]);
  // this frame is left-handed (x forward, y right, z up): a placement into a right-handed one mirrors,
  // and the triangles' winding turns with it
  const o = place([0, 0, 0]), ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => place(e).map((v, k) => v - o[k]));
  const det = ax[0][0] * (ax[1][1] * ax[2][2] - ax[1][2] * ax[2][1]) - ax[0][1] * (ax[1][0] * ax[2][2] - ax[1][2] * ax[2][0])
    + ax[0][2] * (ax[1][0] * ax[2][1] - ax[1][1] * ax[2][0]);
  const put = (src, dst) => {
    for (let i = 0; i < src.indices.length; i += 3) {
      const v = (k) => {
        const q = src.indices[i + k] * 3;
        return place([src.positions[q], src.positions[q + 1], src.positions[q + 2]]);
      };
      if (det < 0) dst.tri(v(0), v(2), v(1)); else dst.tri(v(0), v(1), v(2));
    }
  };
  put(body, paint);
  put(blk, dark);
}
