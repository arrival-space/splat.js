// shots.mjs — load the harness in headless Chromium and take screenshots of
// the airplane and Meigs Field from several views; fails on page errors.
//   node tests/e2e/shots.mjs [outDir]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '../../scripts/serve.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const out = process.argv[2] || 'dist/shots';
mkdirSync(out, { recursive: true });
const server = await serve(8741);
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors = [];
async function shot(name, query, prep) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(`${name}: ${m.text()}`); });
  await page.goto(`http://localhost:8741/tests/harness/${query}`);
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 60000 });
  if (prep) await page.evaluate(prep);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await page.close();
}

await shot('01-parked', '?');
await shot('02-cockpit-runway36', '?fly=1&view=cockpit');
await shot('03-chase', '?fly=1&view=chase');
await shot('04-tower', '?fly=1&view=tower');
// in flight over the lake, banked, looking back at the skyline
await shot('05-inflight-chase', '?fly=1&view=chase', () => {
  const ac = window.vibe.ac;
  ac.placeInFlight(-200, 600, 180 + 450, 330 * Math.PI / 180, 65);
  ac.state.q = [0.94, -0.2, 0.05, -0.27];
  window.vibe.mapper.throttle = 0.8;
});
await shot('06-inflight-cockpit', '?fly=1&view=cockpit', () => {
  const ac = window.vibe.ac;
  ac.placeInFlight(-1500, 300, 180 + 300, 340 * Math.PI / 180, 65);
  window.vibe.mapper.throttle = 0.8;
});

// drive it through the real key handler: board with E, full throttle with End, hold the brakes off
{
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => errors.push(`roll: ${e.message}`));
  await page.goto('http://localhost:8741/tests/harness/?');
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 60000 });
  await page.keyboard.press('e');
  const boarded = await page.evaluate(() => window.vibe._flying);
  if (!boarded) errors.push('roll: pressing E beside the airplane did not board it');
  await page.keyboard.down('End');
  await page.waitForTimeout(6000);
  const s = await page.evaluate(() => ({ tas: window.vibe.ac.out.tas, rpm: window.vibe.ac.rpm, t: window.vibe.ac.time, dn: window.vibe.ac.state.pos[0] }));
  await page.keyboard.up('End');
  console.log(`takeoff roll in the browser: ${s.t.toFixed(1)} s simulated, ${s.rpm.toFixed(0)} rpm, ${(s.tas / 0.5144).toFixed(0)} kt`);
  if (!(s.rpm > 2400 && s.tas > 8)) errors.push(`roll: full throttle did not get it rolling (${JSON.stringify(s)})`);
  await page.screenshot({ path: join(out, '07-takeoff-roll.png') });
  await page.close();
}
await browser.close();
server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('screenshots in', out);
