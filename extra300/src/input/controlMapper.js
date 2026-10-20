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
  throttleUp: ['r', 'PageUp', '=', '+', 'Shift'],
  throttleDown: ['f', 'PageDown', '-', 'Control'],
  throttleFull: ['End'],
  throttleIdle: ['Home'],
  propUp: [']'],
  propDown: ['['],
  trimUp: ["'"],    // nose up
  trimDown: [';'],  // nose down
  brakes: ['.', 'b'],
  starter: ['k'],
  fire: [' '],      // the X-wing's lasers (held)
  boost: ['Alt'],   // held with a stick key: pull (push, roll) twice as hard, through the buffet
};
// one-shot actions handled by the plugin
export const ACTIONS = {
  view: ['v'], panel: ['i'], reset: ['Backspace'], pause: ['p'], help: ['h', '?'],
  mixture: ['m'], parkingBrake: [','], autoRudder: ['u'], easy: ['l'], demo: ['o'], gReset: ['g'], kollsman: ['n'], exit: ['Escape'], yoke: ['y'], lookCenter: ['c'],
  gear: ['g'], speedbrake: ['j'],   // the jet's: G is the gear handle there (the Extra's G resets its g-meter)
  hook: ['/'],                      // the tail hook, for the carrier's wires
};

/**
 * Keys are a pilot's force, not a stick position. The aerodynamic load on a
 * control surface grows with dynamic pressure, so the same pull moves the
 * stick less the faster you go: full key ≈ 5 g at 170 kt, most of the
 * travel at 70 kt, all of it on the ground. deflection = force / (c·q + k0),
 * c and k0 fitted to those two points per axis. Alt (boost) pulls twice as hard.
 */
export const KEY_AUTHORITY = {
  elevator: { c: 0.000686, k0: 0.63 },
  aileron: { c: 0.000314, k0: 0.75 },
  rudder: { c: 0.000257, k0: 0.79 },
};
/** A pilot feels the buffet a couple of degrees before the stall and eases off there. */
export const BUFFET_ALPHA = 15.5 * Math.PI / 180;
const EASE_PER_RAD = 16;   // stick eased off per radian past the buffet [tune] tests/handling.test.js loops

/**
 * Easy mode: the elevator is never allowed to take the wing past the stall
 * (or past 7 g), from any input (Alt, pad, yoke), either way up; and the
 * torque is handled for you: rudder against the yaw in the air, the runway
 * heading held on the ground, and the bank held where you leave it.
 */
export const EASY = {
  alphaMax: 15.5 * Math.PI / 180,   // body α; the first wing strip stalls at 17.8° (sweeps at 80 and 140 kt)
  lead: 0.25,                        // s of α-rate the limiter looks ahead [tune] tests/handling.test.js easy
  kp: 3.0,                          // elevator per rad past the limit
  ki: 9.0,                          // per rad·s: learns the elevator that holds the limit
  liftoffMargin: 2 * Math.PI / 180, // the limit while the wheels are still on the ground is this much lower
  slew: 3.5,                        // elevator travel per s
  minQ: 60,                         // Pa (~20 kt): below this α means nothing
  rotateQ: 685,                     // Pa (65 kt): hands-off take-off, the nose comes up here
  climbPitch: 13 * Math.PI / 180,    // … to this attitude
  holdKp: 2.2, holdKi: 1.6, holdKd: 0.5,   // pitch hold: elevator per rad, per rad·s, per rad/s [tune] tests/handling.test.js
  gMax: 7, gMin: -4.5,              // and a load limit inside the airplane's ±10 g [tune]
  radPerG: 0.03,                    // α per g at aerobatic speeds, to fold the g limit into the same loop
  holdSpeedKt: [50, 95],            // the pitch hold: 8° nose-down at the first speed, up to 25° nose-up by the second
};

