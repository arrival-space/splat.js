// carrierModel.js — the carrier as meshes, from world/carrier.js's numbers.
//
//   hull      sections every 2 m from the stern to the stem: the hull flaring
//             up from the waterline to the hangar deck, the gallery deck's
//             wall, the sponsons' undersides out to the flight deck's edge;
//             the transom with the fantail's opening, a raked stem, hawse
//             pipes and the hull number on the bows
//   deck      the flight deck, textured in ship metres (render/carrierTextures.js),
//             the four deck-edge elevators raised to it, the hangar's openings
//             under them, the catwalks along the edges
//   markings  the landing area (edges, dashed centre line, foul line, the
//             stern's ramp), the catapults' tracks and shuttles, the jet blast
//             deflectors (one raised behind the Hornet on catapult 2), taxi
//             lines, the elevators' edges, the hull number on the bow
//   island    stepped decks with portholes, the navigation bridge's and primary
//             flight control's glass, the hull number, the mast with its
//             yards, the SPS-48 and SPS-49 radars and the radomes
//   deck park Hornets with their wings folded, tractors, the crash crane
//   lights    the drop lights down the stern, the landing area's edge and
//             centre-line lights; the Fresnel lens's housing (its lights are the
//             plugin's)
//
// Pure geometry: the plugin draws it (plugin/carrierVisual.js), the arresting
// wires and the lens's ball move there.
//
// Ship-local render space: x to starboard (t), y up (height above the
// runway, as everything else), z aft (−s); the plugin turns it to the ship's
// heading and puts its origin on the stern.

import earcut from 'earcut';
import { MeshBuilder } from './geometry.js';
import { buildHornet, slab } from './hornet.js';
import { GLYPHS } from './scenery.js';

/** Port and starboard edge (t) of a polygon [[s, t], ...] at station s, or null. */
export function widthAt(poly, s) {
  const ts = [];
  for (let i = 0; i < poly.length; i++) {
    const [s0, t0] = poly[i], [s1, t1] = poly[(i + 1) % poly.length];
    if ((s0 <= s && s1 > s) || (s1 <= s && s0 > s)) ts.push(t0 + ((s - s0) / (s1 - s0)) * (t1 - t0));
  }
  return ts.length >= 2 ? [Math.min(...ts), Math.max(...ts)] : null;
}

const P = (s, t, h) => [t, h, -s];

/** The deck-edge elevators: forward edge, aft edge (s), side, how far they stand out from the deck's edge. */
export const ELEVATORS = [
  { s0: 262, s1: 281, side: 1, out: 11 },
  { s0: 225, s1: 244, side: 1, out: 11 },
  { s0: 152, s1: 171, side: 1, out: 11 },
  { s0: 38, s1: 57, side: -1, out: 10 },
];

/** A flat strip painted on the deck from (s0, t0) to (s1, t1), `w` wide. */
function stripe(mb, a, b, w, h) {
  const ds = b[0] - a[0], dt = b[1] - a[1];
  const l = Math.hypot(ds, dt) || 1;
  const ns = (-dt / l) * w / 2, nt = (ds / l) * w / 2;
  const q = [P(a[0] - ns, a[1] - nt, h), P(a[0] + ns, a[1] + nt, h), P(b[0] + ns, b[1] + nt, h), P(b[0] - ns, b[1] - nt, h)];
  upQuad(mb, q);
}

/** A horizontal quad turned to face up. */
function upQuad(mb, [a, b, c, d]) {
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (ny > 0) mb.quad(a, b, c, d); else mb.quad(a, d, c, b);
}

/**
 * Glyphs (scenery.js's FAA numerals: a 20 × 60 cell) stroked onto a surface: `map(x, y)` turns a point
 * of the text (x to the reader's right, y up, metres) into render space, `out` faces it.
 */
function lettering(mb, text, { height, map, out, stroke = 0.09 }) {
  const k = height / 60, w = 20 * k, gap = 9 * k;
  const total = text.length * w + (text.length - 1) * gap;
  [...text].forEach((ch, i) => {
    const x0 = -total / 2 + i * (w + gap);
    for (const path of GLYPHS[ch] || []) {
      for (let j = 0; j < path.length - 1; j++) {
        const [xa, ya] = path[j], [xb, yb] = path[j + 1];
        const ax = x0 + xa * k, ay = ya * k, bx = x0 + xb * k, by = yb * k;
        const l = Math.hypot(bx - ax, by - ay) || 1;
        const ex = ((bx - ax) / l) * stroke * height * 0.25, ey = ((by - ay) / l) * stroke * height * 0.25;
        const nx = (-(by - ay) / l) * stroke * height / 2, ny = ((bx - ax) / l) * stroke * height / 2;
        const q = [map(ax - ex + nx, ay - ey + ny), map(ax - ex - nx, ay - ey - ny), map(bx + ex - nx, by + ey - ny), map(bx + ex + nx, by + ey + ny)];
        mb.quadOut(q[0], q[1], q[2], q[3], q.reduce((c, p) => [c[0] + p[0] / 4 - out[0], c[1] + p[1] / 4 - out[1], c[2] + p[2] / 4 - out[2]], [0, 0, 0]));
      }
    }
  });
}

