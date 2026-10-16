// meigs.js — Merrill C. Meigs Field (CGX), Chicago, as it was before the
// night of 30 March 2003: one runway down the spine of Northerly Island,
// Lake Michigan on three sides, the Loop skyline a mile and a half north.
// It was the default airport of Microsoft Flight Simulator from 1.0 (1982)
// through FS2002 — "Runway 36, Meigs Field" was where every flight began.
//
// Coordinates are WGS-84 and approximate (marked [verify] where they need a
// survey source); the plan is to check them against the Google 3D Tiles of
// today's Northerly Island, whose shoreline still follows the old fill.

import { LocalFrame, pointInPolygon } from './geo.js';

const FT = 0.3048;

export const MEIGS = {
  icao: 'KCGX',
  name: 'Merrill C. Meigs Field',
  arp: [41.8586, -87.6083],          // [verify] aerodrome reference point
  elevationFt: 593,                  // field elevation
  lakeLevelFt: 578,                  // Lake Michigan long-term mean
  magVar: -2.0,                      // degrees, west negative (late 1990s)
  runway: {
    ident: ['36', '18'],
    lengthFt: 3948,                  // [verify] some sources 3,899 ft after the 1990s re-marking
    widthFt: 150,
    trueBearing: 0.0,                // [verify] the island runs very nearly true north
    centre: [41.8586, -87.6083],     // [verify]
    surface: 'asphalt',
  },
  // Northerly Island (landfill, 1920s-30s) and the Solidarity Drive causeway [verify]
  island: [
    [41.8503, -87.6102], [41.8503, -87.6060], [41.8560, -87.6057], [41.8620, -87.6054],
    [41.8652, -87.6049], [41.8672, -87.6056], [41.8678, -87.6078], [41.8668, -87.6098],
    [41.8662, -87.6142], [41.8656, -87.6142], [41.8655, -87.6104], [41.8620, -87.6109],
    [41.8560, -87.6108],
  ],
  // mainland lakefront, south to north; land lies to the west [verify]
  shoreline: [
    [41.8300, -87.6050], [41.8400, -87.6075], [41.8470, -87.6100], [41.8510, -87.6125],
    [41.8560, -87.6145], [41.8610, -87.6152], [41.8650, -87.6146], [41.8690, -87.6132],
    [41.8730, -87.6148], [41.8800, -87.6162], [41.8860, -87.6155], [41.8905, -87.6125],
    [41.8925, -87.6125], [41.8935, -87.6160], [41.9000, -87.6205], [41.9100, -87.6255],
    [41.9300, -87.6330],
  ],
  navyPier: [[41.8908, -87.6118], [41.8908, -87.5985], [41.8925, -87.5985], [41.8925, -87.6118]],
  // landmarks, roof heights in metres [verify positions against tiles]
  landmarks: [
    { name: 'Sears Tower', at: [41.8789, -87.6359], h: 442, w: 68, d: 68, kind: 'bundled', color: '#2a2a2e' },
    { name: 'Aon Center', at: [41.8853, -87.6215], h: 346, w: 59, d: 59, kind: 'box', color: '#e8e6e0' },
    { name: 'John Hancock Center', at: [41.8988, -87.6229], h: 344, w: 50, d: 80, kind: 'taper', color: '#1f1f22', mast: 113 },
    { name: 'Two Prudential Plaza', at: [41.8850, -87.6232], h: 303, w: 40, d: 40, kind: 'spire', color: '#b9b4ab' },
    { name: 'AT&T Corporate Center', at: [41.8807, -87.6344], h: 307, w: 45, d: 45, kind: 'box', color: '#8c7f73' },
    { name: '311 South Wacker', at: [41.8774, -87.6360], h: 293, w: 45, d: 45, kind: 'crown', color: '#c9b9a0' },
    { name: 'Water Tower Place', at: [41.8978, -87.6236], h: 262, w: 60, d: 45, kind: 'box', color: '#cfcac0' },
    { name: 'Lake Point Tower', at: [41.8917, -87.6128], h: 197, w: 45, d: 45, kind: 'trefoil', color: '#3a3328' },
    { name: 'Field Museum', at: [41.8663, -87.6170], h: 30, w: 230, d: 100, kind: 'box', color: '#e4dfd2' },
    { name: 'Shedd Aquarium', at: [41.8676, -87.6140], h: 25, w: 90, d: 90, kind: 'box', color: '#e4dfd2' },
    { name: 'Adler Planetarium', at: [41.8663, -87.6068], h: 22, w: 50, d: 50, kind: 'dome', color: '#c8b48c' },
    { name: 'Soldier Field', at: [41.8623, -87.6167], h: 30, w: 170, d: 260, kind: 'stadium', color: '#cfcac0' },
    { name: 'McCormick Place Lakeside', at: [41.8512, -87.6155], h: 25, w: 250, d: 220, kind: 'box', color: '#2b2b2b' },
    { name: 'Meigs Terminal', at: [41.8597, -87.6096], h: 8, w: 70, d: 22, kind: 'box', color: '#d8d4cb' },
    { name: 'Meigs Tower', at: [41.8605, -87.6097], h: 22, w: 7, d: 7, kind: 'tower', color: '#d8d4cb' },
  ],
  // where the Loop's fabric of mid-rises goes (procedural blocks) [approx]
  downtown: { south: 41.8730, north: 41.8960, west: -87.6420, east: -87.6190, minH: 25, maxH: 210, seed: 1982 },
};

