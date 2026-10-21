// Known cameras (src/io/cameras.js): both file conventions against the synthetic set's ground truth,
// the feature-scale conversion, name matching and the random seed volume.
import { readFileSync } from 'fs';
import { parseCameras, reconFromKnownCameras, randomSeedPoints } from '../../src/io/cameras.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  if (!cond) failures++;
};

const gt = JSON.parse(readFileSync(new URL('../../data/synthetic/cameras.json', import.meta.url), 'utf8'));
const project = (c, X, f, fy, cx, cy) => {
  const p = [0, 1, 2].map((r) => c.R[r * 3] * X[0] + c.R[r * 3 + 1] * X[1] + c.R[r * 3 + 2] * X[2] + c.t[r]);
  return [f * p[0] / p[2] + cx, fy * p[1] / p[2] + cy];
};
const pts = [[0, 0, 0], [0.3, -0.2, 0.1], [-0.25, 0.15, -0.2]];

// ---- the repo's ground-truth list ----
{
  const cams = parseCameras(gt);
  check('gt list: one camera per entry', cams.length === gt.cameras.length);
  const c0 = gt.cameras[0], k0 = cams[0];
  check('gt list: R, t, intrinsics carried over',
    k0.R.every((v, i) => v === c0.R_w2c_rowmajor[i]) && k0.t.every((v, i) => v === c0.t_w2c[i]) &&
    k0.fx === c0.fx && k0.cx === c0.cx && k0.w === c0.width);
}

// ---- NeRF / Blender transforms.json built from the same cameras ----
{
  const frames = gt.cameras.map((c) => {
    const R = c.R_w2c_rowmajor, t = c.t_w2c;
    const C = [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2]));
    // c2w (OpenCV) = R^T; OpenGL camera axes flip its y and z columns
    const M = [0, 1, 2].map((r) => [R[r], -R[3 + r], -R[6 + r], C[r]]);
    M.push([0, 0, 0, 1]);
    return { file_path: `./train/${c.image.replace(/\.png$/, '')}`, transform_matrix: M };
  });
  const c0 = gt.cameras[0];
  const json = { camera_angle_x: 2 * Math.atan(c0.width / 2 / c0.fx), frames };
  const cams = parseCameras(json);
  let maxErr = 0;
  cams.forEach((k, i) => {
    const c = gt.cameras[i];
    const ref = { R: c.R_w2c_rowmajor, t: c.t_w2c };
    const fx = c.width / 2 / Math.tan(k.angleX / 2);
    for (const X of pts) {
      const a = project(ref, X, c.fx, c.fy, c.cx, c.cy);
      const b = project(k, X, fx, fx, c.width / 2, c.height / 2);
      maxErr = Math.max(maxErr, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  });
  check('transforms.json: projects like the ground truth', maxErr < 1e-6, `(max ${maxErr.toExponential(2)} px)`);
  check('transforms.json: focal only from camera_angle_x', cams[0].fx === null && Math.abs(cams[0].angleX - json.camera_angle_x) < 1e-12);

  // matched by name without directory or extension; image pixels -> feature scale
  const fakeFrames = gt.cameras.map((c) => ({ name: c.image, fw: c.width / 2, fh: c.height / 2, srcW: c.width, srcH: c.height }));
  const recon = reconFromKnownCameras(fakeFrames, cams);
  const r0 = recon.cams[0];
  check('recon: every frame matched', recon.cams.length === fakeFrames.length);
  check('recon: focal and principal point at feature scale',
    Math.abs(r0.f - c0.fx / 2) < 1e-9 && Math.abs(r0.cx - c0.width / 4) < 1e-9 && Math.abs(r0.cy - c0.height / 4) < 1e-9,
    `(f ${r0.f.toFixed(3)} vs ${c0.fx / 2})`);
  check('recon: flagged as known, seeded at random without points', recon.known === true && recon.points.length === 50000);
}

// ---- the random seed fills what an orbit looks at ----
{
  const ring = Array.from({ length: 12 }, (_, i) => {
    const a = i / 12 * 2 * Math.PI, C = [4 * Math.cos(a), 0.5, 4 * Math.sin(a)];
    const z = C.map((v) => -v / Math.hypot(...C));                       // looking at the origin
    const x = [z[2], 0, -z[0]].map((v, _, s) => v / Math.hypot(...s));    // right = up x forward
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const R = [...x, ...y, ...z];
    const t = [0, 1, 2].map((r) => -(R[r * 3] * C[0] + R[r * 3 + 1] * C[1] + R[r * 3 + 2] * C[2]));
    return { R, t, f: 500, w: 640 };
  });
  const p = randomSeedPoints(ring, 2000);
  const mean = [0, 1, 2].map((k) => p.reduce((s, q) => s + q.X[k], 0) / p.length);
  const rmax = Math.max(...p.map((q) => Math.hypot(...q.X)));
  check('seed: centred on the look-at point', Math.hypot(...mean) < 0.15, `(|mean| ${Math.hypot(...mean).toFixed(3)})`);
  check('seed: inside the viewed radius', rmax < Math.hypot(4, 0.5) * 320 / 500 + 0.02, `(max r ${rmax.toFixed(2)})`);

  let threw = false;
  try { randomSeedPoints(ring.map((c) => ({ ...c, R: ring[0].R })), 10); } catch { threw = true; }
  check('seed: parallel cameras ask for points instead of guessing', threw);
}

let threw = false;
try { reconFromKnownCameras([{ name: 'a.png', fw: 10, fh: 10, srcW: 10, srcH: 10 }], parseCameras(gt)); } catch { threw = true; }
check('recon: too few matches is an error', threw);

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
