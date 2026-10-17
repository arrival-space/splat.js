// f15c.js — the McDonnell Douglas F-15C Eagle as data, in the same body axes
// and conventions as extra300l.js (x forward, y right, z down; metres from the
// reference point R, the CG at the reference loading).
//
// Provenance, as in extra300l.js:
//   [pub]  published: USAF fact sheet, F-15C SAC (Feb 1992) figures as quoted
//          on Wikipedia / milavia.net / aerospaceweb.org — 19.43 m long,
//          13.05 m span, 5.63 m high, 56.5 m² wing, NACA 64A006.6 root /
//          64A203 tip, 45° leading-edge sweep, 12,975-13,150 kg empty,
//          6,103 kg internal fuel, 2 × F100-PW-220 at 64.9 kN dry /
//          105.7 kN with afterburner, wheelbase 17.78 ft, Mach 2.5, +9 g
//   [est]  from the three-view and fighter-design rules of thumb
//   [tune] chosen to meet a published figure; tests/f15.test.js pins it
//
// Stations: the nose is 11.0 m ahead of R, which sits at 25 % of the
// 4.86 m mean aerodynamic chord; the tail end is 8.43 m behind it.

import { DEG, KT } from '../units.js';

const NOSE = 11.0;                    // body x of the radome tip
const xb = (fromNose) => NOSE - fromNose;   // station (m aft of the nose) → body x

// ── wing: cropped delta, 45° leading edge ───────────────────────────────
const span = 13.05;                   // [pub]
const semi = span / 2;
const rootChord = 6.93;               // [est] theoretical, at the centreline: with the tip gives S = 56.5 m², MAC 4.86 m
const tipChord = 1.73;                // [est] taper 0.25
const leSweep = 45 * DEG;             // [pub]
const LE0 = xb(7.2);                  // [est] theoretical leading edge at the centreline (station 7.2 m)
export const WING_Z = -0.50;          // [est] shoulder wing: chord plane above R
export const wingLE = (y) => LE0 - Math.abs(y) * Math.tan(leSweep);
export const wingChord = (y) => rootChord + ((tipChord - rootChord) * Math.abs(y)) / semi;
// the sweep's effective dihedral (the real wing has 1° of anhedral; 38° of quarter-chord sweep
// more than makes up for it): modelled as a tilt of the strips [tune] tests/f15.test.js spiral
const DIHEDRAL_EFF = 4 * DEG;

function wingSegments(n = 8) {
  const segs = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const y0 = (semi * i) / n, y1 = (semi * (i + 1)) / n, ym = 0.5 * (y0 + y1);
      const c = wingChord(ym);
      // trailing edge: simple flaps inboard of the ailerons [est] three-view
      let control = null;
      if (ym > 4.1) control = { input: 'aileron', sign: -side, chordFrac: 0.22, maxDefl: 16 * DEG };
      else if (ym > 1.6) control = { input: 'flaps', sign: 1, chordFrac: 0.24, maxDefl: 30 * DEG, clmaxGain: 0.6 };
      segs.push({
        name: `wing${side < 0 ? 'L' : 'R'}${i}`,
        group: 'wing',
        side,
        pos: [wingLE(ym) - 0.25 * c, side * ym, WING_Z],
        chord: c,
        area: (y1 - y0) * c,
        span: [0, Math.cos(DIHEDRAL_EFF), -side * Math.sin(DIHEDRAL_EFF)],
        normal: [0, -side * Math.sin(DIHEDRAL_EFF), -Math.cos(DIHEDRAL_EFF)],
        incidence: 1.5 * DEG,         // [est] the conical camber's zero-lift angle
        control,
      });
    }
  }
  return segs;
}

// ── stabilators: all-moving, outboard of the fins, 8.61 m span [est] ────
function stabilators() {
  const y0 = 1.95, y1 = 4.305, c0 = 3.0, c1 = 1.1, le0 = xb(15.6);
  const out = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const ya = y0 + ((y1 - y0) * i) / 2, yb = y0 + ((y1 - y0) * (i + 1)) / 2, ym = 0.5 * (ya + yb);
      const c = c0 + ((c1 - c0) * (ym - y0)) / (y1 - y0);
      const le = le0 - (ym - y0);     // 45° leading edge
      out.push({
        name: `stab${side < 0 ? 'L' : 'R'}${i}`,
        group: 'htail',
        side,
        pos: [le - 0.25 * c, side * ym, 0.0],
        chord: c,
        area: (yb - ya) * c,
        span: [0, 1, 0],
        normal: [0, 0, -1],
        // stick back: leading edge up, both together; stick right: the right one down at the
        // leading edge, the left one up — the Eagle rolls on its tails as well as its ailerons
        control: { input: 'elevator', sign: -1, chordFrac: 1, maxDefl: 22 * DEG, allMoving: true,
          mix: [{ input: 'aileron', gain: 0.25 * side }] },
        downwash: true,
      });
    }
  }
  return out;
}

