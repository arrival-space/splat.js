"""declaw.py — cap the axis ratio of every splat in a PLY (needle splats -> thin ellipsoids).

A trainer that renders with mip-splatting compensation never sees its own
needles (their opacity is cut when they fall under a pixel), a classic viewer
(PlayCanvas, the client) draws them as streaks. This raises the two small
scales of any splat whose long/short ratio exceeds `max_ratio` so the ratio is
exactly that; nothing else changes.

  python tests/bench/declaw.py in.ply out.ply [max_ratio=8]
"""
import sys
import numpy as np
from plyfile import PlyData, PlyElement

src, dst = sys.argv[1], sys.argv[2]
R = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
ply = PlyData.read(src)
v = ply['vertex'].data.copy()
sc = np.stack([v['scale_0'], v['scale_1'], v['scale_2']], 1).astype(np.float64)   # log scales
mx = sc.max(1, keepdims=True)
floor = mx - np.log(R)
before = np.exp(mx[:, 0] - sc.min(1))
sc2 = np.maximum(sc, floor)
after = np.exp(sc2.max(1) - sc2.min(1))
for k in range(3): v[f'scale_{k}'] = sc2[:, k].astype(np.float32)
PlyData([PlyElement.describe(v, 'vertex')], text=False).write(dst)
print(f'{len(v)} splats: ratio>10 {np.mean(before > 10) * 100:.1f}% -> {np.mean(after > 10) * 100:.1f}%, median {np.median(before):.1f} -> {np.median(after):.1f}, touched {np.mean(before > R) * 100:.1f}%')
