// intro.js — the boarding intro: a short film of the airplane on runway 36, then
// into the cockpit — one for each airplane. Pure timing and geometry (no
// engine): the plugin asks for the shot at time t and turns it into a camera
// pose and a caption card.
//
// Every camera point is in body axes (x forward, y right, z down; metres from
// R, as the model and the sim), so the shots stay framed on the airplane
// wherever it stands. On the ground the tail sits low: in body axes the ground
// is at z ≈ 1.33 + 0.2·x, and every eye point stays well above it.

import EXTRA from '../sim/aircraft/extra300l.js';
import F15 from '../sim/aircraft/f15c.js';
import XW from '../sim/aircraft/xwing.js';
import B777 from '../sim/aircraft/b777.js';

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

/**
 * The film at load (plugin/extra300.js), while Google's tiles are still streaming in: the same four
 * captions, shot so their pop-in stays out of the frame. The camera looks down onto the airplane, the
 * runway round it behind (ours, there from the first frame, the horizon above the top of the frame);
 * one low shot has it against the sky. The airplane is the middle of every frame. It ends outside,
 * the visitor on foot after. (Body axes as above; the ground at z ≈ 1.33 + 0.2·x.)
 */
const INTRO_LOAD_SHOTS = [
  // the spinner from ahead and above, the runway under it
  { t0: 0, t1: 5.5, eye: [[3.9, -1.5, -1.0], [3.3, -1.0, -0.9]], at: [[2.0, 0, 0.05], [1.9, 0, 0.0]], fov: [38, 34], card: 0 },
  // low ahead of the left wing, the cowl and the canopy against the sky
  { t0: 5.5, t1: 10.5, eye: [[3.2, -3.4, 0.7], [2.4, -3.8, 0.6]], at: [[0.4, 0, -0.9], [-0.4, 0, -1.0]], fov: [40, 42], card: 1 },
  // straight down over the right wing's sunburst
  { t0: 10.5, t1: 15.5, eye: [[0.8, 3.2, -4.6], [-1.0, 1.4, -5.6]], at: [[-0.2, 2.4, 0.1], [-0.5, 0.2, 0.0]], fov: [50, 52], card: 2 },
  // high behind the tail, swinging round, down the fuselage to the nose
  { t0: 15.5, t1: 20.5, eye: [[-8.0, -1.4, -4.6], [-7.0, 1.6, -4.4]], at: [[-0.6, 0, -0.4], [0.0, 0, -0.4]], fov: [36, 36], card: 3 },
];

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

// ── the F-15C: the radome, down the intake, over the wing, the nozzles, into the cockpit ──
// (body axes as the F-15's model: the radome tip 11 m ahead of R, the ground ~2.15 m below it)
const F15_EYE = F15.eye;
const F15_SHOTS = [
  { t0: 0, t1: 5.5, eye: [[14.6, 2.6, 1.1], [13.2, 1.7, 0.6]], at: [[9.0, 0, -0.45], [7.6, 0, -0.65]], fov: [40, 34], card: 0 },
  { t0: 5.5, t1: 10.5, eye: [[8.4, -5.6, 0.9], [0.6, -8.4, -0.6]], at: [[5.8, -1.4, -0.3], [-0.5, -2.2, -0.6]], fov: [44, 48], card: 1 },
  { t0: 10.5, t1: 15.5, eye: [[2.5, 12.5, -4.0], [-4.0, 8.5, -8.5]], at: [[-1.0, 3.6, -0.5], [-2.6, 0, -0.6]], fov: [50, 52], card: 2 },
  { t0: 15.5, t1: 20.5, eye: [[-15.0, -4.2, 1.0], [-13.6, 3.8, -0.4]], at: [[-8.0, 0, 0.0], [-3.0, 0, -0.9]], fov: [44, 52], card: 3 },
  { t0: 20.5, t1: 24.5, eye: [[-7.0, 0, -4.2], F15_EYE], at: [[3.0, 0, -1.6], [F15_EYE[0] + 5, 0, F15_EYE[2] + 0.05]], fov: [55, 72], card: 4 },
];
const F15_CARDS = [
  { kicker: 'McDonnell Douglas · St. Louis', title: 'F-15C Eagle', lines: ['Air-superiority fighter: over 100 aerial victories, none lost in air combat', 'Meigs Field, Chicago · runway 36'] },
  { kicker: 'Engines', title: '2 × Pratt & Whitney F100', lines: ['105.7 kN each with afterburner, 64.9 kN dry', 'More thrust than weight: it accelerates going straight up'] },
  { kicker: 'Airframe', title: '45° swept wing, twin tails', lines: ['13.05 m span, 56.5 m² of wing · all-moving stabilators', 'Big low-loaded wing: it turns, and it lands slow for a fighter'] },
  { kicker: 'Envelope', title: 'Mach 2.5 · +9 g', lines: ['19.43 m long, 20 t with fuel and missiles', 'Service ceiling 65,000 ft'] },
  { kicker: 'Your jet', title: 'Runway 36', lines: ['Engines at idle · throttle past 80 % lights the burners'] },
];

