// extraModel.js — the Extra 300L, built from numbers rather than a mesh file.
//
// Every part is described in aircraft body axes (metres from the reference
// point R, x fwd, y right, z down), the same axes as the flight model, so the
// wheels sit where the gear model's contact points are, the control surfaces
// hinge where the aero strips put them, and the eye point is the sim's.
// Moving parts are built around their own hinge so the renderer only has to
// rotate one node per part.

import EXTRA from '../sim/aircraft/extra300l.js';
import { fromBody, MeshBuilder, ring } from './geometry.js';

export const LIVERY = {
  white: '#f3f1ec',
  red: '#c41e2a',
  blue: '#1d3e8a',
  dark: '#1b1d22',
  canopy: '#9fc4dc',
  tyre: '#151515',
  metal: '#a4a7ab',
  spinner: '#c41e2a',
};

// fuselage stations [x, zCentre, halfHeight, halfWidth, exponent] [est] from the three-view
const STATIONS = [
  [2.06, -0.02, 0.19, 0.19, 2.0],
  [1.98, -0.02, 0.34, 0.36, 2.4],
  [1.70, -0.03, 0.43, 0.44, 2.8],
  [1.20, -0.05, 0.47, 0.49, 3.0],
  [0.60, -0.06, 0.50, 0.50, 3.0],
  [-0.20, -0.06, 0.50, 0.48, 3.0],
  [-1.20, -0.06, 0.47, 0.42, 2.8],
  [-2.00, -0.10, 0.38, 0.31, 2.6],
  [-3.00, -0.20, 0.28, 0.19, 2.4],
  [-4.00, -0.29, 0.18, 0.10, 2.2],
  [-4.62, -0.33, 0.09, 0.04, 2.0],
];

const B = (x, y, z) => fromBody([x, y, z]);

function fuselage() {
  const mb = new MeshBuilder();
  const rings = STATIONS.map(([x, zc, hh, hw, e]) => ring(B(x, 0, zc), [1, 0, 0], [0, 1, 0], hw, hh, 24, e));
  mb.loft(rings);
  return mb;
}

/** Red sunburst panels along the fuselage sides (thin offset strips). */
function fuselageStripes() {
  const mb = new MeshBuilder();
  for (const side of [-1, 1]) {
    const pts = [];
    for (const [x, zc, hh, hw] of STATIONS.slice(2, 10)) {
      const y = side * (hw + 0.004);
      pts.push([B(x, y, zc - 0.05), B(x, y, zc + 0.12)]);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const [a0, a1] = pts[i], [b0, b1] = pts[i + 1];
      if (side > 0) mb.quad(a0, a1, b1, b0); else mb.quad(a0, b0, b1, a1);
    }
  }
  return mb;
}

function canopy() {
  const mb = new MeshBuilder();
  const xs = [0.95, 0.6, 0.1, -0.5, -1.1, -1.6, -1.95];
  const hs = [0.02, 0.28, 0.42, 0.47, 0.46, 0.33, 0.03];
  const ws = [0.20, 0.34, 0.39, 0.40, 0.38, 0.30, 0.10];
  const rings = xs.map((x, i) => {
    const base = -0.53;
    // upper half of an ellipse sitting on the fuselage top line
    const pts = [];
    const n = 12;
    for (let k = 0; k <= n; k++) {
      const t = Math.PI * (k / n);
      pts.push(B(x, ws[i] * Math.cos(t), base - hs[i] * Math.sin(t)));
    }
    return pts;
  });
  // join as an open loft (no end caps, not closed around)
  const m = rings[0].length;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < m - 1; j++) {
      mb.quad(rings[i][j], rings[i + 1][j], rings[i + 1][j + 1], rings[i][j + 1]);
    }
  }
  return mb;
}

/**
 * A horizontal lifting surface: planform stations [[yBody, xLE, xTE], ...] with
 * the chord plane at body z = planeOffset, NACA 00xx section of thickness t.
 */
function surface(stations, { planeOffset = 0, t = 0.13, mirror = false } = {}) {
  const mb = new MeshBuilder();
  const N = 8; // chordwise points per side
  const sectionPts = (s, xle, xte) => {
    const c = xle - xte;
    const pts = [];
    for (let k = 0; k <= N; k++) {
      const u = k / N;                                   // 0 = LE, 1 = TE (cosine spacing)
      const xc = 0.5 * (1 - Math.cos(Math.PI * u));
      const th = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4); // NACA 00xx
      pts.push([xle - xc * c, th * c]);
    }
    const upper = pts.map(([x, h]) => [x, h]);
    const lower = pts.slice(1, -1).reverse().map(([x, h]) => [x, -h]);
    return [...upper, ...lower].map(([x, h]) => B(x, s, planeOffset - h));
  };
  const rings = stations.map(([s, xle, xte]) => sectionPts(s, xle, xte));
  mb.loft(rings, { flip: mirror });
  return mb;
}

