// shaders.js — WGSL for the WebGPU 3DGS trainer.
//
// Rasterization is standard 3DGS: anisotropic Gaussians (per-axis scale +
// rotation quaternion), EWA projection to a 2D covariance, GLOBAL sorted
// binning (count -> prefix scan -> scatter into exact-size per-tile segments
// -> per-segment depth sort; no per-tile capacity cap), sorted front-to-back
// alpha compositing, and the matching back-to-front transmittance-recursion
// backward pass with the full covariance chain rule
// (conic -> 2D cov -> 3D cov -> scales/quaternion, incl. the J position term).
//
// Remaining prototype simplifications vs. reference 3DGS:
//  * Charbonnier loss (no SSIM)
//
// Gaussian parameter layout (stride 16 f32):
//   [0-2 pos, 3-5 logScale xyz, 6-9 quat (w,x,y,z, raw), 10-12 color logits,
//    13 logitOpacity, 14-15 pad]
// View-dependent color (shDeg > 0) lives in a SEPARATE per-splat SH buffer
// (channel-major: K red rest coeffs, K green, K blue). The color model is
//   c(dir) = max(0, sigmoid(logit) + sum_k sh_k Y_k(dir))
// — the DC stays the bounded sigmoid (identical to shDeg 0 when sh == 0),
// the rest bands are the STANDARD basis in color space, so the PLY export is
// exact: f_dc = (sigmoid(logit) - 0.5)/C0, f_rest_k = sh_k.
// Per-frame projected layout (stride 16 f32):
//   [0 meanX, 1 meanY, 2 depth, 3 conicA, 4 conicB, 5 conicC, 6 comp,
//    7 opacity, 8-10 rgb, 11 visible flag, 12-14 cov2D (a,b,c), 15 radius]
// Screen-space gradient accumulator (stride 16 atomic<i32>, fixed point):
//   [0 dMeanX, 1 dMeanY, 2 dConicA, 3 dConicB, 4 dConicC, 5 dComp,
//    6 dLogitOpacity, 7-9 dRGB]
// Entry buffer (interleaved pairs): [2k] = depth key (f32 bits), [2k+1] = id.

export const STRIDE = 16;
export const TILE = 16;
export const SHARED_SORT = 2048;    // shared-memory sort fast path (16KB workgroup mem)
export const ENTRIES_CAP = 12000000; // global (key,id) pair budget across all tiles (96MB)
export const FIXED = 16384.0;
// same scale as FIXED since the render pass normalizes conic grads by
// (1 + rad^2) per splat (they are px^2-scaled otherwise; the old coarser
// 4096 scale still hit the i32 ceiling on big splats at native res)
export const FIXED_CONIC = 16384.0;

// Cutoffs (parameterized so gradcheck can use a "strict" variant whose
// boundary discontinuities are negligible): E_CUT is the Gaussian exponent
// cutoff, A_MIN the minimum alpha, RADM the matching binning radius in sigmas.
export const DEFAULT_E_CUT = 4.5;
export const DEFAULT_A_MIN = 0.0039;
// RC (binning radius clamp, fraction of image width) defaults to full frame:
// clamping smaller shows up as square-clipped splats when the camera gets
// close (the Gaussian renders only inside its binned tiles).
// MIPCOMP false = classic-3DGS / Brush semantics: the dilated footprint is
// rendered at the raw opacity (thinning splats keep their weight instead of
// fading toward gradient death) — what every external rasterizer does.
const cutConsts = (E, A, RC = 1.0, D = 0.3, C = true) => /* wgsl */ `
const E_CUT = ${E.toExponential()};
const A_MIN = ${A.toExponential()};
const RADM = ${Math.sqrt(2 * E).toExponential()};
const RADCL = ${RC.toExponential()};
const DILATE = ${D.toExponential()};
const MIPCOMP = ${C ? 'true' : 'false'};
`;

// ---- spherical harmonics (view-dependent color) ----
// Real SH basis, INRIA constant convention (deg 1-3). Generated per compiled
// degree; the RUNTIME active degree ramps via cam.misc3.x (INRIA-style, one
// band per 1000 iters) — inactive bands contribute nothing and get 0 grads.
const SH_C1 = 0.4886025119029199;
const SH_C2 = [1.0925484305920792, -1.0925484305920792, 0.31539156525252005,
  -1.0925484305920792, 0.5462742152960396];
const SH_C3 = [-0.5900435899266435, 2.890611442640554, -0.4570457994644658,
  0.3731763325901154, -0.4570457994644658, 1.445305721320277, -0.5900435899266435];
export const shRestCoefs = (deg) => (deg + 1) * (deg + 1) - 1;

// WGSL: basis values Y_k(v) and (for the chain pass) their gradients dY_k/dv
// at a unit direction v. Emitted only for shDeg >= 1 compiles.
const shFns = (deg) => {
  const K = shRestCoefs(deg);
  const e = (v) => v.toExponential();
  let y = `
  Y[0] = ${e(-SH_C1)} * y;
  Y[1] = ${e(SH_C1)} * z;
  Y[2] = ${e(-SH_C1)} * x;`;
  let dy = `
  D[0] = vec3f(0.0, ${e(-SH_C1)}, 0.0);
  D[1] = vec3f(0.0, 0.0, ${e(SH_C1)});
  D[2] = vec3f(${e(-SH_C1)}, 0.0, 0.0);`;
  if (deg >= 2) {
    y += `
  Y[3] = ${e(SH_C2[0])} * x * y;
  Y[4] = ${e(SH_C2[1])} * y * z;
  Y[5] = ${e(SH_C2[2])} * (2.0 * zz - xx - yy);
  Y[6] = ${e(SH_C2[3])} * x * z;
  Y[7] = ${e(SH_C2[4])} * (xx - yy);`;
    dy += `
  D[3] = ${e(SH_C2[0])} * vec3f(y, x, 0.0);
  D[4] = ${e(SH_C2[1])} * vec3f(0.0, z, y);
  D[5] = ${e(SH_C2[2])} * vec3f(-2.0 * x, -2.0 * y, 4.0 * z);
  D[6] = ${e(SH_C2[3])} * vec3f(z, 0.0, x);
  D[7] = ${e(SH_C2[4])} * vec3f(2.0 * x, -2.0 * y, 0.0);`;
  }
  if (deg >= 3) {
    y += `
  Y[8]  = ${e(SH_C3[0])} * y * (3.0 * xx - yy);
  Y[9]  = ${e(SH_C3[1])} * x * y * z;
  Y[10] = ${e(SH_C3[2])} * y * (4.0 * zz - xx - yy);
  Y[11] = ${e(SH_C3[3])} * z * (2.0 * zz - 3.0 * xx - 3.0 * yy);
  Y[12] = ${e(SH_C3[4])} * x * (4.0 * zz - xx - yy);
  Y[13] = ${e(SH_C3[5])} * z * (xx - yy);
  Y[14] = ${e(SH_C3[6])} * x * (xx - 3.0 * yy);`;
    dy += `
  D[8]  = ${e(SH_C3[0])} * vec3f(6.0 * x * y, 3.0 * xx - 3.0 * yy, 0.0);
  D[9]  = ${e(SH_C3[1])} * vec3f(y * z, x * z, x * y);
  D[10] = ${e(SH_C3[2])} * vec3f(-2.0 * x * y, 4.0 * zz - xx - 3.0 * yy, 8.0 * y * z);
  D[11] = ${e(SH_C3[3])} * vec3f(-6.0 * x * z, -6.0 * y * z, 6.0 * zz - 3.0 * xx - 3.0 * yy);
  D[12] = ${e(SH_C3[4])} * vec3f(4.0 * zz - 3.0 * xx - yy, -2.0 * x * y, 8.0 * x * z);
  D[13] = ${e(SH_C3[5])} * vec3f(2.0 * x * z, -2.0 * y * z, xx - yy);
  D[14] = ${e(SH_C3[6])} * vec3f(3.0 * xx - 3.0 * yy, -6.0 * x * y, 0.0);`;
  }
  const pre = deg >= 2
    ? 'let x = v.x; let y = v.y; let z = v.z;\n  let xx = x * x; let yy = y * y; let zz = z * z;'
    : 'let x = v.x; let y = v.y; let z = v.z;';
  return /* wgsl */ `
const SHK = ${K}u;
fn shActiveK() -> u32 {
  let ad = u32(cam.misc3.x + 0.5);
  return min((ad + 1u) * (ad + 1u) - 1u, ${K}u);
}
fn camPosWorld() -> vec3f {
  return -vec3f(
    cam.R0.x * cam.t.x + cam.R1.x * cam.t.y + cam.R2.x * cam.t.z,
    cam.R0.y * cam.t.x + cam.R1.y * cam.t.y + cam.R2.y * cam.t.z,
    cam.R0.z * cam.t.x + cam.R1.z * cam.t.y + cam.R2.z * cam.t.z);
}
fn shBasis(v: vec3f) -> array<f32, ${K}> {
  var Y: array<f32, ${K}>;
  ${pre}${y}
  return Y;
}
fn shBasisGrad(v: vec3f) -> array<vec3f, ${K}> {
  var D: array<vec3f, ${K}>;
  ${pre}${dy}
  return D;
}
`;
};

const CAM_STRUCT = /* wgsl */ `
struct Cam {
  R0: vec4f,      // row 0 of world-to-cam rotation
  R1: vec4f,
  R2: vec4f,
  t: vec4f,       // xyz = translation, w = near plane
  proj: vec4f,    // x = focal(px), y = cx, z = cy, w = exposure gain
  size: vec4f,    // x = width, y = height, z = tilesX, w = numGaussians
  misc: vec4f,    // xyz = background color, w = target offset (u32 bits)
  misc2: vec4f,   // x = trainMode (1/0), y = camera index, z = numCams, w = exposure bias
  misc3: vec4f,   // x = active SH degree, z = fy (0 = fx; cameras with
                  //     fx != fy: non-uniformly resized datasets, COLMAP PINHOLE)
};
@group(0) @binding(0) var<uniform> cam: Cam;
const TILEF = ${TILE}.0;
const SHSORT = ${SHARED_SORT}u;
override ENTCAP: u32 = ${ENTRIES_CAP}u;
override FIXED: f32 = ${FIXED.toExponential()}; // gradient fixed-point scale (opts.gradFixed probes precision)
const FIXEDC = ${FIXED_CONIC.toExponential()};
const FIXCAM = 64.0; // camera grads sum over all splats: coarse fixed point
// error-mass accumulators (gradP slots 10/11) integrate across a whole refine
// window (up to ~500 iters x screen-area pixels), so the quantum is coarse to
// keep the i32 ceiling out of reach; they only feed donor SAMPLING weights
const WFIX = 8.0;
`;

