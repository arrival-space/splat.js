// sync.mjs — keep the Arrival.Space space in step with this repo, through
// the official `arrival` CLI (github.com/arrival-space/arrival-plugins,
// tools/arrival-cli).
//
//   npm run sync -- setup             install the CLI into .arrival-cli/ (sparse clone + npm install)
//   npm run sync -- login             browser sign-in (or export ARRIVAL_TOKEN=<api key> instead)
//   npm run sync -- create ["title"]  create the space, remember its id in arrival.json
//   npm run sync -- status            what a push would change (pull + stage, no write to the space)
//   npm run sync -- validate          pull, stage, server-side dry-run
//   npm run sync -- push              test, build, pull, stage, validate, push
//
// What this repo owns in the space (everything else is left as the space has it):
//   space/plugins/extra300-meigs.mjs        the built vibe (dist/)
//   space/entities/extra300-meigs.json      the vibe's host entity + its params
//   space/entities/spawn-runway36.json      where visitors appear: behind the airplane, facing north
//   room.json keys in MANAGED_ROOM_KEYS     hub hidden, far clip for the skyline
//   space/plugins/google-3d-tiles.mjs       the Arrival library's Google 3D Tiles vibe (from the pulled reference/),
//                                           patched with the lake's water shading (scripts/tilesWater.mjs)
//   space/entities/google-3d-tiles.json     its host, centred on the parking spot; only its position and
//                                           location params are ours — the API key etc. stay as set in the
//                                           browser (this file is git-ignored: it holds the key)
//
// Every push pulls first, so changes made in the browser to anything else
// survive; the CLI also snapshots the space server-side before applying.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMeigs } from '../src/world/meigs.js';
import { patchTilesWater } from './tilesWater.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, 'arrival.json');
const WORKSPACE = join(ROOT, 'space');           // the CLI workspace (space/, .arrival/, AGENTS.md …)
const PLUGIN_NAME = 'extra300-meigs';
const DIST = join(ROOT, 'dist', `${PLUGIN_NAME}.mjs`);
export const TILES_ID = 'google-3d-tiles';
const TILES_SRC = join(WORKSPACE, 'reference', 'examples', 'google-3d-tiles.mjs');

export const MANAGED_ROOM_KEYS = {
  hideArchitecture: true,   // no hub: Northerly Island is the floor
  hideNavigationPortals: true,
  farClip: 40000,           // the Loop is 4 km away
  defaultCamera: 'third',
};

export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

/** The plugin's editor defaults, read from the built class so params never drift from the code. */
async function pluginDefaults() {
  globalThis.ArrivalScript ??= class {};
  globalThis.pc ??= {};
  const mod = await import(`${DIST}?t=${Date.now()}`);
  const C = Object.values(mod).find((v) => typeof v === 'function');
  const inst = new C();
  return Object.fromEntries(Object.keys(C.properties).map((k) => [k, inst[k]]));
}

/**
 * Write the files this repo owns into a pulled workspace's space/ dir. Pure
 * file manipulation (no network) so it is unit-tested.
 * @param {string} spaceDir   <workspace>/space
 * @param {object} cfg        arrival.json
 * @param {string} pluginSrc  built module source
 * @param {object} params     plugin params
 */