/** A box in ship coordinates: s, t, h ranges (h from the deck at H). */
function sbox(mb, H, s0, s1, t0, t1, h0, h1) {
  mb.box([Math.min(t0, t1), H + h0, -Math.max(s0, s1)], [Math.max(t0, t1), H + h1, -Math.min(s0, s1)]);
}

/** A vertical prism over a footprint [[s, t], ...] from h0 to h1 above the deck, faces outward. */
function block(mb, H, foot, h0, h1) {
  const c = foot.reduce((a, [s, t]) => [a[0] + s / foot.length, a[1] + t / foot.length], [0, 0]);
  const inside = P(c[0], c[1], H + (h0 + h1) / 2);
  for (let i = 0; i < foot.length; i++) {
    const [sa, ta] = foot[i], [sb, tb] = foot[(i + 1) % foot.length];
    mb.quadOut(P(sa, ta, H + h0), P(sb, tb, H + h0), P(sb, tb, H + h1), P(sa, ta, H + h1), inside);
  }
  const top = foot.map(([s, t]) => P(s, t, H + h1));
  for (let i = 1; i < top.length - 1; i++) {
    const [a, b, c2] = [top[0], top[i], top[i + 1]];
    const ny = (b[2] - a[2]) * (c2[0] - a[0]) - (b[0] - a[0]) * (c2[2] - a[2]);
    if (ny > 0) mb.tri(a, b, c2); else mb.tri(a, c2, b);
  }
}

/** A footprint rectangle with its forward corners cut back `c` metres. */
const chamfered = (s0, s1, t0, t1, c) => [[s0, t0], [s1 - c, t0], [s1, t0 + c], [s1, t1 - c], [s1 - c, t1], [s0, t1]];

/** A sphere-ish dome (a squashed ball) at (s, t, h) above the deck. */
function dome(mb, H, s, t, h, r) {
  const rings = [];
  for (let i = 1; i < 6; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 6;
    rings.push(Array.from({ length: 12 }, (_, k) => {
      const b = (2 * Math.PI * k) / 12;
      return P(s + r * Math.cos(a) * Math.cos(b), t + r * Math.cos(a) * Math.sin(b), H + h + r * Math.sin(a));
    }));
  }
  mb.loft(rings);
}

/** Replace a builder's texture coordinates by f(position, normal). */
function setUvs(mb, f) {
  for (let i = 0, k = 0; i < mb.positions.length; i += 3, k += 2) {
    const uv = f([mb.positions[i], mb.positions[i + 1], mb.positions[i + 2]], [mb.normals[i], mb.normals[i + 1], mb.normals[i + 2]]);
    mb.uvs[k] = uv[0]; mb.uvs[k + 1] = uv[1];
  }
}

/**
 * @param {object} carrier  world/carrier.js buildCarrier()
 * @param {number} water    the lake's level (m above the runway)
 * @returns {{ name: string, color: string, mesh: MeshBuilder, finish: string }[]}
 *   finish: hull (the hull's texture), deck (the deck's), paint, mark (flat on the deck), glass,
 *   dark, grating, emissive
 */
