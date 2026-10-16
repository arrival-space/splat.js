// extra300l.js — the Extra 300L as data.
//
// Body axes, aerospace convention: x forward, y right wing, z down. Lengths in
// metres from the reference point R, which is the CG at the reference loading
// (pilot in the rear seat, aerobatic fuel). Mass items move the actual CG.
//
// Provenance of the numbers, so they can be audited and replaced:
//   [pub]  published by Extra Flugzeugproduktions / type certificate data
//          (EASA TCDS A.362) / POH figures as commonly quoted
//   [est]  estimated from three-view drawings or standard light-aircraft
//          methods (Roskam, Raymer); flagged so they can be checked
//   [tune] chosen so the model meets a published performance figure;
//          the test that pins it is named
//
// Validation targets live in tests/performance.test.js and are the
// published numbers: stall ~55 KIAS at 950 kg, climb ~3,200 fpm,
// roll rate ~400 °/s, max level speed ~185 KTAS.

import { DEG, HP, INHG, KT } from '../units.js';

const span = 8.0;          // [pub] 8.00 m
const rootChord = 1.86;    // [est] three-view; with tip gives S = 10.7 m²
const tipChord = 0.82;     // [est]
const semi = span / 2;
const teX = -1.014;        // [est] straight trailing edge station; puts R at ~28 % MAC

/** Wing panels: TE straight, LE swept, symmetric section (MA 15 S root, MA 12 S tip). */
function wingSegments(n = 6, yInner = 0.0) {
  const segs = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const y0 = yInner + ((semi - yInner) * i) / n;
      const y1 = yInner + ((semi - yInner) * (i + 1)) / n;
      const ym = 0.5 * (y0 + y1);
      const c = rootChord + ((tipChord - rootChord) * ym) / semi;
      segs.push({
        name: `wing${side < 0 ? 'L' : 'R'}${i}`,
        group: 'wing',
        side,
        pos: [teX + 0.75 * c, side * ym, 0.2],   // low wing: chord plane 0.2 m below R
        chord: c,
        area: (y1 - y0) * c,
        span: [0, 1, 0],            // spanwise axis (same for both sides so lift is up)
        // Sign conventions (checked in tests/aero.test.js): stick right = +aileron rolls right,
        // stick back = +elevator pitches up, right pedal = +rudder yaws right.
        normal: [0, 0, -1],         // lift-positive normal
        // [pub] ailerons nearly full span; [est] 30 % chord
        control: ym > 0.75 ? { input: 'aileron', sign: -side, chordFrac: 0.30, maxDefl: 27 * DEG } : null, // [tune] roll rate test
      });
    }
  }
  return segs;
}

