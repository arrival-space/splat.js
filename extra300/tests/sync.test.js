// The staging step of scripts/sync.mjs: what this repo writes into a pulled workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage, MANAGED_ROOM_KEYS, loadConfig } from '../scripts/sync.mjs';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  const space = join(dir, 'space');
  mkdirSync(join(space, 'entities'), { recursive: true });
  writeFileSync(join(space, 'room.json'), JSON.stringify({ id: 'RoomInfo', type: 'Simple', data: { roomTitle: 'Kept', worldScale: 1 } }));
  writeFileSync(join(space, 'entities', 'old-spawn.json'), JSON.stringify({ id: 'old-spawn', type: 'SpawnPoint', data: { position: { x: 0, y: 0, z: 0 }, isDefaultThirdPerson: true, isDefaultFreeCam: true } }));
  writeFileSync(join(space, 'entities', 'someone-elses.json'), JSON.stringify({ id: 'someone-elses', type: 'UserModelEntity', data: { glbUrl: 'https://x/y.glb' } }));
  return space;
}
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('stage writes the plugin, its host entity with params, and the runway-36 spawn', () => {
  const space = workspace();
  const cfg = loadConfig();
  stage(space, cfg, '// plugin', { isEnabled: true, startRunway: '36' });
  assert.equal(readFileSync(join(space, 'plugins', 'extra300-meigs.mjs'), 'utf8'), '// plugin');
  const host = read(join(space, 'entities', `${cfg.entityId}.json`));
  assert.equal(host.type, 'UserModelEntity');
  assert.equal(host.data.glbUrl, 'plugins/extra300-meigs.mjs');
  assert.equal(host.data.params.startRunway, '36');
  const spawn = read(join(space, 'entities', `${cfg.spawnId}.json`));
  assert.equal(spawn.type, 'SpawnPoint');
  assert.equal(spawn.data.isDefaultThirdPerson, true);
});

test('stage leaves exactly one default spawn and does not touch other entities', () => {
  const space = workspace();
  const before = readFileSync(join(space, 'entities', 'someone-elses.json'), 'utf8');
  stage(space, loadConfig(), '', {});
  const old = read(join(space, 'entities', 'old-spawn.json'));
  assert.equal(old.data.isDefaultThirdPerson, false);
  assert.equal(old.data.isDefaultFreeCam, false);
  assert.equal(readFileSync(join(space, 'entities', 'someone-elses.json'), 'utf8'), before);
});

test('stage merges only the managed room keys', () => {
  const space = workspace();
  stage(space, loadConfig(), '', {});
  const room = read(join(space, 'room.json'));
  assert.equal(room.data.roomTitle, 'Kept');
  assert.equal(room.data.worldScale, 1, 'never touches worldScale');
  for (const [k, v] of Object.entries(MANAGED_ROOM_KEYS)) assert.deepEqual(room.data[k], v);
  assert.ok(!existsSync(join(space, '.arrival')));
});

test('the spawn is within boarding distance of the parked airplane (worldScale 1)', async () => {
  const { buildMeigs } = await import('../src/world/meigs.js');
  const cfg = loadConfig();
  const s = buildMeigs().startPosition();
  const aircraftZ = cfg.placement.position.z + -s.n;   // render z = -north
  const d = Math.hypot(cfg.placement.spawn.x - (cfg.placement.position.x + s.e), cfg.placement.spawn.z - aircraftZ);
  assert.ok(d > 4 && d < 9, `spawn ${d.toFixed(1)} m from the airplane`);
});
