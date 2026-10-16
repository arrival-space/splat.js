import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtraModel } from '../src/render/extraModel.js';
import { buildScenery } from '../src/render/scenery.js';
import { buildMeigs } from '../src/world/meigs.js';
import { fromBody } from '../src/render/geometry.js';
import { simToRenderQuat } from '../src/render/cameraRig.js';
import { qFromEuler, qRotate } from '../src/math/quat.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';

test('model matches the published dimensions: 8.0 m span, ~7 m long', () => {
  const parts = buildExtraModel();
  const b = parts.filter((p) => !p.hinge).map((p) => p.mesh.bounds());
  const min = [0, 1, 2].map((k) => Math.min(...b.map((x) => x.min[k])));
  const max = [0, 1, 2].map((k) => Math.max(...b.map((x) => x.max[k])));
  assert.ok(Math.abs(max[0] - min[0] - 8.0) < 0.02, `span ${max[0] - min[0]}`);
  const length = max[2] - min[2];
  assert.ok(length > 6.9 && length < 7.2, `length ${length}`);
});

test('every part has geometry and finite numbers', () => {
  for (const p of buildExtraModel()) {
    assert.ok(p.mesh.vertexCount > 0, p.name);
    assert.ok(p.mesh.positions.every(Number.isFinite), p.name);
    assert.ok(p.mesh.indices.every((i) => i < p.mesh.vertexCount), p.name);
  }
});

test('the wheels sit on the gear model\'s contact points', () => {
  const parts = buildExtraModel();
  for (const [i, name] of [[0, 'wheel-1'], [1, 'wheel1'], [2, 'tailwheel']]) {
    const u = EXTRA.gear.units[i];
    const w = parts.find((p) => p.name === name);
    assert.ok(Math.abs(w.hinge[2] + u.tyre.radius - u.pos[2]) < 1e-9, `${name} hub + radius = contact`);
    assert.ok(Math.abs(w.hinge[0] - u.pos[0]) < 1e-9);
  }
});

test('render quaternion maps body axes the same way fromBody does', () => {
  const q = qFromEuler(0.3, -0.2, 1.1);
  const r = simToRenderQuat(q);
  for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.5, 0.8]]) {
    const ned = qRotate(q, v);
    const want = [ned[1], -ned[2], -ned[0]];
    // rotate fromBody(v) by r ([x, y, z, w])
    const p = fromBody(v);
    const [x, y, z, w] = r;
    const tx = 2 * (y * p[2] - z * p[1]), ty = 2 * (z * p[0] - x * p[2]), tz = 2 * (x * p[1] - y * p[0]);
    const got = [p[0] + w * tx + (y * tz - z * ty), p[1] + w * ty + (z * tx - x * tz), p[2] + w * tz + (x * ty - y * tx)];
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - want[k]) < 1e-12);
  }
});

test('scenery builds with every landmark and a few thousand Loop blocks', () => {
  const parts = buildScenery(buildMeigs());
  const names = parts.map((p) => p.name);
  for (const n of ['lake', 'mainland', 'island', 'runway', 'markings', 'seawall']) assert.ok(names.includes(n), n);
  const loop = parts.filter((p) => p.name.startsWith('loop')).reduce((s, p) => s + p.mesh.vertexCount, 0);
  assert.ok(loop > 5000 && loop < 60000, `loop verts ${loop}`);
  for (const p of parts) assert.ok(p.mesh.positions.every(Number.isFinite), p.name);
});

test('scenery walls: each two-sided pair is marked for back-face culling, and each quad faces its own way', async () => {
  const { buildScenery } = await import('../src/render/scenery.js');
  const { buildMeigs } = await import('../src/world/meigs.js');
  const parts = buildScenery(buildMeigs());
  for (const name of ['islandWall', 'seawall', 'navyPierWall']) {
    const p = parts.find((x) => x.name === name);
    assert.ok(p && p.cullBack, `${name} culls back faces`);
    // the two quads of a segment: same corners, opposite normals (so exactly one is front-facing from anywhere)
    const n = p.mesh.normals;
    assert.ok(Math.abs(n[0] + n[12]) < 1e-9 && Math.abs(n[2] + n[14]) < 1e-9, `${name}: the pair faces opposite ways`);
  }
});