/** Build everything the sim and the renderer need, in metres in the local frame. */
export function buildMeigs(data = MEIGS) {
  const frame = new LocalFrame(data.runway.centre[0], data.runway.centre[1]);
  const elevation = data.elevationFt * FT;
  const water = (data.lakeLevelFt - data.elevationFt) * FT;   // relative to the datum (runway)
  const toNE = ([lat, lon]) => frame.toNE(lat, lon);

  const rw = data.runway;
  const len = rw.lengthFt * FT;
  const wid = rw.widthFt * FT;
  const brg = (rw.trueBearing * Math.PI) / 180;
  const dir = [Math.cos(brg), Math.sin(brg)];            // along 36, (n, e)
  const c = toNE(rw.centre);
  const thr36 = [c[0] - (dir[0] * len) / 2, c[1] - (dir[1] * len) / 2];
  const thr18 = [c[0] + (dir[0] * len) / 2, c[1] + (dir[1] * len) / 2];

  const island = data.island.map(toNE);
  // close the mainland polygon far to the west
  const shore = data.shoreline.map(toNE);
  const mainland = [...shore, [shore[shore.length - 1][0], -30000], [shore[0][0], -30000]];
  const pier = data.navyPier.map(toNE);

  const runwayLocal = (n, e) => {
    const dn = n - c[0], de = e - c[1];
    return [dn * dir[0] + de * dir[1], -dn * dir[1] + de * dir[0]]; // along, across
  };

  /** Ground query used by the gear: height above the datum, normal (NED up), surface. */
  const ground = (n, e) => {
    const [al, ac] = runwayLocal(n, e);
    if (Math.abs(al) <= len / 2 + 30 && Math.abs(ac) <= wid / 2) return { h: 0, normal: UP, surface: 'asphalt' };
    if (pointInPolygon(n, e, island)) return { h: 0, normal: UP, surface: 'grass' };
    if (pointInPolygon(n, e, pier)) return { h: 1.5, normal: UP, surface: 'asphalt' };
    if (pointInPolygon(n, e, mainland)) return { h: 0.5, normal: UP, surface: 'grass' };
    return { h: water, normal: UP, surface: 'water' };
  };

  const landmarks = data.landmarks.map((l) => ({ ...l, ne: toNE(l.at) }));

  /** East coordinate of the mainland shore at a given north (linear between shoreline points). */
  const shoreEastAt = (n) => {
    if (n <= shore[0][0]) return shore[0][1];
    for (let i = 1; i < shore.length; i++) {
      if (n <= shore[i][0]) {
        const t = (n - shore[i - 1][0]) / (shore[i][0] - shore[i - 1][0]);
        return shore[i - 1][1] + t * (shore[i][1] - shore[i - 1][1]);
      }
    }
    return shore[shore.length - 1][1];
  };

  return {
    data, frame, elevation, water, ground, shoreEastAt,
    runway: { centre: c, dir, length: len, width: wid, thr36, thr18, bearing: brg },
    island, mainland, shore, pier, landmarks,
    downtown: { ...data.downtown, sw: toNE([data.downtown.south, data.downtown.west]), ne: toNE([data.downtown.north, data.downtown.east]) },
    /** Classic start: lined up on runway 36 just past the numbers. */
    startPosition() {
      const back = 105;
      return { n: thr36[0] + dir[0] * back, e: thr36[1] + dir[1] * back, heading: brg };
    },
  };
}

const UP = [0, 0, -1];
