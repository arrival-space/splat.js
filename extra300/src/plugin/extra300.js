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
import { CLOUD_PRESETS, CloudLayer, cloudsAt } from './clouds.js';
import { tileGroundY } from './tileGround.js';
import { buildCarrier } from '../world/carrier.js';
import { Arrestor } from '../sim/arrestor.js';
import { CarrierVisual } from './carrierVisual.js';
import { Lasers } from './lasers.js';
import { RunwayVisual } from './runwayVisual.js';
import { CockpitDisplay } from './cockpitDisplay.js';
import { discTexture, LightsVisual } from './lightsVisual.js';
import { CameraRig } from '../render/cameraRig.js';
import { fromNE, MeshBuilder } from '../render/geometry.js';
import { AircraftColliders } from './aircraftColliders.js';
import { AircraftVisual } from './aircraftVisual.js';
import { AIRCRAFT_OPTIONS, PROFILES } from './profiles.js';
import { aircraftBase, airportBase, flightRegistry, listed } from './flightRegistry.js';
import { plainAircraft, tunedProfile } from './tuning.js';
import { AIRFIELD_CREDIT, airfieldWorld, geocode, loadAirfields, nearestAirfields, searchAirfields } from '../world/airfields.js';
import { PlaneShadowFit } from './planeShadowFit.js';
import { ReflectionProbe } from './reflectionProbe.js';
import { StartMenu } from './startMenu.js';
import { SceneryVisual } from './sceneryVisual.js';
import { Hud } from './hud.js';
import { disposeMaterials, toMesh } from './pcMesh.js';
import { disposeGroundTextures } from './groundMaterial.js';
import { disposeFinishes, glassReflectionMaterial, mirrorMaterial, paintMaterial, setReflectionCube } from './finishes.js';
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
  meigs: { id: 'meigs', title: 'Chicago Meigs (KCGX)', short: 'Chicago', runways: ['36', '18'], credit: 'Map data © OpenStreetMap contributors (ODbL)' },
  lowi: { id: 'lowi', title: 'Innsbruck (LOWI)', short: 'Innsbruck', runways: ['26', '08'], credit: 'Map data © OpenStreetMap contributors (ODbL) · Elevation: Terrarium (Mapzen, AWS Open Data)' },
  krnt: { id: 'krnt', title: 'Renton, Boeing 737 field (KRNT)', short: 'Renton', runways: ['34', '16'], credit: 'Map data © OpenStreetMap contributors (ODbL) · Elevation: Terrarium (Mapzen, AWS Open Data)' },
};
// the airports beyond Meigs: their worlds, made when first flown to
const AIRPORTS = {
  lowi: async () => { const dem = await inflateLowiDem(); return { dem, world: buildInnsbruck(dem) }; },
  krnt: async () => { const dem = await inflateRentonDem(); return { dem, world: buildRenton(dem) }; },
};
/** The destination after this one, as the ✈ button goes round them. */
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
/** ?airport= naming an airfield found by its code (not one of the three carried): the code, else null. */
const fieldFromAddress = (a) => (/^[a-z0-9]{3,4}$/i.test(a) && !/^(lowi|inn|krnt|rnt|meigs|kcgx|cgx)$/i.test(a) ? a.toUpperCase() : null);
const aircraftFromAddress = (a) => (/f-?15/i.test(a) ? 'f15c' : /x-?wing/i.test(a) ? 'xwing' : /777|b7|boeing/i.test(a) ? 'b777' : 'extra300l');


export class Extra300 extends ArrivalScript {
  static scriptName = 'extra300Meigs';
  static INTRO_LENGTH = INTRO_LENGTH;   // for tests/e2e/record-intro.cjs (the Extra's; vibe.profile.intro.length)

