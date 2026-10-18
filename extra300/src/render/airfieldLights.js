// airfieldLights.js — Meigs' lights as geometry: the fixtures (small dark housings on stalks) and, for
// each colour, the lamps' lenses (small bright shapes the plugin draws strongly emissive, so the room's
// HDR bloom makes their glow — no painted flares). Render space, metres.
//
//   runway edge   white, every 200 ft, 10 ft outside both edges
//   threshold     green across each threshold (seen landing), red just beyond it (the far end's)
//   REIL          a pair of white strobes either side of each threshold (flashed by the plugin)
//   PAPI          four boxes left of each landing direction, 1,000 ft in: each shows white above its
//                 angle and red below (the plugin picks per frame from where the eye is): on a 3° path,
//                 two white outside, two red nearest the runway
//   taxiway       blue, along the parallel taxiway's edges and the connectors

import { fromNE, MeshBuilder } from './geometry.js';

const FT = 0.3048;
const DEG = Math.PI / 180;

/** A lamp's lens at p (render): an octahedron r across its middle (round enough at its size). */
export function glowQuads(mb, p, r) {
  const [x, y, z] = p;
  const v = [[x + r, y, z], [x - r, y, z], [x, y + r, z], [x, y - r, z], [x, y, z + r], [x, y, z - r]];
  const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  for (const [a, b, c] of faces) mb.tri(v[a], v[b], v[c]);
}

/**
 * @param {object} world  buildMeigs()
 * @returns {{ fixtures: MeshBuilder, glows: Object<string, MeshBuilder>, papis: object[], reils: number[][][] }}
 */
export function buildAirfieldLights(world) {
  const rw = world.runway;
  const L = rw.length, W = rw.width, thr = 6;
  const P = (al, ac, y) => {
    const n = rw.centre[0] + al * rw.dir[0] - ac * rw.dir[1];
    const e = rw.centre[1] + al * rw.dir[1] + ac * rw.dir[0];
    return fromNE(n, e, y);
  };
  const fixtures = new MeshBuilder();
  const glows = {};
  const glow = (color) => (glows[color] ??= new MeshBuilder());
  /** A light on a short stalk: the housing, and its glow at the lens. */
  const light = (al, ac, color, h = 0.36, r = 0.55) => {
    const p = P(al, ac, 0);
    fixtures.box([p[0] - 0.05, 0, p[2] - 0.05], [p[0] + 0.05, h - 0.08, p[2] + 0.05]);
    fixtures.box([p[0] - 0.1, h - 0.08, p[2] - 0.1], [p[0] + 0.1, h + 0.04, p[2] + 0.1]);
    glowQuads(glow(color), [p[0], h, p[2]], r * 0.22);
  };

  // runway edge lights, both sides, 200 ft apart from threshold to threshold
  const span = L - 2 * thr, nEdge = Math.round(span / (200 * FT));
  for (let k = 0; k <= nEdge; k++) {
    const al = -L / 2 + thr + (span * k) / nEdge;
    for (const side of [-1, 1]) light(al, side * (W / 2 + 10 * FT), 'white');
  }
  // threshold (green) and runway end (red) rows at both ends
  for (const end of [-1, 1]) {
    const at = end * (L / 2 - thr);
    for (const ac of [-W / 2 - 3, -W / 2 + 2, -W / 2 + 7, -W / 2 + 12, W / 2 - 12, W / 2 - 7, W / 2 - 2, W / 2 + 3]) {
      light(at + end * 0.8, ac, 'green', 0.3, 0.7);
      light(at + end * 2.4, ac, 'red', 0.3, 0.6);
    }
  }
  // taxiway edge lights: the parallel taxiway's two edges, the connectors' sides
  for (let al = -L / 2 + 50; al <= L / 2 - 50; al += 30) {
    for (const ac of [-W / 2 - 60 - 1.5, -W / 2 - 75 + 1.5]) {
      // not across a connector's mouth
      if ([-L / 2 + 50, -60, L / 2 - 50].some((c) => Math.abs(al - c) < 11) && ac > -W / 2 - 62) continue;
      light(al, ac, 'blue', 0.3, 0.35);
    }
  }
  for (const c of [-L / 2 + 50, -60, L / 2 - 50]) {
    for (const ac of [-W / 2 - 50, -W / 2 - 35, -W / 2 - 20]) for (const s of [-1, 1]) light(c + s * 10.5, ac, 'blue', 0.3, 0.35);
  }

  // REIL strobes and PAPIs: positions for the plugin, their housings here
  const reils = [];
  const papis = [];
  for (const end of [-1, 1]) {
    const at = end * (L / 2 - thr - 1);
    const pair = [-1, 1].map((s) => {
      const p = P(at, s * (W / 2 + 12), 0);
      fixtures.box([p[0] - 0.3, 0, p[2] - 0.3], [p[0] + 0.3, 0.5, p[2] + 0.3]);
      return [p[0], 0.6, p[2]];
    });
    reils.push(pair);
    // PAPI left of the landing direction: runway 36 lands north (end −1), its left is the west side
    const landing = -end;                               // +1 lands toward +along (36)
    const left = -landing;                              // across sign of the pilot's left
    const al = -landing * (L / 2 - thr) + landing * 1000 * FT;
    const units = [0, 1, 2, 3].map((k) => {
      const p = P(al, left * (W / 2 + 15 + k * 9), 0);
      fixtures.box([p[0] - 0.6, 0, p[2] - 0.6], [p[0] + 0.6, 0.85, p[2] + 0.6]);
      // the transition angles from the runway outward: 3.5, 3.17, 2.83, 2.5° for a 3° path
      return { pos: [p[0], 0.95, p[2]], transition: [3.5, 3.17, 2.83, 2.5][k] * DEG };
    });
    // the line the angles are measured along: toward the threshold the airplane comes from
    const back = P(al - landing * 100, 0, 0), here = P(al, 0, 0);
    const dir = [back[0] - here[0], back[2] - here[2]];
    const dl = Math.hypot(dir[0], dir[1]);
    papis.push({ units, dir: [dir[0] / dl, dir[1] / dl] });
  }
  return { fixtures, glows, papis, reils };
}
