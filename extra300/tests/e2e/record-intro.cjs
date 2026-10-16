// record-intro.cjs — render the boarding intro film from the real arrival.space client to an MP4.
//
//   node tests/e2e/record-intro.cjs [spaceId] [out.mp4]
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

const SPACE = process.argv[2] || '42485456_1041';
const OUT = process.argv[3] || path.join(__dirname, '..', '..', 'dist', 'intro.mp4');
const FPS = Number(process.env.FPS || 30);
const TAIL = Number(process.env.TAIL || 2.0);     // seconds of cockpit after the film
const W = Number(process.env.W || 1280), H = Number(process.env.H || 720);
const FRAMES = path.join(path.dirname(OUT), 'intro-frames');
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

(async () => {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
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
  // the vibe placed in the space: its script instance
  await page.waitForFunction(() => {
    const app = window.pc.app || window.pc.AppBase.getApplication();
    const sc = app.root.findComponents('script').find((s) => s.extra300Meigs);
    if (sc) { window.__app = app; window.vibe = sc.extra300Meigs; }
    return !!sc && window.vibe.world && window.vibe.city && !window.vibe.city.queue.length;
  }, null, { timeout: 400000, polling: 2000 });
  log('vibe found and the city is up');

  await page.evaluate(() => {
    const v = window.vibe;
    // the client's own on-screen help bubbles: not in the film
    for (const el of document.querySelectorAll('body *')) {
      if (/Look Around|Move/.test(el.textContent || '') && el.children.length < 12 && getComputedStyle(el).position === 'fixed') el.style.display = 'none';
    }
    v.playIntro = true;
    v._introPlayed = false;
    v._enter();
  });
  await page.waitForTimeout(4000);   // the seated pose blends in
  await page.evaluate(() => {
    const v = window.vibe;
    for (const el of document.querySelectorAll('body *')) {
      if (/Look Around/.test(el.textContent || '') && getComputedStyle(el).position === 'fixed') el.style.display = 'none';
    }
    // back to the very start of the film, engine still, then freeze the client's clock
    v._intro = { t: 0 };
    v.ac.engine.running = false; v.ac.rpm = 0;
    window.__app.timeScale = 0;
  });

  const total = Math.ceil((await page.evaluate(() => window.vibe.constructor.INTRO_LENGTH || 24.5) + TAIL) * FPS);
  log(`rendering ${total} frames at ${FPS} fps`);
  for (let i = 0; i < total; i++) {
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
