// page_run.mjs — open a bench page headless with WebGPU and wait for its done file.
//   node tests/bench/page_run.mjs "render_orbit.html?ply=...&out=orbit" --done=scratch/orbit_done.json [--port=8734] [--wait=600]
import { chromium } from 'playwright';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const pageQ = args.find((a) => !a.startsWith('--')) || '';
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const doneFile = opt('done', 'scratch/done.json');
if (existsSync(doneFile)) unlinkSync(doneFile);
const browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed'), args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
page.on('console', (m) => { const t = m.text(); if (/^\[(RENDER|KEYHOLE|BENCH)\]/.test(t)) console.log(t.slice(0, 220)); });
page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e).slice(0, 300)));
await page.goto(`http://localhost:${opt('port', '8734')}/tests/bench/${pageQ}`, { waitUntil: 'load' });
const waitS = +opt('wait', '600');
// a page that cannot read its own WebGL canvas asks for a screenshot via its title
for (let i = 0; i < waitS * 5; i++) {
  if (existsSync(doneFile)) break;
  const title = await page.title().catch(() => '');
  if (title.startsWith('shot:')) {
    const name = title.slice(5);
    await page.locator('#cv').screenshot({ path: `scratch/${name}` });
    await page.evaluate(() => { window.__shotDone = true; });
  }
  await page.waitForTimeout(200);
}
await browser.close();
if (!existsSync(doneFile)) { console.log('TIMEOUT'); process.exit(1); }
const d = JSON.parse(readFileSync(doneFile, 'utf8'));
if (d.error) { console.log('FAILED', d.error); process.exit(1); }
console.log('OK');