/** How much of its travel a held key may use without Alt. */
export const KEY_CAP = { elevator: 0.75, aileron: 0.5, rudder: 0.65 };
const BANK_HOLD_Q = 700;
const TRIM_Q = 700;        // Pa: the auto trim at full gain up to here (the same scaling as the bank hold)
const TRIM_PER_RATE = 1.2; // trim per rad/s of pitch rate, per second
const YAW_Q = 700;         // Pa: the yaw damper at full gain up to here (plugin of the same scaling as the bank hold)   // Pa (about 65 kt at sea level): easy mode's bank hold at full gain up to here

export function keyAuthority(axis, qbar, boost = 1, table = KEY_AUTHORITY) {
  const a = table[axis];
  return Math.min(1, boost / (a.c * Math.max(0, qbar) + a.k0));
}

/** Keys that move a control: pressing one during the demo flight takes over. */
export const FLIGHT_KEYS = ['pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight', 'throttleUp', 'throttleDown', 'throttleFull', 'throttleIdle', 'brakes'];

const expo = (x, e) => Math.sign(x) * (e * Math.abs(x) ** 3 + (1 - e) * Math.abs(x));
const dead = (x, d) => (Math.abs(x) < d ? 0 : Math.sign(x) * (Math.abs(x) - d) / (1 - d));

export class ControlMapper {
  /**
   * @param {object} [opts]
   * @param {object} [opts.handling]  the aircraft's own stick feel and easy-mode limits (spec.handling):
   *   { keyAuthority, keyCap, buffetAlpha, easy, throttleRate }, each over the Extra's defaults here
   */
  constructor(opts = {}) {
    this.setHandling(opts.handling);
    this.rampIn = opts.rampIn ?? 2.5;     // a held key reaches its pull in ~0.4 s …
    this.rampOut = opts.rampOut ?? 5.0;   // … and springs back in ~0.2 s
    this.expo = opts.expo ?? 0.45;
    this.kb = { aileron: 0, elevator: 0, rudder: 0 };
    this.throttle = 0;
    this.prop = 1;
    this.trim = 0;
    this.speedbrake = false;   // the jet's speed brake switch (J); B holds it out in the air
    this.gear = 1;             // the gear handle (G), down
    this.hook = 0;             // the hook handle (/), up
    this.sfoils = 0;           // the X-wing's S-foils (J): closed
    this.autoRudder = opts.autoRudder ?? true;   // the pilot's feet: keeps the ball centred in the air
    this.autoTrim = opts.autoTrim ?? true;       // the elevator trimmed for the attitude the stick was let go at
    this.yawKb = 1;     // rudder per rad of sideslip   } the yaw damper (_yawDamper), at full gain
    this.yawKr = 3;     // rudder per rad/s of yaw rate }
    this.yawKi = 1.5;   // the slow sideslip trim on top, per rad s
    this._rSteady = 0;  // the yaw rate's slow part (a turn's), which the damper leaves alone
    this._autoRud = 0;
    this.easy = opts.easy ?? false;
    this._lim = { hi: null, lo: null };   // active α-limiter integrators (null: not limiting)
    this._alphaPrev = null;
    this._alphaDot = 0;
    this._rudI = 0;
    this._phiRef = null;
    this._psiRef = null;
    this._ele = 0;
    this._thetaRef = null;
    this._holdI = 0;
  }

  /** Another airplane: its key feel and easy-mode limits. */
  setHandling(h = {}) {
    this.keyTable = { ...KEY_AUTHORITY, ...(h.keyAuthority || {}) };
    this.keyCap = { ...KEY_CAP, ...(h.keyCap || {}) };
    this.buffetAlpha = h.buffetAlpha ?? BUFFET_ALPHA;
    this.E = { ...EASY, ...(h.easy || {}) };
    this.throttleRate = h.throttleRate ?? 0.5;
  }

