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

// metal's, glass's and the plain parts' reflections (plugin/pcMesh.js) 30 % up on what the materials
// would give: in a browser, with no bloom and an 8-bit screen, things came out reflecting less than
// they do outside (the paint is a denser clear coat instead, below)
export const REFLECTANCE = 1.3;

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

// The paint's clear coat as a real one: its reflectance from its refractive index, Fresnel's 1 at
// grazing never exceeded. The engine's coat is n = 1.5 (4 % facing the eye); a glossy polyurethane
// topcoat is a little denser: n = 1.58, 5 %, a quarter more, as bright a sheen as glass at grazing.
const COAT_IOR = 1.58;
const COAT_F0 = ((COAT_IOR - 1) / (COAT_IOR + 1)) ** 2;
const FRESNEL_DEFAULT_GLSL = `
float pow5(float x) { float x2 = x * x; return x2 * x2 * x; }
vec3 getFresnel(float cosTheta, float gloss, vec3 specularity
#if defined(LIT_IRIDESCENCE)
    , vec3 iridescenceFresnel, float iridescenceIntensity
#endif
) {
    float fresnel = pow5(1.0 - saturate(cosTheta));
    float glossSq = gloss * gloss;
    float specIntensity = max(specularity.r, max(specularity.g, specularity.b));
    vec3 ret = specularity + (max(vec3(glossSq * specIntensity), specularity) - specularity) * fresnel;
#if defined(LIT_IRIDESCENCE)
    return mix(ret, iridescenceFresnel, iridescenceIntensity);
#else
    return ret;
#endif
}
`;
const FRESNEL_DEFAULT_WGSL = `
fn pow5(x: f32) -> f32 { let x2: f32 = x * x; return x2 * x2 * x; }
fn getFresnel(cosTheta: f32, gloss: f32, specularity: vec3f
#if defined(LIT_IRIDESCENCE)
    , iridescenceFresnel: vec3f, iridescenceIntensity: f32
#endif
) -> vec3f {
    let fresnel: f32 = pow5(1.0 - saturate(cosTheta));
    let glossSq: f32 = gloss * gloss;
    let specIntensity: f32 = max(specularity.r, max(specularity.g, specularity.b));
    let ret: vec3f = specularity + (max(vec3f(glossSq * specIntensity), specularity) - specularity) * fresnel;
#if defined(LIT_IRIDESCENCE)
    return mix(ret, iridescenceFresnel, iridescenceIntensity);
#else
    return ret;
#endif
}
`;
function paintCoat(m) {
  const f0 = COAT_F0.toFixed(5), f1 = (1 - COAT_F0).toFixed(5);
  m.getShaderChunks('glsl').set('fresnelSchlickPS', `${FRESNEL_DEFAULT_GLSL}
float getFresnelCC(float cosTheta) { return ${f0} + ${f1} * pow5(1.0 - saturate(cosTheta)); }
`);
  m.getShaderChunks('wgsl').set('fresnelSchlickPS', `${FRESNEL_DEFAULT_WGSL}
fn getFresnelCC(cosTheta: f32) -> f32 { return ${f0} + ${f1} * pow5(1.0 - saturate(cosTheta)); }
`);
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
  m.clearCoat = satin ? 0.25 : 1;   // a full coat (a fighter's satin: a thin one)
  m.clearCoatGloss = satin ? 0.7 : 0.93;
  paintCoat(m);
  reflecting(m, probe);
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
  m.reflectivity = REFLECTANCE;
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
  m.reflectivity = REFLECTANCE;
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
  m.opacity = 0.1;            // clear acrylic: a faint cast, the view through it barely dimmed
  m.blendType = pc.BLEND_NORMAL;
  m.depthWrite = false;
  m.useMetalness = false;
  m.specular = new pc.Color(0, 0, 0);
  m.cull = pc.CULLFACE_NONE;
  m.update();
  cache.set(key, m);
  return m;
}

// Schlick's Fresnel as it is: from the specular colour head on to a mirror at a grazing look. The
// engine's caps the grazing reflectance at gloss² × the specular colour, so a dielectric's never rose
// above its 4 %: glass had no rim, no sheen of sky across its curve.
const FRESNEL_GLSL = `
float pow5(float x) { float x2 = x * x; return x2 * x2 * x; }
vec3 getFresnel(float cosTheta, float gloss, vec3 specularity
#if defined(LIT_IRIDESCENCE)
    , vec3 iridescenceFresnel, float iridescenceIntensity
#endif
) {
    return specularity + (1.0 - specularity) * pow5(1.0 - saturate(cosTheta));
}
float getFresnelCC(float cosTheta) { return 0.04 + 0.96 * pow5(1.0 - saturate(cosTheta)); }
`;
const FRESNEL_WGSL = `
fn pow5(x: f32) -> f32 { let x2: f32 = x * x; return x2 * x2 * x; }
fn getFresnel(cosTheta: f32, gloss: f32, specularity: vec3f
#if defined(LIT_IRIDESCENCE)
    , iridescenceFresnel: vec3f, iridescenceIntensity: f32
#endif
) -> vec3f {
    return specularity + (vec3f(1.0) - specularity) * pow5(1.0 - saturate(cosTheta));
}
fn getFresnelCC(cosTheta: f32) -> f32 { return 0.04 + 0.96 * pow5(1.0 - saturate(cosTheta)); }
`;

export function glassReflectionMaterial(device, f0 = 0.06) {
  const key = `glassReflection${f0}`;
  if (cache.has(key)) return cache.get(key);
  cube ??= skyCube(device);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(0, 0, 0);
  m.ambient = new pc.Color(0, 0, 0);
  m.useMetalness = false;
  m.specular = new pc.Color(f0, f0, f0);   // acrylic's 4 % a surface; the canopy a little over, for the pair
  // the sun's glint a few degrees across (the cube's reflection takes no blur from gloss: it stays sharp)
  m.gloss = 0.88;
  m.getShaderChunks('glsl').set('fresnelSchlickPS', FRESNEL_GLSL);
  m.getShaderChunks('wgsl').set('fresnelSchlickPS', FRESNEL_WGSL);
  reflecting(m, true);
  m.reflectivity = REFLECTANCE;
  m.blendType = pc.BLEND_ADDITIVE;
  m.depthWrite = false;
  m.update();
  cache.set(key, m);
  return m;
}

/** A perfect mirror (the debug spheres': plugin/extra300.js), reflecting the live cube: the reference, unboosted. */
export function mirrorMaterial(device) {
  const key = 'mirror';
  if (cache.has(key)) return cache.get(key);
  cube ??= skyCube(device);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color(1, 1, 1);
  m.useMetalness = true;
  m.metalness = 1;
  m.gloss = 1;
  reflecting(m, true);
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
