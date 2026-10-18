// aircraftVibe.js — one airplane, as its own vibe: a tuned copy of one of the airplanes the flight vibe
// carries (the Extra 300L, F-15C, X-wing, 777), listed in its airplane dropdown. Duplicate it for a
// variant (another paint, more power, a heavier load); delete it and it leaves the list. It draws
// nothing itself (plugin/flightRegistry.js; the tuning: plugin/tuning.js).

import { BASE_AIRCRAFT, register, unregister } from './flightRegistry.js';

// the base airplanes' own two main colours (plugin/tuning.js PAINT)
export const OWN = { extra300l: ['#f3f1ec', '#c41e2a'], f15c: ['#8e969d', '#6b737b'], xwing: ['#dedcd5', '#c4452e'], b777: ['#f2f3f4', '#1d4f9c'] };

export class FlightAircraft extends ArrivalScript {
  static scriptName = 'flightAircraft';

  airplane = BASE_AIRCRAFT.extra300l;
  title = '';
  paint = OWN.extra300l[0];   // (hex defaults: the editor shows colour pickers)
  trim = OWN.extra300l[1];
  power = 1;
  mass = 1;
  lift = 1;
  controls = 1;
  fuel = -1;
  chaseDistance = 1;
  seatHeight = 0;
  seatForward = 0;
  startHere = false;
  order = 0;

  static properties = {
    airplane: { title: 'Airplane (its model and flight model)', options: Object.values(BASE_AIRCRAFT) },
    title: { title: 'Name in the airplane list (empty: the airplane\'s own)' },
    paint: { title: 'Main paint' },
    trim: { title: 'Trim paint: stripes, tips' },
    power: { title: 'Engine power / thrust ×', min: 0.2, max: 4 },
    mass: { title: 'Empty mass ×', min: 0.4, max: 2.5 },
    lift: { title: 'Wing lift × (the stall: higher flies slower)', min: 0.5, max: 1.8 },
    controls: { title: 'Control authority ×', min: 0.3, max: 2.5 },
    fuel: { title: 'Fuel at the start, % of the tanks (−1: its usual load)', min: -1, max: 100 },
    chaseDistance: { title: 'Chase camera distance ×', min: 0.3, max: 4 },
    seatHeight: { title: 'Pilot seat: up (m)', min: -1, max: 1 },
    seatForward: { title: 'Pilot seat: forward (m)', min: -1, max: 1 },
    startHere: { title: 'Visitors start in this one' },
    order: { title: 'Place in the airplane list (lower first)', min: -100, max: 100 },
  };

  initialize() {
    // left at the class's defaults (the Extra's), the colours are the chosen airplane's own
    const base = this._base();
    if (this.paint === OWN.extra300l[0]) this.paint = OWN[base][0];
    if (this.trim === OWN.extra300l[1]) this.trim = OWN[base][1];
    this._own = base;
    this._watch();
    this._publish();
  }

  onPropertyChanged(name) {
    // another airplane: its own colours, unless they had been changed
    if (name === 'airplane') {
      const base = this._base(), was = OWN[this._own];
      if (this.paint === was[0]) this.paint = OWN[base][0];
      if (this.trim === was[1]) this.trim = OWN[base][1];
      this._own = base;
    }
    if (this.enabled !== false) this._publish();
  }

  _base() { return Object.keys(BASE_AIRCRAFT).find((k) => BASE_AIRCRAFT[k] === this.airplane) || 'extra300l'; }

  _publish() {
    const base = this._base();
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    register(this.app, 'aircraft', {
      id: this.entity.getGuid(),
      base,
      title: (this.title || '').trim() || BASE_AIRCRAFT[base],
      paint: this.paint && this.paint !== OWN[base][0] ? this.paint : null,
      trim: this.trim && this.trim !== OWN[base][1] ? this.trim : null,
      power: num(this.power, 1), mass: num(this.mass, 1), lift: num(this.lift, 1), controls: num(this.controls, 1),
      fuel: num(this.fuel, -1),
      chaseDistance: num(this.chaseDistance, 1), seatHeight: num(this.seatHeight, 0), seatForward: num(this.seatForward, 0),
      startHere: !!this.startHere,
      order: num(this.order, 0),
    });
  }

  /** Out of the list when the vibe is deleted or switched off, back in when it is on again. */
  _watch() {
    this.entity.once('destroy', () => this.destroy());
    this.on?.('disable', () => unregister(this.app, 'aircraft', this.entity.getGuid()));
    this.on?.('enable', () => this._publish());
  }

  destroy() { unregister(this.app, 'aircraft', this.entity.getGuid()); }
}