export function buildCarrierModel(carrier, water) {
  const d = carrier.data;
  const H = carrier.deckH;
  const parts = [];
  const add = (name, color, mesh, finish) => parts.push({ name, color, mesh, finish });

  // ── hull ────────────────────────────────────────────────────────────────
  const hull = new MeshBuilder({ uv: true });
  const dark = new MeshBuilder();
  const paint = new MeshBuilder();
  const grating = new MeshBuilder();
  const stations = [];
  const sMax = Math.max(...d.deck.map(([s]) => s)) - 0.01;
  for (let s = 0.01; s < sMax; s += 2) stations.push(s);
  stations.push(sMax);
  const wlStart = d.waterline[0][0];
  const elevatorAt = (s, side) => ELEVATORS.find((e) => e.side === side && s > e.s0 - 0.5 && s < e.s1 + 0.5);
  // each section's profile on each side: keel, waterline, hangar deck, gallery deck, sponson, deck edge
  const sections = stations.map((s) => {
    const dk = widthAt(d.deck, s) || [-1, 1];
    // past the waterline's end the stem rakes forward and up to the flight deck
    const wl = widthAt(d.waterline, Math.max(s, wlStart + 0.01)) || [-0.4, 0.4];
    const lift = Math.min(1, Math.max(0, (s - 318) / 14)) ** 1.5 * (H - 6 - water);
    const prof = [0, 1].map((k) => {
      const sg = k ? 1 : -1;
      const w = Math.abs(wl[k]), e = Math.abs(dk[k]);
      const wall = Math.min(e, w * 1.05 + 0.4);
      const hb = Math.max(water + 0.6 + lift, H - 9);
      return [
        [sg * w * 0.9, water - 2.5 + lift],
        [sg * w, water + 0.5 + lift],
        [sg * wall, hb],
        [sg * wall, H - 1.7],
        [sg * e, H - 1.7],
        [sg * e, H],
      ];
    });
    return { s, dk, prof };
  });
  for (let i = 0; i < sections.length - 1; i++) {
    const A = sections[i], B = sections[i + 1];
    const sm = (A.s + B.s) / 2;
    for (const k of [0, 1]) {
      const a = A.prof[k], b = B.prof[k];
      for (let j = 0; j < 5; j++) {
        const q = [P(A.s, ...a[j]), P(B.s, ...b[j]), P(B.s, ...b[j + 1]), P(A.s, ...a[j + 1])];
        const span = Math.hypot(a[j + 1][0] - a[j][0], a[j + 1][1] - a[j][1]) + Math.hypot(b[j + 1][0] - b[j][0], b[j + 1][1] - b[j][1]);
        if (span < 0.05) continue;
        // the sponson's underside faces down, everything else out from the middle
        const inside = j === 3 ? P(sm, a[j][0], H + 6) : P(sm, 0, (a[j][1] + a[j + 1][1]) / 2);
        hull.quadOut(q[0], q[1], q[2], q[3], inside);
      }
    }
  }
  // the transom: the stern's section closed flat, and the fantail's opening across it
  const capSection = (X, facing) => {
    const ring = [...X.prof[0].slice().reverse(), ...X.prof[1]];
    const tri = earcut(ring.flat());
    for (let i = 0; i < tri.length; i += 3) {
      const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]].map((k) => P(X.s, ring[k][0], ring[k][1]));
      const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (nz * facing > 0) hull.tri(a, b, c); else hull.tri(a, c, b);
    }
  };
  capSection(sections[0], 1);
  capSection(sections[sections.length - 1], -1);
  sbox(dark, H, -0.06, 0.05, -11, 11, -6.8, -3.2);                    // the fantail
  for (const t of [-13.5, 13.5]) sbox(dark, H, -0.06, 0.05, t - 1.2, t + 1.2, -12.5, -11);   // stern ports
  // hawse pipes and anchors on the bows
  for (const sg of [-1, 1]) {
    const s = 300, sec = sections.find((x) => x.s >= s);
    const t = sec.prof[sg > 0 ? 1 : 0][2][0];
    const tt = t + sg * 0.12;
    sbox(dark, H, s - 1.3, s + 1.3, tt - sg * 0.3, tt, -10.2, -8.0);
    sbox(dark, H, s - 0.5, s + 0.5, tt - sg * 0.1, tt + sg * 0.25, -12.5, -9.6);   // the anchor's shank
    sbox(dark, H, s - 1.4, s + 1.4, tt - sg * 0.1, tt + sg * 0.3, -12.9, -12.4);   // its flukes
  }
  // hangar openings under the elevators, in the gallery wall
  for (const e of ELEVATORS) {
    const sec = sections.find((x) => x.s >= (e.s0 + e.s1) / 2);
    const wall = sec.prof[e.side > 0 ? 1 : 0][3][0];
    const tw = wall + e.side * 0.06;
    dark.quadOut(P(e.s0 + 0.8, tw, H - 9.6), P(e.s1 - 0.8, tw, H - 9.6), P(e.s1 - 0.8, tw, H - 1.8), P(e.s0 + 0.8, tw, H - 1.8), P((e.s0 + e.s1) / 2, 0, H - 5));
  }
  // the hull's texture: along the ship on the sides (repeating every 64 m), across it on the transom
  // (the engine reads an image's first row at v = 0: the textures' top rows, v = 1 in their generators, go there)
  setUvs(hull, (p, n) => [Math.abs(n[2]) > 0.7 ? p[0] / 64 : -p[2] / 64, 1 - (p[1] - (water - 2)) / (H - water + 2)]);
  add('hull', '#ffffff', hull, 'hull');

  // ── the flight deck and the elevators ──────────────────────────────────
  const T0 = -46, T1 = 40, SL = 334;
  const deck = new MeshBuilder({ uv: true });
  const flat = d.deck.flatMap(([s, t]) => [s, t]);
  const tri = earcut(flat);
  for (let i = 0; i < tri.length; i += 3) {
    const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]].map((k) => P(d.deck[k][0], d.deck[k][1], H + 0.02));
    const n = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
    if (n < 0) deck.tri(a, b, c); else deck.tri(a, c, b);
  }
  const marks = { white: new MeshBuilder(), yellow: new MeshBuilder(), red: new MeshBuilder(), dark: new MeshBuilder(), steel: new MeshBuilder() };
  const hm = H + 0.06;
  for (const e of ELEVATORS) {
    const k = e.side > 0 ? 1 : 0;
    const t0a = widthAt(d.deck, e.s0)[k], t0b = widthAt(d.deck, e.s1)[k];
    const corners = [[e.s0, t0a], [e.s1, t0b], [e.s1, t0b + e.side * e.out], [e.s0, t0a + e.side * e.out]];
    upQuad(deck, corners.map(([s, t]) => P(s, t, H + 0.02)));
    // its body under the deck plate, and the stanchions along its outer edge
    const inside = P((e.s0 + e.s1) / 2, t0a + (e.side * e.out) / 2, H - 0.6);
    const lo = corners.map(([s, t]) => P(s, t, H - 1.1)), hi = corners.map(([s, t]) => P(s, t, H + 0.01));
    for (let j = 0; j < 4; j++) paint.quadOut(lo[j], lo[(j + 1) % 4], hi[(j + 1) % 4], hi[j], inside);
    paint.quadOut(lo[0], lo[1], lo[2], lo[3], P((e.s0 + e.s1) / 2, t0a, H + 3));
    for (let x = 0; x <= 8; x++) {
      const s = e.s0 + ((e.s1 - e.s0) * x) / 8, t = t0a + e.side * (e.out - 0.15);
      sbox(grating, H, s - 0.04, s + 0.04, t - 0.04, t + 0.04, 0, 1.0);
    }
    sbox(grating, H, e.s0, e.s1, t0a + e.side * (e.out - 0.19), t0a + e.side * (e.out - 0.11), 0.96, 1.02);
    // the gap round it, where it meets the deck
    stripe(marks.dark, [e.s0, t0a - e.side * 0.3], [e.s1, t0b - e.side * 0.3], 0.22, hm);
    stripe(marks.dark, [e.s0, t0a], [e.s0, t0a + e.side * e.out], 0.22, hm);
    stripe(marks.dark, [e.s1, t0b], [e.s1, t0b + e.side * e.out], 0.22, hm);
  }
  setUvs(deck, (p) => [(p[0] - T0) / (T1 - T0), 1 + p[2] / SL]);
  add('deck', '#ffffff', deck, 'deck');

  // the catwalks: grating a metre below the deck's edge, its outer rail, where no elevator is
  for (let i = 0; i < sections.length - 1; i++) {
    const A = sections[i], B = sections[i + 1];
    if (A.s < 4 || B.s > 300) continue;
    for (const k of [0, 1]) {
      const sg = k ? 1 : -1;
      if (elevatorAt(A.s, sg) || elevatorAt(B.s, sg)) continue;
      const ta = A.dk[k], tb = B.dk[k];
      if (Math.abs(ta - tb) > 3) continue;                       // not across a corner of the outline
      const q = [P(A.s, ta, H - 1.15), P(B.s, tb, H - 1.15), P(B.s, tb + sg * 1.4, H - 1.15), P(A.s, ta + sg * 1.4, H - 1.15)];
      upQuad(grating, q);
      grating.quad(P(A.s, ta + sg * 1.4, H - 1.15), P(B.s, tb + sg * 1.4, H - 1.15), P(B.s, tb + sg * 1.55, H - 0.25), P(A.s, ta + sg * 1.55, H - 0.25));
    }
  }

  // ── markings ────────────────────────────────────────────────────────────
  const { white, yellow, red } = marks;
  const L = (dist, lat) => {
    const [n, e] = carrier.onLanding(dist, lat);
    return carrier.toShip(n, e);
  };
  const la = d.landing;
  // the landing area: its edges, the dashed centre line, the ramp's stripes at the stern
  for (const side of [-1, 1]) stripe(white, L(2, side * la.halfWidth), L(la.length - 6, side * la.halfWidth), 0.45, hm);
  for (let x = 4; x < la.length - 10; x += 9) stripe(white, L(x, 0), L(x + 4.5, 0), 0.5, hm);
  for (let k = -6; k <= 6; k++) stripe(white, L(0.8, k * 2.0), L(5, k * 2.0), 0.5, hm);
  // the foul line: red and white along the landing area's starboard side
  for (let x = 10; x < 200; x += 6) {
    stripe(red, L(x, la.halfWidth + 5), L(x + 3, la.halfWidth + 5), 0.32, hm);
    stripe(white, L(x + 3, la.halfWidth + 5), L(x + 6, la.halfWidth + 5), 0.32, hm);
  }
  // the wires' deck-edge sheaves, and the wires' positions painted at the edges
  for (const w of carrier.wires) {
    for (const side of [-1, 1]) {
      stripe(yellow, L(w.along, side * (d.wireHalfSpan + 0.3)), L(w.along, side * (d.wireHalfSpan + 2)), 0.6, hm);
      const [s, t] = L(w.along, side * (d.wireHalfSpan + 0.4));
      sbox(dark, H, s - 0.35, s + 0.35, t - 0.35, t + 0.35, 0, 0.22);
    }
  }
  // catapults: tracks with the shuttle at the launch end, the jet blast deflectors behind them
  const cats = [
    { a: [205, -8], b: [326, -4], jbd: false },
    { a: [205, 7], b: [326, 3.5], jbd: true },
    { a: L(118, -7), b: L(190, -7), jbd: false },
    { a: L(112, 7), b: L(184, 7), jbd: false },
  ];
  for (const c of cats) {
    const [s0, t0] = c.a, [s1, t1] = c.b;
    const l = Math.hypot(s1 - s0, t1 - t0), us = (s1 - s0) / l, ut = (t1 - t0) / l;
    const at = (x, y) => [s0 + us * x - ut * y, t0 + ut * x + us * y];
    stripe(marks.dark, c.a, c.b, 0.3, hm);
    for (const y of [-0.45, 0.45]) stripe(marks.steel, at(0, y), at(l, y), 0.12, hm);
    const [ss, st] = at(1.5, 0);
    sbox(paint, H, ss - 0.6, ss + 0.6, st - 0.25, st + 0.25, 0, 0.3);
    // the deflector: 11 m across, 4.3 m deep, hinged at its forward edge; flush, outlined, or raised
    const fwd = -7, aft = fwd - 4.3;
    if (c.jbd) {
      const up = 50 * Math.PI / 180;
      const corner = (x, y, hh) => P(...at(x, y), H + hh);
      const ha = 4.3 * Math.sin(up), xa = fwd - 4.3 * Math.cos(up);
      slab(paint, [corner(fwd, -5.5, 0.15), corner(fwd, 5.5, 0.15), corner(xa, 5.5, ha), corner(xa, -5.5, ha)], 0.25);
      for (const y of [-3, 3]) slab(dark, [corner(fwd - 2.5, y - 0.15, 0), corner(fwd - 2.5, y + 0.15, 0), corner(xa + 0.6, y + 0.15, ha - 0.5), corner(xa + 0.6, y - 0.15, ha - 0.5)], 0.3);
    }
    stripe(c.jbd ? marks.dark : marks.steel, at(fwd, -5.5), at(fwd, 5.5), c.jbd ? 0.5 : 0.18, hm);
    for (const y of [-5.5, 5.5]) stripe(marks.dark, at(fwd, y), at(aft, y), 0.16, hm);
    stripe(marks.dark, at(aft, -5.5), at(aft, 5.5), 0.16, hm);
    // the lead-in line the taxi director brings the jet in on
    stripe(yellow, at(-30, 0), at(-12, 0), 0.3, hm);
  }
  // taxi lines to the elevators and the deck park
  for (const [a, b] of [[[60, 6], [150, 15]], [[176, 6], [226, 16]], [[248, 6], [262, 16]], [[30, -4], [45, -24]]]) stripe(yellow, a, b, 0.3, hm);
  // the hull number on the bow, read from aft (its top toward the bow)
  lettering(white, (d.hull.match(/\d+/) || ['68'])[0], {
    height: 15, stroke: 0.085, out: [0, 1, 0],
    map: (x, y) => P(287 + y, x - 1, hm),
  });

  // the hull number on the bows, under the flight deck's overhang, white on a black shadow
  const num = (d.hull.match(/\d+/) || ['68'])[0];
  for (const sg of [-1, 1]) {
    const tAt = (s) => {
      const sec = sections.find((x) => x.s >= s) || sections[sections.length - 1];
      return sec.prof[sg > 0 ? 1 : 0][3][0];
    };
    // seen from the side: aft is to the reader's right on the port bow, to the left on the starboard bow
    const map = (off, dx = 0, dy = 0) => (x, y) => { const s = 291 + sg * (x + dx); return P(s, tAt(s) + sg * off, H - 8.6 + y + dy); };
    lettering(dark, num, { height: 6, stroke: 0.1, out: [sg, 0, 0], map: map(0.07, 0.18, -0.18) });
    lettering(white, num, { height: 6, stroke: 0.1, out: [sg, 0, 0], map: map(0.12) });
  }
  add('deckWhite', '#e8e6df', white, 'mark');
  add('deckYellow', '#d9b42a', yellow, 'mark');
  add('deckRed', '#b8322b', red, 'mark');
  add('deckDark', '#24262a', marks.dark, 'mark');
  add('deckSteel', '#8d9196', marks.steel, 'mark');

  // ── the island ──────────────────────────────────────────────────────────
  const isl = d.island;
  const island = new MeshBuilder(), glass = new MeshBuilder(), white2 = new MeshBuilder();
  block(island, H, chamfered(isl.s0, isl.s1, isl.t0, isl.t1, 2.5), 0, 10.6);
  block(island, H, chamfered(isl.s0 + 2, isl.s1 - 3, isl.t0 + 0.6, isl.t1 - 0.6, 2), 10.6, 14.0);
  block(island, H, chamfered(isl.s0 + 5, isl.s1 - 1.5, isl.t0, isl.t1 - 0.4, 2.2), 14.0, 17.0);     // navigation bridge
  block(island, H, chamfered(isl.s0 + 2, isl.s0 + 27, isl.t0 - 0.8, isl.t1 - 1.5, 1.2), 17.0, 20.2); // primary flight control
  block(island, H, chamfered(isl.s0 + 8, isl.s0 + 24, isl.t0 + 2, isl.t1 - 3, 0.8), 20.2, 22.6);
  // portholes along the main block's two long sides, doors at the deck
  for (const t of [isl.t0 - 0.04, isl.t1 + 0.04]) {
    for (const h of [2.6, 5.4, 8.2]) {
      for (let s = isl.s0 + 2; s < isl.s1 - 3; s += 3.2) sbox(glass, H, s, s + 0.8, t - 0.03, t + 0.03, h, h + 0.6);
    }
    for (const s of [isl.s0 + 4, isl.s0 + 19]) sbox(dark, H, s, s + 1.2, t - 0.03, t + 0.03, 0, 2.1);
  }
  // the bridge's glass round its forward and port faces, leaning out; pri-fly's round its aft and port faces
  const band = (a, b, h0, h1, lean, outward) => {
    const o = outward;
    const q = [P(a[0], a[1], H + h0), P(b[0], b[1], H + h0), P(b[0] + o[0] * lean, b[1] + o[1] * lean, H + h1), P(a[0] + o[0] * lean, a[1] + o[1] * lean, H + h1)];
    glass.quadOut(q[0], q[1], q[2], q[3], P((a[0] + b[0]) / 2 - o[0] * 3, (a[1] + b[1]) / 2 - o[1] * 3, H + (h0 + h1) / 2));
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let x = 1.4; x < l - 0.5; x += 1.4) {
      const f = x / l, m = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      const e = [((b[0] - a[0]) / l) * 0.06, ((b[1] - a[1]) / l) * 0.06];
      dark.quadOut(P(m[0] - e[0] + o[0] * 0.03, m[1] - e[1] + o[1] * 0.03, H + h0), P(m[0] + e[0] + o[0] * 0.03, m[1] + e[1] + o[1] * 0.03, H + h0),
        P(m[0] + e[0] + o[0] * (lean + 0.03), m[1] + e[1] + o[1] * (lean + 0.03), H + h1), P(m[0] - e[0] + o[0] * (lean + 0.03), m[1] - e[1] + o[1] * (lean + 0.03), H + h1),
        P(m[0] - o[0] * 3, m[1] - o[1] * 3, H + (h0 + h1) / 2));
    }
  };
  const bs1 = isl.s1 - 1.5;
  band([bs1, isl.t0 + 2.2], [bs1, isl.t1 - 2.6], 14.7, 16.6, 0.35, [1, 0]);
  band([isl.s0 + 5, isl.t0 - 0.02], [bs1 - 2.2, isl.t0 - 0.02], 14.7, 16.6, 0.35, [0, -1]);
  const ps0 = isl.s0 + 2, ps1 = isl.s0 + 27, pt0 = isl.t0 - 0.8;
  band([ps0, pt0 - 0.02], [ps1 - 1.2, pt0 - 0.02], 17.8, 19.9, 0.45, [0, -1]);
  band([ps0 - 0.02, pt0 + 0.5], [ps0 - 0.02, isl.t1 - 2], 17.8, 19.9, 0.45, [-1, 0]);
  // the hull number on both sides of the island
  for (const sg of [-1, 1]) {
    const t = sg < 0 ? isl.t0 - 0.06 : isl.t1 + 0.06;
    const map = (off, dx = 0, dy = 0) => (x, y) => P(isl.s0 + 31 + sg * (x + dx), t + sg * off, H + 10.9 + y + dy);
    // above the portholes, on the second level's face (set in 0.6 m)
    const mapIn = (off, dx, dy) => { const f = map(off, dx, dy); return (x, y) => { const p = f(x, y); p[0] -= sg * 0.6; return p; }; };
    lettering(dark, num, { height: 2.8, stroke: 0.11, out: [sg, 0, 0], map: mapIn(0.03, 0.08, -0.08) });
    lettering(white2, num, { height: 2.8, stroke: 0.11, out: [sg, 0, 0], map: mapIn(0.06) });
  }
  // the mast: a tapering pole on legs, platforms, yards; the radars and the radomes
  const ms = isl.s0 + 17, mt = (isl.t0 + isl.t1) / 2;
  const mast = new MeshBuilder();
  mast.loft([[22.6, 1.0], [34, 0.55], [45, 0.25]].map(([h, r]) => [[-r, -r], [r, -r], [r, r], [-r, r]].map(([a, b]) => P(ms + a, mt + b, H + h))));
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const foot = P(ms + a * 4, mt + b * 2.4, H + 22.6), top = P(ms + a * 0.5, mt + b * 0.5, H + 31);
    const dx = 0.12;
    mast.quad([foot[0] - dx, foot[1], foot[2]], [foot[0] + dx, foot[1], foot[2]], [top[0] + dx, top[1], top[2]], [top[0] - dx, top[1], top[2]]);
    mast.quad([foot[0], foot[1], foot[2] - dx], [foot[0], foot[1], foot[2] + dx], [top[0], top[1], top[2] + dx], [top[0], top[1], top[2] - dx]);
  }
  sbox(mast, H, ms - 2, ms + 3.5, mt - 2, mt + 2, 31, 31.25);                 // the SPS-49's platform
  sbox(mast, H, ms - 1.4, ms + 1.4, mt - 1.4, mt + 1.4, 38.5, 38.7);
  sbox(mast, H, ms - 0.2, ms + 0.2, mt - 6.5, mt + 6.5, 36.6, 36.85);          // yards
  sbox(mast, H, ms - 0.15, ms + 0.15, mt - 4, mt + 4, 41.5, 41.7);
  for (const y of [-6, -3.5, 3.5, 6]) sbox(mast, H, ms - 0.03, ms + 0.03, mt + y - 0.03, mt + y + 0.03, 36.85, 39.5);   // whips
  sbox(mast, H, ms - 0.04, ms + 0.04, mt - 0.04, mt + 0.04, 45, 49);
  // SPS-49: a long curved mesh, here a slim tilted frame on the forward platform
  slab(mast, [P(ms + 2.6, mt - 3.6, H + 31.6), P(ms + 2.6, mt + 3.6, H + 31.6), P(ms + 3.2, mt + 3.6, H + 35.6), P(ms + 3.2, mt - 3.6, H + 35.6)], 0.18);
  // SPS-48: the big square planar array on its pedestal aft of the mast, leaning back
  sbox(mast, H, isl.s0 + 9, isl.s0 + 11, mt - 1, mt + 1, 22.6, 24.4);
  slab(mast, [P(isl.s0 + 10.3, mt - 2.6, H + 24.4), P(isl.s0 + 10.3, mt + 2.6, H + 24.4), P(isl.s0 + 9.0, mt + 2.6, H + 29.4), P(isl.s0 + 9.0, mt - 2.6, H + 29.4)], 0.5);
  // radomes on the bridge's roof and on the top deck
  dome(white2, H, isl.s1 - 4, isl.t0 + 1.8, 17.0, 1.2);
  dome(white2, H, isl.s1 - 4, isl.t1 - 2.4, 17.0, 1.2);
  dome(white2, H, isl.s0 + 22, isl.t0 + 2.8, 22.6, 0.85);
  dome(white2, H, isl.s0 + 22, isl.t1 - 3.6, 22.6, 0.85);
  dome(white2, H, ms, mt, 31.25, 0.0001 + 0.7);
  // the obstruction light on the mast's top
  const lights = new MeshBuilder();
  sbox(lights, H, ms - 0.18, ms + 0.18, mt - 0.18, mt + 0.18, 49, 49.35);
  add('island', '#7b8188', island, 'paint');
  add('islandGlass', '#16202a', glass, 'glass');
  add('mast', '#5f646b', mast, 'paint');
  add('radomes', '#e4e4df', white2, 'paint');

  // ── the deck park: Hornets with their wings folded, tractors, the crash crane ──
  const jets = new MeshBuilder(), jetDark = new MeshBuilder(), yellowKit = new MeshBuilder();
  const DEG = Math.PI / 180;
  const park = [
    [250, 13.5, -55], [263, 12.5, -55], [276, 11.0, -55], [289, 8.5, -55],
    [293, -12.5, 62], [280, -14, 62],
    [161, 29, -92], [139, 17, -78],
    [214, 6.74, -1.7],                     // on catapult 2, the deflector up behind it
  ];
  for (const [s, t, yaw] of park) {
    const c = Math.cos(yaw * DEG), sn = Math.sin(yaw * DEG);
    buildHornet(jets, jetDark, ([x, y, z]) => P(s + x * c - y * sn, t + x * sn + y * c, H + 0.02 + z));
  }
  const tractor = (s, t, yaw) => {
    const c = Math.cos(yaw * DEG), sn = Math.sin(yaw * DEG);
    const at = (x, y) => [s + x * c - y * sn, t + x * sn + y * c];
    const boxAt = (mb, x0, x1, y0, y1, h0, h1) => {
      const q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => at(x, y));
      block(mb, H, q, h0, h1);
    };
    boxAt(yellowKit, -1.5, 1.5, -0.9, 0.9, 0.35, 1.0);
    boxAt(yellowKit, -1.5, -0.4, -0.9, 0.9, 1.0, 1.5);
    for (const x of [-1.0, 1.0]) for (const y of [-0.95, 0.75]) boxAt(jetDark, x - 0.35, x + 0.35, y, y + 0.2, 0, 0.7);
  };
  tractor(256, 4.5, 30);
  tractor(172, 11, -10);
  tractor(309, -6, 160);
  // the crash crane ("Tilly") parked aft of the island: its body and its boom
  {
    const s = 174, t = 18.5;
    block(yellowKit, H, [[s - 4, t - 1.6], [s + 3, t - 1.6], [s + 3, t + 1.6], [s - 4, t + 1.6]], 0.5, 3.0);
    block(yellowKit, H, [[s - 1, t - 1.2], [s + 1.5, t - 1.2], [s + 1.5, t + 1.2], [s - 1, t + 1.2]], 3.0, 4.6);
    slab(yellowKit, [P(s + 1, t - 0.3, H + 3.6), P(s + 1, t + 0.3, H + 3.6), P(s - 8, t + 0.3, H + 8.5), P(s - 8, t - 0.3, H + 8.5)], 0.6);
    for (const x of [-3, 2]) for (const y of [-1.75, 1.45]) sbox(jetDark, H, s + x - 0.6, s + x + 0.6, t + y, t + y + 0.3, 0, 1.2);
  }
  add('parkedJets', '#9aa0a6', jets, 'paint');
  add('parkedDark', '#1d2024', jetDark, 'dark');
  add('yellowGear', '#e0b324', yellowKit, 'paint');

  // ── lights: the drop lights down the stern on the landing line, the landing area's edge and centre lights ──
  const [ls, lt] = la.origin;
  for (let h = -1.4; h > -11; h -= 1.1) sbox(lights, H, ls - 0.12, ls + 0.02, lt - 0.18, lt + 0.18, h - 0.3, h);
  for (let x = 8; x < la.length - 8; x += 15) {
    for (const lat of [-la.halfWidth - 0.6, la.halfWidth + 0.6, 0.6]) {
      const [s, t] = L(x, lat);
      sbox(lights, H, s - 0.15, s + 0.15, t - 0.15, t + 0.15, 0.02, 0.09);
    }
  }
  add('lights', '#3a2a10', lights, 'emissive');

  // ── the Fresnel lens: its housing on the port sponson; lights drawn by the plugin ──
  const lens = new MeshBuilder();
  const box = (s0, s1, t0, t1, h0, h1, mb = lens) => mb.box([t0, H + h0, -s1], [t1, H + h1, -s0]);
  const ls2 = d.lens.s, lt2 = d.lens.t;
  box(ls2 - 1, ls2 + 1, lt2 - 0.6, lt2 + 0.6, 0, 1.2);
  box(ls2 - 0.4, ls2 + 0.4, lt2 - 2.2, lt2 + 2.2, 1.2, 4.4);
  box(ls2 - 0.3, ls2 + 0.3, lt2 - 6.5, lt2 - 2.2, 2.6, 3.0);
  box(ls2 - 0.3, ls2 + 0.3, lt2 + 2.2, lt2 + 6.5, 2.6, 3.0);
  // the landing signal officers' platform, port side aft, with its windscreen
  {
    const s0 = 62, s1 = 70, te = widthAt(d.deck, 66)[0];
    sbox(lens, H, s0, s1, te - 4, te + 0.2, -0.6, -0.3);
    slab(glass, [P(s1, te - 4, H - 0.3), P(s1, te, H - 0.3), P(s1 + 0.4, te, H + 1.3), P(s1 + 0.4, te - 4, H + 1.3)], 0.05);
  }
  add('lensHousing', '#2a2c30', lens, 'dark');
  add('hullDark', '#121416', dark, 'dark');
  add('equipment', '#6e747a', paint, 'paint');
  add('grating', '#2e3236', grating, 'grating');
  return parts;
}

/** Where the lens's lights are, ship frame: centre of the cell column, the datum bars, and the cell height. */
export function lensLights(carrier) {
  const d = carrier.data;
  return { s: d.lens.s - 0.45, t: d.lens.t, h: carrier.deckH + 2.8, cell: 0.32, datumHalf: [2.4, 6.3] };
}
