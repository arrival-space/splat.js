// harness.js — a stand-in for the Arrival.Space client: a PlayCanvas app with
// sky, sun and a walking-player placeholder, plus just enough of the
// `ArrivalScript` / `ArrivalSpace` surface for the vibe to run. Lets the
// plugin be loaded, flown and screenshotted headlessly (tests/e2e).
//
// URL parameters: ?menu=1 the start menu, ?fly=1 board immediately (?intro=1 with the intro film), ?mobile=1 as a phone, ?view=chase|tower|flyby|cockpit, ?aircraft=f15 the F-15C (read by the plugin itself),
// ?bundle=0 load the sources instead of dist/ (faster edit-reload), ?gpu=webgpu on a WebGPU device.
import * as pc from 'playcanvas';

window.pc = pc;
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('app');
// ?gpu=webgpu: the WebGPU device the Arrival client runs on where it can (WGSL shaders), else WebGL2
const graphicsDevice = params.get('gpu') === 'webgpu' ? await pc.createGraphicsDevice(canvas, { deviceTypes: ['webgpu'] }) : undefined;
const app = new pc.Application(canvas, { mouse: new pc.Mouse(canvas), keyboard: new pc.Keyboard(window), graphicsDevice });
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());
app.worldScale = Number(params.get('ws')) || 1;   // ?ws=0.7 like older Arrival spaces
app.scene.ambientLight = new pc.Color(0.42, 0.45, 0.5);
app.scene.skyboxIntensity = 1;

const sun = new pc.Entity('sun');
sun.addComponent('light', { type: 'directional', color: new pc.Color(1, 0.97, 0.9), intensity: 1.6, castShadows: true, shadowDistance: 120, shadowResolution: 2048, shadowBias: 0.3, normalOffsetBias: 0.05 });
sun.setEulerAngles(48, 35, 0);
app.root.addChild(sun);

const camera = new pc.Entity('camera');
camera.addComponent('camera', { clearColor: new pc.Color(0.61, 0.76, 0.9), fov: 60, nearClip: 0.1, farClip: 2000 });
camera.setPosition(-12, 4, -560);
app.root.addChild(camera);

// the walking player: a capsule stand-in
const player = new pc.Entity('player');
const playerMesh = new pc.Entity('playerMesh');
playerMesh.addComponent('render', { type: 'capsule' });
playerMesh.setLocalPosition(0, 0.9, 0);
player.addChild(playerMesh);
app.root.addChild(player);

let cameraMode = 'third';
let attached = null;
// like the client: the plugin UI container is click-through; only createUI elements take the pointer
const uiRoot = document.createElement('div');
Object.assign(uiRoot.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 10 });
document.body.appendChild(uiRoot);

window.ArrivalSpace = {
  VERSION: 'harness',
  getCamera: () => camera,
  getCameraMode: () => cameraMode,
  setCameraMode: (m) => { cameraMode = m; return true; },
  getPlayer: () => player,
  getPlayerMesh: () => playerMesh,
  teleportPlayer: (p) => { player.setPosition(p.x, p.y, p.z); return true; },
  attachPlayerToEntity: (entity, opts) => { attached = entity; return { detach: () => { attached = null; } }; },
  getLocalAttachedEntity: () => attached,
  onEntityClick: () => () => {},
};

class ArrivalScript extends pc.Script {
  get isMobile() { return params.get('mobile') === '1'; }   // ?mobile=1: the phone layout and behaviour
  getUIContainer() { return uiRoot; }
  createUI(tag, opts = {}) {
    const el = document.createElement(tag);
    if (opts.interactive !== false) el.style.pointerEvents = 'auto';
    if (opts.style) Object.assign(el.style, opts.style);
    uiRoot.appendChild(el);
    return el;
  }
  lockKeyboard() {}
  unlockKeyboard() {}
  getLeftStick() { return { x: 0, y: 0 }; }
  getRightStick() { return { x: 0, y: 0 }; }
}
window.ArrivalScript = ArrivalScript;

