// extra300.js — the Arrival.Space vibe: an Extra 300L parked on runway 36 at
// Meigs Field. Walk up to it, press E (or tap it) and fly.
//
// This file is glue only. The flight model, instruments, scenery and camera
// maths live in engine-free modules under src/ and are unit-tested in Node;
// scripts/build.mjs bundles everything into one .mjs for the space.

import { Aircraft } from '../sim/aircraft.js';
import EXTRA from '../sim/aircraft/extra300l.js';
import { DEG, INHG, KT } from '../sim/units.js';
import { Instruments } from '../instruments/instruments.js';
import { ControlMapper, ACTIONS } from '../input/controlMapper.js';
import { buildMeigs } from '../world/meigs.js';
import { CameraRig } from '../render/cameraRig.js';
import { fromNE } from '../render/geometry.js';
import { CockpitSound } from '../render/audio.js';
import { AircraftVisual } from './aircraftVisual.js';
import { SceneryVisual } from './sceneryVisual.js';
import { Hud } from './hud.js';
import { disposeMaterials, toMesh } from './pcMesh.js';
import { OsmVisual } from './osmVisual.js';
import { inflateOsm } from '../world/osmCodec.js';
import { CHICAGO_OSM } from '../world/data/chicagoOsm.js';
import { buildSkyDome } from '../render/sky.js';

const BOARD_DISTANCE = 9; // metres from the airplane

export class Extra300 extends ArrivalScript {
  static scriptName = 'extra300Meigs';

  isEnabled = true;
  startRunway = '36';
  engineRunningAtStart = true;
  showPanel = true;
  showScenery = true;
  fuelLiters = 60;
  windKt = 0;
  windFromDeg = 0;
  qnhInHg = 29.92;
  oatC = 15;
  skylineYear = 2026;
  cityDetail = 'full';

  static properties = {
    isEnabled: { title: 'Enabled' },
    startRunway: { title: 'Start runway', options: ['36', '18'] },
    engineRunningAtStart: { title: 'Engine running at start' },
    showPanel: { title: 'Instrument panel' },
    showScenery: { title: 'Meigs & Chicago scenery' },
    fuelLiters: { title: 'Fuel, centre tank (L)', min: 5, max: 60, step: 1 },
    windKt: { title: 'Wind (kt)', min: 0, max: 40, step: 1 },
    windFromDeg: { title: 'Wind from (°true)', min: 0, max: 359, step: 1 },
    qnhInHg: { title: 'QNH (inHg)', min: 28.5, max: 31, step: 0.01 },
    oatC: { title: 'Sea-level temperature (°C)', min: -30, max: 45, step: 1 },
    skylineYear: { title: 'Skyline year (2026 = today, 2002 = the last Meigs year)', min: 1980, max: 2026, step: 1 },
    cityDetail: { title: 'City detail', options: ['full', 'mid-rise and up', 'towers only'] },
  };

