// tower.js — Meigs' control tower as meshes: a two-storey base with its window bands and roof plant,
// a ribbed concrete shaft with the stair's slit window, and the cab: an octagon of outward-leaning
// tinted glass between a projecting floor and an overhanging roof, mullions at the corners, a catwalk
// with its railing, the antenna mast and the beacon's platform on top. Render space (x east, y up,
// z south), metres; the beacon's and the obstruction light's positions come back for the lights.

import { fromNE, MeshBuilder } from './geometry.js';

/** A frustum of n sides, axis vertical: radius r0 at y0, r1 at y1, faces outward (caps optional). */
function frustum(mb, c, r0, r1, y0, y1, n = 8, caps = true, rot = Math.PI / 8) {
  const ring = (r, y) => Array.from({ length: n }, (_, k) => {
    const a = rot + (2 * Math.PI * k) / n;
    return [c[0] + r * Math.cos(a), y, c[2] + r * Math.sin(a)];
  });
  const A = ring(r0, y0), B = ring(r1, y1);
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    mb.quadOut(A[k], A[k1], B[k1], B[k], [c[0], (y0 + y1) / 2, c[2]]);
  }
  if (caps) {
    mb.fan(B, false);
    mb.fan(A, true);
  }
  return { A, B };
}

const box = (mb, x0, x1, y0, y1, z0, z1) => mb.box([x0, y0, z0], [x1, y1, z1]);

/**
 * @param {number[]} ne  the tower's foot (n, e)
 * @returns {{ parts: { name: string, color: string, mesh: MeshBuilder, finish?: string }[], beacon: number[], obstruction: number[], cabEye: number[] }}
 */
export function buildTower(ne) {
  const [x, , z] = fromNE(ne[0], ne[1], 0);
  const concrete = new MeshBuilder(), trim = new MeshBuilder(), glass = new MeshBuilder(), metal = new MeshBuilder(), roof = new MeshBuilder();
  const cabGlass = new MeshBuilder();   // see-through: the tower view looks out of it
  const c = [x, 0, z];

  // ── the base: two storeys east of the shaft, window bands, a parapet, plant on the roof ──
  const bx0 = x + 2.2, bx1 = x + 16, bz0 = z - 6, bz1 = z + 6;
  box(concrete, bx0, bx1, 0, 7.2, bz0, bz1);
  for (const [y0, y1] of [[1.0, 2.6], [4.4, 6.0]]) {
    box(glass, bx0 - 0.05, bx1 + 0.05, y0, y1, bz0 - 0.05, bz1 + 0.05);       // ribbon windows all round
    for (let k = 1; k < 9; k++) box(trim, bx0 + k * ((bx1 - bx0) / 9) - 0.08, bx0 + k * ((bx1 - bx0) / 9) + 0.08, y0, y1, bz0 - 0.12, bz1 + 0.12);
  }
  box(trim, bx0 - 0.15, bx1 + 0.15, 7.2, 7.75, bz0 - 0.15, bz1 + 0.15);         // parapet coping
  box(roof, bx0 + 0.3, bx1 - 0.3, 7.2, 7.3, bz0 + 0.3, bz1 - 0.3);
  box(metal, bx0 + 3, bx0 + 6, 7.3, 8.6, bz0 + 2, bz0 + 4.5);                    // air handlers
  box(metal, bx0 + 8, bx0 + 9.6, 7.3, 8.2, bz1 - 3, bz1 - 1.2);
  // the entrance: a canopy over the door on the apron side
  box(trim, bx1 - 0.05, bx1 + 2.4, 2.9, 3.15, z - 2.2, z + 2.2);
  box(glass, bx1 - 0.02, bx1 + 0.06, 0, 2.6, z - 1.4, z + 1.4);

  // ── the shaft: an octagon with pilasters on its corners and the stair's slit window ──
  frustum(concrete, c, 2.7, 2.5, 0, 17.0, 8, false);
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (2 * Math.PI * k) / 8;
    const px = x + 2.65 * Math.cos(a), pz = z + 2.65 * Math.sin(a);
    box(trim, px - 0.18, px + 0.18, 0, 17.0, pz - 0.18, pz + 0.18);
  }
  box(glass, x - 2.75, x - 2.45, 1.5, 15.5, z - 0.35, z + 0.35);                 // stair window, west face

  // ── the cab ──
  frustum(trim, c, 4.4, 4.9, 16.6, 17.3, 8, true);                             // projecting floor slab
  const { A: g0, B: g1 } = frustum(cabGlass, c, 4.3, 4.85, 17.3, 20.4, 8, false); // glass leaning outward
  for (let k = 0; k < 8; k++) {                                                // corner mullions
    const a = g0[k], b = g1[k];
    const mb = metal;
    const d = 0.09;
    mb.quad([a[0] - d, a[1], a[2]], [a[0] + d, a[1], a[2]], [b[0] + d, b[1], b[2]], [b[0] - d, b[1], b[2]]);
    mb.quad([a[0], a[1], a[2] - d], [a[0], a[1], a[2] + d], [b[0], b[1], b[2] + d], [b[0], b[1], b[2] - d]);
  }
  frustum(trim, c, 4.4, 4.4, 17.3, 17.95, 8, false);                           // the console sill inside the glass
  frustum(roof, c, 5.6, 5.3, 20.4, 21.0, 8, true);                            // overhanging roof
  frustum(trim, c, 3.2, 3.0, 21.0, 21.6, 8, true);                            // the roof's plant room
  // the catwalk round the cab at floor level, and its railing
  frustum(metal, c, 5.6, 5.6, 17.0, 17.12, 8, true);
  for (let k = 0; k < 24; k++) {
    const a = (2 * Math.PI * k) / 24;
    const px = x + 5.5 * Math.cos(a), pz = z + 5.5 * Math.sin(a);
    box(metal, px - 0.03, px + 0.03, 17.12, 18.15, pz - 0.03, pz + 0.03);
  }
  frustum(metal, c, 5.52, 5.52, 18.08, 18.15, 24, false, 0);
  // antenna mast with a yard and a dish, the beacon's platform
  box(metal, x - 0.08, x + 0.08, 21.6, 28.5, z - 0.08, z + 0.08);
  box(metal, x - 1.2, x + 1.2, 26.0, 26.08, z - 0.04, z + 0.04);
  box(metal, x + 1.6, x + 2.0, 21.6, 23.2, z + 1.6, z + 2.0);
  frustum(metal, [x + 1.8, 0, z + 1.8], 0.15, 0.55, 23.2, 23.5, 10, true, 0);
  box(trim, x - 2.4, x - 1.4, 21.0, 21.9, z - 0.5, z + 0.5);                   // the beacon's plinth

  return {
    parts: [
      { name: 'towerConcrete', color: '#d6d1c6', mesh: concrete },
      { name: 'towerTrim', color: '#9a978f', mesh: trim },
      { name: 'towerWindows', color: '#2b3a44', mesh: glass, finish: 'mirror' },
      { name: 'towerCabGlass', color: '#3a5466', mesh: cabGlass, finish: 'glass' },
      { name: 'towerMetal', color: '#55585c', mesh: metal, finish: 'metal' },
      { name: 'towerRoof', color: '#3c3e42', mesh: roof },
    ],
    beacon: [x - 1.9, 22.3, z],
    obstruction: [x, 28.7, z],
    cabEye: [x, 19.2, z],
  };
}
