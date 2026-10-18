// b777.js — the Boeing 777-300ER as data, in the same body axes and conventions as extra300l.js
// (x forward, y right, z down; metres from the reference point R, at 25 % of the mean aerodynamic
// chord, on the fuselage's centre line).
//
// Provenance, as in f15c.js:
//   [pub]  published: Boeing 777 Airplane Characteristics for Airport Planning (D6-58329) and the
//          type certificate data as quoted on Wikipedia / boeing.com — 73.86 m long, 64.80 m span
//          (raked tips), 18.5 m high, 6.20 m fuselage, 436.8 m² wing, 31.6° quarter-chord sweep,
//          167,800 kg operating empty, 351,534 kg MTOW, 181,280 L fuel, 2 × GE90-115B at 513 kN,
//          wheelbase 31.22 m, main gear track 10.97 m on two six-wheel bogies, Mach 0.89 MMO
//   [est]  from the user's three-view and airliner-design rules of thumb
//   [tune] chosen to meet a published figure; tests/b777.test.js pins it
//
// Stations are metres aft of the nose; R sits at the wing's quarter MAC (computed from the planform
// below), the main bogies' centres 2.0 m behind it.

import { DEG, KT } from '../units.js';

// ── wing planform, in stations (m aft of the nose) and y (m out from the centre line) [est] ──
// leading edge swept 33.5° all along, a trailing-edge kink (the yehudi) at 10 m, raked tips from 29.5 m
export const WING_PLAN = {
  le: (y) => (y <= 29.5 ? 25.0 + y * Math.tan(33.5 * DEG) : 25.0 + 29.5 * Math.tan(33.5 * DEG) + (y - 29.5) * 1.28),
  te: (y) => (y <= 10 ? 39.0 + y * 0.12 : y <= 29.5 ? 40.2 + (y - 10) * (7.23 / 19.5) : 47.43 + (y - 29.5) * (1.57 / 2.9)),
  semi: 32.4,                       // [pub] 64.8 m span
  kink: 10, rakeAt: 29.5,
  z0: 2.2,                          // [est] the chord plane under the fuselage's centre line at the root
  dihedral: 6 * DEG,                // [est]
};
const chordAt = (y) => WING_PLAN.te(y) - WING_PLAN.le(y);

// the mean aerodynamic chord and where its quarter is: R
function mac() {
  let a = 0, c2 = 0, xq = 0;
  const n = 400, dy = WING_PLAN.semi / n;
  for (let i = 0; i < n; i++) {
    const y = (i + 0.5) * dy, c = chordAt(y);
    a += c * dy; c2 += c * c * dy; xq += c * (WING_PLAN.le(y) + 0.25 * c) * dy;
  }
  return { mac: c2 / a, quarter: xq / a };
}
const MAC = mac();
export const R_STATION = MAC.quarter;                       // ≈ 34.5 m aft of the nose
export const xb = (station) => R_STATION - station;         // station → body x
const wingZ = (y) => WING_PLAN.z0 - Math.abs(y) * Math.tan(WING_PLAN.dihedral);

function wingSegments() {
  const segs = [];
  // strip edges: the root to the kink, out to the rake, the raked tip
  const edges = [0, 2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25.2, 27.5, 29.5, 32.4];
  for (const side of [-1, 1]) {
    for (let i = 0; i < edges.length - 1; i++) {
      const y0 = edges[i], y1 = edges[i + 1], ym = 0.5 * (y0 + y1), c = chordAt(ym);
      // [est] inboard and outboard flaps (slats with them), the outboard aileron
      let control = null;
      if (ym > 3.2 && ym < 21) control = { input: 'flaps', sign: 1, chordFrac: 0.3, maxDefl: 30 * DEG, clmaxGain: 0.9, cpAft: 0.12 };
      else if (ym >= 21 && ym < 29.5) control = { input: 'aileron', sign: -side, chordFrac: 0.22, maxDefl: 20 * DEG };
      const d = WING_PLAN.dihedral;
      segs.push({
        name: `wing${side < 0 ? 'L' : 'R'}${i}`,
        group: 'wing',
        side,
        pos: [xb(WING_PLAN.le(ym) + 0.25 * c), side * ym, wingZ(ym)],
        chord: c,
        area: (y1 - y0) * c,
        span: [0, Math.cos(d), -side * Math.sin(d)],
        normal: [0, -side * Math.sin(d), -Math.cos(d)],
        incidence: 3 * DEG,           // [est] root incidence and the supercritical section's camber
        control,
      });
    }
  }
  return segs;
}