  /** Forget the held heading and bank (the airplane was put somewhere new). */
  resetHolds() {
    this._psiRef = this._phiRef = null;
    this._rudI = 0;
    this._lim.hi = this._lim.lo = null;
    this._thetaRef = null;
    this._holdI = 0;
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
   * @param {{ qbar?: number, alpha?: number, beta?: number, yawRate?: number, rollRate?: number, pitchRate?: number, heading?: number, bank?: number, pitch?: number, loadFactor?: number, onGround?: boolean, agl?: number, climbRate?: number, retractable?: boolean }} [flight]
   *   dynamic pressure (Pa), angle of attack and sideslip (rad), yaw and roll rate (rad/s), true heading, bank and pitch (rad), load factor: for
   *   the keyboard's pilot-force model, its feel for the buffet, the auto-rudder and easy mode
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
    const boost = P('boost') ? 2 : 1;
    // responsive but not slammed: the stick moves at once (steepest at the start of the press) and a
    // held key stops short of full travel; Alt takes the cap off
    const soft = (h, cap) => Math.sign(h) * Math.pow(Math.abs(h), 0.6) * (boost > 1 ? 1 : cap);
    let ail = soft(this.kb.aileron, this.keyCap.aileron) * keyAuthority('aileron', q, boost, this.keyTable);
    let ele = soft(this.kb.elevator, this.keyCap.elevator) * keyAuthority('elevator', q, boost, this.keyTable);
    // the keyboard pilot holds the pull at the buffet instead of pulling through it (Alt: through)
    const alpha = flight.alpha ?? 0;
    if (boost === 1 && q > 150 && !this.easy) {   // easy mode has its own, closer limit
      const ba = this.buffetAlpha;
      if (ele > 0 && alpha > ba) ele = Math.max(0, ele - EASE_PER_RAD * (alpha - ba));
      if (ele < 0 && alpha < -ba) ele = Math.min(0, ele - EASE_PER_RAD * (alpha + ba));
    }
    let rud = soft(this.kb.rudder, this.keyCap.rudder) * keyAuthority('rudder', q, boost, this.keyTable);
    // auto-rudder: right pedal for a sideslip from the right, damped by the yaw rate; any rudder
    // input from keys, pad or sticks takes over
    const target = this.easy ? this._easyRudder(flight, dt)
      : this.autoRudder && !flight.onGround && q > 300 ? this._yawDamper(flight, dt) : 0;
    this._autoRud += (target - this._autoRud) * Math.min(1, dt * 8);
    if (this.kb.rudder === 0) rud = this._autoRud;
    else { this._psiRef = null; this._rudI = 0; }   // the pilot steers: hold the new heading (and trim) after
    let brake = P('brakes') ? 1 : 0;
    let brakeL = brake, brakeR = brake;

    let elevIn = this.kb.elevator !== 0;   // is anyone asking for elevator? (easy mode's pitch hold steps in if not)
    const pad = raw.pad;
    if (pad && pad.axes && pad.axes.length >= 4) {
      const lx = dead(pad.axes[0], 0.08), ly = dead(pad.axes[1], 0.08), rx = dead(pad.axes[2], 0.1), ry = dead(pad.axes[3], 0.15);
      if (lx || ly) { ail = expo(lx, this.expo); ele = expo(ly, this.expo); }   // pull back (stick down) = +elevator
      if (ly) elevIn = true;
      if (rx) rud = expo(rx, 0.3);
      if (ry) this.throttle = clamp(this.throttle - ry * 0.6 * dt, 0, 1);
      const lt = pad.buttons?.[6] ?? 0, rt = pad.buttons?.[7] ?? 0;
      brakeL = Math.max(brakeL, lt); brakeR = Math.max(brakeR, rt);
      if (pad.buttons?.[12]) this.trim = clamp(this.trim - 0.25 * dt, -1, 1);   // d-pad up = nose down
      if (pad.buttons?.[13]) this.trim = clamp(this.trim + 0.25 * dt, -1, 1);
    }
    if (raw.left && (raw.left.x || raw.left.y)) { ail = expo(raw.left.x, this.expo); ele = expo(-raw.left.y, this.expo); }
    if (raw.left?.y) elevIn = true;
    if (raw.right && (raw.right.x || raw.right.y)) {
      rud = expo(raw.right.x, 0.3);
      this.throttle = clamp(this.throttle + raw.right.y * 0.6 * dt, 0, 1);
    }
    if (raw.yoke) { ail = expo(clamp(raw.yoke.x, -1, 1), this.expo); ele = expo(clamp(raw.yoke.y, -1, 1), this.expo); }
    if (raw.yoke && Math.abs(raw.yoke.y) > 0.02) elevIn = true;

    if (P('throttleUp')) this.throttle = clamp(this.throttle + this.throttleRate * dt, 0, 1);
    if (P('throttleDown')) this.throttle = clamp(this.throttle - this.throttleRate * dt, 0, 1);
    if (P('throttleFull')) this.throttle = 1;
    if (P('throttleIdle')) this.throttle = 0;
    if (P('propUp')) this.prop = clamp(this.prop + 0.4 * dt, 0, 1);
    if (P('propDown')) this.prop = clamp(this.prop - 0.4 * dt, 0, 1);
    if (P('trimUp')) this.trim = clamp(this.trim + 0.25 * dt, -1, 1);
    if (P('trimDown')) this.trim = clamp(this.trim - 0.25 * dt, -1, 1);

    // easy mode: with the stick let go, the airplane holds the attitude it was left in (and rotates for
    // the take-off by itself), so a thumb only has to say where to point it
    if (this.easy && !elevIn) ele = this._pitchHold(flight, dt);
    else { this._thetaRef = null; this._holdI = ele; }
    // normal mode's auto trim (easy mode's pitch hold trims for itself): stick free, the trim winds the
    // pitch rate away, so the airplane holds the attitude it was let go at instead of a key's release
    // pitching it back; the trim keys still nudge it
    if (!this.easy && this.autoTrim && !elevIn) this._autoTrim(flight, dt);
    ele = clamp(ele, -1, 1);
    if (this.easy) {
      // a stick slammed full back reaches the wing faster than any limiter can see it coming:
      // easy mode moves the elevator at most this fast (a brisk 0.3 s end to end)
      // (the stick itself is slewed; the limiter then works on that)
      const slew = this.E.slew * dt;
      // a fighter's stabilators would pull it far past its g limit before the loop below caught up:
      // bound the stick by dynamic pressure first ("q-feel": elevator per g falls as 1/q)
      if (this.E.elevPerGq && q > 0) {
        const up = ((this.E.gMax - 1) * this.E.elevPerGq) / q, down = ((1 - this.E.gMin) * this.E.elevPerGq) / q;
        ele = clamp(ele, -down, up);
      }
      this._ele = clamp(ele, this._ele - slew, this._ele + slew);
      ele = this._limitAlpha(this._ele, flight, dt);
    } else this._ele = ele;
    // easy mode holds the bank where the pilot left it, so the torque roll after lift-off and in the
    // climb is taken out with aileron; steep up or down, where bank means little, it only damps the roll
    if (this.easy && !flight.onGround && q > 40 && ail === 0 && this.kb.aileron === 0) {
      const p = flight.rollRate ?? 0, phi = flight.bank ?? 0;
      const steep = Math.abs(flight.pitch ?? 0) > 60 * Math.PI / 180;
      if (steep) this._phiRef = null;
      else if (this._phiRef == null) this._phiRef = phi;
      const err = steep ? 0 : Math.atan2(Math.sin(this._phiRef - phi), Math.cos(this._phiRef - phi));
      // the gains are for lift-off speeds: the aileron's bite grows with dynamic pressure, and at
      // speed, held for a frame of several sim steps, the same gains overcorrected every frame (the
      // aileron flapping side to side at 30 fps); scaled by q they ask for the same roll at any speed
      const g = Math.min(1, BANK_HOLD_Q / q);
      ail = clamp(g * (2 * err - 0.25 * p), -0.6, 0.6);
    } else this._phiRef = flight.onGround ? 0 : null;
    if (!this.easy) this._lim.hi = this._lim.lo = null;

    controls.aileron = clamp(ail, -1, 1);
    controls.elevator = ele;
    controls.rudder = clamp(rud, -1, 1);
    controls.throttle = this.throttle;
    controls.prop = this.prop;
    controls.elevatorTrim = this.trim;
    controls.brakeL = brakeL;
    controls.brakeR = brakeR;
    controls.starter = P('starter');
    // in the air the brake key works the speed brake (a jet's); on the wheels it is the wheel brakes
    controls.speedbrake = Math.max(this.speedbrake ? 1 : 0, !flight.onGround && brake ? 1 : 0);
    // easy mode works a retractable gear too: up once climbing away, down when coming back low and slow
    if (this.easy && flight.retractable && !flight.onGround) {
      const kt = Math.sqrt((2 * Math.max(0, q)) / 1.225) / 0.514444;
      if (this.gear === 1 && flight.agl > 15 && flight.climbRate > 2) { this.gear = 0; this.hook = 0; }
      else if (this.gear === 0 && flight.agl < 150 && flight.climbRate < -1 && kt < 220) { this.gear = 1; this.hook = flight.hasHook ? 1 : 0; }
    }
    if (flight.onGround) this.gear = 1;
    controls.gear = this.gear;
    controls.hook = this.hook;
    controls.sfoils = this.sfoils;
    controls.fire = P('fire') || !!(raw.pad?.buttons?.[0]) || !!raw.fire;
    return controls;
  }

