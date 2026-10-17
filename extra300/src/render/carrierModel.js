// carrierModel.js — the carrier as meshes, from world/carrier.js's numbers:
// the hull from the flight deck's outline down to the waterline, the deck,
// its markings (the angled landing area's edges and centre line, the
// catapult tracks, the elevators, the hull number), the island with its
// mast, and the Fresnel lens on the port sponson. Pure geometry: the plugin
// draws it (plugin/carrierVisual.js), the arresting wires and the lens's
// ball move there.
//
// Ship-local render space: x to starboard (t), y up (height above the
// runway, as everything else), z aft (−s); the plugin turns it to the ship's
// heading and puts its origin on the stern.

import earcut from 'earcut';
import { MeshBuilder } from './geometry.js';

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

/** A flat strip painted on the deck from (s0, t0) to (s1, t1), `w` wide. */
function stripe(mb, a, b, w, h) {
  const ds = b[0] - a[0], dt = b[1] - a[1];
  const l = Math.hypot(ds, dt) || 1;
  const ns = (-dt / l) * w / 2, nt = (ds / l) * w / 2;
  mb.quad(P(a[0] - ns, a[1] - nt, h), P(a[0] + ns, a[1] + nt, h), P(b[0] + ns, b[1] + nt, h), P(b[0] - ns, b[1] - nt, h));
}

/** Seven-segment digits, painted big on the bow: the hull number. */
const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function digit(mb, ch, s0, t0, size, h) {
  // a digit read from aft (an airplane on final sees it the right way up): its top toward the bow
  const W = size * 0.55, H = size, w = size * 0.13;
  const seg = {
    a: [[H, 0], [H, W]], b: [[H, W], [H / 2, W]], c: [[H / 2, W], [0, W]], d: [[0, 0], [0, W]],
    e: [[H / 2, 0], [0, 0]], f: [[H, 0], [H / 2, 0]], g: [[H / 2, 0], [H / 2, W]],
  };
  for (const k of SEG[ch] || '') {
    const [[sa, ta], [sb, tb]] = seg[k];
    stripe(mb, [s0 + sa, t0 + ta], [s0 + sb, t0 + tb], w, h);
  }
}

/**
 * @param {object} carrier  world/carrier.js buildCarrier()
 * @param {number} water    the lake's level (m above the runway)
 * @returns {{ name: string, color: string, mesh: MeshBuilder, emissive?: string, deck?: boolean }[]}
 */
