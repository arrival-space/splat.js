// controlMapper.js — turns raw device state into flight controls.
//
// Pure logic: the plugin samples the keyboard / gamepad / touch sticks /
// mouse each frame into a plain `raw` object and this decides what the
// aircraft gets. Keyboard axes ramp in and spring back like the classic
// Flight Simulator keyboard controls; analog axes get a deadzone and an
// exponential curve so small corrections stay small on an airplane that
// rolls at 400°/s.

import { clamp } from '../sim/units.js';

export const BINDINGS = {
  pitchDown: ['ArrowUp', 'w'],
  pitchUp: ['ArrowDown', 's'],
  rollLeft: ['ArrowLeft', 'a'],
  rollRight: ['ArrowRight', 'd'],
  yawLeft: ['q', 'z'],
  yawRight: ['e', 'x'],
  throttleUp: ['r', 'PageUp', '=', '+'],
  throttleDown: ['f', 'PageDown', '-'],
  throttleFull: ['End'],
  throttleIdle: ['Home'],
  propUp: [']'],
  propDown: ['['],
  trimUp: ["'"],    // nose up
  trimDown: [';'],  // nose down
  brakes: ['.', 'b'],
  starter: ['k'],
};
// one-shot actions handled by the plugin
export const ACTIONS = {
  view: ['v'], panel: ['i'], reset: ['Backspace'], pause: ['p'], help: ['h', '?'],
  mixture: ['m'], parkingBrake: [','], autoRudder: ['u'], demo: ['o'], gReset: ['g'], kollsman: ['n'], exit: ['Escape'], yoke: ['y'], lookCenter: ['c'],
};

/**
 * Keys are a pilot's force, not a stick position. The aerodynamic load on a
 * control surface grows with dynamic pressure, so the same pull moves the
 * stick less the faster you go: full key ≈ 5 g at 170 kt, most of the
 * travel at 70 kt, all of it on the ground. deflection = force / (c·q + k0),
 * c and k0 fitted to those two points per axis. Shift pulls twice as hard.
 */
export const KEY_AUTHORITY = {
  elevator: { c: 0.000686, k0: 0.63 },
  aileron: { c: 0.000314, k0: 0.75 },
  rudder: { c: 0.000257, k0: 0.79 },
};
/** A pilot feels the buffet a couple of degrees before the stall and eases off there. */
export const BUFFET_ALPHA = 15.5 * Math.PI / 180;
const EASE_PER_RAD = 16;   // stick eased off per radian past the buffet [tune] tests/handling.test.js loops

/** How much of its travel a held key may use without Shift. */
export const KEY_CAP = { elevator: 0.75, aileron: 0.5, rudder: 0.65 };

export function keyAuthority(axis, qbar, boost = 1) {
  const a = KEY_AUTHORITY[axis];
  return Math.min(1, boost / (a.c * Math.max(0, qbar) + a.k0));
}

/** Keys that move a control: pressing one during the demo flight takes over. */
export const FLIGHT_KEYS = ['pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight', 'throttleUp', 'throttleDown', 'throttleFull', 'throttleIdle', 'brakes'];

const expo = (x, e) => Math.sign(x) * (e * Math.abs(x) ** 3 + (1 - e) * Math.abs(x));
const dead = (x, d) => (Math.abs(x) < d ? 0 : Math.sign(x) * (Math.abs(x) - d) / (1 - d));

export class ControlMapper {
  constructor(opts = {}) {
    this.rampIn = opts.rampIn ?? 2.5;     // a held key reaches its pull in ~0.4 s …
    this.rampOut = opts.rampOut ?? 5.0;   // … and springs back in ~0.2 s
    this.expo = opts.expo ?? 0.45;
    this.kb = { aileron: 0, elevator: 0, rudder: 0 };
    this.throttle = 0;
    this.prop = 1;
    this.trim = 0;
    this.autoRudder = opts.autoRudder ?? true;   // the pilot's feet: keeps the ball centred in the air
    this._autoRud = 0;
  }

  static pressed(keys, names) {
    for (const n of names) if (keys.has(n) || keys.has(n.toLowerCase())) return true;
    return false;
  }

