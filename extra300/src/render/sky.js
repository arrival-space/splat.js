// sky.js — a procedural sky: a unit dome with a vertical colour gradient,
// deep blue overhead to a pale haze at the horizon, and the lake-coloured
// murk below it, brightening toward the sun (where the scene's directional
// light comes from: the plugin draws the disc there too). The plugin scales
// it to just inside the far clip and keeps it centred on the camera, so it
// never parallaxes.

import { MeshBuilder } from './geometry.js';

const ZENITH = [70, 120, 190];
const HORIZON = [196, 214, 228];
const BELOW = [120, 140, 150];

const GLOW = [255, 246, 222];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Elevation angle (rad) → sky colour [r, g, b] 0..255. */
export function skyColour(el) {
  if (el < 0) return mix(HORIZON, BELOW, Math.min(1, -el / 0.15));
  const t = Math.pow(Math.min(1, el / (Math.PI / 2)), 0.45);
  return mix(HORIZON, ZENITH, t);
}

/** The sky toward unit direction p, with the sun (unit, or null) brightening the haze round it. */
export function skyColourToward(p, el, sun) {
  const c = skyColour(el);
  if (!sun || el < -0.05) return c;
  const mu = Math.max(0, p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]);
  return mix(c, GLOW, Math.min(0.85, 0.7 * mu ** 24 + 0.25 * mu ** 4));
}

export function buildSkyDome(segments = 32, rings = 14, sun = null) {
  const mb = new MeshBuilder({ color: true });
  const els = [];
  // denser near the horizon, where the sun's glow and the haze change fastest
  for (let i = 0; i <= rings; i++) els.push(-0.25 + Math.pow(i / rings, 1.6) * (Math.PI / 2 + 0.25));
  for (let i = 0; i <= rings; i++) {
    const el = els[i];
    for (let j = 0; j <= segments; j++) {
      const az = (j / segments) * Math.PI * 2;
      const p = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
      mb.vertex(p, [-p[0], -p[1], -p[2]], null, skyColourToward(p, el, sun));
    }
  }
  const row = segments + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      mb.indices.push(a, c, b, b, c, d);
    }
  }
  return mb;
}