// Shared per-splat geometry: params -> normalized quat, rotation, cam-space
// point, projection T = J*W, 2D covariance (va, vb, vc). Used identically by
// project and chain so both see the same forward quantities.
const GEOM_FNS = /* wgsl */ `
struct Geom {
  ok: f32,
  pc: vec3f,          // cam-space point
  q: vec4f,           // normalized quat (w,x,y,z)
  r0: vec3f, r1: vec3f, r2: vec3f,   // rows of R(q)
  s: vec3f,           // scales
  t0: vec3f, t1: vec3f,              // rows of T = J*W
  va: f32, vb: f32, vc: f32,         // 2D covariance
  s00: f32, s01: f32, s02: f32, s11: f32, s12: f32, s22: f32, // 3D cov
  cx: f32, cy: f32,   // frustum-clamped cam-space x, y as used in J
  inx: f32, iny: f32, // 1 when unclamped (gradient flows through J's x/y)
};

fn computeGeom(pbase: u32) -> Geom {
  var g: Geom;
  g.ok = 0.0;
  let p = vec3f(params[pbase], params[pbase + 1u], params[pbase + 2u]);
  g.pc = vec3f(dot(cam.R0.xyz, p), dot(cam.R1.xyz, p), dot(cam.R2.xyz, p)) + cam.t.xyz;
  if (g.pc.z < cam.t.w) { return g; }

  var q = vec4f(params[pbase + 6u], params[pbase + 7u], params[pbase + 8u], params[pbase + 9u]);
  let ql = length(q);
  if (ql < 1e-6) { q = vec4f(1.0, 0.0, 0.0, 0.0); } else { q = q / ql; }
  g.q = q;
  let qw = q.x; let qx = q.y; let qy = q.z; let qz = q.w;
  g.r0 = vec3f(1.0 - 2.0 * (qy * qy + qz * qz), 2.0 * (qx * qy - qw * qz), 2.0 * (qx * qz + qw * qy));
  g.r1 = vec3f(2.0 * (qx * qy + qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz), 2.0 * (qy * qz - qw * qx));
  g.r2 = vec3f(2.0 * (qx * qz - qw * qy), 2.0 * (qy * qz + qw * qx), 1.0 - 2.0 * (qx * qx + qy * qy));

  g.s = vec3f(
    exp(clamp(params[pbase + 3u], -12.0, 6.0)),
    exp(clamp(params[pbase + 4u], -12.0, 6.0)),
    exp(clamp(params[pbase + 5u], -12.0, 6.0)));

  // M = R * diag(s); Sigma3D = M M^T
  let m0 = g.r0 * g.s;
  let m1 = g.r1 * g.s;
  let m2 = g.r2 * g.s;
  g.s00 = dot(m0, m0); g.s01 = dot(m0, m1); g.s02 = dot(m0, m2);
  g.s11 = dot(m1, m1); g.s12 = dot(m1, m2); g.s22 = dot(m2, m2);

  // T = J * W (2x3): J = [[f/z, 0, -f x/z^2], [0, f/z, -f y/z^2]].
  // J is evaluated at a frustum-CLAMPED x, y (1.3x the half-FOV, the
  // reference rasterizer's guard): outside the view cone the linearization
  // point runs away and the 2D covariance explodes into screen-sized
  // quads that leak back into frame — in the interactive view AND in
  // every training render whose frustum the splat sits just outside of.
  let fx = cam.proj.x;
  let fy = select(fx, cam.misc3.z, cam.misc3.z > 0.0);
  let iz = 1.0 / g.pc.z;
  let limx = 1.3 * 0.5 * cam.size.x / fx;
  let limy = 1.3 * 0.5 * cam.size.y / fy;
  let txz = g.pc.x * iz;
  let tyz = g.pc.y * iz;
  g.cx = clamp(txz, -limx, limx) * g.pc.z;
  g.cy = clamp(tyz, -limy, limy) * g.pc.z;
  g.inx = select(0.0, 1.0, abs(txz) <= limx);
  g.iny = select(0.0, 1.0, abs(tyz) <= limy);
  g.t0 = (fx * iz) * cam.R0.xyz + (-fx * g.cx * iz * iz) * cam.R2.xyz;
  g.t1 = (fy * iz) * cam.R1.xyz + (-fy * g.cy * iz * iz) * cam.R2.xyz;

  // V = T Sigma T^T
  let st0 = vec3f(
    g.s00 * g.t0.x + g.s01 * g.t0.y + g.s02 * g.t0.z,
    g.s01 * g.t0.x + g.s11 * g.t0.y + g.s12 * g.t0.z,
    g.s02 * g.t0.x + g.s12 * g.t0.y + g.s22 * g.t0.z);
  let st1 = vec3f(
    g.s00 * g.t1.x + g.s01 * g.t1.y + g.s02 * g.t1.z,
    g.s01 * g.t1.x + g.s11 * g.t1.y + g.s12 * g.t1.z,
    g.s02 * g.t1.x + g.s12 * g.t1.y + g.s22 * g.t1.z);
  g.va = max(dot(g.t0, st0), 0.0);
  g.vb = dot(g.t1, st0);
  g.vc = max(dot(g.t1, st1), 0.0);
  g.ok = 1.0;
  return g;
}
`;

// Pass 1: project each splat and COUNT the tiles it touches.
// dc: 'sigmoid' (legacy bounded DC) | 'sh' (v2: standard unbounded SH-DC,
// col = C0*dc + 0.5 — matches the PLY convention directly)
export const makeProjectSrc = (E = DEFAULT_E_CUT, A = DEFAULT_A_MIN, RC = 1.0, shDeg = 0, dc = 'sigmoid', D = 0.3, C = true) =>
  CAM_STRUCT + cutConsts(E, A, RC, D, C) + /* wgsl */ `
@group(0) @binding(1) var<storage, read> params: array<f32>;
@group(0) @binding(2) var<storage, read_write> proj: array<f32>;
@group(0) @binding(3) var<storage, read_write> tileCnt: array<atomic<u32>>;
` + (shDeg > 0 ? `@group(0) @binding(4) var<storage, read> sh: array<f32>;\n` : '')
  + GEOM_FNS + (shDeg > 0 ? shFns(shDeg) : '') + /* wgsl */ `
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(cam.size.w)) { return; }
  let b = i * 16u;
  proj[b + 11u] = 0.0; // culled until proven visible

  let g = computeGeom(b);
  if (g.ok < 0.5) { return; }

  let detV = max(g.va * g.vc - g.vb * g.vb, 0.0);
  let ad = g.va + DILATE;
  let cd = g.vc + DILATE;
  let detVd = ad * cd - g.vb * g.vb;
  if (detVd < 1e-8) { return; }
  // Mip-Splatting opacity compensation: dilation must not add energy
  let comp = select(1.0, sqrt(max(detV / detVd, 0.0)), MIPCOMP);
  let opa = 1.0 / (1.0 + exp(-clamp(params[b + 13u], -9.0, 9.0)));
  if (opa * comp < A_MIN) { return; }

  let fx = cam.proj.x;
  let fy = select(fx, cam.misc3.z, cam.misc3.z > 0.0);
  let mx = fx * g.pc.x / g.pc.z + cam.proj.y;
  let my = fy * g.pc.y / g.pc.z + cam.proj.z;
  // bounding radius from the largest eigenvalue of the dilated covariance,
  // shrunk opacity-aware: bin only where alpha can still exceed A_MIN
  let mid = 0.5 * (ad + cd);
  let disc = sqrt(max(mid * mid - detVd, 0.0));
  let eMax = min(E_CUT, log(max(opa * comp / A_MIN, 1.0001)));
  let rad = min(sqrt(2.0 * eMax) * sqrt(mid + disc), RADCL * cam.size.x);
  let W = cam.size.x;
  let H = cam.size.y;
  if (mx + rad < 0.0 || my + rad < 0.0 || mx - rad > W || my - rad > H) { return; }

  let inv = 1.0 / detVd;
  proj[b]       = mx;
  proj[b + 1u]  = my;
  proj[b + 2u]  = g.pc.z;
  proj[b + 3u]  = cd * inv;        // conic A
  proj[b + 4u]  = -g.vb * inv;     // conic B
  proj[b + 5u]  = ad * inv;        // conic C
  proj[b + 6u]  = comp;
  proj[b + 7u]  = opa;
${dc === 'sh' ? /* wgsl */ `
  var col = 0.28209479 * vec3f(params[b + 10u], params[b + 11u], params[b + 12u]) + vec3f(0.5);
` : /* wgsl */ `
  var col = vec3f(
    1.0 / (1.0 + exp(-clamp(params[b + 10u], -9.0, 9.0))),
    1.0 / (1.0 + exp(-clamp(params[b + 11u], -9.0, 9.0))),
    1.0 / (1.0 + exp(-clamp(params[b + 12u], -9.0, 9.0))));
`}
${shDeg > 0 ? /* wgsl */ `
  // view-dependent color: SH rest bands added to the sigmoid DC, clamp at 0
  {
    let un = vec3f(params[b], params[b + 1u], params[b + 2u]) - camPosWorld();
    let v = un / max(length(un), 1e-9);
    var Y = shBasis(v);
    let aK = shActiveK();
    let sb = i * ${3 * shRestCoefs(shDeg)}u;
    for (var k = 0u; k < aK; k++) {
      col += vec3f(sh[sb + k], sh[sb + SHK + k], sh[sb + 2u * SHK + k]) * Y[k];
    }
    col = max(col, vec3f(0.0));
  }` : ''}
  proj[b + 8u]  = col.x;
  proj[b + 9u]  = col.y;
  proj[b + 10u] = col.z;
  proj[b + 11u] = 1.0;
  proj[b + 12u] = g.va;
  proj[b + 13u] = g.vb;
  proj[b + 14u] = g.vc;
  proj[b + 15u] = rad;

  let tilesX = u32(cam.size.z);
  let tilesY = u32(ceil(H / TILEF));
  let tx0 = u32(clamp(floor((mx - rad) / TILEF), 0.0, f32(tilesX - 1u)));
  let tx1 = u32(clamp(floor((mx + rad) / TILEF), 0.0, f32(tilesX - 1u)));
  let ty0 = u32(clamp(floor((my - rad) / TILEF), 0.0, f32(tilesY - 1u)));
  let ty1 = u32(clamp(floor((my + rad) / TILEF), 0.0, f32(tilesY - 1u)));
  for (var ty = ty0; ty <= ty1; ty++) {
    for (var tx = tx0; tx <= tx1; tx++) {
      atomicAdd(&tileCnt[ty * tilesX + tx], 1u);
    }
  }
}
`;

// Pass 2: single-workgroup two-level exclusive scan over per-tile counts.
// Segments over SHSORT get padded to the next power of two so the global
// bitonic path has real padding slots. Writes tileStart (segment starts,
// +1 sentinel), initializes tileCursor, flags overflow in stats[3].
export const SCAN_SRC = CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read> tileCnt: array<u32>;
@group(0) @binding(2) var<storage, read_write> tileStart: array<u32>;
@group(0) @binding(3) var<storage, read_write> tileCursor: array<u32>;
@group(0) @binding(4) var<storage, read_write> stats: array<atomic<u32>>;

const CHUNK = 64u; // 256 threads x 64 = up to 16384 tiles
var<workgroup> sums: array<u32, 256>;

fn paddedSize(c: u32) -> u32 {
  if (c <= SHSORT) { return c; }
  return 1u << (32u - countLeadingZeros(c - 1u));
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let tilesX = u32(cam.size.z);
  let tilesY = u32(ceil(cam.size.y / TILEF));
  let numTiles = tilesX * tilesY;

  var local = 0u;
  for (var k = 0u; k < CHUNK; k++) {
    let t = li * CHUNK + k;
    if (t < numTiles) { local += paddedSize(tileCnt[t]); }
  }
  sums[li] = local;
  workgroupBarrier();
  if (li == 0u) {
    var acc = 0u;
    for (var k = 0u; k < 256u; k++) {
      let v = sums[k];
      sums[k] = acc;
      acc += v;
    }
  }
  workgroupBarrier();
  var acc = sums[li];
  for (var k = 0u; k < CHUNK; k++) {
    let t = li * CHUNK + k;
    if (t >= numTiles) { break; }
    var p = paddedSize(tileCnt[t]);
    if (acc + p > ENTCAP) { // out of entry budget: drop this tile, flag it
      p = 0u;
      atomicAdd(&stats[3], 1u);
    }
    tileStart[t] = acc;
    tileCursor[t] = acc;
    // dropped tiles get zero-length segments (start == next start)
    if (p == 0u && tileCnt[t] > 0u) { tileStart[t] = acc; }
    acc += p;
    if (t == numTiles - 1u) { tileStart[numTiles] = acc; }
  }
}
`;

// Pass 3: scatter (depthKey, id) pairs into each splat's tiles (bounds from
// the proj buffer, identical to the count pass).
export const SCATTER_SRC = CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read> proj: array<f32>;
@group(0) @binding(2) var<storage, read_write> tileCursor: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> entries: array<u32>;
@group(0) @binding(4) var<storage, read> tileStart: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(cam.size.w)) { return; }
  let b = i * 16u;
  if (proj[b + 11u] <= 0.0) { return; }
  let mx = proj[b];
  let my = proj[b + 1u];
  let rad = proj[b + 15u];
  let key = bitcast<u32>(proj[b + 2u]); // positive depth: bits are monotonic

  let tilesX = u32(cam.size.z);
  let tilesY = u32(ceil(cam.size.y / TILEF));
  let tx0 = u32(clamp(floor((mx - rad) / TILEF), 0.0, f32(tilesX - 1u)));
  let tx1 = u32(clamp(floor((mx + rad) / TILEF), 0.0, f32(tilesX - 1u)));
  let ty0 = u32(clamp(floor((my - rad) / TILEF), 0.0, f32(tilesY - 1u)));
  let ty1 = u32(clamp(floor((my + rad) / TILEF), 0.0, f32(tilesY - 1u)));
  let numTiles = tilesX * tilesY;
  for (var ty = ty0; ty <= ty1; ty++) {
    for (var tx = tx0; tx <= tx1; tx++) {
      let t = ty * tilesX + tx;
      // zero-length segments (budget-dropped tiles) take no entries
      if (tileStart[t + 1u] == tileStart[t]) { continue; }
      let pos = atomicAdd(&tileCursor[t], 1u);
      entries[2u * pos] = key;
      entries[2u * pos + 1u] = i;
    }
  }
}
`;

