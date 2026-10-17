// record-intro.cjs — render the boarding intro film from the real arrival.space client to an MP4.
//
//   node tests/e2e/record-intro.cjs [spaceId] [out.mp4]          (AIRCRAFT=f15c for the Eagle's film)
//
// Opens the space as a guest (read-only: every write and websocket is blocked), finds the vibe
// already placed there, boards, and then renders the film frame by frame at a fixed time step:
// the client's clock is frozen (app.timeScale = 0) and the vibe is stepped by exactly 1/FPS per
// frame, so the video plays at full speed however slowly software GL draws. Frames → ffmpeg.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

// a public space: a guest can't open a Closed one. Where the vibe isn't placed (any space but ours),
// the built bundle is injected at the guest's feet, as tests/e2e/arrival-client.cjs does.
const SPACE = process.argv[2] || '42485456_9715';
const BUNDLE = process.env.BUNDLE || path.join(__dirname, '..', '..', 'dist', 'extra300-meigs.mjs');
const AIRCRAFT = process.env.AIRCRAFT || 'extra300l';
const OUT = process.argv[3] || path.join(__dirname, '..', '..', 'dist', AIRCRAFT === 'extra300l' ? 'intro.mp4' : `intro-${AIRCRAFT}.mp4`);
const FPS = Number(process.env.FPS || 24);
const TAIL = Number(process.env.TAIL || 2.0);     // seconds of cockpit after the film
const W = Number(process.env.W || 960), H = Number(process.env.H || 540);
const FRAMES = path.join(path.dirname(OUT), 'intro-frames');
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

(async () => {
  // RESUME=1 keeps the frames already rendered and carries on after the last one
  const RESUME = process.env.RESUME === '1';
  if (!RESUME) fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const have = RESUME ? fs.readdirSync(FRAMES).filter((f) => /^f\d{5}\.jpg$/.test(f)).length : 0;
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined, headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
  await page.route('**/*', (route, req) => (['GET', 'HEAD', 'OPTIONS'].includes(req.method()) ? route.continue() : route.abort()));
  await page.routeWebSocket(/.*/, (ws) => ws.close());

  log('goto', SPACE);
  await page.goto(`https://arrival.space/${SPACE}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.ArrivalSpace && window.pc && (window.pc.app || window.pc.AppBase?.getApplication?.()) && window.ArrivalSpace.getCamera?.(),
    null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(15000);
  // the vibe placed in the space, or else inject the bundle
  const how = await page.evaluate(async (src) => {
    const app = window.pc.app || window.pc.AppBase.getApplication();
    window.__app = app;
    const sc = app.root.findComponents('script').find((s) => s.extra300Meigs);
    if (sc) { window.vibe = sc.extra300Meigs; return 'placed'; }
    const mod = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const host = new window.pc.Entity('extra300-film');
    const pl = window.ArrivalSpace.getPlayer?.();
    if (pl) { const q = pl.getPosition(); host.setPosition(q.x, q.y, q.z); }
    app.root.addChild(host);
    host.addComponent('script');
    window.vibe = host.script.create(mod.Extra300);
    // the film is of our airfield: switch off the host space's own models and splats
    const ours = (e) => { for (let n = e; n; n = n.parent) if (n === host || n === pl || n.name === 'Extra300World') return true; return false; };
    for (const type of ['render', 'model', 'gsplat']) {
      for (const c of app.root.findComponents(type)) if (!ours(c.entity) && !c.entity.findComponent?.('camera')) c.enabled = false;
    }
    return 'injected';
  }, fs.readFileSync(BUNDLE, 'utf8'));
  log('vibe', how);
  await page.waitForFunction(() => window.vibe.world && window.vibe.city && !window.vibe.city.queue.length, null, { timeout: 400000, polling: 2000 });
  log('vibe found and the city is up');

  await page.evaluate((id) => {
    const v = window.vibe;
    if (v.profile && v.profile.id !== id) v._action('aircraft');   // two airplanes: the other one
    // the client's own on-screen help bubbles: not in the film
    for (const el of document.querySelectorAll('body *')) {
      if (/Look Around|Move/.test(el.textContent || '') && el.children.length < 12 && getComputedStyle(el).position === 'fixed') el.style.display = 'none';
    }
    v.playIntro = true;
    v._introPlayed = false;
    v._enter();
  }, AIRCRAFT);
  await page.waitForTimeout(4000);   // the seated pose blends in
  await page.evaluate(() => {
    const v = window.vibe;
    for (const el of document.querySelectorAll('body *')) {
      if (/Look Around/.test(el.textContent || '') && getComputedStyle(el).position === 'fixed') el.style.display = 'none';
    }
    // back to the very start of the film, engine still, then freeze the client's clock
    v._intro = { t: 0 };
    v.ac.setEngineRunning(false);
    v.hud.skipButton.style.visibility = 'hidden';   // a film, not the live screen
    window.__app.timeScale = 0;
  });

  const total = Math.ceil((await page.evaluate(() => window.vibe.profile?.intro.length || window.vibe.constructor.INTRO_LENGTH || 24.5) + TAIL) * FPS);
  log(`rendering ${total} frames at ${FPS} fps`);
  if (have) {
    // replay the film's first frames without drawing them: the airplane (engine start and all) ends up
    // exactly where it was when frame `have` was due
    await page.evaluate(({ n, dt }) => { for (let i = 0; i < n; i++) window.vibe.update(dt); }, { n: have, dt: 1 / FPS });
    log(`resuming at frame ${have}`);
  }
  for (let i = have; i < total; i++) {
    await page.evaluate((dt) => new Promise((done) => {
      window.vibe.update(dt);
      requestAnimationFrame(() => requestAnimationFrame(done));
    }), 1 / FPS);
    await page.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
    if (i % 60 === 0) log(`frame ${i}/${total}`);
  }
  await browser.close();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', OUT]);
  log('video →', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
