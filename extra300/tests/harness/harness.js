// harness.js — a stand-in for the Arrival.Space client: a PlayCanvas app with
// sky, sun and a walking-player placeholder, plus just enough of the
// `ArrivalScript` / `ArrivalSpace` surface for the vibe to run. Lets the
// plugin be loaded, flown and screenshotted headlessly (tests/e2e).
//
// URL parameters: ?fly=1 board immediately, ?view=chase|tower|flyby|cockpit,
// ?bundle=0 load the sources instead of dist/ (faster edit-reload).
import * as pc from 'playcanvas';

window.pc = pc;
const params = new URLSearchParams(location.search);
const canvas = document.getElementById('app');
const app = new pc.Application(canvas, { mouse: new pc.Mouse(canvas), keyboard: new pc.Keyboard(window) });
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());
app.worldScale = 1;
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
const uiRoot = document.createElement('div');
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
  get isMobile() { return false; }
  getUIContainer() { return uiRoot; }
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
const vibe = host.script.create(mod.Extra300);
window.vibe = vibe;
window.app = app;

// place the stand-in player beside the airplane
const ap = vibe.visual.root.getPosition();
player.setPosition(ap.x - 6, 0, ap.z);
camera.setPosition(ap.x - 9, 2.2, ap.z + 7);
camera.lookAt(ap.x, 1, ap.z);

if (params.get('fly') === '1') {
  vibe._enter();
  const view = params.get('view');
  if (view) { while (vibe.cameraRig.view !== view) vibe.cameraRig.cycle(); vibe._setAvatarVisible(view !== 'cockpit'); vibe.visual.setCockpitView(view === 'cockpit'); }
}
window.harnessReady = true;