  initialize() {
    this._flying = false;
    this._paused = false;
    this._keys = new Set();
    this._panelVisible = this.showPanel;
    this._yoke = false;
    this._mouse = { x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
    this._panelAcc = 0;

    this.world = buildMeigs();
    this._worldRoot = new pc.Entity('Extra300World');
    this.entity.addChild(this._worldRoot);
    this._placeWorldRoot();

    this.scenery = new SceneryVisual(this.app, this._worldRoot, this.world);
    this.scenery.visible = this.showScenery;
    this._loadCity();
    this._sky = null;

    this.ac = new Aircraft(EXTRA, {
      ground: this.world.ground,
      datumMsl: this.world.elevation,
      load: { fuelCenterL: this.fuelLiters },
      weather: this._weather(),
    });
    this.instruments = new Instruments(EXTRA, { kollsman: this.qnhInHg * INHG });
    this.mapper = new ControlMapper();
    const tower = this.world.landmarks.find((l) => l.name === 'Meigs Tower');
    this.cameraRig = new CameraRig({ eye: EXTRA.eye, towerPos: fromNE(tower.ne[0], tower.ne[1], tower.h + 1.5) });
    this.visual = new AircraftVisual(this.app, this._worldRoot);
    this.sound = new CockpitSound();
    this.hud = new Hud(this.getUIContainer(), EXTRA.limits, this.isMobile);

    this._resetToRunway();
    this.visual.update(this.ac, 0);

    // input
    this._onKeyDown = (e) => this._keyDown(e);
    this._onKeyUp = (e) => this._keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    this._onBlur = () => this._keys.clear();
    this._onResize = () => this.hud.layout();
    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('keyup', this._onKeyUp, true);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('resize', this._onResize);
    const canvas = this.app.graphicsDevice.canvas;
    this._onPointerDown = (e) => { this._mouse.dragging = true; this._mouse.lastX = e.clientX; this._mouse.lastY = e.clientY; };
    this._onPointerUp = () => { this._mouse.dragging = false; };
    this._onPointerMove = (e) => this._pointerMove(e);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointermove', this._onPointerMove);

    // tap / click the airplane to board
    this._unsubClick = ArrivalSpace.onEntityClick?.(this.visual.root, () => { if (!this._flying) this._enter(); });
    if (this.hud.buttons.board) this.hud.buttons.board.onclick = () => this._enter();
    if (this.hud.buttons.exit) this.hud.buttons.exit.onclick = () => this._exit();
    if (this.hud.buttons.view) this.hud.buttons.view.onclick = () => this._action('view');
    if (this.hud.buttons.reset) this.hud.buttons.reset.onclick = () => this._action('reset');
    if (this.hud.buttons.brake) {
      this.hud.buttons.brake.ontouchstart = () => this._keys.add('b');
      this.hud.buttons.brake.ontouchend = () => this._keys.delete('b');
    }

    // the camera is ours for the frame, after the platform's own camera scripts
    this._onPrerender = () => this._applyCamera();
    this.app.on('prerender', this._onPrerender);
  }

  // ── setup helpers ──────────────────────────────────────────────────────
  get _ws() {
    const s = Number(this.app.worldScale);
    return s > 0 ? s : 0.7;
  }

  _placeWorldRoot() {
    // The world root carries metres → space units and ignores the vibe's own rotation/scale.
    // It is offset so the airplane's parking spot on runway 36 is where the vibe was placed.
    const ps = this.entity.getWorldTransform().getScale();
    const ws = this._ws;
    this._worldRoot.setLocalScale(ws / (ps.x || 1), ws / (ps.y || 1), ws / (ps.z || 1));
    this._worldRoot.setRotation(pc.Quat.IDENTITY);
    const s = this.world.startPosition();
    const a = fromNE(s.n, s.e, 0);
    const p = this.entity.getPosition();
    this._worldRoot.setPosition(p.x - a[0] * ws, p.y - a[1] * ws, p.z - a[2] * ws);
  }

  /** Decode the baked OpenStreetMap Chicago and start raising it; the stand-in city shows meanwhile. */
  async _loadCity() {
    try {
      const osm = await inflateOsm(CHICAGO_OSM);
      if (this._destroyed) return;
      this.world.attachOsm(osm, this.skylineYear);
      this.city = new OsmVisual(this.app, this._worldRoot, this.world, this._cityOptions());
      this.city.visible = this.showScenery;
      // the stand-in skyline stays up until the last OSM tile is built (see update)
    } catch (e) {
      console.warn('[extra300] OpenStreetMap city unavailable, keeping the stand-in skyline:', e);
    }
  }

  _cityOptions() {
    let minHeight = { full: 0, 'mid-rise and up': 15, 'towers only': 45 }[this.cityDetail] ?? 0;
    // ~15,000 buildings is ~500k vertices: on a phone, 'full' leaves out the low-rise
    if (this.isMobile) minHeight = Math.max(minHeight, 15);
    return { year: this.skylineYear, minHeight };
  }

  _weather() {
    const from = this.windFromDeg * DEG;
    const v = this.windKt * KT;
    // air moves *toward* from+180°: NED components
    return { qnh: this.qnhInHg * INHG, dT: this.oatC - 15, wind: [-Math.cos(from) * v, -Math.sin(from) * v, 0] };
  }

  _resetToRunway() {
    const s = this.world.startPosition();
    let { n, e, heading } = s;
    if (this.startRunway === '18') {
      const rw = this.world.runway;
      n = rw.thr18[0] - rw.dir[0] * 30; e = rw.thr18[1] - rw.dir[1] * 30; heading = rw.bearing + Math.PI;
    }
    this.ac.load.fuelCenterL = this.fuelLiters;
    this.ac.updateMass();
    this.ac.placeOnGround(n, e, heading);
    this.ac.controls.parkingBrake = false;
    this.ac.engine.running = this.engineRunningAtStart;
    this.ac.rpm = this.engineRunningAtStart ? 750 : 0;
    this.ac.engine.oilTemp = this.engineRunningAtStart ? 70 : this.oatC;
    this.ac.engine.cht = this.engineRunningAtStart ? 150 : this.oatC;
    this.mapper.throttle = 0;
    this.instruments.resetG();
    // let it settle onto its gear before anyone sees it
    for (let i = 0; i < 480; i++) this.ac.step(1 / 480);
  }

  // ── boarding ───────────────────────────────────────────────────────────
  _enter() {
    if (this._flying || !this.isEnabled) return;
    const attached = ArrivalSpace.getLocalAttachedEntity?.();
    if (attached && attached !== this.visual.root) return;
    this._flying = true;
    this.lockKeyboard();
    this._prevMode = ArrivalSpace.getCameraMode?.() || 'third';
    // the client re-parents the camera per mode and keeps its world pose: remember the local
    // pose under the current rig so leaving the airplane doesn't strand the camera
    const cam0 = ArrivalSpace.getCamera?.();
    this._camLocal = cam0 ? { parent: cam0.parent, p: cam0.getLocalPosition().clone(), r: cam0.getLocalRotation().clone() } : null;
    const seat = EXTRA.eye;
    this._attach = ArrivalSpace.attachPlayerToEntity?.(this.visual.root, {
      offset: { x: seat[1], y: -seat[2] - 0.75, z: -seat[0] },
      disableCollision: true,
      rate: 20,
      extra: () => ({ rpm: Math.round(this.ac.rpm), ias: Math.round(this.instruments.values.ias || 0) }),
    }) || null;
    ArrivalSpace.setCameraMode?.('free');
    const cam = ArrivalSpace.getCamera?.();
    if (cam?.camera) {
      this._camSaved = { near: cam.camera.nearClip, far: cam.camera.farClip, fov: cam.camera.fov };
      cam.camera.nearClip = 0.35 * this._ws;   // the canopy is hidden in the cockpit; a far near plane keeps the ground layers from z-fighting
      cam.camera.farClip = 60000 * this._ws;
    }
    this._setAvatarVisible(this.cameraRig.view !== 'cockpit');
    this.visual.setCockpitView(this.cameraRig.view === 'cockpit');
    this.sound.start();
    ArrivalSpace.setAppUIVisible?.(false);
    this._showSky(true);
    this._pose = this.cameraRig.update(this.ac, 0, this.ac.cg);
    this.hud.showPrompt('');
    this.hud.setFlying(true, this._panelVisible);
    // the controls card opens by itself the first time; H toggles it from then on
    if (!this._helpShown) { this.hud.toggleHelp(true); this._helpShown = true; }
  }

  _exit() {
    if (!this._flying) return;
    this._flying = false;
    this.unlockKeyboard();
    this._keys.clear();
    this._attach?.detach?.();
    this._attach = null;
    ArrivalSpace.setCameraMode?.(this._prevMode || 'third');
    const cam = ArrivalSpace.getCamera?.();
    if (cam && this._camLocal && cam.parent === this._camLocal.parent) {
      cam.setLocalPosition(this._camLocal.p);
      cam.setLocalRotation(this._camLocal.r);
    }
    if (cam?.camera && this._camSaved) {
      cam.camera.nearClip = this._camSaved.near;
      cam.camera.farClip = this._camSaved.far;
      cam.camera.fov = this._camSaved.fov;
    }
    ArrivalSpace.setAppUIVisible?.(true);
    this._showSky(false);
    this._setAvatarVisible(true);
    this.visual.setCockpitView(false);
    this.sound.stop();
    this.hud.setFlying(false, false);
    // step out beside the left wing; an airplane left in the air goes back to the runway
    if (this.ac.agl > 3 || this.ac.damage.crashed) this._resetToRunway();
    const ws = this._ws;
    const p = this.ac.referencePoint();
    const side = [p[0] + Math.sin(this.ac.euler.psi) * 5.5, p[1] - Math.cos(this.ac.euler.psi) * 5.5];
    const local = fromNE(side[0], side[1], 1.0);
    const o = this._worldRoot.getPosition();
    const out = { x: o.x + local[0] * ws, y: o.y + local[1] * ws, z: o.z + local[2] * ws };
    ArrivalSpace.teleportPlayer?.(out, { azimuth: -(this.ac.euler.psi / DEG + 90) }); // face the airplane
    if (this._prevMode === 'free') {
      // a free camera keeps whatever pose it had: put it beside the airplane, looking at it
      const ap = this.visual.root.getPosition();
      ArrivalSpace.setFreeCamPose?.({ x: out.x, y: out.y + 1.6 * ws, z: out.z }, { x: ap.x, y: ap.y, z: ap.z });
    }
  }

  _setAvatarVisible(v) {
    const mesh = ArrivalSpace.getPlayerMesh?.();
    if (mesh) mesh.enabled = v;
  }

  // ── input ──────────────────────────────────────────────────────────────
  _keyDown(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!this._flying) {
      if (key === 'e' && this._nearAircraft()) { this._enter(); e.preventDefault(); }
      return;
    }
    if (!this._keys.has(key)) {
      for (const [name, keys] of Object.entries(ACTIONS)) if (keys.includes(key)) this._action(name);
    }
    this._keys.add(key);
    if (key.startsWith('Arrow') || key.startsWith('Page') || key === ' ' || key === 'Home' || key === 'End' || key === 'Backspace') e.preventDefault();
    e.stopPropagation();
  }

