// atmosphere.js — ICAO standard atmosphere (troposphere and the isothermal
// layer above it, to 20 km) with a sea-level
// pressure and temperature offset, the two knobs a pilot meets as QNH and OAT.

export const P0 = 101325;     // Pa
export const T0 = 288.15;     // K
export const RHO0 = 1.225;    // kg/m³
export const L = 0.0065;      // K/m lapse rate
export const R = 287.053;     // J/(kg K)
export const GAMMA = 1.4;
const G = 9.80665;
const EXP = G / (R * L);      // 5.2559

/**
 * @param {number} h geometric altitude above mean sea level, m
 * @param {{ qnh?: number, dT?: number }} [wx] sea-level pressure (Pa) and ISA deviation (K)
 */
export function atmosphere(h, wx = {}) {
  const qnh = wx.qnh ?? P0;
  const dT = wx.dT ?? 0;
  const hc = Math.min(h, 11000);
  const Tstd = T0 - L * hc;
  let p = qnh * Math.pow(Tstd / T0, EXP);
  // above the tropopause the temperature stays put and the pressure falls off exponentially
  if (h > 11000) p *= Math.exp((-G * (h - 11000)) / (R * Tstd));
  const T = Tstd + dT;
  const rho = p / (R * T);
  const a = Math.sqrt(GAMMA * R * T);
  return { p, T, rho, a, sigma: rho / RHO0 };
}

/** Pressure altitude (m) a standard altimeter set to `kollsman` Pa shows for static pressure p. */
export function pressureAltitude(p, kollsman = P0) {
  const T11 = T0 - L * 11000;
  const p11 = kollsman * Math.pow(T11 / T0, EXP);
  if (p < p11) return 11000 + ((R * T11) / G) * Math.log(p11 / p);
  return (T0 / L) * (1 - Math.pow(p / kollsman, 1 / EXP));
}

/** Calibrated airspeed (m/s) from impact pressure qc (Pa), subsonic compressible pitot formula. */
export function casFromImpact(qc) {
  if (qc <= 0) return 0;
  const a0 = Math.sqrt(GAMMA * R * T0);
  return a0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

/** Impact pressure (Pa) a pitot sees at true airspeed V in an atmosphere {p, a}. */
export function impactPressure(V, { p, a }) {
  const M = V / a;
  return p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
}