// Pass 4: sort each tile segment front-to-back (key asc, id tie-break).
// Fast path: bitonic in shared memory (<= SHSORT entries). Large segments:
// bitonic in global memory over the pow2-padded segment.
export const SORT_SRC = /* wgsl */ `
@group(0) @binding(0) var<storage, read> tileStart: array<u32>;
@group(0) @binding(1) var<storage, read> tileCursor: array<u32>;
@group(0) @binding(2) var<storage, read_write> entries: array<u32>;

const SHSORT = ${SHARED_SORT}u;
var<workgroup> sk: array<u32, ${SHARED_SORT}>;
var<workgroup> sv: array<u32, ${SHARED_SORT}>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3u,
        @builtin(local_invocation_index) li: u32) {
  let tile = wg.x;
  let s = tileStart[tile];
  let segCap = tileStart[tile + 1u] - s; // pow2 for large segments
  if (segCap == 0u) { return; }
  let cnt = tileCursor[tile] - s;

  if (cnt <= SHSORT) {
    // ---- shared-memory bitonic over SHSORT slots ----
    for (var i = li; i < SHSORT; i += 256u) {
      if (i < cnt) {
        sk[i] = entries[2u * (s + i)];
        sv[i] = entries[2u * (s + i) + 1u];
      } else {
        sk[i] = 0xFFFFFFFFu;
        sv[i] = 0xFFFFFFFFu;
      }
    }
    workgroupBarrier();
    for (var k = 2u; k <= SHSORT; k = k << 1u) {
      for (var j = k >> 1u; j > 0u; j = j >> 1u) {
        for (var i = li; i < SHSORT; i += 256u) {
          let l = i ^ j;
          if (l > i) {
            let asc = (i & k) == 0u;
            let gt = sk[i] > sk[l] || (sk[i] == sk[l] && sv[i] > sv[l]);
            if (gt == asc) {
              let tk = sk[i]; sk[i] = sk[l]; sk[l] = tk;
              let tv = sv[i]; sv[i] = sv[l]; sv[l] = tv;
            }
          }
        }
        workgroupBarrier();
      }
    }
    for (var i = li; i < cnt; i += 256u) {
      entries[2u * (s + i)] = sk[i];
      entries[2u * (s + i) + 1u] = sv[i];
    }
    return;
  }

  // ---- global-memory bitonic over the pow2-padded segment ----
  for (var i = li; i < segCap; i += 256u) {
    if (i >= cnt) {
      entries[2u * (s + i)] = 0xFFFFFFFFu;
      entries[2u * (s + i) + 1u] = 0xFFFFFFFFu;
    }
  }
  storageBarrier();
  for (var k = 2u; k <= segCap; k = k << 1u) {
    for (var j = k >> 1u; j > 0u; j = j >> 1u) {
      for (var i = li; i < segCap; i += 256u) {
        let l = i ^ j;
        if (l > i) {
          let asc = (i & k) == 0u;
          let ki = entries[2u * (s + i)];
          let kl = entries[2u * (s + l)];
          let vi = entries[2u * (s + i) + 1u];
          let vl = entries[2u * (s + l) + 1u];
          let gt = ki > kl || (ki == kl && vi > vl);
          if (gt == asc) {
            entries[2u * (s + i)] = kl; entries[2u * (s + l)] = ki;
            entries[2u * (s + i) + 1u] = vl; entries[2u * (s + l) + 1u] = vi;
          }
        }
      }
      storageBarrier();
    }
  }
}
`;

// The render pass comes in two gradient-accumulation flavours:
//   tileGrad=false  every pixel atomicAdds its 10 gradient slots straight to
//                   global memory — fastest on desktop GPUs (L2-side atomics)
//   tileGrad=true   the whole tile walks entries in lockstep, sums each
//                   entry's gradients in on-chip workgroup memory and flushes
//                   ONE global atomicAdd per slot per splat per tile. Apple
//                   (TBDR) GPUs pay dearly for contended global atomics —
//                   this is the difference between ~12 it/s and usable on an
//                   M1. Integer sums commute, so results are bit-identical.
// mode: 0 = fused fwd+bwd (default); 1 = forward only (stores the per-pixel
// walk end for a later backward — the D-SSIM/SSAA passes run in between);
// 2 = backward only (restores C/T/end, mixes the SSIM gradient into gC);
// 3 = backward only for SSAA (this kernel runs at ssaa x the loss res; gC
//     comes from the downsample-loss pass's per-1x-pixel gradient buffer).
export const makeRenderSrc = (E = DEFAULT_E_CUT, A = DEFAULT_A_MIN, tileGrad = false, subgroups = false, mode = 0, ssimW = 0.2, ssaa = 2, D = 0.3, spread = 1,
  // P partial shared accumulators per gradient slot, lane-interleaved (li % P): 256 threads
  // adding to the SAME 13 shared addresses serialize; partials cut same-address collisions
  // P-fold and are summed at the flush. Non-subgroup tile-grad path only. MEASURED
  // 2026-09-06 (truck 1.04M, 979 px): render 10.8 ms at P=1 → 14.4 (P=4) → 15.2 (P=8) —
  // same-address contention is NOT the backward's bottleneck; opt-in, default 1.
  P = subgroups ? 1 : Math.max(1, spread | 0)) =>
  (subgroups ? 'enable subgroups;\n' : '') + CAM_STRUCT + cutConsts(E, A, 1.0, D) + /* wgsl */ `
@group(0) @binding(1) var<storage, read> proj: array<f32>;
@group(0) @binding(2) var<storage, read> tileStart: array<u32>;
@group(0) @binding(3) var<storage, read> entries: array<u32>;
@group(0) @binding(4) var<storage, read> tgtImg: array<u32>; // packed RGBA8, alpha 0 = invalid
@group(0) @binding(5) var<storage, read_write> outImg: array<f32>;
@group(0) @binding(6) var<storage, read_write> gradP: array<atomic<i32>>;
@group(0) @binding(7) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> gradCam: array<atomic<i32>>;
${mode === 1 ? '@group(0) @binding(9) var<storage, read_write> endBuf: array<u32>;' : ''}
${mode === 2 ? `@group(0) @binding(9) var<storage, read> endBuf: array<u32>;
@group(0) @binding(10) var<storage, read> gssim: array<f32>;
const SSIMW = ${ssimW};` : ''}
${mode === 3 ? `@group(0) @binding(9) var<storage, read> endBuf: array<u32>;
@group(0) @binding(10) var<storage, read> gloss: array<f32>;
const SSAA = ${ssaa}u;` : ''}

fn camAdd(idx: u32, v: f32) {
  atomicAdd(&gradCam[idx], i32(round(clamp(v * FIXCAM, -1.0e9, 1.0e9))));
}
` + (tileGrad ? /* wgsl */ `
var<workgroup> wgEnd: atomic<u32>;
var<workgroup> wgEndU: u32;
var<workgroup> sg: array<atomic<i32>, ${13 * P}>; // 0-9 grads, 10-11 error mass, 12 grad-stat (x P partials)
var<private> sgPart: u32;
` + (mode === 0 ? /* wgsl */ `
var<workgroup> wgErr: atomic<u32>;   // robust-loss tile vote: residual sum (x4096)
var<workgroup> wgValid: atomic<u32>; // and its valid-pixel count
` : '') + (subgroups ? /* wgsl */ `
// LichtFeld-style warp aggregation (their #1675: 13.6 -> 1.1 ms on the
// analogous kernel): every thread in the lockstep walk adds to the SAME
// sg[slot], a 256-way serialized atomic. Sum across the subgroup first —
// one atomic per subgroup — and quantize the aggregate (less noise too).
// MUST be called in UNIFORM control flow (WGSL validation rejects subgroup
// builtins in divergent flow): callers accumulate into locals and flush
// unconditionally, zeros contributing nothing to the sum.
fn atomAdd(slot: u32, v: f32) {
  let s = subgroupAdd(v);
  if (subgroupElect() && s != 0.0) {
    atomicAdd(&sg[slot], i32(round(clamp(s * FIXED, -1.0e9, 1.0e9))));
  }
}
fn atomAddC(slot: u32, v: f32) {
  let s = subgroupAdd(v);
  if (subgroupElect() && s != 0.0) {
    atomicAdd(&sg[slot], i32(round(clamp(s * FIXEDC, -1.0e9, 1.0e9))));
  }
}
fn atomAddW(slot: u32, v: f32) {
  let s = subgroupAdd(v);
  if (subgroupElect() && s != 0.0) {
    atomicAdd(&sg[slot], i32(round(clamp(s * WFIX, 0.0, 1.0e9))));
  }
}
` : /* wgsl */ `
fn atomAdd(slot: u32, v: f32) {
  atomicAdd(&sg[slot * ${P}u + sgPart], i32(round(clamp(v * FIXED, -1.0e9, 1.0e9))));
}
fn atomAddC(slot: u32, v: f32) {
  atomicAdd(&sg[slot * ${P}u + sgPart], i32(round(clamp(v * FIXEDC, -1.0e9, 1.0e9))));
}
fn atomAddW(slot: u32, v: f32) {
  atomicAdd(&sg[slot * ${P}u + sgPart], i32(round(clamp(v * WFIX, 0.0, 1.0e9))));
}
`) : /* wgsl */ `
fn atomAdd(idx: u32, v: f32) {
  atomicAdd(&gradP[idx], i32(round(clamp(v * FIXED, -1.0e9, 1.0e9))));
}
fn atomAddC(idx: u32, v: f32) {
  atomicAdd(&gradP[idx], i32(round(clamp(v * FIXEDC, -1.0e9, 1.0e9))));
}
fn atomAddW(idx: u32, v: f32) {
  atomicAdd(&gradP[idx], i32(round(clamp(v * WFIX, 0.0, 1.0e9))));
}
`) + /* wgsl */ `
// i32() truncates toward zero — a systematic shrink of every accumulated
// gradient quantum, worst exactly where residuals are small; round() is
// zero-mean. (The PSNR accumulator already dithers for the same reason.)

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u,
        @builtin(workgroup_id) wid: vec3u,
        @builtin(local_invocation_index) li: u32) {
${tileGrad ? `  sgPart = li % ${P}u;` : ''}
  let W = u32(cam.size.x);
  let H = u32(cam.size.y);
${tileGrad ? '  let pxOk = g.x < W && g.y < H;' : '  if (g.x >= W || g.y >= H) { return; }'}
  let px = vec2f(f32(g.x) + 0.5, f32(g.y) + 0.5);
  let tile = wid.y * u32(cam.size.z) + wid.x;
  let segS = tileStart[tile];
  let segE = tileStart[tile + 1u];

${mode >= 2 ? /* wgsl */ `
  // ---- backward-only: forward state restored from outImg / endBuf ----
  let pi = g.y * W + g.x;
  var T = 1.0;
  var end = segS;
  var C = vec3f(0.0);
` + (tileGrad ? '  if (pxOk) {' : '  {') + /* wgsl */ `
    C = vec3f(outImg[pi * 4u], outImg[pi * 4u + 1u], outImg[pi * 4u + 2u]);
    T = 1.0 - outImg[pi * 4u + 3u];
    end = endBuf[pi];
  }
  let bg = cam.misc.xyz;
` : /* wgsl */ `
  // ---- forward: sorted front-to-back alpha compositing ----
  var T = 1.0;
  var Crgb = vec3f(0.0);
  var end = segS; // one past the last processed entry
` + (tileGrad ? '  if (pxOk) {' : '  {') + /* wgsl */ `
  for (var k = segS; k < segE; k++) {
    if (entries[2u * k] == 0xFFFFFFFFu) { break; } // segment padding
    end = k + 1u;
    let i = entries[2u * k + 1u];
    let b = i * 16u;
    let d = px - vec2f(proj[b], proj[b + 1u]);
    // cut at the BINNED radius too: when rad hits the RADCL clamp the splat
    // is absent from farther tiles, and evaluating its (still-visible) tail
    // only inside binned tiles steps the image at tile boundaries — the
    // circular cut moves that edge off the tile grid. Unclamped rad
    // circumscribes the E_CUT ellipse, so nothing changes in the normal case.
    let rr = proj[b + 15u];
    if (dot(d, d) > rr * rr) { continue; }
    let e = max(0.5 * (proj[b + 3u] * d.x * d.x + proj[b + 5u] * d.y * d.y) + proj[b + 4u] * d.x * d.y, 0.0);
    if (e > E_CUT) { continue; }
    let araw = proj[b + 7u] * proj[b + 6u] * exp(-e);
    let alpha = min(0.99, araw);
    if (alpha < A_MIN) { continue; }
    Crgb += T * alpha * vec3f(proj[b + 8u], proj[b + 9u], proj[b + 10u]);
    T *= 1.0 - alpha;
    if (T < 1e-4) { break; }
  }
  }
  let bg = cam.misc.xyz;
  let C = Crgb + T * bg;
  let pi = g.y * W + g.x;
` + (tileGrad ? '  if (pxOk) {' : '  {') + /* wgsl */ `
  outImg[pi * 4u]      = C.r;
  outImg[pi * 4u + 1u] = C.g;
  outImg[pi * 4u + 2u] = C.b;
  outImg[pi * 4u + 3u] = 1.0 - T;
