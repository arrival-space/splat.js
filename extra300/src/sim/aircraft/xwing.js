// xwing.js — the Incom T-65B X-wing, as data in the same body axes as the
// others (x forward, y right, z down; metres from R, which sits at the wing
// roots' leading edge).
//
// Its shape is from the three-view schematic by Troy Vigil (top, side, front
// and rear views), scaled to the 12.5 m length it is usually given: nose
// 9.1 m ahead of R, engine nozzles 3.4 m behind, the cannons' axes 5.3 m out,
// wings that widen toward their tips, engines 1.6 m off the centre line.
//
// Its performance is invented for this sim — it should be fast [tune] tests/xwing.test.js:
// four Incom 4L4 fusial thrust engines at 60 kN each, 110 kN on boost (past
// 80 % throttle), no lapse with height or speed; Mach ~2 on the deck with
// the S-foils in attack position, a little more with them closed, past
// Mach 3 high up. Repulsorlifts carry it when slow (it hovers, and settles
// onto its gear), reaction thrusters give it a roll, pitch and yaw rate for
// the stick, and flight stabilizers make it go where it points.

import { DEG, KT } from '../units.js';

const semiTip = 5.3;              // cannon axis, from the schematic
export const WING = {
  rootY: 0.95, tipY: semiTip,     // the wing's span, from the fuselage side to the cannon
  le: 0.2,                        // its leading edge, straight
  teRoot: -1.3, teTip: -1.95,     // its trailing edge, swept back toward the tip (the wing widens)
  hingeZ: 0.26,                   // the upper pair hinges this far above R, the lower this far below
  open: 15 * DEG,                 // each wing's angle in attack position (the X)
};

function wings() {
  const segs = [];
  const chord = (y) => WING.le - (WING.teRoot + ((WING.teTip - WING.teRoot) * (y - WING.rootY)) / (WING.tipY - WING.rootY));
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const y0 = WING.rootY + ((WING.tipY - WING.rootY) * i) / 3, y1 = WING.rootY + ((WING.tipY - WING.rootY) * (i + 1)) / 3, ym = (y0 + y1) / 2;
      const c = chord(ym);
      segs.push({
        name: `sfoil${side < 0 ? 'L' : 'R'}${i}`, group: 'wing', side,
        pos: [WING.le - 0.25 * c, side * ym, 0],
        chord: c,
        area: 2 * (y1 - y0) * c,          // the upper and lower wing together
        span: [0, 1, 0], normal: [0, 0, -1],
        control: null,                    // it steers with thrusters, not with flaps
      });
    }
  }
  return segs;
}

