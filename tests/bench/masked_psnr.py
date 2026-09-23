"""masked_psnr.py — PSNR inside the person's matte from RENDERS, recipe-independent.

Renders come from tests/bench/render_views.html (the photo's own camera, width W);
the photo and its matte are resized to the render. Pixels with matte > 0.75
count (the trainer's maskCut), against the photo composited on black where the
render background is black — the same convention as the in-trainer score.

  python tests/bench/masked_psnr.py <renders_prefix> <frames_dir> <masks_dir> <recon.json> <cams e.g. 5,10,15>
"""
import sys, json, glob, os
import numpy as np
from PIL import Image

prefix, frames_dir, masks_dir, recon_p, cams_s = sys.argv[1:6]
recon = json.load(open(recon_p))
rows = []
for ci in [int(x) for x in cams_s.split(',')]:
    fr = recon['frames'][recon['cams'][ci]['imgIdx']]
    rp = sorted(glob.glob(f'{prefix}_{ci:03d}.png'))
    if not rp: print(f'cam {ci}: no render'); continue
    r = np.asarray(Image.open(rp[0]).convert('RGB'), dtype=np.float64) / 255
    H, W = r.shape[:2]
    p = np.asarray(Image.open(os.path.join(frames_dir, fr['name'])).convert('RGB').resize((W, H), Image.LANCZOS), dtype=np.float64) / 255
    m = np.asarray(Image.open(os.path.join(masks_dir, fr['name'].rsplit('.', 1)[0] + '.png')).convert('L').resize((W, H), Image.BILINEAR), dtype=np.float64) / 255
    sel = m > 0.75
    if sel.sum() < 100: print(f'cam {ci}: empty matte'); continue
    # the trainer composites its target with the subject alpha; on a black
    # background that is alpha * photo
    tgt = p * m[..., None]
    mse = ((r[sel] - tgt[sel]) ** 2).mean()
    psnr = -10 * np.log10(max(mse, 1e-12))
    rows.append((ci, psnr, int(sel.sum())))
    print(f'cam {ci:2d} {fr["name"]}: {psnr:6.2f} dB over {sel.sum()} px')
if rows:
    v = np.array([r[1] for r in rows])
    print(f'MASKED PSNR mean {v.mean():.2f} dB, median {np.median(v):.2f}, min {v.min():.2f}, n {len(v)}')
