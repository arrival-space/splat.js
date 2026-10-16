// flyPattern.js — fly one Platzrunde in the real Meigs world (OSM ground,
// buildings as obstacles) and report what happened.
import { Aircraft } from '../../src/sim/aircraft.js';
import EXTRA from '../../src/sim/aircraft/extra300l.js';
import { buildMeigs } from '../../src/world/meigs.js';
import { inflateOsm } from '../../src/world/osmCodec.js';
import { CHICAGO_OSM } from '../../src/world/data/chicagoOsm.js';
import { PatternPilot } from './platzrunde.js';

export async function flyPattern({ maxSeconds = 600 } = {}) {
  const world = buildMeigs();
  world.attachOsm(await inflateOsm(CHICAGO_OSM), 2026);
  const ac = new Aircraft(EXTRA, { ground: world.ground, datumMsl: world.elevation });
  const s = world.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.engine.running = true; ac.rpm = 750;
  for (let i = 0; i < 480; i++) ac.step(1 / 480);
  const pilot = new PatternPilot(ac, world);
  const frame = 1 / 60;
  let hitBuilding = null, stallBeforeFlare = 0;
  while (pilot.phase !== 'stopped' && pilot.t < maxSeconds) {
    pilot.step(frame);
    ac.update(frame);
    const [n, e, d] = ac.state.pos;
    const b = world.buildingAt(n, e, -d);
    if (b && !hitBuilding) hitBuilding = { t: pilot.t, name: b.name || 'building', h: b.h };
    if (!['flare', 'rollout', 'stopped', 'takeoff'].includes(pilot.phase) && ac.aero.wingStallFraction() > 0.5) stallBeforeFlare += frame;
    if (ac.damage.crashed || ac.damage.propStrike) break;
  }
  return {
    phase: pilot.phase, seconds: +pilot.t.toFixed(1), events: pilot.events, log: pilot.log,
    loop: pilot.loopResult || null, touchdown: pilot.touchdown, maxG: +pilot.maxG.toFixed(1),
    stop: { n: Math.round(ac.state.pos[0]), e: +ac.state.pos[1].toFixed(1), surface: world.ground(ac.state.pos[0], ac.state.pos[1]).surface },
    damage: ac.damage, hitBuilding, stallBeforeFlare: +stallBeforeFlare.toFixed(1), runway: world.runway,
  };
}