export const XWING = {
  name: 'T-65B X-wing',
  id: 'xwing',
  wing: { span: 2 * semiTip, area: 30, mac: 1.8, aspect: (2 * semiTip) ** 2 / 30, oswald: 0.7 },

  mass: {
    empty: { m: 9200, pos: [0.4, 0, 0] },
    inertiaEmpty: { xx: 30000, yy: 70000, zz: 90000, xz: 0 },
    items: {
      pilot: { m: 90, pos: [2.5, 0, -0.5] },
      passenger: { m: 32, pos: [1.0, 0, -0.75] },   // the astromech
      fuelCenter: { capacityL: 400, pos: [0, 0, 0] },
      fuelWings: { capacityL: 0, pos: [0, 0, 0] },
      baggage: { m: 0, pos: [-1, 0, 0] },
    },
    fuelDensity: 0.8,
    defaultLoad: { fuelCenterL: 400, fuelWingsL: 0, passenger: 32 },
    mtow: 10500,
  },

  aero: {
    surfaces: wings(),
    groupData: { wing: { a: 3.2, stall: 22 * DEG, stallDrop: 0.1, stallWidth: 10 * DEG, cd0: 0.006, e: 0.7, aspect: 3.7 } },
    downwash: { deda: 0 },
    body: {
      dragArea: 0.85, sfoilDragArea: 0.22, gearDragArea: 0.5,
      sideArea: 9, sideSlope: 0.4, topArea: 12, topSlope: 0.4,
      pos: [1.5, 0, 0],
    },
    // a "deflector-streamlined" hull: the transonic rise is mild, and a heat barrier past Mach 3.3
    mach: {
      lift: [[0, 1], [1, 1.1], [2, 0.8], [4, 0.6]],
      drag: [[0, 1], [0.9, 1.05], [1.05, 1.45], [1.3, 1.55], [2.0, 1.5], [3.0, 1.45], [3.4, 2.2], [4.0, 4.5]],
    },
    groundEffect: true,
  },

  jet: {
    count: 4,
    pos: [-3.4, 0, 0],
    milThrust: 60000, maxThrust: 110000, idleThrust: 1500,   // [invented]
    idleN2: 30, milN2: 100,
    starterN2: 25, lightOffN2: 15,
    spoolTauIdle: 0.6, spoolTauMil: 0.3, starterTau: 1.0, windDownTau: 4,
    abDetent: 0.8, abLightDelay: 0.15, abTau: 0.3,             // "boost"
    densityExp: 0,                                            // fusial engines don't breathe
    ramDry: [[0, 1]], ramAb: [[0, 1]],
    tsfcDry: 2e-6, tsfcAb: 4e-6,
    ftitIdle: 300, ftitMil: 700, windmillDrag: 0,
  },
  repulsor: { share: 0.99, fadeSpeed: 140, cushionHeight: 25, damping: 1.4 },
  thrusters: { roll: 220 * DEG, pitch: 95 * DEG, yaw: 45 * DEG, gain: 30, gLimit: 9 },
  stabilizers: { rate: 1.6, maxG: 9 },
  sfoils: WING,

  gear: {
    transitTime: 2.5,
    units: [
      { name: 'mainL', pos: [-1.6, -0.85, 1.75], k: 200000, c: 25000, travel: 0.25, retracts: true,
        tyre: { mu: 0.8, rolling: 0.02, radius: 0.3 }, brake: 'left', maxBrakeTorque: 6000 },
      { name: 'mainR', pos: [-1.6, 0.85, 1.75], k: 200000, c: 25000, travel: 0.25, retracts: true,
        tyre: { mu: 0.8, rolling: 0.02, radius: 0.3 }, brake: 'right', maxBrakeTorque: 6000 },
      { name: 'nose', pos: [4.8, 0, 1.75], k: 80000, c: 10000, travel: 0.25, retracts: true,
        tyre: { mu: 0.7, rolling: 0.02, radius: 0.22 }, steer: { maxAngle: 30 * DEG, input: 'rudder', sign: 1, fadeSpeed: 15 } },
    ],
    scrape: [
      { name: 'noseTip', pos: [9.08, 0, 0.3], mu: 0.4, k: 400000, c: 30000 },
      { name: 'engineL', pos: [-3.3, -1.6, 0.95], mu: 0.4, k: 400000, c: 30000 },
      { name: 'engineR', pos: [-3.3, 1.6, 0.95], mu: 0.4, k: 400000, c: 30000 },
      { name: 'wingtipL', pos: [-1.0, -5.3, 0.6], mu: 0.4, k: 300000, c: 20000 },
      { name: 'wingtipR', pos: [-1.0, 5.3, 0.6], mu: 0.4, k: 300000, c: 20000 },
    ],
  },

  limits: { vso: 0, vs1: 0, vne: 1400, mmo: 3.3, gPos: 9, gNeg: -4 },

  handling: {
    // the stick is a rate command: a held key asks for most of the rate, Shift for all of it
    keyAuthority: { elevator: { c: 0, k0: 1 }, aileron: { c: 0, k0: 1 }, rudder: { c: 0, k0: 1 } },
    keyCap: { elevator: 0.8, aileron: 0.7, rudder: 0.8 },
    buffetAlpha: 40 * DEG,
    easy: { alphaMax: 30 * DEG, rotateQ: 0.5 * 1.225 * (70 * KT) ** 2, climbPitch: 15 * DEG, gMax: 8, gMin: -4, holdSpeedKt: [40, 120], minQ: 30 },
    throttleRate: 0.6,
  },

  // the pilot under the canopy, the astromech behind him [schematic]
  eye: [2.55, 0, -0.80],
};

export default XWING;
