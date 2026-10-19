// icaoRunway.js — a runway with ICAO markings (Annex 14), laid out from a description of the real
// one (world/innsbruck.js LOWI_LAYOUT, measured on the orthophoto): the pavement with its shoulders
// and the areas before and past the thresholds, the white markings, the yellow taxi lines that
// lead onto it. Pure geometry in render space (x east, y up, z south), metres from the datum;
// runway-local coordinates (along from the runway's centre, across to the right of the low end's
// landing direction), as scenery.js uses them.

import { RUNWAY_PAVE_H } from '../world/airport.js';
import { MeshBuilder } from './geometry.js';
import { numerals, runwayUvs, rwQuad, strokeOn } from './scenery.js';

const Y_PAVE = RUNWAY_PAVE_H, Y_PAINT = RUNWAY_PAVE_H + 0.02;   // over the ground, clear of Google's flattened tiles

/** A quadratic Bézier from a to c through control b, as a polyline. */
function bezier(a, b, c, n = 16) {
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = k / n, s = 1 - t;
    return [s * s * a[0] + 2 * s * t * b[0] + t * t * c[0], s * s * a[1] + 2 * s * t * b[1] + t * t * c[1]];
  });
}

/** An arc round (ca, cc), radius r, from angle t0 to t1 (radians; 0 = along +, π/2 = across +). */
function arc(ca, cc, r, t0, t1, n = 24) {
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = t0 + ((t1 - t0) * k) / n;
    return [ca + r * Math.cos(t), cc + r * Math.sin(t)];
  });
}

/**
 * @param {{ centre: number[], dir: number[], length: number, width: number, ident: string[] }} rw
 *        the runway between its thresholds (length: threshold to threshold)
 * @param {object} L  the layout (see world/innsbruck.js LOWI_LAYOUT); distances from each threshold
 * @returns {{ asphalt: MeshBuilder, paint: MeshBuilder, yel: MeshBuilder, areas: object[], u: number[], v: number[] }}
 */