  isEnabled = true;
  aircraft = 'Extra 300L';
  startRunway = '36';
  showCarrier = true;
  destination = 'Innsbruck (LOWI)';
  clouds = 'Scattered';
  cloudBaseFt = 4500;
  waterReflections = true;
  engineRunningAtStart = false;   // off: the first throttle starts it (update)
  showPanel = true;
  showScenery = true;
  fuelLiters = 60;
  windKt = 0;
  windFromDeg = 0;
  qnhInHg = 29.92;
  oatC = 15;
  easyMode = true;            // the default: stall-proof, the attitude held hands off (the top bar's switch, or L)
  autoTrim = true;            // normal mode: the elevator trimmed for the attitude the stick was let go at
  playIntro = true;
  introAtStart = true;
  introOnLoad = false;
  startMenu = false;
  registryWait = 3;
  debugSpheres = false;
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
    waterReflections: { title: 'Reflections in the lake (screen-space: the airplane, the carrier)' },
    engineRunningAtStart: { title: 'Engine running at start (off: the first throttle cranks it with the starter)' },
    showPanel: { title: 'Instrument panel' },
    showScenery: { title: 'Meigs scenery (the field, its tower and lights)' },
    fuelLiters: { title: 'Fuel, centre tank (L) — the Extra (the F-15 carries ~64 % internal)', min: 5, max: 60, step: 1 },
    clouds: { title: 'Clouds (volumetric, drifting with the wind)', options: Object.keys(CLOUD_PRESETS) },
    cloudBaseFt: { title: 'Cloud base (ft above the field)', min: 500, max: 15000, step: 100 },
    windKt: { title: 'Wind (kt)', min: 0, max: 40, step: 1 },
    windFromDeg: { title: 'Wind from (°true)', min: 0, max: 359, step: 1 },
    qnhInHg: { title: 'QNH (inHg)', min: 28.5, max: 31, step: 0.01 },
    oatC: { title: 'Sea-level temperature (°C)', min: -30, max: 45, step: 1 },
    easyMode: { title: 'Easy mode at start (no stalls, torque handled; L in flight)' },
    autoTrim: { title: 'Auto trim (normal mode; easy mode always holds the attitude)' },
    playIntro: { title: 'Intro film on first boarding (skippable)' },
    introAtStart: { title: 'Intro film at load, round the parked airplane while Google\'s tiles stream in (then on foot beside it)' },
    debugSpheres: { title: 'Debug: three spheres over the airplane (its white paint, a mirror, clear glass), lit and reflecting as it is (or ?spheres on the address)' },
    registryWait: { title: 'At load: wait this long (s) for the airport and airplane vibes before starting', min: 0, max: 15 },
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
    let askedPlace = null, askedAircraft = null, askedField = null;
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('airport')) {
        askedField = fieldFromAddress(q.get('airport'));
        if (!askedField) askedPlace = placeFromAddress(q.get('airport'));
      }
      if (q.get('aircraft')) askedAircraft = aircraftFromAddress(q.get('aircraft'));
    } catch { /* no address to read */ }
    this._sky = null;

    // the airplane until the start picks one (plugin/flightRegistry.js: the space's airplane vibes)
    this.profile = tunedProfile(plainAircraft(askedAircraft || aircraftBase(this.aircraft)));
    this.mapper = new ControlMapper({ easy: this.easyMode, autoTrim: this.autoTrim });
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
    // and its paint reflects the world round it (a small cube rendered from it, two faces a frame)
    this._probe = new ReflectionProbe(this.app, this.isMobile ? { size: 128, every: 2, faces: 1 } : {});   // 256 px faces, the whole cube every 3 frames (a phone: 128 px, every 12)

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
    this._onPointerDown = (e) => { if (this._flying) this.sound?.start(); this._mouse.dragging = true; this._mouse.lastX = e.clientX; this._mouse.lastY = e.clientY; };
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

    // the top bar's dropdowns: which airplane, where to fly
    // (what the space's airport and airplane vibes list, as it is when opened)
    this.hud.setMenu('aircraft', () => this._planeEntries().map((e) => ({ id: e.id, title: e.title })),
      () => this._planeId, (id) => this._pickAircraft(id));
    this.hud.setMenu('place', () => this._placeEntries().map((e) => ({ id: e.id, title: e.title })),
      () => this._placeId, (id) => this._goTo(id), {
        // any airfield on Earth, by its code, its name, its town, or a place near it (world/airfields.js)
        placeholder: 'Fly to… a town, an airfield, a code',
        find: (q, more) => this._findAirfields(q, more),
        focus: () => { if (!this._flying) this.lockKeyboard(); },
        blur: () => { if (!this._flying) this.unlockKeyboard(); },
      });
    this._found = new Map();   // airfields found by name this visit: listed after the space's airports
    // the weather (no wind: that stays the space's setting)
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hhmm = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
    this.hud.setSliders('weather', [
      { key: 'coverage', label: 'Cloud cover', min: 0, max: 95, step: 1, value: () => Math.round(this._wx('coverage') * 100), format: (v) => (v < 2 ? 'Clear' : `${v} %`) },
      { key: 'baseFt', label: 'Cloud base', min: 1000, max: 12000, step: 100, value: () => this._wx('baseFt'), format: (v) => `${v.toLocaleString('en-US')} ft` },
      { key: 'hour', label: 'Time of day', min: 5, max: 21, step: 0.25, value: () => this._wx('hour'), format: hhmm },
      { key: 'month', label: 'Season', min: 1, max: 12, step: 1, value: () => this._wx('month'), format: (v) => MONTHS[v - 1] },
      { key: 'tempC', label: 'Temperature', min: -20, max: 40, step: 1, value: () => this._wx('tempC'), format: (v) => `${v} °C` },
    ], (key, v) => this._setWeather(key, v));
    // an airport or airplane vibe tuned, added or deleted: taken on as it is
    this._onRegistry = (kind) => this._registryChanged(kind);
    this.app.on('flightsim:changed', this._onRegistry);
    this.hud.easyButton.onclick = (ev) => { ev.stopPropagation(); this._action('easy'); };
    this.hud.restartButton.onclick = (ev) => { ev.stopPropagation(); this._action('reset'); };
    // the panel's throttle lever, dragged
    this.hud.onThrottle = (t) => { if (this._flying && !this._intro) { this.mapper.throttle = t; this.sound?.start(); } };
    // its lamps that are switches too (setLampButtons, in _buildAircraft), clicked
    this.hud.onLamp = (key) => {
      if (!this._flying || this._intro) return;
      switch (key) {
        case 'ENGINE OFF': this._engineOff(); break;
        case 'PARK BRK': this._action('parkingBrake'); break;
        case 'PAUSED': this._action('pause'); break;
        case 'GEAR': this._action('gear'); break;
        case 'HOOK': this._action('hook'); break;
        case 'SB': case 'FLAP': this._action('speedbrake'); break;   // (the X-wing's lamp there: its S-foils, on the same key)
        default: break;
      }
    };
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

    // nothing heavy loads (the airport, Google's tiles: held) until the start is picked,
    // once the space's airport and airplane vibes are there to pick from
    this._worldRoot.enabled = false;
    this.app.googleTilesHold = true;   // the tiles vibe streams nothing meanwhile (scripts/tilesWater.mjs)
    this._awaitRegistry().then(() => {
      if (this._destroyed) return;
      const places = this._placeEntries(), planes = this._planeEntries();
      const place = this._pick(places, askedPlace, airportBase(this.destination));
      const plane = this._pick(planes, askedAircraft, aircraftBase(this.aircraft));
      // the start menu, when it's on: the address naming both, or film mode, skips it
      if (this.startMenu && !this._filmPending && !(askedPlace && askedAircraft)) {
        this.hud.placeButton.style.display = 'none';
        this._menu = new StartMenu((tag, opts) => this.createUI(tag, opts),
          places.map((e) => ({ id: e.id, title: e.title, blurb: PLACE_BLURBS[e.base] })),
          planes.map((e) => ({ id: e.id, title: e.title, blurb: AIRCRAFT_BLURBS[e.base] || '' })),
          { place: askedPlace && place.id, aircraft: askedAircraft && plane.id, isMobile: this.isMobile, onStart: (pl, ac) => this._start(pl, ac) });
        return;
      }
      // the airport and the airplane, parked with its engine off; the visitor arrives on foot to walk
      // to it (E boards). An airfield the address names by its code (a reload where one was found):
      // looked up first, the space's own start if it can't be
      if (!askedField) { this._start(place.id, plane.id); return; }
      loadAirfields().then((fields) => {
        const a = searchAirfields(fields, askedField, 1).find((f) => f.codes.includes(askedField.toLowerCase()));
        if (!a) throw new Error(`no airfield ${askedField}`);
        return this._start(this._foundEntry(a).id, plane.id);
      }).catch((e) => { console.warn('[extra300]', e.message); this._start(place.id, plane.id); });
    });
  }

  // ── the airports and airplanes in the space (plugin/flightRegistry.js) ───────
  /** The airports listed: the space's airport vibes, or (none there) the three as they are. */
  _placeEntries() {
    const l = listed(this.app, 'airports');
    const own = l.length ? l : Object.keys(DESTINATIONS).map((base, i) => ({
      id: base, base, title: DESTINATIONS[base].title, runwayEnd: null, sun: null, clouds: null, startHere: false, order: i,
    }));
    return [...own, ...(this._found?.values() || [])];
  }

  /** A place's own words (its name, short name, runway ends, credit): the airports carried, or an airfield found. */
  _info(base) {
    if (DESTINATIONS[base]) return DESTINATIONS[base];
    const e = this._found.get(base), a = e.airfield, r = a.runways[0];
    return { id: base, title: e.title, short: a.ident, runways: [r.le, r.he], credit: AIRFIELD_CREDIT };
  }

  /**
   * The ✈ box: airfields by code, name or town as typed; `more` (a pause in the typing, or Enter) with
   * few of those, the place looked up (Nominatim) and the airfields nearest it.
   */
  async _findAirfields(q, more) {
    const fields = await loadAirfields();
    const row = (a, sub) => ({
      title: `${a.ident} · ${a.name}`,
      sub: sub || `${[a.town, a.country].filter(Boolean).join(', ')} · ${Math.round(a.runways[0].lengthM)} m${a.runways[0].paved ? '' : ', grass'}`,
      go: () => this._flyToAirfield(a),
    });
    const hits = searchAirfields(fields, q, 6);
    const rows = hits.map((a) => row(a));
    if (more && hits.length < 3) {
      const p = await geocode(q).catch(() => null);
      if (p) {
        const where = p.name.split(',')[0];
        for (const a of nearestAirfields(fields, p.lat, p.lon, 5)) {
          if (!hits.includes(a)) rows.push(row(a, `${(a.distanceM / 1000).toFixed(0)} km from ${where} · ${Math.round(a.runways[0].lengthM)} m${a.runways[0].paved ? '' : ', grass'}`));
        }
      }
    }
    return rows;
  }

  /** An airfield found by name: listed for this visit, and gone to (the airplane on its longest runway). */
  _flyToAirfield(a) { this._goTo(this._foundEntry(a).id); }

  /** A found airfield as a place to fly from (listed after the space's airports). */
  _foundEntry(a) {
    const id = `af:${a.ident}`;
    if (!this._found.has(id)) {
      this._found.set(id, { id, base: id, title: `${a.ident} ${a.name}`, airfield: a, runwayEnd: null, sun: null, clouds: null, startHere: false, order: 1000 + this._found.size });
    }
    return this._found.get(id);
  }

  /** The place on the address (?airport=), so a reload comes back here: the code of a found airfield, else the airport's. */
  _addressPlace(base) {
    try {
      const u = new URL(location.href), code = base.startsWith('af:') ? base.slice(3) : base;
      if (u.searchParams.get('airport') === code) return;
      u.searchParams.set('airport', code);
      history.replaceState(history.state, '', u);
    } catch { /* no address to write */ }
  }

  /** The airplanes listed: the space's airplane vibes, or (none there) the four as they are. */
  _planeEntries() {
    const l = listed(this.app, 'aircraft');
    return l.length ? l : Object.keys(PROFILES).map(plainAircraft);
  }

  _placeEntry(id) { return this._placeEntries().find((e) => e.id === id) || null; }
  _planeEntry(id) { return this._planeEntries().find((e) => e.id === id) || null; }

  /** Where we are, as its vibe has it now (its runway end, sun, clouds). */
  get _placeCfg() { return this._placeEntry(this._placeId); }

  /** The one to start with: the address's, one marked to start, the setting's, or the first. */
  _pick(entries, asked, settingBase) {
    return (asked && entries.find((e) => e.base === asked)) || entries.find((e) => e.startHere)
      || entries.find((e) => e.base === settingBase) || entries[0];
  }

  /** At load: the airport and airplane vibes register as they load (after us, perhaps); wait for them a little. */
  _awaitRegistry() {
    const reg = flightRegistry(this.app);
    const ready = () => reg.airports.size > 0 && reg.aircraft.size > 0;
    if (!(this.registryWait > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      let settle = null;
      const done = () => { clearTimeout(limit); clearTimeout(settle); this.app.off('flightsim:changed', check); resolve(); };
      // all there: a moment more for the rest of a space's vibes to come in, then go
      const check = () => { if (ready()) { clearTimeout(settle); settle = setTimeout(done, 300); } };
      const limit = setTimeout(done, this.registryWait * 1000);
      this.app.on('flightsim:changed', check);
      check();
    });
  }

  /** The airplane an entry describes, tuned (plugin/tuning.js). */
  _pickAircraft(id) {
    const e = this._planeEntry(id);
    if (!e) return;
    this._planeId = id;
    this._switchAircraft(tunedProfile(e));
  }

  /** An airport or airplane vibe changed, came or went. Parked, it's taken on now; flying, on landing (leaving the airplane). */
  _registryChanged(kind) {
    if (!this._started) return;   // the start picks from what is there by then
    if (kind === 'aircraft') {
      const e = this._planeEntry(this._planeId);
      if (!e) {
        // ours was deleted (or the plain list gave way to the space's vibes): the first one
        const f = this._planeEntries()[0];
        if (f && !this._flying) this._pickAircraft(f.id);
        else this._retune = true;
        return;
      }
      if (tunedProfile(e) === this.profile) return;
      if (this._flying) this._retune = true;
      else this._switchAircraft(tunedProfile(e));
      return;
    }
    const e = this._placeCfg;
    if (!e) {
      const f = this._placeEntries()[0];
      if (f && !this._flying) this._goTo(f.id);
      return;
    }
    // its sun and clouds at once; its runway end once parked
    this._applyClouds();
    this._publishOrigin();
    if (!this._flying) this._resetToRunway();
  }

  /** The start (the menu's choice, or the settings'): the airplane, the place loaded, Google's tiles let go, the visitor on foot. */
  async _start(placeId, planeId) {
    this._menu?.setStatus(`Loading ${this._placeEntry(placeId)?.title || ''}…`);
    this._pickAircraft(planeId);
    await this._goTo(placeId);
    if (this._dest === 'meigs') this._ensureLake();   // also when the airport couldn't be loaded
    this._started = true;
    if (this._destroyed) return;
    this._menu?.destroy();
    this._menu = null;
    this._worldRoot.enabled = true;
    this.hud.placeButton.style.display = 'block';
    this.app.googleTilesHold = false;
    // the visitor's avatar, to walk round the airplane (not a free camera); film mode boards by itself
    if (!this._flying && !this._filmPending) ArrivalSpace.setCameraMode?.('third');
    // the airplane's film while the tiles stream in, the visitor on foot beside it after
    if (this.introAtStart && !this._flying && !this._filmPending) this._startLoadIntro();
  }

  /** The intro film as the first thing seen: the engine left off, the airplane left parked, the visitor on foot at its end. */
  _startLoadIntro() {
    this._loadIntro = true;
    this._introPlayed = false;
    this._enter();
    if (!this._intro) this._loadIntro = false;   // couldn't board (another vehicle has the visitor)
  }

  /** Lake Michigan's shore (the land/water mask), read the first time Meigs is where we are. */
  _ensureLake() { this._lakeLoad ??= this._loadLake(); }

  // ── destinations ─────────────────────────────────────────────────────────
  get _place() { return this._info(this._dest); }

  /** Start on the runway's other end: the airport vibe's choice, or (the plain list) the setting's. */
  get _reverse() {
    const e = this._placeCfg;
    return e && e.runwayEnd != null ? e.runwayEnd === 1 : this.startRunway === '18';
  }

  /** The runway the airplane starts on (and goes back to). */
  get _runwayName() { return this._place.runways[this._reverse ? 1 : 0]; }

  /** The ✈ button's word for an airport: its own short name, or the name its vibe gives it. */
  _shortOf(e) {
    if (!e) return this._info(this._dest).short;
    const own = this._info(e.base);
    return e.title === own.title ? own.short : e.title;
  }

  /**
   * Fly somewhere else: the world under the airplane (its ground, its height, its runway), Google's
   * globe moved under the space, the Meigs scenery off or on, and the airplane on the new runway,
   * a pilot already aboard with it.
   */
  async _goTo(id) {
    const entry = this._placeEntry(id);
    if (!entry || id === this._placeId || this._going) return;
    const base = entry.base;
    this._going = true;
    this.hud.setPlace(this._shortOf(entry), true);
    try {
      // the airports carried, or an airfield found by name (its terrain fetched now)
      const load = AIRPORTS[base] || (entry.airfield ? () => airfieldWorld(entry.airfield) : null);
      if (load && !this._airports[base]) this._airports[base] = await load();
    } catch (e) {
      console.warn(`[extra300] ${entry.title} unavailable:`, e);
      this.hud.flash(`${entry.title} could not be loaded`, 3);
      this._going = false;
      this.hud.setPlace(this._shortOf(this._placeCfg));
      return;
    }
    this._going = false;
    if (this._destroyed) return;
    const flying = this._flying;
    if (this._intro) this._endIntro();
    if (this._demo) this._stopDemo('Demo ended');
    if (flying) { this._attach?.detach?.(); this._attach = null; }
    this._placeId = id;
    this._dest = base;
    this._addressPlace(base);
    if (DESTINATIONS[base]) this.destination = DESTINATIONS[base].title;
    if (base === 'meigs') this._ensureLake();
    this.world = base === 'meigs' ? this.meigs : this._airports[base].world;
    this._applyClouds();
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
    this.hud.flash(`${entry.title}: ${this.profile.title} on runway ${this._runwayName}`, 3);
  }

  /** What belongs to the place we're at: on, the rest off; Google's tiles told where we are. */
  _applyDestination(moved = false) {
    const meigs = this._dest === 'meigs';
    this.hud.setPlace(this._shortOf(this._placeCfg));
    this.hud.setCredit(this._place.credit);
    this.scenery.visible = meigs && this.showScenery;
    this.lights.visible = meigs && this.showScenery;
    this.carrierVisual.visible = meigs && this.showCarrier;
    this.meigs.attachCarrier(meigs && this.showCarrier ? this.carrier : null);
    for (const [id, ssr] of Object.entries(this._ssrs)) ssr.visible = id === this._dest && this.waterReflections;
    // our own runway over the photograph of it (the photo cut away beneath, see _publishCarve)
    const ap = this._airports[this._dest];
    if (ap && !this._runways[this._dest] && ap.world.runway.layout) this._runways[this._dest] = new RunwayVisual(this.app, this._worldRoot, ap.world.runway, this._dest);
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
    const tick = (this._probeAt = (this._probeAt || 0) + 1);
    if (on && (this._probeRoot !== root || tick % 60 === 0)) {
      this._probeRoot = root;
      const player = ArrivalSpace.getPlayer?.();
      // out of the cube: the airplane and its pilot, and the skies drawn for the eye (Google's
      // atmosphere shell, our own dome and sun): the cube has its own sky
      const gsky = this.app.root.findByName('google-tiles-atmosphere-sky');
      const mis = [root, player, gsky, this._sky].filter(Boolean).flatMap((e) => e.findComponents('render').flatMap((r) => r.meshInstances));
      for (const mi of mis) mi.cull = true;   // (an unculled instance never asks its isVisibleFunc)
      this._probe.hide(mis);
    }
    const L = this._sunLight || this.app.root.findComponents('light').find((l) => l.type === 'directional' && l.enabled);
    const sun = L ? [L.entity.up.x, L.entity.up.y, L.entity.up.z] : null;
    this._spheresTick(root);
    const whole = this._probe.update(on ? root.getPosition() : null, on, this._ws, sun);
    setReflectionCube(whole ? this._probe.texture : null);
    // and its light on the airplane, about once a second
    if (whole && tick % 60 === 30) {
      this._probe.irradiance().then((sh) => {
        if (!sh || this._destroyed || !this.visual) return;
        const mats = new Set(this.visual.root.findComponents('render').flatMap((r) => r.meshInstances.map((mi) => mi.material)));
        for (const m of mats) {
          if (!m.useLighting) continue;
          m.ambientSH = sh;
          m.update();
        }
      }).catch(() => { /* no readback here: the room's light stays */ });
    }
  }

  /**
   * Debug: three balls a couple of metres over the airplane, riding with it: its white paint (the very
   * material, so lit by the probe as it is), a perfect mirror, and clear glass with acrylic's own
   * Fresnel (4 % head on). They're the airplane's for the probe: kept out of its cube.
   */
  _spheresTick(root) {
    let want = this.debugSpheres;
    try { want ||= new URLSearchParams(location.search).has('spheres'); } catch { /* no address */ }
    if (!want || !root) { if (this._spheres) { this._spheres.destroy(); this._spheres = null; } return; }
    if (this._spheres?.parent === root) return;
    this._spheres?.destroy();
    const dev = this.app.graphicsDevice;
    const ws = this._ws, ps = root.getWorldTransform().getScale().x || 1;
    this._spheres = new pc.Entity('DebugSpheres');
    root.addChild(this._spheres);
    const up = this.profile.spec.wing.span * 0.2 + 2;
    [paintMaterial(dev, '#f3f1ec'), mirrorMaterial(dev), null].forEach((mat, i) => {
      const e = new pc.Entity(['debugWhite', 'debugMirror', 'debugGlass'][i]);
      e.addComponent('render', { type: 'sphere', material: mat || glassReflectionMaterial(dev, 0.04), castShadows: false });
      e.setLocalPosition(((i - 1) * 1.6 * ws) / ps, (up * ws) / ps, 0);
      e.setLocalScale(ws / ps, ws / ps, ws / ps);
      this._spheres.addChild(e);
    });
    this._probeRoot = null;   // hidden from the cube with the airplane, next tick
  }

  /** Google's globe under the place: its start on the runway where the vibe stands. */
  _publishOrigin() {
    const s = this.world.startPosition();
    const [latitude, longitude] = this.world.frame.toLatLon(s.n, s.e);
    this.app.fire('googletiles:set-origin', {
      // (a found airfield's Google ground lined up with its runway: _alignToGoogle)
      latitude, longitude, groundAltitude: this.world.elevation + this.world.data.geoidM + (this._altFix?.[this._dest] || 0),
      sun: this._sunNow(longitude),
    });
  }

  /**
   * A found airfield (world/airfields.js) has its height from a table and the geoid, a few metres off
   * Google's photogrammetry (and its runway flattened into a trench, or left on a step, when they
   * differ): once Google's fine tiles are in under the runway, their ground along it is read off
   * their meshes (before any flattening) and the globe moved by the difference, the median of a few
   * points. Once within 30 cm it's done; each point is read in a frame of its own.
   */
  async _alignToGoogle() {
    const dest = this._dest;
    if (!dest.startsWith('af:') || !this._google || this._aligning || this._aligned?.[dest]) return;
    const tiles = this._tilesVibe();
    if (!tiles) return;
    this._aligning = true;
    try {
      const rw = this.world.runway, ws = this._ws, offs = [];
      for (let k = 0; k < 7; k++) {
        if (this._dest !== dest || this._destroyed) return;
        const al = (k / 6 - 0.5) * rw.length * 0.8;
        const l = fromNE(rw.centre[0] + rw.dir[0] * al, rw.centre[1] + rw.dir[1] * al, 0);
        const o = this._worldRoot.getPosition();
        // tiles up to 600 m across: their ground within a metre or so, the median of seven points
        const hit = tileGroundY(tiles, o.x + l[0] * ws, o.z + l[2] * ws, o.y + 400 * ws, o.y - 400 * ws, (this._alignMaxHalf ?? 300) * ws);
        if (hit) offs.push((hit.y - o.y) / ws);
        await new Promise((r) => setTimeout(r, 0));
      }
      this._alignLast = offs;          // (what was read, for a look from the console)
      if (offs.length < 4) return;   // not enough fine tiles yet: the next tick
      offs.sort((a, b) => a - b);
      const off = offs[offs.length >> 1];
      this._altFix ||= {};
      const tries = this._aligns ||= {};
      tries[dest] = (tries[dest] || 0) + 1;
      if (Math.abs(off) < 0.3 || tries[dest] > 6 || Math.abs(off) > 80) {
        (this._aligned ||= {})[dest] = true;
        return;
      }
      // Google's ground `off` above our runway: raised on the globe by as much, it comes down to it
      this._altFix[dest] = (this._altFix[dest] || 0) + off;
      this._publishOrigin();
    } finally {
      this._aligning = false;
    }
  }

  // ── the weather menu (the top bar's Weather): what the visitor set, else the place's own ──
  /** The sun: the visitor's time of day and season, else the airport vibe's, the place's own (Renton's imagery), else the space's. */
  _sunNow(lon) {
    const own = this._placeCfg?.sun || this.world.data.sun, u = this._wxUser || {};
    if (u.hour == null && u.month == null) return own;
    const doy = u.month != null ? Math.round((u.month - 0.5) * 30.44) : own?.dayOfYear;
    return { timeUTC: (((this._wx('hour') - lon / 15) % 24) + 24) % 24, dayOfYear: doy };
  }

  /** The place's longitude (its runway start). */
  _lon() { const s = this.world.startPosition(); return this.world.frame.toLatLon(s.n, s.e)[1]; }

  /** The Google tiles vibe (its sun: the space's time of day, where the place sets none). */
  _tilesVibe() {
    if (this._tiles?.entity && !this._tiles.entity._destroyed) return this._tiles;
    for (const c of this.app.root.findComponents('script')) for (const sc of c.scripts || []) if ('groundAltitude' in sc && 'timeUTC' in sc) return (this._tiles = sc);
    return null;
  }

  /** One weather value as it is now: the visitor's, else the place's (cloud cover 15 % under its preset). */
  _wx(key) {
    const u = this._wxUser?.[key];
    if (u != null) return u;
    const own = this._placeCfg?.sun || this.world.data.sun, tiles = this._tilesVibe();
    switch (key) {
      case 'coverage': return 0.85 * (CLOUD_PRESETS[this._placeCfg?.clouds || this.clouds]?.coverage || 0);
      case 'baseFt': return this.cloudBaseFt;
      case 'hour': {
        const utc = own?.timeUTC ?? tiles?.timeUTC;
        return utc == null ? 13.5 : Math.round(((((utc + this._lon() / 15) % 24) + 24) % 24) * 4) / 4;
      }
      case 'month': {
        const doy = own?.dayOfYear ?? tiles?.dayOfYear;
        return doy == null ? 6 : Math.min(12, Math.floor(doy / 30.44) + 1);
      }
      case 'tempC': return this.oatC;
      default: return null;
    }
  }

  /** A weather slider moved: the clouds, the sun or the air taken on at once. */
  _setWeather(key, v) {
    (this._wxUser ||= {})[key] = key === 'coverage' ? v / 100 : v;
    if (key === 'coverage' || key === 'baseFt') this._applyClouds();
    else if (key === 'hour' || key === 'month') this._publishOrigin();
    else if (key === 'tempC') this.ac.weather = this._weather();
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
  /** ENGINE OFF, clicked: the engine stopped, the throttle closed; raising it cranks it again. */
  _engineOff() {
    if (!this.ac.engine.running) return;
    this.ac.setEngineRunning(false);
    this.mapper.throttle = 0;
    this.ac.controls.starter = false;
    this._autoStarter = true;
    this._crankT = 0;
    this.hud.flash('Engine off · raise the throttle to start it', 2.5);
  }

  /** The panel's lamps this airplane can switch by a click: its gear if it retracts, its hook, its speed brake … */
  _lampButtons() {
    const sp = this.ac.spec, t = {
      'ENGINE OFF': 'Switch the engine off (raise the throttle to start it again)',
      'PARK BRK': 'Parking brake on / off (,)',
      PAUSED: 'Pause (P)',
    };
    if (this.ac.retractable) t.GEAR = 'Gear up / down (G)';
    if (sp.hook) t.HOOK = 'Hook up / down (/)';
    if (sp.sfoils) t.FLAP = 'S-foils open / closed (J)';
    else if (this.ac.jet && sp.aero?.body?.speedbrakeDragArea) t.SB = 'Speed brake out / in (J)';
    this.hud.setLampButtons(t);
  }

  _buildAircraft(profile) {
    this.profile = profile;
    const spec = profile.spec;
    this.ac = new Aircraft(spec, {
      ground: this.world.ground,
      datumMsl: this.world.elevation,
      load: spec.engine ? { fuelCenterL: profile.fuelL ?? this.fuelLiters } : {},
      weather: this._weather(),
    });
    this.instruments = new Instruments(spec, { kollsman: this.qnhInHg * INHG });
    this._lampButtons();
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
    const parts = profile.buildModel();
    this.visual = new AircraftVisual(this.app, this._worldRoot, parts, profile.title);
    // solid to the avatars walking round it while it is parked (plugin/aircraftColliders.js)
    this._colliders = new AircraftColliders(this.app, this.visual.root, parts, this._ws);
    this._colliders.enabled = !this._flying;
    if (profile.cockpitDisplay) this.display = new CockpitDisplay(this.app, this.visual.root, this.world);
    this.sound?.stop();
    this.sound = new profile.Sound();
    this.hud.setProfile(profile);
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
    this.aircraft = PROFILES[profile.id].title;   // (the setting: the base airplane)
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

  /** Offer the avatar animation catalog as the pilot-pose choices in the editor (as the vehicle demo does). */
  async _loadPoses() {
    try {
      const cfg = await ArrivalSpace.getAvatarConfig?.();
      const list = await ArrivalSpace.getAvatarAnimationCatalog?.(cfg?.gender === 'female' ? 'female' : 'male');
      if (Array.isArray(list) && list.length) this.setParamOptions?.('seatAnimation', list, false);
    } catch { /* the default pose still works */ }
  }

  /** Decode the baked land/water mask round Meigs: the gear's land and lake, Google's water shading, our reflections. */
  async _loadLake() {
    try {
      const osm = await inflateOsm(CHICAGO_OSM);
      if (this._destroyed) return;
      this.meigs.attachOsm(osm);
      this._publishWater();
    } catch (e) {
      console.warn('[extra300] the lake\'s mask unavailable, the shore as drawn by hand:', e);
    }
  }

  // ── Google Photorealistic 3D Tiles (the "Google 3D Tiles" vibe in the same space) ──────
  // Its tiles are the city, the land and the lake; we keep only Meigs itself, cut out of the tiles.
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
      this._alignToGoogle();
      // with no API key yet the tiles vibe lays a 50 km green disc at the runway's height, over our lake
      const ph = this.app.root.findByName('google-tiles-placeholder-ground');
      if (ph?.enabled) ph.enabled = false;
    }
  }

  _setGoogle(on) {
    this._google = on;
    this.scenery.setGoogle(on);
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

  _weather() {
    const from = this.windFromDeg * DEG;
    const v = this.windKt * KT;
    // air moves *toward* from+180°: NED components
    return { qnh: this.qnhInHg * INHG, dT: (this._wxUser?.tempC ?? this.oatC) - 15, wind: [-Math.cos(from) * v, -Math.sin(from) * v, 0] };
  }

  /** The LSO platform: on the port deck edge abeam the wires, a man's height up — the deck view. */
  _placeDeckCamera() {
    if (!this.showCarrier) { this.cameraRig.deckPos = null; return; }
    const cv = this.carrier;
    const [n, e] = cv.onLanding(cv.wires[0].along - 25, -cv.data.landing.halfWidth - 9);
    this.cameraRig.deckPos = fromNE(n, e, cv.deckH + 1.8);
  }

  _resetToRunway() {
    this._broken = false;
    this.mapper.resetHolds();
    // on final to the carrier only once aboard: parked, the airplane waits on runway 36
    if (this._onFinalStart) { this._startOnFinal(); return; }
    const { n, e, heading } = this.world.startPosition(this._reverse);
    if (this.ac.spec.engine) this.ac.load.fuelCenterL = this.profile.fuelL ?? this.fuelLiters;
    this.ac.updateMass();
    this.ac.placeOnGround(n, e, heading);
    // the brake holds it on the runway until the pilot opens the throttle (update)
    this.ac.controls.parkingBrake = true;
    this._autoBrake = true;
    this.ac.setEngineRunning(this.engineRunningAtStart);
    this._autoStarter = !this.engineRunningAtStart;
    this._crankT = 0;
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
    this._colliders.enabled = false;
    // boarding starts outside, in the chase view (V goes round the others, the cockpit among them)
    this.cameraRig.view = 'chase';
    this.cameraRig.chasePos = null;
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
    } else if (this._loadIntro || (this.playIntro && !this._introPlayed && !this._demo && this._dest === 'meigs')) this._startIntro();
    else this._showTakeoffCard();
  }

  /** The avatar in the pilot's seat (the Extra's rear seat, the Eagle's ACES II). */
  _attachPilot() {
    // the avatar sits in a seated pose (as the vehicle demo seats its driver): its root goes below the
    // seat pan by the pose's hip height, so the hips land on the cushion
    const own = this.profile.seat || { forward: this.avatarSeatForward, height: this.avatarSeatHeight, lean: this.avatarLean };
    // moved as its airplane vibe says (up, forward)
    const adj = this.profile.seatAdjust || { up: 0, forward: 0 };
    const seat = { ...own, forward: own.forward + adj.forward, height: own.height - adj.up };
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
  /** Film mode: wait for Google's first tiles (if they come), settle, then board and roll. */
  _filmTick(dt) {
    const tilesUp = this.app.googleTilesLoading !== true;
    this._filmWait = tilesUp ? (this._filmWait || 0) + dt : 0;
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
    // at load: its own shots where the airplane has them (the tiles' pop-in kept out of the frame), else
    // the boarding film's, ending before the last shot (into the pilot's seat): the visitor stays outside
    const own = this.profile.intro;
    const film = this._loadIntro && own.load ? { ...own, ...own.load } : own;
    const end = this._loadIntro && !own.load ? film.shots[film.shots.length - 1].t0 : film.length;
    c.throttle = 0; c.parkingBrake = true;
    c.starter = !this._loadIntro && it.t > film.starter[0] && it.t < film.starter[1] && !this.ac.engine.running;
    if (it.t >= end) { this._endIntro(); return null; }
    const shot = introAt(it.t, film);
    // at load it opens out of black
    this.hud.setIntroFade(this._loadIntro ? 1 - Math.max(0, Math.min(1, (it.t - 0.3) / 1.6)) : 0);
    // the last second flies into the pilot's seat: the pilot's own head goes, and the canopy
    const inside = it.t > film.length - 1.2;
    this._setAvatarVisible(!inside);
    this.visual.setCockpitView(inside);
    this.hud.setIntroCard(shot.card >= 0 ? this._introCard(film.cards[shot.card]) : null, shot.cardAlpha, Math.min(1, it.t / end));
    if (shot.done) { this._endIntro(); return null; }
    return this.cameraRig.bodyPose(this.ac, shot.eye, shot.at, shot.fov, this.ac.cg);
  }

  /** A caption as it reads here: the place and runway the airplane stands on, not the film's own (Meigs, runway 36). */
  _introCard(card) {
    const place = this._placeCfg?.title || this._place?.title || '';
    const rw = this._runwayName;
    return {
      ...card,
      title: /^Runway /.test(card.title) ? `Runway ${rw}` : card.title,
      lines: card.lines.map((l) => (/· runway \S+$/.test(l) ? `${place} · runway ${rw}` : l)),
    };
  }

  /** The film ends (or is skipped): the engine runs, the brake is off, the pilot is in the cockpit view. */
  _endIntro() {
    if (!this._intro) return;
    if (this._loadIntro) {
      // the film at load: back on foot beside the airplane, parked as it was
      this._loadIntro = false;
      this._intro = null;
      this.ac.controls.starter = false;
      this.hud.showIntro(false);
      this._exit();
      return;
    }
    this._intro = null;
    this._filmMode = false;
    const c = this.ac.controls;
    c.starter = false;
    c.parkingBrake = false;
    if (this.engineRunningAtStart && !this.ac.engine.running) this.ac.setEngineRunning(true);
    this._autoStarter = !this.ac.engine.running;
    this._crankT = 0;
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
    this._colliders.enabled = true;
    // an airplane vibe tuned while it flew: taken on now it's parked
    if (this._retune) { this._retune = false; this._registryChanged('aircraft'); }
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
    // the browser keeps the sound muted until a key or a click: boarded by itself at load, the
    // airplane's sound waits for the first one
    if (this._flying) this.sound?.start();
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
      case 'parkingBrake': this._autoBrake = false; c.parkingBrake = !c.parkingBrake; this._thrAtBrake = this.mapper.throttle; break;
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
      case 'aircraft': {
        const l = this._planeEntries(), i = l.findIndex((e) => e.id === this._planeId);
        if (l.length) this._pickAircraft(l[(i + 1) % l.length].id);
        break;
      }
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
    this._colliders?.tick();
    this._lightsTick(dt);
    this._googleTick(dt);
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
    // the engine: off at the start, cranked by its starter on the first throttle until it runs (30 s at
    // most: the 777's cores take ~10 s to light)
    if (this._autoStarter && !this._intro && this.mapper.throttle > 0.02) {
      const c = this.ac.controls;
      this._crankT += dt;
      if (this.ac.engine.running || this._crankT > 30) { c.starter = false; this._autoStarter = false; }
      else c.starter = true;
    }
    // the auto brake: on from the start, off once the throttle opens (or the pilot works the brake)
    if (this._autoBrake && !this._intro) {
      if (this.mapper.throttle > 0.1 || !this.ac.gear.onGround) { this._autoBrake = false; this.ac.controls.parkingBrake = false; }
      else this.ac.controls.parkingBrake = true;
    } else if (this.ac.controls.parkingBrake && !this._intro && this.mapper.throttle > Math.max(0.1, (this._thrAtBrake ?? 0) + 0.05)) {
      // a parking brake set by the pilot lets go too as the throttle is opened past where it was set
      this.ac.controls.parkingBrake = false;
      this.hud.flash('Parking brake off', 1.2);
    }
    if (!this._paused) this.ac.update(dt);
    this._checkShip();
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
      // the ones that end the flight: the restart button too, until the reset
      if (ev.e === 'propStrike' || /^belly/.test(ev.e) || ev.e === 'splash') this._broken = true;
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

    // broken (crashed, the prop struck, the gear folded): the restart button under the top bar
    const dmg = this.ac.damage;
    this.hud.showRestart(this._flying && !this._intro && (this._broken || dmg.crashed || dmg.propStrike || dmg.gearCollapsed));
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
        this.hud.jetPanel.draw(v, {
          throttle: c.throttle, abDetent: this.ac.spec.jet.abDetent, boostLabel: this.profile.boostLabel, gearPos: this.ac.gearPos,
          speedbrake: this.ac.spec.aero.body.speedbrakeDragArea ? this.ac.speedbrakePos : null,
          flaps: this.ac.spec.autoFlaps ? c.flaps : null, hook: this.ac.spec.hook ? this.ac.hookPos : null,
          sfoils: this.ac.spec.sfoils ? this.ac.sfoilPos : null,
          parkingBrake: c.parkingBrake, engineRunning: this.ac.engine.running, paused: this._paused, buttons: this.hud.lampButtons,
        });
      } else {
        this.hud.panel.draw(v, {
          throttle: c.throttle, parkingBrake: c.parkingBrake, buttons: this.hud.lampButtons,
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

  /** Fly into the carrier's side or its island and the flight ends there. */
  _checkShip() {
    if (!this.showCarrier || this._dest !== 'meigs' || this.ac.damage.crashed) return;
    const p = this.ac.state.pos, h = -p[2];
    if (this.carrier.hullContains(p[0], p[1], h - 1) || this.carrier.islandContains(p[0], p[1], h)) this._crash('You hit the ship. Backspace to reset');
  }

  /** What a laser bolt bursts on: the ground or the water, the ship (n, e, h above the datum). */
  _laserSolid = (n, e, h) => {
    if (h <= this.world.ground(n, e).h) return true;
    return !!(this.showCarrier && this._dest === 'meigs' && (this.carrier.hullContains(n, e, h) || this.carrier.islandContains(n, e, h)));
  };

  _crash(message) {
    this.ac.damage.crashed = true;
    this._broken = true;
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
    this.cloudLayer?.set(cloudsAt(this._wx('coverage')), this.world.elevation + this._wx('baseFt') * 0.3048);
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
    if (name === 'destination') { const e = this._placeEntries().find((x) => x.base === airportBase(this.destination)); if (e) this._goTo(e.id); }
    if (name === 'clouds' || name === 'cloudBaseFt') this._applyClouds();
    if (name === 'easyMode') this._setEasy(this.easyMode);
    if (name === 'autoTrim') this.mapper.autoTrim = !!this.autoTrim;
    if (name === 'aircraft') { const e = this._planeEntries().find((x) => x.base === aircraftBase(this.aircraft)); if (e && e.id !== this._planeId) this._pickAircraft(e.id); }
    if (name === 'introOnLoad' && this.introOnLoad && !this._flying) this._filmPending = true;
    if (name === 'showPanel') { this._panelVisible = this.showPanel; this.hud.setFlying(this._flying, this._panelVisible); }
    if (['windKt', 'windFromDeg', 'qnhInHg', 'oatC'].includes(name)) this.ac.weather = this._weather();
    if (name === 'fuelLiters' || name === 'startRunway' || name === 'engineRunningAtStart') { if (!this._flying) this._resetToRunway(); }
    if (name === 'isEnabled' && !this.isEnabled) this._exit();
  }

  onEntityMoved() { this._placeWorldRoot(); }

  destroy() {
    this._destroyed = true;
    this.app.off('flightsim:changed', this._onRegistry);
    if (this._menu) { this._menu.destroy(); this._menu = null; }
    this._shadowFit?.destroy();
    this.app.googleTilesHold = false;
    // Google's globe back where the space has it (Meigs), the flattening gone
    if (this._dest !== 'meigs') { this.world = this.meigs; this._publishOrigin(); }
    this.app.fire('googletiles:flatten-region-clear', `extra300-flatten-${this.entity.getGuid()}`);
    for (const f of Object.values(this._flatMasks)) f.texture.destroy();
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