// ── wing ────────────────────────────────────────────────────────────────────
const TE = -1.014;
const chordAt = (y) => 1.86 + ((0.82 - 1.86) * Math.abs(y)) / 4.0;
const AIL_IN = 0.95, AIL_OUT = 3.95, AIL_FRAC = 0.3;
const WING_Z = 0.2;

function wingFixed(side) {
  // inboard full-chord part, then the outboard part ahead of the aileron
  const st = [];
  const ys = [0.3, 0.5, AIL_IN];
  for (const y of ys) st.push([side * y, TE + chordAt(y), TE]);
  const inner = surface(st, { planeOffset: WING_Z, t: 0.15, mirror: side < 0 });
  const ys2 = [AIL_IN, 2.0, 3.0, AIL_OUT, 4.0];
  const st2 = ys2.map((y) => {
    const c = chordAt(y);
    const hinge = y <= AIL_OUT ? TE + AIL_FRAC * c : TE;
    return [side * y, TE + c, hinge];
  });
  const outer = surface(st2, { planeOffset: WING_Z, t: 0.13, mirror: side < 0 });
  return inner.append(outer);
}

/** Aileron built around its hinge line; returns { mesh, hinge, axis } in body axes. */
function aileron(side) {
  const y0 = AIL_IN, y1 = AIL_OUT;
  const h0 = TE + AIL_FRAC * chordAt(y0), h1 = TE + AIL_FRAC * chordAt(y1);
  const hinge = [0.5 * (h0 + h1), side * 0.5 * (y0 + y1), WING_Z];
  const st = [y0, 2.0, 3.0, y1].map((y) => [side * y, TE + AIL_FRAC * chordAt(y), TE]);
  const mesh = surface(st, { planeOffset: WING_Z, t: 0.13 * 0.6, mirror: side < 0 });
  const axis = [h1 - h0, side * (y1 - y0), 0];
  return { mesh, hinge, axis };
}

// ── tail ────────────────────────────────────────────────────────────────────
const HT_Z = -0.18;
const HT_HINGE = -4.18;

function stabiliser(side) {
  const st = [[side * 0.08, -3.55, HT_HINGE], [side * 0.8, -3.62, HT_HINGE], [side * 1.6, -3.78, HT_HINGE]];
  return surface(st, { planeOffset: HT_Z, t: 0.12, mirror: side < 0 });
}
function elevator() {
  const mb = new MeshBuilder();
  for (const side of [-1, 1]) {
    const st = [[side * 0.08, HT_HINGE, -4.62], [side * 0.8, HT_HINGE, -4.58], [side * 1.6, HT_HINGE, -4.42]];
    mb.append(surface(st, { planeOffset: HT_Z, t: 0.12 * 0.7, mirror: side < 0 }));
  }
  return { mesh: mb, hinge: [HT_HINGE, 0, HT_Z], axis: [0, 1, 0] };
}

const VT_HINGE = -4.25;
function fin() {
  // span along body -z (up)
  // stations [zBody, xLE, xTE], z negative = up
  return surfaceVertical([[-0.3, -3.55, VT_HINGE], [-0.8, -3.80, VT_HINGE], [-1.32, -4.02, VT_HINGE]], 0.12);
}
function rudder() {
  const st = [[0.05, VT_HINGE, -4.70], [-0.8, VT_HINGE, -4.66], [-1.38, VT_HINGE, -4.35]];
  return { mesh: surfaceVertical(st, 0.1), hinge: [VT_HINGE, 0, -0.6], axis: [0, 0, -1] };
}
function surfaceVertical(stations, t) {
  // stations: [zBody, xLE, xTE]; thickness along body y
  const mb = new MeshBuilder();
  const N = 8;
  const rings = stations.map(([z, xle, xte]) => {
    const c = xle - xte;
    const pts = [];
    for (let k = 0; k <= N; k++) {
      const xc = 0.5 * (1 - Math.cos(Math.PI * (k / N)));
      const th = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
      pts.push([xle - xc * c, th * c]);
    }
    const upper = pts;
    const lower = pts.slice(1, -1).reverse().map(([x, h]) => [x, -h]);
    return [...upper, ...lower].map(([x, h]) => B(x, h, z));
  });
  mb.loft(rings, { flip: true });
  return mb;
}

