// aircraft.js — the flight model: one rigid body with a spinning propeller,
// stepped at a fixed 480 Hz no matter what the display does.
//
// Earth frame is local NED (north, east, down) about a datum point; the
// world module decides where that is (Meigs Field). Everything in here is
// SI and free of PlayCanvas so it runs the same under `node --test`.

import { add, cross, inertiaMul, inertiaSolve, length } from '../math/vec3.js';
import { qFromEuler, qIntegrate, qRotate, qRotateInv, qToEuler } from '../math/quat.js';
import { Aero } from './aero.js';
import { atmosphere } from './atmosphere.js';
import { Engine } from './engine.js';
import { Gear } from './gear.js';
import { massProperties } from './massprops.js';
import { Propeller } from './propeller.js';
import { clamp, G0, RPM } from './units.js';

export const SIM_HZ = 480;
const H = 1 / SIM_HZ;
const MAX_SUBSTEPS = 48;          // 0.1 s per frame at most; slower frames run the sim slower, not unstable

export function defaultControls() {
  return {
    aileron: 0, elevator: 0, rudder: 0, elevatorTrim: 0,
    throttle: 0, prop: 1, mixture: 1, magnetos: true, starter: false,
    brakeL: 0, brakeR: 0, parkingBrake: false,
  };
}

export class Aircraft {
  /**
   * @param {object} spec  aircraft data (see aircraft/extra300l.js)
   * @param {object} [opts]
   * @param {object} [opts.load]  { pilot, passenger, baggage, fuelCenterL, fuelWingsL }
   * @param {(n:number, e:number) => {h:number, normal:number[], surface:string}} [opts.ground]
   * @param {number} [opts.datumMsl]  MSL height of the earth-frame origin, m
   * @param {object} [opts.weather]  { qnh, dT, wind: [n, e, d] m/s (air velocity, NED) }
   */
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.ground = opts.ground || (() => ({ h: 0, normal: [0, 0, -1], surface: 'asphalt' }));
    this.datumMsl = opts.datumMsl ?? 0;
    this.weather = { qnh: 101325, dT: 0, wind: [0, 0, 0], ...(opts.weather || {}) };
    this.load = { fuelCenterL: spec.mass.items.fuelCenter.capacityL, fuelWingsL: 0, ...(opts.load || {}) };

    this.aero = new Aero(spec);
    this.engine = new Engine(spec.engine);
    this.prop = new Propeller(spec.prop);
    this.gear = new Gear(spec.gear);
    this.controls = defaultControls();

