// sky.js — a procedural sky: a unit dome with a vertical colour gradient,
// deep blue overhead to a pale haze at the horizon, and the lake-coloured
// murk below it. The plugin scales it to just inside the far clip and keeps
// it centred on the camera, so it never parallaxes.

import { MeshBuilder } from './geometry.js';

const ZENITH = [70, 120, 190];
const HORIZON = [196, 214, 228];
const BELOW = [120, 140, 150];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** Elevation angle (rad) → sky colour [r, g, b] 0..255. */
export function skyColour(el) {
  if (el < 0) return mix(HORIZON, BELOW, Math.min(1, -el / 0.15));
  const t = Math.pow(Math.min(1, el / (Math.PI / 2)), 0.45);
  return mix(HORIZON, ZENITH, t);
}

export function buildSkyDome(segments = 32, rings = 14) {
  const mb = new MeshBuilder({ color: true });
  const els = [];
  for (let i = 0; i <= rings; i++) els.push(-0.25 + (i / rings) * (Math.PI / 2 + 0.25));
  for (let i = 0; i <= rings; i++) {
    const el = els[i];
    for (let j = 0; j <= segments; j++) {
      const az = (j / segments) * Math.PI * 2;
      const p = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
      mb.vertex(p, [-p[0], -p[1], -p[2]], null, skyColour(el));
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
