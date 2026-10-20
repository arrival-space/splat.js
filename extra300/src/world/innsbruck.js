// innsbruck.js — Innsbruck Airport (LOWI) as a destination (world/airport.js): in the Inn valley,
// the mountains all round; runway 08/26, started on 26.

import { buildAirport, inflateAirport } from './airport.js';
import { LOWI_DATA, LOWI_DEM } from './data/lowi.js';

export { inflateGrid } from './airport.js';

/**
 * Runway 08/26 as painted (render/icaoRunway.js), measured on basemap.at's 2025 orthophoto: metres
 * in from each threshold (OpenStreetMap's runway ends are the thresholds), across from the centre
 * line (+ to the right landing 08, the south side). Edge-line gaps and the yellow lines are in metres
 * from the 08 threshold.
 */
export const LOWI_LAYOUT = {
  shoulder: 7.5,                   // paved beyond the 45 m runway, each side
  before: [96, 36],                // pavement before the 08 threshold (the turn pad), past the 26 one
  bar: 1.8, edge: 0.9,             // the threshold bar's depth, the edge lines' width
  piano: { n: 6, first: 1.2, pitch: 3.65, width: 1.8, at: 6.6, length: 30 },
  numerals: 49,                    // the designator's foot
  aiming: { at: 227.5, length: 45, c: [9, 15] },
  tdz: { at: [150, 450, 600], length: 22.5, c: [9, 12] },
  centre: { from: 70, stripe: 30, gap: 20, width: 0.9 },
  edgeFrom: [59.5, 0],             // the edge lines from the bar before 08 to the 26 threshold
  edgeGaps: { right: [[40, 48], [349, 441], [1555, 1622], [1826, 1838]], left: [[1258, 1291]] },
  // 08's pre-threshold area: a bar across 59 m out, an arrow down the middle to the threshold
  preThreshold: [{ end: -1, bar: -59, arrow: [-50, -12] }],
  yellow: [
    { bezier: [[100, 0], [62, 0], [33, 30]] },                      // from the taxiway onto 08
    { line: [[-17, 0], [-61, 0]] },                                 // 08's turn pad
    { arc: [-61, 26, 26, -Math.PI / 2, -1.5 * Math.PI] },
    { bezier: [[1770, 0], [1800, 0], [1823, 30]] },                 // from the taxiway onto 26
    { line: [[1870, 0], [1945, 0]] },                               // 26's turn pad
    { arc: [1945, 26, 26, -Math.PI / 2, Math.PI / 2] },
    { line: [[1940, -24], [1973, -24], [1973, 30]] },              // the end of the pavement
  ],
};

export const INNSBRUCK = {
  id: 'lowi',
  icao: 'LOWI',
  name: 'Innsbruck Airport',
  elevationM: 581,                 // field elevation (OSM ele, AIP 1906 ft)
  geoidM: 48.0,                    // geoid above the WGS-84 ellipsoid here (EGM2008) [approx]: Google's tiles are in ellipsoid heights
  magVar: 4.5,                     // degrees east (2026)
  runway: { ident: ['08', '26'] },
  // the tower view: over the terminal on the south side [approx: the tower isn't in OSM]
  tower: { at: [47.2583, 11.3476], h: 32 },
  start: 'high',
  style: 'lowi',
  // where the other airplanes park unless an airplane vibe places one (plugin/parkedAircraft.js): metres
  // from the start on 26, along the runway and to its left (south), for wingspans up to `span`. The small
  // ones nose to the runway on the concrete pad beside the threshold (Google's imagery: ~27–62 m left, ~95 m
  // back to ~50 m ahead); the big one along the main apron's open front (~245–320 m left), clear of the trees.
  stands: [
    { along: -18, left: 42, span: 12 },
    { along: -45, left: 44, span: 20 },
    { along: -75, left: 44, span: 20 },
    { along: 560, left: 283, span: 80, face: 'along' },
  ],
  get layout() { return LOWI_LAYOUT; },
};


export const inflateLowiDem = (dem = LOWI_DEM) => inflateAirport(dem);

/** @param {{ near, far }|null} dem  inflateLowiDem(); null: level everywhere (until it's decoded) */
export const buildInnsbruck = (dem = null, data = INNSBRUCK, osm = LOWI_DATA) => buildAirport(data, osm, dem);
