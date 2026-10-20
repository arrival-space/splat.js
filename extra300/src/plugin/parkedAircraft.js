// parkedAircraft.js — the space's other airplanes parked in a row beside the runway (Innsbruck): each one
// drawn as it stands on its gear, solid to the avatars, and the one a visitor walks up to offered to fly
// (the flight vibe then takes it out onto the runway).

import { Aircraft } from '../sim/aircraft.js';
import { AircraftColliders } from './aircraftColliders.js';
import { AircraftVisual } from './aircraftVisual.js';

const EDGE = 12;   // m between the runway's edge and a wingtip

/**
 * Where the row stands: left of the airplane lined up at the start, parallel to the runway, the smallest
 * nearest; each `{ span, length }` (m) in turn, abreast of the start and on along the runway.
 * @param {{ n: number, e: number, heading: number }} start
 * @param {{ span: number, length: number }[]} planes
 * @returns {{ n: number, e: number, heading: number }[]}
 */
export function parkingSpots(start, planes, runwayWidth = 45) {
  const f = [Math.cos(start.heading), Math.sin(start.heading)], left = [Math.sin(start.heading), -Math.cos(start.heading)];
  let along = 0, prev = 0;
  return planes.map((p, i) => {
    along += i ? prev + 10 + p.length / 2 : 0;
    prev = p.length / 2;
    const side = runwayWidth / 2 + EDGE + p.span / 2;
    return { n: start.n + f[0] * along + left[0] * side, e: start.e + f[1] * along + left[1] * side, heading: start.heading };
  });
}

/** An airplane's size for the row: its span, its length (from its chase camera's size: the Extra's ~7 m is 1). */
export const sizeOf = (profile) => ({ span: profile.spec.wing.span, length: Math.max(7, 9.5 * (profile.chaseSize || 1)) });

export class ParkedAircraft {
  constructor(app, parent, ws) {
    this.app = app;
    this.parent = parent;
    this.ws = ws;
    this.items = [];   // { entryId, profile, visual, colliders, root }
    this._key = '';
  }

  /**
   * The row as it should be: [{ entryId, profile }] at `spots`, on `world`'s ground. Made again only when
   * what stands there (or where) changes. `onClick(entryId)`: one tapped.
   */
  set(list, spots, world, onClick) {
    const key = list.map((it, i) => `${it.entryId}:${it.profile.entryId ?? ''}:${spots[i].n.toFixed(1)},${spots[i].e.toFixed(1)}`).join('|') + `@${world.elevation}`;
    if (key === this._key) return;
    this.clear();
    this._key = key;
    list.forEach((it, i) => {
      const { n, e, heading } = spots[i];
      const spec = it.profile.spec;
      // stood on its gear: the flight model settles it, as the one on the runway is
      const ac = new Aircraft(spec, { ground: world.ground, datumMsl: world.elevation, load: spec.engine ? { fuelCenterL: it.profile.fuelL ?? 60 } : {} });
      ac.placeOnGround(n, e, heading);
      ac.controls.parkingBrake = true;
      ac.setEngineRunning(false);
      for (let k = 0; k < 480; k++) ac.step(1 / 480);
      const parts = it.profile.buildModel();
      const visual = new AircraftVisual(this.app, this.parent, parts, `Parked ${it.profile.title}`);
      visual.update(ac, 0);
      const colliders = new AircraftColliders(this.app, visual.root, parts, this.ws);
      colliders.enabled = true;
      const unsub = onClick ? ArrivalSpace.onEntityClick?.(visual.root, () => onClick(it.entryId)) : null;
      this.items.push({ ...it, visual, colliders, unsub, span: spec.wing.span, root: visual.root });
    });
  }

  /** The parked airplane a visitor at `pos` (world) stands by, if any. */
  near(pos, reach) {
    let best = null, bd = Infinity;
    for (const it of this.items) {
      const d = pos.distance(it.root.getPosition());
      if (d < Math.max(reach, it.span) * this.ws && d < bd) { best = it; bd = d; }
    }
    return best;
  }

  /** Each frame: the colliders made once the physics is there. */
  tick() { for (const it of this.items) it.colliders.tick(); }

  /** Their roots (they keep their shadows: plugin/extra300.js _publishShadows). */
  get roots() { return this.items.map((it) => it.root); }

  clear() {
    for (const it of this.items) {
      if (typeof it.unsub === 'function') it.unsub();
      it.colliders.destroy();
      it.visual.destroy();
    }
    this.items = [];
    this._key = '';
  }
}
