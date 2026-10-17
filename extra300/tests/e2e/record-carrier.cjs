// record-carrier.cjs — a film of the F-15's carrier landing: the demo pilot flies the approach to USS
// Nimitz, catches the 3-wire, and the cameras cut between the chase, the cockpit with its HUD, a camera
// on the water under the glide slope, the LSO platform for the trap, and an orbit of the stopped jet.
//
//   node tests/e2e/record-carrier.cjs [out.mp4]
//   STRIDE=24 … renders every 24th frame only (a quick preview of the cuts); RESUME=1 carries on a stopped render
//
// The local harness (PlayCanvas + the Arrival stand-in, the OpenStreetMap city), rendered frame by frame
// at a fixed step as record-intro.cjs does: the clock is frozen and the vibe stepped by exactly 1/FPS.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.join(__dirname, '..', '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'carrier-landing.mp4');
const FPS = Number(process.env.FPS || 24);
const W = Number(process.env.W || 960), H = Number(process.env.H || 540);
const FRAMES = path.join(path.dirname(OUT), 'carrier-frames');
const TAIL = 9;   // seconds after the jet stops
const STRIDE = Number(process.env.STRIDE || 1);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

(async () => {
  const { serve } = await import(path.join(ROOT, 'scripts', 'serve.mjs'));
  const server = await serve(8744);
  const RESUME = process.env.RESUME === '1';
  if (!RESUME) fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const have = RESUME ? fs.readdirSync(FRAMES).filter((f) => /^f\d{5}\.jpg$/.test(f)).length : 0;
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined, headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto('http://localhost:8744/tests/harness/?aircraft=f15&fly=1&view=chase');
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 120000 });
  await page.waitForFunction(() => window.vibe.city && !window.vibe.city.queue.length, null, { timeout: 600000, polling: 1000 });
  log('city up');

  await page.evaluate(() => {
    const v = window.vibe;
    v._startDemo();
    v._director = false;          // the film picks its own cameras
    window.app.timeScale = 0;
    // a film, not the live screen: no buttons, no cards
    for (const el of [v.hud.aircraftButton, v.hud.easyButton, v.hud.controlsButton, v.hud.quick, v.hud.message]) el.style.visibility = 'hidden';
    v.hud.showQuick(false);
    // a title for the opening seconds
    const t = document.createElement('div');
    Object.assign(t.style, {
      position: 'fixed', left: '5vw', bottom: '9vh', color: '#fff', font: '15px/1.4 "Helvetica Neue", Arial, sans-serif',
      textShadow: '0 2px 12px rgba(0,0,0,0.7)', zIndex: 40, pointerEvents: 'none', transition: 'opacity 0.6s',
    });
    t.innerHTML = '<div style="font:700 12px Helvetica Neue,Arial;letter-spacing:0.22em;color:#ff5a64;text-transform:uppercase">Lake Michigan · off Meigs Field</div>'
      + '<div style="font:800 40px/1.1 Helvetica Neue,Arial;margin:4px 0">F-15C trap on USS Nimitz</div>'
      + '<div style="opacity:0.9">138 kt on the 3.5° glide slope · hook down · four wires</div>';
    document.body.appendChild(t);
    window.__title = t;
    const cv = v.carrier;
    const P = (dist, lat, h) => { const [n, e] = cv.onLanding(dist, lat); return [e, h, -n]; };
    // the film's fixed cameras (render metres, as the rig's deck view takes them)
    window.__cams = {
      water: P(-330, -120, cv.deckH - 11),                      // on the water short of the stern, beside the glide slope
      lso: P(cv.wires[0].along - 25, -cv.data.landing.halfWidth - 9, cv.deckH + 1.8),
      foul: P(150, cv.data.landing.halfWidth + 12, cv.deckH + 2.5),   // the starboard foul line, abeam the run-out
    };
    window.__shot = null;
    window.__stopT = null;
  });

  // the director: which camera, given the demo's state
  const frame = async (dt, i) => page.evaluate(({ dt, i, fps }) => new Promise((done) => {
    const v = window.vibe, d = v._demo, cv = v.carrier, rig = v.cameraRig, ac = v.ac;
    const t = i / fps;
    const behind = cv.aimAlong - cv.along(ac.state.pos[0], ac.state.pos[1]);
    if (d.phase === 'stopped' && window.__stopT == null) window.__stopT = t;
    const sinceStop = window.__stopT == null ? -1 : t - window.__stopT;
    let shot;
    if (d.phase === 'approach') shot = behind > 2350 ? 'chase' : behind > 1250 ? 'cockpit' : behind > 330 ? 'water' : 'lso';
    else shot = sinceStop < 2.5 ? 'lso' : sinceStop < 5.5 ? 'foul' : 'orbit';
    if (shot !== window.__shot) {
      window.__shot = shot;
      const view = shot === 'chase' || shot === 'orbit' ? 'chase' : shot === 'cockpit' ? 'cockpit' : 'deck';
      while (rig.view !== view) rig.cycle();
      if (view === 'deck') rig.deckPos = window.__cams[shot];
      rig.centre();
      rig.chaseScale = shot === 'orbit' ? 0.9 : 0.75;
      rig.fovScale = shot === 'water' ? 3.2 : 1;    // wide enough for the ship behind the jet
      v._setAvatarVisible(view !== 'cockpit');
      v.visual.setCockpitView(view === 'cockpit');
      // the head-up display only from the seat, where it means something
      v.hud.setFlying(true, view === 'cockpit');
      v._panelVisible = view === 'cockpit';
    }
    if (shot === 'chase') rig.lookYaw = 0.35 - 0.012 * t;
    if (shot === 'orbit') { rig.lookYaw = 1.2 + 0.11 * (sinceStop - 5.5); rig.lookPitch = -0.12; rig.chaseScale = 0.9 + 0.12 * (sinceStop - 5.5); }
    window.__title.style.opacity = t < 5 ? '1' : '0';
    v.update(dt);
    requestAnimationFrame(() => requestAnimationFrame(() => done({ phase: d.phase, stopT: window.__stopT, t })));
  }), { dt, i, fps: FPS });

  // a second of pre-roll: the chase camera settles in behind before the first frame is kept
  await page.evaluate(() => { window.__preroll = true; });
  for (let k = 0; k < FPS; k++) await frame(1 / FPS, 0);
  if (have) {
    for (let i = 0; i < have; i++) await frame(1 / FPS, i);
    log(`resuming at frame ${have}`);
  }
  let i = have;
  let n = have;
  for (;; i++) {
    const st = await frame(1 / FPS, i);
    if (i % STRIDE === 0) await page.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 90 });
    if (i % 48 === 0) log(`frame ${i} t ${st.t.toFixed(1)} ${st.phase}`);
    if ((st.stopT != null && st.t > st.stopT + TAIL) || st.t > 120) break;
  }
  const summary = await page.evaluate(() => ({ trap: window.vibe._demo.trap, touchdown: window.vibe._demo.touchdown, events: window.vibe._demo.events }));
  log('flight', JSON.stringify(summary));
  await browser.close();
  server.close();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS / STRIDE), '-i', path.join(FRAMES, 'f%05d.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-movflags', '+faststart', OUT]);
  log(`video → ${OUT} (${i + 1} frames)`);
})().catch((e) => { console.error(e); process.exit(1); });
