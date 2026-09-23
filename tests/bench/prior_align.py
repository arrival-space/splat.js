"""prior_align.py — put a generative human prior into an orbit's SfM frame.

Inputs
  recon.json          the solve (cams at feature scale: x_cam = R X + t, u = f x/z + cx)
  frames_prior.json   Multi-HMR per frame: 2D SMPL-X joints in raw image pixels (frames_prior.py)
  joints.json         the prior's posed SMPL-X joints, same joint order (export_tom.py)
  posed.ply           the prior's Gaussians in that posed frame (export_tom.py)

The body joints are triangulated over every camera that saw them (robust DLT,
the landmarks stage's recipe), a similarity is fitted from the prior's joints
to the triangulated ones (Umeyama, no reflection), and the Gaussians are
carried over: positions, log-scales (+log s), rotations (R q), colours as they
are (degree 0 only — the higher bands would need rotating, and the keyhole
trains at degree 0 anyway).

  python tests/bench/prior_align.py scratch/keyhole/recon.json scratch/keyhole/frames_prior.json \
      scratch/keyhole/lhm/joints.json scratch/keyhole/lhm/posed.ply scratch/keyhole/prior_sfm.ply
"""
import json, sys
import numpy as np
from plyfile import PlyData, PlyElement

recon_p, fp_p, joints_p, ply_p, out_p = sys.argv[1:6]
recon = json.load(open(recon_p))
fp = json.load(open(fp_p))
jj = json.load(open(joints_p))

# ── cameras at feature scale, as 3x4 projection rows ─────────────────────────
frames = recon['frames']
cams = []
for c in recon['cams']:
    fr = frames[c['imgIdx']]
    R = np.array(c['R'], dtype=np.float64).reshape(3, 3)
    t = np.array(c['t'], dtype=np.float64)
    f = c['f']; fy = c.get('fy', f); cx = c.get('cx', fr['fw'] / 2); cy = c.get('cy', fr['fh'] / 2)
    K = np.array([[f, 0, cx], [0, fy, cy], [0, 0, 1]])
    P = K @ np.hstack([R, t[:, None]])
    cams.append({'P': P, 'name': fr['name'], 'fw': fr['fw'], 'fh': fr['fh']})

# ── 2D joints per camera, raw pixels -> feature scale ────────────────────────
obs = {}   # joint index -> list of (P, u, v)
n_j = None
for ci, c in enumerate(cams):
    e = fp.get(c['name'])
    if not e or e.get('humans') != 1: continue
    j2d = np.array(e['j2d'], dtype=np.float64)
    if n_j is None: n_j = len(j2d)
    sx = c['fw'] / e['size'][0]; sy = c['fh'] / e['size'][1]
    for j in range(len(j2d)):
        obs.setdefault(j, []).append((c['P'], j2d[j, 0] * sx, j2d[j, 1] * sy))

def reproj(X, P):
    q = P @ np.append(X, 1.0)
    return None if q[2] <= 1e-9 else q[:2] / q[2]

def dlt(rows):
    A = []
    for P, u, v in rows:
        A.append(u * P[2] - P[0]); A.append(v * P[2] - P[1])
    A = np.array(A)
    _, _, vt = np.linalg.svd(A)
    X = vt[-1]
    return X[:3] / X[3]

def triangulate(rows, min_px=3.0, min_views=4):
    cur = list(rows)
    if len(cur) < min_views: return None
    X = dlt(cur)
    for _ in range(6):
        e = [np.hypot(*(reproj(X, P) - (u, v))) if reproj(X, P) is not None else 1e9 for P, u, v in cur]
        med = float(np.median(e)); cut = max(min_px, 1.5 * med)
        keep = [r for r, ei in zip(cur, e) if ei <= cut]
        if len(keep) < min_views or len(keep) == len(cur): break
        cur = keep; X = dlt(cur)
    e = [np.hypot(*(reproj(X, P) - (u, v))) if reproj(X, P) is not None else 1e9 for P, u, v in cur]
    return X, len(cur), float(np.median(e))

# SMPL-X body joints 0..21 (pelvis .. wrists); hands and face are too noisy in 2D
BODY = list(range(22))
names = jj.get('names') or []
tri = {}
for j in BODY:
    r = triangulate(obs.get(j, []))
    if r: tri[j] = r