export function stage(spaceDir, cfg, pluginSrc, params) {
  const ents = join(spaceDir, 'entities');
  mkdirSync(ents, { recursive: true });
  mkdirSync(join(spaceDir, 'plugins'), { recursive: true });
  writeFileSync(join(spaceDir, 'plugins', `${PLUGIN_NAME}.mjs`), pluginSrc);

  const host = {
    id: cfg.entityId,
    type: 'UserModelEntity',
    data: {
      glbUrl: `plugins/${PLUGIN_NAME}.mjs`,
      displayName: 'Extra 300L — Meigs Field',
      position: cfg.placement.position,
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
      params: { ...params, ...(cfg.params || {}) },
    },
  };
  writeJson(join(ents, `${cfg.entityId}.json`), host);

  // the spawn point is the only default spawn: clear the flags on any others
  for (const f of readdirSync(ents)) {
    if (!f.endsWith('.json') || f === `${cfg.spawnId}.json`) continue;
    const p = join(ents, f);
    const e = JSON.parse(readFileSync(p, 'utf8'));
    if (e.type === 'SpawnPoint' && (e.data?.isDefaultThirdPerson || e.data?.isDefaultFreeCam)) {
      e.data.isDefaultThirdPerson = false;
      e.data.isDefaultFreeCam = false;
      writeJson(p, e);
    }
  }
  writeJson(join(ents, `${cfg.spawnId}.json`), {
    id: cfg.spawnId,
    type: 'SpawnPoint',
    data: {
      position: cfg.placement.spawn,
      rotation: { x: 0, y: 0, z: 0 },     // 0° faces −Z: north, up runway 36 toward the Loop
      isDefaultThirdPerson: true,
      isDefaultFreeCam: true,
      alwaysSnapBack: false,
      hidden: false,
      capturedIn: 'avatar',
      displayName: 'Meigs Field, runway 36',
    },
  });

  const roomPath = join(spaceDir, 'room.json');
  const room = existsSync(roomPath) ? JSON.parse(readFileSync(roomPath, 'utf8')) : { id: 'RoomInfo', type: 'Simple', data: {} };
  room.data = { ...room.data, ...MANAGED_ROOM_KEYS };
  writeJson(roomPath, room);
}

/**
 * The Google 3D Tiles vibe, set on Meigs: its origin is the vibe's (the parking spot), so its
 * latitude / longitude are the parking spot's and its ground altitude the runway's height above
 * the ellipsoid. Everything else on an existing host (the API key above all) is left alone.
 * @param {{ lat: number, lon: number, ellipsoidH: number }} at
 */
export function stageGoogleTiles(spaceDir, cfg, tilesSrc, at, worldScale = 1) {
  if (!tilesSrc) return false;
  writeFileSync(join(spaceDir, 'plugins', `${TILES_ID}.mjs`), tilesSrc);
  const path = join(spaceDir, 'entities', `${TILES_ID}.json`);
  const old = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const where = {
    latitude: +at.lat.toFixed(6), longitude: +at.lon.toFixed(6), groundAltitude: +at.ellipsoidH.toFixed(1), tileScale: worldScale,
  };
  writeJson(path, {
    id: TILES_ID,
    type: 'UserModelEntity',
    data: {
      ...(old?.data || {}),
      glbUrl: `plugins/${TILES_ID}.mjs`,
      displayName: old?.data?.displayName || 'Google 3D Tiles — Chicago',
      position: cfg.placement.position,
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
      // a new host asks whoever can edit the space for the API key (the welcome popup)
      params: { ...(old ? {} : { showPanel: true }), ...(old?.data?.params || {}), ...where },
    },
  });
  return true;
}

function writeJson(p, obj) {
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

// ── the CLI ────────────────────────────────────────────────────────────────
function cliPath() {
  if (process.env.ARRIVAL_CLI) return process.env.ARRIVAL_CLI;
  const local = join(ROOT, '.arrival-cli', 'tools', 'arrival-cli', 'index.js');
  if (existsSync(local)) return local;
  const which = spawnSync('which', ['arrival'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  return null;
}

function arrival(args, opts = {}) {
  const cli = cliPath();
  if (!cli) throw new Error('arrival CLI not found — run `npm run sync -- setup` (or set ARRIVAL_CLI)');
  const res = spawnSync(process.execPath, [cli, ...args], { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', cwd: opts.cwd || ROOT });
  if (res.status !== 0) throw new Error(`arrival ${args.join(' ')} failed (${res.status})${opts.capture ? `\n${res.stdout}\n${res.stderr}` : ''}`);
  return res.stdout;
}

/** ARRIVAL_TOKEN (an Arrival API key) stands in for the browser login on headless machines. */
function ensureToken(cfg) {
  const file = join(homedir(), '.arrival', 'config.json');
  const have = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const token = process.env.ARRIVAL_TOKEN;
  if (token && have.token !== token) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...have, server: cfg.server, token }, null, 2), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* non-POSIX */ }
    return;
  }
  if (!have.token) throw new Error('not signed in — run `npm run sync -- login`, or export ARRIVAL_TOKEN=<your Arrival API key>');
}

function setup() {
  const dir = join(ROOT, '.arrival-cli');
  if (!existsSync(dir)) {
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', 'https://github.com/arrival-space/arrival-plugins.git', dir], { stdio: 'inherit' });
    execFileSync('git', ['sparse-checkout', 'set', 'tools/arrival-cli'], { cwd: dir, stdio: 'inherit' });
  } else {
    execFileSync('git', ['pull', '--ff-only'], { cwd: dir, stdio: 'inherit' });
  }
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: join(dir, 'tools', 'arrival-cli'), stdio: 'inherit' });
  console.log('arrival CLI ready:', cliPath());
}

