// extra300.js — the Arrival.Space vibe: an Extra 300L (or, picked in the top
// bar, with T or in the settings, an F-15C Eagle) parked on runway 36 at Meigs
// Field. Walk up to it, press E (or tap it) and fly.
//
// This file is glue only. The flight model, instruments, scenery and camera
// maths live in engine-free modules under src/ and are unit-tested in Node;
// scripts/build.mjs bundles everything into one .mjs for the space.

import { Aircraft } from '../sim/aircraft.js';
import { DEG, INHG, KT } from '../sim/units.js';
import { Instruments } from '../instruments/instruments.js';
import { ControlMapper, ACTIONS, BINDINGS, FLIGHT_KEYS } from '../input/controlMapper.js';
import { PatternPilot } from '../autopilot/platzrunde.js';
import { CarrierPilot, CARRIER_APPROACH } from '../autopilot/carrierApproach.js';
import { buildMeigs } from '../world/meigs.js';
import { buildInnsbruck, inflateLowiDem } from '../world/innsbruck.js';
import { buildRenton, inflateRentonDem } from '../world/renton.js';
import { TerrainVisual } from './terrainVisual.js';
import { CLOUD_PRESETS, CloudLayer } from './clouds.js';
import { buildCarrier } from '../world/carrier.js';
import { Arrestor } from '../sim/arrestor.js';
import { CarrierVisual } from './carrierVisual.js';
import { Lasers } from './lasers.js';
import { RunwayVisual } from './runwayVisual.js';
import { CockpitDisplay } from './cockpitDisplay.js';
import { discTexture, LightsVisual } from './lightsVisual.js';
import { CameraRig } from '../render/cameraRig.js';
import { fromNE, MeshBuilder } from '../render/geometry.js';
import { AircraftVisual } from './aircraftVisual.js';
import { AIRCRAFT_OPTIONS, nextProfile, PROFILES, profileByTitle } from './profiles.js';
import { PlaneShadowFit } from './planeShadowFit.js';
import { ReflectionProbe } from './reflectionProbe.js';
import { StartMenu } from './startMenu.js';
import { SceneryVisual } from './sceneryVisual.js';
import { Hud } from './hud.js';
import { disposeMaterials, toMesh } from './pcMesh.js';
import { disposeGroundTextures } from './groundMaterial.js';
import { disposeFinishes, setReflectionCube } from './finishes.js';
import { OsmVisual } from './osmVisual.js';
import { inflateOsm } from '../world/osmCodec.js';
import { CHICAGO_OSM } from '../world/data/chicagoOsm.js';
import { buildSkyDome } from '../render/sky.js';
import { carveBox } from '../render/carve.js';
import { buildWaterMasks, maskTransform } from './waterMask.js';
import { WaterReflections } from './waterReflections.js';
import { INTRO_LENGTH, introAt } from '../render/intro.js';

const BOARD_DISTANCE = 9; // metres from the airplane (more for a bigger one)
const MOBILE_THROTTLE = 0.75; // a phone pilot starts rolling at once
// m above the datum (the runway): over the airfield Google's tiles are cut away above this. Just under
// our island's surface, so their water (photographed, not flat: it varies by a metre or more from
// tile to tile) and low shore all stay, and what's left inside the island is hidden under it.
const CARVE_FLOOR = -0.3;

// where the airplane can be: Meigs (the full scenery, the carrier) or Innsbruck (Google's tiles,
// flattened under the runway, or the elevation grids when they aren't there)
const DESTINATIONS = {
  meigs: { id: 'meigs', title: 'Chicago Meigs (KCGX)', short: 'Chicago', runways: ['36', '18'], credit: 'Map data © OpenStreetMap contributors (ODbL) · City of Chicago' },
  lowi: { id: 'lowi', title: 'Innsbruck (LOWI)', short: 'Innsbruck', runways: ['26', '08'], credit: 'Map data © OpenStreetMap contributors (ODbL) · Elevation: Terrarium (Mapzen, AWS Open Data)' },
  krnt: { id: 'krnt', title: 'Renton, Boeing 737 field (KRNT)', short: 'Renton', runways: ['34', '16'], credit: 'Map data © OpenStreetMap contributors (ODbL) · Elevation: Terrarium (Mapzen, AWS Open Data)' },
};
// the airports beyond Meigs: their worlds, made when first flown to
const AIRPORTS = {
  lowi: async () => { const dem = await inflateLowiDem(); return { dem, world: buildInnsbruck(dem) }; },
  krnt: async () => { const dem = await inflateRentonDem(); return { dem, world: buildRenton(dem) }; },
};
/** The destination after this one, as the ✈ button goes round them. */
const nextDestination = (id) => { const ids = Object.keys(DESTINATIONS); return ids[(ids.indexOf(id) + 1) % ids.length]; };
// the start menu's words (plugin/startMenu.js)
const PLACE_BLURBS = {
  meigs: 'The lakefront island strip: the skyline next door, a carrier in the lake',
  lowi: 'The Inn valley, mountains all round',
  krnt: "Boeing's 737 field, at the south end of Lake Washington",
};
const AIRCRAFT_BLURBS = {
  extra300l: 'Aerobatic two-seater',
  f15c: 'Twin-engine air-superiority fighter',
  xwing: 'T-65 starfighter: S-foils, lasers',
  b777: 'Long-haul twin-jet airliner',
};
const placeFromAddress = (a) => (/lowi|inn/i.test(a) ? 'lowi' : /krnt|rnt|renton/i.test(a) ? 'krnt' : 'meigs');
const aircraftFromAddress = (a) => (/f-?15/i.test(a) ? 'f15c' : /x-?wing/i.test(a) ? 'xwing' : /777|b7|boeing/i.test(a) ? 'b777' : 'extra300l');

const destinationByTitle = (t) => Object.values(DESTINATIONS).find((d) => d.title === t || d.id === t) || DESTINATIONS.meigs;

export class Extra300 extends ArrivalScript {
  static scriptName = 'extra300Meigs';
  static INTRO_LENGTH = INTRO_LENGTH;   // for tests/e2e/record-intro.cjs (the Extra's; vibe.profile.intro.length)

  isEnabled = true;
  aircraft = 'Extra 300L';
  startRunway = '36';
  showCarrier = true;
  destination = 'Chicago Meigs (KCGX)';
  clouds = 'Scattered';
  cloudBaseFt = 4500;
  waterReflections = true;
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
  easyMode = false;
  playIntro = true;
  introOnLoad = false;
  startMenu = true;
  seatAnimation = 'driving.glb';
  avatarLean = 20;            // degrees the avatar leans back into the reclined seat
  avatarSeatHeight = 0.79;    // the seated pose has its origin under the hips: low enough that the head stays under the canopy
  avatarSeatForward = -0.90;

  static properties = {
    isEnabled: { title: 'Enabled' },
    aircraft: { title: 'Aircraft (also the top bar, or T in flight; ?aircraft=f15, xwing or 777 on the address)', options: AIRCRAFT_OPTIONS },
    destination: { title: 'Where to fly (also the ✈ button on the top bar, or ?airport=lowi / krnt on the address)', options: Object.values(DESTINATIONS).map((d) => d.title) },
    startRunway: { title: 'Start: runway 36, 18 (at Innsbruck: 26, 08), or on final to the carrier (Backspace goes back there)', options: ['36', '18', 'Carrier approach'] },
    showCarrier: { title: 'Aircraft carrier in the lake (USS Nimitz, arresting wires for the F-15\'s hook)' },
    waterReflections: { title: 'Reflections in the lake (screen-space: the airplane, the carrier, the skyline)' },
    engineRunningAtStart: { title: 'Engine running at start' },
    showPanel: { title: 'Instrument panel' },
    showScenery: { title: 'Meigs & Chicago scenery' },
    fuelLiters: { title: 'Fuel, centre tank (L) — the Extra (the F-15 carries ~64 % internal)', min: 5, max: 60, step: 1 },
    clouds: { title: 'Clouds (volumetric, drifting with the wind)', options: Object.keys(CLOUD_PRESETS) },
    cloudBaseFt: { title: 'Cloud base (ft above the field)', min: 500, max: 15000, step: 100 },
    windKt: { title: 'Wind (kt)', min: 0, max: 40, step: 1 },
    windFromDeg: { title: 'Wind from (°true)', min: 0, max: 359, step: 1 },
    qnhInHg: { title: 'QNH (inHg)', min: 28.5, max: 31, step: 0.01 },
    oatC: { title: 'Sea-level temperature (°C)', min: -30, max: 45, step: 1 },
    skylineYear: { title: 'Skyline year (2026 = today, 2002 = the last Meigs year)', min: 1980, max: 2026, step: 1 },
    cityDetail: { title: 'City detail', options: ['full', 'mid-rise and up', 'towers only'] },
    easyMode: { title: 'Easy mode at start (no stalls, torque handled; L in flight)' },
    playIntro: { title: 'Intro film on first boarding (skippable)' },
    startMenu: { title: 'Start menu: pick the airport and airplane before anything loads (skipped when the address names both)' },
    introOnLoad: { title: 'Film mode: board and play the intro by itself after loading (or open the space with ?intro)' },
    seatAnimation: { title: 'Pilot pose (avatar animation while flying)' },
    avatarSeatHeight: { title: 'Extra\'s pilot seat: avatar height (m, body z: + is down)', min: -1.5, max: 1.0, step: 0.01 },
    avatarSeatForward: { title: 'Extra\'s pilot seat: avatar fore/aft (m, body x: + is forward)', min: -2.0, max: 0.5, step: 0.01 },
    avatarLean: { title: 'Extra\'s pilot seat: avatar leans back (degrees)', min: -10, max: 45, step: 1 },
  };