  _action(name) {
    const c = this.ac.controls;
    switch (name) {
      case 'view': {
        const v = this.cameraRig.cycle();
        this._setAvatarVisible(v !== 'cockpit');
        this.visual.setCockpitView(v === 'cockpit');
        this.hud.flash(`View: ${v}`, 1.5);
        break;
      }
      case 'panel': this._panelVisible = !this._panelVisible; this.hud.setFlying(true, this._panelVisible); break;
      case 'reset': this._resetToRunway(); this.hud.flash('Back on runway 36', 2); break;
      case 'pause': this._paused = !this._paused; break;
      case 'help': this.hud.toggleHelp(); break;
      case 'mixture': c.mixture = c.mixture > 0.5 ? 0 : 1; this.hud.flash(c.mixture ? 'Mixture rich' : 'Mixture cut-off', 1.5); break;
      case 'parkingBrake': c.parkingBrake = !c.parkingBrake; break;
      case 'gReset': this.instruments.resetG(); break;
      case 'kollsman': this.instruments.kollsman = this.ac.weather.qnh; this.hud.flash(`Altimeter ${(this.ac.weather.qnh / INHG).toFixed(2)}`, 1.5); break;
      case 'yoke': this._yoke = !this._yoke; this.hud.flash(this._yoke ? 'Mouse yoke on' : 'Mouse yoke off', 1.5); break;
      case 'lookCenter': this.cameraRig.centre(); break;
      case 'exit': this._exit(); break;
      default: break;
    }
  }

