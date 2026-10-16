// units.js — the sim is SI inside; aviation units only at the edges (gauges, docs, tests).

export const G0 = 9.80665;          // m/s²
export const KT = 0.514444;         // m/s per knot
export const FT = 0.3048;           // m per foot
export const FPM = FT / 60;         // m/s per ft/min
export const HP = 745.7;            // W per horsepower
export const INHG = 3386.39;        // Pa per inHg
export const LB = 0.45359237;       // kg per pound
export const GAL = 3.785411784;     // L per US gallon
export const DEG = Math.PI / 180;
export const RPM = (2 * Math.PI) / 60; // rad/s per rpm

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Linear interpolation in a sorted [[x, y], ...] table, clamped at the ends. */
export function table1(tbl, x) {
  if (x <= tbl[0][0]) return tbl[0][1];
  for (let i = 1; i < tbl.length; i++) {
    if (x <= tbl[i][0]) {
      const [x0, y0] = tbl[i - 1];
      const [x1, y1] = tbl[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return tbl[tbl.length - 1][1];
}
/** First-order lag toward target with time constant tau (exact discretisation). */
export const lag = (value, target, tau, dt) => (tau <= 0 ? target : target + (value - target) * Math.exp(-dt / tau));