export function buildIcaoRunway(rw, L) {
  const asphalt = new MeshBuilder(), paint = new MeshBuilder(), yel = new MeshBuilder();
  const H = rw.length / 2, W = rw.width / 2, P = W + L.shoulder;
  // along-runway position, t metres in from the threshold at end -1 (the low one) or +1
  const at = (end, t) => end * (H - t);
  const span = (end, t0, t1) => [Math.min(at(end, t0), at(end, t1)), Math.max(at(end, t0), at(end, t1))];
  const v = [-H - L.before[0], H + L.before[1]];
  rwQuad(asphalt, rw, v[0], v[1], -P, P, Y_PAVE);
  const q = (end, t0, t1, c0, c1) => { const [a0, a1] = span(end, t0, t1); rwQuad(paint, rw, a0, a1, c0, c1, Y_PAINT); };

  for (const [i, end] of [-1, 1].entries()) {
    // threshold bar right across, and the piano keys: 12 stripes, 1.8 m wide on a 3.65 m pitch
    q(end, -L.bar, 0, -W + L.edge, W - L.edge);
    for (let k = 0; k < L.piano.n; k++) {
      const c0 = L.piano.first + k * L.piano.pitch, c1 = c0 + L.piano.width;
      for (const side of [-1, 1]) q(end, L.piano.at, L.piano.at + L.piano.length, Math.min(side * c0, side * c1), Math.max(side * c0, side * c1));
    }
    // the designator, read from the approach: ICAO's 9 m numerals, the FAA's 60 ft
    numerals(paint, rw, rw.ident[i], at(end, L.numerals), -end, Y_PAINT, (L.numeralHeight || 9) / (60 * 0.3048));
    // aiming point and touchdown zone bars, one either side
    for (const side of [-1, 1]) {
      q(end, L.aiming.at, L.aiming.at + L.aiming.length, ...(side > 0 ? [L.aiming.c[0], L.aiming.c[1]] : [-L.aiming.c[1], -L.aiming.c[0]]));
      for (const t of L.tdz?.at || []) q(end, t, t + L.tdz.length, ...(side > 0 ? [L.tdz.c[0], L.tdz.c[1]] : [-L.tdz.c[1], -L.tdz.c[0]]));
    }
  }
  // centre line: 30 m stripes, 20 m gaps, 0.9 m wide, between the designators
  const c0 = -H + L.centre.from, c1 = H - L.centre.from;
  const n = Math.floor((c1 - c0 + L.centre.gap) / (L.centre.stripe + L.centre.gap));
  const off = (c1 - c0 - (n * L.centre.stripe + (n - 1) * L.centre.gap)) / 2;
  for (let k = 0; k < n; k++) {
    const a = c0 + off + k * (L.centre.stripe + L.centre.gap);
    rwQuad(paint, rw, a, a + L.centre.stripe, -L.centre.width / 2, L.centre.width / 2, Y_PAINT);
  }
  // edge lines, broken where taxiways join (where it has them)
  for (const side of L.edgeLines === false ? [] : [-1, 1]) {
    const gaps = (side > 0 ? L.edgeGaps.right : L.edgeGaps.left).map(([a, b]) => [a - H, b - H]).sort((x, y) => x[0] - y[0]);
    let a = -H - L.edgeFrom[0];
    for (const [g0, g1] of [...gaps, [H + L.edgeFrom[1], Infinity]]) {
      if (g0 > a) rwQuad(paint, rw, a, g0, side > 0 ? W - L.edge : -W, side > 0 ? W : -W + L.edge, Y_PAINT);
      a = g1;
    }
  }
  // what's painted before a threshold (a displaced one's stretch): a bar across, arrows down the
  // middle toward the threshold, arrowheads across just short of it
  for (const m of L.preThreshold) {
    if (m.bar != null) q(m.end, m.bar - L.bar / 1.5, m.bar, -W + L.edge, W - L.edge);
    const aw = m.arrowWidth || 0.6, head = m.head || [6, 2.2];
    for (const [a0, a1] of m.arrows || [m.arrow]) {
      strokeOn(paint, rw, [[at(m.end, a0), 0], [at(m.end, a1), 0]], aw, Y_PAINT);
      const tip = at(m.end, a1 - 1), back = at(m.end, a1 - 1 - head[0]);
      for (const side of [-1, 1]) strokeOn(paint, rw, [[tip, 0], [back, side * head[1]]], aw, Y_PAINT);
    }
    if (m.chevrons) {
      const { at: t, c, length = 13.7, width = 1, spread = 3 } = m.chevrons;
      for (const cc of c) for (const side of [-1, 1]) strokeOn(paint, rw, [[at(m.end, t), cc], [at(m.end, t - length), cc + side * spread]], width, Y_PAINT);
    }
  }
  // yellow taxi lines (0.15 m): lead-ins from the taxiways and the turn pads' loops, given in metres
  // from the low end's threshold, clipped to the pavement we draw
  const inside = ([a, c]) => Math.abs(c) <= P - 0.3 && a >= v[0] + H + 0.3 && a <= v[1] + H - 0.3;
  const yellow = (pts) => {
    let run = [];
    for (const p of pts) {
      if (inside(p)) run.push([p[0] - H, p[1]]);
      else { if (run.length > 1) strokeOn(yel, rw, run, 0.15, Y_PAINT + 0.002); run = []; }
    }
    if (run.length > 1) strokeOn(yel, rw, run, 0.15, Y_PAINT + 0.002);
  };
  for (const y of L.yellow) {
    if (y.bezier) yellow(bezier(...y.bezier));
    if (y.line) yellow(y.line);
    if (y.arc) yellow(arc(...y.arc));
  }
  for (const mb of [asphalt, paint, yel]) runwayUvs(mb, rw);
  return { asphalt, paint, yel, areas: [{ kind: 'runway', u: [-P, P], v }], u: [-P - 1, P + 1], v: [v[0] - 1, v[1] + 1] };
}