// ── the X-wing: the long nose, along the engines, over an S-foil to its cannon, the exhausts, the seat ──
// (its ground ~1.7 m below R)
const XW_EYE = XW.eye;
const XW_SHOTS = [
  { t0: 0, t1: 5.5, eye: [[11.6, 1.9, 0.9], [10.3, 1.3, 0.5]], at: [[7.5, 0, -0.15], [6.2, 0, -0.3]], fov: [40, 34], card: 0 },
  { t0: 5.5, t1: 10.5, eye: [[6.0, -5.6, 0.7], [-1.2, -6.6, -0.5]], at: [[4.0, -1.0, -0.3], [-2.0, -1.6, -0.4]], fov: [44, 48], card: 1 },
  { t0: 10.5, t1: 15.5, eye: [[2.0, 8.2, -3.4], [-2.2, 6.2, -5.0]], at: [[0.5, 4.2, -0.3], [1.5, 0, -0.4]], fov: [50, 52], card: 2 },
  { t0: 15.5, t1: 20.5, eye: [[-9.2, -3.0, 0.9], [-8.6, 3.0, -0.6]], at: [[-3.4, 0, 0], [0, 0, -0.6]], fov: [44, 52], card: 3 },
  { t0: 20.5, t1: 24.5, eye: [[-4.2, 0, -2.6], XW_EYE], at: [[3.0, 0, -1.0], [XW_EYE[0] + 5, 0, XW_EYE[2] + 0.05]], fov: [55, 72], card: 4 },
];
const XW_CARDS = [
  { kicker: 'Incom Corporation · T-65B', title: 'X-wing', lines: ['Starfighter: a long nose, four S-foils, an astromech behind the pilot', 'Meigs Field, Chicago · runway 36'] },
  { kicker: 'Engines', title: '4 × Incom 4L4 fusial thrust', lines: ['This sim: 60 kN each, 110 kN on boost past 80 % throttle', 'Repulsorlifts carry it when slow: it hovers'] },
  { kicker: 'S-foils', title: '4 × KX9 laser cannons', lines: ['J swings the S-foils into attack position', 'Space fires the lasers (S-foils open)'] },
  { kicker: 'This sim', title: 'Mach 2 on the deck', lines: ['Past Mach 3 up high, S-foils closed for cruise', 'Reaction thrusters: 220°/s roll, no g limit'] },
  { kicker: 'Your X-wing', title: 'Runway 36', lines: ['Engines idling · R or End: throttle and boost · Space: lasers'] },
];

