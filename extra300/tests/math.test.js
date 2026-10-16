import test from 'node:test';
import assert from 'node:assert/strict';
import { qFromEuler, qToEuler, qRotate, qRotateInv, qIntegrate } from '../src/math/quat.js';
import { inertiaMul, inertiaSolve } from '../src/math/vec3.js';

const close = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} vs ${b}`);

test('Euler 3-2-1 round trip', () => {
  for (const [phi, theta, psi] of [[0.3, -0.4, 1.2], [-2.5, 1.1, 5.9], [0, 0, 0]]) {
    const e = qToEuler(qFromEuler(phi, theta, psi));
    close(e.phi, phi, 1e-9, 'phi');
    close(e.theta, theta, 1e-9, 'theta');
    close(e.psi, psi, 1e-9, 'psi');
  }
});

test('body x of a 90° heading points east; rotate and inverse agree', () => {
  const q = qFromEuler(0, 0, Math.PI / 2);
  const v = qRotate(q, [1, 0, 0]);
  close(v[0], 0, 1e-12); close(v[1], 1, 1e-12); close(v[2], 0, 1e-12);
  const back = qRotateInv(q, v);
  close(back[0], 1, 1e-12);
});

test('pitch up raises the nose (NED z goes negative)', () => {
  const v = qRotate(qFromEuler(0, 0.2, 0), [1, 0, 0]);
  assert.ok(v[2] < 0);
});

test('integrating a constant roll rate for 1 s rolls by that many radians', () => {
  const q = [1, 0, 0, 0];
  for (let i = 0; i < 480; i++) qIntegrate(q, [0.5, 0, 0], 1 / 480);
  close(qToEuler(q).phi, 0.5, 1e-9);
});

test('inertia solve inverts inertia multiply (with Ixz)', () => {
  const I = { xx: 400, yy: 900, zz: 1200, xz: 40 };
  const w = [0.3, -1.2, 2.0];
  const x = inertiaSolve(I, inertiaMul(I, w));
  for (let k = 0; k < 3; k++) close(x[k], w[k], 1e-12);
});