${mode === 1 ? '  endBuf[pi] = end;' : ''}
  }`}

  if (cam.misc2.x < 0.5) { return; } // uniform: view render, no gradients

  // ---- loss ----
  let off = bitcast<u32>(cam.misc.w); // raw u32 PIXEL offset (f32 exact only to 2^24)
${tileGrad ? '  var lossOk = pxOk;' : '  var lossOk = true;'}
  var gC = vec3f(0.0);
  var perr = 0.0; // this pixel's Charbonnier loss, for the error-mass accumulators
` + (mode === 3 ? /* wgsl */ `
  if (lossOk) {
    // SSAA: per-1x-pixel gradient from the downsample-loss pass, spread
    // evenly over the ssaa^2 render pixels it box-averaged (invalid target
    // pixels already carry zeros in the buffer)
    let W1 = W / SSAA;
    let qi = (g.y / SSAA) * W1 + g.x / SSAA;
    gC = vec3f(gloss[qi * 4u], gloss[qi * 4u + 1u], gloss[qi * 4u + 2u]) * (1.0 / f32(SSAA * SSAA));
    perr = gloss[qi * 4u + 3u];
  }
` : /* wgsl */ `
  if (lossOk) {
    let packed = tgtImg[off + pi];
    if ((packed >> 24u) == 0u) {
      lossOk = false; // invalid pixel (undistortion out-of-frame sentinel)
    } else {
      let tcol = unpack4x8unorm(packed).rgb;
      // per-image exposure compensation (gain = cam.proj.w, bias = cam.misc2.w)
      let gain = cam.proj.w;
      let err = (gain * C + vec3f(cam.misc2.w)) - tcol;
      // Charbonnier (smooth L1); gC = dL/dC up to a constant
      const DELTA = 0.03;
      let root = sqrt(err * err + vec3f(DELTA * DELTA));
      let eg = err / root;         // dL / d(exposure-adjusted color)
${mode === 2 ? /* wgsl */ `      // mix in the D-SSIM gradient (computed by the image passes into
      // gssim, in exposure-adjusted color space): L = (1-w)*L1 + w*(1-S).
      // PLAIN L1 (sign) for the photometric half, matching the reference
      // recipes — charbonnier's gradient decays near convergence, which
      // let the SSIM term dominate late and measured -0.4 dB on garden
      let gs = vec3f(gssim[pi * 4u], gssim[pi * 4u + 1u], gssim[pi * 4u + 2u]);
      gC = gain * ((1.0 - SSIMW) * sign(err) - SSIMW * gs);` : /* wgsl */ `      gC = gain * eg;              // dL / d(rendered color)`}
      let lossv = (root.x + root.y + root.z) - 3.0 * DELTA;
      perr = lossv;
${mode === 2 ? '' : /* wgsl */ `      atomicAdd(&stats[2], 1u); // valid-pixel count (PSNR denominator)
      // squared error for the PSNR metric, DITHERED before quantization: plain
      // truncation zeroes sub-quantum pixels and inflates PSNR above ~40dB
      let dith = fract(sin(f32(pi) * 12.9898) * 43758.5453);
      atomicAdd(&stats[0], u32(dot(err, err) * 16.0 + dith));
      atomicAdd(&stats[1], u32(lossv * 32768.0)); // training loss (grad-check)
      let ci8 = u32(cam.misc2.y) * 8u;
      camAdd(ci8 + 6u, dot(eg, C) * gain); // d/d(log gain)
      camAdd(ci8 + 7u, eg.x + eg.y + eg.z); // d/d(bias)`}
    }
  }
`) + (tileGrad && mode === 0 ? /* wgsl */ `
  // RobustNeRF-style tile vote (misc3.y = threshold, 0 = off): a 16x16 tile
  // whose MEAN residual exceeds kappa x the running mean per-pixel loss
  // (CPU-fed each step) is treated as a transient — a mover, its shadow, a
  // lighting change — and its gradients AND refine error-mass are dropped
  // this step. Tile granularity is RobustNeRF's patch vote: small speculars
  // rarely dominate a whole tile, coherent movers do.
  if (lossOk) {
    atomicAdd(&wgErr, u32(perr * 4096.0));
    atomicAdd(&wgValid, 1u);
  }
  workgroupBarrier();
  if (cam.misc3.y > 0.0) {
    let nv = f32(atomicLoad(&wgValid));
    if (nv > 0.0 && f32(atomicLoad(&wgErr)) / 4096.0 > cam.misc3.y * nv) {
      gC = vec3f(0.0);
      perr = 0.0;
    }
  }
` : '') + (mode === 1 ? /* wgsl */ `
}
` /* forward-only: backward OMITTED (dead code still counts toward the
     per-stage storage-buffer limit); the SSIM passes + bwd kernel follow */
: /* wgsl */ `
${tileGrad ? '' : '  if (!lossOk) { return; }'}

  // ---- backward: back-to-front transmittance recursion ----
  // dC/da_i = c_i T_i - S_i / (1 - a_i),
  // S_i = sum_{k>i} c_k a_k T_k + bg T_N   (everything behind splat i)
${tileGrad ? /* wgsl */ `
  // the whole tile walks the same entries so per-entry sums can live in
  // workgroup memory; pixels beyond their own 'end' simply contribute zero
  atomicMax(&wgEnd, end);
  workgroupBarrier();
  if (li == 0u) { wgEndU = atomicLoad(&wgEnd); }
  let endMax = workgroupUniformLoad(&wgEndU);
` : '  let endMax = end;'}
  var S = bg * T;
  var Ta = T;
  for (var kk = endMax; kk > segS; kk--) {
${tileGrad ? /* wgsl */ `
    if (li < ${13 * P}u) { atomicStore(&sg[li], 0); }
    workgroupBarrier();
` : ''}${tileGrad && subgroups ? /* wgsl */ `
    // subgroup variant only: contributions land in locals so the aggregated
    // flush below runs in UNIFORM control flow (WGSL rejects subgroup
    // builtins in divergent flow — a lesson bought with a dead pipeline)
    var q0 = 0.0; var q1 = 0.0; var q2 = 0.0; var q3 = 0.0; var q4 = 0.0;
    var q5 = 0.0; var q6 = 0.0; var q7 = 0.0; var q8 = 0.0; var q9 = 0.0;
    var q10 = 0.0; var q11 = 0.0; var q12 = 0.0;
` : ''}
    let i = entries[2u * (kk - 1u) + 1u];
    let b = i * 16u;
${tileGrad ? '    if (lossOk && kk <= end) {' : '    {'}
    let d = px - vec2f(proj[b], proj[b + 1u]);
    let cA = proj[b + 3u];
    let cB = proj[b + 4u];
    let cC = proj[b + 5u];
    let rr = proj[b + 15u];
    let e = max(0.5 * (cA * d.x * d.x + cC * d.y * d.y) + cB * d.x * d.y, 0.0);
    // mirrors the forward pass's binned-radius cut exactly — a splat the
    // forward skipped must not receive gradient or desync the S recursion
    if (e <= E_CUT && dot(d, d) <= rr * rr) {
    let comp = proj[b + 6u];
    let opa = proj[b + 7u];
    let G = exp(-e);
    let araw = opa * comp * G;
    let alpha = min(0.99, araw);
    if (alpha >= A_MIN) {
    let c = vec3f(proj[b + 8u], proj[b + 9u], proj[b + 10u]);

    let Tb = Ta / (1.0 - alpha); // transmittance in front of this splat
    // raw dL/dcolor — the activation chain (sigmoid DC + SH bands) is
    // per-splat constant, so the chain pass applies it once after summation
    let gcv = gC * (alpha * Tb);
    var galpha = dot(gC, c * Tb - S / (1.0 - alpha));
    if (araw > 0.99) { galpha = 0.0; } // alpha clamped: no gradient through it

    let ga = galpha * araw;
    let gmean = ga * vec2f(cA * d.x + cB * d.y, cB * d.x + cC * d.y);
${tileGrad ? (subgroups ? '    q0 = gmean.x;\n    q1 = gmean.y;'
                        : '    atomAdd(0u,      gmean.x);\n    atomAdd(1u, gmean.y);')
           : '    atomAdd(b,      gmean.x);\n    atomAdd(b + 1u, gmean.y);'}
    // conic grads scale with d^2 (px^2): measured at native res, big-splat
    // accumulators hit the i32 ceiling and silently wrapped (max 2.14e9 with
    // FIXEDC 4096). Normalize per splat by (1 + lambda_max) of the dilated 2D
    // covariance — d^2/lambda_max is bounded by 2*E_CUT, so per-add values
    // stay O(1) without amplifying quantization noise (a radius^2 normalizer
    // overshoots by (rad/sigma)^2 and BREAKS the FD gradcheck). The chain
    // pass recomputes the identical factor from proj[12..14] and undoes it.
    let cva = proj[b + 12u] + DILATE;
    let cvc = proj[b + 14u] + DILATE;
    let cmid = 0.5 * (cva + cvc);
    let lmax = cmid + sqrt(max(cmid * cmid - (cva * cvc - proj[b + 13u] * proj[b + 13u]), 0.0));
    let cnorm = 1.0 / (1.0 + lmax);
${tileGrad ? (subgroups ? /* wgsl */ `    q2 = -ga * 0.5 * d.x * d.x * cnorm;
    q3 = -ga * d.x * d.y * cnorm;
    q4 = -ga * 0.5 * d.y * d.y * cnorm;
    q5 = galpha * opa * G;          // d/dcomp
    q6 = ga * (1.0 - opa);          // d/dlogitOpacity
    q7 = gcv.r;
    q8 = gcv.g;
    q9 = gcv.b;
    q10 = alpha * Tb;
    q11 = alpha * Tb * perr;
    q12 = abs(gmean.x) + abs(gmean.y);` : /* wgsl */ `    atomAddC(2u, -ga * 0.5 * d.x * d.x * cnorm);
    atomAddC(3u, -ga * d.x * d.y * cnorm);
    atomAddC(4u, -ga * 0.5 * d.y * d.y * cnorm);
    atomAdd(5u, galpha * opa * G);          // d/dcomp
    atomAdd(6u, ga * (1.0 - opa));          // d/dlogitOpacity
    atomAdd(7u, gcv.r);
    atomAdd(8u, gcv.g);
    atomAdd(9u, gcv.b);
    atomAddW(10u, alpha * Tb);              // rendered mass (refine sampling)
    atomAddW(11u, alpha * Tb * perr);       // error mass (refine sampling)
    atomAddW(12u, abs(gmean.x) + abs(gmean.y)); // grad-stat (v2 growth)`) : /* wgsl */ `    atomAddC(b + 2u, -ga * 0.5 * d.x * d.x * cnorm);
    atomAddC(b + 3u, -ga * d.x * d.y * cnorm);
    atomAddC(b + 4u, -ga * 0.5 * d.y * d.y * cnorm);
    atomAdd(b + 5u, galpha * opa * G);          // d/dcomp
    atomAdd(b + 6u, ga * (1.0 - opa));          // d/dlogitOpacity
    atomAdd(b + 7u, gcv.r);
    atomAdd(b + 8u, gcv.g);
    atomAdd(b + 9u, gcv.b);
    atomAddW(b + 10u, alpha * Tb);              // rendered mass (refine sampling)
    atomAddW(b + 11u, alpha * Tb * perr);       // error mass (refine sampling)
    atomAddW(b + 12u, abs(gmean.x) + abs(gmean.y)); // grad-stat (v2 growth)`}

    S += c * alpha * Tb;
    Ta = Tb;
    }
    }
    }
${tileGrad ? (subgroups ? /* wgsl */ `
    // UNIFORM flush: subgroup-aggregate each slot, one sg atomic per subgroup
    // (the LichtFeld #1675 move). Called unconditionally — Tint's uniformity
    // analysis does not track subgroup-uniform conditions, so a subgroupAny
    // gate here failed validation (2026-08-25). MEASURED 2026-09-06 (truck
    // 1.04M, 979 px): render 9.8 -> 42.4 ms — 13 subgroup reductions per
    // splat for every lane cost far more than the sparse shared atomics they
    // replace (most splats touch a few pixels of a tile). Stays opt-in
    // (opts.subgroupAgg); pays only for big-splat scenes, if at all.
    atomAdd(0u, q0); atomAdd(1u, q1);
    atomAddC(2u, q2); atomAddC(3u, q3); atomAddC(4u, q4);
    atomAdd(5u, q5); atomAdd(6u, q6);
    atomAdd(7u, q7); atomAdd(8u, q8); atomAdd(9u, q9);
    atomAddW(10u, q10); atomAddW(11u, q11); atomAddW(12u, q12);
` : '') + /* wgsl */ `
    workgroupBarrier();
    if (li < 13u) {
      var v = 0;
      for (var pp = 0u; pp < ${P}u; pp++) { v += atomicLoad(&sg[li * ${P}u + pp]); }
      if (v != 0) { atomicAdd(&gradP[b + li], v); }
    }
` : ''}
  }
}
`);

export const makeChainSrc = (AREG = 0.02, shDeg = 0, dc = 'sigmoid', statMax = false, D = 0.3, C = true, compact = false) => CAM_STRUCT + /* wgsl */ `
const AREG = ${AREG.toExponential()};
const DILATE = ${D.toExponential()};
const MIPCOMP = ${C ? 'true' : 'false'};
` + /* wgsl */ `
@group(0) @binding(1) var<storage, read> params: array<f32>;
@group(0) @binding(2) var<storage, read> proj: array<f32>;
@group(0) @binding(3) var<storage, read_write> gradP: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read_write> gradF: array<f32>;
// per-camera pose gradients: row per camera x 8 slots
// [dwx, dwy, dwz, dtx, dty, dtz, dlogGain, dBias]; row numCams slot 0 = dlogf
@group(0) @binding(5) var<storage, read_write> gradCam: array<atomic<i32>>;
${shDeg > 0 ? `@group(0) @binding(6) var<storage, read> sh: array<f32>;
@group(0) @binding(7) var<storage, read_write> shGrad: array<f32>;` : ''}

