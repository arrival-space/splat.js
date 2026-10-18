// scenery.js — Meigs Field and the lakefront as meshes, built from the
// world description (world/meigs.js). Pure geometry in render space
// (x east, y up, z south), metres relative to the runway-centre datum.

import { triangulate } from '../world/geo.js';
import { fromNE, MeshBuilder, rng } from './geometry.js';
import { buildTower } from './tower.js';

export const PALETTE = {
  water: '#2f5d7c',
  grass: '#5f7f3e',
  park: '#6b8a45',
  land: '#8a8a7e',
  asphalt: '#3a3b3d',
  taxiway: '#46474a',
  marking: '#e9e6df',
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
export function rwQuad(mb, rw, a0, a1, c0, c1, y) {
  const P = (al, ac) => {
    const n = rw.centre[0] + al * rw.dir[0] - ac * rw.dir[1];
    const e = rw.centre[1] + al * rw.dir[1] + ac * rw.dir[0];
    return fromNE(n, e, y);
  };
  mb.quad(P(a0, c0), P(a0, c1), P(a1, c1), P(a1, c0));
}

// Runway designators in the FAA's numeral shapes (AC 150/5340-1: 60 ft high, 20 ft wide, 5 ft strokes):
// each digit a few stroked paths in a 20 × 60 ft cell (x across, y along from its base), arcs as ellipses
const ell = (cx, cy, rx, ry, a0, a1, n = 20) => Array.from({ length: n + 1 }, (_, k) => {
  const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
});
export const GLYPHS = {
  1: [[[10, 2.5], [10, 57.5], [4, 51]], [[4.5, 2.5], [15.5, 2.5]]],
  3: [[[3, 55.5], [17, 57.5], [9.5, 34]], ell(10, 17.5, 7.5, 15, 75, -200)],
  6: [ell(10, 16, 7.5, 13.5, 0, 360, 28), [[2.5, 16], [2.5, 30], [10, 47], [15.5, 57.5]]],
  8: [ell(10, 45, 6.6, 12.5, 0, 360, 26), ell(10, 17, 7.5, 14.5, 0, 360, 28)],
  0: [ell(10, 30, 7.5, 27.5, 0, 360, 36)],
  2: [[...ell(10, 45, 7.5, 12.5, 160, -20), [2.5, 2.5], [17.5, 2.5]]],
  4: [[[13, 2.5], [13, 57.5], [2.5, 20], [17.5, 20]]],
  5: [[[16.5, 57.5], [4, 57.5], [3, 33], ...ell(9.5, 18, 8, 15.5, 115, -200)]],
  7: [[[2.5, 57.5], [17.5, 57.5], [7, 2.5]]],
  9: [ell(10, 44, 7.5, 13.5, 0, 360, 28), [[17.5, 44], [17.5, 30], [10, 13], [4.5, 2.5]]],
};

/** A painted stroke along a polyline of runway-local points [along, across] (m). */
export function strokeOn(mb, rw, pts, width, y) {
  const P = (al, ac) => {
    const n = rw.centre[0] + al * rw.dir[0] - ac * rw.dir[1];
    const e = rw.centre[1] + al * rw.dir[1] + ac * rw.dir[0];
    return fromNE(n, e, y);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [a0, c0] = pts[i], [a1, c1] = pts[i + 1];
    const l = Math.hypot(a1 - a0, c1 - c0) || 1;
    // extended a little at both ends so the joints of a curve close
    const ea = ((a1 - a0) / l) * width * 0.25, ec = ((c1 - c0) / l) * width * 0.25;
    const na = (-(c1 - c0) / l) * width / 2, nc = ((a1 - a0) / l) * width / 2;
    const A = P(a0 - ea + na, c0 - ec + nc), B = P(a0 - ea - na, c0 - ec - nc);
    const C = P(a1 + ea - na, c1 + ec - nc), D = P(a1 + ea + na, c1 + ec + nc);
    // facing up whichever way the path runs
    const up = (B[0] - A[0]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[0] - A[0]) < 0;
    if (up) mb.quad(A, B, C, D); else mb.quad(A, D, C, B);
  }
}

/**
 * Paint a runway designator; `at` = along-runway position of the numbers' base, facing `facing` (+1 = 36).
 * `scale` sizes the FAA's 60 ft numerals (ICAO's are 9 m: 0.49).
 */
export function numerals(mb, rw, text, at, facing, y, scale = 1) {
  const w = 20 * FT * scale, gap = 10 * FT * scale, stroke = 5 * FT * scale;
  const total = text.length * w + (text.length - 1) * gap;
  [...text].forEach((ch, i) => {
    const x0 = -total / 2 + i * (w + gap);
    for (const path of GLYPHS[ch]) {
      // cell feet → runway-local metres: across = x (right of the landing direction), along = y
      const pts = path.map(([x, yy]) => [at + facing * yy * FT * scale, facing * (x0 + x * FT * scale)]);
      strokeOn(mb, rw, pts, stroke, y);
    }
  });
}

function runway(world) {
  const rw = world.runway;
  const asphalt = new MeshBuilder();
  const paint = new MeshBuilder();
  const yel = new MeshBuilder();
  const L = rw.length, W = rw.width;
  const taxi = new MeshBuilder();
  rwQuad(asphalt, rw, -L / 2 - 30, L / 2 + 30, -W / 2, W / 2, 0.03);
  // FAA markings for a 150 ft non-precision runway (AC 150/5340-1): threshold stripes, designators,
  // aiming points, centre line, side stripes; yellow chevrons on the blast pads beyond each end
  const stripeW = 5.75 * FT, n = 6, len = 150 * FT, thr = 6;             // the threshold this far in from the pavement's end
  for (const end of [-1, 1]) {
    const a0 = end * (L / 2 - thr), a1 = end * (L / 2 - thr - len);
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) {
        // 12 stripes, 5.75 ft wide and as far apart, the middle pair either side of the centre line
        const c0 = side * (5.75 * FT / 2 + 5.75 * FT * 0.5 + i * stripeW * 2), c1 = c0 + side * stripeW;
        rwQuad(paint, rw, Math.min(a0, a1), Math.max(a0, a1), Math.min(c0, c1), Math.max(c0, c1), 0.05);
      }
    }
    // the runway's end: a 10 ft bar right across at the threshold
    rwQuad(paint, rw, Math.min(end * (L / 2 - thr), end * (L / 2 - thr + 3)), Math.max(end * (L / 2 - thr), end * (L / 2 - thr + 3)), -W / 2 + 0.6, W / 2 - 0.6, 0.05);
    // aiming points: 400 ft in (landing distance under 4,200 ft), 150 ft long, 30 ft wide, 72 ft apart inside
    const ap0 = end * (L / 2 - thr - 400 * FT), ap1 = end * (L / 2 - thr - 550 * FT);
    for (const side of [-1, 1]) {
      const c0 = side * 36 * FT, c1 = side * 66 * FT;
      rwQuad(paint, rw, Math.min(ap0, ap1), Math.max(ap0, ap1), Math.min(c0, c1), Math.max(c0, c1), 0.05);
    }
    // blast pad chevrons beyond the end, pointing at the runway
    for (let k = 0; k < 2; k++) {
      const tip = end * (L / 2 + 3 + k * 14), arm = end * (L / 2 + 3 + k * 14 + 12);
      for (const side of [-1, 1]) strokeOn(yel, rw, [[tip, 0], [arm, side * (W / 2 - 1.5)]], 3 * FT, 0.05);
    }
  }
  // designators: 36 at the south end (read landing north), 18 at the north end, 20 ft past the stripes
  numerals(paint, rw, '36', -L / 2 + thr + len + 20 * FT, 1, 0.05);
  numerals(paint, rw, '18', L / 2 - thr - len - 20 * FT, -1, 0.05);
  // centre line: 120 ft stripes, 80 ft gaps, 3 ft wide, from the designators' tops to the far ones
  const cl0 = -L / 2 + thr + len + 100 * FT, cl1 = L / 2 - thr - len - 100 * FT;
  for (let a = cl0; a + 120 * FT <= cl1; a += 200 * FT) rwQuad(paint, rw, a, a + 120 * FT, -0.45, 0.45, 0.05);
  // side stripes, 3 ft, along both edges
  for (const side of [-1, 1]) rwQuad(paint, rw, -L / 2 + thr, L / 2 - thr, side * (W / 2 - 1.5), side * (W / 2 - 0.6), 0.05);
  // parallel taxiway on the west side and the apron by the terminal
  rwQuad(taxi, rw, -L / 2 + 40, L / 2 - 40, -W / 2 - 75, -W / 2 - 60, 0.03);
  rwQuad(yel, rw, -L / 2 + 40, L / 2 - 40, -W / 2 - 67.7, -W / 2 - 67.3, 0.05);
  for (const at of [-L / 2 + 50, -60, L / 2 - 50]) {
    rwQuad(taxi, rw, at - 9, at + 9, -W / 2 - 75, -W / 2, 0.025);
    // the connector's centre line, and its hold-short marking 125 ft from the runway's centre line:
    // two solid lines on the taxiway side, two dashed on the runway side
    rwQuad(yel, rw, at - 0.2, at + 0.2, -W / 2 - 67.5, -W / 2 - 0.5, 0.05);
    const hold = -125 * FT;
    for (let k = 0; k < 4; k++) {
      const c = hold - 0.15 - k * 0.3 - (k > 1 ? 0.3 : 0);
      // (k counts away from the runway)
      if (k >= 2) rwQuad(yel, rw, at - 8.5, at + 8.5, c - 0.15, c, 0.052);
      else for (let d = -8.5; d < 8.5; d += 1.8) rwQuad(yel, rw, at + d, at + Math.min(8.5, d + 0.9), c - 0.15, c, 0.052);
    }
  }
  rwQuad(taxi, rw, 20, 230, -W / 2 - 160, -W / 2 - 75, 0.03);
  // the paved areas in runway coordinates (u across, v along), for the textures
  const areas = [
    { kind: 'runway', u: [-W / 2, W / 2], v: [-L / 2 - 30, L / 2 + 30] },
    { kind: 'taxiway', u: [-W / 2 - 75, -W / 2 - 60], v: [-L / 2 + 40, L / 2 - 40] },
    ...[-L / 2 + 50, -60, L / 2 - 50].map((at) => ({ kind: 'taxiway', u: [-W / 2 - 60, -W / 2], v: [at - 9, at + 9] })),
    { kind: 'apron', u: [-W / 2 - 160, -W / 2 - 75], v: [20, 230] },
  ];
  for (const mb of [asphalt, taxi, paint, yel]) runwayUvs(mb, rw);
  return { asphalt, taxi, paint, yel, areas };
}