// ── propeller, spinner, cowl details ───────────────────────────────────────
const PROP_X = EXTRA.prop.pos[0];
function spinner() {
  const mb = new MeshBuilder();
  const rings = [];
  const len = 0.36, r0 = 0.185;
  for (let i = 0; i <= 6; i++) {
    const f = i / 6;
    const r = r0 * Math.sqrt(1 - f * f) + 0.002;
    rings.push(ring(B(PROP_X + f * len, 0, 0), [1, 0, 0], [0, 1, 0], r, r, 16, 2));
  }
  mb.loft(rings, { flip: true });
  return mb;
}
/** Three blades around the hub at the origin of the prop node (node sits on the crank axis). */
function blades(pitchDeg = 20) {
  const mb = new MeshBuilder();
  const R = EXTRA.prop.diameter / 2;
  for (let b = 0; b < 3; b++) {
    const ang = (b * 2 * Math.PI) / 3;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rings = [];
    for (const r of [0.16, 0.35, 0.6, 0.85, R]) {
      const chord = r < 0.3 ? 0.11 : 0.16 - 0.06 * ((r - 0.3) / (R - 0.3));
      const twist = ((pitchDeg + 22 * (0.75 * R / r - 1) * 0.5) * Math.PI) / 180;
      const th = 0.012;
      // blade section in the plane perpendicular to its radius, then spun to its azimuth
      const sect = [[chord * 0.35, th], [-chord * 0.65, th * 0.3], [-chord * 0.65, -th * 0.3], [chord * 0.35, -th]].map(([c, t]) => {
        const xb = Math.sin(twist) * c + Math.cos(twist) * t;   // along the crank axis
        const tb = Math.cos(twist) * c - Math.sin(twist) * t;   // tangential
        // radius along (0, ca, sa) in body y/z, tangential along (0, -sa, ca)
        return B(xb, ca * r - sa * tb, sa * r + ca * tb);
      });
      rings.push(sect);
    }
    mb.loft(rings);
  }
  return mb;
}
function propDisc() {
  const mb = new MeshBuilder();
  const R = EXTRA.prop.diameter / 2;
  const pts = ring([0, 0, 0], [1, 0, 0], [0, 1, 0], R, R, 32, 2).map(([x, y]) => B(0, x, y));
  mb.fan(pts);
  mb.fan(pts, true);
  return mb;
}

// ── landing gear ───────────────────────────────────────────────────────────
const MAIN = EXTRA.gear.units[0];
function mainLeg(side) {
  const mb = new MeshBuilder();
  const r = MAIN.tyre.radius;
  const top = [0.62, side * 0.32, 0.38];
  const bot = [MAIN.pos[0], side * (Math.abs(MAIN.pos[1]) - 0.08), MAIN.pos[2] - r];
  const w = 0.07, t = 0.025;
  const p = (q, dx, dz) => B(q[0] + dx, q[1], q[2] + dz);
  const a0 = p(top, w * 1.6, -t), a1 = p(top, -w * 1.6, -t), a2 = p(top, -w * 1.6, t), a3 = p(top, w * 1.6, t);
  const b0 = p(bot, w, -t), b1 = p(bot, -w, -t), b2 = p(bot, -w, t), b3 = p(bot, w, t);
  mb.quad(a0, b0, b1, a1).quad(a1, b1, b2, a2).quad(a2, b2, b3, a3).quad(a3, b3, b0, a0);
  return mb;
}
function wheelPant(side) {
  const mb = new MeshBuilder();
  const cx = MAIN.pos[0], cy = side * Math.abs(MAIN.pos[1]), cz = MAIN.pos[2] - MAIN.tyre.radius;
  const xs = [0.42, 0.3, 0.1, -0.1, -0.3, -0.48];
  const hs = [0.02, 0.15, 0.21, 0.21, 0.14, 0.02];
  const ws = [0.02, 0.09, 0.12, 0.12, 0.08, 0.01];
  const rr = xs.map((x, i) => ring(B(cx + x, cy, cz - 0.02), [1, 0, 0], [0, 1, 0], ws[i], hs[i], 14, 2.2));
  mb.loft(rr, { flip: true });
  return mb;
}
function wheel(radius, width) {
  const mb = new MeshBuilder();
  const rings = [];
  for (const [y, rf] of [[-width / 2, 0.75], [-width / 2, 0.97], [0, 1], [width / 2, 0.97], [width / 2, 0.75]]) {
    rings.push(circleXZ(y, radius * rf));
  }
  mb.loft(rings);
  return mb;
}
function circleXZ(y, r, n = 18) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    pts.push(B(Math.cos(t) * r, y, Math.sin(t) * r));
  }
  return pts;
}

