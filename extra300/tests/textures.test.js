// The airfield's procedural textures: detail layers neutral on average, the big images carrying
// the variation where it belongs (rubber and skids in the touchdown zones, mowing stripes by the runway).
import test from 'node:test';
import assert from 'node:assert/strict';
import { asphaltDetail, grassDetail, grassMacro, meanLuma, paintWear, runwayMacro } from '../src/render/groundTextures.js';
import { buildScenery } from '../src/render/scenery.js';
import { buildMeigs } from '../src/world/meigs.js';

const world = buildMeigs();
const L = world.runway.length, W = world.runway.width;
const u = [-W / 2 - 1, W / 2 + 1], v = [-L / 2 - 32, L / 2 + 32];
const runway = runwayMacro({ u, v, length: L, width: W, areas: [{ kind: 'runway', u: [-W / 2, W / 2], v: [-L / 2 - 30, L / 2 + 30] }] }, 256, 1024);
const row = (vv) => Math.round(((v[1] - vv) / (v[1] - v[0])) * runway.height);
const col = (uu) => Math.round(((uu - u[0]) / (u[1] - u[0])) * runway.width);

test('detail layers are grey-centred (overlay leaves the big image\'s colour as it is) and tile seamlessly', () => {
  for (const img of [asphaltDetail(128), grassDetail(128)]) {
    assert.ok(Math.abs(meanLuma(img) - 128) < 12, `mean ${meanLuma(img).toFixed(0)}`);
    // the left and right edges continue into each other
    const edge = meanLuma(img, 0, 0, 1, img.height) - meanLuma(img, img.width - 1, 0, img.width, img.height);
    assert.ok(Math.abs(edge) < 12, `edge step ${edge.toFixed(1)}`);
  }
});

test('runway: the touchdown zones carry rubber and skid marks, the middle of the runway does not', () => {
  const tdz = (end) => meanLuma(runway, col(-6), row(end * (L / 2 - 260)) - 20, col(6), row(end * (L / 2 - 260)) + 20);
  const middle = meanLuma(runway, col(-6), row(0) - 20, col(6), row(0) + 20);
  for (const end of [-1, 1]) assert.ok(tdz(end) < middle - 12, `touchdown ${tdz(end).toFixed(0)} vs middle ${middle.toFixed(0)}`);
  // skids: individual near-black streaks among the rubber
  let darkest = 255;
  for (let j = row(L / 2 - 120); j < row(L / 2 - 500); j++) for (let i = col(-6); i < col(6); i++) darkest = Math.min(darkest, runway.data[(j * runway.width + i) * 4]);
  assert.ok(darkest < 45, `darkest ${darkest}`);
});

test('markings wear: paint picks up the rubber where it lies in the touchdown zone', () => {
  const wear = paintWear(runway);
  const tdz = meanLuma(wear, col(-3), row(L / 2 - 260) - 20, col(3), row(L / 2 - 260) + 20);
  const middle = meanLuma(wear, col(-3), row(0) - 20, col(3), row(0) + 20);
  assert.ok(middle > 200, `clean paint ${middle.toFixed(0)}`);
  assert.ok(tdz < middle - 25, `touchdown ${tdz.toFixed(0)} vs ${middle.toFixed(0)}`);
});

test('grass: mowing stripes alternate beside the runway', () => {
  const gu = [-256, 256], gv = [-832, 832];
  const img = grassMacro({ u: gu, v: gv, width: W }, 512, 256);
  const c = (uu) => Math.round(((uu - gu[0]) / 512) * 512);
  const band = (uu) => meanLuma(img, c(uu), 100, c(uu) + 2, 156);
  // stripes 6 m wide from the runway's edge: 3 m and 9 m out are opposite stripes
  assert.ok(Math.abs(band(W / 2 + 3) - band(W / 2 + 9)) > 3, `${band(W / 2 + 3).toFixed(1)} vs ${band(W / 2 + 9).toFixed(1)}`);
});

test('scenery: runway, taxiways, grass and markings carry runway-metre texture coordinates', () => {
  const parts = buildScenery(world);
  for (const name of ['runway', 'taxiways', 'island', 'markings', 'taxiLine']) {
    const p = parts.find((x) => x.name === name);
    assert.ok(p.texture, `${name} is textured`);
    assert.equal(p.mesh.uvs.length / 2, p.mesh.vertexCount, `${name} has a uv per vertex`);
  }
  // the threshold of 36 sits at v = -L/2 on the centreline
  const rw = parts.find((x) => x.name === 'runway').mesh;
  const vs = rw.uvs.filter((_, i) => i % 2 === 1);
  assert.ok(Math.abs(Math.min(...vs) + L / 2 + 30) < 0.5 && Math.abs(Math.max(...vs) - L / 2 - 30) < 0.5);
  assert.ok(parts.paved.some((a) => a.kind === 'apron'));
});
