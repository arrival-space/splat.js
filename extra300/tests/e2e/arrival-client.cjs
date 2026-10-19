// realclient.cjs — load the Extra300 vibe into the REAL arrival.space client, headless, as a guest,
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
const CLICK_BOARD = process.env.CLICK_BOARD !== '0'; // try boarding by clicking the airplane (onEntityClick)

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

  // ── 2. environment + API surface ───────────────────────────────────────
  const env = await page.evaluate(() => {
    const app = window.pc.app || window.pc.AppBase.getApplication() || window.app;
    window.__app = app;
    const AS = window.ArrivalSpace;
    const fnNames = ['attachPlayerToEntity', 'onEntityClick', 'getPlayerMesh', 'getPlayer', 'teleportPlayer', 'setCameraMode',
      'getCameraMode', 'getCamera', 'getLocalAttachedEntity', 'getPlugins'];
    const asTypes = Object.fromEntries(fnNames.map((n) => [n, typeof AS[n]]));
    const findDesc = (proto, name) => {
      for (let p = proto; p; p = Object.getPrototypeOf(p)) {
        const d = Object.getOwnPropertyDescriptor(p, name);
        if (d) return d.get ? 'getter' : typeof d.value;
      }
      return 'missing';
    };
    const scrNames = ['lockKeyboard', 'unlockKeyboard', 'getUIContainer', 'getLeftStick', 'getRightStick', 'isMobile'];
    const scrTypes = Object.fromEntries(scrNames.map((n) => [n, findDesc(window.ArrivalScript.prototype, n)]));
    const cam = AS.getCamera();
    const p = cam.getPosition();
    // does the client fire 'prerender'? count for 3 s
    window.__prerender = 0; window.__frames = 0;
    app.on('prerender', () => { window.__prerender++; });
    app.on('frameend', () => { window.__frames++; });
    return {
      VERSION: AS.VERSION, pcVersion: window.pc.version, appSource: window.pc.app ? 'pc.app' : (window.app ? 'window.app' : 'AppBase.getApplication'),
      appIsGetApplication: app === (window.pc.AppBase.getApplication && window.pc.AppBase.getApplication()),
      worldScale: app.worldScale, cameraMode: AS.getCameraMode && AS.getCameraMode(), cameraName: cam.name,
      cameraPos: [p.x, p.y, p.z], cameraHasCameraComponent: !!cam.camera,
      asTypes, scrTypes, isScriptSubclassOfPcScript: window.ArrivalScript.prototype instanceof window.pc.Script,
      plugins: (() => { try { const r = AS.getPlugins && AS.getPlugins(); return Array.isArray(r) ? r.length : typeof r; } catch (e) { return 'throws: ' + e.message; } })(),
      player: (() => { const pl = AS.getPlayer && AS.getPlayer(); if (!pl) return null; const q = pl.getPosition(); return [q.x, q.y, q.z]; })(),
    };
  });
  log('env', JSON.stringify(env, null, 1));
  await page.waitForTimeout(3000);
  env.prerenderIn3s = await page.evaluate(() => window.__prerender);
  env.framesIn3s = await page.evaluate(() => window.__frames);
  log('prerender events in 3 s:', env.prerenderIn3s, 'frames:', env.framesIn3s);
  await page.screenshot({ path: path.join(OUT, (PRE_MODE ? PRE_MODE + '_' : '') + '01_space_loaded.png') });

  // ── 3. inject the bundle, create the vibe ──────────────────────────────
  const created = await page.evaluate(async (src) => {
    const out = { importVia: null, importError: null };
    let mod;
    try {
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      mod = await import(url);
      out.importVia = 'blob';
    } catch (e) {
      out.importError = String(e && e.message || e);
      mod = await import('https://arrival.space/__extra300_local__/extra300-meigs.mjs?t=' + Date.now());
      out.importVia = 'route-fulfilled';
    }
    out.exports = Object.keys(mod);
    out.scriptName = mod.Extra300 && mod.Extra300.scriptName;
    const app = window.__app;
    const AS = window.ArrivalSpace;
    const host = new window.pc.Entity('extra300-local-test');
    // put the vibe at the guest player's feet
    const pl = AS.getPlayer && AS.getPlayer();
    if (pl) { const q = pl.getPosition(); host.setPosition(q.x, q.y, q.z); }
    app.root.addChild(host);
    host.addComponent('script');
    try {
      const vibe = host.script.create(mod.Extra300);
      window.vibe = vibe;
      out.created = !!vibe;
      out.initialized = !!(vibe && vibe.ac && vibe.visual && vibe.hud);
      const a = vibe.visual.root.getPosition();
      out.aircraftPos = [a.x, a.y, a.z];
      out.ws = vibe._ws;
    } catch (e) {
      out.createError = String(e && e.stack || e);
    }
    return out;
  }, bundleText);
  log('created', JSON.stringify(created));

  if (PRE_MODE) {
    created.preMode = await page.evaluate(async (m) => { const ok = window.ArrivalSpace.setCameraMode(m); await new Promise((r) => setTimeout(r, 1500)); return { ok, now: window.ArrivalSpace.getCameraMode() }; }, PRE_MODE);
    log('pre-mode', JSON.stringify(created.preMode));
  }
  // look at the parked airplane from the side for the "before" shot (camera mode stays as-is;
  // the client's camera script will likely take it back, so set it in a prerender hook)
  await page.evaluate(() => {
    const vibe = window.vibe; if (!vibe) return;
    const app = window.__app; const AS = window.ArrivalSpace;
    const ap = vibe.visual.root.getPosition().clone();
    const ws = vibe._ws;
    window.__peek = () => { const c = AS.getCamera(); c.setPosition(ap.x - 9 * ws, ap.y + 2.2 * ws, ap.z + 7 * ws); c.lookAt(ap.x, ap.y + 1 * ws, ap.z); };
    app.on('prerender', window.__peek);
  });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, (PRE_MODE ? PRE_MODE + '_' : '') + '02_before_boarding.png') });
  let clickBoard = null;
  if (CLICK_BOARD) {
    const sp = await page.evaluate(() => {
      const AS = window.ArrivalSpace; const cam = AS.getCamera(); const v = window.vibe;
      const p = v.visual.root.getPosition(); const ws = v._ws;
      const s = cam.camera.worldToScreen(new window.pc.Vec3(p.x, p.y + 0.3 * ws, p.z));
      const c = window.__app.graphicsDevice.canvas; const r = c.getBoundingClientRect();
      return { x: r.left + s.x * r.width / c.clientWidth, y: r.top + s.y * r.height / c.clientHeight };
    });
    await page.mouse.click(sp.x, sp.y);
    await page.waitForTimeout(3000);
    clickBoard = { at: sp, flying: await page.evaluate(() => window.vibe._flying) };
    log('click-to-board', JSON.stringify(clickBoard));
  }
  await page.evaluate(() => { window.__app.off('prerender', window.__peek); });

  // ── 4. board + fly ─────────────────────────────────────────────────────
  const boarded = await page.evaluate(() => {
    const vibe = window.vibe; const AS = window.ArrivalSpace; const app = window.__app;
    if (!vibe) return { error: 'no vibe' };
    const r = {};
    r.alreadyFlyingFromClick = vibe._flying;
    if (vibe._loadIntro) vibe._endIntro();   // the film at load still running: back on foot first
    vibe.playIntro = false;   // straight to flying: the film has its own checks (tests/intro.test.js, the harness ?intro=1)
    try { vibe._enter(); } catch (e) { r.enterError = String(e && e.stack || e); }
    if (vibe._intro) vibe._endIntro();   // boarded by the click above, which started the film
    r.flying = vibe._flying;
    r.attachHandle = vibe._attach ? Object.keys(vibe._attach) : null;
    r.localAttached = (AS.getLocalAttachedEntity && AS.getLocalAttachedEntity()) === vibe.visual.root;
    r.cameraModeAfterEnter = AS.getCameraMode && AS.getCameraMode();
    // camera override check: after every rendered frame compare the camera pose to what the plugin set
    window.__camCheck = [];
    window.__camHook = () => {
      const cam = AS.getCamera(); const pose = vibe._pose; if (!cam || !pose) return;
      const o = vibe._worldRoot.getPosition(); const ws = vibe._ws;
      const want = [o.x + pose.pos[0] * ws, o.y + pose.pos[1] * ws, o.z + pose.pos[2] * ws];
      const p = cam.getPosition(); const q = cam.getRotation();
      const dq = Math.abs(q.x * pose.rot[0] + q.y * pose.rot[1] + q.z * pose.rot[2] + q.w * pose.rot[3]);
      window.__camCheck.push({ dPos: Math.hypot(p.x - want[0], p.y - want[1], p.z - want[2]), quatDot: dq, fov: cam.camera && cam.camera.fov, wantFov: pose.fov });
    };
    app.on('frameend', window.__camHook);
    return r;
  });
  log('boarded', JSON.stringify(boarded));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, (PRE_MODE ? PRE_MODE + '_' : '') + '03_after_boarding.png') });

  const flyStart = await page.evaluate(() => {
    const v = window.vibe; v.mapper.throttle = 1;
    return { t: performance.now(), simT: v.ac.t ?? null, rpm: v.ac.rpm, tas: v.ac.out && v.ac.out.tas };
  });
  const samples = [];
  for (let i = 0; i < FLY_SECONDS; i++) {
    await page.waitForTimeout(1000);
    samples.push(await page.evaluate(() => {
      const v = window.vibe; const AS = window.ArrivalSpace; const c = AS.getCamera().getPosition();
      return { rpm: Math.round(v.ac.rpm), tas: +(v.ac.out && v.ac.out.tas || 0).toFixed(2), throttle: v.mapper.throttle, frames: window.__frames, mode: AS.getCameraMode(), cam: [c.x, c.y, c.z].map((n) => +n.toFixed(2)) };
    }));
  }
  log('samples', JSON.stringify(samples));
  await page.screenshot({ path: path.join(OUT, (PRE_MODE ? PRE_MODE + '_' : '') + '04_after_throttle.png') });

  const final = await page.evaluate(() => {
    const v = window.vibe; const AS = window.ArrivalSpace; const app = window.__app;
    const c = AS.getCamera(); const p = c.getPosition();
    const cc = window.__camCheck;
    const maxD = cc.reduce((m, s) => Math.max(m, s.dPos), 0);
    const minDot = cc.reduce((m, s) => Math.min(m, s.quatDot), 1);
    return {
      rpm: v.ac.rpm, tas: v.ac.out && v.ac.out.tas, ias: v.instruments.values.ias, agl: v.ac.agl,
      cameraMode: AS.getCameraMode(), cameraPos: [p.x, p.y, p.z], cameraFov: c.camera && c.camera.fov,
      worldScale: app.worldScale, VERSION: AS.VERSION,
      camCheck: { frames: cc.length, maxPosErr: maxD, minQuatDot: minDot, last: cc[cc.length - 1] },
      hudInDom: !!document.querySelector('canvas') && v.hud && v.hud.root ? document.body.contains(v.hud.root) : 'unknown',
      uiContainer: (() => { const u = v.getUIContainer(); return u ? { tag: u.tagName, id: u.id, cls: u.className, children: u.children.length } : null; })(),
      isMobile: v.isMobile,
    };
  });
  log('final', JSON.stringify(final, null, 1));

  // exit cleanly to see the client restores
  const exited = await page.evaluate(() => {
    const v = window.vibe; const AS = window.ArrivalSpace;
    try { v._exit(); } catch (e) { return { exitError: String(e && e.stack || e) }; }
    const pl = AS.getPlayer && AS.getPlayer(); const pp = pl && pl.getPosition();
    const mesh = AS.getPlayerMesh && AS.getPlayerMesh();
    const cam = AS.getCamera();
    return { flying: v._flying, cameraMode: AS.getCameraMode(), playerPos: pp && [pp.x, pp.y, pp.z], playerMeshEnabled: mesh && mesh.enabled,
      clip: cam.camera && [cam.camera.nearClip, cam.camera.farClip, cam.camera.fov], attached: !!(AS.getLocalAttachedEntity && AS.getLocalAttachedEntity()) };
  });
  log('exited', JSON.stringify(exited));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, (PRE_MODE ? PRE_MODE + '_' : '') + '05_after_exit.png') });
  exited.after3s = await page.evaluate(() => { const AS = window.ArrivalSpace; const c = AS.getCamera().getPosition(); const pl = AS.getPlayer(); const pp = pl && pl.getPosition();
    return { cameraMode: AS.getCameraMode(), cam: [c.x, c.y, c.z], playerPos: pp && [pp.x, pp.y, pp.z] }; });
  log('after exit +3s', JSON.stringify(exited.after3s));
  exited.trail = [];
  for (let i = 0; i < Number(process.env.EXIT_SECONDS || 12); i++) {
    await page.waitForTimeout(1000);
    exited.trail.push(await page.evaluate(() => { const AS = window.ArrivalSpace; const c = AS.getCamera().getPosition(); const pp = AS.getPlayer().getPosition();
      return { mode: AS.getCameraMode(), frames: window.__frames, cam: [c.x, c.y, c.z].map((n) => +n.toFixed(1)), player: [pp.x, pp.y, pp.z].map((n) => +n.toFixed(1)), dist: +Math.hypot(c.x - pp.x, c.y - pp.y, c.z - pp.z).toFixed(1) }; }));
  }
  log('exit trail', JSON.stringify(exited.trail));
  await page.screenshot({ path: path.join(OUT, (PRE_MODE ? PRE_MODE + '_' : '') + '06_after_exit_settled.png') });

  const report = {
    space: SPACE, preMode: PRE_MODE, clickBoard, env, created, boarded, flyStart, samples, final, exited,
    pageErrors: pageErrors.map((e) => ({ ...e, afterInject: e.t >= tInject })),
    consoleErrors: consoleErrors.map((e) => ({ ...e, afterInject: e.t >= tInject })),
    consoleWarningsAfterInject: consoleWarnings.filter((e) => e.t >= tInject),
    failedAfterInject: failed.filter((f) => f.t >= tInject).map((f) => `${f.m} ${f.u} ${f.e}`),
    blockedWrites: [...new Set(blocked)], wsBlocked: [...new Set(wsBlocked)],
  };
  fs.writeFileSync(path.join(OUT, `report${PRE_MODE ? '-' + PRE_MODE : ''}.json`), JSON.stringify(report, null, 1));
  log('pageErrors', JSON.stringify(report.pageErrors, null, 1));
  log('consoleErrors(after inject)', JSON.stringify(report.consoleErrors.filter((e) => e.afterInject), null, 1));
  log('consoleErrors(before inject, count)', report.consoleErrors.filter((e) => !e.afterInject).length);
  log('blocked writes', JSON.stringify(report.blockedWrites, null, 1));
  log('failed requests after inject', JSON.stringify([...new Set(report.failedAfterInject)]));
  log('blocked ws', JSON.stringify(report.wsBlocked));
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
