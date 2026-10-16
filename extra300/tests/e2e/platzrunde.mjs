// platzrunde.mjs — fly the scripted circuit in the browser harness (the real
// vibe, the OSM city) and photograph it: takeoff, crosswind, the loop, final,
// the landing. Also writes the flight log as JSON.
//   node tests/e2e/platzrunde.mjs [outDir]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '../../scripts/serve.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const out = process.argv[2] || 'dist/platzrunde';
mkdirSync(out, { recursive: true });
const server = await serve(8744);
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8744/tests/harness/?fly=1&view=chase&flight=platzrunde');
await page.waitForFunction(() => window.harnessReady && window.vibe.city && window.vibe.city.queue.length === 0, null, { timeout: 300000 });
await page.evaluate(() => { window.vibe.hud.toggleHelp(false); window.startFlight(4); });

const view = (v) => page.evaluate((v) => { const r = window.vibe.cameraRig; while (r.view !== v) r.cycle(); window.vibe._setAvatarVisible(v !== 'cockpit'); window.vibe.visual.setCockpitView(v === 'cockpit'); }, v);
const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 900000, polling: 200 });
const snap = async (name, speed = 1) => {
  await page.evaluate((s) => { window.flightSpeedup = s; }, speed);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await page.evaluate(() => { window.flightSpeedup = 4; });
  console.log('shot', name, await page.evaluate(() => `${window.pilot.phase} t=${window.pilot.t.toFixed(0)}s`));
};

await until(() => window.pilot.phase === 'takeoff' && window.pilot.kt > 45);
await snap('1-takeoff-roll');
await until(() => window.pilot.phase === 'crosswind');
await view('chase'); await snap('2-crosswind-turn');
await until(() => window.pilot.phase === 'loop' && window.pilot.loopTurned > 1.2);
await view('flyby'); await snap('3-loop-going-up');
await until(() => window.pilot.phase === 'loop' && window.pilot.loopTurned > 3.0);
await view('cockpit'); await snap('4-loop-inverted-at-the-top');
await until(() => window.pilot.phase === 'final' && window.pilot.agl < 120);
await view('cockpit'); await snap('5-final-runway-36');
await until(() => window.pilot.phase === 'rollout');
await view('tower'); await snap('6-touchdown');
await until(() => window.pilot.phase === 'stopped');
await view('chase'); await snap('7-stopped');
const result = await page.evaluate(() => ({ events: window.pilot.events, loop: window.pilot.loopResult, touchdown: window.pilot.touchdown, damage: window.vibe.ac.damage }));
writeFileSync(join(out, 'flight.json'), JSON.stringify(result, null, 1));
await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log(JSON.stringify({ loop: result.loop, touchdown: result.touchdown, damage: result.damage }));
