// glassMaterial.js — the canopy: tinted, see-through acrylic with a mirror finish.
// Reflections come from a small sky cube of our own (sky above, haze at the
// horizon, ground below), so the canopy reflects the same sky whatever the space's
// skybox is; specular is kept at full strength through the transparency, so the
// reflection stays bright where the glass is clear — as it does on a real canopy.

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
export function glassMaterial(device, tint) {
  cube ??= skyCube(device);
  const m = new pc.StandardMaterial();
  m.diffuse = new pc.Color().fromString(tint);
  m.opacity = 0.22;
  m.blendType = pc.BLEND_NORMAL;
  m.depthWrite = false;
  m.useMetalness = true;
  m.metalness = 0;
  m.gloss = 0.96;
  m.cubeMap = cube;
  m.reflectivity = 1;
  m.opacityFadesSpecular = false;   // the reflection keeps its strength where the glass is clear
  m.cull = pc.CULLFACE_NONE;
  m.update();
  return m;
}

export function disposeGlass() {
  cube?.destroy?.();
  cube = null;
}
