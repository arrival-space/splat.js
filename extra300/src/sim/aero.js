// aero.js — component build-up aerodynamics.
//
// Every lifting surface is cut into strips. Each strip sees its own local
// airflow: the aircraft's motion, plus its rotation (ω × r — this is where
// roll, pitch and yaw damping come from, no derivatives to tune), plus the
// propeller slipstream and its swirl, minus the wing's downwash at the tail.
// The strip's section works over the full ±180° range — linear lift, stall,
// flat-plate post-stall, reversed flow — so spins, snap rolls, knife-edge,
// tailslides and inverted flight come out of the geometry rather than out of
// a table someone had to measure.

import { cross, dot, length } from '../math/vec3.js';
import { clamp, DEG, lag, table1 } from './units.js';

const FLAT_PLATE_CL = 1.15;   // peak normal-force lift of a plate (Hoerner)
const FLAT_PLATE_CD = 1.95;

/** Flap effectiveness τ for a plain flap of chord fraction cf (thin-airfoil theory). */
export function flapTau(cf) {
  const th = Math.acos(2 * cf - 1);
  return 1 - (th - Math.sin(th)) / Math.PI;
}

/** Big deflections lose effectiveness (separation over the hinge line). */
export function deflectionEfficiency(delta) {
  const d = Math.abs(delta);
  return d <= 10 * DEG ? 1 : 1 - 0.4 * clamp((d - 10 * DEG) / (25 * DEG), 0, 1);
}

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Forward-flow lift for |alpha| in [0, pi/2]. A thick straight wing breaks sharply (22 % gone within 4°);
 * a thin swept one (stallDrop, stallWidth) rounds over gently and keeps most of its lift.
 */
function clForward(x, a, stall, lossFrac = 0.22, width = 4 * DEG) {
  const clmax = a * stall;
  if (x <= stall) return a * x;
  if (x <= stall + width) return clmax * (1 - lossFrac * ((x - stall) / width));
  const fp = FLAT_PLATE_CL * Math.sin(2 * x);
  const end = Math.max(40 * DEG, stall + width + 10 * DEG);
  const t = smooth(clamp((x - stall - width) / (end - stall - width), 0, 1));
  return (1 - lossFrac) * clmax * (1 - t) + fp * t;
}

/**
 * Section lift and drag over the full circle.
 * @returns {{ cl: number, cd: number, stalled: boolean }}
 */
export function sectionCoefficients(alpha, g, groundFactor = 1) {
  // wrap to (-pi, pi]
  let al = alpha;
  while (al > Math.PI) al -= 2 * Math.PI;
  while (al <= -Math.PI) al += 2 * Math.PI;
  const s = al < 0 ? -1 : 1;
  const x = Math.abs(al);
  let cl;
  let stalled;
  if (x <= Math.PI / 2) {
    cl = s * clForward(x, g.a, g.stall, g.stallDrop, g.stallWidth);
    stalled = x > g.stall;
  } else {
    // reversed flow: the section works backwards, with a worse slope and an earlier stall
    cl = -s * clForward(Math.PI - x, g.a * 0.7, g.stall * 0.75);
    stalled = Math.PI - x > g.stall * 0.75;
  }
  const induced = (cl * cl) / (Math.PI * g.e * g.aspect) * groundFactor;
  const plate = FLAT_PLATE_CD * Math.sin(x) ** 2;
  let cd = g.cd0 + induced;
  if (stalled || x > Math.PI / 2) cd = Math.max(cd, g.cd0 + plate);
  return { cl, cd, stalled };
}

/** Wing-in-ground-effect induced-drag factor (McCormick). */
export function groundEffectFactor(h, span) {
  if (!(h > 0)) return 0.0;
  if (h > 2 * span) return 1.0;
  const r = (16 * h) / span;
  return (r * r) / (1 + r * r);
}