  /**
   * Easy mode's α-limiter. Within 3° of the limit an integrator starts from the stick and learns the
   * elevator that holds α there; whatever asks for more (key, Alt, pad) gets that instead.
   * Mirrored for pushing.
   */
  _limitAlpha(ele, flight, dt) {
    const a = flight.alpha ?? 0;
    if (this._alphaPrev != null && dt > 0) this._alphaDot += ((a - this._alphaPrev) / dt - this._alphaDot) * Math.min(1, dt * 20);
    this._alphaPrev = a;
    // on the wheels too: the lift-off is where an over-rotation drops a wing (three-point α is ~12°)
    if ((flight.qbar ?? 0) < this.E.minQ) { this._lim.hi = this._lim.lo = null; return ele; }
    const pred = a + this.E.lead * this._alphaDot;
    // rotating on the main wheels the nose comes up fast: lift off with a couple of degrees in hand
    const alphaMax = this.E.alphaMax - (flight.onGround ? this.E.liftoffMargin : 0);
    for (const sgn of [1, -1]) {
      const key = sgn > 0 ? 'hi' : 'lo';
      const n = flight.loadFactor ?? 1;
      const gLeft = sgn > 0 ? this.E.gMax - n : n - this.E.gMin;
      const margin = Math.min(alphaMax - sgn * pred, gLeft * this.E.radPerG);   // rad left before a limit
      const e = sgn * ele;                                 // the stick, as a pull toward this limit
      if (margin > 6 * Math.PI / 180) { this._lim[key] = null; continue; }
      // never above the stick: when the stick asks for less there is nothing to limit
      const I = Math.max(-1, Math.min(1, e, (this._lim[key] ?? e) + this.E.ki * margin * dt));
      this._lim[key] = I;
      const cap = I + this.E.kp * margin;
      if (e > cap) ele = sgn * Math.max(-1, cap);
    }
    return ele;
  }