// ── the 777: the nose and its windscreen, along the fuselage to an engine, over the wing, the tail,
// into the left seat (its ground ~5.1 m below R; nose 35 m ahead, the tail 39 m behind) ──
const B7_EYE = B777.eye;
const B7_SHOTS = [
  { t0: 0, t1: 5.5, eye: [[48, 9, 2.0], [43, 6, 0.8]], at: [[33, 0, -0.8], [32, 0, -1.0]], fov: [36, 32], card: 0 },
  { t0: 5.5, t1: 10.5, eye: [[20, -22, 2.5], [6, -24, 0.5]], at: [[9, -9.6, 2.4], [2, -9.6, 2.2]], fov: [40, 46], card: 1 },
  { t0: 10.5, t1: 15.5, eye: [[0, 34, -14], [-14, 26, -22]], at: [[-6, 16, 1.0], [-10, 2, 0]], fov: [50, 52], card: 2 },
  { t0: 15.5, t1: 20.5, eye: [[-62, -18, 1.5], [-58, 16, -4]], at: [[-38, 0, -6], [-20, 0, -4]], fov: [40, 48], card: 3 },
  { t0: 20.5, t1: 24.5, eye: [[22, -8, -6], B7_EYE], at: [[33, 0, -1.5], [B7_EYE[0] + 8, B7_EYE[1], B7_EYE[2] + 0.4]], fov: [50, 72], card: 4 },
];
const B7_CARDS = [
  { kicker: 'Boeing Commercial Airplanes · Everett', title: 'Boeing 777-300ER', lines: ['The big twin: 350 seats, 13,650 km', 'Six-pane windscreen, a flight deck for two'] },
  { kicker: 'Engines', title: '2 × General Electric GE90-115B', lines: ['513 kN each: the most powerful jet engines in service', 'A 3.25 m fan in a nacelle as wide as a 737\'s fuselage'] },
  { kicker: 'Airframe', title: '64.8 m span, raked tips', lines: ['436.8 m² of wing, slats and flaps for 120 kt approaches', 'Six-wheel main bogies, 351 t maximum take-off'] },
  { kicker: 'Envelope', title: 'Mach 0.84 at 35,000 ft', lines: ['73.86 m long · MMO 0.89 · ceiling 43,100 ft', 'Tail strike past ~8.5° on the runway: rotate gently'] },
  { kicker: 'Your airplane', title: 'Cleared for take-off', lines: ['Engines idling, flaps set · R / End: thrust · rotate at ~145 kt'] },
];

/** Each airplane's film: shots, captions, the starter's window, its length; `load`: its shots at load, if its own. */
export const INTROS = {
  extra300l: {
    shots: INTRO_SHOTS, cards: INTRO_CARDS, starter: INTRO_STARTER, length: INTRO_LENGTH,
    load: { shots: INTRO_LOAD_SHOTS, length: INTRO_LOAD_SHOTS[INTRO_LOAD_SHOTS.length - 1].t1 },
  },
  // the jet fuel starter needs longer to bring the cores to light-off
  f15c: { shots: F15_SHOTS, cards: F15_CARDS, starter: [1.4, 7.5], length: F15_SHOTS[F15_SHOTS.length - 1].t1 },
  xwing: { shots: XW_SHOTS, cards: XW_CARDS, starter: [1.4, 3.5], length: XW_SHOTS[XW_SHOTS.length - 1].t1 },
  // the big fans need a while on the starter
  b777: { shots: B7_SHOTS, cards: B7_CARDS, starter: [1.4, 12], length: B7_SHOTS[B7_SHOTS.length - 1].t1 },
};

/**
 * A shot's field of view (vertical, degrees) on a screen of this aspect (width / height): the shots are
 * framed for a wide screen; on a narrower one (a phone upright) the view opens up and down until it is
 * as wide as framed, so the airplane stays whole (to `max`).
 */
export function framedFov(fov, aspect, design = 16 / 9, max = 105) {
  if (!(aspect > 0) || aspect >= design) return fov;
  const half = Math.atan(Math.tan((fov * Math.PI) / 360) * (design / aspect));
  return Math.min(max, (half * 360) / Math.PI);
}

/**
 * How far (radians, down) a shot looks below its target on a screen this narrow: upright, the airplane
 * sits higher in the frame, clear of the caption along the bottom. None on a wide screen.
 */
export function framedTilt(fov, aspect) {
  const k = Math.max(0, Math.min(1, (1.2 - aspect) / 0.6));
  return -Math.atan(0.24 * k * Math.tan((fov * Math.PI) / 360));
}

/**
 * The intro at time t (s): camera eye and target in body axes, field of view, which caption, and its
 * opacity (fading in at a shot's start and out at its end). Past the end, `done` is true.
 */
export function introAt(t, intro = INTROS.extra300l) {
  const shots = intro.shots;
  if (t >= intro.length) {
    const last = shots[shots.length - 1];
    return { eye: last.eye[1], at: last.at[1], fov: last.fov[1], card: -1, cardAlpha: 0, done: true };
  }
  const s = shots.find((x) => t < x.t1) || shots[0];
  const u = ease(Math.max(0, Math.min(1, (t - s.t0) / (s.t1 - s.t0))));
  const into = t - s.t0, left = s.t1 - t;
  const cardAlpha = Math.max(0, Math.min(1, (into - 0.5) / 0.6, left / 0.5));
  return { eye: lerp3(s.eye[0], s.eye[1], u), at: lerp3(s.at[0], s.at[1], u), fov: lerp(s.fov[0], s.fov[1], u), card: s.card, cardAlpha, done: false };
}