export const EXTRA_300L = {
  name: 'Extra 300L',

  // ── geometry ────────────────────────────────────────────────────────────
  wing: { span, area: 10.7, mac: 1.407, aspect: (span * span) / 10.7, oswald: 0.82 }, // [pub] S, b; [est] e

  // ── mass & balance ──────────────────────────────────────────────────────
  mass: {
    empty: { m: 667, pos: [0.06, 0, 0.05] },               // [pub] ~667 kg; [est] empty CG
    // Ixx, Iyy, Izz about the empty CG [est] radii of gyration for a light aerobatic airframe
    inertiaEmpty: { xx: 360, yy: 760, zz: 1060, xz: 25 },
    items: {
      pilot: { m: 85, pos: [-1.05, 0, -0.35] },             // rear seat [est]
      passenger: { m: 0, pos: [0.25, 0, -0.35] },           // front seat
      fuelCenter: { capacityL: 60, pos: [0.85, 0, -0.10] }, // [pub] 60 L aerobatic tank, ahead of the front seat
      fuelWings: { capacityL: 120, pos: [-0.10, 0, 0.05] }, // [pub] 2×60 L wing tanks (empty for aerobatics)
      baggage: { m: 0, pos: [-1.7, 0, -0.2] },
    },
    fuelDensity: 0.72, // kg/L avgas
    mtow: 950, mtowAcro: 870, // [pub]
  },

  // ── aerodynamic surfaces (component build-up) ───────────────────────────
  aero: {
    // Lift slope of the finite surfaces, per radian [est] from AR via Helmbold
    surfaces: [
      ...wingSegments(6, 0.0),
      // Horizontal tail [est] 3.2 m span, 2.5 m², elevator 45 % chord
      ...[-1, 1].flatMap((side) => [0, 1].map((i) => ({
        name: `htail${side < 0 ? 'L' : 'R'}${i}`,
        group: 'htail',
        side,
        pos: [-3.95, side * (0.4 + 0.8 * i), -0.15],
        chord: 0.82 - 0.12 * i,
        area: 0.8 * (0.82 - 0.12 * i),
        span: [0, 1, 0],
        normal: [0, 0, -1],
        control: { input: 'elevator', sign: -1, chordFrac: 0.45, maxDefl: 25 * DEG },
        downwash: true,
        propwash: i === 0 ? 0.9 : 0.35,
      }))),
      // Vertical tail [est] 1.25 m² with a 50 % chord rudder
      ...[0, 1].map((i) => ({
        name: `vtail${i}`,
        group: 'vtail',
        side: 0,
        pos: [-4.05 - 0.1 * i, 0, -0.35 - 0.55 * i],
        chord: 1.05 - 0.25 * i,
        area: 0.55 * (1.05 - 0.25 * i) + (i === 0 ? 0.08 : 0),
        span: [0, 0, -1],
        normal: [0, -1, 0],
        control: { input: 'rudder', sign: 1, chordFrac: 0.5, maxDefl: 30 * DEG },
        propwash: i === 0 ? 0.9 : 0.5,
        swirl: true,
      })),
    ],
    groupData: {
      // a: 3D lift slope /rad; stall: section stall angle; cd0: profile drag
      // [tune] wing CLmax = a·stall ≈ 1.43 — power-off stall test (thick symmetric MA 15 S/12 S)
      wing: { a: 4.55, stall: 18 * DEG, cd0: 0.0085, e: 0.82, aspect: 6.0 },
      htail: { a: 3.7, stall: 18 * DEG, cd0: 0.0095, e: 0.8, aspect: 4.1 },
      vtail: { a: 2.6, stall: 22 * DEG, cd0: 0.0095, e: 0.7, aspect: 1.6 },
    },
    downwash: { deda: 0.42 },       // [est] dε/dα at the tail
    // Fuselage, gear, cooling, canopy as an equivalent body [tune] Vmax test
    body: {
      dragArea: 0.205,               // m² flat-plate equivalent
      sideArea: 3.6, sideSlope: 0.9, // side force, knife-edge [est]
      topArea: 2.2, topSlope: 0.6,
      pos: [0.15, 0, -0.05],
    },
    groundEffect: true,
  },

  // ── engine: Lycoming AEIO-540-L1B5 ──────────────────────────────────────
  engine: {
    ratedPower: 300 * HP,      // [pub] 300 hp
    ratedRpm: 2700,            // [pub]
    idleRpm: 700,              // [pub] POH idle ~700
    frictionPowerRated: 42 * HP, // [est] friction+pumping at rated rpm
    mpZeroWork: 9.3 * INHG,    // [tune] manifold pressure below which no net indicated work
    intakeLossFull: 1.0 * INHG, // [est] full-throttle manifold loss, static
    idleMp: 11.5 * INHG,       // [est] MP at idle rpm, throttle closed
    rotInertia: 1.75,          // kg m² prop + crank [est] MT 3-blade composite
    rotation: 1,               // +1: clockwise seen from the cockpit (Lycoming)
    bsfc: 0.47,                // lb/hp/h at best power [est]
    fuelInverted: true,        // Christen inverted fuel & oil
    starterTorque: 120,        // N m at the prop
    oil: { capacityQt: 16, tempNormal: 82, pressNormal: 75 },
  },

  // ── propeller: MT-Propeller MTV-9-B-C, 3 blades, constant speed ─────────
  prop: {
    pos: [2.05, 0, 0.0],       // [est] disc centre
    diameter: 1.98,            // [pub] MTV-9-B/198-25 (198 cm)
    blades: 3,
    discEfficiency: 0.55,      // [tune] hub, tip and swirl losses; static thrust ≈ 5.5 kN (~4 lbf/hp)
    chord75: 0.125,            // [tune] static thrust & full-power climb
    betaFine: 17.5 * DEG,      // [tune] full-throttle static rpm ~2,650 on the fine stop
    betaCoarse: 42 * DEG,
    governor: { gain: 0.0045, damping: 0.0012, rateLimit: 18 * DEG, rpmMin: 2000, rpmMax: 2700 },
    pFactor: 0.12,             // thrust-line offset per radian of disc AoA, in radii [est]
  },

  // ── landing gear (spring-steel/composite mains, steerable tailwheel) ────
  gear: {
    // pos = wheel contact point with the strut fully extended
    units: [
      { name: 'mainL', pos: [0.55, -0.93, 1.33], k: 62000, c: 4200, travel: 0.20,
        tyre: { mu: 0.85, rolling: 0.03, radius: 0.18 }, brake: 'left', maxBrakeTorque: 1250 },
      { name: 'mainR', pos: [0.55, 0.93, 1.33], k: 62000, c: 4200, travel: 0.20,
        tyre: { mu: 0.85, rolling: 0.03, radius: 0.18 }, brake: 'right', maxBrakeTorque: 1250 },
      { name: 'tail', pos: [-4.45, 0, 0.42], k: 16000, c: 900, travel: 0.12,
        tyre: { mu: 0.7, rolling: 0.04, radius: 0.08 }, steer: { maxAngle: 30 * DEG, input: 'rudder', sign: -1 } },
    ],
    // hard points that touch the ground in a ground loop or a nose-over
    scrape: [
      { name: 'propTip', pos: [2.1, 0, 0.99], mu: 0.5, k: 120000, c: 6000 },
      { name: 'wingtipL', pos: [-0.2, -4.0, 0.15], mu: 0.5, k: 60000, c: 3000 },
      { name: 'wingtipR', pos: [-0.2, 4.0, 0.15], mu: 0.5, k: 60000, c: 3000 },
      { name: 'rudderBottom', pos: [-4.65, 0, 0.12], mu: 0.5, k: 60000, c: 3000 },
    ],
  },

  // ── limits & V-speeds for the gauges ────────────────────────────────────
  limits: {
    vso: 55, vs1: 55, vfe: null, va: 158, vno: 158, vne: 219, // KIAS [pub]
    gPos: 10, gNeg: -10, // solo, acrobatic category [pub]
    rpmRedline: 2700, mpMax: 30,
  },

  // ground-adjustable trim tabs, set so it flies hands-off at cruise power [tune]
  // tests/performance.test.js "hands off at cruise"
  rigging: { aileron: 0.006, rudder: 0.03 },

  // where the pilot's eyes are (rear seat) for the cockpit camera [est]
  eye: [-1.0, 0, -0.95],
};

export const KNOTS = KT; // re-export so callers can stay unit-explicit
export default EXTRA_300L;