fn camAdd(idx: u32, v: f32) {
  atomicAdd(&gradCam[idx], i32(clamp(v * FIXCAM, -1.0e9, 1.0e9)));
}
` + GEOM_FNS + (shDeg > 0 ? shFns(shDeg) : '') + /* wgsl */ `
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
${compact ? /* wgsl */ `
  // COMPACT: one thread per VISIBLE splat, via the list the vis-scatter pass
  // wrote into the proj tail ([tail] = count, [tail+1+j] = splat id)
  let tail = bitcast<u32>(cam.misc3.w);
  if (gid.x >= bitcast<u32>(proj[tail])) { return; }
  let i = bitcast<u32>(proj[tail + 1u + gid.x]);` : /* wgsl */ `
  let i = gid.x;
  if (i >= u32(cam.size.w)) { return; }`}
  let b = i * 16u;

  var gp: array<f32, 10>;
  for (var k = 0u; k < 10u; k++) {
    let scale = select(FIXED, FIXEDC, k >= 2u && k <= 4u);
    gp[k] = f32(atomicLoad(&gradP[b + k])) / scale;
    atomicStore(&gradP[b + k], 0);
  }
  // undo the render pass's per-splat conic range normalization (identical
  // lambda_max formula from the same proj values)
  {
    let cva = proj[b + 12u] + DILATE;
    let cvc = proj[b + 14u] + DILATE;
    let cmid = 0.5 * (cva + cvc);
    let lmax = cmid + sqrt(max(cmid * cmid - (cva * cvc - proj[b + 13u] * proj[b + 13u]), 0.0));
    let cdenorm = 1.0 + lmax;
    gp[2] *= cdenorm;
    gp[3] *= cdenorm;
    gp[4] *= cdenorm;
  }
  for (var k = 0u; k < 16u; k++) { gradF[b + k] = 0.0; }
${shDeg > 0 ? /* wgsl */ `
  let sbz = i * ${3 * shRestCoefs(shDeg)}u;
  for (var k = 0u; k < ${3 * shRestCoefs(shDeg)}u; k++) { shGrad[sbz + k] = 0.0; }` : ''}
  if (proj[b + 11u] <= 0.0) { return; }

  let g = computeGeom(b);
  if (g.ok < 0.5) { return; }

  let fx = cam.proj.x;
  let fy = select(fx, cam.misc3.z, cam.misc3.z > 0.0);
  let z = g.pc.z;
  let iz = 1.0 / z;

  // ---- conic -> dilated 2D covariance ----
  let ad = g.va + DILATE;
  let cd = g.vc + DILATE;
  let detVd = ad * cd - g.vb * g.vb;
  let inv = 1.0 / detVd;
  let kA = cd * inv;
  let kB = -g.vb * inv;
  let kC = ad * inv;
  let g11 = gp[2]; let g12 = 0.5 * gp[3]; let g22 = gp[4];
  let m100 = g11 * kA + g12 * kB;
  let m101 = g11 * kB + g12 * kC;
  let m110 = g12 * kA + g22 * kB;
  let m111 = g12 * kB + g22 * kC;
  let p00 = kA * m100 + kB * m110;
  let p01 = kA * m101 + kB * m111;
  let p10 = kB * m100 + kC * m110;
  let p11 = kB * m101 + kC * m111;
  var gva = -p00;
  var gvb = -(p01 + p10);
  var gvc = -p11;

  // ---- comp -> raw 2D covariance ----
  let detV = max(g.va * g.vc - g.vb * g.vb, 0.0);
  let comp = sqrt(max(detV / detVd, 0.0));
  if (MIPCOMP && comp > 1e-4) {
    let gcomp = gp[5];
    let denom = 2.0 * comp * detVd;
    gva += gcomp * (g.vc - comp * comp * cd) / denom;
    gvc += gcomp * (g.va - comp * comp * ad) / denom;
    gvb += gcomp * (2.0 * g.vb * (comp * comp - 1.0)) / denom;
  }

  // ---- V = T Sigma T^T backward ----
  let h11 = gva; let h12 = 0.5 * gvb; let h22 = gvc;
  let u0 = h11 * g.t0 + h12 * g.t1;
  let u1 = h12 * g.t0 + h22 * g.t1;
  let dS00 = g.t0.x * u0.x + g.t1.x * u1.x;
  let dS01 = 0.5 * ((g.t0.x * u0.y + g.t1.x * u1.y) + (g.t0.y * u0.x + g.t1.y * u1.x));
  let dS02 = 0.5 * ((g.t0.x * u0.z + g.t1.x * u1.z) + (g.t0.z * u0.x + g.t1.z * u1.x));
  let dS11 = g.t0.y * u0.y + g.t1.y * u1.y;
  let dS12 = 0.5 * ((g.t0.y * u0.z + g.t1.y * u1.z) + (g.t0.z * u0.y + g.t1.z * u1.y));
  let dS22 = g.t0.z * u0.z + g.t1.z * u1.z;

  let sT0 = vec3f(
    g.s00 * g.t0.x + g.s01 * g.t0.y + g.s02 * g.t0.z,
    g.s01 * g.t0.x + g.s11 * g.t0.y + g.s12 * g.t0.z,
    g.s02 * g.t0.x + g.s12 * g.t0.y + g.s22 * g.t0.z);
  let sT1 = vec3f(
    g.s00 * g.t1.x + g.s01 * g.t1.y + g.s02 * g.t1.z,
    g.s01 * g.t1.x + g.s11 * g.t1.y + g.s12 * g.t1.z,
    g.s02 * g.t1.x + g.s12 * g.t1.y + g.s22 * g.t1.z);
  let dT0 = 2.0 * (h11 * sT0 + h12 * sT1);
  let dT1 = 2.0 * (h12 * sT0 + h22 * sT1);

  // ---- T = J W: gradient to cam-space position through J ----
  let dJ00 = dot(dT0, cam.R0.xyz);
  let dJ02 = dot(dT0, cam.R2.xyz);
  let dJ11 = dot(dT1, cam.R1.xyz);
  let dJ12 = dot(dT1, cam.R2.xyz);
  // clamped splats: J was built from the clamped x/y, so no gradient flows
  // to position through that entry (reference-rasterizer convention)
  var dpc = vec3f(0.0);
  dpc.x += dJ02 * (-fx * iz * iz) * g.inx;
  dpc.y += dJ12 * (-fy * iz * iz) * g.iny;
  dpc.z += dJ00 * (-fx * iz * iz) + dJ11 * (-fy * iz * iz)
         + dJ02 * (2.0 * fx * g.cx * iz * iz * iz)
         + dJ12 * (2.0 * fy * g.cy * iz * iz * iz);

  // ---- mean path ----
  dpc.x += gp[0] * fx * iz;
  dpc.y += gp[1] * fy * iz;
  dpc.z += -(fx * gp[0] * g.pc.x + fy * gp[1] * g.pc.y) * iz * iz;

  // dL/dp_world = W^T dpc
  gradF[b]      = cam.R0.x * dpc.x + cam.R1.x * dpc.y + cam.R2.x * dpc.z;
  gradF[b + 1u] = cam.R0.y * dpc.x + cam.R1.y * dpc.y + cam.R2.y * dpc.z;
  gradF[b + 2u] = cam.R0.z * dpc.x + cam.R1.z * dpc.y + cam.R2.z * dpc.z;

  // ---- camera pose gradients (train mode): p_c = exp(w^) R p + t ----
  if (cam.misc2.x > 0.5) {
    let ci = u32(cam.misc2.y) * 8u;
    camAdd(ci + 3u, dpc.x); // dL/dt
    camAdd(ci + 4u, dpc.y);
    camAdd(ci + 5u, dpc.z);
    var dw = cross(g.pc - cam.t.xyz, dpc);
    let dW0 = (fx * iz) * dT0;
    let dW1 = (fy * iz) * dT1;
    let dW2 = (-fx * g.cx * iz * iz) * dT0 + (-fy * g.cy * iz * iz) * dT1;
    let wc0 = vec3f(cam.R0.x, cam.R1.x, cam.R2.x);
    let wc1 = vec3f(cam.R0.y, cam.R1.y, cam.R2.y);
    let wc2 = vec3f(cam.R0.z, cam.R1.z, cam.R2.z);
    dw += cross(wc0, vec3f(dW0.x, dW1.x, dW2.x))
        + cross(wc1, vec3f(dW0.y, dW1.y, dW2.y))
        + cross(wc2, vec3f(dW0.z, dW1.z, dW2.z));
    camAdd(ci,      dw.x);
    camAdd(ci + 1u, dw.y);
    camAdd(ci + 2u, dw.z);
    // shared focal: dL/dlogf = f dL/df (mean path + J path, J entries all
    // ~f — except a clamped J02/J12, where the limit is itself 1/f and the
    // f-dependence cancels, so those terms gate out). Split per axis: slot 0
    // = dL/dlog(f) with both axes scaling together, slot 1 = dL/dlog(fy)
    // alone = the pixel-ASPECT gradient (fy = f·a; non-square pixels)
    let dlogfx = gp[0] * fx * g.pc.x * iz + dJ00 * (fx * iz)
      + dJ02 * (-fx * g.cx * iz * iz) * g.inx;
    let dlogfy = gp[1] * fy * g.pc.y * iz + dJ11 * (fy * iz)
      + dJ12 * (-fy * g.cy * iz * iz) * g.iny;
    camAdd(u32(cam.misc2.z) * 8u, dlogfx + dlogfy);
    camAdd(u32(cam.misc2.z) * 8u + 1u, dlogfy);
  }

  // ---- Sigma = M M^T backward: dL/dM = 2 dLdSigma M, M = R diag(s) ----
  let m0 = g.r0 * g.s;
  let m1 = g.r1 * g.s;
  let m2 = g.r2 * g.s;
  let dM0 = 2.0 * (dS00 * m0 + dS01 * m1 + dS02 * m2);
  let dM1 = 2.0 * (dS01 * m0 + dS11 * m1 + dS12 * m2);
  let dM2 = 2.0 * (dS02 * m0 + dS12 * m1 + dS22 * m2);

  // dL/ds_k = sum_i dM[i][k] R[i][k];  dlogs = ds * s
  let dsv = vec3f(
    dM0.x * g.r0.x + dM1.x * g.r1.x + dM2.x * g.r2.x,
    dM0.y * g.r0.y + dM1.y * g.r1.y + dM2.y * g.r2.y,
    dM0.z * g.r0.z + dM1.z * g.r1.z + dM2.z * g.r2.z);
  // Anisotropy regularizer: pull each log-scale toward the splat's mean.
  // On low-parallax data the thin dimensions are unconstrained and random-walk
  // to the clamps (needle artifact); this restoring force wins exactly where
  // data gradients are absent, while data-supported plates override it.
  let ls = vec3f(
    clamp(params[b + 3u], -12.0, 6.0),
    clamp(params[b + 4u], -12.0, 6.0),
    clamp(params[b + 5u], -12.0, 6.0));
  let mls = (ls.x + ls.y + ls.z) / 3.0;
  gradF[b + 3u] = dsv.x * g.s.x + AREG * (ls.x - mls);
  gradF[b + 4u] = dsv.y * g.s.y + AREG * (ls.y - mls);
  gradF[b + 5u] = dsv.z * g.s.z + AREG * (ls.z - mls);

  // dL/dR = dM * diag(s)
  let dR0 = dM0 * g.s;
  let dR1 = dM1 * g.s;
  let dR2 = dM2 * g.s;

  // quaternion backward (normalized q = (w,x,y,z))
  let qw = g.q.x; let qx = g.q.y; let qy = g.q.z; let qz = g.q.w;
  let gw = 2.0 * (dR0.y * (-qz) + dR0.z * qy + dR1.x * qz + dR1.z * (-qx) + dR2.x * (-qy) + dR2.y * qx);
  let gx = 2.0 * (dR0.y * qy + dR0.z * qz + dR1.x * qy + dR1.y * (-2.0 * qx) + dR1.z * (-qw) + dR2.x * qz + dR2.y * qw + dR2.z * (-2.0 * qx));
  let gy = 2.0 * (dR0.x * (-2.0 * qy) + dR0.y * qx + dR0.z * qw + dR1.x * qx + dR1.z * qz + dR2.x * (-qw) + dR2.y * qz + dR2.z * (-2.0 * qy));
  let gz = 2.0 * (dR0.x * (-2.0 * qz) + dR0.y * (-qw) + dR0.z * qx + dR1.x * qw + dR1.y * (-2.0 * qz) + dR1.z * qy + dR2.x * qx + dR2.y * qy);
  let gq = vec4f(gw, gx, gy, gz);
  var qraw = vec4f(params[b + 6u], params[b + 7u], params[b + 8u], params[b + 9u]);
  let ql = max(length(qraw), 1e-6);
  let gqr = (gq - g.q * dot(g.q, gq)) / ql;
  gradF[b + 6u] = gqr.x;
  gradF[b + 7u] = gqr.y;
  gradF[b + 8u] = gqr.z;
  gradF[b + 9u] = gqr.w;

  // ---- color: DC sigmoid chain + SH band grads (+ position via view dir) ----
  let sCol = vec3f(
    1.0 / (1.0 + exp(-clamp(params[b + 10u], -9.0, 9.0))),
    1.0 / (1.0 + exp(-clamp(params[b + 11u], -9.0, 9.0))),
    1.0 / (1.0 + exp(-clamp(params[b + 12u], -9.0, 9.0))));
  var dRGB = vec3f(gp[7], gp[8], gp[9]);
