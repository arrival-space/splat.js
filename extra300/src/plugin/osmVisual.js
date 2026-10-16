// osmVisual.js — the OpenStreetMap city as PlayCanvas entities: ground
// layers, roads, the shore, and the procedural buildings, built a few tiles
// per frame so the space never freezes while Chicago goes up.

import { buildCity, groundLayer, ribbons, seawalls, FACADES } from '../render/buildings.js';
import { material, meshEntity, toMesh } from './pcMesh.js';

const textures = new Map();

/** One window cell (one bay × one floor) per style, drawn on a canvas; the walls repeat it. */
function facadeTexture(device, style) {
  if (textures.has(style)) return textures.get(style);
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const wall = '#e8e8e8';
  const glass = '#3c4652';
  const win = {
    brick: [0.30, 0.25, 0.40, 0.50], stone: [0.28, 0.22, 0.44, 0.56], glass: [0.06, 0.12, 0.88, 0.80],
    dark: [0.05, 0.12, 0.90, 0.80], white: [0.36, 0.10, 0.28, 0.82], plain: [0.0, 0.55, 1.0, 0.16], house: [0.32, 0.28, 0.36, 0.42],
  }[style] || [0.3, 0.25, 0.4, 0.5];
  g.fillStyle = wall;
  g.fillRect(0, 0, S, S);
  g.fillStyle = glass;
  // canvas y runs down, the texture's v runs up: windows sit above the sill
  g.fillRect(win[0] * S, (1 - win[1] - win[3]) * S, win[2] * S, win[3] * S);
  // a lighter reflection streak on the glass
  g.fillStyle = 'rgba(160,180,200,0.35)';
  g.fillRect(win[0] * S, (1 - win[1] - win[3]) * S, win[2] * S * 0.35, win[3] * S);
  const tex = new pc.Texture(device, { width: S, height: S, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, anisotropy: 8 });
  tex.setSource(c);
  textures.set(style, tex);
  return tex;
}

function facadeMaterial(device, style) {
  const m = new pc.StandardMaterial();
  m.diffuseMap = facadeTexture(device, style);
  m.diffuseVertexColor = true;
  m.diffuse = new pc.Color(1, 1, 1);
  m.useMetalness = true;
  m.metalness = 0;
  m.gloss = style === 'glass' || style === 'dark' ? 0.75 : 0.3;
  m.update();
  return m;
}

function roofMaterial() {
  const m = new pc.StandardMaterial();
  m.diffuseVertexColor = true;
  m.diffuse = new pc.Color(1, 1, 1);
  m.useMetalness = true;
  m.metalness = 0;
  m.gloss = 0.2;
  m.update();
  return m;
}

/** Layers drawn over the land get a depth bias instead of a visible height step. */
function overlay(color, bias) {
  const m = material(color);
  const o = m.clone();
  o.depthBias = bias;
  o.slopeDepthBias = bias;
  o.update();
  return o;
}

export class OsmVisual {
  constructor(app, parent, world, opts) {
    this.app = app;
    this.root = new pc.Entity('OsmChicago');
    parent.addChild(this.root);
    this.world = world;
    this.queue = [];
    this.materials = new Map();
    this.cityRoot = null;
    const osm = world.osm;

    // ground: land, parks, inland water, roads, rail, and the stone edge of the lake
    const g = (name, mb, mat) => meshEntity(app, this.root, name, mb, mat, { castShadows: false });
    this.ground = {
      land: g('land', groundLayer(osm.land, 0), material('#8b8d84')),
      // past the box: the suburbs out to the horizon, west of the lakefront
      farLand: world.farLand ? g('farLand', groundLayer([world.farLand], 0), material('#7d8573')) : null,
      parks: g('parks', groundLayer(osm.parks, 0.01), overlay('#5f8240', -1)),
      river: g('river', groundLayer(osm.water, 0.01), overlay('#355f78', -1)),
      roads: g('roads', ribbons(osm.roads, 0.02), overlay('#4a4b4e', -2)),
      rail: g('rail', ribbons(osm.rail, 0.03), overlay('#5c5149', -3)),
      shore: g('shore', seawalls(osm.land, osm.header.box, world.water - 0.5, 0), material('#9b968a')),
    };
    this.google = false;
    this.build(opts);
  }

  /** (Re)build the buildings for a skyline year and detail level; tiles stream in over the next frames. */
  build({ year = 2026, minHeight = 0 } = {}) {
    if (this.cityRoot) this.cityRoot.destroy();
    this.cityRoot = new pc.Entity('buildings');
    this.cityRoot.enabled = !this.google;
    this.root.addChild(this.cityRoot);
    const parts = buildCity(this.world.osm.buildings, { year, minHeight });
    this.shown = parts.shown;
    this.queue = parts;
  }

  /** Call once per frame: turns a few prepared tiles into GPU meshes. */
  tick(budgetMs = 6) {
    if (this.google) return;   // nothing of ours to raise: Google's tiles are the city
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const p = this.queue.shift();
      const key = `${p.kind}|${p.style}`;
      if (!this.materials.has(key)) this.materials.set(key, p.kind === 'walls' ? facadeMaterial(this.app.graphicsDevice, p.style) : roofMaterial());
      const e = new pc.Entity(`${p.style}-${p.kind}-${p.key}`);
      const mesh = toMesh(this.app.graphicsDevice, p.mesh);
      const mi = new pc.MeshInstance(mesh, this.materials.get(key));
      e.addComponent('render', { meshInstances: [mi], castShadows: p.kind === 'walls', receiveShadows: true });
      this.cityRoot.addChild(e);
    }
    return this.queue.length;
  }

  set visible(v) { this.root.enabled = v; }

  /** Google's 3D tiles are the city, its land and its water: all of ours goes but the collision volumes. */
  setGoogle(on) {
    this.google = on;
    for (const e of Object.values(this.ground)) if (e) e.enabled = !on;
    if (this.cityRoot) this.cityRoot.enabled = !on;
  }

  destroy() {
    this.root.destroy();
    for (const m of this.materials.values()) m.destroy?.();
    for (const t of textures.values()) t.destroy?.();
    textures.clear();
  }
}

export { FACADES };