  /**
   * Easy mode's pitch hold, while nobody touches the elevator: on the take-off roll the nose comes up
   * to the climb attitude at 65 kt; in the air the pitch attitude the stick was released at is held
   * (within ±25°, and never more nose-up than the speed can carry), the elevator trimming itself through
   * an integrator. Upside down, near vertical or slow, it lets go: the α-limiter still guards the wing.
   */
  _pitchHold(flight, dt) {
    const q = flight.qbar ?? 0, theta = flight.pitch ?? 0, phi = flight.bank ?? 0;
    const qr = flight.pitchRate ?? 0;
    const D = Math.PI / 180;
    if (flight.onGround) {
      this._holdI = 0;
      this._thetaRef = q > this.E.rotateQ ? this.E.climbPitch : null;
      if (this._thetaRef == null) return 0;
    } else if (Math.abs(phi) > 80 * D || Math.abs(theta) > 80 * D || q < this.E.minQ) {
      // near vertical, banked past 80° or upside down, or no air over the wing: hands off, stick centred
      this._thetaRef = null;
      this._holdI = 0;
      return 0;
    } else if (this._thetaRef == null) {
      this._thetaRef = clamp(theta, -25 * D, 25 * D);
    }
    // never hold more nose-up than the speed can carry: the Extra's 25° above ~95 kt, level near 60,
    // nose down below (holdSpeedKt: where it is 8° nose-down and where 25° nose-up)
    const kt = Math.sqrt((2 * Math.max(0, q)) / 1.225) / 0.514444;
    const [lo, hi] = this.E.holdSpeedKt;
    const thetaMax = clamp(-8 * D + (kt - lo) * ((33 * D) / (hi - lo)), -8 * D, 25 * D);
    const target = flight.onGround ? this._thetaRef : Math.min(this._thetaRef, thetaMax);
    const err = target - theta;
    this._holdI = clamp((this._holdI ?? 0) + this.E.holdKi * err * dt, -0.6, 0.8);
    return clamp(this._holdI + this.E.holdKp * err - this.E.holdKd * qr, -1, 1);
  }

