// keyhole_run.mjs — drives tests/bench/keyhole.html headless and prints the row.
//   node tests/bench/keyhole_run.mjs "dir=keyhole&train=1,12,23&seed=cloud&iters=3000&tag=cloud6" [--headed] [--port=8734]
//
// Publishing to the account without a click (2026-09-21, the user: "create a
// way you can upload the avatar to my account without pressing a button"):
//   --profile=scratch/pw-profile   a browser profile of the harness's own; the
//                                  app's sign-in token lives in its localStorage
//   --publish=1                    press "Use as my avatar" for the user once the
//                                  panel is up; with a token in the profile no
//                                  popup opens and the upload just runs
// The FIRST time, run --headed: the click opens the sign-in popup and the user
// signs in there (the harness never sees or types a credential); from then on
// the token in the profile carries every later run, headless.
import { chromium } from 'playwright';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--')) || '';
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const tag = new URLSearchParams(query).get('tag') || 'run';
const doneFile = `scratch/keyhole_${tag}_done.json`;
if (existsSync(doneFile)) unlinkSync(doneFile);
const headless = !args.includes('--headed');
const chromeArgs = ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'];
const profile = opt('profile', '');
let browser, page;
if (profile) {
  mkdirSync(profile, { recursive: true });
  browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless, args: chromeArgs, viewport: { width: 900, height: 1000 } });
  page = browser.pages()[0] || await browser.newPage();
} else {
  browser = await chromium.launch({ channel: 'chrome', headless, args: chromeArgs });
  page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
}
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
page.on('console', (m) => { const t = m.text(); if (/\[KEYHOLE\]/.test(t)) log(t.replace('[KEYHOLE] ', '').slice(0, 220)); });
page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e).slice(0, 300)));
await page.goto(`http://localhost:${opt('port', '8734')}/tests/bench/keyhole.html?${query}`, { waitUntil: 'load' });
// --wait=N seconds (default 7200); the avatar route waits for the user's click and sign-in
const waitS = +opt('wait', '7200');
let pressed = false;
for (let i = 0; i < waitS / 2; i++) {
  if (existsSync(doneFile)) break;
  if (opt('publish', '') === '1' && !pressed) {
    const go = await page.$('#av-go');
    if (go) {
      const hasToken = await page.evaluate(() => !!localStorage.getItem('splatjs.arrival.token') || Object.keys(localStorage).some((k) => /token/i.test(k) && localStorage.getItem(k)));
      await go.click();
      pressed = true;
      log(hasToken ? 'pressed "Use as my avatar" — the stored sign-in carries the upload' : 'pressed "Use as my avatar" — no token in this profile yet: sign in ONCE in the popup');
    }
  }
  await page.waitForTimeout(2000);
}
if (pressed) {
  const st = await page.evaluate(() => document.querySelector('#av-status')?.textContent || '').catch(() => '');
  log('publish status: ' + st);
}
await browser.close();
if (!existsSync(doneFile)) { console.log('TIMEOUT'); process.exit(1); }
const d = JSON.parse(readFileSync(doneFile, 'utf8'));
if (d.error) { console.log('FAILED', d.error); process.exit(1); }
const r = JSON.parse(readFileSync(`scratch/keyhole_${tag}.json`, 'utf8'));
console.log(`ROW ${tag}: held-out ${r.psnrHeld} dB (median ${r.psnrHeldMedian}, min ${r.psnrHeldMin}, n ${r.nHeld}) · train ${r.psnrTrain} dB · ${r.splats} splats · ${r.iters} it · ${r.minutes} min · seed ${r.seed}`);
