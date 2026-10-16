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
