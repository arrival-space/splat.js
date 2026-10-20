// parkedAircraft.js — the space's other airplanes parked in a row on the apron (Innsbruck): each one
// drawn as it stands on its gear, solid to the avatars, and the one a visitor walks up to offered to fly
// (the flight vibe then takes it out onto the runway).

import { Aircraft } from '../sim/aircraft.js';
import { AircraftColliders } from './aircraftColliders.js';
import { AircraftVisual } from './aircraftVisual.js';
import { pointInPolygon } from '../world/geo.js';

const EDGE = 12;   // m between the runway's edge and a wingtip
const FAR_SPANS = 150;   // drawn out to this many wingspans away

/**
 * A parked airplane, posed once, made into one mesh per material (its ~70 parts were as many draw
 * calls): every part drawn now, in place under `root`, merged by the material it has; the parts go.
 */
export function bakeStatic(app, root, parts) {
  // switched on itself, up to the root (the world may still be hidden as a whole, at load)
  const shown = (e, top) => { for (let x = e; x && x !== top; x = x.parent) if (x._enabled === false) return false; return true; };
  const byName = new Map(parts.map((p) => [p.name, p]));
  const inv = root.getWorldTransform().clone().invert();
  const groups = new Map();   // material → { mi flags, pieces: [{ mb, m }] }
  const old = new Set();
  for (const r of root.findComponents('render')) {
    const part = byName.get(r.entity.name);
    for (const mi of r.meshInstances) old.add(mi.mesh);
    if (!part || !shown(r.entity, root) || !part.mesh.vertexCount) continue;
    const m = new pc.Mat4().mul2(inv, r.entity.getWorldTransform());
    if (Math.abs(m.getScale(new pc.Vec3()).x) < 1e-4) continue;   // shrunk away (a flame, a disc)
    for (const mi of r.meshInstances) {
      const key = `${mi.material.id}|${r.castShadows}|${r.receiveShadows}`;
      if (!groups.has(key)) groups.set(key, { material: mi.material, cast: r.castShadows, receive: r.receiveShadows, pieces: [] });
      groups.get(key).pieces.push({ mb: part.mesh, m });
    }
  }
  for (const c of [...root.children]) c.destroy();
  for (const mesh of old) mesh.destroy?.();
  const v = new pc.Vec3(), w = new pc.Vec3();
  for (const g of groups.values()) {
    let nv = 0, ni = 0;
    for (const { mb } of g.pieces) { nv += mb.vertexCount; ni += mb.indices.length; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Uint8Array(nv * 4).fill(255);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let bv = 0, bi = 0;
    for (const { mb, m } of g.pieces) {
      for (let k = 0; k < mb.vertexCount; k++) {
        v.set(mb.positions[k * 3], mb.positions[k * 3 + 1], mb.positions[k * 3 + 2]);
        m.transformPoint(v, w); pos.set([w.x, w.y, w.z], (bv + k) * 3);
        v.set(mb.normals[k * 3], mb.normals[k * 3 + 1], mb.normals[k * 3 + 2]);
        m.transformVector(v, w).normalize(); nor.set([w.x, w.y, w.z], (bv + k) * 3);
      }
      if (mb.uvs) uv.set(mb.uvs.slice(0, mb.vertexCount * 2), bv * 2);
      if (mb.colors) col.set(mb.colors.slice(0, mb.vertexCount * 4), bv * 4);
      for (let k = 0; k < mb.indices.length; k++) idx[bi + k] = mb.indices[k] + bv;
      bv += mb.vertexCount; bi += mb.indices.length;
    }
    const mesh = new pc.Mesh(app.graphicsDevice);
    mesh.setPositions(pos); mesh.setNormals(nor); mesh.setUvs(0, uv); mesh.setColors32(col); mesh.setIndices(idx);
    mesh.update(pc.PRIMITIVE_TRIANGLES);
    const e = new pc.Entity('parkedMerged');
    e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, g.material)], castShadows: g.cast, receiveShadows: g.receive });
    root.addChild(e);
  }
}

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

/**
 * Where the row stands on an apron (polygons in (n, e)): noses toward the runway (or, where that won't
 * fit, along the apron), the fuselage and gear wholly on the paving with a margin (the wings may reach
 * past its edge), wingtips clear of each other; the first as near the start as fits, the next on from
 * it. The left side's aprons first, then the right's. Null for one that fits nowhere.
 * @param {{ n: number, e: number, heading: number }} start  lined up on the runway
 * @param {{ span: number, length: number }[]} planes
 * @param {number[][][]} aprons
 */