// ── twin fins: 2 × 5.3 m², rudders on their lower halves [est] ──────────
function fins() {
  const out = [];
  const zRoot = -0.75, zTip = 2.15 - 5.63;   // [pub] 5.63 m high, standing on its gear
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const za = zRoot + ((zTip - zRoot) * i) / 2, zb = zRoot + ((zTip - zRoot) * (i + 1)) / 2, zm = 0.5 * (za + zb);
      const u = (zm - zRoot) / (zTip - zRoot);
      const c = 2.9 + (1.0 - 2.9) * u;
      const le = xb(14.9) - (zRoot - zm) * Math.tan(37 * DEG);
      out.push({
        name: `fin${side < 0 ? 'L' : 'R'}${i}`,
        group: 'vtail',
        side: 0,
        pos: [le - 0.25 * c, side * 1.3, zm],
        chord: c,
        area: Math.abs(zb - za) * c,
        span: [0, 0, -1],
        normal: [0, -1, 0],
        control: i === 0 ? { input: 'rudder', sign: 1, chordFrac: 0.3, maxDefl: 30 * DEG } : null,
      });
    }
  }
  return out;
}

export const F15C = {
  name: 'F-15C Eagle',
  id: 'f15c',

  wing: { span, area: 56.5, mac: 4.86, aspect: (span * span) / 56.5, oswald: 0.8 },   // [pub] S, b; MAC from the planform

  // ── mass & balance ──────────────────────────────────────────────────────
  mass: {
    empty: { m: 13150, pos: [0.05, 0, 0.0] },             // [pub] 29,000 lb; [est] CG
    // [est] NASA F-15 simulation inertias (≈ 39,000 / 224,000 / 255,000 kg m² at 45,000 lb), scaled to the lighter loading
    inertiaEmpty: { xx: 30000, yy: 185000, zz: 210000, xz: -700 },
    items: {
      pilot: { m: 100, pos: [5.4, 0, -1.0] },              // with gear
      passenger: { m: 0, pos: [4.4, 0, -0.95] },           // (a D-model's rear seat)
      fuelCenter: { capacityL: 4900, pos: [-0.6, 0, -0.3] },   // fuselage tanks 1-4 [est] of the 7,630 L internal
      fuelWings: { capacityL: 2730, pos: [-1.2, 0, -0.4] },
      baggage: { m: 0, pos: [0, 0, 0] },
    },
    fuelDensity: 0.80,     // kg/L JP-8
    defaultLoad: { fuelCenterL: 3900, fuelWingsL: 1000 },   // ~64 % internal fuel, clean: 17.2 t (37,900 lb)
    mtow: 30845,           // [pub]
  },

  // ── aerodynamics ────────────────────────────────────────────────────────
  aero: {
    surfaces: [...wingSegments(8), ...stabilators(), ...fins()],
    groupData: {
      // [est] DATCOM lift slope for A = 3.0 with 31° half-chord sweep ≈ 3.1 /rad; a thin swept wing
      // rounds over gently past ~26° instead of breaking [tune] tests/f15.test.js approach
      wing: { a: 3.2, stall: 26 * DEG, stallDrop: 0.1, stallWidth: 12 * DEG, cd0: 0.0055, e: 0.8, aspect: 3.0 },
      htail: { a: 2.9, stall: 24 * DEG, stallDrop: 0.15, stallWidth: 8 * DEG, cd0: 0.006, e: 0.8, aspect: 3.4 },
      vtail: { a: 2.4, stall: 25 * DEG, cd0: 0.006, e: 0.75, aspect: 1.6 },
    },
    downwash: { deda: 0.35 },
    // [tune] zero-lift drag ≈ 0.024 · S subsonic, the strips' share taken out; gear and the dorsal speed brake
    body: {
      dragArea: 0.92, gearDragArea: 0.9, speedbrakeDragArea: 1.8,
      sideArea: 14, sideSlope: 0.4,
      topArea: 8, topSlope: 0.5,
      pos: [1.5, 0, 0.0],
    },
    // compressibility [est]: lift slope rising toward Mach 1 and falling past it; zero-lift drag
    // rising ~2.4× through the transonic and easing off supersonic [tune] tests/f15.test.js: Mach ~0.92 dry and
    // ~1.25 with the burner at sea level; ~1.0 dry and 2.3+ with the burner at 36,000 ft
    mach: {
      lift: [[0, 1], [0.6, 1.08], [0.9, 1.22], [1.05, 1.15], [1.4, 0.9], [2.0, 0.7], [2.6, 0.58]],
      drag: [[0, 1], [0.8, 1], [0.88, 1.1], [0.92, 1.45], [0.98, 1.9], [1.05, 2.3], [1.2, 2.4], [1.5, 2.1], [2.0, 1.75], [2.5, 1.6]],
    },
    groundEffect: true,
  },
  // flaps follow the gear handle and blow up above 250 kt
  autoFlaps: { maxSpeed: 250 * KT },

  // ── engines: 2 × Pratt & Whitney F100-PW-220 ────────────────────────────
  jet: {
    count: 2,
    pos: [xb(19.2), 0, 0.0],   // nozzles, on the thrust line
    milThrust: 64900,          // [pub] N each, dry
    maxThrust: 105700,         // [pub] N each, full afterburner
    idleThrust: 2400,          // [est]
    idleN2: 68, milN2: 95,     // % core speed [est]
    starterN2: 26, lightOffN2: 20,
    spoolTauIdle: 2.0, spoolTauMil: 0.8,   // s [est] idle → military in ~4-5 s
    starterTau: 3.5, windDownTau: 7,
    abDetent: 0.8,             // throttle travel where the burner starts
    abLightDelay: 0.5, abTau: 0.7,
    densityExp: 0.75,
    // ram recovery [est/tune]: little for the dry engine, a lot for the burner
    ramDry: [[0, 1], [0.4, 0.97], [0.8, 0.97], [0.95, 0.93], [1.2, 0.95], [1.6, 1.1], [2.0, 1.28], [2.5, 1.3]],
    ramAb: [[0, 1], [0.4, 1.08], [0.8, 1.6], [1.2, 2.67], [1.6, 3.1], [2.0, 3.45], [2.3, 3.65], [2.6, 3.3], [3.0, 1.8]],
    tsfcDry: 2.07e-5,          // kg/(N s) = 0.73 lb/(lbf h) [est]
    tsfcAb: 1.21e-4,           // on the burner's share: 2.1 lb/(lbf h) overall at full burner [est]
    ftitIdle: 480, ftitMil: 900,
    windmillDrag: 4000,        // N each at Mach 1, flamed out
  },

  // ── landing gear: retractable tricycle, steerable nose wheel ────────────
  gear: {
    transitTime: 6,
    units: [
      { name: 'mainL', pos: [-0.9, -1.375, 2.27], k: 630000, c: 70000, travel: 0.30, retracts: true,
        tyre: { mu: 0.8, rolling: 0.015, radius: 0.44 }, brake: 'left', maxBrakeTorque: 16000 },
      { name: 'mainR', pos: [-0.9, 1.375, 2.27], k: 630000, c: 70000, travel: 0.30, retracts: true,
        tyre: { mu: 0.8, rolling: 0.015, radius: 0.44 }, brake: 'right', maxBrakeTorque: 16000 },
      { name: 'nose', pos: [4.52, 0, 2.27], k: 150000, c: 15000, travel: 0.30, retracts: true,   // [pub] wheelbase 5.42 m, track 2.75 m
        tyre: { mu: 0.7, rolling: 0.02, radius: 0.28 }, steer: { maxAngle: 15 * DEG, input: 'rudder', sign: 1, fadeSpeed: 22 } },
    ],
    scrape: [
      { name: 'nozzleL', pos: [xb(19.2), -0.6, 0.35], mu: 0.45, k: 900000, c: 60000 },
      { name: 'nozzleR', pos: [xb(19.2), 0.6, 0.35], mu: 0.45, k: 900000, c: 60000 },
      { name: 'wingtipL', pos: [-3.6, -6.52, -0.45], mu: 0.5, k: 600000, c: 30000 },
      { name: 'wingtipR', pos: [-3.6, 6.52, -0.45], mu: 0.5, k: 600000, c: 30000 },
      { name: 'belly', pos: [3.0, 0, 1.0], mu: 0.45, k: 900000, c: 60000 },
      { name: 'bellyL', pos: [-2.0, -1.2, 1.05], mu: 0.45, k: 900000, c: 60000 },
      { name: 'bellyR', pos: [-2.0, 1.2, 1.05], mu: 0.45, k: 900000, c: 60000 },
    ],
  },

  // tail hook under the aft fuselage, between the engines (the Eagle's is for runway arresting cables;
  // here it catches a carrier's wires): pivot, arm length, how far down it swings [est]
  hook: { pivot: [xb(17.0), 0, 0.55], length: 1.9, maxAngle: 55 * DEG },

  limits: {
    vso: 130, vs1: 130, vne: 800, mmo: 2.5,   // KCAS; [pub] Mach 2.5
    gPos: 9, gNeg: -3,                         // [pub]
  },

  // the stick for the keyboard pilot and easy mode (see input/controlMapper.js) [tune] tests/f15.test.js
  handling: {
    keyAuthority: {
      elevator: { c: 0.000115, k0: 0.6 },
      aileron: { c: 0.00002, k0: 0.8 },
      rudder: { c: 0.00003, k0: 0.8 },
    },
    buffetAlpha: 24 * DEG,
    easy: {
      alphaMax: 22 * DEG, liftoffMargin: 8 * DEG, minQ: 150,
      rotateQ: 0.5 * 1.225 * (125 * KT) ** 2, climbPitch: 12 * DEG,
      gMax: 7.5, gMin: -3, radPerG: 0.035,
      elevPerGq: 750,          // Pa per g: stabilator travel per g falls as 1/q [tune] tests/f15.test.js easy pull
      holdSpeedKt: [120, 210],
    },
    throttleRate: 0.4,
  },

  // the pilot's eye under the bubble, sitting high: ~15° to see over the nose [est]
  eye: [xb(5.3), 0, -1.32],
};

export default F15C;