${shDeg > 0 ? /* wgsl */ `
  {
    let un = vec3f(params[b], params[b + 1u], params[b + 2u]) - camPosWorld();
    let ulen = max(length(un), 1e-9);
    let v = un / ulen;
    var Y = shBasis(v);
    var D = shBasisGrad(v);
    let aK = shActiveK();
    let sb = i * ${3 * shRestCoefs(shDeg)}u;
    var col = sCol;
    for (var k = 0u; k < aK; k++) {
      col += vec3f(sh[sb + k], sh[sb + SHK + k], sh[sb + 2u * SHK + k]) * Y[k];
    }
    // clamp-at-zero gate: a channel clamped in the forward has no gradient
    dRGB *= vec3f(
      select(0.0, 1.0, col.x > 0.0),
      select(0.0, 1.0, col.y > 0.0),
      select(0.0, 1.0, col.z > 0.0));
    var gv = vec3f(0.0);
    for (var k = 0u; k < aK; k++) {
      shGrad[sb + k] = dRGB.x * Y[k];
      shGrad[sb + SHK + k] = dRGB.y * Y[k];
      shGrad[sb + 2u * SHK + k] = dRGB.z * Y[k];
      let w = dRGB.x * sh[sb + k] + dRGB.y * sh[sb + SHK + k] + dRGB.z * sh[sb + 2u * SHK + k];
      gv += w * D[k];
    }
    // dL/dp through the view direction v = (p - cam)/|p - cam|
    let shPos = (gv - v * dot(v, gv)) / ulen;
    gradF[b]      += shPos.x;
    gradF[b + 1u] += shPos.y;
    gradF[b + 2u] += shPos.z;
  }` : ''}
${dc === 'sh' ? /* wgsl */ `
  gradF[b + 10u] = dRGB.x * 0.28209479;
  gradF[b + 11u] = dRGB.y * 0.28209479;
  gradF[b + 12u] = dRGB.z * 0.28209479;
` : /* wgsl */ `
  gradF[b + 10u] = dRGB.x * sCol.x * (1.0 - sCol.x);
  gradF[b + 11u] = dRGB.y * sCol.y * (1.0 - sCol.y);
  gradF[b + 12u] = dRGB.z * sCol.z * (1.0 - sCol.z);
`}
  gradF[b + 13u] = gp[6];
${statMax ? /* wgsl */ `
  // windowed-MAX growth stat (Brush semantics): keep the max PER-STEP
  // gradient sum over the refine window in slot 13; slot 12 restarts
  // each step
  let stepStat = atomicExchange(&gradP[b + 12u], 0);
  atomicMax(&gradP[b + 13u], stepStat);
` : ''}
}
`;

// Adam for the SH coefficient buffer (single lr, no clamps, NaN-guarded).
export const SH_ADAM_SRC = /* wgsl */ `
struct SHA {
  hp: vec4f,   // beta1, beta2, eps, step t
  cfg: vec4f,  // x = lr, y = total coeffs (n * 3K)
};
@group(0) @binding(0) var<uniform> au: SHA;
@group(0) @binding(1) var<storage, read_write> sh: array<f32>;
@group(0) @binding(2) var<storage, read> g: array<f32>;
@group(0) @binding(3) var<storage, read_write> mBuf: array<f32>;
@group(0) @binding(4) var<storage, read_write> vBuf: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(num_workgroups) nw: vec3u) {
  // 2D dispatch: big splat counts exceed 65535 workgroups in one dimension
  let j = gid.x + gid.y * nw.x * 256u;
  if (j >= u32(au.cfg.y)) { return; }
  var gr = g[j];
  if (!(abs(gr) < 1e18)) { gr = 0.0; }
  let b1 = au.hp.x;
  let b2 = au.hp.y;
  let m = b1 * mBuf[j] + (1.0 - b1) * gr;
  let v = b2 * vBuf[j] + (1.0 - b2) * gr * gr;
  mBuf[j] = m;
  vBuf[j] = v;
  let t = au.hp.w;
  let mh = m / (1.0 - pow(b1, t));
  let vh = v / (1.0 - pow(b2, t));
  sh[j] = sh[j] - au.cfg.x * mh / (sqrt(vh) + au.hp.z);
}
`;

export const ADAM_SRC = /* wgsl */ `
struct AdamU {
  lr0: vec4f,   // lr slots 0..3   (pos xyz, logScale x)
  lr1: vec4f,   // lr slots 4..7   (logScale yz, quat wx)
  lr2: vec4f,   // lr slots 8..11  (quat yz, color rg)
  lr3: vec4f,   // lr slots 12..15 (color b, logitOpacity, pads)
  hp: vec4f,    // beta1, beta2, eps, step t
  cl: vec4f,    // minLogScale, maxLogScale, maxAbsLogit, totalParams (n*16)
  reg: vec4f,   // x = opacity reg weight, y = scale reg weight,
                // z = MCMC noise prefactor (0 = off; reference uses 5e5)
  flg: vec4f,   // x = regs only on splats that rendered this step (>0.5),
                // y = opacity logit floor (0 = cl.z), z/w pad
};
@group(0) @binding(0) var<uniform> au: AdamU;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;
@group(0) @binding(2) var<storage, read> gradF: array<f32>;
@group(0) @binding(3) var<storage, read_write> mBuf: array<f32>;
@group(0) @binding(4) var<storage, read_write> vBuf: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(num_workgroups) nw: vec3u) {
  // 2D dispatch: big splat counts exceed 65535 workgroups in one dimension
  let j = gid.x + gid.y * nw.x * 256u;
  if (j >= u32(au.cl.w)) { return; }
  let slot = j % 16u;
  var lr: f32;
  if (slot < 4u) { lr = au.lr0[slot]; }
  else if (slot < 8u) { lr = au.lr1[slot - 4u]; }
  else if (slot < 12u) { lr = au.lr2[slot - 8u]; }
  else { lr = au.lr3[slot - 12u]; }
  if (lr == 0.0) { return; }

  var g = gradF[j];
  if (!(abs(g) < 1e18)) { g = 0.0; } // NaN/Inf guard
  // flg.x: regularizers act only on splats the last render touched (their
  // opacity slot carries a data gradient). Adam normalizes, so a culled
  // splat under an unconditional reg walks at full lr with nothing pushing
  // back — opacity ratchets to the clamp, scales to the minScale wall —
  // and a splat parked below A_MIN never renders again (lab log 2026-09-01).
  let regOn = au.flg.x < 0.5 || gradF[(j / 16u) * 16u + 13u] != 0.0;
  if (slot == 13u && regOn) {
    let sg = 1.0 / (1.0 + exp(-clamp(params[j], -9.0, 9.0)));
    g += au.reg.x * sg * (1.0 - sg); // opacity regularizer
  }
  if (slot >= 3u && slot <= 5u && au.reg.y > 0.0 && regOn) {
    // 3DGS-MCMC scale pressure: shrink unless the data disagrees
    g += au.reg.y * exp(clamp(params[j], -20.0, 5.0));
  }

  let b1 = au.hp.x;
  let b2 = au.hp.y;
  var m = b1 * mBuf[j] + (1.0 - b1) * g;
  var v = b2 * vBuf[j] + (1.0 - b2) * g * g;
  mBuf[j] = m;
  vBuf[j] = v;
  let t = au.hp.w;
  let mh = m / (1.0 - pow(b1, t));
  let vh = v / (1.0 - pow(b2, t));
  var p = params[j] - lr * mh / (sqrt(vh) + au.hp.z);

  // 3DGS-MCMC Langevin exploration (paper eq. 8 / reference NOISE_LR 5e5):
  // near-dead splats random-walk inside their own covariance every iteration
  // instead of waiting for a refine event. Gate ~ sigmoid(-100(opacity-0.005))
  // so healthy splats are untouched. Same epsilon for a splat's three
  // position slots: the hash seeds on (splat, step) only.
  if (slot < 3u && au.reg.z > 0.0) {
    let base = (j / 16u) * 16u;
    let opa = 1.0 / (1.0 + exp(-clamp(params[base + 13u], -9.0, 9.0)));
    let gate = 1.0 / (1.0 + exp(100.0 * (opa - 0.005)));
    if (gate > 1e-4) {
      var h = (j / 16u) * 747796405u + u32(au.hp.w) * 2891336453u + 277803737u;
      var e: vec3f;
      for (var k = 0u; k < 3u; k++) {
        h = h * 747796405u + 2891336453u;
        let a = f32((h >> 9u) & 0x7fffffu) / 8388608.0;    // (0,1)
        h = h * 747796405u + 2891336453u;
        let b = f32((h >> 9u) & 0x7fffffu) / 8388608.0;
        e[k] = sqrt(max(-2.0 * log(max(a, 1e-7)), 0.0)) * cos(6.2831853 * b);
      }
      // Sigma e = R diag(exp(2 logS)) R^T e
      let q = normalize(vec4f(params[base + 6u], params[base + 7u],
                              params[base + 8u], params[base + 9u]));
      let w = q.x; let x = q.y; let y = q.z; let z = q.w;
      let R = mat3x3f(
        1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z),       2.0 * (x * z - w * y),
        2.0 * (x * y - w * z),       1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
        2.0 * (x * z + w * y),       2.0 * (y * z - w * x),       1.0 - 2.0 * (x * x + y * y));
      let s2 = exp(2.0 * vec3f(params[base + 3u], params[base + 4u], params[base + 5u]));
      let u = R * (s2 * (transpose(R) * e));
      p += au.reg.z * lr * gate * u[slot];
    }
  }

  if (slot >= 3u && slot <= 5u) { p = clamp(p, au.cl.x, au.cl.y); }
  // logit clamps; reg.w >= 0.5 = v2 unbounded SH-DC color (opacity stays)
  if (slot == 13u || (slot >= 10u && slot <= 12u && au.reg.w < 0.5)) {
    p = clamp(p, -au.cl.z, au.cl.z);
  }
  // opacity floor (flg.y): a shallower pit than the ±cl.z clamp so a splat
  // that lost its view climbs back inside a few hundred steps
  if (slot == 13u && au.flg.y > 0.0) { p = max(p, -au.flg.y); }
  // flg.z: Brush-style opacity decay — a constant subtracted in OPACITY
  // space every step (Brush: o -= 0.004*(1-t) per 200 it, then prune below
  // 1/255) in place of the loss-side reg above (reg.x = 0 with it). Unlike
  // the reg it is not Adam-normalised, so a splat the data supports outruns
  // it easily while an unsupported one fades at a fixed rate.
  if (slot == 13u && au.flg.z > 0.0 && regOn) {
    let o = 1.0 / (1.0 + exp(-p));
    let o2 = max(o - au.flg.z, 1e-4);
    p = log(o2 / (1.0 - o2));
  }
  params[j] = p;
}
`;

export const BLIT_SRC = CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read> outImg: array<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  if (fc.x >= cam.size.x || fc.y >= cam.size.y) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let x = u32(fc.x);
  let y = u32(fc.y);
  let i = (y * u32(cam.size.x) + x) * 4u;
  return vec4f(
    clamp(outImg[i], 0.0, 1.0),
    clamp(outImg[i + 1u], 0.0, 1.0),
    clamp(outImg[i + 2u], 0.0, 1.0),
    1.0);
}
`;

