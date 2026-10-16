// arrival-demo-button.cjs — (built on arrival-client.cjs) load the Extra300 vibe into the REAL arrival.space client, headless, as a guest,
// strictly read-only: every non-GET/HEAD/OPTIONS request is aborted and the realtime websocket is
// closed before it opens. The bundle is injected from a Blob URL (fallback: a Playwright-fulfilled
// URL that never touches the server). Nothing is saved to any space or account.
//
// usage: node tests/e2e/arrival-client.cjs [spaceId] [bundlePath]   (npm run test:arrival)
// Screenshots and report.json go to dist/arrival-client/ (or $OUT).
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
const CHROMIUM = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);

const OUT = process.env.OUT || require('path').join(__dirname, '..', '..', 'dist', 'arrival-client');
require('fs').mkdirSync(OUT, { recursive: true });
const SPACE = process.argv[2] || '42485456_9715';
const BUNDLE = process.argv[3] || require('path').join(__dirname, '..', '..', 'dist', 'extra300-meigs.mjs');
const FLY_SECONDS = Number(process.env.FLY_SECONDS || 10);
const PRE_MODE = process.env.PRE_MODE || '';      // e.g. 'third': local camera mode to set before boarding
 // try boarding by clicking the airplane (onEntityClick)

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

(async () => {
  const bundleText = fs.readFileSync(BUNDLE, 'utf8');
  const browser = await chromium.launch({
    executablePath: CHROMIUM, headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  // ── read-only guard ────────────────────────────────────────────────────
  const blocked = [];
  await page.route('**/*', (route, req) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      blocked.push(`${req.method()} ${req.url().replace(/\?.*$/, '')}`);
      return route.abort();
    }
    return route.continue();
  });
  // the local-only fallback URL for the bundle (fulfilled here, never sent to the server)
  await page.route('https://arrival.space/__extra300_local__/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: bundleText }));
  const wsBlocked = [];
  await page.routeWebSocket(/.*/, (ws) => { wsBlocked.push(ws.url().replace(/\?.*$/, '')); ws.close(); });

  const pageErrors = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  const failed = [];
  page.on('requestfailed', (r) => failed.push({ t: Date.now(), m: r.method(), u: r.url().replace(/\?.*$/, ''), e: r.failure() && r.failure().errorText }));
  page.on('pageerror', (e) => pageErrors.push({ t: Date.now(), msg: e.message, stack: (e.stack || '').split('\n').slice(0, 4).join(' | ') }));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ t: Date.now(), msg: m.text().slice(0, 400) });
    if (m.type() === 'warning') consoleWarnings.push({ t: Date.now(), msg: m.text().slice(0, 300) });
  });

  // ── 1. open the space as a guest ───────────────────────────────────────
  log('goto', SPACE);
  await page.goto(`https://arrival.space/${SPACE}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => {
    const app = (window.pc && (window.pc.app || (window.pc.AppBase && window.pc.AppBase.getApplication && window.pc.AppBase.getApplication()))) || window.app;
    return window.ArrivalSpace && window.ArrivalScript && app && app.root && window.ArrivalSpace.getCamera && window.ArrivalSpace.getCamera();
  }, null, { timeout: 300000, polling: 1000 });
  log('client globals ready; letting the space settle 15 s');
  await page.waitForTimeout(15000);
  const tInject = Date.now();


  const app0 = await page.evaluate(() => { window.__app = window.pc.app || window.pc.AppBase.getApplication() || window.app; return { VERSION: window.ArrivalSpace.VERSION }; });
  log('client', JSON.stringify(app0));
  // ── inject the vibe (Blob URL, nothing leaves the page) ─────────────────
  const created = await page.evaluate(async (src) => {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const mod = await import(url);
    const host = new window.pc.Entity('extra300-demo-test');
    const pl = window.ArrivalSpace.getPlayer && window.ArrivalSpace.getPlayer();
    if (pl) { const q = pl.getPosition(); host.setPosition(q.x, q.y, q.z); }
    window.__app.root.addChild(host);
    host.addComponent('script');
    window.vibe = host.script.create(mod.Extra300);
    return !!window.vibe.hud;
  }, bundleText);
  log('vibe created', created);
  await page.waitForTimeout(4000);

  const probe = () => page.evaluate(() => {
    const b = window.vibe.hud.demoButton;
    const r = b.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const cs = getComputedStyle(b);
    return { x, y, w: r.width, h: r.height, text: b.textContent, pointerEvents: cs.pointerEvents, visible: cs.display !== 'none' && cs.visibility !== 'hidden',
      topmostIsButton: top === b, topmost: top ? `${top.tagName}#${top.id}.${String(top.className).slice(0, 40)}` : null };
  });
  const result = { before: await probe() };
  log('button before', JSON.stringify(result.before));
  await page.screenshot({ path: path.join(OUT, 'demo-1-button.png') });

  // a real pointer: move, press, release where the button is drawn
  await page.mouse.move(result.before.x, result.before.y);
  await page.waitForTimeout(300);
  await page.mouse.click(result.before.x, result.before.y);
  await page.waitForTimeout(2500);
  result.afterClick = await page.evaluate(() => ({ demo: !!window.vibe._demo, flying: window.vibe._flying, phase: window.vibe._demo && window.vibe._demo.phase, status: window.vibe.hud.demoStatus.textContent }));
  log('after click', JSON.stringify(result.afterClick));
  await page.waitForFunction(() => window.vibe._demo && window.vibe._demo.phase !== 'takeoff', null, { timeout: 240000, polling: 1000 }).catch(() => {});
  result.later = await page.evaluate(() => ({ phase: window.vibe._demo && window.vibe._demo.phase, kt: window.vibe.instruments.values.ias, altFt: window.vibe.instruments.values.altitude, view: window.vibe.cameraRig.view }));
  log('later', JSON.stringify(result.later));
  await page.screenshot({ path: path.join(OUT, 'demo-2-flying.png') });

  // take over with the same button, by mouse
  result.takeOverButton = await probe();
  await page.mouse.click(result.takeOverButton.x, result.takeOverButton.y);
  await page.waitForTimeout(1500);
  result.afterTakeOver = await page.evaluate(() => ({ demo: !!window.vibe._demo, label: window.vibe.hud.demoButton.textContent }));
  log('after take-over click', JSON.stringify(result.afterTakeOver));
  result.pageErrors = pageErrors.filter((e) => e.t > tInject).map((e) => e.msg);
  fs.writeFileSync(path.join(OUT, 'demo-button-report.json'), JSON.stringify(result, null, 1));
  const ok = result.before.topmostIsButton && result.afterClick.demo && result.afterClick.flying && !result.afterTakeOver.demo && !result.pageErrors.length;
  log(ok ? 'PASS: the button is clickable in the real client' : 'FAIL', JSON.stringify(result.pageErrors));
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
