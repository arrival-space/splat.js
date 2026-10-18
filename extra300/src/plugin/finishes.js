// finishes.js — the airplane's surfaces: glossy paint, metal, and the canopy's
// tinted acrylic. Reflections come from the live cube rendered round the airplane
// (plugin/reflectionProbe.js), or until it is whole from a small sky cube of our
// own (sky above, haze at the horizon, ground below).

/** Sky colour (linear 0–1) seen along a direction; y is up. */
export function skyColour(dx, dy, dz) {
  const l = Math.hypot(dx, dy, dz) || 1;
  const y = dy / l;
  if (y < 0) {
    // ground: dark, a touch of green, lightening into the horizon haze
    const t = Math.min(1, -y * 4);
    return [0.55 - t * 0.43, 0.58 - t * 0.43, 0.6 - t * 0.5];
  }
  const t = Math.pow(y, 0.45);
  return [0.78 - t * 0.55, 0.84 - t * 0.44, 0.9 - t * 0.12];
}

function skyCube(device, S = 32) {
  // +x, −x, +y, −y, +z, −z: face directions (u right, v down, as the cube faces are laid out)
  const faces = [
    (u, v) => [1, -v, -u], (u, v) => [-1, -v, u], (u, v) => [u, 1, v],
    (u, v) => [u, -1, -v], (u, v) => [u, -v, 1], (u, v) => [-u, -v, -1],
  ];
  const levels = faces.map((dir) => {
    const px = new Uint8Array(S * S * 4);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const c = skyColour(...dir(((i + 0.5) / S) * 2 - 1, ((j + 0.5) / S) * 2 - 1));
      const k = (j * S + i) * 4;
      px[k] = c[0] * 255; px[k + 1] = c[1] * 255; px[k + 2] = c[2] * 255; px[k + 3] = 255;
    }
    return px;
  });
  return new pc.Texture(device, {
    cubemap: true, width: S, height: S, format: pc.PIXELFORMAT_SRGBA8, mipmaps: false,
    minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR, levels: [levels],
  });
}

let cube = null;
let live = null;          // the reflection probe's cube, when it has one
const cache = new Map();
const reflective = new Set();

/** A material's reflections: the live cube (the airplane's own surfaces), or the sky cube (the scenery's). */
function reflecting(m, probe) {
  m.cubeMap = (probe && live) || cube;
  if (probe) reflective.add(m);
}

/** Reflections from this cube (the probe's), or null: back to the sky cube. */
export function setReflectionCube(tex) {
  if (tex === live) return;
  live = tex;
  for (const m of reflective) { m.cubeMap = live || cube; m.update(); }
}

/**
 * Aircraft paint: a polyurethane topcoat over the colour, glossy and clear-coated, the sky sliding
 * across it as the airplane moves (white, red, the yellow prop tips, the spinner). `satin`: a
 * fighter's low-sheen greys, the sky only a soft sheen on them.
 */
export function paintMaterial(device, colour, satin = false, probe = true) {
  const key = `paint${colour}${satin}${probe}`;
  if (cache.has(key)) return cache.get(key);
  cube ??= skyCube(device);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color().fromString(colour);
  m.useMetalness = true;
  m.metalness = 0;
  m.gloss = satin ? 0.55 : 0.82;
  m.clearCoat = satin ? 0.25 : 1;
  m.clearCoatGloss = satin ? 0.7 : 0.93;
  reflecting(m, probe);
  m.reflectivity = 1;
  m.update();
  cache.set(key, m);
  return m;
}

/** Bare and polished metal: exhaust, wheel hubs, pedals (and chrome: buckles, bezels). */
export function metalMaterial(device, colour, polished = false, probe = false) {
  const key = `metal${colour}${polished}${probe}`;
  if (cache.has(key)) return cache.get(key);
  cube ??= skyCube(device);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color().fromString(colour);
  m.useMetalness = true;
  m.metalness = 1;
  m.gloss = polished ? 0.9 : 0.6;
  reflecting(m, probe);
  m.update();
  cache.set(key, m);
  return m;
}

export function glassMaterial(device, tint, probe = false) {
  const key = `glass${tint}${probe}`;
  if (cache.has(key)) return cache.get(key);
  cube ??= skyCube(device);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color().fromString(tint);
  m.opacity = 0.22;
  m.blendType = pc.BLEND_NORMAL;
  m.depthWrite = false;
  m.useMetalness = true;
  m.metalness = 0;
  m.gloss = 0.96;
  reflecting(m, probe);
  m.reflectivity = 1;
  m.opacityFadesSpecular = false;   // the reflection keeps its strength where the glass is clear
  m.cull = pc.CULLFACE_NONE;
  m.update();
  cache.set(key, m);
  return m;
}

/**
 * The airplane's canopy is two layers over one mesh. Blended the usual way, the engine scales the
 * whole colour, reflection and all, by the glass's alpha (a fifth), and the sky on the acrylic was
 * all but gone. Instead the tint is one layer, the light it takes out of the view behind, and the
 * reflection another, added at full strength: clear acrylic's Fresnel reflection of the live cube
 * (a few per cent head on, a mirror at a grazing look) and the sun's glint.
 */
export function glassTintMaterial(device, tint) {
  const key = `glassTint${tint}`;
  if (cache.has(key)) return cache.get(key);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color().fromString(tint);
  m.opacity = 0.22;
  m.blendType = pc.BLEND_NORMAL;
  m.depthWrite = false;
  m.useMetalness = false;
  m.specular = new pc.Color(0, 0, 0);
  m.cull = pc.CULLFACE_NONE;
  m.update();
  cache.set(key, m);
  return m;
}

export function glassReflectionMaterial(device) {
  const key = 'glassReflection';
  if (cache.has(key)) return cache.get(key);
  cube ??= skyCube(device);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0, 0, 0);
  m.ambient = new pc.Color(0, 0, 0);
  m.useMetalness = false;
  m.specular = new pc.Color(0.06, 0.06, 0.06);   // acrylic's 4 % a surface, a little over for the pair
  m.gloss = 0.97;
  reflecting(m, true);
  m.reflectivity = 1;
  m.blendType = pc.BLEND_ADDITIVE;
  m.depthWrite = false;
  m.update();
  cache.set(key, m);
  return m;
}

/** The afterburner's plume: glowing, additive, unlit, seen from both sides. */
export function flameMaterial(colour) {
  const key = `flame${colour}`;
  if (cache.has(key)) return cache.get(key);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0, 0, 0);
  m.emissive = new pc.Color().fromString(colour);
  m.emissiveIntensity = 2.2;
  m.useLighting = false;
  m.useFog = false;
  m.blendType = pc.BLEND_ADDITIVEALPHA;
  m.opacity = 0.35;
  m.depthWrite = false;
  m.cull = pc.CULLFACE_NONE;
  m.update();
  cache.set(key, m);
  return m;
}

export function disposeFinishes() {
  for (const m of cache.values()) m.destroy?.();
  cache.clear();
  reflective.clear();
  live = null;
  cube?.destroy?.();
  cube = null;
}