export class Aero {
  /** @param {object} ac  aircraft data, e.g. EXTRA_300L from aircraft/extra300l.js */
  constructor(ac) {
    this.ac = ac;
    this.eps = 0;                 // tail downwash angle, lagged by the wing-to-tail transit time
    this.alphaBody = 0;
    this.betaBody = 0;
    this.strips = ac.aero.surfaces.map((s) => ({
      ...s,
      tau: s.control ? flapTau(s.control.chordFrac) : 0,
      // inner wing strips sit in the slipstream
      propwash: s.propwash ?? (ac.prop && s.group === 'wing' && Math.abs(s.pos[1]) < (ac.prop.diameter / 2) * 0.9 ? 0.55 : 0),
      out: { alpha: 0, cl: 0, stalled: false, q: 0 },
      deflection: 0,
    }));
  }

  /**
   * @param {object} p
   * @param {number[]} p.vAir   aircraft velocity through the air, body axes (m/s)
   * @param {number[]} p.omega  body rates (rad/s)
   * @param {number[]} p.cg     CG relative to the reference point (m)
   * @param {number} p.rho
   * @param {{aileron:number, elevator:number, rudder:number, elevatorTrim?:number}} p.controls
   * @param {{dv:number, swirl:number, rot:number}} p.slip  slipstream axial increment & swirl at the tail
   * @param {number} p.hWing   wing height above ground (m), Infinity in the air
   * @param {number} [p.mach]  flight Mach number (the jet's compressibility tables; the Extra never notices)
   * @param {number} p.dt
   * @returns {{ force: number[], moment: number[] }} body axes, about the CG
   */
  compute({ vAir, omega, cg, rho, controls, slip, hWing = Infinity, mach = 0, dt }) {
    const F = [0, 0, 0];
    const M = [0, 0, 0];
    const V = length(vAir);
    const gd = this.ac.aero.groupData;
    // compressibility: lift slope up toward Mach 1 and down past it, the drag rise through it
    const mt = this.ac.aero.mach;
    const liftK = mt ? table1(mt.lift, mach) : 1;
    const dragK = mt ? table1(mt.drag, mach) : 1;
    this.alphaBody = vAir[0] > 0.1 ? Math.atan2(vAir[2], vAir[0]) : 0;
    this.betaBody = V > 0.1 ? Math.asin(clamp(vAir[1] / V, -1, 1)) : 0;

    // downwash: dε/dα · α_wing, valid in the attached range, lagged by tail transit time
    const tailArm = 4.0;
    const aw = clamp(this.alphaBody, -gd.wing.stall, gd.wing.stall);
    this.eps = lag(this.eps, this.ac.aero.downwash.deda * aw, V > 1 ? tailArm / V : 0.5, dt);
    const ge = groundEffectFactor(hWing, this.ac.wing.span);

    const r = [0, 0, 0];
    const u = [0, 0, 0];
    const tmp = [0, 0, 0];
    for (const st of this.strips) {
      const g = gd[st.group];
      r[0] = st.pos[0] - cg[0]; r[1] = st.pos[1] - cg[1]; r[2] = st.pos[2] - cg[2];
      cross(omega, r, u);
      u[0] += vAir[0]; u[1] += vAir[1]; u[2] += vAir[2];
      if (st.propwash && slip) u[0] += st.propwash * slip.dv;
      if (st.swirl && slip) u[1] -= slip.rot * slip.swirl;

      // remove the spanwise component; the section only feels the chord-plane flow
      const us = dot(u, st.span);
      u[0] -= us * st.span[0]; u[1] -= us * st.span[1]; u[2] -= us * st.span[2];
      const Vp = length(u);
      if (Vp < 0.05) { st.out.q = 0; continue; }

      let alpha = Math.atan2(-dot(u, st.normal), u[0]) + (st.incidence || 0);
      if (st.downwash) alpha -= this.eps;

      let delta = 0;
      if (st.control) {
        let input = (controls[st.control.input] || 0) + (this.ac.rigging?.[st.control.input] || 0);
        if (st.control.input === 'elevator') input += 0.35 * (controls.elevatorTrim || 0);
        // a surface worked by two inputs (the F-15's stabilators: pitch together, roll differentially)
        if (st.control.mix) for (const m of st.control.mix) input += m.gain * (controls[m.input] || 0);
        input = clamp(input, -1, 1);
        delta = st.control.sign * input * st.control.maxDefl;
      }
      st.deflection = delta;
      // an all-moving surface turns as a whole: no hinge-line separation to lose effectiveness to
      const eff = st.control?.allMoving ? 1 : deflectionEfficiency(delta);
      const alphaEff = alpha + st.tau * eff * delta;
      // a trailing-edge flap raises the section's maximum lift, not only its lift at a given angle
      const flapStall = st.control?.clmaxGain && delta > 0 ? st.control.clmaxGain * st.tau * eff * delta : 0;
      const gs = mt || flapStall ? { ...g, a: g.a * liftK, cd0: g.cd0 * dragK, stall: g.stall + flapStall } : g;
      const sc = sectionCoefficients(alphaEff, gs, st.group === 'wing' ? ge : 1);
      const { cl, cd, stalled } = sc;

      const q = 0.5 * rho * Vp * Vp;
      const qS = q * st.area;
      // lift ⟂ local flow in the chord plane; drag opposes the strip's motion
      cross(st.span, u, tmp);
      const tl = length(tmp) || 1;
      const L = (qS * cl) / tl;
      const D = (-qS * cd) / Vp;
      const fx = L * tmp[0] + D * u[0];
      const fy = L * tmp[1] + D * u[1];
      const fz = L * tmp[2] + D * u[2];
      // past the stall the centre of pressure walks aft toward mid-chord
      const cpShift = stalled ? -0.18 * st.chord * clamp((Math.abs(alphaEff) - g.stall) / (25 * DEG), 0, 1) : 0;
      const rx = r[0] + cpShift;
      F[0] += fx; F[1] += fy; F[2] += fz;
      M[0] += r[1] * fz - r[2] * fy;
      M[1] += r[2] * fx - rx * fz;
      M[2] += rx * fy - r[1] * fx;
      st.out.alpha = alphaEff; st.out.cl = cl; st.out.stalled = stalled; st.out.q = q;
    }

    // fuselage, gear, canopy: parasite drag + crossflow lift/side force
    const b = this.ac.aero.body;
    if (V > 0.05) {
      const q = 0.5 * rho * V * V;
      const sa = vAir[1] / V;   // sin β
      const sz = vAir[2] / V;   // sin α (approx.)
      const ca = Math.abs(vAir[0]) / V;
      const Y = -q * b.sideArea * (b.sideSlope * sa * ca + 1.1 * sa * Math.abs(sa));
      const Z = -q * b.topArea * (b.topSlope * sz * ca + 1.1 * sz * Math.abs(sz));
      // the gear hanging out and the speed brake up add their own flat-plate drag
      const extra = (b.gearDragArea || 0) * (controls.gearPos ?? 1) + (b.speedbrakeDragArea || 0) * (controls.speedbrakePos || 0)
        + (b.sfoilDragArea || 0) * (controls.sfoilPos || 0);
      const Dk = -q * (b.dragArea * dragK + extra) / V;
      const fx = Dk * vAir[0];
      const fy = Dk * vAir[1] + Y;
      const fz = Dk * vAir[2] + Z;
      r[0] = b.pos[0] - cg[0]; r[1] = b.pos[1] - cg[1]; r[2] = b.pos[2] - cg[2];
      F[0] += fx; F[1] += fy; F[2] += fz;
      M[0] += r[1] * fz - r[2] * fy;
      M[1] += r[2] * fx - r[0] * fz;
      M[2] += r[0] * fy - r[1] * fx;
    }
    return { force: F, moment: M };
  }

  /** Highest fraction of wing strips that are stalled (0..1) — for the buffet and stall horn. */
  wingStallFraction() {
    let n = 0, s = 0;
    for (const st of this.strips) if (st.group === 'wing') { n++; if (st.out.stalled) s++; }
    return n ? s / n : 0;
  }
}