  /** The trim run toward no pitch rate, scaled by dynamic pressure; not on the wheels, steep, upside down or slow. */
  _autoTrim(flight, dt) {
    const q = flight.qbar ?? 0, D = Math.PI / 180;
    if (flight.onGround || q < 40 || Math.abs(flight.bank ?? 0) > 60 * D || Math.abs(flight.pitch ?? 0) > 60 * D) return;
    const g = Math.min(1, TRIM_Q / q);
    this.trim = clamp(this.trim - TRIM_PER_RATE * g * (flight.pitchRate ?? 0) * dt, -1, 1);
  }

  /** Easy mode's feet: the ball centred in the air (with an integrator for the climb torque), the heading held on the ground. */
  _easyRudder(flight, dt) {
    const q = flight.qbar ?? 0, r = flight.yawRate ?? 0, psi = flight.heading ?? 0;
    if (flight.onGround) {
      this._rudI = 0;
      if (this._psiRef == null) this._psiRef = psi;
      const err = Math.atan2(Math.sin(this._psiRef - psi), Math.cos(this._psiRef - psi));
      return clamp(3 * err - 1.2 * r, -1, 1);
    }
    this._psiRef = null;
    if (q < 40) return 0;
    return this._yawDamper(flight, dt);
  }

  /**
   * The pilot's feet in the air: rudder against the swing of the nose, and gently toward no sideslip.
   * It used to push hard toward no sideslip alone: let go after a bootful of rudder, it slammed the
   * opposite pedal while the nose was already swinging back, and swung it on through, side to side.
   * Only the yaw rate's changes are damped (a turn's steady rate washes out in ~1.5 s), and scaled by
   * dynamic pressure it asks for the same yaw at any speed (and holds steady at a low frame rate).
   */
  _yawDamper(flight, dt) {
    const q = flight.qbar ?? 0, g = Math.min(1, YAW_Q / Math.max(q, 1)), r = flight.yawRate ?? 0, beta = flight.beta ?? 0;
    this._rSteady += (r - this._rSteady) * Math.min(1, dt / 1.5);
    // the steady sideslip (the prop's swirl, the climb's p-factor) trimmed out slowly, on top
    this._rudI = clamp(this._rudI + this.yawKi * g * beta * dt, -0.6, 0.6);
    return clamp(g * (this.yawKb * beta - this.yawKr * (r - this._rSteady)) + this._rudI, -1, 1);
  }
}
