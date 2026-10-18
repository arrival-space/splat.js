// The airports and airplanes as their own vibes (plugin/flightRegistry.js, airportVibe.js, aircraftVibe.js)
// and an airplane vibe's tuning made into the profile the flight vibe flies (plugin/tuning.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_AIRCRAFT, flightRegistry, listed, register, unregister } from '../src/plugin/flightRegistry.js';
import { PAINT, plainAircraft, tunedProfile, tuneSpec } from '../src/plugin/tuning.js';
import { PROFILES } from '../src/plugin/profiles.js';
import { Aircraft } from '../src/sim/aircraft.js';

const fakeApp = () => { const heard = []; return { heard, fire: (e, k) => heard.push([e, k]) }; };

test('registry: entries come and go, are listed by order then name, and every change is heard', () => {
  const app = fakeApp();
  register(app, 'aircraft', { id: 'b', title: 'Beta', order: 1 });
  register(app, 'aircraft', { id: 'a', title: 'Alpha', order: 1 });
  register(app, 'aircraft', { id: 'z', title: 'Zulu', order: 0 });
  assert.deepEqual(listed(app, 'aircraft').map((e) => e.id), ['z', 'a', 'b']);
  register(app, 'aircraft', { id: 'z', title: 'Zulu', order: 5 });   // tuned: replaced, not added
  assert.deepEqual(listed(app, 'aircraft').map((e) => e.id), ['a', 'b', 'z']);
  unregister(app, 'aircraft', 'a');
  unregister(app, 'aircraft', 'nope');                                  // nothing there: nothing heard
  assert.equal(flightRegistry(app).aircraft.size, 2);
  assert.equal(app.heard.length, 5);
  assert.ok(app.heard.every(([e, k]) => e === 'flightsim:changed' && k === 'aircraft'));
});

test('an untuned airplane flies as its base; the base spec is never changed by tuning', () => {
  for (const base of Object.keys(BASE_AIRCRAFT)) {
    const p = tunedProfile(plainAircraft(base));
    assert.equal(p.id, base);
    assert.deepEqual(p.spec, PROFILES[base].spec);
  }
  const before = JSON.stringify(PROFILES.extra300l.spec);
  tuneSpec(PROFILES.extra300l.spec, { ...plainAircraft('extra300l'), power: 3, mass: 2, lift: 1.5, controls: 2, fuel: 10 });
  assert.equal(JSON.stringify(PROFILES.extra300l.spec), before);
});

test('tuning: more power gains more energy, more lift stalls slower, the paint is changed, the seat and camera move', () => {
  // ten seconds at full throttle, hands off: the energy it has gained (height and speed), per kg
  const energy = (entry) => {
    const ac = new Aircraft(tunedProfile(entry).spec, { ground: () => ({ h: -1e4, normal: [0, 0, -1], surface: 'asphalt' }) });
    ac.placeInFlight(0, 0, 1000, 0, 50, 0.08);
    ac.controls.throttle = 1;
    for (let i = 0; i < 600; i++) ac.update(1 / 60);
    return 9.81 * -ac.state.pos[2] + Math.hypot(...ac.state.vel) ** 2 / 2;
  };
  const plain = plainAircraft('extra300l');
  assert.ok(energy({ ...plain, power: 1.6 }) > energy(plain) * 1.05, 'more power, no more energy');
  const stall = (entry) => tunedProfile(entry).spec.aero.groupData.wing.stall;
  assert.ok(stall({ ...plain, lift: 1.3 }) > stall(plain) * 1.29);
  const p = tunedProfile({ ...plain, id: 'blue', paint: '#2050c0', chaseDistance: 2, seatHeight: 0.1 });
  const [main] = PAINT.extra300l;
  const parts = p.buildModel();
  assert.ok(parts.some((x) => x.material === main) && parts.filter((x) => x.material === main).every((x) => x.color === '#2050c0'));
  assert.equal(p.chaseSize, PROFILES.extra300l.chaseSize * 2);
  assert.deepEqual(p.seatAdjust, { up: 0.1, forward: 0 });
  assert.equal(p.entryId, 'blue');
});

test('the same tuning is the same profile (a vibe re-publishing unchanged rebuilds nothing)', () => {
  const e = { ...plainAircraft('f15c'), id: 'x', power: 1.2 };
  assert.equal(tunedProfile({ ...e }), tunedProfile({ ...e }));
  assert.notEqual(tunedProfile(e), tunedProfile({ ...e, power: 1.3 }));
});