// ── horizontal tail: 21.5 m span, 101 m², elevators [pub]/[est] ─────────────
export const HTAIL = { le0: 61.8, root: 7.6, tip: 2.4, semi: 10.75, sweep: 38 * DEG, z0: -0.6, dihedral: 7 * DEG, elevFrac: 0.33 };
function htail() {
  const out = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const ya = (HTAIL.semi * i) / 3, yb = (HTAIL.semi * (i + 1)) / 3, ym = 0.5 * (ya + yb);
      const c = HTAIL.root + ((HTAIL.tip - HTAIL.root) * ym) / HTAIL.semi;
      const le = HTAIL.le0 + ym * Math.tan(HTAIL.sweep);
      out.push({
        name: `htail${side < 0 ? 'L' : 'R'}${i}`,
        group: 'htail',
        side,
        pos: [xb(le + 0.25 * c), side * ym, HTAIL.z0 - ym * Math.tan(HTAIL.dihedral)],
        chord: c,
        area: (yb - ya) * c,
        span: [0, 1, 0],
        normal: [0, 0, -1],
        incidence: -0.5 * DEG,        // [est] the trimmed stabiliser
        control: { input: 'elevator', sign: -1, chordFrac: HTAIL.elevFrac, maxDefl: 30 * DEG },
        downwash: true,
      });
    }
  }
  return out;
}

// ── vertical tail: 53 m², rudder over most of its height [pub]/[est] ────────
export const VTAIL = { le0: 60.5, root: 8.0, tip: 3.0, z0: -2.9, z1: -13.2, sweep: 41 * DEG, rudFrac: 0.33 };
function vtail() {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const za = VTAIL.z0 + ((VTAIL.z1 - VTAIL.z0) * i) / 3, zb = VTAIL.z0 + ((VTAIL.z1 - VTAIL.z0) * (i + 1)) / 3, zm = 0.5 * (za + zb);
    const u = (zm - VTAIL.z0) / (VTAIL.z1 - VTAIL.z0);
    const c = VTAIL.root + (VTAIL.tip - VTAIL.root) * u;
    const le = VTAIL.le0 + (VTAIL.z0 - zm) * Math.tan(VTAIL.sweep);
    out.push({
      name: `fin${i}`,
      group: 'vtail',
      side: 0,
      pos: [xb(le + 0.25 * c), 0, zm],
      chord: c,
      area: Math.abs(zb - za) * c,
      span: [0, 0, -1],
      normal: [0, -1, 0],
      control: { input: 'rudder', sign: 1, chordFrac: VTAIL.rudFrac, maxDefl: 27 * DEG },
    });
  }
  return out;
}

// ── landing gear: two six-wheel bogies, a twin nose wheel [pub] ─────────────
export const GEAR = {
  contactZ: 5.2,                   // [est] the ground under the fuselage's centre line, static
  main: { x: xb(R_STATION + 2.0), y: 10.97 / 2, axle: 1.45, r: 0.635, w: 0.5, pair: 1.40 },   // bogie centre; 3 axles 1.45 m apart, wheels in pairs
  nose: { x: xb(R_STATION + 2.0 - 31.22), r: 0.545, w: 0.44, pair: 0.86 },
};

