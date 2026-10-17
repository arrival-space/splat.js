// xwingModel.js — the X-wing as the renderer gets it: modelled in Blender (scripts/blender/xwing.py,
// from the three-view schematic) and baked into src/render/data/xwingModel.js. Each S-foil is one
// moving part with its engine and cannon; the engines' glow rides on them.

import { decodeModel } from './extraModel.js';
import { XWING_MODEL } from './data/xwingModel.js';
import XW, { WING } from '../sim/aircraft/xwing.js';

export function buildXwingModel() {
  return decodeModel(XWING_MODEL).parts;
}

const rotX = (p, a) => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a)];

/**
 * The four cannons' muzzles in body axes, for an S-foil opening (0 closed .. 1 attack position):
 * each tip turns with its wing about the hinge along the fuselage.
 */
export function cannonTips(sfoilPos = 1) {
  const out = [];
  for (const side of [1, -1]) {
    for (const layer of [1, -1]) {
      const z = -layer * WING.hingeZ;
      const hinge = [0, side * 0.6, z];
      const tip = [5.0 - hinge[0], side * WING.tipY - hinge[1], 0];
      const r = rotX(tip, -side * layer * WING.open * sfoilPos);
      out.push([hinge[0] + r[0], hinge[1] + r[1], hinge[2] + r[2]]);
    }
  }
  return out;
}

export { XW };