/**
 * All parts of the aircraft. Static parts: { name, color, mesh }. Moving
 * parts add { hinge (body), axis (body), kind } and their mesh is relative
 * to the hinge.
 */
export function buildExtraModel() {
  const parts = [];
  const rel = (mesh, hinge) => {
    const h = fromBody(hinge);
    return new MeshBuilder().append(mesh, (p) => [p[0] - h[0], p[1] - h[1], p[2] - h[2]]);
  };
  parts.push({ name: 'fuselage', color: LIVERY.white, mesh: fuselage() });
  parts.push({ name: 'stripes', color: LIVERY.red, mesh: fuselageStripes() });
  parts.push({ name: 'canopy', color: LIVERY.canopy, mesh: canopy(), transparent: true });
  parts.push({ name: 'wingL', color: LIVERY.white, mesh: wingFixed(-1) });
  parts.push({ name: 'wingR', color: LIVERY.white, mesh: wingFixed(1) });
  for (const side of [-1, 1]) {
    const a = aileron(side);
    parts.push({ name: side < 0 ? 'aileronL' : 'aileronR', color: LIVERY.red, mesh: rel(a.mesh, a.hinge), hinge: a.hinge, axis: a.axis, kind: 'aileron', side });
  }
  parts.push({ name: 'stabL', color: LIVERY.white, mesh: stabiliser(-1) });
  parts.push({ name: 'stabR', color: LIVERY.white, mesh: stabiliser(1) });
  const el = elevator();
  parts.push({ name: 'elevator', color: LIVERY.red, mesh: rel(el.mesh, el.hinge), hinge: el.hinge, axis: el.axis, kind: 'elevator' });
  parts.push({ name: 'fin', color: LIVERY.white, mesh: fin() });
  const ru = rudder();
  parts.push({ name: 'rudder', color: LIVERY.red, mesh: rel(ru.mesh, ru.hinge), hinge: ru.hinge, axis: ru.axis, kind: 'rudder' });
  parts.push({ name: 'spinner', color: LIVERY.spinner, mesh: spinner() });
  parts.push({ name: 'prop', color: LIVERY.dark, mesh: blades(), hinge: [PROP_X + 0.05, 0, 0], axis: [1, 0, 0], kind: 'prop' });
  parts.push({ name: 'propDisc', color: LIVERY.dark, mesh: propDisc(), hinge: [PROP_X + 0.05, 0, 0], axis: [1, 0, 0], kind: 'propDisc', transparent: true });
  for (const side of [-1, 1]) {
    parts.push({ name: `leg${side}`, color: LIVERY.white, mesh: mainLeg(side) });
    parts.push({ name: `pant${side}`, color: LIVERY.red, mesh: wheelPant(side) });
    const hub = [MAIN.pos[0], side * Math.abs(MAIN.pos[1]), MAIN.pos[2] - MAIN.tyre.radius];
    parts.push({ name: `wheel${side}`, color: LIVERY.tyre, mesh: wheel(MAIN.tyre.radius, 0.11), hinge: hub, axis: [0, 1, 0], kind: 'wheel', gear: side < 0 ? 0 : 1 });
  }
  const tw = EXTRA.gear.units[2];
  const twHub = [tw.pos[0], 0, tw.pos[2] - tw.tyre.radius];
  parts.push({ name: 'tailwheel', color: LIVERY.tyre, mesh: wheel(tw.tyre.radius, 0.05), hinge: twHub, axis: [0, 1, 0], kind: 'tailwheel', gear: 2 });
  parts.push({ name: 'tailSpring', color: LIVERY.dark, mesh: tailSpring(twHub) });
  return parts;
}

function tailSpring(hub) {
  const mb = new MeshBuilder();
  const top = [-4.25, 0, -0.22];
  const w = 0.02, t = 0.012;
  const p = (q, dy, dz) => B(q[0], q[1] + dy, q[2] + dz);
  const a = [p(top, -w, -t), p(top, w, -t), p(top, w, t), p(top, -w, t)];
  const b = [p(hub, -w, -t), p(hub, w, -t), p(hub, w, t), p(hub, -w, t)];
  for (let i = 0; i < 4; i++) mb.quad(a[i], b[i], b[(i + 1) % 4], a[(i + 1) % 4]);
  return mb;
}
