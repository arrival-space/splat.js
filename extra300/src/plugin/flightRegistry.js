// flightRegistry.js — the airports and airplanes in the space, each its own vibe (plugin/airportVibe.js,
// plugin/aircraftVibe.js) so people can tune them, duplicate them and delete them in the editor. The
// vibes are small: they describe a tuned copy of one of the airports and airplanes the flight vibe
// carries (its terrain, its models), and put that description here. The flight vibe (plugin/extra300.js)
// lists what is here in its dropdowns and builds what is picked.
//
// The vibes are separate bundles, so the registry lives on the app they share: app.flightSim.

/** The airports with baked terrain, and the airplanes with models: what a vibe can be a copy of. */
export const BASE_AIRPORTS = { meigs: 'Chicago Meigs (KCGX)', lowi: 'Innsbruck (LOWI)', krnt: 'Renton, Boeing 737 field (KRNT)' };
export const BASE_AIRCRAFT = { extra300l: 'Extra 300L', f15c: 'F-15C Eagle', xwing: 'X-wing', b777: 'Boeing 777-300ER' };
export const CLOUD_OPTIONS = ['Space setting', 'Clear', 'Few', 'Scattered', 'Broken', 'Overcast'];

const baseByTitle = (table, title, fallback) => Object.keys(table).find((k) => table[k] === title || k === title) || fallback;
export const airportBase = (title) => baseByTitle(BASE_AIRPORTS, title, 'meigs');
export const aircraftBase = (title) => baseByTitle(BASE_AIRCRAFT, title, 'extra300l');

/** @returns {{ airports: Map<string, object>, aircraft: Map<string, object> }} */
export function flightRegistry(app) {
  app.flightSim ??= { airports: new Map(), aircraft: new Map() };
  return app.flightSim;
}

/** Put (or replace) an entry; the flight vibe hears 'flightsim:changed'. */
export function register(app, kind, entry) {
  flightRegistry(app)[kind].set(entry.id, entry);
  app.fire('flightsim:changed', kind);
}

export function unregister(app, kind, id) {
  if (flightRegistry(app)[kind].delete(id)) app.fire('flightsim:changed', kind);
}

/** The entries in their dropdown order: by `order`, then by name. */
export function listed(app, kind) {
  return [...flightRegistry(app)[kind].values()].sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
}