// ---- phase-2 MCMC refine: gather + plan-apply (no CPU params round-trip) ----
// GATHER compacts per-splat refine inputs to 4 floats — logit-opacity, the
// two error-mass accumulators (gradP slots 10/11, zeroed here to start the
// next window), and mean log-scale — so refine() reads back 16 bytes/splat
// instead of params+moments+SH (~700 bytes). The relocation decisions stay
// on the CPU; APPLY executes them GPU-side.
export const GATHER_SRC = /* wgsl */ `
const WFIX = 8.0;
struct GUni { n: u32, mode: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> gu: GUni;
@group(0) @binding(1) var<storage, read> params: array<f32>;
@group(0) @binding(2) var<storage, read_write> gradP: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> outv: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(num_workgroups) nw: vec3u) {
  let i = gid.x + gid.y * nw.x * 256u;
  if (i >= gu.n) { return; }
  let b = i * 16u;
  outv[i * 4u] = params[b + 13u];
  let statSlot = select(12u, 13u, gu.pad0 == 1u); // pad0=1: windowed-max slot
  outv[i * 4u + 1u] = f32(atomicExchange(&gradP[b + statSlot], 0)) / WFIX;
  // slot 2 carries error mass (legacy donors, mode 0) or rendered mass
  // (v2 growth normalization, mode 1); both windows drain either way
  let wm = f32(atomicExchange(&gradP[b + 10u], 0)) / WFIX;
  let em = f32(atomicExchange(&gradP[b + 11u], 0)) / WFIX;
  outv[i * 4u + 2u] = select(em, wm, gu.mode == 1u);
  outv[i * 4u + 3u] = (params[b + 3u] + params[b + 4u] + params[b + 5u]) / 3.0;
}
`;

// APPLY: one thread per plan op. Op = { dst, src, flags, seed, newLogitO,
// dLogScale }. flags bit0 = copy row src->dst (params + SH, fresh moments),
// bit1 = set logit-opacity to newLogitO, bit2 = add dLogScale to the three
// log-scales, bit3 = reset dst moments (donor rows: shape changed under the
// optimizer). Relocations are EXACT copies (3DGS-MCMC eq-9 semantics — the
// Langevin noise does the dispersing); the eq-9 opacity/scale adjustment is
// precomputed on the CPU from the gathered opacities.
export const REFINE_APPLY_SRC = /* wgsl */ `
// base/nOps window a SLICE of the plan: clone-copies dispatch first, donor
// in-place adjustments second (ordered dispatches in one pass) — in a single
// dispatch a clone racing its donor's adjustment could copy the already-
// shrunk scale and apply the eq-9 coefficient twice
struct Op { dst: u32, src: u32, flags: u32, seed: u32, newO: f32, dls: f32, p0: f32, p1: f32 };
struct RUni { nOps: u32, shr: u32, base: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> ru: RUni;
@group(0) @binding(1) var<storage, read> plan: array<Op>;
@group(0) @binding(2) var<storage, read_write> params: array<f32>;
@group(0) @binding(3) var<storage, read_write> mBuf: array<f32>;
@group(0) @binding(4) var<storage, read_write> vBuf: array<f32>;
@group(0) @binding(5) var<storage, read_write> sh: array<f32>;
@group(0) @binding(6) var<storage, read_write> shM: array<f32>;
@group(0) @binding(7) var<storage, read_write> shV: array<f32>;

fn h32(x0: u32) -> u32 {
  var x = x0;
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(num_workgroups) nw: vec3u) {
  let k = gid.x + gid.y * nw.x * 256u;
  if (k >= ru.nOps) { return; }
  let op = plan[ru.base + k];
  let bd = op.dst * 16u;
  let bs = op.src * 16u;
  if ((op.flags & 1u) != 0u) {
    for (var j = 0u; j < 16u; j++) {
      params[bd + j] = params[bs + j];
      mBuf[bd + j] = 0.0;
      vBuf[bd + j] = 0.0;
    }
    if (ru.shr > 0u) {
      let sd = op.dst * ru.shr;
      let ss = op.src * ru.shr;
      for (var j = 0u; j < ru.shr; j++) {
        sh[sd + j] = sh[ss + j];
        shM[sd + j] = 0.0;
        shV[sd + j] = 0.0;
      }
    }
    // a fresh row starts a fresh error window
    // (gradP slots were zeroed by the gather that planned this refine)
  }
  if ((op.flags & 16u) != 0u) {
    // clone jitter, v1-style: 0.7 sigma of the (just-copied) donor scale —
    // an exact-copy pair is gradient-degenerate and separates too slowly on
    // Langevin noise alone (measured -0.45 dB at 40k)
    let mls = (params[bd + 3u] + params[bd + 4u] + params[bd + 5u]) / 3.0;
    let s = exp(mls) * 0.7;
    for (var c = 0u; c < 3u; c++) {
      let u1 = (f32(h32(op.seed ^ (op.dst * 3u + c))) + 0.5) / 4294967296.0;
      let u2 = (f32(h32(op.seed ^ (op.dst * 3u + c) ^ 0x9e3779b9u)) + 0.5) / 4294967296.0;
      params[bd + c] += s * sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2);
    }
  }
  if ((op.flags & 2u) != 0u) { params[bd + 13u] = op.newO; }
  if ((op.flags & 4u) != 0u) {
    params[bd + 3u] += op.dls;
    params[bd + 4u] += op.dls;
    params[bd + 5u] += op.dls;
  }
  if ((op.flags & 8u) != 0u) {
    for (var j = 0u; j < 16u; j++) { mBuf[bd + j] = 0.0; vBuf[bd + j] = 0.0; }
    if (ru.shr > 0u) {
      let sd = op.dst * ru.shr;
      for (var j = 0u; j < ru.shr; j++) { shM[sd + j] = 0.0; shV[sd + j] = 0.0; }
    }
  }
  if ((op.flags & 32u) != 0u) {
    // v2 conserving split: signed ellipsoid offset. The pair shares one
    // seed -> identical vector; p0 = +/-1 picks the side, p1 = sigma in
    // units of the (post-shrink) scale. Runs after the dls block so both
    // rows sample the same ellipsoid.
    var q = vec4f(params[bd + 6u], params[bd + 7u], params[bd + 8u], params[bd + 9u]);
    q /= max(length(q), 1e-9);
    let w = q.x; let x = q.y; let y = q.z; let z = q.w;
    var e: vec3f;
    for (var c = 0u; c < 3u; c++) {
      let u1 = (f32(h32(op.seed ^ (c * 2654435761u))) + 0.5) / 4294967296.0;
      let u2 = (f32(h32(op.seed ^ (c * 2654435761u) ^ 0x9e3779b9u)) + 0.5) / 4294967296.0;
      e[c] = sqrt(-2.0 * log(u1)) * cos(6.2831853 * u2) * exp(params[bd + 3u + c]) * op.p1;
    }
    let off = vec3f(
      (1.0 - 2.0 * (y * y + z * z)) * e.x + 2.0 * (x * y - w * z) * e.y + 2.0 * (x * z + w * y) * e.z,
      2.0 * (x * y + w * z) * e.x + (1.0 - 2.0 * (x * x + z * z)) * e.y + 2.0 * (y * z - w * x) * e.z,
      2.0 * (x * z - w * y) * e.x + 2.0 * (y * z + w * x) * e.y + (1.0 - 2.0 * (x * x + y * y)) * e.z);
    params[bd] += op.p0 * off.x;
    params[bd + 1u] += op.p0 * off.y;
    params[bd + 2u] += op.p0 * off.z;
  }
}
`;

// ---------------- D-SSIM loss passes (opts.ssimWeight > 0) ----------------
// Image-space pipeline between the forward and backward raster:
//   prep     -> A: [x, y, x^2, y^2, xy] (3ch each; x = exposure-adjusted
//               prediction, y = target; invalid target pixels -> 0)
//   blurH/V  -> 11-tap Gaussian (sigma 1.5), separable; A -> B -> A
//   coeff    -> B: closed-form SSIM partials per pixel/channel:
//               c1 = dS/dmu_x, c2 = dS/dE[x^2], c3 = dS/dE[xy]
//   blurH(9) -> B -> A
//   finalv   -> vertical blur of the partials + chain rule:
//               dS/dx(q) = [G*c1](q) + 2 x(q) [G*c2](q) + y(q) [G*c3](q)
//               written to gssim; the backward raster mixes it into gC.
// A/B are pixel-major, 16 f32 per pixel (15 used). All passes bind the
// training cam uniform for W/H, target offset, and exposure gain/bias.
export const SSIM_SRC = CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read> srcb: array<f32>;
@group(0) @binding(2) var<storage, read_write> dstb: array<f32>;
@group(0) @binding(3) var<storage, read> outImg: array<f32>;
@group(0) @binding(4) var<storage, read> tgtImg: array<u32>;
@group(0) @binding(5) var<storage, read_write> gssim: array<f32>;

override NCH: u32 = 15u;
const SC1 = 1e-4;   // (0.01)^2
const SC2 = 9e-4;   // (0.03)^2

// normalized 11-tap Gaussian, sigma 1.5: w(k) = exp(-k^2/4.5)/3.75906
fn kw(k: i32) -> f32 { return 0.2660255 * exp(-f32(k * k) / 4.5); }

// exposure-adjusted prediction x and target y; w = 0 marks invalid pixels
fn readXY(pi: u32) -> array<vec4f, 2> {
  let packed = tgtImg[bitcast<u32>(cam.misc.w) + pi];
  var o = array<vec4f, 2>(vec4f(0.0), vec4f(0.0));
  if ((packed >> 24u) != 0u) {
    let x = cam.proj.w * vec3f(outImg[pi * 4u], outImg[pi * 4u + 1u], outImg[pi * 4u + 2u]) + vec3f(cam.misc2.w);
    o[0] = vec4f(x, 1.0);
    o[1] = vec4f(unpack4x8unorm(packed).rgb, 1.0);
  }
  return o;
}

@compute @workgroup_size(16, 16)
fn prep(@builtin(global_invocation_id) g: vec3u) {
  let W = u32(cam.size.x); let H = u32(cam.size.y);
  if (g.x >= W || g.y >= H) { return; }
  let pi = g.y * W + g.x;
  let v = readXY(pi);
  let x = v[0].rgb; let y = v[1].rgb;
  let b = pi * 16u;
  dstb[b]      = x.r; dstb[b + 1u]  = x.g; dstb[b + 2u]  = x.b;
  dstb[b + 3u] = y.r; dstb[b + 4u]  = y.g; dstb[b + 5u]  = y.b;
  dstb[b + 6u] = x.r * x.r; dstb[b + 7u]  = x.g * x.g; dstb[b + 8u]  = x.b * x.b;
  dstb[b + 9u] = y.r * y.r; dstb[b + 10u] = y.g * y.g; dstb[b + 11u] = y.b * y.b;
  dstb[b + 12u] = x.r * y.r; dstb[b + 13u] = x.g * y.g; dstb[b + 14u] = x.b * y.b;
}

@compute @workgroup_size(16, 16)
fn blurH(@builtin(global_invocation_id) g: vec3u) {
  let W = u32(cam.size.x); let H = u32(cam.size.y);
  if (g.x >= W || g.y >= H) { return; }
  let rowB = g.y * W;
  let db = (rowB + g.x) * 16u;
  for (var ch = 0u; ch < NCH; ch++) {
    var s = 0.0;
    for (var k = -5; k <= 5; k++) {
      let xx = u32(clamp(i32(g.x) + k, 0, i32(W) - 1));
      s += kw(k) * srcb[(rowB + xx) * 16u + ch];
    }
    dstb[db + ch] = s;
  }
}

@compute @workgroup_size(16, 16)
fn blurV(@builtin(global_invocation_id) g: vec3u) {
  let W = u32(cam.size.x); let H = u32(cam.size.y);
  if (g.x >= W || g.y >= H) { return; }
  let db = (g.y * W + g.x) * 16u;
  for (var ch = 0u; ch < NCH; ch++) {
    var s = 0.0;
    for (var k = -5; k <= 5; k++) {
      let yy = u32(clamp(i32(g.y) + k, 0, i32(H) - 1));
      s += kw(k) * srcb[(yy * W + g.x) * 16u + ch];
    }
    dstb[db + ch] = s;
  }
}

