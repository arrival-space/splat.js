// cameras.js — cameras from outside the solver: a renderer's ground truth, a rig, an AR session.
//
// Two file conventions are read by parseCameras():
//   - NeRF / Blender transforms.json: frames[].transform_matrix is camera-to-world with OpenGL
//     camera axes (x right, y up, z back); intrinsics fl_x/fl_y/cx/cy/w/h (top level or per frame)
//     or camera_angle_x (horizontal field of view, radians)
//   - this repo's ground-truth list (data/synthetic/cameras.json): cameras[] world-to-camera,
//     OpenCV axes (x right, y down, z forward), R_w2c_rowmajor + t_w2c, fx/fy/cx/cy/width/height
// Both come out as world-to-camera OpenCV cameras in IMAGE pixels: { name, R, t, fx, fy, cx, cy,
// w, h, angleX }, with fx null when only angleX is known (resolved against the image width).
//
// reconFromKnownCameras() turns them into a reconstruction for Session.useReconstruction(). The
// solver's cameras live at FEATURE scale (frame.fw), not at the photo's size: handing image-pixel
// focals to useReconstruction directly trains against wrongly projected targets without an error.

/** Basename without directory or extension, lower case: how cameras are matched to frames. */
export function frameKey(path) {
  return String(path).split(/[\\/]/).pop().replace(/\.[^.]*$/, '').toLowerCase();
}

/** Cameras from a parsed transforms.json or ground-truth cameras.json (see the header). */
export function parseCameras(json) {
  if (Array.isArray(json.frames)) return fromTransforms(json);
  if (Array.isArray(json.cameras)) return fromGroundTruth(json);
  throw new Error('no cameras: expected frames[] (transforms.json) or cameras[] (ground-truth list)');
}

function fromTransforms(json) {
  return json.frames.map((fr) => {
    const k = { ...json, ...fr };
    const M = fr.transform_matrix;
    // camera-to-world rotation with the y and z axes flipped: OpenGL camera -> OpenCV camera
    const c2w = [
      M[0][0], -M[0][1], -M[0][2],
      M[1][0], -M[1][1], -M[1][2],
      M[2][0], -M[2][1], -M[2][2],
    ];
    const C = [M[0][3], M[1][3], M[2][3]];
    const R = [c2w[0], c2w[3], c2w[6], c2w[1], c2w[4], c2w[7], c2w[2], c2w[5], c2w[8]];
    const t = [0, 1, 2].map((r) => -(R[r * 3] * C[0] + R[r * 3 + 1] * C[1] + R[r * 3 + 2] * C[2]));
    return {
      name: fr.file_path, R, t,
      fx: k.fl_x ?? null, fy: k.fl_y ?? k.fl_x ?? null,
      cx: k.cx ?? null, cy: k.cy ?? null,
      w: k.w ?? null, h: k.h ?? null,
      angleX: k.camera_angle_x ?? null,
    };
  });
}

function fromGroundTruth(json) {
  return json.cameras.map((c) => ({
    name: c.image, R: c.R_w2c_rowmajor.slice(), t: c.t_w2c.slice(),
    fx: c.fx, fy: c.fy ?? c.fx, cx: c.cx ?? null, cy: c.cy ?? null,
    w: c.width ?? null, h: c.height ?? null, angleX: null,
  }));
}

/** Camera centre in world coordinates (C = -R^T t). */
function centre(c) {
  const { R, t } = c;
  return [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2]));
}

/** The point closest to every camera's optical axis (least squares), and the cameras' median
 *  distance to it: where a turntable or orbit set is looking. */
function lookAt(cams) {
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0];
  for (const c of cams) {
    const C = centre(c), d = [c.R[6], c.R[7], c.R[8]];   // viewing direction = third row of R
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const m = (i === j ? 1 : 0) - d[i] * d[j];
        A[i * 3 + j] += m;
        b[i] += m * C[j];
      }
    }
  }
  const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det(A);
  if (Math.abs(D) < 1e-9 * cams.length ** 3) {
    throw new Error('the cameras look in parallel, there is no common point to seed around: pass opts.points');
  }
  const p = [0, 1, 2].map((k) => {
    const m = A.slice();
    for (let r = 0; r < 3; r++) m[r * 3 + k] = b[r];
    return det(m) / D;
  });
  const dist = cams.map((c) => Math.hypot(...centre(c).map((v, i) => v - p[i]))).sort((x, y) => x - y);
  return { point: p, distance: dist[dist.length >> 1] };
}

/** Random seed points filling the volume the cameras look at: what 3DGS seeds a synthetic set with
 *  when there is no sparse cloud. A masked set's hull then keeps the ones on the subject. */
export function randomSeedPoints(cams, n = 50000, seed = 1) {
  const { point, distance } = lookAt(cams);
  const halfFov = Math.min(...cams.map((c) => Math.atan(c.w / 2 / c.f)));
  const r = distance * Math.tan(halfFov);
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [];
  while (out.length < n) {
    const v = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    if (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > 1) continue;
    out.push({ X: v.map((x, i) => point[i] + x * r), rgb: [0.5, 0.5, 0.5] });
  }
  return out;
}

/** A reconstruction for Session.useReconstruction() from known cameras and decoded frames.
 *  Cameras are matched to frames by file name (frameKey) and scaled from image pixels to the
 *  frames' feature scale. opts.points: seed points [{ X: [x,y,z], rgb: [r,g,b] 0..1 }]; without
 *  them the viewed volume is filled at random (randomSeedPoints). */
export function reconFromKnownCameras(frames, cameras, opts = {}) {
  const byName = new Map(cameras.map((c) => [frameKey(c.name), c]));
  const cams = [];
  frames.forEach((fr, imgIdx) => {
    const c = byName.get(frameKey(fr.name));
    if (!c) return;
    const w = c.w ?? fr.srcW, h = c.h ?? fr.srcH;
    const fx = c.fx ?? (c.angleX != null ? w / 2 / Math.tan(c.angleX / 2) : null);
    if (fx == null) throw new Error(`camera ${c.name}: no focal length (fl_x / fx / camera_angle_x)`);
    const s = fr.fw / w;
    cams.push({
      imgIdx, R: c.R.slice(), t: c.t.slice(),
      f: fx * s, fy: (c.fy ?? fx) * s,
      cx: (c.cx ?? w / 2) * s, cy: (c.cy ?? h / 2) * s,
      w: fr.fw, h: fr.fh,
    });
  });
  if (cams.length < 2) throw new Error(`only ${cams.length} of ${frames.length} frames have a camera (matched by file name)`);
  const points = opts.points && opts.points.length ? opts.points : randomSeedPoints(cams, opts.seedCount);
  return { cams, points, known: true };
}