  _pointerMove(e) {
    this._mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this._mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
    if (this._flying && this._mouse.dragging && !this._yoke) {
      const dx = e.clientX - this._mouse.lastX, dy = e.clientY - this._mouse.lastY;
      this.cameraRig.look(-dx * 0.005, -dy * 0.005);
    }
    this._mouse.lastX = e.clientX; this._mouse.lastY = e.clientY;
  }

  _readPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads || []) {
      if (p && p.connected && p.axes.length >= 4) return { axes: [...p.axes], buttons: p.buttons.map((b) => b.value) };
    }
    return null;
  }

  _nearAircraft() {
    const player = ArrivalSpace.getPlayer?.();
    if (!player) return false;
    const pp = player.getPosition();
    const ap = this.visual.root.getPosition();
    return pp.distance(ap) < BOARD_DISTANCE * this._ws;
  }

  // ── frame ──────────────────────────────────────────────────────────────
  update(dt) {
    if (!this.isEnabled) return;
    this.hud.tick();
    if (this.city && this.city.queue.length) {
      this.city.tick(this._flying ? 3 : 8);
      if (!this.city.queue.length) this.scenery.standInCity = false;
    }
    if (!this._flying) {
      this.hud.showPrompt(this._nearAircraft() ? (this.isMobile ? 'Extra 300L' : 'Press E to fly the Extra 300L') : '');
      return;
    }
    const raw = {
      keys: this._keys,
      pad: this._readPad(),
      left: this.isMobile ? this.getLeftStick() : null,
      right: this.isMobile ? this.getRightStick() : null,
      yoke: this._yoke ? { x: this._mouse.x, y: this._mouse.y } : null,
    };
    this.mapper.update(raw, dt, this.ac.controls);
    if (!this._paused) this.ac.update(dt);
    this._checkBuildings();
    const v = this.instruments.update(this.ac, dt);
    this.visual.update(this.ac, this._paused ? 0 : dt);

    for (const ev of this.ac.events.splice(0)) {
      if (ev.e === 'propStrike') this.hud.flash('Prop strike! Backspace to reset', 4);
      if (ev.e === 'splash') this.hud.flash('In the lake. Backspace to reset', 4);
    }

    this._pose = this.cameraRig.update(this.ac, dt, this.ac.cg);

    this.sound.update({
      rpm: this.ac.rpm,
      powerFrac: Math.max(0, this.ac.engine.power) / EXTRA.engine.ratedPower,
      running: this.ac.engine.running,
      qbar: this.ac.out.qbar,
      stall: v.stallWarning,
      inside: this.cameraRig.view === 'cockpit',
    });

    this._panelAcc += dt;
    if (this._panelVisible && this._panelAcc > 1 / 30) {
      this._panelAcc = 0;
      const c = this.ac.controls;
      this.hud.panel.draw(v, {
        throttle: c.throttle, prop: c.prop, trim: c.elevatorTrim, parkingBrake: c.parkingBrake,
        engineRunning: this.ac.engine.running, paused: this._paused,
      });
    }
    const e = this.ac.euler;
    this.hud.readout.textContent = `H — controls   ${this.cameraRig.view.toUpperCase()}  IAS ${Math.round(v.ias)} kt  ALT ${Math.round(v.altitude)} ft  HDG ${String(Math.round(v.compass)).padStart(3, '0')}  `
      + `pitch ${(e.theta / DEG).toFixed(0)}°  bank ${(e.phi / DEG).toFixed(0)}°  ${Math.round(v.rpm)} rpm  ${v.g.toFixed(1)} g`;
  }

  postUpdate() {
    if (this._flying) this._applyCamera();
  }

  _applyCamera() {
    if (!this._flying) return;
    const cam = ArrivalSpace.getCamera?.();
    const pose = this._pose;
    if (!cam || !pose) return;
    const o = this._worldRoot.getPosition();
    const ws = this._ws;
    cam.setPosition(o.x + pose.pos[0] * ws, o.y + pose.pos[1] * ws, o.z + pose.pos[2] * ws);
    cam.setRotation(pose.rot[0], pose.rot[1], pose.rot[2], pose.rot[3]);
    if (cam.camera) cam.camera.fov = pose.fov;
    this._placeSky();
  }

  /** Fly into a building and the flight ends there. */
  _checkBuildings() {
    if (!this.world.osm || this.ac.damage.crashed) return;
    const p = this.ac.state.pos;
    const h = -p[2];
    if (h > 450) return;
    if (this.world.buildingAt(p[0], p[1], h)) {
      this.ac.damage.crashed = true;
      this.ac.engine.running = false;
      this.ac.state.vel = [0, 0, 0];
      this.ac.state.omega = [0, 0, 0];
      this.hud.flash('You hit a building. Backspace to reset', 5);
    }
  }

  _showSky(on) {
    if (on && !this._sky) {
      const m = new pc.StandardMaterial();
      m.useLighting = false;
      m.diffuse = new pc.Color(0, 0, 0);
      m.emissiveVertexColor = true;
      m.emissive = new pc.Color(1, 1, 1);
      m.cull = pc.CULLFACE_NONE;
      m.useFog = false;
      m.useSkybox = false;
      m.update();
      this._sky = new pc.Entity('SkyDome');
      const mi = new pc.MeshInstance(toMesh(this.app.graphicsDevice, buildSkyDome()), m);
      this._sky.addComponent('render', { meshInstances: [mi], castShadows: false, receiveShadows: false });
      this.app.root.addChild(this._sky);   // world-space, follows the camera; destroyed in destroy()
    }
    if (this._sky) this._sky.enabled = on;
  }

  _placeSky() {
    const cam = ArrivalSpace.getCamera?.();
    if (!this._sky || !this._sky.enabled || !cam?.camera) return;
    const r = cam.camera.farClip * 0.9;
    const p = cam.getPosition();
    this._sky.setPosition(p.x, p.y, p.z);
    this._sky.setLocalScale(r, r, r);
  }

  onPropertyChanged(name) {
    if (name === 'showScenery') { this.scenery.visible = this.showScenery; if (this.city) this.city.visible = this.showScenery; }
    if ((name === 'skylineYear' || name === 'cityDetail') && this.city) {
      this.world.setSkylineYear(this.skylineYear);
      this.city.build(this._cityOptions());
    }
    if (name === 'showPanel') { this._panelVisible = this.showPanel; this.hud.setFlying(this._flying, this._panelVisible); }
    if (['windKt', 'windFromDeg', 'qnhInHg', 'oatC'].includes(name)) this.ac.weather = this._weather();
    if (name === 'fuelLiters' || name === 'startRunway' || name === 'engineRunningAtStart') { if (!this._flying) this._resetToRunway(); }
    if (name === 'isEnabled' && !this.isEnabled) this._exit();
  }

  onEntityMoved() { this._placeWorldRoot(); }

  destroy() {
    this._destroyed = true;
    this._exit();
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('keyup', this._onKeyUp, true);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    this.app.graphicsDevice.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.app.off('prerender', this._onPrerender);
    if (typeof this._unsubClick === 'function') this._unsubClick();
    this.hud.destroy();
    this.sound.stop();
    this.visual.destroy();
    this.scenery.destroy();
    this.city?.destroy();
    this._sky?.destroy();
    this._worldRoot.destroy();
    disposeMaterials();
  }
}