  initialize() {
    this._flying = false;
    this._paused = false;
    this._keys = new Set();
    this._panelVisible = this.showPanel;
    this._yoke = false;
    this._mouse = { x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };
    this._panelAcc = 0;

    this.world = this.meigs = buildMeigs();
    this._dest = 'meigs';
    // per airport: its world and grids, its own terrain and runway, its water and flatten masks
    this._airports = {};
    this._terrains = {};
    this._runways = {};
    this._waters = {};
    this._ssrs = {};
    this._flatMasks = {};
    this._worldRoot = new pc.Entity('Extra300World');
    this.entity.addChild(this._worldRoot);
    this._placeWorldRoot();

    this.scenery = new SceneryVisual(this.app, this._worldRoot, this.world);
    this.scenery.visible = this.showScenery;
    this.lights = new LightsVisual(this.app, this._worldRoot, this.world, this.scenery.tower);
    this.lights.visible = this.showScenery;
    // the carrier, anchored in the lake east of the island: its deck joins the ground
    this.carrier = buildCarrier(this.world);
    if (this.showCarrier) this.world.attachCarrier(this.carrier);
    this.carrierVisual = new CarrierVisual(this.app, this._worldRoot, this.carrier, this.world.water);
    this.carrierVisual.visible = this.showCarrier;
    this._loadPoses();
    // film mode: ?intro (or #intro) on the space's address, or the setting — board by itself once
    // everything has loaded and play the intro, ready to be screen-recorded
    try {
      this._filmPending = this.introOnLoad || new URLSearchParams(location.search).has('intro') || /(^|[#&])intro\b/.test(location.hash.slice(1));
    } catch { this._filmPending = this.introOnLoad; }
    // ?aircraft=f15 (or f15c, extra, xwing, 777) and ?airport=lowi (or innsbruck, krnt, renton) on the
    // address pick the airplane and the place, as the settings do
    let askedPlace = null, askedAircraft = null;
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('airport')) askedPlace = placeFromAddress(q.get('airport'));
      if (q.get('aircraft')) askedAircraft = aircraftFromAddress(q.get('aircraft'));
    } catch { /* no address to read */ }
    if (askedAircraft) this.aircraft = PROFILES[askedAircraft].title;
    this._sky = null;

    this.profile = profileByTitle(this.aircraft);
    this.mapper = new ControlMapper({ easy: this.easyMode });
    const tower = this.world.landmarks.find((l) => l.name === 'Meigs Tower');
    this.cameraRig = new CameraRig({ eye: this.profile.spec.eye, towerPos: fromNE(tower.ne[0], tower.ne[1], tower.h + 1.5) });
    this._placeDeckCamera();
    this.hud = new Hud(this.getUIContainer(), this.profile, this.isMobile, (tag, opts) => this.createUI(tag, opts));
    this.lasers = new Lasers(this.app, this._worldRoot);
    this._fire = false;
    this._buildAircraft(this.profile);
    this.hud.setEasy(this.mapper.easy);
    // in flight the sun's shadow map is fitted round the airplane, wherever the camera is
    this._shadowFit = new PlaneShadowFit(this.app, () => this._shadowFocus());
    // and its paint reflects the world round it (a small cube rendered from it, a face at a time)
    this._probe = new ReflectionProbe(this.app, this.isMobile ? { size: 64, every: 4 } : {});

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
    // mouse wheel: chase distance, or zoom in the other views
    this._onWheel = (e) => {
      if (!this._flying) return;
      this.cameraRig.zoom(Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 || 1));
      e.preventDefault();
    };
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointermove', this._onPointerMove);

    this.hud.aircraftButton.onclick = (ev) => { ev.stopPropagation(); this._action('aircraft'); };
    this.hud.placeButton.onclick = (ev) => { ev.stopPropagation(); this._goTo(nextDestination(this._dest)); };
    this.hud.easyButton.onclick = (ev) => { ev.stopPropagation(); this._action('easy'); };
    this.hud.controlsButton.onclick = (ev) => { ev.stopPropagation(); this.hud.toggleHelp(); };
    this.hud.skipButton.onclick = (ev) => { ev.stopPropagation(); this._endIntro(); };
    if (this.hud.buttons.board) this.hud.buttons.board.onclick = () => this._enter();
    if (this.hud.buttons.exit) this.hud.buttons.exit.onclick = () => this._exit();
    if (this.hud.buttons.view) this.hud.buttons.view.onclick = () => this._action('view');
    if (this.hud.buttons.reset) this.hud.buttons.reset.onclick = () => this._action('reset');
    if (this.hud.buttons.fire) {
      this.hud.buttons.fire.ontouchstart = () => { this._fire = true; };
      this.hud.buttons.fire.ontouchend = () => { this._fire = false; };
    }
    if (this.hud.buttons.brake) {
      this.hud.buttons.brake.ontouchstart = () => this._keys.add('b');
      this.hud.buttons.brake.ontouchend = () => this._keys.delete('b');
    }

    // the camera is ours for the frame, after the platform's own camera scripts
    // the clouds: their noise made over the first frames, marched each frame after our camera is placed
    this.cloudLayer = new CloudLayer(this.app, this.isMobile ? { scale: 0.28, steps: 40, lightSteps: 3 } : {});
    this._applyClouds();
    this._onPrerender = () => { this._applyCamera(); this._cloudsTick(); };
    this.app.on('prerender', this._onPrerender);

