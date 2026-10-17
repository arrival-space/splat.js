// groundMaterial.js — the airfield's textured materials: a big unique image for
// the variation (sRGB) under a small tileable detail layer for the grain
// (overlay, grey-centred), both mapped in runway metres (see render/groundTextures.js).

import { asphaltDetail, asphaltNormal, grassDetail, grassMacro, paintWear, runwayMacro } from '../render/groundTextures.js';

export function upload(device, img, { srgb, repeat }) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const address = repeat ? pc.ADDRESS_REPEAT : pc.ADDRESS_CLAMP_TO_EDGE;
  const tex = new pc.Texture(device, {
    width: img.width, height: img.height, format: srgb ? pc.PIXELFORMAT_SRGBA8 : pc.PIXELFORMAT_RGBA8,
    mipmaps: true, addressU: address, addressV: address, anisotropy: 8,
  });
  tex.setSource(c);   // canvas row 0 is the image's v-max edge, as the generators draw it
  return tex;
}

// where each paved image lies, in runway metres
const PAVED = {
  runway: (L, W) => ({ u: [-W / 2 - 1, W / 2 + 1], v: [-L / 2 - 32, L / 2 + 32] }),
  taxiway: (L, W) => ({ u: [-W / 2 - 162, -W / 2 + 1], v: [-L / 2 + 30, L / 2 - 30] }),
};

// the paved images are painted once and shared with the markings on them
const macros = new Map();
function pavedMacro(kind, L, W, paved) {
  if (!macros.has(kind)) {
    const { u, v } = PAVED[kind](L, W);
    macros.set(kind, kind === 'runway'
      ? runwayMacro({ u, v, length: L, width: W, areas: paved.filter((a) => a.kind === 'runway') }, 512, 2048)
      : runwayMacro({ u, v, length: L, width: W, areas: paved.filter((a) => a.kind !== 'runway') }, 256, 1024, 9));
  }
  return macros.get(kind);
}

const details = new Map();
export function detail(device, kind) {
  if (!details.has(kind)) {
    const img = kind === 'grass' ? grassDetail() : kind === 'asphaltNormal' ? asphaltNormal() : asphaltDetail();
    details.set(kind, upload(device, img, { srgb: false, repeat: true }));
  }
  return details.get(kind);
}

/**
 * @param {'runway'|'taxiway'|'grass'|'paint-runway'|'paint-taxiway'} kind
 * @param {{ length: number, width: number }} rw   the runway
 * @param {{ kind: string, u: number[], v: number[] }[]} paved  runway / taxiway / apron rectangles
 * @param {string|null} paint  for markings: the paint colour, worn by the asphalt image it lies on
 */
export function groundMaterial(device, kind, rw, paved, bias = 0, paint = null) {
  const L = rw.length, W = rw.width;
  const base = kind.replace('paint-', '');
  let macro, u, v, period;
  if (base === 'runway' || base === 'taxiway') {
    ({ u, v } = PAVED[base](L, W));
    macro = pavedMacro(base, L, W, paved);
    if (paint) macro = paintWear(macro);
    period = 2.5;
  } else {
    u = [-256, 256]; v = [-832, 832];
    macro = grassMacro({ u, v, width: W }, 512, 1024);
    period = 3;
  }
  const m = new pc.StandardMaterial();
  m.diffuse = paint ? new pc.Color().fromString(paint) : new pc.Color(1, 1, 1);
  m.diffuseMap = upload(device, macro, { srgb: true, repeat: false });
  m.diffuseMapTiling = new pc.Vec2(1 / (u[1] - u[0]), 1 / (v[1] - v[0]));
  m.diffuseMapOffset = new pc.Vec2(-u[0] / (u[1] - u[0]), -v[0] / (v[1] - v[0]));
  m.diffuseDetailMap = detail(device, base === 'grass' ? 'grass' : 'asphalt');
  m.diffuseDetailMapTiling = new pc.Vec2(1 / period, 1 / period);
  m.diffuseDetailMode = pc.DETAILMODE_OVERLAY;
  if (base !== 'grass') {
    // the aggregate's relief, at the detail layer's scale: the sun glints off it
    m.normalMap = detail(device, 'asphaltNormal');
    m.normalMapTiling = new pc.Vec2(1 / period, 1 / period);
    m.bumpiness = paint ? 0.35 : 0.7;
  }
  m.useMetalness = true;
  m.metalness = 0;
  m.gloss = base === 'grass' ? 0.2 : paint ? 0.45 : 0.36;
  m.cull = pc.CULLFACE_NONE;
  if (bias) { m.depthBias = bias; m.slopeDepthBias = bias; }
  m.update();
  return m;
}

export function disposeGroundTextures() {
  for (const t of details.values()) t.destroy?.();
  details.clear();
  macros.clear();
}
