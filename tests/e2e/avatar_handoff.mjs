// avatar_handoff.mjs — the embedded route, end to end: a host page iframes the
// app with ?handoff=1, the app makes an avatar, and the finished package comes
// back over postMessage. This is the contract the splat rigger consumes; the
// host page here (scratch/handoff_host.html) is a stand-in for it.
//
//   node tests/e2e/avatar_handoff.mjs --video=scratch/tom_avatar.mov [--iters=1200]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const VIDEO = opt('video', 'scratch/tom_avatar.mov');
const OUT = opt('out', 'scratch/handoff');
const PORT = opt('port', '8734');

const browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed'), args: [
  '--enable-unsafe-webgpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
page.on('console', (m) => { const t = m.text(); if (/\[host\]|\[avatar\]|handed|PAGEERROR/i.test(t)) log(t.slice(0, 200)); });
page.on('pageerror', (e) => log('PAGEERROR ' + String(e).slice(0, 200)));

await page.goto(`http://localhost:${PORT}/scratch/handoff_host.html?iters=${opt('iters', '1200')}`, { waitUntil: 'load' });
const frame = async () => {
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((x) => x.url().includes('/app/index.html'));
    if (f) return f;
    await page.waitForTimeout(500);
  }
  throw new Error('the app frame never appeared');
};
const f = await frame();
await f.waitForSelector('#file-input', { state: 'attached', timeout: 60000 });   // it is hidden by design
await f.setInputFiles('#file-input', VIDEO);
log('video set');
await f.waitForSelector('#vid-use', { timeout: 300000 });
await f.click('#vid-use');
await f.waitForSelector('#set-avatar', { timeout: 60000 });
await f.check('#set-avatar');
log('avatar box ticked');
await f.click('#btn-go');
log('run started');

// the hand-off, or a failure, whichever comes first
await page.waitForFunction(() => (window.__got || []).some((m) => m.type === 'splat-done' || m.type === 'splat-error'),
  null, { timeout: 1800000, polling: 2000 });
const got = await page.evaluate(() => window.__got);
await page.screenshot({ path: `${OUT}.png` });
console.log('\nwhat the host received:');
for (const m of got) console.log(`  ${m.type.padEnd(12)} ${(m.assetType || '').padEnd(10)} ${m.name || m.message || ''} ${m.bytes ? `${(m.bytes / 1e6).toFixed(2)} MB` : ''}`);

const kinds = new Set(got.filter((m) => m.type === 'splat-asset').map((m) => m.assetType));
const ok = got.some((m) => m.type === 'splat-done') && ['splat', 'binding', 'fit'].every((k) => kinds.has(k));
console.log(ok ? '\nPASS — splat, binding and fit handed over, then splat-done' : '\nFAIL — see above');
await browser.close();
process.exit(ok ? 0 : 1);
