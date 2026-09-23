"""prior_cover.py — sort a prior seed by what the training photographs can see.

Each Gaussian of the aligned prior is projected into the chosen training
cameras; it counts as SEEN when it lands inside the person's matte in at least
`min_views` of them. The output PLY holds the seen rows first and the unseen
rows after them, so the trainer's contiguous freeze/protect range
(setFreezePos / protect) can cover exactly the unseen part: the photographs
train what they see, the prior keeps what they never saw.

  python tests/bench/prior_cover.py scratch/keyhole/recon.json scratch/keyhole/masks \
      scratch/keyhole/prior_sfm.ply 1,12,23,34,45,56 scratch/keyhole/prior_cov.ply [min_views]
Prints the split point (the &freezefrom= / &protectfrom= value for keyhole.js).
"""
import json, sys, os
import numpy as np
from PIL import Image
from plyfile import PlyData, PlyElement

recon_p, masks_dir, ply_p, cams_s, out_p = sys.argv[1:6]
min_views = int(sys.argv[6]) if len(sys.argv) > 6 else 2
# depth margin in SfM units: 4 cm at the prior's own scale (prior_sfm_align.json)
align_p = ply_p.replace('.ply', '_align.json')
scale = json.load(open(align_p))['scale'] if os.path.exists(align_p) else 1.0
margin_units = 0.04 * scale
recon = json.load(open(recon_p))
train = [int(x) for x in cams_s.split(',')]
ply = PlyData.read(ply_p)
v = ply['vertex'].data
xyz = np.stack([v['x'], v['y'], v['z']], 1).astype(np.float64)
seen = np.zeros(len(v), dtype=np.int32)
for ci in train:
    c = recon['cams'][ci]; fr = recon['frames'][c['imgIdx']]
    R = np.array(c['R']).reshape(3, 3); t = np.array(c['t'])
    f = c['f']; fy = c.get('fy', f); cx = c.get('cx', fr['fw'] / 2); cy = c.get('cy', fr['fh'] / 2)
    m = np.asarray(Image.open(os.path.join(masks_dir, fr['name'].rsplit('.', 1)[0] + '.png')).convert('L'))
    mh, mw = m.shape
    X = (R @ xyz.T).T + t
    z = X[:, 2]
    u = f * X[:, 0] / np.maximum(z, 1e-9) + cx; w = fy * X[:, 1] / np.maximum(z, 1e-9) + cy
    # feature-scale pixels -> matte pixels
    ui = np.clip((u * mw / fr['fw']).astype(int), 0, mw - 1); wi = np.clip((w * mh / fr['fh']).astype(int), 0, mh - 1)
    inside = (z > 0) & (u >= 0) & (u < fr['fw']) & (w >= 0) & (w < fr['fh']) & (m[wi, ui] > 127)
    # occlusion by the prior itself: a coarse depth buffer over the splat
    # centres (BIN px cells at feature scale); a splat is in front when it is
    # within MARGIN of the nearest centre in its cell (the back of the torso
    # projects inside the silhouette too, but sits half a body behind)
    BIN = 6; MARGIN = margin_units
    bu = np.clip((u / BIN).astype(int), 0, fr['fw'] // BIN); bw = np.clip((w / BIN).astype(int), 0, fr['fh'] // BIN)
    key = bw * (fr['fw'] // BIN + 1) + bu
    zmin = np.full(key.max() + 1, np.inf)
    np.minimum.at(zmin, key[inside], z[inside])
    front = inside & (z <= zmin[key] + MARGIN)
    seen += front.astype(np.int32)
    print(f'cam {ci:2d} {fr["name"]}: {inside.sum()} inside the matte, {front.sum()} of them in front')
ok = seen >= min_views
order = np.concatenate([np.where(ok)[0], np.where(~ok)[0]])
out = v[order]
PlyData([PlyElement.describe(out, 'vertex')], text=False).write(out_p)
print(f'{ok.sum()} seen by >= {min_views} of {len(train)} cameras, {(~ok).sum()} unseen -> {out_p}; freezefrom={ok.sum()}')