export const B777 = {
  name: 'Boeing 777-300ER',
  id: 'b777',

  wing: { span: 64.8, area: 436.8, mac: MAC.mac, aspect: (64.8 * 64.8) / 436.8, oswald: 0.85 },   // [pub] S, b

  // ── mass & balance ──────────────────────────────────────────────────────
  mass: {
    empty: { m: 167800, pos: [0.4, 0, 0.6] },                    // [pub] OEW; [est] CG ~20 % MAC
    // [est] scaled from the 747-100's published inertias (Heffley & Jewell) to the 777's mass and length
    inertiaEmpty: { xx: 1.05e7, yy: 3.2e7, zz: 4.1e7, xz: -6e5 },
    items: {
      pilot: { m: 90, pos: [xb(3.6), -0.53, -0.2] },            // the captain
      passenger: { m: 90, pos: [xb(3.6), 0.53, -0.2] },         // the first officer
      fuelCenter: { capacityL: 97100, pos: [0.6, 0, 2.6] },     // [est] the centre tank of the 181,280 L
      fuelWings: { capacityL: 84180, pos: [-1.6, 0, 2.0] },     // and the two mains
      baggage: { m: 20000, pos: [1.2, 0, 1.6] },                // payload: a light load, a test flight out of Renton
    },
    fuelDensity: 0.80,     // kg/L Jet A
    defaultLoad: { fuelCenterL: 0, fuelWingsL: 30000 },          // ~212 t: off Meigs' 1,200 m with room to spare
    mtow: 351534,          // [pub]
  },

  // ── aerodynamics ────────────────────────────────────────────────────────
  aero: {
    surfaces: [...wingSegments(), ...htail(), ...vtail()],
    groupData: {
      // [est] DATCOM lift slope for A = 9.6 at ~30° half-chord sweep ≈ 4.6 /rad; a supercritical wing
      // stalls near 15° clean (slats and flaps: clmaxGain) [tune] tests/b777.test.js approach
      wing: { a: 4.6, stall: 15 * DEG, stallDrop: 0.25, stallWidth: 6 * DEG, cd0: 0.0055, e: 0.85, aspect: 9.6 },
      htail: { a: 3.8, stall: 18 * DEG, stallDrop: 0.2, stallWidth: 6 * DEG, cd0: 0.006, e: 0.8, aspect: 4.6 },
      vtail: { a: 2.9, stall: 22 * DEG, cd0: 0.006, e: 0.75, aspect: 1.9 },
    },
    downwash: { deda: 0.45 },
    // leading-edge slats: out with the flaps, the whole wing stalls ~8° later [est]
    slats: { stall: 8 * DEG },
    // [tune] the fuselage, nacelles, fairings: zero-lift drag ≈ 0.018 · S with the strips' share; the
    // gear down; the spoilers up (J / B in the air)
    body: {
      dragArea: 6.2, gearDragArea: 6.5, speedbrakeDragArea: 14,
      sideArea: 150, sideSlope: 0.4,
      topArea: 120, topSlope: 0.5,
      pos: [4, 0, 0.5],
    },
    // compressibility [est]: the supercritical wing holds to Mach ~0.86, the drag rises past it
    // [tune] tests/b777.test.js: cruise Mach 0.84 at FL350, no faster than ~0.89 flat out
    mach: {
      lift: [[0, 1], [0.6, 1.1], [0.8, 1.22], [0.86, 1.25], [0.9, 1.2], [0.95, 1.05], [1.1, 0.9]],
      drag: [[0, 1], [0.78, 1], [0.82, 1.04], [0.85, 1.12], [0.88, 1.35], [0.9, 1.7], [0.95, 2.6], [1.0, 3.1], [1.2, 3.2]],
    },
    groundEffect: true,
  },
  // the flaps (and slats) come down with the gear and run up after it, in ~20 s, above 210 kt they stay up
  autoFlaps: { maxSpeed: 210 * KT, time: 20 },

  // ── engines: 2 × General Electric GE90-115B ─────────────────────────────
  jet: {
    count: 2,
    pos: [xb(29.5), 0, 2.45],      // under the wing: the thrust line below the CG pitches the nose up a little
    milThrust: 513000,             // [pub] N each, take-off
    maxThrust: 513000,             // no afterburner
    idleThrust: 12000,             // [est]
    idleN2: 63, milN2: 100,        // % [est]
    starterN2: 22, lightOffN2: 18,
    spoolTauIdle: 3.5, spoolTauMil: 1.6,   // s [est] a big fan: idle to take-off power in ~8 s
    starterTau: 6, windDownTau: 14,
    abDetent: 1,                   // the whole throttle travel is dry
    abLightDelay: 1, abTau: 1,
    densityExp: 0.85,
    // a high-bypass fan loses thrust fast with speed [est]: ~68 % of static at Mach 0.8
    ramDry: [[0, 1], [0.1, 0.93], [0.2, 0.87], [0.3, 0.82], [0.4, 0.78], [0.5, 0.75], [0.6, 0.72], [0.7, 0.7], [0.8, 0.68], [0.9, 0.66], [1.0, 0.64]],
    ramAb: [[0, 1]],
    tsfcDry: 1.45e-5,              // kg/(N s) ≈ 0.51 lb/(lbf h) [est] cruise
    tsfcAb: 1.45e-5,
    ftitIdle: 430, ftitMil: 920,   // EGT, °C
    windmillDrag: 9000,
  },

  // ── landing gear: two units a bogie (its front and rear axles), the twin nose wheel ──
  gear: {
    transitTime: 12,
    units: [
      ...[-1, 1].flatMap((side) => [1, -1].map((fa) => ({
        name: `main${side < 0 ? 'L' : 'R'}${fa > 0 ? 'f' : 'r'}`,
        pos: [GEAR.main.x + fa * GEAR.main.axle, side * GEAR.main.y, GEAR.contactZ],
        k: 2.7e6, c: 4.2e5, travel: 0.45, retracts: true,
        tyre: { mu: 0.8, rolling: 0.012, radius: GEAR.main.r }, brake: side < 0 ? 'left' : 'right', maxBrakeTorque: 160000,
      }))),
      { name: 'nose', pos: [GEAR.nose.x, 0, GEAR.contactZ], k: 8e5, c: 1.3e5, travel: 0.4, retracts: true,
        tyre: { mu: 0.7, rolling: 0.015, radius: GEAR.nose.r }, steer: { maxAngle: 45 * DEG, input: 'rudder', sign: 1, fadeSpeed: 12 } },
    ],
    scrape: [
      { name: 'nacelleL', pos: [xb(26.5), -9.6, 4.45], mu: 0.45, k: 4e6, c: 4e5 },
      { name: 'nacelleR', pos: [xb(26.5), 9.6, 4.45], mu: 0.45, k: 4e6, c: 4e5 },
      { name: 'tail', pos: [xb(65.5), 0, 1.05], mu: 0.45, k: 4e6, c: 4e5 },      // the tail strike: ~8.5° on the main wheels
      { name: 'wingtipL', pos: [xb(48.5), -32.4, wingZ(32.4)], mu: 0.5, k: 3e6, c: 2e5 },
      { name: 'wingtipR', pos: [xb(48.5), 32.4, wingZ(32.4)], mu: 0.5, k: 3e6, c: 2e5 },
      { name: 'belly', pos: [xb(12), 0, 3.15], mu: 0.45, k: 4e6, c: 4e5 },
      { name: 'bellyAft', pos: [xb(48), 0, 3.0], mu: 0.45, k: 4e6, c: 4e5 },
    ],
  },

  limits: {
    vso: 110, vs1: 125, vne: 330, mmo: 0.89,   // KCAS; [pub] VMO 330 KIAS, MMO 0.89
    gPos: 2.5, gNeg: -1,                       // [pub] the transport category's limits
  },

  // the yoke for the keyboard pilot and easy mode (see input/controlMapper.js) [tune] tests/b777.test.js
  handling: {
    keyAuthority: {
      elevator: { c: 0.00022, k0: 1.4 },     // a held key rotates it at ~3°/s, not into a tail strike
      aileron: { c: 0.00008, k0: 0.8 },
      rudder: { c: 0.0001, k0: 0.8 },
    },
    buffetAlpha: 13 * DEG,
    easy: {
      alphaMax: 13 * DEG, liftoffMargin: 5 * DEG, minQ: 300,
      rotateQ: 0.5 * 1.225 * (140 * KT) ** 2, climbPitch: 8 * DEG,
      gMax: 2.0, gMin: 0, radPerG: 0.07,
      elevPerGq: 2600,
      holdSpeedKt: [90, 200],    // the pitch hold's nose-up limit: 8° down at 90 kt, 25° up by 200
    },
    throttleRate: 0.25,
  },

  // the captain's eye, left seat [est]
  eye: [xb(3.55), -0.53, -0.82],
};

export default B777;
