// b777Model.js — the Boeing 777-300ER as the renderer gets it: modelled in Blender
// (scripts/blender/b777.py: the fuselage with its six-pane windscreen and the flight deck behind it,
// the wings with flaps, ailerons and spoilers, the GE90s, the tails, the six-wheel bogies) and baked
// into src/render/data/b777Model.js by scripts/bake-model.mjs, in the flight model's body axes.

import { decodeModel } from './extraModel.js';
import { B777_MODEL } from './data/b777Model.js';

export function buildB777Model() {
  return decodeModel(B777_MODEL).parts;
}