    // the start menu first: nothing heavy loads (the city, the airport, Google's tiles) until the
    // airport and the airplane are both picked; the address naming both, or film mode, skips it
    if (this.startMenu && !this._filmPending && !(askedPlace && askedAircraft)) {
      this._worldRoot.enabled = false;
      this.app.googleTilesHold = true;   // the tiles vibe streams nothing meanwhile (scripts/tilesWater.mjs)
      this.hud.placeButton.style.display = 'none';
      this._menu = new StartMenu((tag, opts) => this.createUI(tag, opts),
        Object.values(DESTINATIONS).map((d) => ({ id: d.id, title: d.title, blurb: PLACE_BLURBS[d.id] })),
        Object.entries(PROFILES).map(([id, p]) => ({ id, title: p.title, blurb: AIRCRAFT_BLURBS[id] || '' })),
        { place: askedPlace, aircraft: askedAircraft, isMobile: this.isMobile, onStart: (place, ac) => this._start(place, ac) });
      return;
    }
    const want = askedPlace || destinationByTitle(this.destination).id;
    if (want === 'meigs') this._ensureCity();
    else this._goTo(want);
  }

  /** The start menu's choice: the airplane, the place loaded, Google's tiles let go, and aboard. */
  async _start(place, aircraft) {
    this._menu.setStatus(`Loading ${DESTINATIONS[place].short}…`);
    this._switchAircraft(PROFILES[aircraft]);
    if (place !== 'meigs') await this._goTo(place);
    if (this._dest === 'meigs') this._ensureCity();   // also when the airport couldn't be loaded
    if (this._destroyed) return;
    this._menu.destroy();
    this._menu = null;
    this._worldRoot.enabled = true;
    this.hud.placeButton.style.display = 'block';
    this.app.googleTilesHold = false;
    this._enter();
  }

  /** The OpenStreetMap city, loaded the first time Meigs is where we are. */
  _ensureCity() { this._cityLoad ??= this._loadCity(); }

  // ── destinations ─────────────────────────────────────────────────────────
  get _place() { return DESTINATIONS[this._dest]; }

  /** The runway the airplane starts on (and goes back to). */
  get _runwayName() { return this._place.runways[this.startRunway === '18' ? 1 : 0]; }

  /**
   * Fly somewhere else: the world under the airplane (its ground, its height, its runway), Google's
   * globe moved under the space, the Meigs scenery off or on, and the airplane on the new runway,
   * a pilot already aboard with it.
   */
  async _goTo(id) {
    if (id === this._dest || this._going || !DESTINATIONS[id]) return;
    this._going = true;
    this.hud.setPlace(DESTINATIONS[id].short, true);
    try {
      if (AIRPORTS[id] && !this._airports[id]) this._airports[id] = await AIRPORTS[id]();
    } catch (e) {
      console.warn(`[extra300] ${DESTINATIONS[id].short} unavailable:`, e);
      this.hud.flash(`${DESTINATIONS[id].short} could not be loaded`, 3);
      this._going = false;
      this.hud.setPlace(DESTINATIONS[nextDestination(this._dest)].short);
      return;
    }
    this._going = false;
    if (this._destroyed) return;
    const flying = this._flying;
    if (this._intro) this._endIntro();
    if (this._demo) this._stopDemo('Demo ended');
    if (flying) { this._attach?.detach?.(); this._attach = null; }
    this._dest = id;
    this.destination = DESTINATIONS[id].title;
    if (id === 'meigs') this._ensureCity();
    this.world = id === 'meigs' ? this.meigs : this._airports[id].world;
    this._placeWorldRoot();
    this._applyDestination(true);
    this._buildAircraft(this.profile);
    // the lagged cameras start afresh behind the airplane, not a kilometre off where it was
    this.cameraRig.chasePos = null;
    this.cameraRig.flybyPos = null;
    if (flying) {
      this._attachPilot();
      this.sound.start();
      this._setAvatarVisible(this.cameraRig.view !== 'cockpit');
      this.visual.setCockpitView(this.cameraRig.view === 'cockpit');
      this._showTakeoffCard();
    }
    this.hud.flash(`${this._place.short}: ${this.profile.title} on runway ${this._runwayName}`, 3);
  }

  /** What belongs to the place we're at: on, the rest off; Google's tiles told where we are. */
  _applyDestination(moved = false) {
    const meigs = this._dest === 'meigs';
    this.hud.setPlace(DESTINATIONS[nextDestination(this._dest)].short);
    this.hud.setCredit(this._place.credit);
    this.scenery.visible = meigs && this.showScenery;
    this.lights.visible = meigs && this.showScenery;
    if (this.city) this.city.visible = meigs && this.showScenery;
    this.carrierVisual.visible = meigs && this.showCarrier;
    this.meigs.attachCarrier(meigs && this.showCarrier ? this.carrier : null);
    for (const [id, ssr] of Object.entries(this._ssrs)) ssr.visible = id === this._dest && this.waterReflections;
    // the airport's own ground (when Google's tiles aren't there) and our own runway over the
    // photograph of it (the photo cut away beneath, see _publishCarve)
    const ap = this._airports[this._dest];
    if (ap && !this._terrains[this._dest]) this._terrains[this._dest] = new TerrainVisual(this.app, this._worldRoot, ap.world, ap.dem);
    if (ap && !this._runways[this._dest] && ap.world.runway.layout) this._runways[this._dest] = new RunwayVisual(this.app, this._worldRoot, ap.world.runway, this._dest);
    for (const [id, t] of Object.entries(this._terrains)) t.visible = id === this._dest && !this._google;
    for (const [id, r] of Object.entries(this._runways)) r.visible = id === this._dest;
    // the tower view's cab, the carrier's deck view
    const t = meigs ? this.meigs.landmarks.find((l) => l.name === 'Meigs Tower') : { ne: this.world.tower.ne, h: this.world.tower.h };
    this.cameraRig.towerPos = fromNE(t.ne[0], t.ne[1], t.h + 1.5);
    if (meigs) this._placeDeckCamera(); else this.cameraRig.deckPos = null;
    if (this.cameraRig.view === 'deck' && !this.cameraRig.deckPos) this.cameraRig.cycle();
    this._applyClouds();
    if (moved) this._publishOrigin();
    this._publishCarve();
    this._publishWater();
    this._publishFlatten();
    this._publishShadows();
  }

  /**
   * The room sun's shadow map: only the airplane (and the player, the room's own) casts into it,
   * nothing else of ours; Google's unlit tiles take it too (darkened by the sun's share of light).
   */
  _publishShadows() {
    const plane = this.visual?.root;
    for (const r of this._worldRoot?.findComponents('render') || []) {
      if (r.castShadows && !(plane && (r.entity === plane || r.entity.isDescendantOf(plane)))) r.castShadows = false;
    }
    this.app.fire('googletiles:receive-shadows', 0.55);
  }

  /** What casts the sun's shadow in flight (plugin/planeShadowFit.js): the airplane and its pilot. */
  _shadowFocus() {
    const root = this.visual?.root;
    if (!this._flying || !root) return null;
    if (this._shadowRoot !== root) {
      this._shadowRoot = root;
      this._shadowMeshes = root.findComponents('render').flatMap((r) => r.meshInstances);
    }
    const spheres = [];
    const at = ArrivalSpace.getPlayer?.()?.getPosition();
    if (at && at.distance(root.getPosition()) < this.ac.spec.wing.span * this._ws) spheres.push({ at, r: 1.2 * this._ws });
    return { meshes: this._shadowMeshes, spheres, agl: Math.max(0, this.ac.agl) * this._ws };
  }

  /** The reflection cube follows the airplane while the camera is near it; the airplane and pilot stay out of it. */
  _probeTick() {
    const root = this.visual?.root, cam = ArrivalSpace.getCamera?.();
    const on = !!root && !!cam && cam.getPosition().distance(root.getPosition()) < 400 * this._ws;
    if (on && (this._probeRoot !== root || (this._probeHideAt = (this._probeHideAt || 0) + 1) % 60 === 0)) {
      this._probeRoot = root;
      const player = ArrivalSpace.getPlayer?.();
      this._probe.hide([root, player].filter(Boolean).flatMap((e) => e.findComponents('render').flatMap((r) => r.meshInstances)));
    }
    setReflectionCube(this._probe.update(on ? root.getPosition() : null, on, this._ws) ? this._probe.texture : null);
  }

  /** Google's globe under the place: its start on the runway where the vibe stands. */
  _publishOrigin() {
    const s = this.world.startPosition();
    const [latitude, longitude] = this.world.frame.toLatLon(s.n, s.e);
    this.app.fire('googletiles:set-origin', {
      latitude, longitude, groundAltitude: this.world.elevation + this.world.data.geoidM,
      sun: this.world.data.sun,      // the place's own (Renton's imagery), else the space's
    });
  }

  /** Google's ground levelled where the airplane rolls (Innsbruck's runway, taxiways, aprons). */
  _publishFlatten() {
    const id = `extra300-flatten-${this.entity.getGuid()}`;
    if (this._dest === 'meigs' || !this._worldRoot) { this.app.fire('googletiles:flatten-region-clear', id); return; }
    if (!this._flatMasks[this._dest]) {
      const m = this.world.flattenMask();
      const tex = new pc.Texture(this.app.graphicsDevice, {
        width: m.width, height: m.height, format: pc.PIXELFORMAT_R8, mipmaps: false,
        minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
      });
      tex.lock().set(m.data);
      tex.unlock();
      this._flatMasks[this._dest] = { texture: tex, box: m.box };
    }
    const flat = this._flatMasks[this._dest];
    const root = this._worldRoot.getWorldTransform();
    this.app.fire('googletiles:flatten-region', id, {
      texture: flat.texture,
      inv: maskTransform(root, flat.box),
      height: this._worldRoot.getPosition().y,
    });
  }

  // ── setup helpers ──────────────────────────────────────────────────────
  get _ws() {
    const s = Number(this.app.worldScale);
    return s > 0 ? s : 0.7;
  }

  /** The airplane itself: flight model, instruments, 3D model, sound, stick feel, cockpit display, camera eye. */
  _buildAircraft(profile) {
    this.profile = profile;
    const spec = profile.spec;
    this.ac = new Aircraft(spec, {
      ground: this.world.ground,
      datumMsl: this.world.elevation,
      load: spec.engine ? { fuelCenterL: this.fuelLiters } : {},
      weather: this._weather(),
    });
    this.instruments = new Instruments(spec, { kollsman: this.qnhInHg * INHG });
    // a hook to catch the carrier's wires with
    if (spec.hook) this.ac.arrestor = new Arrestor(this.carrier);
    this.mapper.setHandling(spec.handling);
    this.mapper.speedbrake = false;
    this.cameraRig.eye = spec.eye;
    this.cameraRig.size = profile.chaseSize;
    if (typeof this._unsubClick === 'function') this._unsubClick();
    this.display?.destroy();
    this.display = null;
    this.visual?.destroy();
    this.visual = new AircraftVisual(this.app, this._worldRoot, profile.buildModel(), profile.title);
    if (profile.cockpitDisplay) this.display = new CockpitDisplay(this.app, this.visual.root, this.world);
    this.sound?.stop();
    this.sound = new profile.Sound();
    this.hud.setProfile(profile, nextProfile(profile));
    this.hud.jetHud.setColor(profile.hudColor || '#6dff9e');
    this.lasers?.hide();
    this.mapper.sfoils = 0;
    this._sfoilHint = false;
    // tap / click the airplane to board
    this._unsubClick = ArrivalSpace.onEntityClick?.(this.visual.root, () => { if (!this._flying) this._enter(); });
    this._resetToRunway();
    this.visual.update(this.ac, 0);
  }

  /** Another airplane, back on runway 36; a pilot already aboard moves across with it. */
  _switchAircraft(profile) {
    if (profile === this.profile) return;
    const flying = this._flying;
    if (this._intro) this._endIntro();
    if (this._demo) this._stopDemo('Demo ended');
    if (flying) { this._attach?.detach?.(); this._attach = null; }
    this._buildAircraft(profile);
    this.aircraft = profile.title;
    if (flying) {
      this._attachPilot();
      this.sound.start();
      this._setAvatarVisible(this.cameraRig.view !== 'cockpit');
      this.visual.setCockpitView(this.cameraRig.view === 'cockpit');
      this._showTakeoffCard();
      this.hud.flash(`${profile.title} on runway ${this._runwayName}`, 2.5);
    }
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
  /** Offer the avatar animation catalog as the pilot-pose choices in the editor (as the vehicle demo does). */
  async _loadPoses() {
    try {
      const cfg = await ArrivalSpace.getAvatarConfig?.();
      const list = await ArrivalSpace.getAvatarAnimationCatalog?.(cfg?.gender === 'female' ? 'female' : 'male');
      if (Array.isArray(list) && list.length) this.setParamOptions?.('seatAnimation', list, false);
    } catch { /* the default pose still works */ }
  }

  async _loadCity() {
    try {
      const osm = await inflateOsm(CHICAGO_OSM);
      if (this._destroyed) return;
      this.meigs.attachOsm(osm, this.skylineYear);
      this._publishWater();   // the lake's mask: Google's water shading and our reflections
      this.city = new OsmVisual(this.app, this._worldRoot, this.meigs, this._cityOptions());
      this.city.visible = this.showScenery && this._dest === 'meigs';
      if (this._google) this.city.setGoogle(true);
      // the stand-in skyline stays up until the last OSM tile is built (see update)
    } catch (e) {
      console.warn('[extra300] OpenStreetMap city unavailable, keeping the stand-in skyline:', e);
    }
  }

  // ── Google Photorealistic 3D Tiles (the "Google 3D Tiles" vibe in the same space) ──────
  // Its tiles are the city, the land and the lake; we keep only Meigs itself, cut out of the tiles.
  // Our OpenStreetMap buildings aren't drawn then, and aren't solid either.
  _googleTick(dt) {
    // the vibe sets app.googleTilesLoading while its first tiles stream in and clears it when they are up
    if (!this._google && this.app.googleTilesLoading === false) this._setGoogle(true);
    // (re)publish the cut-out now and then: the tiles vibe may start after us, or be re-added
    this._carveTimer = (this._carveTimer ?? 0) - dt;
    if (this._carveTimer <= 0) {
      this._carveTimer = 2;
      this._publishCarve();
      this._publishWater();
      this._publishFlatten();
      this._publishShadows();
      // the tiles vibe may have started after we moved: tell it again where we are
      if (this._dest !== 'meigs') this._publishOrigin();
      // with no API key yet the tiles vibe lays a 50 km green disc at the runway's height, over our lake
      const ph = this.app.root.findByName('google-tiles-placeholder-ground');
      if (ph?.enabled) ph.enabled = false;
    }
  }

  _setGoogle(on) {
    this._google = on;
    for (const [id, t] of Object.entries(this._terrains)) t.visible = id === this._dest && !on;
    this.city?.setGoogle(on);
    this.scenery.setGoogle(on);
    if (on) this.scenery.standInCity = false;
    // the tiles vibe brings its own sky
    if (this._sky) this._showSky(this._flying && !on);
  }

  _publishCarve() {
    if (!this._worldRoot) return;
    let box;
    if (this._dest === 'meigs') {
      // from just under the runway up: the island's park, hills and trees go, Google's water around it stays
      box = carveBox(this.world.airfieldBox(), CARVE_FLOOR, 400);
    } else if (this._runways[this._dest]) {
      // under our runway: Google's (flattened) photo of it, no higher than a few metres
      const rw = this.world.runway, { u, v } = this._runways[this._dest].extent, mid = (v[0] + v[1]) / 2;
      box = carveBox({
        centre: [rw.centre[0] + rw.dir[0] * mid, rw.centre[1] + rw.dir[1] * mid], dir: rw.dir,
        halfAlong: (v[1] - v[0]) / 2, halfAcross: u[1],
      }, CARVE_FLOOR, 3);
    } else { this.app.fire('googletiles:patch-region-clear', `extra300-meigs-${this.entity.getGuid()}`); return; }
    const { local, half } = box;
    const m = new pc.Mat4();
    m.set(local);
    const world = new pc.Mat4().mul2(this._worldRoot.getWorldTransform(), m);
    const inv = world.invert();
    this.app.fire('googletiles:patch-region', `extra300-meigs-${this.entity.getGuid()}`, { inv: Array.from(inv.data), half });
  }

  /**
   * The lake from OpenStreetMap's land/water raster, for the tiles vibe to shade as water
   * (waterMask.js): Chicago's lakefront, Renton's Lake Washington.
   */
  _publishWater() {
    const wid = `extra300-meigs-${this.entity.getGuid()}`;
    const has = this._dest === 'meigs' ? !!this.world.osm : !!this.world.waterMask;
    if (!this._worldRoot || !has) { this.app.fire('googletiles:water-mask-clear', wid); return; }
    if (!(this._dest in this._waters)) this._waters[this._dest] = buildWaterMasks(this.app.graphicsDevice, this.world);
    const masks = this._waters[this._dest];
    if (!masks) { this.app.fire('googletiles:water-mask-clear', wid); return; }
    const root = this._worldRoot.getWorldTransform();
    const { near, far } = masks;
    this._waterXf = { nearInv: maskTransform(root, near.box), farInv: maskTransform(root, far.box), scale: 1 / this._ws };
    this.app.fire('googletiles:water-mask', wid, {
      near: { texture: near.texture, inv: this._waterXf.nearInv },
      far: { texture: far.texture, inv: this._waterXf.farInv },
      level: this.world.water,
      scale: this._waterXf.scale,
      origin: (({ x, y, z }) => [x, y, z])(this._worldRoot.getPosition()),
    });
    // the lake's mirror: screen-space reflections over the same mask
    // (GLSL: WebGL2 only for now)
    if (!this._ssrs[this._dest] && !this.app.graphicsDevice.isWebGPU) {
      this._ssrs[this._dest] = new WaterReflections(this.app, this._worldRoot, this.world.water, masks, { steps: this.isMobile ? 40 : 160 });
      this._ssrs[this._dest].visible = this.waterReflections;
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

  /** The LSO platform: on the port deck edge abeam the wires, a man's height up — the deck view. */
  _placeDeckCamera() {
    if (!this.showCarrier) { this.cameraRig.deckPos = null; return; }
    const cv = this.carrier;
    const [n, e] = cv.onLanding(cv.wires[0].along - 25, -cv.data.landing.halfWidth - 9);
    this.cameraRig.deckPos = fromNE(n, e, cv.deckH + 1.8);
  }

  _resetToRunway() {
    this.mapper.resetHolds();
    // on final to the carrier only once aboard: parked, the airplane waits on runway 36
    if (this._onFinalStart) { this._startOnFinal(); return; }
    const { n, e, heading } = this.world.startPosition(this.startRunway === '18');
    if (this.ac.spec.engine) this.ac.load.fuelCenterL = this.fuelLiters;
    this.ac.updateMass();
    this.ac.placeOnGround(n, e, heading);
    this.ac.controls.parkingBrake = false;
    this.ac.setEngineRunning(this.engineRunningAtStart);
    if (!this.ac.jet) {
      this.ac.engine.oilTemp = this.engineRunningAtStart ? 70 : this.oatC;
      this.ac.engine.cht = this.engineRunningAtStart ? 150 : this.oatC;
    }
    this.mapper.throttle = 0;
    this.mapper.gear = 1;
    this.mapper.hook = 0;
    this.instruments.resetG();
    // let it settle onto its gear before anyone sees it
    for (let i = 0; i < 480; i++) this.ac.step(1 / 480);
  }

  get _onFinalStart() { return this._flying && this.startRunway === 'Carrier approach' && this.showCarrier && this._dest === 'meigs'; }

  /** On final to the carrier, on the glide slope, gear (and hook) down, on speed. */
  _startOnFinal() {
    const jet = this.ac.jet;
    const cv = this.carrier;
    // the Extra comes in slower and from closer in
    const st = cv.approachStart(jet ? CARRIER_APPROACH.startDist : 1500);
    const kt = jet ? CARRIER_APPROACH.approachKt : 72;
    this.ac.placeInFlight(st.n, st.e, this.world.elevation + st.h, st.heading, kt * KT, (jet ? 8 : 6) * DEG);
    const c = this.ac.controls;
    c.gear = 1; this.ac.gearPos = 1;
    if (jet) { c.flaps = 1; this.mapper.throttle = 0.47; } else this.mapper.throttle = 0.45;
    if (this.ac.spec.hook) { c.hook = 1; this.ac.hookPos = 1; }
    this.mapper.gear = 1;
    this.mapper.hook = this.ac.spec.hook ? 1 : 0;
    this.instruments.resetG();
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
    this._attachPilot();
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
    this._showSky(!this._google);
    this._pose = this.cameraRig.update(this.ac, 0, this.ac.cg);
    this.hud.showPrompt('');
    this.hud.setFlying(true, this._panelVisible);
    // the first boarding plays the intro film; after it (and on later boardings) only the small
    // take-off card shows, the full table is behind Controls / H
    if (this._onFinalStart && !this._demo) {
      // straight onto final: no film, the carrier ahead
      this._introPlayed = true;
      this._resetToRunway();
      this.hud.flash(this.ac.spec.hook ? 'On final to USS Nimitz: fly the ball, the hook is down (/)' : 'On final to USS Nimitz: land on the angled deck', 5);
    } else if (this.playIntro && !this._introPlayed && !this._demo && this._dest === 'meigs') this._startIntro();
    else this._showTakeoffCard();
  }

  /** The avatar in the pilot's seat (the Extra's rear seat, the Eagle's ACES II). */
  _attachPilot() {
    // the avatar sits in a seated pose (as the vehicle demo seats its driver): its root goes below the
    // seat pan by the pose's hip height, so the hips land on the cushion
    const seat = this.profile.seat || { forward: this.avatarSeatForward, height: this.avatarSeatHeight, lean: this.avatarLean };
    const pose = this.seatAnimation || 'driving.glb';
    this._attach = ArrivalSpace.attachPlayerToEntity?.(this.visual.root, {
      offset: { x: this.profile.spec.eye[1], y: -seat.height, z: -seat.forward },
      animations: { Idle: pose, Forward: pose, Backward: pose, Left: pose, Right: pose },
      // the avatar faces the entity's +z; the airplane's nose is its −z: turn the avatar round
      // and lean it back into the reclined seat (the car pose sits upright)
      meshEuler: () => ({ x: -(this.profile.seat ? this.profile.seat.lean : this.avatarLean), y: 180, z: 0 }),
      disableCollision: true,
      rate: 20,
      extra: () => ({ aircraft: this.profile.id, rpm: Math.round(this.ac.rpm), ias: Math.round(this.instruments.values.ias || 0) }),
    }) || null;
  }

  _showTakeoffCard() {
    this._helpAutoHidden = false;
    this.hud.showQuick(this.ac.agl < 30);
    // on a phone it should fly with one thumb: easy mode (stall-proof, rudder done for you, the
    // attitude held when the stick is let go) and the engine already at 75 % — it rolls, lifts off
    // at 65 kt by itself, and the left stick points it
    if (this.isMobile) {
      if (!this._mobileEasyOn) { this._mobileEasyOn = true; this._setEasy(true); }
      if (this.ac.gear.onGround && this.ac.groundSpeed < 2 && !this.ac.damage.crashed) {
        if (!this.ac.engine.running) this.ac.setEngineRunning(true);
        this.ac.controls.parkingBrake = false;
        if (this.ac.spec.sfoils) this.mapper.sfoils = 1;   // they open by themselves once it is off the ground
        this.mapper.throttle = MOBILE_THROTTLE;
      }
    }
  }

  // ── the intro film ──────────────────────────────────────────────────────
  /** Film mode: wait for the city (and Google's first tiles, if they come), settle, then board and roll. */
  _filmTick(dt) {
    const cityUp = this._dest !== 'meigs' || (this.city && !this.city.queue.length);
    const tilesUp = this.app.googleTilesLoading !== true;
    this._filmWait = cityUp && tilesUp ? (this._filmWait || 0) + dt : 0;
    if (this._filmWait < 2.5) return;
    this._filmPending = false;
    this._filmMode = true;
    this.playIntro = true;
    this._introPlayed = false;
    this._enter();
  }


  _startIntro() {
    this._introPlayed = true;
    this._intro = { t: 0 };
    const c = this.ac.controls;
    // it starts with the engine still: the first shot watches the starter turn the prop over (or spool the cores up)
    this.ac.setEngineRunning(false);
    c.throttle = 0; c.parkingBrake = true; c.starter = false;
    this.mapper.throttle = 0;
    this._setAvatarVisible(true);
    this.visual.setCockpitView(false);
    this.hud.showIntro(true);
    if (this._filmMode) this.hud.skipButton.style.display = 'none';   // not in the recording
  }

  _introTick(dt) {
    const it = this._intro;
    it.t += dt;
    const c = this.ac.controls;
    const film = this.profile.intro;
    c.throttle = 0; c.parkingBrake = true;
    c.starter = it.t > film.starter[0] && it.t < film.starter[1] && !this.ac.engine.running;
    const shot = introAt(it.t, film);
    // the last second flies into the pilot's seat: the pilot's own head goes, and the canopy
    const inside = it.t > film.length - 1.2;
    this._setAvatarVisible(!inside);
    this.visual.setCockpitView(inside);
    this.hud.setIntroCard(shot.card >= 0 ? film.cards[shot.card] : null, shot.cardAlpha, Math.min(1, it.t / film.length));
    if (shot.done) { this._endIntro(); return null; }
    return this.cameraRig.bodyPose(this.ac, shot.eye, shot.at, shot.fov, this.ac.cg);
  }

  /** The film ends (or is skipped): the engine runs, the brake is off, the pilot is in the cockpit view. */
  _endIntro() {
    if (!this._intro) return;
    this._intro = null;
    this._filmMode = false;
    const c = this.ac.controls;
    c.starter = false;
    c.parkingBrake = false;
    if (this.engineRunningAtStart && !this.ac.engine.running) this.ac.setEngineRunning(true);
    this.hud.showIntro(false);
    this.hud.setFlying(true, this._panelVisible);
    this.cameraRig.view = 'cockpit';
    this.cameraRig.centre();
    this._setAvatarVisible(false);
    this.visual.setCockpitView(true);
    this._showTakeoffCard();
  }

  _exit() {
    if (!this._flying) return;
    this._intro = null;
    if (this._demo) this._stopDemo('Demo ended');
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
    const out0 = this.ac.spec.wing.span / 2 + 1.5;
    const side = [p[0] + Math.sin(this.ac.euler.psi) * out0, p[1] - Math.cos(this.ac.euler.psi) * out0];
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

  _setEasy(on) {
    this.mapper.easy = on;
    this.hud.setEasy(on);
  }

  // ── demo flight ──────────────────────────────────────────────────────────
  _startDemo() {
    if (!this.isEnabled) return;
    const kind = this.profile.demo;
    if (!kind || (kind === 'carrier' && !this.showCarrier) || this._dest !== 'meigs') { this.hud.flash(this._dest !== 'meigs' ? 'The demo flights are at Chicago Meigs (✈ on the top bar)' : 'No demo flight for this airplane here (T switches airplane)', 3); return; }
    this._introPlayed = true;
    if (this._intro) this._endIntro();
    if (!this._flying) this._enter();
    this._paused = false;
    if (kind === 'carrier') {
      // a carrier landing: on final, the demo pilot flies the ball into the wires
      this._startOnFinal();
      this._demo = new CarrierPilot(this.ac, this.carrier);
    } else {
      this._resetToRunway();
      this.ac.setEngineRunning(true);
      this._demo = new PatternPilot(this.ac, this.world);
    }
    this._director = true;
    this._helpAutoHidden = true;
    this.hud.toggleHelp(false);
    this.hud.showQuick(false);
    this.hud.flash('Demo flight: watch, or press any flight key to take over', 4);
  }

  _stopDemo(message = 'You have control') {
    if (!this._demo) return;
    // hand over exactly as it is: the throttle and trim stay where the demo pilot left them
    this.mapper.throttle = Math.max(0, this.ac.controls.throttle);
    this.mapper.trim = this.ac.controls.elevatorTrim || 0;
    this.mapper.gear = this.ac.controls.gear ?? 1;
    this.mapper.hook = this.ac.controls.hook ?? 0;
    this.ac.controls.brakeL = this.ac.controls.brakeR = 0;
    this._demo = null;
    this.hud.showDemoStatus('');
    this.hud.flash(message, 2.5);
  }

  /** Which camera tells each part of the circuit best (until the viewer presses V). */
  _directCamera() {
    if (!this._director) return;
    if (this._demo instanceof CarrierPilot) {
      // the approach from behind, then the LSO's view of the last of it and the trap, then round it
      const d = this._demo;
      const behind = this.carrier.aimAlong - this.carrier.along(this.ac.state.pos[0], this.ac.state.pos[1]);
      const want = d.phase === 'approach' ? (behind > 1100 ? 'chase' : 'deck') : d.phase === 'stopped' && d.phaseT > 3 ? 'chase' : d.phase === 'bolter' ? 'chase' : 'deck';
      if (this.cameraRig.view !== want) {
        while (this.cameraRig.view !== want) this.cameraRig.cycle();
        this._setAvatarVisible(true);
        this.visual.setCockpitView(false);
      }
      return;
    }
    const want = {
      takeoff: 'chase', climb: 'chase', crosswind: 'chase', downwind: 'chase', loopEntry: 'flyby', loop: 'flyby',
      recover: 'chase', downwind2: 'chase', base: 'chase', final: 'cockpit', flare: 'cockpit', rollout: 'tower', stopped: 'tower',
    }[this._demo.phase] || 'chase';
    if (this.cameraRig.view === want) return;
    while (this.cameraRig.view !== want) this.cameraRig.cycle();
    this._setAvatarVisible(want !== 'cockpit');
    this.visual.setCockpitView(want === 'cockpit');
  }

  _demoText() {
    const d = this._demo;
    if (!(d instanceof CarrierPilot)) return Extra300.DEMO_TEXT[d.phase] || '';
    if (d.phase === 'arrested' || (d.phase === 'stopped' && d.trap)) {
      return d.phase === 'arrested' ? `Trap! The ${d.trap.wire}-wire has it at ${d.trap.kt} kt` : `Stopped, ${d.trap.wire}-wire. Hook up, the wire lets go. O flies it again, or take over`;
    }
    return Extra300.CARRIER_TEXT[d.phase] || '';
  }

  static CARRIER_TEXT = {
    approach: 'On final to USS Nimitz: 138 kt, gear, flaps and hook down, flying the ball',
    touchdown: 'Touchdown: full power, in case the hook skips the wires',
    bolter: 'Bolter: the hook missed every wire. Full power, round again',
  };

  static DEMO_TEXT = {
    takeoff: 'Takeoff from runway 36 — full power, tail up at 35 kt',
    climb: 'Climbing out over Northerly Island at 85 kt',
    crosswind: 'Crosswind: right turn out over the lake',
    downwind: 'Downwind at 1,000 ft — loop coming up',
    loopEntry: 'Diving for 160 kt…',
    loop: 'Loop — holding the stick back, easing at the buffet',
    recover: 'Easing out of the loop',
    downwind2: 'Back on downwind, slowing down',
    base: 'Base: power back, descending',
    final: 'Final, runway 36 — 72 kt over the fence',
    flare: 'Flare — holding it off',
    rollout: 'Touchdown — three-pointer, gentle brakes',
    stopped: 'Stopped on runway 36. Press the button to fly it again, or take over.',
  };

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
      if (key === 'o') { this._startDemo(); e.preventDefault(); }
      return;
    }
    // during the intro: Space, Enter or Esc skip it; nothing else flies the airplane yet
    if (this._intro) {
      if (key === ' ' || key === 'Enter' || key === 'Escape') this._endIntro();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // any flight control key takes the airplane back from the demo pilot
    if (this._demo && FLIGHT_KEYS.some((b) => BINDINGS[b].includes(key))) this._stopDemo();
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
        this._director = false;   // the viewer picks the camera now
        const v = this.cameraRig.cycle();
        this._setAvatarVisible(v !== 'cockpit');
        this.visual.setCockpitView(v === 'cockpit');
        this.hud.flash(`View: ${v}`, 1.5);
        break;
      }
      case 'panel': this._panelVisible = !this._panelVisible; this.hud.setFlying(true, this._panelVisible); break;
      case 'reset':
        if (this._demo) this._stopDemo('Demo ended');
        this._resetToRunway();
        this.hud.flash(this._onFinalStart ? 'Back on final to the carrier' : `Back on runway ${this._runwayName}`, 2);
        break;
      case 'pause': this._paused = !this._paused; break;
      case 'help': this.hud.toggleHelp(); break;
      case 'mixture':
        c.mixture = c.mixture > 0.5 ? 0 : 1;
        this.hud.flash(this.ac.jet ? (c.mixture ? 'Fuel on' : 'Fuel off: engines shut down') : (c.mixture ? 'Mixture rich' : 'Mixture cut-off'), 1.5);
        break;
      case 'parkingBrake': c.parkingBrake = !c.parkingBrake; break;
      case 'gReset': if (!this.ac.retractable) this.instruments.resetG(); break;
      case 'gear':
        if (!this.ac.retractable) break;
        if (this.ac.gear.onGround) { this.hud.flash('Weight on wheels: the gear stays down', 1.5); break; }
        this.mapper.gear = this.mapper.gear ? 0 : 1;
        this.hud.flash(this.mapper.gear ? 'Gear down' : 'Gear up', 1.2);
        break;
      case 'speedbrake':
        if (this.ac.spec.sfoils) {
          // the X-wing's J: the S-foils
          this.mapper.sfoils = this.mapper.sfoils ? 0 : 1;
          this.hud.flash(this.ac.gear.onGround ? 'S-foils open once you are off the ground' : this.mapper.sfoils ? 'S-foils in attack position' : 'S-foils closed: cruise', 1.5);
          break;
        }
        if (!this.ac.jet) break;
        this.mapper.speedbrake = !this.mapper.speedbrake;
        this.hud.flash(this.mapper.speedbrake ? 'Speed brake out' : 'Speed brake in', 1.2);
        break;
      case 'aircraft': this._switchAircraft(nextProfile(this.profile)); break;
      case 'hook':
        if (!this.ac.spec.hook) break;
        this.mapper.hook = this.mapper.hook ? 0 : 1;
        this.hud.flash(this.mapper.hook ? 'Hook down' : 'Hook up', 1.2);
        break;
      case 'kollsman': this.instruments.kollsman = this.ac.weather.qnh; this.hud.flash(`Altimeter ${(this.ac.weather.qnh / INHG).toFixed(2)}`, 1.5); break;
      case 'easy':
        this._setEasy(!this.mapper.easy);
        this.hud.flash(this.mapper.easy ? this.profile.easyOn : 'Easy mode off: all yours', 2.5);
        break;
      case 'autoRudder': this.mapper.autoRudder = !this.mapper.autoRudder; this.hud.flash(this.mapper.autoRudder ? 'Auto-rudder on (keeps the ball centred)' : 'Auto-rudder off: your feet', 2); break;
      case 'yoke': this._yoke = !this._yoke; this.hud.flash(this._yoke ? 'Mouse yoke on' : 'Mouse yoke off', 1.5); break;
      case 'lookCenter': this.cameraRig.centre(); break;
      case 'exit': this._exit(); break;
      case 'demo': this._demo ? this._stopDemo() : this._startDemo(); break;
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
    return pp.distance(ap) < Math.max(BOARD_DISTANCE, this.ac.spec.wing.span) * this._ws;
  }

  // ── frame ──────────────────────────────────────────────────────────────
  update(dt) {
    this._dt = dt;
    if (!this.isEnabled) return;
    this.hud.tick();
    if (this._menu) return;   // nothing is there yet
    this._probeTick();
    this._lightsTick(dt);
    this._googleTick(dt);
    if (this.city && this.city.queue.length) {
      this.city.tick(this._flying ? 3 : 8);
      if (!this.city.queue.length) this.scenery.standInCity = false;
    }
    if (!this._flying) {
      if (this._filmPending) this._filmTick(dt);
      if (!this._flying) this.hud.showPrompt(this._nearAircraft() ? (this.isMobile ? this.profile.title : `Press E to fly the ${this.profile.title}`) : '');
      return;
    }
    const raw = {
      keys: this._keys,
      pad: this._readPad(),
      left: this.isMobile ? this.getLeftStick() : null,
      right: this.isMobile ? this.getRightStick() : null,
      yoke: this._yoke ? { x: this._mouse.x, y: this._mouse.y } : null,
      fire: this._fire,
    };
    if (this._demo && raw.pad && raw.pad.axes.slice(0, 4).some((a) => Math.abs(a) > 0.35)) this._stopDemo();
    if (this._intro) {
      // the film: nobody at the controls yet, the airplane stands on its brakes
    } else if (this._demo) {
      if (!this._paused) this._demo.step(Math.min(dt, 0.1));
      this._directCamera();
      this.hud.showDemoStatus(this._demoText());
    } else {
      this.mapper.update(raw, dt, this.ac.controls, this.ac.flightState());
    }
    if (!this._paused) this.ac.update(dt);
    this._checkBuildings();
    // the controls card has done its job once the airplane is flying
    if (!this._helpAutoHidden && this.ac.agl > 30) { this._helpAutoHidden = true; this.hud.showQuick(false); }
    const v = this.instruments.update(this.ac, dt);
    this.display?.update(this.ac, v, dt, this.cameraRig.view === 'cockpit' && !this._intro);
    this.visual.update(this.ac, this._paused ? 0 : dt);
    if (this.showCarrier) this.carrierVisual.update(this.ac);
    if (this.profile.lasers) {
      if (this.lasers.update(this.ac, !!this.ac.controls.fire && !this._intro && !this._demo && !this._paused, this._paused ? 0 : dt, this._laserSolid)) this.sound.pew?.();
      // a first-time hint once it is flying with its wings still closed
      if (!this._sfoilHint && !this.isMobile && this.ac.agl > 40 && !this.mapper.sfoils) {
        this._sfoilHint = true;
        this.hud.flash('J: S-foils into attack position, then Space fires', 4);
      }
    }

    for (const ev of this.ac.events.splice(0)) {
      if (ev.e === 'propStrike') this.hud.flash('Prop strike! Backspace to reset', 4);
      if (ev.e === 'nozzleLStrike' || ev.e === 'nozzleRStrike') this.hud.flash('Tail strike: easy on the rotation', 3);
      if (/^belly/.test(ev.e)) this.hud.flash('Gear-up landing! Backspace to reset', 4);
      if (ev.e === 'trap' && !this._demo) this.hud.flash(`Trap! ${ev.wire}-wire at ${Math.round(ev.kt)} kt`, 4);
      if (ev.e === 'stopped' && !this._demo) this.hud.flash(`Stopped in ${Math.round(ev.runout)} m. Throttle idle, hook up (/) to let the wire go`, 5);
      if (ev.e === 'bolter' && !this._demo) this.hud.flash('Bolter! Full power and go around', 3);
      if (ev.e === 'splash') this.hud.flash('In the lake. Backspace to reset', 4);
    }

    this._pose = (this._intro && this._introTick(dt)) || this.cameraRig.update(this.ac, dt, this.ac.cg);

    this.sound.update({
      rpm: this.ac.rpm,
      powerFrac: this.ac.jet ? this.ac.engine.power : Math.max(0, this.ac.engine.power) / this.ac.spec.engine.ratedPower,
      ab: this.ac.jet ? this.ac.engine.ab : 0,
      running: this.ac.engine.running,
      qbar: this.ac.out.qbar,
      stall: v.stallWarning,
      inside: this.cameraRig.view === 'cockpit',
    });

    this._panelAcc += dt;
    if (this._panelVisible && !this._intro && this._panelAcc > 1 / 30) {
      this._panelAcc = 0;
      const c = this.ac.controls;
      if (this.profile.display === 'hud') {
        this.hud.jetHud.draw(v, {
          fov: this._pose?.fov, throttle: c.throttle, abDetent: this.ac.spec.jet.abDetent, gearPos: this.ac.gearPos,
          speedbrake: this.ac.spec.aero.body.speedbrakeDragArea ? this.ac.speedbrakePos : null,
          flaps: this.ac.spec.autoFlaps ? c.flaps : null, hook: this.ac.spec.hook ? this.ac.hookPos : null,
          sfoils: this.ac.spec.sfoils ? this.ac.sfoilPos : null, boostLabel: this.profile.boostLabel,
          parkingBrake: c.parkingBrake, engineRunning: this.ac.engine.running,
          paused: this._paused, stall: v.stallWarning, gMax: this.ac.spec.limits.gPos, conformal: this.cameraRig.view === 'cockpit' && !this._intro,
        });
      } else {
        this.hud.panel.draw(v, {
          throttle: c.throttle, prop: c.prop, trim: c.elevatorTrim, parkingBrake: c.parkingBrake,
          engineRunning: this.ac.engine.running, paused: this._paused,
        });
      }
    }
  }

  /** The airfield's changing lights: the PAPIs need to know where the eye is. */
  _lightsTick(dt) {
    const cam = ArrivalSpace.getCamera?.();
    let eye = null;
    if (cam) {
      const p = cam.getPosition(), o = this._worldRoot.getPosition(), ws = this._ws;
      eye = [(p.x - o.x) / ws, (p.y - o.y) / ws, (p.z - o.z) / ws];
    }
    if (this.showScenery) this.lights.update(dt, eye);
    if (this.showCarrier) this.carrierVisual.lod(eye);
    const ssr = this._ssrs[this._dest];
    if (ssr && this._waterXf) ssr.update(dt, this._waterXf);
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

  /** Fly into a building (or the carrier's side, or its island) and the flight ends there. */
  _checkBuildings() {
    if (this.showCarrier && this._dest === 'meigs' && !this.ac.damage.crashed) {
      const p = this.ac.state.pos, h = -p[2];
      if (this.carrier.hullContains(p[0], p[1], h - 1) || this.carrier.islandContains(p[0], p[1], h)) {
        this._crash('You hit the ship. Backspace to reset');
        return;
      }
    }
    // only the city we draw is solid: under Google's tiles the OpenStreetMap buildings aren't there
    if (!this.world.osm || this.ac.damage.crashed || this._google) return;
    const p = this.ac.state.pos;
    const h = -p[2];
    if (h > 450) return;
    if (this.world.buildingAt(p[0], p[1], h)) this._crash('You hit a building. Backspace to reset');
  }

  /** What a laser bolt bursts on: the ground or the water, the ship, a building (n, e, h above the datum). */
  _laserSolid = (n, e, h) => {
    if (h <= this.world.ground(n, e).h) return true;
    if (this.showCarrier && this._dest === 'meigs' && (this.carrier.hullContains(n, e, h) || this.carrier.islandContains(n, e, h))) return true;
    return !!(this.world.osm && h < 450 && this.world.buildingAt(n, e, h));
  };

  _crash(message) {
    this.ac.damage.crashed = true;
    this.ac.setEngineRunning(false);
    this.ac.state.vel = [0, 0, 0];
    this.ac.state.omega = [0, 0, 0];
    this.hud.flash(message, 5);
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
    this._skySun(p);
  }

  /**
   * The sun in our sky where the scene's light comes from: the dome's haze brightened round it
   * (re-coloured when the light turns) and a disc with its glow. The light is the room's main
   * directional one (found again now and then: the room may set it up after us).
   */
  /** The clouds' settings: the preset, the base above this field. */
  _applyClouds() {
    this.cloudLayer?.set(CLOUD_PRESETS[this.clouds] || null, this.world.elevation + this.cloudBaseFt * 0.3048);
  }

  _cloudsTick() {
    if (!this.cloudLayer || !this.isEnabled) return;
    const cam = ArrivalSpace.getCamera?.();
    if (!cam) return;
    const L = this._sunLight || this.app.root.findComponents('light').find((l) => l.type === 'directional' && l.enabled);
    const up = L ? L.entity.up : { x: 0.3, y: 0.8, z: 0.3 };
    const w = this._weather().wind;          // NED, toward
    const sunDir = [up.x, up.y, up.z];
    this.cloudLayer.update(this._dt || 1 / 60, {
      cam, root: this._worldRoot, ws: this._ws, datumMsl: this.world.elevation,
      sunDir, wind: [w[1], w[0]], hdr: !!this.app.customTravelCenter?.cameraFrame,
    });
  }

  _skySun(camPos) {
    this._sunLookup = (this._sunLookup ?? 0) - 1;
    if (this._sunLookup <= 0 || !this._sunLight?.entity?.enabled) {
      this._sunLookup = 120;
      this._sunLight = this.app.root.findComponents('light').find((l) => l.type === 'directional' && l.enabled && l.entity.enabled) || null;
    }
    const L = this._sunLight;
    const up = L ? L.entity.up : null;                       // a directional light shines down its -Y
    const sun = up && up.y > -0.1 ? [up.x, up.y, up.z] : null;
    const last = this._skySunDir;
    if (!!sun !== !!last || (sun && sun[0] * last[0] + sun[1] * last[1] + sun[2] * last[2] < 0.99996)) {
      this._skySunDir = sun;
      const mi = this._sky.render.meshInstances[0];
      const old = mi.mesh;
      mi.mesh = toMesh(this.app.graphicsDevice, buildSkyDome(32, 14, sun));
      old.destroy();
    }
    if (!this._sunDisc) {
      const m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(0, 0, 0);
      m.emissive = new pc.Color(1, 0.96, 0.86);
      m.emissiveIntensity = 1.5;
      m.emissiveMap = discTexture(this.app.graphicsDevice);
      m.opacityMap = m.emissiveMap;
      m.opacityMapChannel = 'a';
      m.blendType = pc.BLEND_ADDITIVEALPHA;
      m.depthWrite = false;
      m.useLighting = false;
      m.useFog = false;
      m.cull = pc.CULLFACE_NONE;
      m.update();
      const mb = new MeshBuilder({ uv: true });
      const n = [0, 0, 1];
      const i = mb.vertex([-1, -1, 0], n, [0, 0]); mb.vertex([1, -1, 0], n, [1, 0]); mb.vertex([1, 1, 0], n, [1, 1]); mb.vertex([-1, 1, 0], n, [0, 1]);
      mb.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
      this._sunDisc = new pc.Entity('SkySun');
      this._sunDisc.addComponent('render', { meshInstances: [new pc.MeshInstance(toMesh(this.app.graphicsDevice, mb), m)], castShadows: false, receiveShadows: false });
      this._sky.addChild(this._sunDisc);
      this._sunDiscMat = m;
    }
    this._sunDisc.enabled = !!sun;
    if (sun) {
      // a little inside the dome, facing the camera: the bright core about 1° across, its glow 5°
      this._sunDisc.setLocalPosition(sun[0] * 0.97, sun[1] * 0.97, sun[2] * 0.97);
      const s = Math.tan(2.6 * Math.PI / 180) * 0.97;
      this._sunDisc.setLocalScale(s, s, s);
      this._sunDisc.lookAt(camPos);
    }
  }

  onPropertyChanged(name) {
    if (name === 'showScenery' || name === 'waterReflections' || name === 'showCarrier') this._applyDestination();
    if (name === 'destination') this._goTo(destinationByTitle(this.destination).id);
    if (name === 'clouds' || name === 'cloudBaseFt') this._applyClouds();
    if ((name === 'skylineYear' || name === 'cityDetail') && this.city) {
      this.meigs.setSkylineYear(this.skylineYear);
      this.city.build(this._cityOptions());
    }
    if (name === 'easyMode') this._setEasy(this.easyMode);
    if (name === 'aircraft') this._switchAircraft(profileByTitle(this.aircraft));
    if (name === 'introOnLoad' && this.introOnLoad && !this._flying) this._filmPending = true;
    if (name === 'showPanel') { this._panelVisible = this.showPanel; this.hud.setFlying(this._flying, this._panelVisible); }
    if (['windKt', 'windFromDeg', 'qnhInHg', 'oatC'].includes(name)) this.ac.weather = this._weather();
    if (name === 'fuelLiters' || name === 'startRunway' || name === 'engineRunningAtStart') { if (!this._flying) this._resetToRunway(); }
    if (name === 'isEnabled' && !this.isEnabled) this._exit();
  }

  onEntityMoved() { this._placeWorldRoot(); }

  destroy() {
    this._destroyed = true;
    if (this._menu) { this._menu.destroy(); this._menu = null; }
    this._shadowFit?.destroy();
    this.app.googleTilesHold = false;
    // Google's globe back where the space has it (Meigs), the flattening gone
    if (this._dest !== 'meigs') { this.world = this.meigs; this._publishOrigin(); }
    this.app.fire('googletiles:flatten-region-clear', `extra300-flatten-${this.entity.getGuid()}`);
    for (const f of Object.values(this._flatMasks)) f.texture.destroy();
    for (const t of Object.values(this._terrains)) t.destroy();
    for (const r of Object.values(this._runways)) r.destroy();
    this.cloudLayer?.destroy();
    this.app.fire('googletiles:receive-shadows', 0);
    this.app.fire('googletiles:patch-region-clear', `extra300-meigs-${this.entity.getGuid()}`);
    this.app.fire('googletiles:water-mask-clear', `extra300-meigs-${this.entity.getGuid()}`);
    for (const ssr of Object.values(this._ssrs)) ssr.destroy();
    this._ssrs = {};
    for (const w of Object.values(this._waters)) if (w) { w.near.texture.destroy(); w.far.texture.destroy(); }
    this._waters = {};
    this._exit();
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('keyup', this._onKeyUp, true);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    this.app.graphicsDevice.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.app.graphicsDevice.canvas.removeEventListener('wheel', this._onWheel);
    this.app.off('prerender', this._onPrerender);
    if (typeof this._unsubClick === 'function') this._unsubClick();
    this.hud.destroy();
    this.sound.stop();
    this.visual.destroy();
    this.scenery.destroy();
    this.city?.destroy();
    this.carrierVisual.destroy();
    this.lights.destroy();
    this.lasers.destroy();
    this.display?.destroy();
    this._sky?.destroy();
    this._sunDiscMat?.destroy();
    this._worldRoot.destroy();
    disposeMaterials();
    disposeGroundTextures();
    setReflectionCube(null);
    this._probe?.destroy();
    disposeFinishes();
  }
}
