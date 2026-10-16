// intro.js — the boarding intro: a short film of the airplane on runway 36, then
// into the cockpit. Pure timing and geometry (no engine): the plugin asks for
// the shot at time t and turns it into a camera pose and a caption card.
//
// Every camera point is in body axes (x forward, y right, z down; metres from
// R, as the model and the sim), so the shots stay framed on the airplane
// wherever it stands. On the ground the tail sits low: in body axes the ground
// is at z ≈ 1.33 + 0.2·x, and every eye point stays well above it.

import EXTRA from '../sim/aircraft/extra300l.js';

const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);   // smootherstep
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const EYE = EXTRA.eye;

/**
 * Shots: [t0, t1) seconds; the camera eye and the point it looks at move from → to. `card` is the
 * caption shown during the shot.
 */
export const INTRO_SHOTS = [
  // the spinner, close and low, the prop still; the starter turns it over and it catches
  { t0: 0, t1: 5.5, eye: [[3.7, 0.95, 0.22], [3.05, 0.6, 0.12]], at: [[2.15, 0, 0.02], [2.1, 0, -0.02]], fov: [38, 32], card: 0 },
  // down the left side, from the cowl back along the fuselage
  { t0: 5.5, t1: 10.5, eye: [[2.7, -2.5, 0.35], [-0.9, -3.3, 0.05]], at: [[1.6, 0, 0.05], [-0.6, 0, -0.3]], fov: [44, 46], card: 1 },
  // up over the right wing's sunburst
  { t0: 10.5, t1: 15.5, eye: [[0.7, 5.6, -0.9], [-1.5, 3.3, -3.5]], at: [[-0.3, 2.1, 0.2], [-0.6, 0.2, 0.0]], fov: [50, 52], card: 2 },
  // low behind the tail, swinging round to look up the fuselage
  { t0: 15.5, t1: 20.5, eye: [[-7.0, -2.3, -1.0], [-6.2, 1.7, -1.7]], at: [[-4.3, 0, -0.5], [-1.0, 0, -0.45]], fov: [44, 54], card: 3 },
  // over the tail and into the rear seat: the pilot's eye
  { t0: 20.5, t1: 24.5, eye: [[-3.2, 0, -1.7], EYE], at: [[0.5, 0, -0.9], [EYE[0] + 5, 0, EYE[2] + 0.05]], fov: [55, 72], card: 4 },
];
export const INTRO_LENGTH = INTRO_SHOTS[INTRO_SHOTS.length - 1].t1;

/** The engine during the intro: still for the first shot's opening, then the starter, then running. */
export const INTRO_STARTER = [1.4, 4.2];

/** Captions, one per shot. Published figures (EASA TCDS A.362, the POH) as the flight model uses them. */
export const INTRO_CARDS = [
  { kicker: 'Extra Flugzeugbau · Germany', title: 'Extra 300L', lines: ['Unlimited-class aerobatic two-seater', 'Meigs Field, Chicago · runway 36'] },
  { kicker: 'Engine', title: '300 hp Lycoming AEIO-540', lines: ['Six cylinders, fuel injected, inverted oil system', 'MT three-blade constant-speed prop, 1.98 m'] },
  { kicker: 'Airframe', title: 'Steel tube & carbon fibre', lines: ['Welded steel-tube fuselage, composite wing', '8.0 m span · symmetric airfoil, no dihedral'] },
  { kicker: 'Envelope', title: '±10 g · 400°/s roll', lines: ['Climbs 3,200 ft/min, about 185 kt flat out', 'Never exceed 219 kt'] },
  { kicker: 'Your airplane', title: 'Runway 36', lines: ['Pilot in the rear seat · engine running'] },
];

/**
 * The intro at time t (s): camera eye and target in body axes, field of view, which caption, and its
 * opacity (fading in at a shot's start and out at its end). Past the end, `done` is true.
 */
export function introAt(t) {
  if (t >= INTRO_LENGTH) {
    const last = INTRO_SHOTS[INTRO_SHOTS.length - 1];
    return { eye: last.eye[1], at: last.at[1], fov: last.fov[1], card: -1, cardAlpha: 0, done: true };
  }
  const s = INTRO_SHOTS.find((x) => t < x.t1) || INTRO_SHOTS[0];
  const u = ease(Math.max(0, Math.min(1, (t - s.t0) / (s.t1 - s.t0))));
  const into = t - s.t0, left = s.t1 - t;
  const cardAlpha = Math.max(0, Math.min(1, (into - 0.5) / 0.6, left / 0.5));
  return { eye: lerp3(s.eye[0], s.eye[1], u), at: lerp3(s.at[0], s.at[1], u), fov: lerp(s.fov[0], s.fov[1], u), card: s.card, cardAlpha, done: false };
}
