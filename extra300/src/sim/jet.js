// jet.js — a pair of afterburning turbofans (the F-15's two F100-PW-220s) as
// one throttle, one spool and one afterburner.
//
// The throttle asks for a core speed; the spool follows it with a lag that is
// slow near idle and quick near military power, the way a turbine accelerates.
// Dry thrust grows with core speed from idle to military power; past the
// afterburner detent the burner lights after a short delay and its share
// builds with its own lag. Both lapse with air density and pick up ram
// recovery with Mach (the afterburner far more than the dry engine), and the
// fuel flow follows the thrust through each regime's specific consumption.
// The jet fuel starter spins the core up to light-off; from there the engine
// accelerates to idle by itself.

import { clamp, lag, table1 } from './units.js';

export class JetEngine {
  constructor(spec) {
    this.spec = spec;
    this.running = false;
    this.n2 = 0;            // core speed, % (the "rpm" gauge)
    this.ab = 0;            // afterburner, 0..1 of its full share
    this.thrust = 0;        // N, all engines together
    this.fuelFlow = 0;      // kg/s, all engines
    this.ftit = 15;         // °C, fan turbine inlet temperature
    this.nozzle = 0.8;      // 0 closed .. 1 wide open
    this.oilPress = 0;      // psi
    this.power = 0;         // 0..1 for the sound: dry share of military power (+ the burner on top)
    this._abDelay = 0;
  }

  /** Throttle 0..1 → (dry 0..1, burner 0..1). The detent sits at `abDetent`. */
  split(throttle) {
    const d = this.spec.abDetent;
    const t = clamp(throttle, 0, 1);
    return t <= d ? { dry: t / d, ab: 0 } : { dry: 1, ab: (t - d) / (1 - d) };
  }

  /** Put it straight at idle (or stop it): a started engine, a cold one. */
  setRunning(on) {
    this.running = on;
    this.n2 = on ? this.spec.idleN2 : 0;
    this.ab = 0;
    this.ftit = on ? this.spec.ftitIdle : 15;
    this.oilPress = on ? 45 : 0;
  }

  /**
   * @param {object} c  controls { throttle, mixture (fuel shut-off), starter }
   * @param {{sigma:number, T:number}} atm
   * @param {number} mach
   * @param {boolean} fuelAvailable
   * @param {number} dt
   */
  update(c, atm, mach, fuelAvailable, dt) {
    const s = this.spec;
    const fuelOn = (c.mixture ?? 1) > 0.05 && fuelAvailable;
    // light-off once the starter has the core turning fast enough; flame-out without fuel
    if (!this.running && fuelOn && this.n2 >= s.lightOffN2) this.running = true;
    if (this.running && (!fuelOn || this.n2 < s.lightOffN2 * 0.8)) this.running = false;

    const { dry, ab } = this.split(c.throttle ?? 0);
    let target;
    if (this.running) target = s.idleN2 + (s.milN2 - s.idleN2) * dry;
    else if (c.starter) target = s.starterN2;
    else target = 0;
    // a turbine is sluggish at low speed and brisk near the top
    const tau = this.running ? this._spoolTau() : target > this.n2 ? s.starterTau : s.windDownTau;
    // ram air keeps a dead engine windmilling
    const windmill = this.running ? 0 : clamp(mach * 30, 0, 22);
    this.n2 = lag(this.n2, Math.max(target, windmill), tau, dt);

    // the burner lights only from military power, after a short delay, and builds up
    const atMil = this.running && dry >= 0.999 && this.n2 > s.milN2 - 1.5;
    this._abDelay = atMil && ab > 0 ? this._abDelay + dt : 0;
    const abTarget = this._abDelay > s.abLightDelay ? ab : 0;
    this.ab = lag(this.ab, abTarget, abTarget > this.ab ? s.abTau : s.abTau * 0.5, dt);

    // thrust: dry from core speed (≈ quadratic from idle), the burner on top; lapse and ram
    const nFrac = clamp((this.n2 - s.idleN2) / (s.milN2 - s.idleN2), 0, 1.05);
    const lapse = Math.pow(atm.sigma, s.densityExp);
    const dryT = this.running ? (s.idleThrust + (s.milThrust - s.idleThrust) * Math.pow(nFrac, 1.7)) * table1(s.ramDry, mach) : 0;
    const abT = this.running ? this.ab * (s.maxThrust - s.milThrust) * table1(s.ramAb, mach) : 0;
    this.thrust = s.count * lapse * (dryT + abT);
    // a windmilling engine drags
    if (!this.running) this.thrust = -s.count * s.windmillDrag * mach * mach * atm.sigma;

    this.fuelFlow = this.running ? s.count * lapse * (dryT * s.tsfcDry + abT * s.tsfcAb) : 0;
    this.power = this.running ? clamp(nFrac, 0, 1) + this.ab : 0;
    this.nozzle = this.running ? clamp(0.85 - 1.1 * nFrac, 0, 0.85) + 0.95 * this.ab : clamp(this.n2 / 100, 0.2, 0.8);
    this.nozzle = clamp(this.nozzle, 0, 1);
    const ftitEq = this.running ? s.ftitIdle + (s.ftitMil - s.ftitIdle) * Math.pow(nFrac, 1.4) + 25 * this.ab : atm.T - 273.15 + this.n2;
    this.ftit = lag(this.ftit, ftitEq, 1.6, dt);
    this.oilPress = lag(this.oilPress, this.n2 > 10 ? 25 + 35 * clamp(this.n2 / s.milN2, 0, 1) : 0, 0.8, dt);
  }

  _spoolTau() {
    const s = this.spec;
    const u = clamp((this.n2 - s.idleN2) / (s.milN2 - s.idleN2), 0, 1);
    return s.spoolTauIdle + (s.spoolTauMil - s.spoolTauIdle) * u;
  }
}
