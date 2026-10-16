// scenery.js — Meigs Field and the lakefront as meshes, built from the
// world description (world/meigs.js). Pure geometry in render space
// (x east, y up, z south), metres relative to the runway-centre datum.

import { triangulate } from '../world/geo.js';
import { fromNE, MeshBuilder, rng } from './geometry.js';

export const PALETTE = {
  water: '#2f5d7c',
  grass: '#5f7f3e',
  park: '#6b8a45',
  land: '#8a8a7e',
  asphalt: '#3a3b3d',
  taxiway: '#46474a',
  marking: '#f2f2ee',
  yellow: '#e2b83a',
  seawall: '#9b968a',
  pier: '#9d9481',
  glass: '#4d6273',
};

const FT = 0.3048;

/** Flat polygon at height y from [[n, e], ...]. */
function flatPolygon(mb, ne, y) {
  const pts2 = ne.map(([n, e]) => [e, -n]);               // (x, z)
  const tris = triangulate(pts2);
  for (const [a, b, c] of tris) {
    const A = [pts2[a][0], y, pts2[a][1]], Bp = [pts2[b][0], y, pts2[b][1]], C = [pts2[c][0], y, pts2[c][1]];
    // keep normals up
    const cross = (Bp[0] - A[0]) * (C[2] - A[2]) - (Bp[2] - A[2]) * (C[0] - A[0]);
    if (cross < 0) mb.tri(A, Bp, C); else mb.tri(A, C, Bp);
  }
  return mb;
}

/** Vertical wall along a polyline from y0 up to y1 (both faces). */
function wall(mb, ne, y0, y1, closed = true) {
  const n = ne.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [an, ae] = ne[i];
    const [bn, be] = ne[(i + 1) % n];
    const a0 = fromNE(an, ae, y0), b0 = fromNE(bn, be, y0), b1 = fromNE(bn, be, y1), a1 = fromNE(an, ae, y1);
    mb.quad(a0, b0, b1, a1);
    mb.quad(b0, a0, a1, b1);
  }
  return mb;
}

/** A quad on the runway, given in runway-local (along, across) metres. */
function rwQuad(mb, rw, a0, a1, c0, c1, y) {
  const P = (al, ac) => {
    const n = rw.centre[0] + al * rw.dir[0] - ac * rw.dir[1];
    const e = rw.centre[1] + al * rw.dir[1] + ac * rw.dir[0];
    return fromNE(n, e, y);
  };
  mb.quad(P(a0, c0), P(a0, c1), P(a1, c1), P(a1, c0));
}

// 7-segment-ish runway numerals: segments as [x0, y0, x1, y1] in a 4 × 7 cell
const SEG = {
  a: [0, 7, 4, 7], b: [4, 7, 4, 3.5], c: [4, 3.5, 4, 0], d: [0, 0, 4, 0], e: [0, 0, 0, 3.5], f: [0, 3.5, 0, 7], g: [0, 3.5, 4, 3.5],
};
const DIGITS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};

/** Paint a runway designator; `at` = along-runway position of the numbers' base, facing `facing` (+1 = 36). */
function numerals(mb, rw, text, at, facing, y) {
  const h = 60 * FT, w = 20 * FT, stroke = 5 * FT, gap = 10 * FT;
  const total = text.length * w + (text.length - 1) * gap;
  [...text].forEach((ch, i) => {
    const x0 = -total / 2 + i * (w + gap);
    for (const s of DIGITS[ch]) {
      const [sx0, sy0, sx1, sy1] = SEG[s];
      // cell → runway-local; across = x (right of the landing direction), along = y
      const ac0 = x0 + (sx0 / 4) * w, ac1 = x0 + (sx1 / 4) * w;
      const al0 = (sy0 / 7) * h, al1 = (sy1 / 7) * h;
      const vertical = ac0 === ac1;
      const A0 = vertical ? ac0 - stroke / 2 : Math.min(ac0, ac1) - stroke / 2;
      const A1 = vertical ? ac0 + stroke / 2 : Math.max(ac0, ac1) + stroke / 2;
      const L0 = vertical ? Math.min(al0, al1) : al0 - stroke / 2;
      const L1 = vertical ? Math.max(al0, al1) : al0 + stroke / 2;
      rwQuad(mb, rw, at + facing * L0, at + facing * L1, facing * A0, facing * A1, y);
    }
  });
}

