// cloudNoise.js — the noise the clouds are carved from, after Guerrilla's Nubis (Schneider,
// "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015 / 2017): tileable
// 3D textures made once at load (engine-free: RGBA8 arrays the plugin uploads).
//
//   shape    64³  r: Perlin-Worley (billowy Perlin fbm, carved by inverted Worley), g b a: inverted
//            Worley fbm at 4, 8, 16 cells across — the clouds' big round lumps
//   detail   32³  r g b: inverted Worley fbm at 2, 4, 8 cells — the wisps eroding their edges
//   weather  256² r: coverage (where clouds may be), g: type (0 stratus … 1 towering cumulus),
//            b: a slow variation of density; tiled every few tens of kilometres


function hash3(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177 + seed * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const mod = (a, n) => ((a % n) + n) % n;

/** Inverted Worley (1 at the feature points, 0 far between them), tileable over `freq` cells. */
function worley(x, y, z, freq, seed) {
  const px = x * freq, py = y * freq, pz = z * freq;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz;
    const wx = mod(cx, freq), wy = mod(cy, freq), wz = mod(cz, freq);
    const fx = cx + hash3(wx, wy, wz, seed), fy = cy + hash3(wx, wy, wz, seed + 1), fz = cz + hash3(wx, wy, wz, seed + 2);
    const d = (fx - px) ** 2 + (fy - py) ** 2 + (fz - pz) ** 2;
    if (d < best) best = d;
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const GRAD = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
/** Gradient (Perlin) noise in [−1, 1], tileable over `freq` cells. */
function perlin(x, y, z, freq, seed) {
  const px = x * freq, py = y * freq, pz = z * freq;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  const fx = px - ix, fy = py - iy, fz = pz - iz;
  const g = (i, j, k, dx, dy, dz) => {
    const v = GRAD[Math.floor(hash3(mod(i, freq), mod(j, freq), mod(k, freq), seed) * 12)];
    return v[0] * dx + v[1] * dy + v[2] * dz;
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(g(ix, iy, iz, fx, fy, fz), g(ix + 1, iy, iz, fx - 1, fy, fz), u), l(g(ix, iy + 1, iz, fx, fy - 1, fz), g(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), u), v),
    l(l(g(ix, iy, iz + 1, fx, fy, fz - 1), g(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), u), l(g(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), g(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), u), v),
    w,
  );
}

const worleyFbm = (x, y, z, f, seed) => worley(x, y, z, f, seed) * 0.625 + worley(x, y, z, f * 2, seed + 7) * 0.25 + worley(x, y, z, f * 4, seed + 13) * 0.125;
const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Rows z0 … z1 of the shape texture into `out` (so it can be made a few slices per frame). */
export function shapeSlices(out, N, z0, z1, seed = 3) {
  for (let z = z0; z < z1; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N;
    // Perlin fbm, 0..1, dilated by the Worley cells: round lumps with Perlin's variety on them
    let p = 0, amp = 1, norm = 0;
    for (let o = 0; o < 3; o++) { p += perlin(u, v, w, 4 << o, seed + o) * amp; norm += amp; amp *= 0.5; }
    p = Math.max(0, Math.min(1, (p / norm) * 0.9 + 0.5));
    const w1 = worleyFbm(u, v, w, 4, seed + 20), w2 = worleyFbm(u, v, w, 8, seed + 40), w3 = worleyFbm(u, v, w, 16, seed + 60);
    const pw = remap(p, 0, 1, w1, 1);
    const k = ((z * N + y) * N + x) * 4;
    out[k] = byte(pw); out[k + 1] = byte(w1); out[k + 2] = byte(w2); out[k + 3] = byte(w3);
  }
}

export function shapeNoise(N = 64, seed = 3) {
  const out = new Uint8Array(N * N * N * 4);
  shapeSlices(out, N, 0, N, seed);
  return { size: N, data: out };
}

export function detailNoise(N = 32, seed = 101) {
  const out = new Uint8Array(N * N * N * 4);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, w = z / N;
    const k = ((z * N + y) * N + x) * 4;
    out[k] = byte(worleyFbm(u, v, w, 2, seed)); out[k + 1] = byte(worleyFbm(u, v, w, 4, seed + 30)); out[k + 2] = byte(worleyFbm(u, v, w, 8, seed + 60)); out[k + 3] = 255;
  }
  return { size: N, data: out };
}

export function weatherMap(S = 256, seed = 211) {
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    // coverage: broad Perlin fbm, broken up by Worley cells: 0 clear … 1 cloud, about half and half
    let p = 0, amp = 1, norm = 0;
    for (let o = 0; o < 5; o++) { p += perlin(u, v, 0.5, 4 << o, seed + o) * amp; norm += amp; amp *= 0.5; }
    const cells = worley(u, v, 0.5, 6, seed + 10) * 0.6 + worley(u, v, 0.5, 12, seed + 11) * 0.4;
    const cov = Math.max(0, Math.min(1, 0.5 + (p / norm) * 2.4 + (cells - 0.5) * 0.7));
    let t = 0;
    for (let o = 0; o < 3; o++) t += perlin(u, v, 0.25, 2 << o, seed + 20 + o) * 0.5 ** o;
    const k = (y * S + x) * 4;
    out[k] = byte(cov); out[k + 1] = byte(t * 0.6 + 0.5); out[k + 2] = byte(0.5 + 0.5 * perlin(u, v, 0.75, 3, seed + 30)); out[k + 3] = 255;
  }
  return { size: S, data: out };
}
