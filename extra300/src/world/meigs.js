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
import { MASK_CELL, maskLookup } from './osmCodec.js';

const FT = 0.3048;

export const MEIGS = {
  icao: 'KCGX',
  name: 'Merrill C. Meigs Field',
  arp: [41.8586, -87.6083],          // [verify] aerodrome reference point
  elevationFt: 593,                  // field elevation
  lakeLevelFt: 578,                  // Lake Michigan long-term mean
  geoidM: -33.6,                     // geoid above the WGS-84 ellipsoid here (EGM2008) [approx]: Google's 3D tiles are in ellipsoid heights
  magVar: -2.0,                      // degrees, west negative (late 1990s)
  runway: {
    ident: ['36', '18'],
    lengthFt: 3948,                  // [verify] some sources 3,899 ft after the 1990s re-marking
    widthFt: 150,
    trueBearing: 0.0,                // [verify] the island runs very nearly true north
    centre: [41.8586, -87.6083],     // [verify]
    surface: 'asphalt',
  },
  // Northerly Island (landfill, 1920s-30s) as an airfield: the west shore traced from today's
  // OpenStreetMap outline, the east side the straight pre-2003 seawall (the 2015 park cut a cove
  // into it), the south tip long enough for the runway-36 overrun
  island: [
    [41.85266, -87.60902], [41.85347, -87.60984], [41.85482, -87.60989], [41.85572, -87.60962], [41.85680, -87.60941],
    [41.85725, -87.60967], [41.85815, -87.60999], [41.85905, -87.61023], [41.85959, -87.61042], [41.86040, -87.61066],
    [41.86130, -87.61044], [41.86175, -87.61013], [41.86220, -87.60994], [41.86310, -87.60979], [41.86400, -87.60975],
    [41.86490, -87.61011], [41.86544, -87.61049], [41.86580, -87.61047], [41.86598, -87.60782], [41.86580, -87.60589],
    [41.86544, -87.60572], [41.86481, -87.60649], [41.86436, -87.60671], [41.85392, -87.60671], [41.85284, -87.60746],
  ],
  // mainland lakefront, south to north; land lies to the west [verify]
  shoreline: [
    [41.8300, -87.6050], [41.8400, -87.6075], [41.8470, -87.6100], [41.8510, -87.6125],
    [41.8560, -87.6145], [41.8610, -87.6152], [41.8650, -87.6146], [41.8690, -87.6132],
    [41.8730, -87.6148], [41.8800, -87.6162], [41.8860, -87.6155], [41.8905, -87.6125],
    [41.8925, -87.6125], [41.8935, -87.6160], [41.9000, -87.6205], [41.9100, -87.6255],
    [41.9300, -87.6330],
  ],
  // the lakefront beyond the OpenStreetMap box, north and south, outward from it [approx: beaches and
  // harbours read off the map]; only for the far ground and for the gear, past the detailed city
  farShore: {
    north: [[41.927, -87.629], [41.965, -87.635], [41.986, -87.652], [42.020, -87.663], [42.055, -87.670],
      [42.077, -87.680], [42.135, -87.745], [42.180, -87.780], [42.250, -87.810], [42.400, -87.820]],
    south: [[41.810, -87.583], [41.794, -87.573], [41.782, -87.573], [41.765, -87.560], [41.758, -87.548],
      [41.730, -87.527], [41.680, -87.480], [41.640, -87.400], [41.620, -87.330], [41.640, -87.150]],
  },
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

/** Where the lake starts along one row of the land mask: the west end of the last stretch of open water. */
export function maskShoreE(mask, box, j) {
  const row = j * mask.nx;
  // from the east edge, the first cell that starts ~400 m of mostly land westward (piers and harbours don't count)
  const run = Math.round(400 / MASK_CELL);
  for (let i = mask.nx - 1; i >= run; i--) {
    if (!mask.data[row + i]) continue;
    let land = 0;
    for (let k = 0; k < run; k++) land += mask.data[row + i - k];
    if (land > 0.8 * run) return box.x0 + (i + 1) * MASK_CELL;
  }
  return box.x0;
}

/**
 * The land and the lake around the OSM box, as two polygons [[e, n], ...] with the box cut out:
 * the shore leaves the box's north and south edges where the mask says and follows the far shore
 * points outward to FAR; past the last point it runs straight north, and east along the Indiana
 * shore.
 */
export function buildFarLand(mask, box, northNE, southNE, FAR = 40000) {
  const eTop = maskShoreE(mask, box, mask.ny - 1), eBot = maskShoreE(mask, box, 0);
  const north = northNE.map(([n, e]) => [e, n]).filter(([, n]) => n > box.y1);
  const south = southNE.map(([n, e]) => [e, n]).filter(([, n]) => n < box.y0);
  const lastN = north[north.length - 1] || [eTop, box.y1], lastS = south[south.length - 1] || [eBot, box.y0];
  const northLine = [...north, [lastN[0], FAR]];              // outward from the box
  const southLine = [...south, [FAR, lastS[1]]];
  const southIn = [...southLine].reverse();                   // inward to the box
  return [[-FAR, -FAR], [FAR, -FAR], ...southIn, [eBot, box.y0], [box.x0, box.y0], [box.x0, box.y1], [eTop, box.y1], ...northLine, [-FAR, FAR]];
}

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
  let isLand = null;   // OSM land/water raster, once attached
  let farLand = null;  // [[e, n], ...] the land around the OSM box, out to the horizon
  let inBox = () => false;
  const ground = (n, e) => {
    const [al, ac] = runwayLocal(n, e);
    if (Math.abs(al) <= len / 2 + 30 && Math.abs(ac) <= wid / 2) return { h: 0, normal: UP, surface: 'asphalt' };
    if (pointInPolygon(n, e, island)) return { h: 0, normal: UP, surface: 'grass' };
    if (isLand) {
      const land = inBox(e, n) ? isLand(e, n) : pointInPolygon(e, n, farLand);
      return land ? { h: 0, normal: UP, surface: 'grass' } : { h: water, normal: UP, surface: 'water' };
    }
    if (pointInPolygon(n, e, pier)) return { h: 1.5, normal: UP, surface: 'asphalt' };
    if (pointInPolygon(n, e, mainland)) return { h: 0.5, normal: UP, surface: 'grass' };
    return { h: water, normal: UP, surface: 'water' };
  };

  // buildings, indexed on a 100 m grid for collision checks
  const CELL = 100;
  let grid = null;
  let skylineYear = 2026;

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
    osm: null,
    /** Hand the world the decoded OpenStreetMap scenery: land/water raster for the gear, buildings for collisions. */
    attachOsm(osm, year = 2026) {
      this.osm = osm;
      isLand = maskLookup(osm.mask, osm.header.box);
      const b = osm.header.box;
      inBox = (e, n) => e >= b.x0 && e < b.x1 && n >= b.y0 && n < b.y1;
      farLand = this.farLand = buildFarLand(osm.mask, b, data.farShore.north.map(toNE), data.farShore.south.map(toNE));
      skylineYear = year;
      grid = new Map();
      osm.buildings.forEach((b, i) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of b.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
          for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
            const k = gx * 100003 + gy;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(i);
          }
        }
      });
    },
    setSkylineYear(year) { skylineYear = year; },
    /** The building (if any) whose volume contains the point; height h above the datum. */
    buildingAt(n, e, h) {
      if (!grid) return null;
      for (const i of grid.get(Math.floor(e / CELL) * 100003 + Math.floor(n / CELL)) || []) {
        const b = this.osm.buildings[i];
        if (b.year && b.year > skylineYear) continue;
        if (h > b.h || h < b.minH) continue;
        if (pointInPolygon(e, n, b.outer)) return b;
      }
      return null;
    },
    runway: { centre: c, dir, length: len, width: wid, thr36, thr18, bearing: brg },
    /**
     * The airfield as a box aligned with the runway: Northerly Island and a margin. Google's tiles
     * are cut away inside it so the flat 1990s field shows instead of today's park.
     * @returns {{ centre: number[], dir: number[], halfAlong: number, halfAcross: number }}  (n, e)
     */
    airfieldBox(margin = 12) {
      let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity;
      for (const [n, e] of island) {
        const [al, ac] = runwayLocal(n, e);
        a0 = Math.min(a0, al); a1 = Math.max(a1, al); c0 = Math.min(c0, ac); c1 = Math.max(c1, ac);
      }
      const am = (a0 + a1) / 2, cm = (c0 + c1) / 2;
      // runwayLocal: along = d·dir, across = d × dir (east of the centreline for runway 36)
      const centre = [c[0] + am * dir[0] - cm * dir[1], c[1] + am * dir[1] + cm * dir[0]];
      return { centre, dir, halfAlong: (a1 - a0) / 2 + margin, halfAcross: (c1 - c0) / 2 + margin };
    },
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
