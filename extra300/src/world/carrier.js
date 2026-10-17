// carrier.js — a Nimitz-class aircraft carrier at anchor in Lake Michigan off
// Meigs Field: the flight deck as a surface the gear can roll on, the hull as
// something to hit, the angled landing deck with its four arresting wires,
// and the glide slope the Fresnel lens shows.
//
// Ship frame: s metres forward from the stern ramp along the ship's heading,
// t metres to starboard. The angled deck runs 9° to port of the ship's
// heading; the ship is anchored so that it points into the approach from the
// south: the angled deck lies exactly along 360° true, like runway 36.
//
// [pub] USS Nimitz (CVN-68): 332.8 m long, flight deck 76.8 m wide, 40.8 m beam
// at the waterline, 11.3 m draft, angled deck 9°, four arresting wires (on the
// older ships; three on the newest) about 12 m apart, 3.5° glide slope.
// [est] the deck outline, the wires' positions and the island, from the
// published top view.

import { pointInPolygon } from './geo.js';

const DEG = Math.PI / 180;

export const NIMITZ = {
  name: 'USS Nimitz (CVN-68)',
  hull: 'CVN-68',
  length: 332.8,              // [pub]
  beam: 40.8,                 // [pub] at the waterline
  draft: 11.3,                // [pub]
  deckHeight: 18.5,           // [est] flight deck above the waterline
  // flight deck outline, ship frame (s, t), from the stern's port corner forward along the port side,
  // round the bow and back along the starboard side [est]
  deck: [[0, -17], [12, -25], [80, -33], [160, -39], [212, -43], [236, -40], [252, -27], [290, -19], [318, -10],
    [332, -3], [332, 3], [318, 11], [285, 18], [240, 23], [100, 24], [40, 23], [10, 21], [0, 20]],
  // the waterline, narrower, for the hull's sides
  waterline: [[6, -14], [60, -20.4], [250, -20.4], [300, -14], [326, -2], [326, 2], [300, 14], [250, 20.4], [60, 20.4], [6, 14]],
  angle: 9 * DEG,             // [pub] the angled deck, to port
  landing: {
    origin: [0, 4],           // where its centre line crosses the stern [est]
    length: 236,              // to the end of the angled deck
    halfWidth: 14,            // the landing area's painted edges
  },
  // arresting wires: distance from the stern along the landing centre line [est], their half-span
  wires: [55, 67, 79, 91],
  wireHalfSpan: 15,
  targetWire: 3,              // the hook touches down between 2 and 3 and catches the 3-wire
  glideSlope: 3.5 * DEG,      // [pub]
  lens: { s: 140, t: -40.5 }, // the Fresnel lens (IFLOLS) on the port sponson, abeam the landing area [est]
  island: { s0: 178, s1: 220, t0: 15, t1: 26, height: 21 },   // [est] above the flight deck
  // where it lies: its stern this far north and east of the runway's centre [est: open water east of Northerly Island]
  sternNE: [-1350, 3400],
};

/**
 * The carrier in the local frame (metres, n/e from the runway's centre, heights above the runway).
 * @param {{ water: number }} world  buildMeigs(): the lake's level relative to the runway
 */
export function buildCarrier(world, data = NIMITZ) {
  // the angled deck along 360°: the ship itself points 9° to the right of it
  const heading = data.angle;
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const [n0, e0] = data.sternNE;
  const toNE = (s, t) => [n0 + s * ch - t * sh, e0 + s * sh + t * ch];
  const toShip = (n, e) => {
    const dn = n - n0, de = e - e0;
    return [dn * ch + de * sh, -dn * sh + de * ch];
  };
  const deckH = world.water + data.deckHeight;

  // the landing area: centre line from the stern, 9° to port of the ship's heading
  const la = data.landing;
  const lAngle = heading - data.angle;                       // its true bearing
  const axis = [Math.cos(lAngle), Math.sin(lAngle)];        // (n, e) along the landing direction
  const across = [-axis[1], axis[0]];                         // to its right
  const landingNE = toNE(la.origin[0], la.origin[1]);
  const along = (n, e) => (n - landingNE[0]) * axis[0] + (e - landingNE[1]) * axis[1];
  const lateral = (n, e) => (n - landingNE[0]) * across[0] + (e - landingNE[1]) * across[1];
  const onLanding = (d, l = 0) => [landingNE[0] + axis[0] * d + across[0] * l, landingNE[1] + axis[1] * d + across[1] * l];

  const wires = data.wires.map((d, i) => ({
    index: i + 1, along: d, centre: onLanding(d),
    ends: [onLanding(d, -data.wireHalfSpan), onLanding(d, data.wireHalfSpan)],
  }));
  // the hook's aim point: between the 2- and 3-wire, where the glide slope meets the deck
  const aimAlong = 0.5 * (data.wires[data.targetWire - 2] + data.wires[data.targetWire - 1]);

  const inDeck = (s, t) => s >= 0 && s <= data.length && pointInPolygon(s, t, data.deck);
  const UP = [0, 0, -1];

  return {
    data, heading, deckH, toNE, toShip, axis, across, landingNE, along, lateral, onLanding, wires, aimAlong,
    bearing: lAngle,
    /** The flight deck under (n, e), or null. A point well below it (d, NED down) is beside the hull, not on it. */
    deckAt(n, e, d = null) {
      const [s, t] = toShip(n, e);
      if (!inDeck(s, t)) return null;
      if (d != null && -d < deckH - 4) return null;
      return { h: deckH, normal: UP, surface: 'deck' };
    },
    /** Is the point (height h above the datum) inside the ship: below the flight deck, above the water? */
    hullContains(n, e, h) {
      if (h >= deckH - 0.5 || h < world.water - data.draft) return false;
      const [s, t] = toShip(n, e);
      // the island stands on the deck
      return inDeck(s, t);
    },
    /** Is the point inside the island's superstructure? */
    islandContains(n, e, h) {
      const [s, t] = toShip(n, e);
      const i = data.island;
      return s > i.s0 && s < i.s1 && t > i.t0 && t < i.t1 && h > deckH - 0.5 && h < deckH + i.height;
    },
    /**
     * Where an airplane on the glide slope should be: its hook's height above the deck at a distance
     * `dist` (m, along the landing line, behind the aim point) — and how far (deg) a point is off it.
     */
    glidePathHeight(dist) { return Math.tan(data.glideSlope) * dist; },
    glideDeviation(n, e, h) {
      const dist = aimAlong - along(n, e);
      return Math.atan2(h - deckH, Math.max(dist, 1)) / DEG - data.glideSlope / DEG;
    },
    /** A start on final: `dist` m behind the aim point on the glide slope, lined up; h above the datum. */
    approachStart(dist = 3000) {
      const [n, e] = onLanding(aimAlong - dist);
      return { n, e, heading: lAngle, h: deckH + Math.tan(data.glideSlope) * dist };
    },
  };
}