export function apronSpots(start, planes, aprons, margin = 4) {
  const f = [Math.cos(start.heading), Math.sin(start.heading)], left = [Math.sin(start.heading), -Math.cos(start.heading)];
  const toNE = (a, l) => [start.n + f[0] * a + left[0] * l, start.e + f[1] * a + left[1] * l];
  const rel = ([n, e]) => [(n - start.n) * f[0] + (e - start.e) * f[1], (n - start.n) * left[0] + (e - start.e) * left[1]];
  // the aprons in (along, left) and their extents, the left side's first, then the nearer
  const polys = aprons.map((ap) => ap.map(rel)).map((P) => ({ P, a0: Math.min(...P.map((q) => q[0])), a1: Math.max(...P.map((q) => q[0])), l0: Math.min(...P.map((q) => q[1])), l1: Math.max(...P.map((q) => q[1])) }))
    .sort((x, y) => (y.l0 > 0) - (x.l0 > 0) || Math.min(Math.abs(x.l0), Math.abs(x.l1)) - Math.min(Math.abs(y.l0), Math.abs(y.l1)));
  const taken = [];   // wingtip-to-wingtip boxes in (along, left): [a0, a1, l0, l1]
  return planes.map((p) => {
    const core = Math.max(6, 0.3 * p.span) / 2 + margin;   // the fuselage and the gear's track, half
    for (const across of [true, false]) {                 // nose toward the runway, else along the apron
      // half-extents (along, left): what must be paved, and what must stay clear of the others
      const [pa, pl] = across ? [core, p.length / 2 + margin] : [p.length / 2 + margin, core];
      const [ca, cl] = across ? [p.span / 2 + 4, p.length / 2 + 4] : [p.length / 2 + 4, p.span / 2 + 4];   // (8 m between)
      for (const { P, a0, a1, l0, l1 } of polys) {
        const side = l0 > 0 ? 1 : -1;
        const fits = (a, l) => {
          for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) if (!pointInPolygon(a - pa + (2 * pa * i) / 6, l - pl + (2 * pl * j) / 6, P)) return false;
          return !taken.some((b) => a + ca > b[0] && a - ca < b[1] && l + cl > b[2] && l - cl < b[3]);
        };
        // across the apron from the runway's side, along it from its end nearest the start
        const as = []; for (let a = a0 + pa; a <= a1 - pa; a += 2) as.push(a);
        as.sort((x, y) => Math.abs(x) - Math.abs(y));
        const ls = []; for (let l = l0 + pl; l <= l1 - pl; l += 2) ls.push(l);
        ls.sort((x, y) => Math.abs(x) - Math.abs(y));
        for (const l of ls) for (const a of as) {   // (a row: nearest the runway first, then the start)
          if (!fits(a, l)) continue;
          taken.push([a - ca, a + ca, l - cl, l + cl]);
          const [n, e] = toNE(a, l);
          // across: facing the runway (a quarter turn toward it); along: the start's way
          return { n, e, heading: across ? start.heading + side * Math.PI / 2 : start.heading };
        }
      }
    }
    return null;
  });
}

/**
 * Where the row stands at an airport that names its stands (`{ along, left, span }`, metres from the start:
 * along the runway and to its left): each airplane, smallest first, on the first free stand wide enough,
 * nose toward the runway (or, `face: 'along'`, the runway's way). Null for one with no stand left.
 */
export function standSpots(start, planes, stands) {
  const f = [Math.cos(start.heading), Math.sin(start.heading)], left = [Math.sin(start.heading), -Math.cos(start.heading)];
  const free = stands.map((s, i) => ({ ...s, i })).sort((a, b) => a.span - b.span);
  return planes.map((p) => {
    const k = free.findIndex((s) => s.span >= p.span);
    if (k < 0) return null;
    const [s] = free.splice(k, 1);
    const heading = s.face === 'along' ? start.heading : start.heading + Math.sign(s.left || 1) * Math.PI / 2;
    return { n: start.n + f[0] * s.along + left[0] * s.left, e: start.e + f[1] * s.along + left[1] * s.left, heading };
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
      bakeStatic(this.app, visual.root, parts);   // a draw call per material, not per part
      const colliders = new AircraftColliders(this.app, visual.root, parts, this.ws);
      colliders.enabled = true;
      const unsub = onClick ? ArrivalSpace.onEntityClick?.(visual.root, () => onClick(it.entryId)) : null;
      this.items.push({ ...it, visual, colliders, unsub, span: spec.wing.span, length: sizeOf(it.profile).length, root: visual.root });
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

  /**
   * Each frame: the colliders made once the physics is there; each one drawn only while it is bigger
   * than a few pixels (out past ~150 spans: the Extra beyond 1.2 km, the 777 beyond 10 km).
   */
  tick(camPos) {
    for (const it of this.items) {
      it.colliders.tick();
      if (!camPos) continue;
      const show = camPos.distance(it.root.getPosition()) < FAR_SPANS * it.span * this.ws;
      if (it.drawn !== show) { it.drawn = show; for (const r of it.root.findComponents('render')) r.enabled = show; }
    }
  }

  /** Their roots (they keep their shadows: plugin/extra300.js _publishShadows). */
  get roots() { return this.items.map((it) => it.root); }

  clear() {
    for (const it of this.items) {
      if (typeof it.unsub === 'function') it.unsub();
      it.colliders.destroy();
      for (const r of it.root.findComponents('render')) for (const mi of r.meshInstances) mi.mesh.destroy?.();
      it.visual.destroy();
    }
    this.items = [];
    this._key = '';
  }
}