function runway(world) {
  const rw = world.runway;
  const asphalt = new MeshBuilder();
  const paint = new MeshBuilder();
  const yel = new MeshBuilder();
  const L = rw.length, W = rw.width;
  rwQuad(asphalt, rw, -L / 2 - 30, L / 2 + 30, -W / 2, W / 2, 0.03);
  // threshold bars: 12 stripes for a 150 ft runway, 150 ft long
  const stripeW = 5.75 * FT, n = 6, len = 150 * FT;
  for (const end of [-1, 1]) {
    const a0 = end * (L / 2 - 6), a1 = end * (L / 2 - 6 - len);
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) {
        const c0 = side * (3 + i * (stripeW * 2)), c1 = c0 + side * stripeW;
        rwQuad(paint, rw, Math.min(a0, a1), Math.max(a0, a1), Math.min(c0, c1), Math.max(c0, c1), 0.05);
      }
    }
  }
  // designators: 36 at the south end (read landing north), 18 at the north end
  numerals(paint, rw, '36', -L / 2 + 6 + len + 20, 1, 0.05);
  numerals(paint, rw, '18', L / 2 - 6 - len - 20, -1, 0.05);
  // centreline: 120 ft stripes, 80 ft gaps
  const start = -L / 2 + 6 + len + 20 + 60 * FT + 20;
  for (let a = start; a + 120 * FT < L / 2 - 6 - len - 20 - 60 * FT - 20; a += 200 * FT) {
    rwQuad(paint, rw, a, a + 120 * FT, -0.45, 0.45, 0.05);
  }
  // side stripes
  for (const side of [-1, 1]) rwQuad(paint, rw, -L / 2, L / 2, side * (W / 2 - 1.5), side * (W / 2 - 0.6), 0.05);
  // parallel taxiway on the west side and the apron by the terminal
  rwQuad(asphalt, rw, -L / 2 + 40, L / 2 - 40, -W / 2 - 75, -W / 2 - 60, 0.03);
  rwQuad(yel, rw, -L / 2 + 40, L / 2 - 40, -W / 2 - 67.7, -W / 2 - 67.3, 0.05);
  for (const at of [-L / 2 + 50, -60, L / 2 - 50]) rwQuad(asphalt, rw, at - 9, at + 9, -W / 2 - 75, -W / 2, 0.025);
  rwQuad(asphalt, rw, 20, 230, -W / 2 - 160, -W / 2 - 75, 0.03);
  return { asphalt, paint, yel };
}

function building(mb, l) {
  const [n, e] = l.ne;
  const hw = l.w / 2, hd = l.d / 2;
  const box = (x0, x1, z0, z1, y0, y1) => mb.box([e + x0, y0, -n + z0], [e + x1, y1, -n + z1]);
  switch (l.kind) {
    case 'bundled': // Sears: nine tubes ending at different heights
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const hts = [[0.6, 1, 0.6], [0.8, 1, 1], [0.5, 0.8, 0.5]];
        const s = l.w / 3;
        box(-hw + i * s, -hw + (i + 1) * s, -hd + j * s, -hd + (j + 1) * s, 0, l.h * hts[i][j]);
      }
      // the antennas
      box(-hw + l.w / 3 + 3, -hw + l.w / 3 + 5, -2, 0, l.h, l.h + 85);
      box(-hw + (2 * l.w) / 3 - 5, -hw + (2 * l.w) / 3 - 3, -2, 0, l.h, l.h + 75);
      break;
    case 'taper': { // Hancock: tapering box + masts
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        const f0 = i / steps, f1 = (i + 1) / steps;
        const sw = 1 - 0.38 * f0, sd = 1 - 0.38 * f0;
        box(-hw * sw, hw * sw, -hd * sd, hd * sd, l.h * f0, l.h * f1);
      }
      box(-6, -4, -1, 1, l.h, l.h + (l.mast || 0));
      box(4, 6, -1, 1, l.h, l.h + (l.mast || 0) * 0.9);
      break;
    }
    case 'spire':
      box(-hw, hw, -hd, hd, 0, l.h * 0.78);
      box(-hw * 0.7, hw * 0.7, -hd * 0.7, hd * 0.7, l.h * 0.78, l.h * 0.88);
      box(-hw * 0.35, hw * 0.35, -hd * 0.35, hd * 0.35, l.h * 0.88, l.h * 0.95);
      box(-1, 1, -1, 1, l.h * 0.95, l.h + 20);
      break;
    case 'crown':
      box(-hw, hw, -hd, hd, 0, l.h * 0.88);
      box(-hw * 0.75, hw * 0.75, -hd * 0.75, hd * 0.75, l.h * 0.88, l.h);
      break;
    case 'trefoil':
      for (let k = 0; k < 3; k++) {
        const a = (k * 2 * Math.PI) / 3;
        const cx = Math.cos(a) * hw * 0.5, cz = Math.sin(a) * hw * 0.5;
        box(cx - hw * 0.45, cx + hw * 0.45, cz - hd * 0.45, cz + hd * 0.45, 0, l.h);
      }
      break;
    case 'dome': {
      box(-hw, hw, -hd, hd, 0, l.h * 0.5);
      const rings = [];
      for (let i = 0; i <= 5; i++) {
        const t = (i / 5) * (Math.PI / 2);
        const r = Math.cos(t) * hw * 0.55 + 0.01;
        const y = l.h * 0.5 + Math.sin(t) * hw * 0.45;
        const pts = [];
        for (let k = 0; k < 12; k++) {
          const u = (k / 12) * Math.PI * 2;
          pts.push([e + Math.cos(u) * r, y, -n + Math.sin(u) * r]);
        }
        rings.push(pts);
      }
      mb.loft(rings, { closeEnds: false, flip: true });
      break;
    }
    case 'stadium': // two colonnaded stands and an open field
      box(-hw, hw, -hd, -hd + 45, 0, l.h);
      box(-hw, hw, hd - 45, hd, 0, l.h);
      box(-hw, -hw + 25, -hd + 45, hd - 45, 0, l.h * 0.6);
      box(hw - 25, hw, -hd + 45, hd - 45, 0, l.h * 0.6);
      break;
    case 'tower':
      box(-hw * 0.5, hw * 0.5, -hd * 0.5, hd * 0.5, 0, l.h - 4);
      box(-hw, hw, -hd, hd, l.h - 4, l.h);
      break;
    default:
      box(-hw, hw, -hd, hd, 0, l.h);
  }
}

