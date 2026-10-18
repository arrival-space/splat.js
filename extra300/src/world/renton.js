// renton.js — Renton Municipal Airport (KRNT) as a destination (world/airport.js): where Boeing
// builds the 737, at the south tip of Lake Washington; runway 16/34 runs right up to the shore, and
// the new airplanes take off north over the lake. Started on 34.

import { buildAirport, inflateAirport } from './airport.js';
import { KRNT_DATA, KRNT_DEM } from './data/krnt.js';

const FT = 0.3048;

/**
 * Runway 16/34 as painted (render/icaoRunway.js: FAA markings for a 200 ft non-precision runway
 * with displaced thresholds), measured on Google's imagery: metres in from each threshold
 * (OpenStreetMap's runway ends are the thresholds), across from the centre line (+ to the right
 * landing 34, the east side). No edge lines, no touchdown-zone bars.
 */
export const KRNT_LAYOUT = {
  shoulder: 0,                     // the pavement is the runway, 61 m
  before: [150, 93],               // the displaced thresholds' stretches: 34's, and 16's to the seawall
  bar: 3, edge: 0,                 // a 10 ft threshold bar right across
  edgeLines: false,
  piano: { n: 8, first: 1.0, pitch: 3.6, width: 1.75, at: 8.6, length: 150 * FT },
  numerals: 8.6 + 150 * FT + 20 * FT, numeralHeight: 60 * FT,
  aiming: { at: 315.8, length: 150 * FT, c: [11, 20.1] },
  tdz: null,
  centre: { from: 104, stripe: 120 * FT, gap: 80 * FT, width: 0.9 },
  edgeFrom: [0, 0], edgeGaps: { right: [], left: [] },
  // the displaced thresholds: arrows down the middle, arrowheads across just short of the bar
  preThreshold: [
    { end: -1, arrows: [[-130, -98], [-82, -50]], arrowWidth: 0.9, head: [9, 2.6], chevrons: { at: -5, c: [-21, -7, 7, 21] } },
    { end: 1, arrows: [[-58, -26]], arrowWidth: 0.9, head: [9, 2.6], chevrons: { at: -5, c: [-21, -7, 7, 21] } },
  ],
  yellow: [],
};

export const RENTON = {
  id: 'krnt',
  icao: 'KRNT',
  name: 'Renton Municipal Airport',
  elevationM: 7.5,                 // the runway, from the elevation tiles (AIP field elevation 32 ft at its highest)
  geoidM: -23.0,                   // geoid above the WGS-84 ellipsoid here (EGM2008) [approx]: Google's tiles are in ellipsoid heights
  magVar: 15.0,                    // degrees east (2026)
  runway: { ident: ['34', '16'] }, // OpenStreetMap draws it south to north: 34's threshold first
  tower: { at: [47.4919, -122.2173], h: 20 },
  start: 'low',                    // on 34, toward the lake
  // the sun of Google's imagery: its trees' and hangars' shadows fall short and north-north-west, a
  // summer's late morning (sun 163° true, 63° up; 12:36 PDT on 19 July). Sent with the origin, as the
  // tiles plugin's timeUTC / dayOfYear
  sun: { timeUTC: 19.6, dayOfYear: 200 },
  style: 'krnt',
  get layout() { return KRNT_LAYOUT; },
};

export const inflateRentonDem = (dem = KRNT_DEM) => inflateAirport(dem, KRNT_DATA);

/** @param {{ near, far, water }|null} dem  inflateRentonDem(); null: level everywhere (until it's decoded) */
export const buildRenton = (dem = null, data = RENTON, osm = KRNT_DATA) => buildAirport(data, osm, dem);