print(f'{len(tri)} of {len(BODY)} body joints triangulated over up to {len(cams)} cameras')
for j, (X, nv, err) in tri.items():
    print(f'  {j:2d} {names[j] if j < len(names) else "":10s} {nv:3d} views  {err:5.2f} px')

# ── similarity: prior joints (metric, posed frame) -> SfM joints ─────────────
prior = np.array(jj['posed'], dtype=np.float64)
src = np.array([prior[j] for j in tri]); dst = np.array([tri[j][0] for j in tri])
def umeyama(src, dst):
    mu_s, mu_d = src.mean(0), dst.mean(0)
    S, D = src - mu_s, dst - mu_d
    cov = D.T @ S / len(src)
    U, sig, Vt = np.linalg.svd(cov)
    d = np.ones(3); d[2] = np.sign(np.linalg.det(U @ Vt))
    R = U @ np.diag(d) @ Vt
    s = (sig * d).sum() / (S ** 2).sum() * len(src)
    t = mu_d - s * R @ mu_s
    return s, R, t
s, R, t = umeyama(src, dst)
res = np.linalg.norm((s * (R @ src.T).T + t) - dst, axis=1)
print(f'similarity: scale {s:.4f} SfM units per metre, residual mean {res.mean() / s * 100:.1f} cm, max {res.max() / s * 100:.1f} cm')
for k, j in enumerate(tri):
    print(f'  {j:2d} {names[j] if j < len(names) else "":10s} {res[k] / s * 100:5.1f} cm')

# ── carry the Gaussians over ─────────────────────────────────────────────────
ply = PlyData.read(ply_p)
v = ply['vertex'].data
xyz = np.stack([v['x'], v['y'], v['z']], 1).astype(np.float64)
xyz2 = s * (R @ xyz.T).T + t
scales = np.stack([v['scale_0'], v['scale_1'], v['scale_2']], 1) + np.log(s)
q = np.stack([v['rot_0'], v['rot_1'], v['rot_2'], v['rot_3']], 1).astype(np.float64)   # w x y z
def mat_to_quat(M):
    w = np.sqrt(max(0.0, 1 + M[0, 0] + M[1, 1] + M[2, 2])) / 2
    x = np.sqrt(max(0.0, 1 + M[0, 0] - M[1, 1] - M[2, 2])) / 2
    y = np.sqrt(max(0.0, 1 - M[0, 0] + M[1, 1] - M[2, 2])) / 2
    z = np.sqrt(max(0.0, 1 - M[0, 0] - M[1, 1] + M[2, 2])) / 2
    x = np.copysign(x, M[2, 1] - M[1, 2]); y = np.copysign(y, M[0, 2] - M[2, 0]); z = np.copysign(z, M[1, 0] - M[0, 1])
    return np.array([w, x, y, z])
qr = mat_to_quat(R)
def qmul(a, b):
    w1, x1, y1, z1 = a.T; w2, x2, y2, z2 = b.T
    return np.stack([w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2, w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
                     w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2], 1)
q2 = qmul(np.tile(qr, (len(q), 1)), q)
q2 /= np.linalg.norm(q2, axis=1, keepdims=True)

fields = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
out = np.empty(len(v), dtype=[(f, 'f4') for f in fields])
out['x'], out['y'], out['z'] = xyz2.T.astype(np.float32)
out['nx'] = out['ny'] = out['nz'] = 0
for k in ['f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity']: out[k] = v[k]
out['scale_0'], out['scale_1'], out['scale_2'] = scales.T.astype(np.float32)
out['rot_0'], out['rot_1'], out['rot_2'], out['rot_3'] = q2.T.astype(np.float32)
PlyData([PlyElement.describe(out, 'vertex')], text=False).write(out_p)
op = 1 / (1 + np.exp(-v['opacity']))
print(f'wrote {out_p}: {len(v)} Gaussians, opacity median {np.median(op):.2f}, '
      f'scale median {np.exp(np.median(scales)):.4f} SfM units, bbox {xyz2.min(0).round(2)} .. {xyz2.max(0).round(2)}')
json.dump({'scale': s, 'R': R.tolist(), 't': t.tolist(), 'residual_cm_mean': float(res.mean() / s * 100),
           'joints': {int(j): {'views': tri[j][1], 'px': tri[j][2], 'X': tri[j][0].tolist()} for j in tri}},
          open(out_p.replace('.ply', '_align.json'), 'w'), indent=1)