@compute @workgroup_size(16, 16)
fn coeff(@builtin(global_invocation_id) g: vec3u) {
  let W = u32(cam.size.x); let H = u32(cam.size.y);
  if (g.x >= W || g.y >= H) { return; }
  let b = (g.y * W + g.x) * 16u;
  for (var ch = 0u; ch < 3u; ch++) {
    let mx  = srcb[b + ch];        // G*x
    let my  = srcb[b + 3u + ch];   // G*y
    let ex2 = srcb[b + 6u + ch];   // G*x^2
    let ey2 = srcb[b + 9u + ch];   // G*y^2
    let exy = srcb[b + 12u + ch];  // G*xy
    let sx2 = ex2 - mx * mx;
    let sy2 = ey2 - my * my;
    let sxy = exy - mx * my;
    let a1 = 2.0 * mx * my + SC1;
    let a2 = 2.0 * sxy + SC2;
    let b1 = mx * mx + my * my + SC1;
    let b2 = sx2 + sy2 + SC2;
    let inv = 1.0 / (b1 * b2);
    let s = a1 * a2 * inv;
    dstb[b + ch]      = 2.0 * (my * (a2 - a1) - s * mx * (b2 - b1)) * inv; // dS/dmu_x
    dstb[b + 3u + ch] = -s / b2;                                          // dS/dE[x^2]
    dstb[b + 6u + ch] = 2.0 * a1 * inv;                                   // dS/dE[xy]
  }
}

@compute @workgroup_size(16, 16)
fn finalv(@builtin(global_invocation_id) g: vec3u) {
  let W = u32(cam.size.x); let H = u32(cam.size.y);
  if (g.x >= W || g.y >= H) { return; }
  let pi = g.y * W + g.x;
  let v = readXY(pi);
  if (v[0].w == 0.0) { // invalid target pixel: no SSIM gradient
    gssim[pi * 4u] = 0.0; gssim[pi * 4u + 1u] = 0.0; gssim[pi * 4u + 2u] = 0.0;
    return;
  }
  let x = v[0].rgb; let y = v[1].rgb;
  for (var ch = 0u; ch < 3u; ch++) {
    var c1 = 0.0; var c2 = 0.0; var c3 = 0.0;
    for (var k = -5; k <= 5; k++) {
      let yy = u32(clamp(i32(g.y) + k, 0, i32(H) - 1));
      let sb = (yy * W + g.x) * 16u;
      let wgt = kw(k);
      c1 += wgt * srcb[sb + ch];
      c2 += wgt * srcb[sb + 3u + ch];
      c3 += wgt * srcb[sb + 6u + ch];
    }
    gssim[pi * 4u + ch] = c1 + 2.0 * x[ch] * c2 + y[ch] * c3;
  }
}
`;

// ---------------- SSAA downsample-loss pass (opts.ssaa >= 2) ----------------
// Runs at the LOSS (1x) resolution: box-averages the ssaa x ssaa render
// pixels, computes the standard charbonnier loss + PSNR stats + exposure
// gradients against the native target, and writes the per-1x-pixel color
// gradient (+ charbonnier for the refine error mass) for the mode-3
// backward raster. PSNR/loss numbers stay directly comparable to non-SSAA
// runs — same targets, same resolution.
export const makeSsaaLossSrc = (S = 2) => CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read> outImg: array<f32>;
@group(0) @binding(2) var<storage, read> tgtImg: array<u32>;
@group(0) @binding(3) var<storage, read_write> gloss: array<f32>;
@group(0) @binding(4) var<storage, read_write> stats: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> gradCam: array<atomic<i32>>;
const SS = ${S}u;

fn camAdd(idx: u32, v: f32) {
  atomicAdd(&gradCam[idx], i32(round(clamp(v * FIXCAM, -1.0e9, 1.0e9))));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let W = u32(cam.size.x); let H = u32(cam.size.y); // 1x dims (this pass binds the 1x uniform)
  if (g.x >= W || g.y >= H) { return; }
  let pi = g.y * W + g.x;
  let gb = pi * 4u;
  let off = bitcast<u32>(cam.misc.w);
  let packed = tgtImg[off + pi];
  if ((packed >> 24u) == 0u) { // undistortion sentinel: no loss, no gradient
    gloss[gb] = 0.0; gloss[gb + 1u] = 0.0; gloss[gb + 2u] = 0.0; gloss[gb + 3u] = 0.0;
    return;
  }
  let W2 = W * SS;
  var C = vec3f(0.0);
  for (var sy = 0u; sy < SS; sy++) {
    for (var sx = 0u; sx < SS; sx++) {
      let p2 = ((g.y * SS + sy) * W2 + g.x * SS + sx) * 4u;
      C += vec3f(outImg[p2], outImg[p2 + 1u], outImg[p2 + 2u]);
    }
  }
  C /= f32(SS * SS);
  let tcol = unpack4x8unorm(packed).rgb;
  atomicAdd(&stats[2], 1u);
  let gain = cam.proj.w;
  let err = (gain * C + vec3f(cam.misc2.w)) - tcol;
  let dith = fract(sin(f32(pi) * 12.9898) * 43758.5453);
  atomicAdd(&stats[0], u32(dot(err, err) * 16.0 + dith));
  const DELTA = 0.03;
  let root = sqrt(err * err + vec3f(DELTA * DELTA));
  let eg = err / root;
  let gC = gain * eg;
  let lossv = (root.x + root.y + root.z) - 3.0 * DELTA;
  atomicAdd(&stats[1], u32(lossv * 32768.0));
  let ci8 = u32(cam.misc2.y) * 8u;
  camAdd(ci8 + 6u, dot(eg, C) * gain);
  camAdd(ci8 + 7u, eg.x + eg.y + eg.z);
  gloss[gb] = gC.r; gloss[gb + 1u] = gC.g; gloss[gb + 2u] = gC.b; gloss[gb + 3u] = lossv;
}
`;

// ---- visibility compaction (LichtFeld #1917 in WebGPU terms) ----
// project marks proj[b+11] = 1 for splats that survive culling. These three
// passes build a STABLE compact list of visible splat ids in the proj tail
// ([tail] = count, [tail+1..] = ids in original order) and fill the indirect
// dispatch arguments for the chain / Adam / SH-Adam passes, which then run
// over visible splats only. Invisible rows keep their unconditional regs and
// Langevin noise through a separate cheap pass (adam mode 'invis').
export const VIS_COUNT_SRC = CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read> proj: array<f32>;
@group(0) @binding(2) var<storage, read_write> blocks: array<u32>;
var<workgroup> cnt: atomic<u32>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u,
        @builtin(num_workgroups) nw: vec3u) {
  if (li == 0u) { atomicStore(&cnt, 0u); }
  workgroupBarrier();
  let blk = wg.x + wg.y * nw.x;
  let i = blk * 256u + li;
  if (i < u32(cam.size.w) && proj[i * 16u + 11u] > 0.5) { atomicAdd(&cnt, 1u); }
  workgroupBarrier();
  if (li == 0u) { blocks[blk] = atomicLoad(&cnt); }
}
`;

// single workgroup: exclusive scan of the block counts (in place), total ->
// proj tail, dispatch args -> disp (chain @0, adam @4, sh-adam @8; x,y,z each)
export const VIS_SCAN_SRC = CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> blocks: array<u32>;
@group(0) @binding(2) var<storage, read_write> proj: array<f32>;
@group(0) @binding(3) var<storage, read_write> disp: array<u32>;
@group(0) @binding(4) var<uniform> vu: vec4u; // x = 3K (SH rest coeffs per splat)
const CHUNK = 64u; // 256 x 64 blocks = 16384 blocks = 4.2M splats
var<workgroup> sums: array<u32, 256>;
fn groups2d(total: u32, at: u32) {
  let g = (total + 255u) / 256u;
  if (g <= 65535u) { disp[at] = max(g, 1u); disp[at + 1u] = 1u; }
  else { disp[at] = 65535u; disp[at + 1u] = (g + 65534u) / 65535u; }
  disp[at + 2u] = 1u;
}
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let n = u32(cam.size.w);
  let nb = (n + 255u) / 256u;
  var local = 0u;
  for (var k = 0u; k < CHUNK; k++) { let t = li * CHUNK + k; if (t < nb) { local += blocks[t]; } }
  sums[li] = local;
  workgroupBarrier();
  if (li == 0u) { var acc = 0u; for (var k = 0u; k < 256u; k++) { let v = sums[k]; sums[k] = acc; acc += v; } }
  workgroupBarrier();
  var acc = sums[li];
  for (var k = 0u; k < CHUNK; k++) {
    let t = li * CHUNK + k;
    if (t >= nb) { break; }
    let v = blocks[t]; blocks[t] = acc; acc += v;
  }
  if (li == 255u) {
    let total = acc;
    let tail = bitcast<u32>(cam.misc3.w);
    proj[tail] = bitcast<f32>(total);
    groups2d(total, 0u);          // chain: one thread per visible splat
    groups2d(total * 16u, 4u);    // adam: 16 params per visible splat
    groups2d(total * vu.x, 8u);   // sh-adam: 3K coeffs per visible splat
  }
}
`;

// per block of 256 splats: rank the visible ones (shared prefix, stable) and
// write ids at blockOffset + rank
export const VIS_SCATTER_SRC = CAM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> proj: array<f32>;
@group(0) @binding(2) var<storage, read> blocks: array<u32>;
var<workgroup> pre: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u,
        @builtin(num_workgroups) nw: vec3u) {
  let blk = wg.x + wg.y * nw.x;
  let i = blk * 256u + li;
  let vis = i < u32(cam.size.w) && proj[i * 16u + 11u] > 0.5;
  pre[li] = select(0u, 1u, vis);
  workgroupBarrier();
  for (var o = 1u; o < 256u; o = o << 1u) {
    var v = 0u;
    if (li >= o) { v = pre[li - o]; }
    workgroupBarrier();
    pre[li] += v;
    workgroupBarrier();
  }
  if (vis) {
    let tail = bitcast<u32>(cam.misc3.w);
    proj[tail + 1u + blocks[blk] + pre[li] - 1u] = bitcast<f32>(i);
  }
}
`;

// Adam / SH-Adam variants: 'all' = every param (the classic pass); 'compact'
// = params of visible splats through the proj-tail list (indirect dispatch);
// 'invis' = invisible splats only, the reg + noise slots (pos 0-2 for the
// Langevin noise, scales 3-5 for scaleReg, opacity 13 for opacityReg) with a
// zero data gradient — keeps the MCMC death signal the compaction would
// otherwise silence (rung 2: regVisOnly cost −0.02 / −0.15)
export const makeAdamSrc = (mode = 'all') => {
  let s = ADAM_SRC;
  if (mode === 'all') return s;
  s = s.replace('@group(0) @binding(4) var<storage, read_write> vBuf: array<f32>;',
    '@group(0) @binding(4) var<storage, read_write> vBuf: array<f32>;\n@group(0) @binding(5) var<storage, read> proj: array<f32>;');
  const head = '  let j = gid.x + gid.y * nw.x * 256u;\n  if (j >= u32(au.cl.w)) { return; }';
  if (!s.includes(head)) throw new Error('adam head anchor');
  if (mode === 'compact') {
    s = s.replace(head, '  let jw = gid.x + gid.y * nw.x * 256u;\n  let tail = bitcast<u32>(au.flg.w);\n  if (jw >= bitcast<u32>(proj[tail]) * 16u) { return; }\n  let j = bitcast<u32>(proj[tail + 1u + jw / 16u]) * 16u + (jw % 16u);');
  } else if (mode === 'invis') {
    s = s.replace(head, '  let j = gid.x + gid.y * nw.x * 256u;\n  if (j >= u32(au.cl.w)) { return; }\n  if (proj[(j / 16u) * 16u + 11u] > 0.5) { return; }\n  let sl = j % 16u;\n  if (!(sl <= 5u || sl == 13u)) { return; }');
    s = s.replace('  var g = gradF[j];', '  var g = 0.0; // invisible: no data gradient, regs + noise only');
  }
  return s;
};
export const makeSHAdamSrc = (mode = 'all') => {
  let s = SH_ADAM_SRC;
  if (mode === 'all') return s;
  s = s.replace('@group(0) @binding(4) var<storage, read_write> vBuf: array<f32>;',
    '@group(0) @binding(4) var<storage, read_write> vBuf: array<f32>;\n@group(0) @binding(5) var<storage, read> proj: array<f32>;');
  const head = '  let j = gid.x + gid.y * nw.x * 256u;\n  if (j >= u32(au.cfg.y)) { return; }';
  if (!s.includes(head)) throw new Error('sh-adam head anchor');
  s = s.replace(head, '  let jw = gid.x + gid.y * nw.x * 256u;\n  let tail = bitcast<u32>(au.cfg.w);\n  let k3 = u32(au.cfg.z);\n  if (jw >= bitcast<u32>(proj[tail]) * k3) { return; }\n  let j = bitcast<u32>(proj[tail + 1u + jw / k3]) * k3 + (jw % k3);');
  return s;
};
