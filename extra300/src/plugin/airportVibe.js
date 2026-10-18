// airportVibe.js — one airport, as its own vibe: a tuned copy of one of the airports the flight vibe
// carries (Chicago Meigs, Innsbruck, Renton), listed in its ✈ dropdown. Duplicate it for another
// version of the same field (another name, the other runway end, an evening sun, other clouds);
// delete it and it leaves the list. It draws nothing itself (plugin/flightRegistry.js).

import { BASE_AIRPORTS, CLOUD_OPTIONS, register, unregister } from './flightRegistry.js';

export class FlightAirport extends ArrivalScript {
  static scriptName = 'flightAirport';

  airport = BASE_AIRPORTS.lowi;
  title = '';
  runwayEnd = 'Default';
  sunTimeUTC = -1;
  dayOfYear = 0;
  clouds = 'Space setting';
  startHere = false;
  order = 0;

  static properties = {
    airport: { title: 'Airport (its terrain and runway)', options: Object.values(BASE_AIRPORTS) },
    title: { title: 'Name in the ✈ list (empty: the airport\'s own)' },
    runwayEnd: { title: 'Start on the runway\'s', options: ['Default', 'Opposite'] },
    sunTimeUTC: { title: 'Sun: time of day, UTC hours (−1: the airport\'s own, or the space\'s)', min: -1, max: 24 },
    dayOfYear: { title: 'Sun: day of the year (0: the airport\'s own, or the space\'s)', min: 0, max: 366 },
    clouds: { title: 'Clouds', options: CLOUD_OPTIONS },
    startHere: { title: 'Visitors start here' },
    order: { title: 'Place in the ✈ list (lower first)', min: -100, max: 100 },
  };

  initialize() {
    this._watch();
    this._publish();
  }

  onPropertyChanged() { if (this.enabled !== false) this._publish(); }

  _publish() {
    const base = Object.keys(BASE_AIRPORTS).find((k) => BASE_AIRPORTS[k] === this.airport) || 'lowi';
    register(this.app, 'airports', {
      id: this.entity.getGuid(),
      base,
      title: (this.title || '').trim() || BASE_AIRPORTS[base],
      runwayEnd: this.runwayEnd === 'Opposite' ? 1 : 0,
      sun: this.sunTimeUTC >= 0 ? { timeUTC: this.sunTimeUTC, dayOfYear: this.dayOfYear > 0 ? this.dayOfYear : undefined } : null,
      clouds: this.clouds === 'Space setting' ? null : this.clouds,
      startHere: !!this.startHere,
      order: Number(this.order) || 0,
    });
  }

  /** Out of the list when the vibe is deleted or switched off, back in when it is on again. */
  _watch() {
    this.entity.once('destroy', () => this.destroy());
    this.on?.('disable', () => unregister(this.app, 'airports', this.entity.getGuid()));
    this.on?.('enable', () => this._publish());
  }

  destroy() { unregister(this.app, 'airports', this.entity.getGuid()); }
}
