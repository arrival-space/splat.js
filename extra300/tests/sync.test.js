// The staging step of scripts/sync.mjs: what this repo writes into a pulled workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stage, stageGoogleTiles, MANAGED_ROOM_KEYS, loadConfig, TILES_ID } from '../scripts/sync.mjs';

function workspace(withSpawn = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  const space = join(dir, 'space');
  mkdirSync(join(space, 'entities'), { recursive: true });
  writeFileSync(join(space, 'room.json'), JSON.stringify({ id: 'RoomInfo', type: 'Simple', data: { roomTitle: 'Kept', worldScale: 1 } }));
  if (withSpawn) writeFileSync(join(space, 'entities', 'old-spawn.json'), JSON.stringify({ id: 'old-spawn', type: 'SpawnPoint', data: { position: { x: 0, y: 0, z: 0 }, isDefaultThirdPerson: true, isDefaultFreeCam: true } }));
  writeFileSync(join(space, 'entities', 'someone-elses.json'), JSON.stringify({ id: 'someone-elses', type: 'UserModelEntity', data: { glbUrl: 'https://x/y.glb' } }));
  return space;
}
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('stage writes the plugin, its host entity with params, and the runway-36 spawn in a space without one', () => {
  const space = workspace(false);
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

test('stage leaves the space\'s own spawn point as it is (placed in the browser) and other entities alone', () => {
  const space = workspace();
  const before = readFileSync(join(space, 'entities', 'someone-elses.json'), 'utf8');
  const spawnBefore = readFileSync(join(space, 'entities', 'old-spawn.json'), 'utf8');
  const cfg = loadConfig();
  stage(space, cfg, '', {});
  assert.equal(readFileSync(join(space, 'entities', 'old-spawn.json'), 'utf8'), spawnBefore);
  assert.ok(!existsSync(join(space, 'entities', `${cfg.spawnId}.json`)), 'no second spawn');
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

test('the spawn is within boarding distance of the parked airplane', () => {
  // the vibe anchors the airplane's parking spot at its own position
  const cfg = loadConfig();
  const d = Math.hypot(cfg.placement.spawn.x - cfg.placement.position.x, cfg.placement.spawn.z - cfg.placement.position.z);
  assert.ok(d > 4 && d < 9, `spawn ${d.toFixed(1)} m from the airplane`);
});

test('Google 3D Tiles host: centred on the parking spot, and a key set in the browser survives the next push', () => {
  const space = workspace();
  const cfg = loadConfig();
  stage(space, cfg, '', {});
  const at = { lat: 41.8530123, lon: -87.6081234, ellipsoidH: 147.15 };
  assert.equal(stageGoogleTiles(space, cfg, '// tiles', at, 1), true);
  const path = join(space, 'entities', `${TILES_ID}.json`);
  let host = read(path);
  assert.equal(host.data.glbUrl, `plugins/${TILES_ID}.mjs`);
  assert.deepEqual(host.data.position, cfg.placement.position);
  assert.equal(host.data.params.latitude, 41.853012);
  assert.equal(host.data.params.groundAltitude, 147.2);
  assert.equal(host.data.params.showPanel, true, 'a new host asks for the key');
  // the owner enters the key in the browser; the next push pulls it back and must keep it
  host.data.params.apiKey = 'browser-entered';
  host.data.params.showPanel = false;
  host.data.params.detail = 4.5;
  writeFileSync(path, JSON.stringify(host));
  stageGoogleTiles(space, cfg, '// tiles v2', { ...at, lat: 41.86 }, 1);
  host = read(path);
  assert.equal(host.data.params.apiKey, 'browser-entered');
  assert.equal(host.data.params.showPanel, false);
  assert.equal(host.data.params.detail, 4.5);
  assert.equal(host.data.params.latitude, 41.86, 'the location is ours');
  assert.equal(stageGoogleTiles(space, cfg, null, at), false, 'no library copy pulled: nothing staged');
});

test('the Google tiles host is git-ignored (it holds the API key)', () => {
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^space\/space\/entities\/google-3d-tiles\.json$/m);
});

test('the airport and airplane vibes: modules always staged, their entities made only for a space without them', async () => {
  const { stage, CONFIG_VIBES, loadConfig } = await import('../scripts/sync.mjs');
  const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const space = mkdtempSync(join(tmpdir(), 'stage-vibes-'));
  const srcs = { 'flight-airport': '// airport', 'flight-aircraft': '// aircraft' };
  stage(space, loadConfig(), '', {}, srcs);
  for (const v of CONFIG_VIBES) assert.ok(readdirSync(join(space, 'entities')).includes(`${v.id}.json`), v.id);
  assert.equal(readFileSync(join(space, 'plugins', 'flight-airport.mjs'), 'utf8'), '// airport');
  // tuned in the browser, one deleted, one duplicated: a later push leaves all that alone
  const lowi = join(space, 'entities', 'flight-airport-lowi.json');
  const e = JSON.parse(readFileSync(lowi, 'utf8'));
  e.data.params.title = 'Innsbruck at dusk';
  writeFileSync(lowi, JSON.stringify(e));
  rmSync(join(space, 'entities', 'flight-aircraft-xwing.json'));
  writeFileSync(join(space, 'entities', 'abc-dup.json'), JSON.stringify({ ...e, id: 'abc-dup' }));
  stage(space, loadConfig(), '', {}, { ...srcs, 'flight-airport': '// airport v2' });
  assert.equal(JSON.parse(readFileSync(lowi, 'utf8')).data.params.title, 'Innsbruck at dusk');
  assert.ok(!readdirSync(join(space, 'entities')).includes('flight-aircraft-xwing.json'), 'the deleted one came back');
  assert.ok(readdirSync(join(space, 'entities')).includes('abc-dup.json'));
  assert.equal(readFileSync(join(space, 'plugins', 'flight-airport.mjs'), 'utf8'), '// airport v2');
  rmSync(space, { recursive: true, force: true });
});