const mod = params.get('bundle') === '0'
  ? await import('../../src/plugin/extra300.js')
  : await import(`../../dist/extra300-meigs.mjs?t=${Date.now()}`);
const host = new pc.Entity('vibe');
app.root.addChild(host);
host.addComponent('script');
app.start();
// the start menu only when asked for (?menu=1); Meigs unless ?airport= says (the vibe's own default
// is Innsbruck): the rest of the harness drives the vibe itself
// ?vibes=1: the space's airport and airplane vibes too (the seven a new space gets, and a tuned Extra);
// without, the flight vibe lists its own (and doesn't wait for any)
const withVibes = params.get('vibes') === '1';
const vibe = host.script.create(mod.Extra300, { properties: {
  startMenu: params.get('menu') === '1', destination: params.get('home') === 'lowi' ? 'Innsbruck (LOWI)' : 'Chicago Meigs (KCGX)',
  registryWait: withVibes ? 3 : 0,
} });
if (withVibes) {
  const [ap, ac] = await Promise.all([import(`../../dist/flight-airport.mjs?t=${Date.now()}`), import(`../../dist/flight-aircraft.mjs?t=${Date.now()}`)]);
  const add = (Cls, properties) => {
    const e = new pc.Entity(`${Cls.scriptName}`);
    app.root.addChild(e);
    e.addComponent('script');
    return e.script.create(Cls, { properties });
  };
  window.configVibes = [
    add(ap.FlightAirport, { airport: 'Chicago Meigs (KCGX)', order: 0 }),
    add(ap.FlightAirport, { airport: 'Innsbruck (LOWI)', order: 1, startHere: true }),
    add(ap.FlightAirport, { airport: 'Renton, Boeing 737 field (KRNT)', order: 2 }),
    add(ac.FlightAircraft, { airplane: 'Extra 300L', order: 0, startHere: true }),
    add(ac.FlightAircraft, { airplane: 'F-15C Eagle', order: 1 }),
    add(ac.FlightAircraft, { airplane: 'X-wing', order: 2 }),
    add(ac.FlightAircraft, { airplane: 'Boeing 777-300ER', order: 3 }),
    add(ac.FlightAircraft, { airplane: 'Extra 300L', title: 'Extra 300L Turbo', paint: '#1f6fd1', power: 2, order: 4 }),
  ];
}
window.vibe = vibe;
window.app = app;

// place the stand-in player beside the airplane
const ap = vibe.visual.root.getPosition();
player.setPosition(ap.x - 6, 0, ap.z);
camera.setPosition(ap.x - 9, 2.2, ap.z + 7);
camera.lookAt(ap.x, 1, ap.z);

if (params.get('fly') === '1') {
  vibe.playIntro = params.get('intro') === '1';   // the film only when asked for: ?intro=1
  vibe._enter();
  const view = params.get('view');
  if (view) { while (vibe.cameraRig.view !== view) vibe.cameraRig.cycle(); vibe._setAvatarVisible(view !== 'cockpit'); vibe.visual.setCockpitView(view === 'cockpit'); }
}
// ?flight=platzrunde — the scripted pilot (tests/lib/platzrunde.js) flies the real vibe;
// call window.startFlight(speedup) once the city is up
if (params.get('flight') === 'platzrunde') {
  const { PatternPilot } = await import('../lib/platzrunde.js');
  window.startFlight = (speedup = 1) => {
    const pilot = new PatternPilot(vibe.ac, vibe.world);
    window.pilot = pilot;
    // the pilot replaces the keyboard; extra sim steps per frame keep slow software GL near real time
    vibe.mapper.update = (raw, dt) => {
      const h = Math.min(dt, 0.1);
      for (let i = 1; i < window.flightSpeedup; i++) { pilot.step(h); vibe.ac.update(h); }
      pilot.step(h);
    };
    window.flightSpeedup = speedup;
  };
}
window.harnessReady = true;