  /**
   * @param {object} raw
   * @param {Set<string>} raw.keys          keys currently held (KeyboardEvent.key)
   * @param {{x:number,y:number}} [raw.left]   touch left stick  (x right, y up = push forward)
   * @param {{x:number,y:number}} [raw.right]  touch right stick
   * @param {object} [raw.pad]   { axes: number[], buttons: number[] } standard mapping, values 0..1
   * @param {{x:number,y:number}|null} [raw.yoke] mouse yoke, -1..1 from screen centre
   * @param {number} dt
   * @param {object} controls  aircraft controls object, written in place
   * @param {{ qbar?: number, alpha?: number, beta?: number, yawRate?: number, onGround?: boolean }} [flight]
   *   dynamic pressure (Pa), angle of attack and sideslip (rad), yaw rate (rad/s): for the keyboard's
   *   pilot-force model, its feel for the buffet, and the auto-rudder
   */
  update(raw, dt, controls, flight = {}) {
    const k = raw.keys || new Set();
    const P = (b) => ControlMapper.pressed(k, BINDINGS[b]);
    const ramp = (cur, dir) => {
      if (dir !== 0) return clamp(cur + dir * this.rampIn * dt * (Math.sign(cur) === -dir ? 2 : 1), -1, 1);
      const back = this.rampOut * dt;
      return Math.abs(cur) <= back ? 0 : cur - Math.sign(cur) * back;
    };
    this.kb.aileron = ramp(this.kb.aileron, (P('rollRight') ? 1 : 0) - (P('rollLeft') ? 1 : 0));
    this.kb.elevator = ramp(this.kb.elevator, (P('pitchUp') ? 1 : 0) - (P('pitchDown') ? 1 : 0));
    this.kb.rudder = ramp(this.kb.rudder, (P('yawRight') ? 1 : 0) - (P('yawLeft') ? 1 : 0));

    const q = flight.qbar ?? 0;
    const boost = k.has('Shift') ? 2 : 1;
    // responsive but not slammed: the stick moves at once (steepest at the start of the press) and a
    // held key stops short of full travel; Shift takes the cap off
    const soft = (h, cap) => Math.sign(h) * Math.pow(Math.abs(h), 0.6) * (boost > 1 ? 1 : cap);
    let ail = soft(this.kb.aileron, KEY_CAP.aileron) * keyAuthority('aileron', q, boost);
    let ele = soft(this.kb.elevator, KEY_CAP.elevator) * keyAuthority('elevator', q, boost);
    // the keyboard pilot holds the pull at the buffet instead of pulling through it (Shift: through)
    const alpha = flight.alpha ?? 0;
    if (boost === 1 && q > 150) {
      if (ele > 0 && alpha > BUFFET_ALPHA) ele = Math.max(0, ele - EASE_PER_RAD * (alpha - BUFFET_ALPHA));
      if (ele < 0 && alpha < -BUFFET_ALPHA) ele = Math.min(0, ele - EASE_PER_RAD * (alpha + BUFFET_ALPHA));
    }
    let rud = soft(this.kb.rudder, KEY_CAP.rudder) * keyAuthority('rudder', q, boost);
    // auto-rudder: right pedal for a sideslip from the right, damped by the yaw rate; any rudder
    // input from keys, pad or sticks takes over
    const target = this.autoRudder && !flight.onGround && q > 300
      ? clamp(4 * (flight.beta ?? 0) - 0.4 * (flight.yawRate ?? 0), -1, 1) : 0;
    this._autoRud += (target - this._autoRud) * Math.min(1, dt * 8);
    if (this.kb.rudder === 0) rud = this._autoRud;
    let brake = P('brakes') ? 1 : 0;
    let brakeL = brake, brakeR = brake;

    const pad = raw.pad;
    if (pad && pad.axes && pad.axes.length >= 4) {
      const lx = dead(pad.axes[0], 0.08), ly = dead(pad.axes[1], 0.08), rx = dead(pad.axes[2], 0.1), ry = dead(pad.axes[3], 0.15);
      if (lx || ly) { ail = expo(lx, this.expo); ele = expo(ly, this.expo); }   // pull back (stick down) = +elevator
      if (rx) rud = expo(rx, 0.3);
      if (ry) this.throttle = clamp(this.throttle - ry * 0.6 * dt, 0, 1);
      const lt = pad.buttons?.[6] ?? 0, rt = pad.buttons?.[7] ?? 0;
      brakeL = Math.max(brakeL, lt); brakeR = Math.max(brakeR, rt);
      if (pad.buttons?.[12]) this.trim = clamp(this.trim - 0.25 * dt, -1, 1);   // d-pad up = nose down
      if (pad.buttons?.[13]) this.trim = clamp(this.trim + 0.25 * dt, -1, 1);
    }
    if (raw.left && (raw.left.x || raw.left.y)) { ail = expo(raw.left.x, this.expo); ele = expo(-raw.left.y, this.expo); }
    if (raw.right && (raw.right.x || raw.right.y)) {
      rud = expo(raw.right.x, 0.3);
      this.throttle = clamp(this.throttle + raw.right.y * 0.6 * dt, 0, 1);
    }
    if (raw.yoke) { ail = expo(clamp(raw.yoke.x, -1, 1), this.expo); ele = expo(clamp(raw.yoke.y, -1, 1), this.expo); }

    if (P('throttleUp')) this.throttle = clamp(this.throttle + 0.5 * dt, 0, 1);
    if (P('throttleDown')) this.throttle = clamp(this.throttle - 0.5 * dt, 0, 1);
    if (P('throttleFull')) this.throttle = 1;
    if (P('throttleIdle')) this.throttle = 0;
    if (P('propUp')) this.prop = clamp(this.prop + 0.4 * dt, 0, 1);
    if (P('propDown')) this.prop = clamp(this.prop - 0.4 * dt, 0, 1);
    if (P('trimUp')) this.trim = clamp(this.trim + 0.25 * dt, -1, 1);
    if (P('trimDown')) this.trim = clamp(this.trim - 0.25 * dt, -1, 1);

    controls.aileron = clamp(ail, -1, 1);
    controls.elevator = clamp(ele, -1, 1);
    controls.rudder = clamp(rud, -1, 1);
    controls.throttle = this.throttle;
    controls.prop = this.prop;
    controls.elevatorTrim = this.trim;
    controls.brakeL = brakeL;
    controls.brakeR = brakeR;
    controls.starter = P('starter');
    return controls;
  }
}