export function buildCarrierModel(carrier, water) {
  const d = carrier.data;
  const H = carrier.deckH;
  const knuckle = H - 7.5;              // where the flared sides meet the straight hull below
  const parts = [];

  // ── hull: the deck's outline flaring down to the waterline's ─────────────
  const hull = new MeshBuilder();
  const step = 4;
  const stations = [];
  for (let s = 0.01; s < d.length; s += step) stations.push(s);
  stations.push(d.length - 0.01);
  const sections = stations.map((s) => {
    const dk = widthAt(d.deck, s) || [0, 0];
    const wl = widthAt(d.waterline, s) || [Math.max(dk[0], -2) * 0.4, Math.min(dk[1], 2) * 0.4];
    // the bow: the waterline ends short of the flight deck, the stem rakes forward up to it
    return { s, dk, wl };
  });
  const inside = (s) => P(s, 0, H - 9);
  for (let i = 0; i < sections.length - 1; i++) {
    const A = sections[i], B = sections[i + 1];
    for (const side of [0, 1]) {
      const ring = (X) => [P(X.s, X.dk[side], H), P(X.s, X.wl[side], knuckle), P(X.s, X.wl[side], water - 2)];
      const ra = ring(A), rb = ring(B);
      const mid = inside((A.s + B.s) / 2);
      hull.quadOut(ra[0], rb[0], rb[1], ra[1], mid);
      hull.quadOut(ra[1], rb[1], rb[2], ra[2], mid);
    }
    // the sponsons' undersides, where the deck overhangs the flare
    const ua = sections[i], ub = sections[i + 1];
    for (const side of [0, 1]) {
      hull.quadOut(P(ua.s, ua.dk[side], H - 1.2), P(ub.s, ub.dk[side], H - 1.2), P(ub.s, ub.wl[side], H - 1.2), P(ua.s, ua.wl[side], H - 1.2), P((ua.s + ub.s) / 2, 0, H + 5));
    }
  }
  // the transom across the stern, and the deck edge's lip all round
  const st0 = sections[0];
  hull.quadOut(P(0, st0.dk[0], H), P(0, st0.dk[1], H), P(0, st0.wl[1], knuckle), P(0, st0.wl[0], knuckle), P(20, 0, H - 4));
  hull.quadOut(P(0, st0.wl[0], knuckle), P(0, st0.wl[1], knuckle), P(0, st0.wl[1], water - 2), P(0, st0.wl[0], water - 2), P(20, 0, H - 4));
  parts.push({ name: 'hull', color: '#737980', mesh: hull });

  // ── the flight deck ─────────────────────────────────────────────────────
  const deck = new MeshBuilder();
  const flat = d.deck.flatMap(([s, t]) => [s, t]);
  const tri = earcut(flat);
  for (let i = 0; i < tri.length; i += 3) {
    const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]].map((k) => P(d.deck[k][0], d.deck[k][1], H + 0.02));
    // facing up
    const n = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
    if (n < 0) deck.tri(a, b, c); else deck.tri(a, c, b);
  }
  parts.push({ name: 'deck', color: '#3c3f43', mesh: deck, deck: true });

  // ── markings ────────────────────────────────────────────────────────────
  const white = new MeshBuilder(), yellow = new MeshBuilder(), red = new MeshBuilder(), dark = new MeshBuilder();
  const hm = H + 0.06;
  const L = (dist, lat) => {
    // a point on the landing area, in ship (s, t)
    const [n, e] = carrier.onLanding(dist, lat);
    return carrier.toShip(n, e);
  };
  const la = d.landing;
  // the landing area's edges, and its centre line dashed
  for (const side of [-1, 1]) stripe(white, L(2, side * la.halfWidth), L(la.length - 6, side * la.halfWidth), 0.45, hm);
  for (let x = 4; x < la.length - 10; x += 9) stripe(white, L(x, 0), L(x + 4.5, 0), 0.5, hm);
  // the stern's ramp stripes and the drop lines down the stern's edge
  for (let k = -6; k <= 6; k++) stripe(white, L(0.8, k * 2.0), L(5, k * 2.0), 0.5, hm);
  // the foul lines: red/white along the landing area's starboard side, where parked airplanes must stay clear
  for (let x = 10; x < 190; x += 6) stripe(red, L(x, la.halfWidth + 5), L(x + 3, la.halfWidth + 5), 0.3, hm);
  // the arresting wires' pendants rest on bow springs; their positions are painted as short bars at the edges
  for (const w of carrier.wires) for (const side of [-1, 1]) stripe(yellow, L(w.along, side * (d.wireHalfSpan + 0.3)), L(w.along, side * (d.wireHalfSpan + 2)), 0.6, hm);
  // the bow catapults' tracks, and the waist catapults on the angled deck
  for (const t of [-8, 7]) stripe(dark, [205, t], [326, t * 0.5], 0.35, hm);
  stripe(dark, L(118, -7), L(190, -7), 0.35, hm);
  stripe(dark, L(112, 7), L(184, 7), 0.35, hm);
  // yellow taxi lines to the elevators
  stripe(yellow, [60, 4], [150, 14], 0.3, hm);
  stripe(yellow, [230, 2], [270, 14], 0.3, hm);
  // the elevators' outlines on the starboard edge and the port one aft
  for (const [s0, s1, t0, t1] of [[150, 170, 12, 24], [228, 248, 14, 23], [40, 60, 12, 23]]) {
    stripe(dark, [s0, t0], [s1, t0], 0.25, hm); stripe(dark, [s1, t0], [s1, t1], 0.25, hm); stripe(dark, [s0, t0], [s0, t1], 0.25, hm);
  }
  // the hull number on the bow
  const num = d.hull.replace(/\D/g, '');
  num.split('').forEach((ch, i) => digit(white, ch, 268, -9 + i * 9, 14, hm));
  parts.push({ name: 'deckWhite', color: '#e8e6df', mesh: white });
  parts.push({ name: 'deckYellow', color: '#d9b42a', mesh: yellow });
  parts.push({ name: 'deckRed', color: '#b8322b', mesh: red });
  parts.push({ name: 'deckDark', color: '#24262a', mesh: dark });

  // ── the island: bridge block, the upper decks stepping in, mast, radars ──
  const isl = d.island;
  const island = new MeshBuilder(), glass = new MeshBuilder(), mast = new MeshBuilder();
  // (box takes min/max in render space: x = t, y = h, z = −s)
  const box = (s0, s1, t0, t1, h0, h1, mb = island) => mb.box([t0, H + h0, -s1], [t1, H + h1, -s0]);
  box(isl.s0, isl.s1, isl.t0, isl.t1, 0, 12);
  box(isl.s0 + 3, isl.s1 - 2, isl.t0 + 1, isl.t1 - 1, 12, 17);
  box(isl.s0 + 8, isl.s1 - 6, isl.t0 + 2, isl.t1 - 2, 17, isl.height);
  // bridge windows: dark bands round the two upper levels
  box(isl.s0 + 2.9, isl.s1 - 1.9, isl.t0 + 0.9, isl.t1 - 0.9, 14.6, 15.8, glass);
  box(isl.s0 + 7.9, isl.s1 - 5.9, isl.t0 + 1.9, isl.t1 - 1.9, 19.0, 20.2, glass);
  // the mast with its yards and the radar arrays
  const ms = (isl.s0 + isl.s1) / 2 + 2, mt = (isl.t0 + isl.t1) / 2;
  box(ms - 0.8, ms + 0.8, mt - 0.8, mt + 0.8, isl.height, isl.height + 16, mast);
  box(ms - 0.4, ms + 0.4, mt - 6, mt + 6, isl.height + 10, isl.height + 10.6, mast);
  box(ms - 0.3, ms + 0.3, mt - 4, mt + 4, isl.height + 14, isl.height + 14.5, mast);
  box(ms - 5, ms - 4.2, mt - 2.5, mt + 2.5, isl.height + 4, isl.height + 8, mast);      // a search radar's antenna
  box(isl.s0 + 1, isl.s0 + 1.6, mt - 2, mt + 2, 9, 12, mast);
  parts.push({ name: 'island', color: '#7c828a', mesh: island });
  parts.push({ name: 'islandGlass', color: '#1b2026', mesh: glass });
  parts.push({ name: 'mast', color: '#5d6269', mesh: mast });

  // ── the Fresnel lens: its housing on the port sponson; lights drawn by the plugin ──
  const lens = new MeshBuilder();
  const ls = d.lens.s, lt = d.lens.t;
  box(ls - 1, ls + 1, lt - 0.6, lt + 0.6, 0, 1.2, lens);
  box(ls - 0.4, ls + 0.4, lt - 2.2, lt + 2.2, 1.2, 4.4, lens);        // the lens box with its datum arms
  box(ls - 0.3, ls + 0.3, lt - 6.5, lt - 2.2, 2.6, 3.0, lens);
  box(ls - 0.3, ls + 0.3, lt + 2.2, lt + 6.5, 2.6, 3.0, lens);
  parts.push({ name: 'lensHousing', color: '#2a2c30', mesh: lens });
  return parts;
}

/** Where the lens's lights are, ship frame: centre of the cell column, the datum bars, and the cell height. */
export function lensLights(carrier) {
  const d = carrier.data;
  return { s: d.lens.s - 0.45, t: d.lens.t, h: carrier.deckH + 2.8, cell: 0.32, datumHalf: [2.4, 6.3] };
}