/** The Loop's mid-rise fabric: seeded blocks on a street grid, Grant Park left open. */
function downtown(world) {
  const d = world.downtown;
  const r = rng(d.seed);
  const light = new MeshBuilder(), dark = new MeshBuilder(), glass = new MeshBuilder();
  const block = 110, street = 22;
  const [s0, w0] = d.sw, [n1, e1] = d.ne;
  const park = world.frame.toNE(41.8680, -87.6240).concat(world.frame.toNE(41.8860, -87.6150));
  for (let n = s0; n < n1; n += block + street) {
    for (let e = w0; e < e1; e += block + street) {
      if (n > park[0] && n < park[2] && e > park[1] && e < park[3]) continue;
      // the river and the lake keep the grid honest
      if (e > world.shoreEastAt(n) - 150) continue;
      const lots = 1 + Math.floor(r() * 3);
      for (let k = 0; k < lots; k++) {
        const w = block / lots - 6;
        const x0 = e + k * (block / lots) + 3;
        const h = d.minH + (d.maxH - d.minH) * Math.pow(r(), 2.2) * (1 - 0.5 * Math.abs((n - (s0 + n1) / 2) / (n1 - s0)));
        const depth = block * (0.6 + 0.4 * r());
        const mb = [light, dark, glass][Math.floor(r() * 3)];
        mb.box([x0, 0, -(n + depth)], [x0 + w, h, -n]);
      }
    }
  }
  return { light, dark, glass };
}

/** Every static scenery part: { name, color, mesh }. */
export function buildScenery(world) {
  const parts = [];
  const water = new MeshBuilder();
  const S = 40000;
  water.quad([-S, world.water, S], [S, world.water, S], [S, world.water, -S], [-S, world.water, -S]);
  parts.push({ name: 'lake', color: PALETTE.water, mesh: water });

  const land = flatPolygon(new MeshBuilder(), world.mainland, 0.5);
  parts.push({ name: 'mainland', color: PALETTE.land, mesh: land });
  parts.push({ name: 'island', color: PALETTE.grass, mesh: flatPolygon(new MeshBuilder(), world.island, 0.0) });
  const walls = new MeshBuilder();
  wall(walls, world.island, world.water - 0.5, 0.0);
  wall(walls, world.shore, world.water - 0.5, 0.5, false);
  parts.push({ name: 'seawall', color: PALETTE.seawall, mesh: walls });
  const pier = flatPolygon(new MeshBuilder(), world.pier, 1.5);
  wall(pier, world.pier, world.water - 0.5, 1.5);
  parts.push({ name: 'navyPier', color: PALETTE.pier, mesh: pier });

  const rw = runway(world);
  parts.push({ name: 'runway', color: PALETTE.asphalt, mesh: rw.asphalt });
  parts.push({ name: 'markings', color: PALETTE.marking, mesh: rw.paint });
  parts.push({ name: 'taxiLine', color: PALETTE.yellow, mesh: rw.yel });

  const byColor = new Map();
  for (const l of world.landmarks) {
    if (!byColor.has(l.color)) byColor.set(l.color, new MeshBuilder());
    building(byColor.get(l.color), l);
  }
  for (const [color, mesh] of byColor) parts.push({ name: `landmarks${color}`, color, mesh });
  const dt = downtown(world);
  parts.push({ name: 'loopLight', color: '#c9c3b6', mesh: dt.light });
  parts.push({ name: 'loopDark', color: '#55524c', mesh: dt.dark });
  parts.push({ name: 'loopGlass', color: PALETTE.glass, mesh: dt.glass });
  return parts;
}