/** Fresh pull into a temp dir, then swap it in as the workspace (our managed files are re-staged after). */
function pullFresh(cfg) {
  const tmp = mkdtempSync(join(tmpdir(), 'arrival-pull-'));
  arrival(['pull', cfg.spaceId, '--dir', join(tmp, 'ws')]);
  rmSync(WORKSPACE, { recursive: true, force: true });
  cpSync(join(tmp, 'ws'), WORKSPACE, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
}

async function stageWorkspace(cfg) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });
  const spaceDir = join(WORKSPACE, 'space');
  stage(spaceDir, cfg, readFileSync(DIST, 'utf8'), await pluginDefaults());
  const room = JSON.parse(readFileSync(join(spaceDir, 'room.json'), 'utf8'));
  // the library's vibe, with the lake shaded as water from our OSM mask (scripts/tilesWater.mjs)
  let tilesSrc = existsSync(TILES_SRC) ? readFileSync(TILES_SRC, 'utf8') : null;
  if (tilesSrc) {
    const patched = patchTilesWater(tilesSrc);
    if (!patched.ok) console.warn('google-3d-tiles: the library changed, staged without the water shading (scripts/tilesWater.mjs)');
    tilesSrc = patched.src;
  }
  stageGoogleTiles(spaceDir, cfg, tilesSrc, parkingSpot(), room.data?.worldScale ?? 1);
}

/** Where the airplane parks, on the ellipsoid: the Google tiles' anchor. */
function parkingSpot() {
  const w = buildMeigs();
  const s = w.startPosition();
  const [lat, lon] = w.frame.toLatLon(s.n, s.e);
  return { lat, lon, ellipsoidH: w.elevation + w.data.geoidM };
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
    case 'setup': return setup();
    case 'login': return arrival(['login', '--server', cfg.server]);
    case 'create': {
      ensureToken(cfg);
      if (cfg.spaceId) throw new Error(`arrival.json already names space ${cfg.spaceId}`);
      const out = arrival(['create', rest[0] || cfg.title, '--privacy', cfg.privacy || 'Closed', '--description', cfg.description || ''], { capture: true });
      const id = (out.match(/\d{8}_\d{4}/) || [])[0];
      if (!id) throw new Error(`could not read the new space id from:\n${out}`);
      writeJson(CONFIG, { ...cfg, spaceId: id });
      console.log(`created space ${id} — https://arrival.space/${id}\nnext: npm run sync -- push`);
      return;
    }
    case 'status':
    case 'validate':
    case 'push': {
      ensureToken(cfg);
      if (!cfg.spaceId) throw new Error('no spaceId in arrival.json — run `npm run sync -- create` first');
      if (cmd === 'push') execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' });
      pullFresh(cfg);
      await stageWorkspace(cfg);
      arrival(['status'], { cwd: WORKSPACE });
      if (cmd === 'status') return;
      arrival(['validate'], { cwd: WORKSPACE });
      if (cmd === 'validate') return;
      arrival(['push'], { cwd: WORKSPACE });
      console.log(`pushed — reload https://arrival.space/${cfg.spaceId}`);
      return;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 20).join('\n'));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