/** Texture coordinates in runway metres: u across (east of the centreline +), v along (north +). */
export function runwayUvs(mb, rw) {
  mb.uvs = [];
  for (let i = 0; i < mb.positions.length; i += 3) {
    const n = -mb.positions[i + 2] - rw.centre[0], e = mb.positions[i] - rw.centre[1];
    mb.uvs.push(-n * rw.dir[1] + e * rw.dir[0], n * rw.dir[0] + e * rw.dir[1]);
  }
  return mb;
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

// modelled in detail (render/tower.js), not as a landmark box
const MODELLED = new Set(['Meigs Tower']);

/**
 * Every static scenery part: { name, color, mesh, layer }.
 *   layer 'core'  Meigs itself (lake, island, runway, terminal, tower) — always drawn
 *   layer 'city'  the hand-placed stand-in city and shore, drawn only when the
 *                 OpenStreetMap city is unavailable
 */
export function buildScenery(world) {
  const parts = [];
  const water = new MeshBuilder();
  const S = 40000;
  water.quad([-S, world.water, S], [S, world.water, S], [S, world.water, -S], [-S, world.water, -S]);
  parts.push({ name: 'lake', color: PALETTE.water, mesh: water, layer: 'core' });

  parts.push({ name: 'mainland', color: PALETTE.land, mesh: flatPolygon(new MeshBuilder(), world.mainland, 0.5), layer: 'city' });
  parts.push({ name: 'island', color: PALETTE.grass, mesh: runwayUvs(flatPolygon(new MeshBuilder(), world.island, 0.0), world.runway), layer: 'core', bias: -1, texture: 'grass' });
  const islandWalls = new MeshBuilder();
  wall(islandWalls, world.island, world.water - 0.5, 0.0);
  // walls are built two-sided (a quad each way): they need back-face culling, or the pair z-fights
  parts.push({ name: 'islandWall', color: PALETTE.seawall, mesh: islandWalls, layer: 'core', cullBack: true });   // below ground where OSM land is, a seawall where the lake is
  const shoreWalls = new MeshBuilder();
  wall(shoreWalls, world.shore, world.water - 0.5, 0.5, false);
  parts.push({ name: 'seawall', color: PALETTE.seawall, mesh: shoreWalls, layer: 'city', cullBack: true });
  parts.push({ name: 'navyPier', color: PALETTE.pier, mesh: flatPolygon(new MeshBuilder(), world.pier, 1.5), layer: 'city' });
  parts.push({ name: 'navyPierWall', color: PALETTE.pier, mesh: wall(new MeshBuilder(), world.pier, world.water - 0.5, 1.5), layer: 'city', cullBack: true });

  const rw = runway(world);
  parts.paved = rw.areas;
  // textured: a detail layer for the grain and one big image each for the variation (see groundTextures.js)
  parts.push({ name: 'runway', color: PALETTE.asphalt, mesh: rw.asphalt, layer: 'core', bias: -2, texture: 'runway' });
  parts.push({ name: 'taxiways', color: PALETTE.asphalt, mesh: rw.taxi, layer: 'core', bias: -2, texture: 'taxiway' });
  parts.push({ name: 'markings', color: PALETTE.marking, mesh: rw.paint, layer: 'core', bias: -3, texture: 'paint-runway', paint: PALETTE.marking });
  parts.push({ name: 'taxiLine', color: PALETTE.yellow, mesh: rw.yel, layer: 'core', bias: -3, texture: 'paint-taxiway', paint: PALETTE.yellow });

  const byColor = new Map();
  const tw = world.landmarks.find((l) => l.name === 'Meigs Tower');
  const tower = buildTower(tw.ne);
  for (const p of tower.parts) parts.push({ ...p, layer: 'core' });
  parts.tower = tower;
  for (const l of world.landmarks) {
    if (MODELLED.has(l.name)) continue;
    const layer = 'city';
    const k = `${layer}${l.color}`;
    if (!byColor.has(k)) byColor.set(k, { layer, color: l.color, mesh: new MeshBuilder() });
    building(byColor.get(k).mesh, l);
  }
  for (const [k, v] of byColor) parts.push({ name: `landmarks${k}`, ...v });
  const dt = downtown(world);
  parts.push({ name: 'loopLight', color: '#c9c3b6', mesh: dt.light, layer: 'city' });
  parts.push({ name: 'loopDark', color: '#55524c', mesh: dt.dark, layer: 'city' });
  parts.push({ name: 'loopGlass', color: PALETTE.glass, mesh: dt.glass, layer: 'city' });
  return parts;
}