test('the airplane is lit from outside: every surface faces away from its part\'s inside', () => {
  const outward = (p) => {
    const P = p.mesh.positions, N = p.mesh.normals, I = p.mesh.indices, nv = P.length / 3;
    const c = [0, 0, 0];
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) c[k] += P[i * 3 + k] / nv;
    let out = 0;
    for (let t = 0; t < I.length; t += 3) {
      const i = I[t];
      const tc = [0, 1, 2].map((k) => (P[I[t] * 3 + k] + P[I[t + 1] * 3 + k] + P[I[t + 2] * 3 + k]) / 3 - c[k]);
      if (N[i * 3] * tc[0] + N[i * 3 + 1] * tc[1] + N[i * 3 + 2] * tc[2] > 0) out++;
    }
    return out / (I.length / 3);
  };
  const parts = buildExtraModel();
  for (const name of ['fuselage', 'stripes', 'spinner', 'pant1', 'pant-1', 'wheel1', 'tailwheel']) {
    const f = outward(parts.find((p) => p.name === name));
    assert.ok(f > 0.95, `${name}: ${(f * 100).toFixed(0)}% outward`);
  }
  // thin surfaces: the top skin faces up, the bottom skin down (render y is up)
  for (const name of ['wingL', 'wingR', 'stabL', 'elevator']) {
    const { positions: P, normals: N } = parts.find((p) => p.name === name).mesh;
    // pair each skin point with the opposite skin at the same spot: the one facing up must be the higher
    let wrong = 0, n = 0;
    for (let i = 0; i < P.length; i += 3) {
      if (Math.abs(N[i + 1]) < 0.8) continue;           // skins only, not the leading edge or the tips
      for (let j = 0; j < P.length; j += 3) {
        if (Math.abs(N[j + 1]) < 0.8 || Math.sign(N[j + 1]) === Math.sign(N[i + 1])) continue;
        if (Math.abs(P[j] - P[i]) > 0.01 || Math.abs(P[j + 2] - P[i + 2]) > 0.01) continue;
        n++;
        if (Math.sign(N[i + 1]) !== Math.sign(P[i + 1] - P[j + 1])) wrong++;
        break;
      }
    }
    assert.ok(n > 10 && wrong / n < 0.05, `${name}: ${wrong} of ${n} skin normals point inward`);
  }
  // and every triangle winds the way its normals point (front faces are the lit ones)
  for (const p of parts) {
    const { positions: P, normals: N, indices: I } = p.mesh;
    let bad = 0;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, d] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[d] - P[a], P[d + 1] - P[a + 1], P[d + 2] - P[a + 2]];
      const fn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (fn[0] * N[a] + fn[1] * N[a + 1] + fn[2] * N[a + 2] < 0) bad++;
    }
    assert.ok(bad / (I.length / 3) < 0.16, `${p.name}: ${bad} triangles wound against their normals`);
  }
});

test('chase view: dragging orbits round the airplane at the same distance, always looking at it', async () => {
  const { CameraRig, nedToRender } = await import('../src/render/cameraRig.js');
  const ac = { state: { pos: [0, 0, -100], q: [1, 0, 0, 0], vel: [40, 0, 0] } };
  const rig = new CameraRig({ eye: EXTRA.eye, towerPos: [0, 0, 0] });
  rig.view = 'chase';
  const at = nedToRender(ac.state.pos);
  const dist = (p) => Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
  const behind = rig.update(ac, 1 / 60).pos;
  rig.look(Math.PI / 2, 0);
  const side = rig.update(ac, 1 / 60).pos;
  rig.look(Math.PI / 2, 0);
  const front = rig.update(ac, 1 / 60).pos;
  assert.ok(Math.abs(dist(side) - dist(behind)) < 0.01 && Math.abs(dist(front) - dist(behind)) < 0.01, 'same distance');
  // flying north (render −z): behind is +z, a half turn puts the camera ahead (−z)
  assert.ok(behind[2] > at[2] + 10 && front[2] < at[2] - 10, `behind ${behind[2].toFixed(1)}, front ${front[2].toFixed(1)}`);
  assert.ok(Math.abs(side[0] - at[0]) > 10, 'a quarter turn is off to the side');
  rig.look(0, -0.8);                                  // drag down: up over the airplane
  const above = rig.update(ac, 1 / 60).pos;
  assert.ok(above[1] > front[1] + 5);
});
