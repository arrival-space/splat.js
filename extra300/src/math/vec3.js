// vec3.js — plain-array 3-vectors for the simulation core.
//
// The sim never touches pc.Vec3: it runs in Node under the tests and in the
// browser inside the plugin, and allocation-light [x, y, z] arrays keep the
// two identical. Functions with an `out` argument write into it and return it.

export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const clone = (a) => [a[0], a[1], a[2]];
export const set = (out, x, y, z) => { out[0] = x; out[1] = y; out[2] = z; return out; };
export const copy = (out, a) => { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; };

export const add = (a, b, out = [0, 0, 0]) => set(out, a[0] + b[0], a[1] + b[1], a[2] + b[2]);
export const sub = (a, b, out = [0, 0, 0]) => set(out, a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const scale = (a, s, out = [0, 0, 0]) => set(out, a[0] * s, a[1] * s, a[2] * s);
/** out = a + b * s */
export const addScaled = (a, b, s, out = [0, 0, 0]) => set(out, a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s);

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b, out = [0, 0, 0]) =>
  set(out, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a, out = [0, 0, 0]) => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l, out) : set(out, 0, 0, 0);
};
export const negate = (a, out = [0, 0, 0]) => set(out, -a[0], -a[1], -a[2]);

/** Diagonal-plus-products inertia tensor times a vector: I·w with I = [[Ixx,-Ixy,-Ixz],[-Ixy,Iyy,-Iyz],[-Ixz,-Iyz,Izz]]. */
export function inertiaMul(I, w, out = [0, 0, 0]) {
  const { xx, yy, zz, xz = 0 } = I;
  return set(out, xx * w[0] - xz * w[2], yy * w[1], zz * w[2] - xz * w[0]);
}

/** Solve I·x = b for the symmetric (x-z coupled) aircraft inertia tensor. */
export function inertiaSolve(I, b, out = [0, 0, 0]) {
  const { xx, yy, zz, xz = 0 } = I;
  const det = xx * zz - xz * xz;
  return set(out, (zz * b[0] + xz * b[2]) / det, b[1] / yy, (xx * b[2] + xz * b[0]) / det);
}
