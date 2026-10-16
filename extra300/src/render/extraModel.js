// extraModel.js — the Extra 300L as the renderer gets it.
//
// The airplane is modelled in Blender (scripts/blender/extra300l.py: fuselage
// shell with the cockpit, seats, harnesses, sticks, panels, canopy and frame,
// sunburst wings, horn-balanced tail, MT prop, gear) and baked into
// src/render/data/extra300lModel.js by scripts/bake-model.mjs. It is built in
// the flight model's body axes (x fwd, y right, z down, metres from R), so the
// wheels sit on the gear model's contact points, the control surfaces hinge
// where the aero strips put them, and the eye point is the sim's. Moving parts
// come relative to their own hinge, so the renderer rotates one node per part.

import EXTRA from '../sim/aircraft/extra300l.js';
import { fromBody, MeshBuilder, ring } from './geometry.js';
import { EXTRA300L_MODEL } from './data/extra300lModel.js';

const POS_SCALE = 4096;   // scripts/bake-model.mjs

function bytesOf(b64) {
  if (typeof atob === 'function') return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** The baked model: { eye, parts: [{ name, color, material, kind?, hinge?, axis?, side?, gear?, transparent?, mesh }] }, meshes in render axes. */
export function decodeModel(b64 = EXTRA300L_MODEL) {
  const u8 = bytesOf(b64);
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const hl = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const head = 4 + hl, pad = (4 - (head % 4)) % 4;
  const nvAll = header.parts.reduce((s, p) => s + p.nv, 0), niAll = header.parts.reduce((s, p) => s + p.ni, 0);
  const P = new Int16Array(buf, head + pad, nvAll * 3);
  const I = new Uint16Array(buf, head + pad + nvAll * 6, niAll);
  const N = new Int8Array(buf, head + pad + nvAll * 6 + niAll * 2, nvAll * 3);
  let pv = 0, pi = 0;
  const parts = header.parts.map(({ nv, ni, ...meta }) => {
    const mb = new MeshBuilder();
    for (let v = 0; v < nv; v++) {
      const k = (pv + v) * 3;
      mb.positions.push(...fromBody([P[k] / POS_SCALE, P[k + 1] / POS_SCALE, P[k + 2] / POS_SCALE]));
      mb.normals.push(...fromBody([N[k] / 127, N[k + 1] / 127, N[k + 2] / 127]));
    }
    for (let i = 0; i < ni; i++) mb.indices.push(I[pi + i]);
    pv += nv;
    pi += ni;
    return { ...meta, mesh: mb };
  });
  return { eye: header.eye, parts };
}

/** The blur of the turning prop: a faint disc the size of the prop, on the prop's node. */
function propDisc() {
  const mb = new MeshBuilder();
  const R = EXTRA.prop.diameter / 2;
  const pts = ring([0, 0, 0], [1, 0, 0], [0, 1, 0], R, R, 32, 2).map(([x, y]) => fromBody([0, x, y]));
  mb.fan(pts);
  mb.fan(pts, true);
  return mb;
}

/**
 * All parts of the aircraft. Static parts: { name, color, mesh }. Moving parts add { hinge (body),
 * axis (body), kind } — aileron, elevator, rudder, prop, propDisc, wheel, tailwheel, stick — and
 * their mesh is relative to the hinge.
 */
export function buildExtraModel() {
  const { parts } = decodeModel();
  const prop = parts.find((p) => p.kind === 'prop');
  parts.push({ name: 'propDisc', color: '#1b1d22', mesh: propDisc(), hinge: prop.hinge, axis: [1, 0, 0], kind: 'propDisc', transparent: true });
  return parts;
}
