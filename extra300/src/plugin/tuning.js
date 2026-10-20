// tuning.js — an airplane vibe's entry (plugin/aircraftVibe.js) made into the profile the flight vibe
// flies: its base airplane's (plugin/profiles.js), with the flight model tuned and the paint changed.

import { BASE_AIRCRAFT } from './flightRegistry.js';
import { PROFILES } from './profiles.js';

const DEG = Math.PI / 180;

// the model materials the two paint settings recolour, per airplane
export const PAINT = { extra300l: ['white', 'red'], f15c: ['grey', 'darkGrey'], xwing: ['white', 'red'], b777: ['white', 'blue'] };

/** An entry with nothing changed: the base airplane as it is (what's listed without airplane vibes). */
export function plainAircraft(base) {
  return {
    id: base, base, title: BASE_AIRCRAFT[base], paint: null, trim: null, power: 1, mass: 1, lift: 1, controls: 1,
    fuel: -1, chaseDistance: 1, seatHeight: 0, seatForward: 0, startHere: false, order: Object.keys(BASE_AIRCRAFT).indexOf(base),
  };
}

// plain data, deeply (the specs are plain objects and arrays)
const clone = (o) => (Array.isArray(o) ? o.map(clone)
  : o && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clone(v)])) : o);

/** A flight-model spec tuned: power, mass, lift and control authority as factors, fuel as % of the tanks. */
export function tuneSpec(spec, t) {
  const s = clone(spec);
  if (t.power !== 1) {
    if (s.engine?.ratedPower) s.engine.ratedPower *= t.power;
    if (s.jet) for (const k of ['milThrust', 'maxThrust', 'idleThrust']) if (s.jet[k]) s.jet[k] *= t.power;
  }
  if (t.mass !== 1) {
    s.mass.empty.m *= t.mass;
    for (const k of Object.keys(s.mass.inertiaEmpty || {})) s.mass.inertiaEmpty[k] *= t.mass;
    // the gear carries it as before: a heavier airplane on stiffer springs, not sitting on its stops
    for (const u of s.gear?.units || []) { if (u.k) u.k *= t.mass; if (u.c) u.c *= t.mass; }
  }
  if (t.lift !== 1 && s.aero?.groupData?.wing) {
    const w = s.aero.groupData.wing;
    w.stall = Math.min(40 * DEG, w.stall * t.lift);   // CLmax = a·stall: the stall speed goes as 1/√lift
  }
  if (t.controls !== 1) {
    for (const st of s.aero?.surfaces || []) {
      if (st.control && ['aileron', 'elevator', 'rudder'].includes(st.control.input)) st.control.maxDefl = Math.min(45 * DEG, st.control.maxDefl * t.controls);
    }
    if (s.thrusters) for (const k of ['roll', 'pitch', 'yaw']) if (s.thrusters[k]) s.thrusters[k] *= t.controls;
  }
  if (t.fuel >= 0 && s.mass.items) {
    const f = Math.min(100, t.fuel) / 100;
    s.mass.defaultLoad = { ...(s.mass.defaultLoad || {}), fuelCenterL: (s.mass.items.fuelCenter?.capacityL || 0) * f, fuelWingsL: (s.mass.items.fuelWings?.capacityL || 0) * f };
  }
  return s;
}

const cache = new Map();

/**
 * The profile an entry flies: its base's, the spec tuned, the paint changed, the chase camera and the
 * pilot's seat moved. `id` stays the base's (the intro, the demo, the sound go by it); `entryId` is the
 * entry's. Made once per entry as it is (a changed entry makes a new one).
 */
export function tunedProfile(entry) {
  const key = JSON.stringify({ ...entry, park: undefined });   // (where it is parked doesn't change the airplane)
  if (cache.has(key)) return cache.get(key);
  const base = PROFILES[entry.base] || PROFILES.extra300l;
  const paints = PAINT[base.id] || [];
  const recolour = { [paints[0]]: entry.paint, [paints[1]]: entry.trim };
  const p = {
    ...base,
    entryId: entry.id,
    title: entry.title,
    spec: tuneSpec(base.spec, entry),
    chaseSize: base.chaseSize * (entry.chaseDistance || 1),
    seatAdjust: { up: entry.seatHeight || 0, forward: entry.seatForward || 0 },
    fuelL: entry.fuel >= 0 ? (base.spec.mass.items?.fuelCenter?.capacityL || 0) * Math.min(100, entry.fuel) / 100 : null,
    buildModel: () => base.buildModel().map((part) => (recolour[part.material] ? { ...part, color: recolour[part.material] } : part)),
  };
  cache.set(key, p);
  return p;
}