    this.state = { pos: [0, 0, 0], vel: [0, 0, 0], q: [1, 0, 0, 0], omega: [0, 0, 0] };
    this.rpm = 0;
    this.time = 0;
    this._acc = 0;
    this.out = {
      vAirBody: [0, 0, 0], tas: 0, alpha: 0, beta: 0, specificForce: [0, 0, -G0], loadFactor: 1,
      atm: atmosphere(this.datumMsl, this.weather), qbar: 0,
    };
    this.events = [];
    this.damage = { propStrike: false, gearCollapsed: false, crashed: false };
    this.updateMass();
  }

  updateMass() {
    const mp = massProperties(this.spec.mass, this.load);
    this.mass = mp.mass;
    this.cg = mp.cg;
    this.inertia = mp.inertia;
  }

  get altitudeMsl() { return this.datumMsl - this.state.pos[2]; }
  get euler() { return qToEuler(this.state.q); }
  get fuelL() { return this.load.fuelCenterL + this.load.fuelWingsL; }

  /** Put the aircraft at rest on its three wheels at (n, e) facing `heading` (rad, true). */
  placeOnGround(n, e, heading) {
    const g = this.spec.gear.units;
    const main = g[0], tail = g[2];
    const theta = Math.atan2(main.pos[2] - tail.pos[2], main.pos[0] - tail.pos[0]);
    const q = qFromEuler(0, theta, heading);
    const gh = this.ground(n, e).h;
    // CG height so the extended main wheel just touches, then sink by the static deflection
    const rel = [main.pos[0] - this.cg[0], main.pos[1] - this.cg[1], main.pos[2] - this.cg[2]];
    const re = qRotate(q, rel);
    const staticDefl = (this.mass * G0 * 0.45) / main.k;
    this.state = { pos: [n, e, -gh - re[2] + staticDefl], vel: [0, 0, 0], q, omega: [0, 0, 0] };
    this.aero.eps = 0;
    this.damage = { propStrike: false, gearCollapsed: false, crashed: false };
  }

  /** Start in the air at a given true airspeed, level, wings level. */
  placeInFlight(n, e, altMsl, heading, tas, alpha = 3 * Math.PI / 180) {
    const q = qFromEuler(0, alpha, heading);
    const vb = [tas * Math.cos(alpha), 0, tas * Math.sin(alpha)];
    this.state = { pos: [n, e, this.datumMsl - altMsl], vel: qRotate(q, vb), q, omega: [0, 0, 0] };
    this.engine.running = true;
    this.rpm = 2400;
    this.prop.lastRpm = this.rpm;
    this.damage = { propStrike: false, gearCollapsed: false, crashed: false };
  }

  /** Advance by a frame time; runs whole 480 Hz substeps and carries the remainder. */
  update(dt) {
    this._acc += Math.min(dt, MAX_SUBSTEPS * H);
    let n = 0;
    while (this._acc >= H && n < MAX_SUBSTEPS) {
      this.step(H);
      this._acc -= H;
      n++;
    }
    return n;
  }

  step(h) {
    const st = this.state;
    const c = this.controls;
    const sp = this.spec;
    const atm = atmosphere(this.altitudeMsl, this.weather);
    const w = this.weather.wind;

    // airflow
    const vAirE = [st.vel[0] - w[0], st.vel[1] - w[1], st.vel[2] - w[2]];
    const vAirB = qRotateInv(st.q, vAirE);
    const tas = length(vAirB);
    const qbar = 0.5 * atm.rho * tas * tas;

    // powerplant: governor + blade element prop + breathing engine, coupled through the shaft
    const fuelAvailable = this.fuelL > 0.05 && !this.damage.propStrike;
    this.prop.update(vAirB[0], this.rpm, atm.rho, c.prop, h);
    this.engine.update(c, this.rpm, atm, 0.6 * qbar, tas, fuelAvailable, h);
    const Irot = sp.engine.rotInertia;
    const omegaShaft = this.rpm * RPM + ((this.engine.torque - this.prop.torque) / Irot) * h;
    this.rpm = Math.max(0, omegaShaft / RPM);
    if (this.damage.propStrike) this.rpm *= Math.exp(-h * 8);
    this.burnFuel(this.engine.fuelFlow * h);

    // forces & moments in body axes about the CG
    const rot = sp.engine.rotation;
    const hWing = this.wingHeight();
    const aero = this.aero.compute({
      vAir: vAirB, omega: st.omega, cg: this.cg, rho: atm.rho, controls: c,
      slip: { dv: this.prop.slipDv, swirl: this.prop.swirl, rot }, hWing, dt: h,
    });
    const F = aero.force;
    const M = aero.moment;

    // thrust along the crankshaft, its line pushed sideways by P-factor
    const T = this.prop.thrust;
    const R = this.prop.R;
    const Vp = Math.max(tas, 5);
    const pf = sp.prop.pFactor * R * rot / Vp;
    const rT = [sp.prop.pos[0] - this.cg[0], sp.prop.pos[1] - this.cg[1] + pf * vAirB[2], sp.prop.pos[2] - this.cg[2] - pf * vAirB[1]];
    F[0] += T;
    M[1] += rT[2] * T;
    M[2] += -rT[1] * T;
    // the engine twists the airframe the other way
    M[0] += -rot * this.engine.torque;

    const gear = this.gear.compute(st, this.cg, c, this.ground, h);
    add(F, gear.force, F);
    add(M, gear.moment, M);
    for (const e of this.gear.events) this.onEvent(e);
    this.gear.events.length = 0;

    // translational dynamics (earth frame)
    const Fe = qRotate(st.q, F);
    const m = this.mass;
    st.vel[0] += (Fe[0] / m) * h;
    st.vel[1] += (Fe[1] / m) * h;
    st.vel[2] += (Fe[2] / m + G0) * h;
    st.pos[0] += st.vel[0] * h;
    st.pos[1] += st.vel[1] * h;
    st.pos[2] += st.vel[2] * h;

    // rotational dynamics with the propeller's angular momentum (gyroscopic precession)
    const Hrot = [rot * Irot * this.rpm * RPM, 0, 0];
    const L = inertiaMul(this.inertia, st.omega);
    L[0] += Hrot[0];
    const gyro = cross(st.omega, L);
    const wdot = inertiaSolve(this.inertia, [M[0] - gyro[0], M[1] - gyro[1], M[2] - gyro[2]]);
    st.omega[0] += wdot[0] * h;
    st.omega[1] += wdot[1] * h;
    st.omega[2] += wdot[2] * h;
    qIntegrate(st.q, st.omega, h);

    this.time += h;
    const o = this.out;
    o.vAirBody = vAirB;
    o.tas = tas;
    o.qbar = qbar;
    o.atm = atm;
    o.alpha = Math.atan2(vAirB[2], vAirB[0]);
    o.beta = tas > 0.1 ? Math.asin(clamp(vAirB[1] / tas, -1, 1)) : 0;
    o.specificForce = [F[0] / m, F[1] / m, F[2] / m];
    o.loadFactor = -o.specificForce[2] / G0;
    o.gear = gear;
  }

  wingHeight() {
    const st = this.state;
    const g = this.ground(st.pos[0], st.pos[1]);
    const agl = -st.pos[2] - g.h;
    return agl < this.spec.wing.span * 2 ? Math.max(0.1, agl) : Infinity;
  }

  burnFuel(kg) {
    if (kg <= 0) return;
    const L = kg / this.spec.mass.fuelDensity;
    if (this.load.fuelCenterL > 0) this.load.fuelCenterL = Math.max(0, this.load.fuelCenterL - L);
    else this.load.fuelWingsL = Math.max(0, this.load.fuelWingsL - L);
    // re-balance a few times a second, not every substep
    this._massAcc = (this._massAcc || 0) + L;
    if (this._massAcc > 0.05) { this._massAcc = 0; this.updateMass(); }
  }

  onEvent(e) {
    if (e === 'propStrike' && this.rpm > 100) {
      this.damage.propStrike = true;
      this.engine.running = false;
    }
    if (e === 'splash') this.damage.crashed = true;
    this.events.push({ t: this.time, e });
  }

  /** NED position of the reference point R (the model origin), which sits at -cg from the CG. */
  referencePoint() {
    const r = qRotate(this.state.q, [-this.cg[0], -this.cg[1], -this.cg[2]]);
    const p = this.state.pos;
    return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
  }

  /** Ground speed, m/s. */
  get groundSpeed() { return Math.hypot(this.state.vel[0], this.state.vel[1]); }

  /** Height of the CG above the ground, m. */
  get agl() {
    const st = this.state;
    return -st.pos[2] - this.ground(st.pos[0], st.pos[1]).h;
  }
}
