// f15Model.js — the F-15C Eagle as the renderer gets it.
//
// Modelled in Blender (scripts/blender/f15c.py: fuselage with the cockpit, raked intakes, wings with
// flaps and ailerons, all-moving stabilators, twin fins and rudders, the dorsal speed brake, nozzles,
// gear that folds forward) and baked into src/render/data/f15cModel.js by scripts/bake-model.mjs, in
// the flight model's body axes like the Extra (see extraModel.js). Added here: the afterburner flames,
// one glowing cone per nozzle that the visual scales with the burner.

import F15 from '../sim/aircraft/f15c.js';
import { fromBody, MeshBuilder } from './geometry.js';
import { decodeModel } from './extraModel.js';
import { F15C_MODEL } from './data/f15cModel.js';

/** A cone along body −x from the nozzle exit: the burner's plume, a few overlapping shells. */
function flame(y) {
  const mb = new MeshBuilder();
  const segs = 20;
  for (const [r0, len] of [[0.42, 3.2], [0.34, 4.6], [0.24, 6.0]]) {
    const base = mb.positions.length / 3;
    for (let k = 0; k < segs; k++) {
      const a = (2 * Math.PI * k) / segs;
      mb.positions.push(...fromBody([0, Math.cos(a) * r0, Math.sin(a) * r0]));
      mb.normals.push(...fromBody([0.3, Math.cos(a), Math.sin(a)]));
    }
    mb.positions.push(...fromBody([-len, 0, 0]));
    mb.normals.push(...fromBody([-1, 0, 0]));
    const tip = base + segs;
    for (let k = 0; k < segs; k++) {
      const a = base + k, b = base + ((k + 1) % segs);
      mb.indices.push(a, tip, b, a, b, tip);   // both sides: seen from anywhere
    }
  }
  return { mb, y };
}

/** All parts, as buildExtraModel: static ones { name, color, mesh }, moving ones with hinge, axis, kind. */
// the ACES II as modelled stands 13 cm through the canopy's glass: sunk under it (the pilot's own seating,
// the profile's, stays as it is)
const SEAT_PARTS = new Set(['seat', 'seatCushion', 'ejectionHandles', 'harness']);
const SEAT_DROP = 0.23;   // m

export function buildF15Model() {
  const { parts } = decodeModel(F15C_MODEL);
  for (const p of parts) {
    if (!SEAT_PARTS.has(p.name)) continue;
    const q = p.mesh.positions;
    for (let i = 1; i < q.length; i += 3) q[i] -= SEAT_DROP;   // (y: up, in the renderer's axes)
  }
  const exit = F15.jet.pos[0] - 0.12;
  for (const side of [-1, 1]) {
    const { mb } = flame(side * 0.64);
    parts.push({ name: `abFlame${side < 0 ? 'L' : 'R'}`, color: '#ff9a3c', mesh: mb, hinge: [exit, side * 0.64, 0], axis: [1, 0, 0], kind: 'abFlame', transparent: true });
  }
  return parts;
}
