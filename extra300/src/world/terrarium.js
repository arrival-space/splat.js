// terrarium.js — the ground's height round an airfield found by name (world/airfields.js), fetched
// as it is picked: the Terrarium elevation tiles (Mapzen, AWS Open Data), sampled onto the same two
// grids the baked airports carry (world/airport.js: near 20 km at 40 m, far 100 km at 250 m), from
// coarser tiles (18 in all) than the bake's, so it comes in a second or two.

import { LocalFrame } from './geo.js';

const URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const NEAR = { half: 10000, step: 40, z: 11 };
const FAR = { half: 50000, step: 250, z: 9 };

/** A tile's pixels in the browser: { width, height, data: RGBA }. */
async function fetchTileBrowser(z, x, y) {
  const res = await fetch(`${URL}/${z}/${x}/${y}.png`);
  if (!res.ok) throw new Error(`terrarium ${z}/${x}/${y}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

/** Global pixel position (256-px tiles) of a point at zoom z. */
function pixel(lat, lon, z) {
  const n = 256 * 2 ** z, s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/**
 * One grid of heights (m above sea level) round the centre: row 0 the south edge, as world/airport.js
 * reads them.
 */
export async function terrariumGrid(centre, { half, step, z }, fetchTile = fetchTileBrowser) {
  const frame = new LocalFrame(centre[0], centre[1]);
  const n = Math.round((2 * half) / step) + 1;
  const px = new Float64Array(n * n * 2);
  const need = new Set();
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [lat, lon] = frame.toLatLon(-half + j * step, -half + i * step);
    const [x, y] = pixel(lat, lon, z);
    px[(j * n + i) * 2] = x; px[(j * n + i) * 2 + 1] = y;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) need.add(`${Math.floor((x + dx) / 256)},${Math.floor((y + dy) / 256)}`);
  }
  const tiles = new Map(await Promise.all([...need].map(async (k) => {
    const [x, y] = k.split(',').map(Number);
    return [k, await fetchTile(z, x, y)];
  })));
  const at = (x, y) => {
    const t = tiles.get(`${Math.floor(x / 256)},${Math.floor(y / 256)}`);
    const k = ((Math.floor(y) % 256) * t.width + (Math.floor(x) % 256)) * 4, d = t.data;
    return d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
  };
  const h = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    const x = px[k * 2] - 0.5, y = px[k * 2 + 1] - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    h[k] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  }
  return { half, step, n, h };
}

/** Both grids round an airfield, as world/airport.js's buildAirport takes them. */
export async function terrariumDem(centre, fetchTile = fetchTileBrowser) {
  const [near, far] = await Promise.all([terrariumGrid(centre, NEAR, fetchTile), terrariumGrid(centre, FAR, fetchTile)]);
  return { near, far };
}
