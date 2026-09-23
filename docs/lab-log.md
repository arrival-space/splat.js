# Lab log

What we tried, what it did, what it cost. Newest first. PSNR numbers are
held-out (eval8) unless noted; "noise band" on repeated truck 40k runs is
about ±0.1 dB.

## 2026-09-22 (what the client draws: the cut wrecks a GenAI body, the trained ones survive it)

The user: avatar 5816 (the untrained LHM++ body) "is deformed weirdly in app,
not just the rigged, just the splat without anim applied — something went
wrong while export". Also bad in SuperSplat. Our own renders of the same body
were clean — the sheets had flattered it. Two tools out of that:
- `render_orbit.js` `&pc=<file.sog>` renders through the PlayCanvas engine
  (app/js/pcview.js) — what the client, the share viewer and SuperSplat draw;
  the WebGL canvas cannot be read back, so `page_run.mjs` screenshots it on a
  title cue. Every sheet from here on is rendered this way before a verdict.
- `keyhole.js` `&nocut=1`: skip the hull cut for a model that is already the
  person alone.

**Found by elimination, each step a direct test:** the account's PLY is
byte-identical to the package (MD5 in its name); the export equals the
aligned seed row for row (scales, colours, opacity); quaternion order, tail
cutoff (3σ, standard) and the SOG step all innocent. Then, through PlayCanvas:
the UNCUT 12-frame body renders clean, the same body AFTER THE CUT is the
smeared, flattened head of 5816 (`scratch/faces_pc_cut_test.png`). The cut
(visual hull, dilated matte, hard top above the head landmarks) is built for
a person in a room; a GenAI body is a stack of thin, third-opacity layers
(160k splats, ~12/cm²) and the carving strips the face's outer layer and the
top of the hair. Rebuilt without the cut, bound 158,534 splats at 1.9 cm,
published by the CLI: **avatar 5821** (5816 superseded).

**The trained avatars checked the same way** (`scratch/faces_pc_all.png`):
masked uncut, masked cut (5813), masked cut+declawed, room+GenAI cut+declawed
— all intact through the cut in PlayCanvas, front, sides, back. The one
defect every trained version shares is the crown from straight above, which
no orbit camera saw: blotchy, with a needle cluster. Not the cut, the data.

Also today: `tests/bench/declaw.py` (axis-ratio cap after training, 8) is
what removes the PlayCanvas streaks; needleReg 0.03 alone only halved the
median ratio (135 → 55). And the account route without a button:
`arrival avatar publish` in the arrival CLI, after the user's `arrival login`.

## 2026-09-21b (back to the room recipe — and a correction to the 6 dB story)

The user: the matte-only recipe "always created worse results ... fuzzy
surfaces on the face", switch the seeded training back to the full room; and
"the seed then will vanish". Harness got `&room=1` (the app's `maskTraining:
false`: mattes stay on the frames for the hull and the cut, targets carry full
alpha) and `&seed=cloud&append=<ply>` (the body's rows appended to the cloud
seed, the face-seed mechanism, SH-DC → sigmoid logits; `&protect=N`). The
in-trainer PSNR is full-frame under `room=1`, so a render-based masked scorer
was added (`tests/bench/masked_psnr.py` on `render_views.html` renders at the
photo's own cameras; reads ~0.9 dB above the in-trainer masked number, compare
within it only). All rows: 54 cameras, 30k, SH 0, then the shipped cut.

| row | recipe | seed | masked dB (renders) | bound splats |
|---|---|---|---|---|
| H | room (the shipped path) | SfM cloud | 28.2 | 46k |
| G | room | cloud + LHM++12 body, unprotected | 28.8 | 136k |
| F | room | cloud + LHM++12 body, protected all run | 28.7 | 106k |
| E | masked | LHM++12 body | 31.7 (its own matte) | 272k |

**The seed does not vanish in the room** — G = F by eye and by number. With
the full orbit every part of the body gets a gradient from some photo; the
dead count the trainer reports (119k by 20k) is the ROOM's churn, not the
body's. Protection is free insurance, not a requirement.

**Correction.** The "6 dB, holes to a person" of 09-20c was measured against
the MASKED cloud row (A), which is not the shipped path. The shipped room
recipe from the cloud (H) already has feet, legs and a back — the room recipe
keeps the legs that the matte recipe lost. Against H the GenAI seed is worth
**+0.6 dB masked and three times the bound splats** (a denser body), and by
eye a slightly cleaner crown; the face is the same. Sheet:
`scratch/room_three_way.png` (H / G / E, bodies and heads).

Where the GenAI seed is decisive stays as measured: the few-photo case
(6 cams: 22.6 vs 20.0) and the masked recipe. In the shipped recipe it is a
modest gain, and the shipped recipe's own advantage over the masked one — the
face the user prefers, the legs — holds with or without it.

E versus H by eye: E's face is not fuzzier than H's in these renders; the
user's "fuzzy" verdict came from the app at full resolution, so the face pass
comparison is still the right next test, on the room recipe.

## 2026-09-21 (twelve frames into LHM++, and the avatar on the account)

Sixteen frames into LHM++ overflow the 16 GB card in the image transformer
(SDPA already; the point encoder was yesterday's fix) — twelve fit. Export cap
in `to_gs_ply.py` lifted 8 → 16 for the record.

| LHM++ frames in | alone | + 54 cams, 30k |
|---|---|---|
| 8 (09-20d) | 18.4 | 30.7 |
| 12 | 18.3 | 30.8 (min cam 28.3 vs 27.7) |
| 16 | — | out of memory on the 5080 |

Same within noise; twelve taken for the account because its worst camera is
half a dB better. Live: `…/index.html?model=…/tom_lhmpp12_54cams_20260921.sog&recon=…_recon.json`.

**On the account:** the keyhole harness's `&avatar=1` route ran the shipped
stages on the trained session (landmarks 15 markers, cut, body fit 2.1 cm,
bind 271,668 splats at 1.47 cm, SOG 3.6 MB), the user clicked "Use as my
avatar" and signed in, and the publish stage put it up: **avatar 5813**. That
is the first GenAI-seeded avatar on arrival.space, Tom, twelve orbit frames
into LHM++ plus the full orbit trained on it.

Noted for the shipped path: the harness trains masked (matte in the loop,
random background outside) and cuts afterwards; the app trains the whole room
and cuts. The comparison of the two on the same clip is still owed.

## 2026-09-20d (LHM++: several photos into the body itself — 30.7 dB, and "no training" measured)

LHM++ (aigc3d/LHM-plusplus, code released 2026-03-16, Apache-2.0, 700M
parameters, 8 GB) takes ONE OR MANY pose-free photos and returns a 3DGS body
(160,000 Gaussians) in the canonical pose or any SMPL-X pose. Installed next
to LHM in the same WSL env (`~/lhm/LHM-plusplus`; extras: gsplat 1.4.0,
pointops, torch_scatter, spconv-cu120, xformers 0.0.31 for torch 2.7.1).
Two Blackwell gotchas: no flash_attn on sm_120, and the Sonata point
encoder's fallback materialises a (patches × heads × 1024²) attention that
runs the 16 GB card out of memory — patched to fused SDPA
(`core/models/encoders/sonata/model.py`, original kept as `.orig`); and the
same OOM is what made the first one-frame run crawl for 20 minutes. With the
patch: ~50 s per export including the model load, 1–8 frames.

Tom's orbit frames in (2 / 2,18,34,50 / every eighth), posed with the
orbit-refined SMPL-X pose (`scripts/inference/to_gs_ply.py --pose_dir`), same
alignment as before (the body lands in the same frame as LHM's, 1.3 cm).

| body | frames in | alone (no training) | + 6 cams, 3k | + 54 cams, 30k |
|---|---|---|---|---|
| LHM-MINI (09-19/20) | 1 | 15.7 | 22.1 | 29.0–29.4 |
| LHM++ | 1 | 16.4 | — | — |
| LHM++ | 4 | 18.1 | — | — |
| **LHM++** | **8** | **18.4** | **22.6** | **30.7** |
| SfM cloud (reference) | — | — | 20.0 | 23.2 |

**"Maybe we need no training at all"** (the user): measured no. Eight frames
into LHM++ give a complete, clean body at 18.4 dB — a plausible person,
generic face, painted stripes, hair as a shell — 12 dB under the trained
result and visibly not Tom in the face. The body model is the SHAPE; the
photographs are the identity, and only the trainer puts them on.

**As the seed, LHM++ beats LHM-MINI by 1.3 dB** with the full orbit (30.7 vs
29.4) and by 0.5 at six photos (22.6 vs 22.1): more frames into the prior =
a better back and sides to start from. Sheets: `scratch/pp8_alone_sheet.png`,
`scratch/pp8_54_sheet.png`. Live:
`https://arrival.space/splat-js/index.html?model=https://ugc.arrival.space/splatjs/models/tom_lhmpp8_54cams_20260920.sog&recon=https://ugc.arrival.space/splatjs/models/tom_lhmpp8_54cams_20260920_recon.json`

So the pipeline shape stands: orbit → a few frames to LHM++ (one second) →
align on the solved cameras → seed → train. The prior's job is the closed
shape; nothing on the shelf replaces the training for likeness.

## 2026-09-20c (the GenAI body as the seed for the FULL orbit: the best Tom we ever had)

The row 09-19 never ran: the LHM body (one photo, 20,000 Gaussians, aligned
into the orbit) as the seed, then ALL 54 training cameras. Same trainer, same
photos, same 11 test cameras — only the seed differs from the cloud row.

| seed | cams | 3k | 30k |
|---|---|---|---|
| SfM cloud | 54 | 21.6 | 23.2 |
| **GenAI body** | 54 | 26.6 | **29.0–29.4** (three runs) |
| SfM cloud | 6 | 19.6 | 20.0 |
| GenAI body | 6 | 22.1 | 21.7 |

Six dB, and the sheets say why: from the cloud the model dissolves below the
knees and has no feet from any of ten virtual cameras; from the GenAI seed
it is a whole person — legs, shoes, soles from straight above, the back, the
crown — with the face and the stripes of the photographs on top. The face is
equal to the cloud row's, not softer. The user, on the sheets: "the best tom
we ever had". Renders: `tests/bench/render_orbit.html|js` (virtual orbit, az:el,
`&target=head`), sheets `scratch/orbit_A_vs_D.png`, `scratch/face_A_vs_D.png`,
`scratch/all_on_genai.png`; the six-photo version `scratch/six_on_genai.png`;
the raw one-photo body `scratch/prior_only_sheet.png`.

Live: `https://arrival.space/splat-js/index.html?model=https://ugc.arrival.space/splatjs/models/tom_genai54_20260920.sog&recon=https://ugc.arrival.space/splatjs/models/tom_genai54_20260920_recon.json`
(the `/splat-js/?model=` form redirects and drops the query).

**What the seed is, in one line:** a closed surface where the orbit has no
evidence, kept because nothing argues against it — the trainer carves the
photographed parts out of it and leaves the rest standing. The 09-20 verdict
that the prior is "the seed, not a constraint" holds; what was wrong on 09-19
was the missing row, not the idea.

**Next:** the seed into the app's avatar path (server call: one frontal frame
→ LHM → posed body + joints; align on the solved cameras; seed; train as
today), then the shipped recipe vs this on the same clip; the six-photo
package (prior6, bound) and this one are ready for the account.

## 2026-09-20b (the prior's pose from the orbit: +0.8 dB alone, noise with photos)

Multi-HMR's pose comes from one frontal frame; the orbit knows better. `~/lhm/LHM/refine_pose.py`
(WSL) takes the 22 body joints prior_align.py triangulated over the 65 cameras,
maps them into the prior's metric frame through the fitted similarity, and
refines the SMPL-X root + body rotations on LHM's own layer (Adam, 400 steps,
5 s, a small pull toward the photo's pose), then poses the same Gaussians again.

| | joint residual | prior alone | prior + 6 cams, 3k |
|---|---|---|---|
| Multi-HMR pose (09-19) | 1.8 cm mean / 4.5 max | 14.9 dB | 22.1 dB |
| refined against the orbit | 1.3 / 3.6 | **15.7** | 22.2 |

Rotations moved by at most 4°; wrists and elbows halved their error, the
ankles (3.8 cm) did not — that is the 2D detector's noise on shoes, not the
pose. The prior alone gains 0.8 dB; with six photographs the trainer had
already absorbed the difference (+0.1, noise band). The doubled left hand at
camera 50 is still there after the refinement: it is not the arm's rotation
but the HAND (fingers and wrist twist are not refined, and hands are the
noisiest joints in 2D). Sheet: `scratch/keyhole_sheet_cam50_ref.png`
(photo · prior · prior refined · each + 6 photos).

So the pose is not the lever either at six photos; the trainer fixes what it
sees. What remains open: the hands, and the prior's own fidelity (LHM++ with
several photos into the prior).

## 2026-09-20 (six photos: the prior's geometry, locked or slowed, measured negative)

The user, on the LHM views: "when the avatar looks like that everywhere the
generalization would be acceptable" — then "the more it fits to the original
the better". So: how much of the prior's clean geometry survives the fit?
Trainer got `opts.lockGeom` / `opts.geomLrScale` (one factor on the position,
scale and rotation learning rates; colour and opacity untouched); the harness
`&lock=1`, `&geomlr=`, `&nogrow=1`. Same keyhole as 09-19 (six cameras, the
11 fixed test cameras, masked PSNR).

| prior seed, 6 cams | 3k | 30k | 30k, no growth/relocation |
|---|---|---|---|
| free (09-19) | **22.1** | 21.7 | 21.4 |
| geometry ×0.3 | 21.5 | 20.1 | 21.0 |
| geometry ×0.1 | 20.6 | 20.1 | 21.2 |
| geometry locked (colour + opacity only) | 18.1 | 18.0 | — |

Locked geometry keeps the shape and smears the paint (train PSNR 19.5 dB: the
photographs land on splats that cannot move to meet them — the 1.8 cm fit
residual and Multi-HMR's arm are baked in). Every slower rate lands between.
Growth off at 30k is worth +0.3 over growth on, still under the free 3k.

**Verdict (conditional on this recipe):** the prior's job is the seed, not a
constraint. The free trainer for a short budget is the best fit to the
original at six photos; what limits it now is where the prior sits, so the
next lever is the prior's POSE (refine SMPL-X against the triangulated joints
before posing), not the trainer.

## 2026-09-19 (a stable human from six photos: the generative prior as the seed)

The question, from the user: "a stable human with only some images". The
family that answers it is the feed-forward human reconstructor (LHM / LHM++);
the idea tested here is to use its output as the SEED for our trainer, so the
photographs refine what they see and the prior supplies the rest.

**LHM-MINI runs on the 5080**, in WSL2 (`~/lhm`, micromamba, torch 2.7.1+cu128,
pytorch3d and the rasterizer built for sm_120, `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1`
for their checkpoints): one frontal frame of Tom's orbit → 20,000 canonical
Gaussians in 2.7 s, peak 14.5 GB (the 500M model wants 18 GB — MINI is the only
fit on this card). Multi-HMR gives the SMPL-X shape and pose of the photo; the
same Gaussians posed as in the photo are what we align.

**Into the SfM frame** (`tests/bench/prior_align.py`): Multi-HMR's 2D joints
on all 65 orbit frames (`frames_prior.py`, with a SAM2 matte per frame),
triangulated over the solved cameras (22 body joints, 11–40 views each,
1.3–11 px), then a similarity from the prior's posed joints: **14.86 SfM units
per metre** (the known Tom scale), residual **1.8 cm mean, 4.5 cm max**.
The rotation carries the quaternions, log s the scales, colours stay (degree 0).

**The keyhole** (`tests/bench/keyhole.html|js`, `keyhole_run.mjs`): the saved
09-14 Tom session's cameras and frames, mattes from SAM2, a fixed test set of
11 cameras (5,10,…,60) that no row ever trains on, PSNR inside the matte at
those 11, 720×1280, SH degree 0, masked training, default trainer otherwise
(NOT the app's avatar recipe — every row shares this one, so the rows compare
with each other, not with the README). Six training cameras 1,12,23,34,45,56.

| seed | trained on | iters | held-out dB (11 cams) | train dB | splats |
|---|---|---|---|---|---|
| LHM prior alone, aligned | — | 0 | **14.9** | — | 20k |
| SfM cloud | 6 cams | 3k | 19.6 | 24.1 | 60k |
| SfM cloud | 6 cams | 30k | 20.0 | 27.9 | 182k |
| **LHM prior** | **6 cams** | **3k** | **22.1** | 33.1 | 20k |
| LHM prior | 6 cams | 30k | 21.7 | 42.4 | 61k |
| LHM prior, all rows frozen | 6 cams | 3k / 30k | 21.3 / 20.9 | 28 / 30 | 20k |
| LHM prior, unseen third frozen+protected | 6 cams | 3k / 10k / 30k | 22.1 / 21.8 / 21.7 | 32 / 36 / 43 | 20k–61k |
| SfM cloud (the full orbit) | 54 cams | 3k | 21.6 | 21.6 | 60k |
| SfM cloud (the full orbit) | 54 cams | 30k | **23.2** | 23.6 | 182k |

Sheet, held-out camera 50 (photo · prior alone · prior+6 · cloud+6 · cloud+54):
`scratch/keyhole_sheet_cam50.png`. Harness rows: `keyhole_run.mjs
"dir=keyhole&test=5,10,15,20,25,30,35,40,50,55,60&train=1,12,23,34,45,56&seed=prior_sfm.ply&iters=3000&tag=…"`.

**What it says.**
- The prior seed is worth **+2.5 dB** over the cloud seed at six photos and
  equal budget, and by eye it is the difference between a person and a
  streaked torso without legs.
- Six photos plus the prior at 3k (22.1) beat the full orbit at 3k (21.6) and
  sit **1 dB under** the full orbit at 30k (23.2). "Some images" is a real
  product point, not a toy.
- **More iterations hurt at six photos**: 42 dB on the training views, held-out
  down 0.4 dB — the classic few-view overfit. Freezing the unseen third of the
  seed (`prior_cover.py`: in front of the prior's own depth, inside the matte,
  ≥ 2 cameras) changes nothing (22.06 vs 22.10): the drift is on the SEEN
  side, splats specialising to six views. Freezing everything costs 0.8 dB —
  the seen part needs to move to absorb the 1.8 cm alignment error.
- The visible residual is Multi-HMR's pose, not the fit: the prior's left arm
  hangs a hand's width from the photo's, and prior+6 keeps a ghost of it.

**Next**, in order: (1) a few-view regulariser instead of position freezing —
the trainer already has the knobs (opacity/needle reg, relocation off,
lower position lr); the 30k row is the test bed. (2) Fix the arm: refine the
SMPL-X pose against the triangulated joints before posing (a 22-joint IK on
the prior's own layer), or pose per training photo. (3) The app's avatar
recipe on the same rows so the number is comparable to the README. (4) LHM++
when its code lands (several photos into the prior itself). (5) A service:
photos in, `posed.ply` + `joints.json` out, on this box for now.

## 2026-09-18e (Splat.js makes the avatar and hands it over)

The division of labour, from the user: "splat-js need to hand off the avatar
once it's finished, no need to animate it there also no need to actually set it
to the user, so the ui is just for the creation, the inspection is then done in
splat rigger, including the animation attachment etc."

So there is a second ending. `?handoff=1` (and only inside a frame): the finished
package is posted to whoever opened this tool and that is the end of the job —
no walk preview, no account step, no upload. The standalone endings are
untouched, because the public tool at arrival.space/splat-js has no rigger
behind it: Download package, Use as my avatar, and the walk stay there.

**The message vocabulary is the rigger's own**, so nothing new had to be
invented and a host that already listens to the rigger needs one more `source`:

```
{ source: 'splat-js', type: 'splat-asset', assetType: 'splat'|'binding'|'fit'|'thumbnail', name, buffer }
{ source: 'splat-js', type: 'splat-done',  name }
{ source: 'splat-js', type: 'splat-error', message }
```

Same-origin only, buffers transferred rather than copied. The SOG compression is
skipped on this route — the rigger takes the PLY and the host compresses when it
uploads.

**Verified end to end** with `tests/e2e/avatar_handoff.mjs`: a host page
(`scratch/handoff_host.html`) iframes the app with the flag, the run goes from
the clip to a bound avatar, and the host collects

| asset | |
|---|---|
| splat | tom_avatar.ply, 20.01 MB |
| binding | tom_avatar_binding.bin, 1.86 MB |
| fit | tom_avatar_fit.json |
| thumbnail | tom_avatar.png |

then `splat-done`, 114 s after the video went in. That test file is the
executable spec for the rigger side.

**What the rigger still needs** (client_git, not touched here): open
`/splat-js/app/index.html?handoff=1` in a frame — both tools are siblings in the
release web root and under the client's dev server — collect the same messages
under `source === 'splat-js'`, and load the three files the way it already loads
`?splat=&fit=&bin=`. From there its own path continues unchanged: inspect,
attach clips, post the assets to arrival.space.

Why this shape and not a port: everything under `app/avatar/` imports only the
Splat.js library and three small helpers, so the pipeline is portable already —
but the capture shell (video intake, the review card, the strip, the solve and
training progress, the viewer) is `app/js/app.js`, and that is what a port would
have to rebuild. A frame and five message types cost neither.

## 2026-09-18d (the avatar walks, and nothing stands in front of it)

Two asks. "The use as my avatar need to show the avatar in full the user needs
to be able to inspect it so there should be no ui in front of it so show it on
the top right below the other buttons visible in green." And: "please find a
way that it actually walks, take the animation from the splat rigger in
client_git." Plus, mid-run: "at the last stage you can remove the top bar with
the finished steps."

**The last card is a panel now** (`.av-act`, top right under the view
controls): the size line, Download package, and Use as my avatar in the accent
green. The picture card and the step bar both go when the publish stage opens,
so the finished avatar stands alone on the stage with the controls above it.

**And it walks.** The rigger's runtime skins the splat on the GPU inside
PlayCanvas (`client_git/splat-rigger/src/splat-skin.js`: bone deltas in a data
texture, a work-buffer modifier shader). Splat.js has no engine to hang that
on, so the same maths runs on the CPU in `app/avatar/walk.js` and the posed
splats are written into the trainer's parameter buffer between frames:

- the clip is the rigger's own `walking_anim.glb` (Mixamo, 1.03 s, 53 rotation
  tracks + one hips translation), synced into `app/avatar/rig/` by
  `scripts/sync_rig.mjs` with the rest of the rig core;
- `app/avatar/anim.js` parses and samples it (slerp on rotations, linear on the
  hips) and does the forward kinematics — glb.js's own `computeNodeWorldMatrices`
  poses rotations only, and the root translation has to go in as authored;
- per bone `D = world(t) · invFit` (the inverse fit-pose matrices are in the
  SBA1 binding), then `Bm = M⁻¹ · D · M` into splat space with
  `M = S(1/s)·T(−p)·R·F` from the binding's own fit meta;
- per splat `S = Σ w_k·Bm_k` from the binding's 4 indices and weights, centre
  through `S`, and the gaussian's quaternion pre-multiplied by the
  Gram-Schmidt-orthonormalised rotation of `S`. Scale, colour and opacity are
  left alone, exactly as the reference shader leaves them.

**The binding does not index the trainer's rows.** It is built from the PLY
export, which drops dead splats and compacts the rest, so splat *k* of the
binding is not row *k* of `bufParams`. Positions survive the export untouched,
so they are the key: an exact-bits hash of the three floats. Tom: 80,114 of
80,114 matched against 88,331 rows.

**Which root convention** was settled by measurement, not by reading: a headless
probe (`scratch/walk_probe.mjs`) skins the bound centres at four points of the
cycle and reports how far the figure's own axis swings off the trained pose and
how far its centroid drifts, in body lengths.

| | axis swing | drift |
|---|---|---|
| no root, rest hips | 80.5° | 5.4% |
| root, rest hips | 10.5° | 86.2% |
| **root, clip hips** | **10.5°** | **2.4%** |
| no root, clip hips | 80.5° | 80.1% |

The 10.5° and the 2.4% are the walk's own lean and sway. The first row is the
figure face down; the second is upright but a body-length away. `?walkroot=0`
and `?walkhips=0` drop them for a clip authored the other way round.

**Cost**: 6.1 ms of CPU a frame for 80,114 splats, plus a 5.7 MB
`writeBuffer`. The view re-sorts every render anyway, so the depth order comes
out right for nothing. A Walk toggle sits in the top-right controls; anything
that READS the model (Compress, an export, the publish thumbnail) puts the
trained pose back first, so nothing ships mid-stride.

## 2026-09-18c (nothing interrupts an avatar run — and the pictures stay up)

The user, on the checkpoints the stages still had: "Don't ask does this look
right, it always did and there's no way to make it different, so the whole
avatar process after start training screen should have no 'look right'
interruption." Then, on what replaced them: "can you show the images along the
processing also keep the last if the new step has no".

He is right that they were not decisions. The joints card and the body-fit card
drew an overlay, said a number and offered "Stop here / Looks right" — and
"Stop here" led nowhere except back to the settings. The cut-outs gate asked
"is this the person?" one screen after the person had been ticked on the start
card.

So the question is gone and the picture stays:

- A stage with something to show exports `preview(ctx, manifest, hooks)` and
  hands a finished node to `hooks.shots(node, caption)` — built off-screen, so
  the card never blinks empty. `review()` and its buttons are gone from
  landmarks.js and bodyfit.js.
- The runner keeps ONE card under the dock. It is born with the first picture
  and lives to the end of the run. A stage with no picture of its own (isolate,
  polish, bind, publish) leaves the last one up, so the joints stay through the
  isolating, the body model replaces them, and the finished card carries the
  body model above Download package / Use as my avatar.
- The cut-outs are shown, not asked: `cutoutsView()` paints the strip and the
  run goes straight into the solve behind it. The sheet clears itself after 6 s
  (`?cutouts=ms`, 0 = straight on).
- The captions carry what the buttons' text used to say ("The joints on your
  frames — rig scale 1.89, 33 frames show the face"), and the dock's line keeps
  each stage's note; the landmarks note gained the rig scale.

The one thing that still waits for a click is publish, and it must: the
sign-in popup can only open inside a real click.

**And the end of a run shows the avatar, not the room it came out of.** Three
stages hand back a NEW model — Isolate cuts the person out, the face pass and
the face polish sharpen him — and the app's viewer kept pointing at the model
it had before, so a finished avatar run was still rendering the full scene
(the user: "show the actual avatar splat not the full scene splat at the
end"). The runner now reports a swap (`ctx.onSession(session, stage, result)`)
and `adoptSession()` in app.js takes it: the viewer re-attaches, the splat
count on the chip follows, and the cached PLY/SOG exports are dropped, so an
export or a share of this run is the isolated person.

Framing came with it. `cut.js` returns the survivors' own extent (mean centre,
90th-percentile radius — a few strays must not pull the camera back out to
where the room was), the intro flight stops (it was orbiting at arm's length
inside a room that no longer exists) and the figure is framed at eye level,
3.2x its radius back. The publish card drops the pictures when it opens, so
the last thing on screen is the avatar with a download-or-use row above it:
Tom, 88,522 of 170,608 splats, on black.

`tests/e2e/avatar_mode.mjs` no longer waits for `#av-yes` or clicks the two
"Looks right" buttons; it screenshots each new picture instead (`_shot1.png`,
`_shot2.png`, …) and polls every 5 s.

## 2026-09-18b (the avatar UI moves to the top, and the decision to the start card)

Three things the user asked for after the first live avatar run: the last
stages' card was "squeezed and hard to read", when it finished it sat "right
in front of the face", and the avatar choice should come at Start training,
not when the video is read — "we need to mask before training not after video
frame read".

**The card was doing two jobs.** `app/avatar/runner.js` painted one 340 px
`.upcard`, centred in the VIEWPORT, holding a nine-item stage grid AND every
stage's review: three photographs at 200 px in a sideways scroller, a
paragraph and two buttons, all in 340 px. So it was both unreadable and
parked over the middle of the model.

Now the two jobs are split:

- **Progress → the dock**, the bar above the stage where the camera solve's
  beats live (`ctx.mountDock`, `.dock-av`/`.av-bar`): the nine stages as one
  short word each (`STAGE_BEAT` in manifest.js), the active one in the title
  style, the stage's message under it, one meter for the whole run. Nothing
  covers the model while a stage works.
- **A card only for a decision** (joints, body fit, publish), absolute in the
  stage at `top: 58px` — under the done-state Train/Share row, above the
  face — `width: fit-content` up to 880 px, and gone again as soon as the
  stage is answered (publish's card stays: it holds the result and its link).
  The review frames grew 200 → 240 px and now sit side by side.

**The decision moved to the start-training card.** A checkbox (`#set-avatar`,
`.av-choice`) above the Start row on the detail card, own captures only (the
matte reads the frames themselves). `startPrep` does the work in this order:
drop the mattes if the box is clear, thin the picks if `?avframes` says so,
then — with the box ticked and no manifest yet — `avatarPrep()` runs the matte
as the run's FIRST BEAT (`MATTE_BEAT`, so the top bar says "Cutting the person
out" while it works), shows the cut-outs sheet (`.av-sheet`: a sheet over the
stage, not the whole window, so the dock stays visible), and only then is the
session created with `trainingOptions`. The masks ride on the frame entries
into `session.load`, as before. A "no" at the checkpoint continues as a plain
scene, and the mattes are written back into the stored capture so reopening it
skips the stage.

Why it matters beyond taste: the matte is ~30 s on Tom's 65 frames and minutes
on a 4K orbit, and it used to be spent before anyone had said they wanted to
train that clip. The Avatar settings group now follows the box, so the toggles
are there to set BEFORE the run instead of after the choice was locked in.

**Checked** (`tests/e2e/avatar_mode.mjs`, updated for the new order: the box
on the start card, the cut-outs after Start training, the stages watched on
`#avbar`):

| | |
|---|---|
| avatar run, Tom 65 frames, 1500 iters | matte 29 s → cut-outs → solve 65/65 → all nine stages → package saved |
| plain run of the same clip (`--noavatar`) | 65 cameras, **0.1 % median / 0.3 % max** against COLMAP — the solver path is untouched |
| unit | 8/8 (sift skipped: optional deps) |

A synthetic layout probe (`scratch/cardprobe.mjs`) confirms the card no longer
overlaps the controls row (card 320..960 × 181..500, controls 1044..1265 ×
135..167) and that the phone width (390 px) wraps the beats and stacks the
buttons; the 47 px of body overflow at that width is the header's, and
pre-dates this work.

## 2026-09-18 (the avatar branch is main, and live)

`feature/avatar-mode` merged into `main` as 385f9a1 (no-ff; the one conflict
was this file, resolved to the branch's copy, a superset). Main's two extra
commits were both cherry-picks already on the branch (804a6f2 share sign-in,
b20450f refine-patch dummies), so the merged tree equals the branch tip
(`git diff` empty). The local branch is deleted; it never existed on origin.
The `../splat-js-main` worktree (the port-8735 comparison server) is gone.

Unit 8/8 (sift skipped: optional deps). The quality gates ran on this tree
yesterday (09-17m): truck-ate, truckfull-ate 251/251, tom-ate 65/65, camping.

**Deploy (local, untracked scripts):** `deploy_live.mjs` and `deploy_nightly.mjs`
never uploaded `app/avatar/` or `app/models/` — the direct push lists its
directories by name — and the avatar modules import `src` one and two levels
deeper than `js/` (`'../../src/'`, `'../../../src/'`), so the root rewrite
missed them: the avatar checkbox would have been on live with a 404 behind
it. Both scripts now rewrite `avatar/` and `avatar/stages/` and push
`avatar/` (js no-cache, the rig glb long-cached) and `models/` (26 MB,
long-cached). Live verified by fetch: stamp `385f9a1 · 2026-09-18 08:56Z` on
both the extensionless twin and `index.html`; `avatar/index.js` served as
application/javascript with `'../src/sfm/sfm.js'`; `stages/cut.js` with
`'../../src/index.js'`; the four models and the rig at their full sizes.
The overlay is committed in client_git (0760649e4, merged over #103 as
bf494222d) — identical to the dist by `diff -r`.

**What a visitor gets now:** the "This is a person" checkbox on the video
review card; with it, the avatar path with every specific off by default
(a plain scene solve and train, then matte, isolate with the hard top and
the generous verdict, body fit, bind, publish). The README does not mention
the avatar path yet — it is a public claim only once it is written down
(see readme-deploy-lockstep), so that is the next lockstep item, not this one.

## 2026-09-17n (the Isolate cut: a hard top, a generous verdict)

The user on the last avatar export: hands, feet and the face chipped
although nothing but the person is nearby; on Filip, ceiling splats a metre
above the head. The mechanism (`gs/hull.js`): a visual hull carved in a
MAD box — a voxel dies when > 15 % of the views that see it land on a
known-empty matte pixel, out-of-frame is NO evidence and leaves a voxel
alive; a splat goes when its centre is outside or >= 4 of 6 probes at 2 sigma
are. Two consequences: thin parts the matte loses in a few frames carve away
(and flat discs on nose and chin fail the 2-sigma probes with their centres
inside); and from an eye-level portrait orbit the space above the head is out
of frame in most views — an uncarved column up to the box's top.

Now: `?hulltop=F` (default 0.15 x body height above the highest head
landmark; up is whichever side of the floor the head is on — the first
version assumed +Y and killed the whole body, camera-frame Y points down),
`?hulldilate=px` (matte max-filtered before carving), `?hullsigma=S`,
`?hullout=N`. Measured at 3k on the avatar toggles off:

| | hull solid | above the top | kept | binder "far" |
|---|---|---|---|---|
| Tom, 2 sigma / 4 of 6, no dilation | 3.1 % | 708 voxels | 88,652 of 188,096 | 0 |
| Tom, **6 px / 1 sigma / 5 of 6** | 4.2 % | 708 | **93,049** | 0 |
| Filip, top OFF | 7.2 % | — | 22,465 | **177** |
| Filip, top ON | **1.0 %** | **27,298 voxels** | 22,258 | **0** |

Filip's hull was six times the body — the column — and the 177 splats the
binder could not reach were the ceiling; with the top they are gone. The
generous verdict and the top are the defaults; the switches revert. The
per-splat vote over views (evidence, not a voxel carve) remains the real
next step for hair and hands.

## 2026-09-17m (the README's Truck rows on this tree)

Merge check for the solver work. `tests/bench/bench_run.html?set=truck` (the
release-default trainer, precise solve tier, eval8):

| row | README (09-09) | this tree |
|---|---|---|
| 40k cycles, held-out PSNR | 26.14 dB, 1.4 M splats, 10 min train | **26.25 dB**, 1.4 M, 6.6 min train, 251/251, rms 0.645, solve 10.1 min |
| 30-min run (127k) | 26.55 dB, 1.05 M | **26.56 dB**, 26.5 min train, 251/251 (2 M allocated, 67 % dead at the end) |

Within the ±0.1 dB noise band, on the good side; the solve time is the
precise tier's 10.8 min of 09-09 (the RANSAC guard makes big pairs run their
600 iterations instead of one, and it did not cost the Truck). New gates:
`tom-ate` (a video orbit against COLMAP, the app's video gates) and
`truckfull-ate` (the README's 250/250 pose row):

| gate | registered | rms | ATE % of path |
|---|---|---|---|
| tom-ate (65 video frames, video gates, vs COLMAP) | 65/65 | 0.59 px | **0.03 %** (limit 0.5) |
| truckfull-ate (251 photos, vs COLMAP) | 251/251 | 0.66 px | **0.00 %** (limit 0.05) — the README row |
| truck-ate (42) | 42/42 | 0.56 px | 0.02 % |

## 2026-09-17l (SH degree 0 did not compile on the branch — and does not run on main either)

The user: SH 0 gives a gray cloud that trains "extremely fast". The chain
shader failed to compile at degree 0 — `unresolved call target
'camPosWorld'`: the 09-15 orientation regularizer's branch is compiled at
every degree but `camPosWorld()` lived in the SH-only function block. Every
step then ran on an invalid pipeline: no gradients, the seed never moved.
Moved into the shared functions. Tom 3k, plain route: SH 0 now trains
(27.0 dB) against SH 3 (28.0 dB).

The two `Invalid CommandBuffer` errors that remained per run at degree 0 —
on main too — were `_refinePatch`: the kernel's three SH bindings are
read_write and ONE 16-byte dummy was bound to all three, an aliased-writable-
bindings validation error at dispatch. Every refine's patch submit was
rejected and the relocations and growth it carried silently dropped (the
refine-apply path already had three distinct dummies). Named by wrapping
every command encoder with a JS stack and every submit with an error scope
(`scratch/probe_sh0_stack.mjs`). Three dummies now: Tom 3k at degree 0,
0 rejected submits, 27.5 dB (was 27.0 with the refines lost). The Draft macro
on phones is `sh: 0`; this one is cherry-picked to main.

## 2026-09-17k (app: the avatar manifest was sticky; settings polish)

- `S.avatar` was only ever cleared inside the video path, so a wall preset or
  a photo drop opened AFTER an avatar run inherited the manifest and ran the
  avatar pipeline (crops, stages) — and showed the avatar settings. The
  manifest now travels on the set (`set.avatar`) and `open()` takes it from
  there; no `await` in `open()` (a yield there let the start card win over
  the detail card — caught by the harness).
- Settings: the Avatar group (title + Horizontal SH + six toggles) sits at
  the end of the panel and is hidden unless the loaded set is an avatar run;
  no splat-ceiling toggle (an avatar never limits splats); the review card's
  SH row is gone. Training resolution: 1600 / 1920 / Full (the pictures'
  own size, labelled), rows above the set's size hidden.
- **Avatar defaults are now ALL OFF** (the user, after running High + Auto with
  every row off: "pretty happy with all off, make this the default"): crops
  Off (three-way: Off / On room pose / On re-posed to the face), precise
  tier, large decode, 100k seed, opacity pressure and needle term all off. An
  avatar run is a scene run until a row is switched on; the rows are the
  ladder. The trainer's ceiling stays the allocation maximum regardless.
  (`trainingOptions` without an `av` argument still returns the full 09-15
  recipe — the app always passes `settings.av`.)
- Harness: `--dumpframes=dir` (picked frames, for COLMAP references),
  `--browser=firefox` (needs `npx playwright install firefox`).

## 2026-09-17j (the gate against truth on all three orbits)

COLMAP references for Tom (65), Lisa (208) and Filip (59), all 100 %
registered. The video gate (absolute pair gates 100 / neighbours 15 in the
first pass) on the current tree (final trials, clean passes):

| orbit | gate ON vs truth | gate OFF vs truth |
|---|---|---|
| Tom, Chrome hardware decode | 0.1 % / max 0.3 % | **3.9 % / max 10.5 %** — 65/65 registered, rms 0.65, WRONG (no retry: the count passed) |
| Tom, Chrome software decode | 0.2 % / 0.3 % | first pass 39/65 → the retry (which IS the gate) → 0.2 % / 0.3 % |
| Lisa | 0.3 % / **max 22.9 %** (119-121) | 0.3 % / max 0.9 % (206/208) |
| Filip | 0.2 % / 0.4 % (59/59) | 0.1 % / 0.6 % (58/59) |

So the gate is what makes Tom's solve correct under hardware decode — a
65/65 registration at 0.65 px rms that is 4 % off truth is the failure the
count-and-rms rulers cannot see — and it is what mis-bridges three of Lisa's
cameras. Filip is right either way. Decision: the gate stays (two orbits
right and one with three bad cameras beats one orbit silently wrong), and
Lisa's three cameras are the next piece of work: a geometric admission check
on gate-admitted pairs, or per-camera verification after the final pass
(a mis-bridged camera has few observations and a residual its neighbours
do not). Not a threshold.

Rulers, again: registered count and BA rms passed Tom-gate-off with flying
colours; only truth caught it.

## 2026-09-17i (COLMAP truth for Lisa: the video gate mis-bridges three cameras)

COLMAP on Lisa's 208 dumped frames (4K, CPU: features 185 s, exhaustive
matching 1,263 s, mapper 194 s): 208/208, one model. Every Lisa solve
against it:

| solve | median | max | rotation max | cams > 2 % |
|---|---|---|---|---|
| main's solver (live) | 0.3 % | 0.6 % | 0.4° | — |
| this tree, gate OFF (206/208) | 0.3 % | **0.9 %** | 0.3° | — |
| this tree, default (gate on, 208/208) | 0.3 % | **22.9 %** | 3.1° | **119, 120, 121** |
| this tree, single final pass | 47 % | 98 % | 179° | nearly all |

So the bisect's reading was right against truth: the video gate registers
two more cameras and places three wrongly (13-23 % of the path), main and
gate-off are clean, and the final trials are what stands between Lisa and a
wrong focal. The "jump at 75-76" in the gate-off solve was NOT an error
(0.9 % max against COLMAP) — a fast real move; the continuity heuristic
flagged it, the truth cleared it.

Decision now depends on Tom without the gate on the CURRENT tree (final
trials + clean passes came after the gate was measured): if Tom is clean
under both decoders without it, the gate goes; if not, it needs a
geometric admission check. Running.

## 2026-09-17h (COLMAP truth for Tom: the day's rulers were honest)

COLMAP 4.1.1 (CPU, `tools/colmap`, exhaustive, 8000 features, one shared
SIMPLE_RADIAL camera) on the 65 picked frames: 65/65 in one model, 99 s.
Every solve of the day aligned against it (`cmp_cams.mjs`, cameras matched
by file name; centre residual as % of the path extent):

| solve | median | p90 | max | rotation median / max |
|---|---|---|---|---|
| live export | 0.1 % | 0.2 % | 0.4 % | 0.1° / 0.2° |
| Firefox "extremely good" (live's path + fixes) | 0.1 % | 0.2 % | 0.3 % | 0.2° / 0.3° |
| **Chrome, current default** (trials, clean passes, gate) | **0.1 %** | 0.3 % | **0.3 %** | 0.2° / 0.3° |
| Chrome, gate + branch passes | 0.2 % | 0.3 % | 0.4 % | 0.2° / 0.3° |
| Firefox, final trials before the leak fix ("5 cm") | 0.2 % | 0.7 % | **1.3 %** | 0.2° / 0.6° |
| Chrome, main's solver | 0.3 % | 0.6 % | 0.9 % | 0.2° / 0.6° |
| Chrome, subsample without a trial ("5 cm") | 0.5 % | 1.4 % | 1.9 % | 0.3° / 0.6° |
| Firefox, branch passes ("30 cm") | 2.5 % | 8.7 % | 11.6 % | 1.2° / 2.6° |
| Chrome, software decode (pre-gate) | 13.7 % | 23.3 % | 32.7 % | 9.0° / 27.9° |
| Firefox, gate off ("destroyed") = the morning export | 40.4 % | 65.0 % | 94.3 % | 39.3° / 104.8° |

So: live is within 0.1 % of COLMAP, which is why "vs live" tracked the truth
all day; the user's eye maps onto the MAX residual (0.3 % perfect, 1.3 %
"5 cm", 11 % "30 cm"), not the median; and the current default on Chrome
is at the top of the table. The morning's broken export and the gate-off run
are the same solve to the digit — deterministic and wrong.

(The avatar-route `camsAll` dumps carry no names and did not align in this
run — not a solve verdict, a bookkeeping gap.)

## 2026-09-17g (two more orbits, a bisect on Lisa, and every avatar specific as a toggle)

**Overfit check** (plain route, High, main's solver on :8735 vs this tree,
aligned with `cmp_cams.mjs`; no ground truth — "vs main" is agreement, the
step jumps a heuristic):

| clip | main | this tree | agreement |
|---|---|---|---|
| Filip, 59 frames | 43/59, jumps at 16-18 (the 09-14 gap) | **59/59**, 0.54 px, no jumps | 0.1 % on the 43 both have |
| Lisa 4K, 208 frames | 208/208 | 208/208, 0.74 px | 0.2 % median, **cams 119-121 at 13-23 %**, jumps 120-122 |

Lisa bisect: gate OFF → 206/208, 0.1 % of main (max 0.6 %), one jump at
75-76 (a frame with one usable pair); gate on with a SINGLE final pass →
181/208, wrong focal (432 vs 369 px), destroyed. So the final trials are
what saves Lisa (not only Tom), and the video gate buys two cameras for
three mis-bridged ones — the "low-inlier neighbour pair poisons the graph"
failure of the 09-08 note, now seen on a video. Decision pending COLMAP
truth (frames unpacked for Tom and dumped for Lisa; the 4.1.1 CPU binary the
bench used is gone with `Browser_3DGS/tools`). The fix, if confirmed, is a
geometric admission check on gate-admitted pairs, not a threshold.

**Avatar specifics as toggles** (the user: "when I toggle all specifics off,
it should solve like non-avatar"). `settings.av` — crops, tier, budget, seed,
opa, needle, cap — seven rows in the panel under Horizontal SH, all on by
default; `trainingOptions(…, { av })` and the app's crops/budget hooks honour
them. Verified: an avatar run with every toggle off produces the plain
route's solve to 0.0 % (same 1280 px decode, same 223 pairs, same 170,608
seed), crops skipped. The user's report that started it: the avatar in the
arrival.space app is the best it has been, while the reconstruction in
splat-js with the avatar specifics is worse than without — some help, some
hurt; the toggles are how to find which.

## 2026-09-17f (a second pass was never a clean pass: two leaks between solver passes)

Final trials kept the right candidate in Firefox too (`final trial 0.69x:
65/65, rms 0.63px against 0.81px — keeping it`) and the user still saw 5 cm
ghosts; aligned, the tail (frames 55-65) sat 1 % off live while his single
pass at the same focal had been within 0.3 % everywhere. Same focal, same
browser, a worse solve when it ran SECOND. Two things survive from one
`runGeometry` call to the next:

1. `refineObsLK` writes its sub-pixel-moved coordinates into `feats[].x/y`
   (sfm.js:203); the next pass's observations start pulled toward the
   previous pass's geometry.
2. `extendTracks` pushes observations onto the shared `tracks[].obs` under
   the previous pass's poses; the reset only cleared `o.ok`, so the next pass
   inherited them as evidence.

Both fixed in the reset at the top of `runGeometry`: keypoints restored from a
first-pass snapshot (`f.x0/y0`), tracks truncated to their detected length
(`tr.n0`). Every pass — candidate, trial, retry — now starts from the
detected features. With that, Chrome default, both routes:

| | trial kept | rms | vs live (median / max) |
|---|---|---|---|
| leaks (17e) | 0.69x | 0.64 px | 0.3 % / 0.5 %, tail 1 % |
| keypoints restored only | 0.69x | 0.65 px | 0.3 % / 0.5 %, tail 1 % |
| **both restored** | 0.69x | 0.82 px | **0.2 % / 0.4 %, no camera above 0.4 %** |

The rms went UP and the geometry got better: the lower numbers were partly
observations already fitted by a previous pass. The user's Firefox default run
on this build: "perfect". Gates: synthetic 12/12 (focal 0.27 %, 0.47 px),
Truck 42/42, ATE 0.02 %.

Also tried, before the leaks were closed: init-pair trials on the final pass
for sets up to 120 (`?inittrialsupto=120`; the mechanism exists for <= 60) —
WORSE, 0.6 % median, the first half of the orbit 1 % off: the cheap median
chose the rank-1 pair over rank-0. Untested on clean passes; not adopted.

Overfit check owed: the video gate's benefit is measured on Tom only.
## 2026-09-17e (final trials: the grid's ranking flips on pixels, the BA rms does not)

Why live's path gave 0.2 % on Firefox and 0.5 % on Chrome, and the every-image
path the reverse: the focal grid ranks near-tie candidates by the cheap
pass's pixel median, and that ranking flips on the decoder's pixels — Chrome
puts 0.96x first, Firefox 0.69x; both BA to f 445 px. But the final
registration seeded from each lands in a DIFFERENT optimum: 0.88 px rms and
0.5 % off live from 0.96x, 0.58-0.64 px and 0.2-0.3 % from 0.69x. The old
bracket re-check rescued Chrome by accident: it re-solved the grid winner
against the bracket's pick and kept the lower rms.

That criterion is the right one, so it is now the mechanism: **final
trials** (`sfm.js`, replacing `focalVerify`) — the final pass runs from the
top candidates (the bracket winner, the grid winner when the bracket moved,
the grid's runner-up), keeps the most cameras, then the lowest full-BA rms.
Default 2 for sets up to 120 images (`?finaltrials=N`; 1 = single pass).
Subsample 48, no gap rule, video gate on.

| default, Chrome | grid | trial | kept | vs live |
|---|---|---|---|---|
| plain route | 0.96x, 0.88 px | 0.69x, 0.64 px | 0.69x | 0.3 % / 0.1°, max 0.5 % |
| avatar route | 0.96x, 0.88 px | 0.69x, 0.64 px | 0.69x | 0.3 % / 0.1° (nose 2.01 px) |

Cost: one extra final pass with BA (~16 s on 65 frames). Gates: synthetic
12/12, BA 0.46 px; Truck 42/42, ATE 0.02 %.

The overlay draws only FINAL passes now (`pass`/`register` events carry
`final`): the focal candidates and init trials register a subsample in
throwaway frames, and clearing the ring on those made it hop and the cloud
vanish six times before the real solve. Ring at the end: 65 for 65.

A note for the record: a python slice edit with `s.index` on two anchors that
matched in the wrong order duplicated 170 lines of `sfm.js` and served a
broken solver for two minutes. Assert `start < end` and re-count landmarks
(`SfM done` lines: 3, as on main) before trusting a structural edit.

## 2026-09-17d (three Firefox exports, aligned: the gate is essential, the branch's extra passes still cost 2.5 %)

The user ran three URLs in his Firefox and exported each session
(`tmp/tom_local_1*`); aligned against his live export with `cmp_cams.mjs`:

| URL | solver path | vs live (centre / rotation, median; max) | psnr@iter |
|---|---|---|---|
| `?sfmsubabove=48&focalverify=0&pairrelax=0` | live's path + today's fixes | **0.2 % / 0.1°; 0.3 %** | 32.2 @ 11k ("EXTREMELY good") |
| default | branch passes (every-image search, bracket check, gap retry) + gate | 2.5 % / 1.1°; **11.5 % at frame 55** | 26.7 @ 6.7k ("30 cm ghosts") |
| `?pairabs=0` | video gate off | 40.5 % / 39.1°; 94 % | 21.2 @ 5.2k ("destroyed") |

The good one also matches the Chrome default solve to 0.1 %. So: the video
gate is essential (without it, the same wrong solve as this morning's export,
bit-for-bit the same 40.5 %); and the branch's three solver additions, which
are neutral on Chrome (0.3 % vs main), still bend the Firefox solve by 2.5 %
with the tail 11 % off. They were written for the avatar route on the
pre-fix graph (868f9b0: a 33-of-65 subsample picked 0.44x and morphed) — a
condition that no longer holds. Decision pending the avatar check: make
live's path the default again, keep the three as opt-in switches.

## 2026-09-17c (the sparse-cloud frustums were several solves at once)

The user's "wrong poses" were judged in the sparse-cloud stage — and his
bisect of the branch's solver switches came out "all three off = as good as
live, subsample alone = bad", which made no solver sense. It made overlay
sense: every solver PASS (each focal candidate, the final run, the bracket
re-check, the gap retry) registers the images again in its own world frame
and fires `register` events; `app.js` pushed every one onto `S.regCams` and
cleared it only at run start. The stage drew several solves' frustums
superimposed — one ring plus a stray arc. The branch adds passes, so it
showed more ghosts than live; switching passes off removed ghosts, not
errors. The finished reconstruction never had those poses (training-time
frustums were right all along).

Fix: `sfm.js runGeometry` emits `stage: 'pass'` at the start of every
registration pass; the app clears the ring (and the cloud) on it and a
re-registered image REPLACES its frustum. Ring at the end of a 65-camera
solve: 63, then 65 once the init pair emits its two events too — against hundreds before.

Lesson (again): judge a solve by the exported cameras (`cmp_cams.mjs`
against a reference) or by the training-time view, never by the sparse-cloud
overlay — and a bisect whose answer contradicts the code is telling you the
ruler is broken.

## 2026-09-17b (the same clip solves four ways: the decoder chooses — until the neighbour gate is on)

The user, after the RANSAC fix: still wrong, and reproducible on a plain scene
run (High, no avatar box) — live solves it, local does not. He exported both
sessions (`tmp/tom_live_session`, `tmp/tom_local_session`): same 65 frames,
same focal (445 px), and after the best similarity fit the local cameras sit a
median **34 %** of the path extent from live's, rotations **39°** (frames 13-19
at 65-94 %). A different reconstruction, not noise.

Direct A/B on this machine (`tests/e2e/avatar_mode.mjs --noavatar --solveonly
--port`, a worktree of main served on 8735, cameras aligned with
`scratchpad/cmp_cams.mjs`):

| solve | vs live (centre / rotation, median) |
|---|---|
| branch, headless | 0.5 % / 0.3° |
| main, headless (62/65 registered) | 0.4 % / 0.2° |
| branch, headed, harness flags | 0.5 % / 0.3° |
| branch, headed, plain flags | 0.5 % / 0.3° |
| branch, headed, **software video decode** | **13.8 % / 9.1°** (repeat: identical to itself) |
| the user's local export | 33.9 % / 39.1° |

So: not branch-vs-main (they agree to 0.3 %), not the window, not the GPU
flags. The solve is a pure function of the pixels — and the pixels depend on
the video decoder. Hardware and software decode give the same feature count
(2,948) and the same usable-pair count (175), yet different features, a
different init pair (1+54 vs 17+18), a different self-consistent solve at the
same focal. The user's tab produced a third pixel set (2,950 features) and a
fourth solve. Which one you got was decided below anything a count can see.

Why the clip admits several solves: the pair gate is ratio-only by default
(`pairMinInliers ?? Infinity`, b806846 09-08), so neighbour pairs with 215 of
600 E-inliers are thrown away — 175 usable pairs of 1,574, a thin chain with
a seam at 44-46 / 51 and a scale-ambiguous tail.

**The fix: a video is a chain.** For video-sourced runs the app now passes the
retry's absolute gates into the FIRST pass (`pairMinInliers 100`,
`pairMinInliersAdj 15`; `app.js VIDEO_GATES`, `set.video` on fresh and
restored video sets; `?pairabs=0` off, `?pairabs=A,N` other values):

| first pass with gates 100/15 | usable pairs | vs live | vs each other |
|---|---|---|---|
| hardware decode | 223 | 0.2 % / 0.2° | — |
| software decode | 223 | 0.2 % / 0.1° | 0.1 % / 0.1° |

Both decoders land on live's solve at live's exact focal (445.3 px).
Verified with the gate on by DEFAULT (no URL switch): plain route hardware
0.2 % / 0.2°, software 0.2 % / 0.1°, avatar route 0.2 % / 0.2° — all 223 pairs,
65/65, rms 0.58-0.60 px. (The avatar's head windows read nose residual 2.13 px
on this solve against 0.98 px on the 0.55x solve the ungated bracket found
earlier today — a different metric on a different solve; live's solve is the
one that trained to 36.9 dB.) Photo
sets keep the ratio gate: those gates cost the Truck 3 dB on 09-08 (250/251
registered at rms 0.62, 22.67 vs 25.72 dB) — a low-inlier neighbour pair on a
photo set can be geometrically wrong; on a video it is overlap by construction.

Also measured today: the pair stage is deterministic (seeded; two runs
bit-identical under each decoder), the focal-search bracket (`focal check`)
and the gap retry behave the same on branch and main for this clip, and the
harness needed `?sessionlog=1` to see a plain run's solver at all (a plain
scene run logs nothing — two 15-minute waits on a console line that never
comes).

## 2026-09-17 (RANSAC ran one iteration on the strongest pairs: a solver defect since the library split)

The user: "camera alignment is broken on Tom, many poses are wrong" — a stray arc
of frustums off the orbit, the trained room in shards. His panel: training
resolution 1280, Cycles 40k, everything else default. Headless on the same clip
(`tests/e2e/avatar_mode.mjs`, default settings) solved 65/65 at 0.55x, twice,
bit-identical — but only through `runSfM`'s retry of a 48/65 first pass with
an 11-frame gap. His tab's log had 2,950 features/image against 2,948 headless
(the headed decode is not pixel-identical, and 1280 vs Auto shifts it again),
a differently fragmented graph, the focal grid picking 1.20x on a wrong init,
and cameras registered on 9-17 inliers (BA aspect 1.34). Nothing on the solve
path had changed in the tree since the last good run.

Probed the pair stage (`?pairdebug=1`: every neighbour pair's raw count,
E-inliers, RANSAC bestCount, estimator failures, iterations run):

| pair | raw | E-inl | best sample | iters |
|---|---|---|---|---|
| 7-8 | 1,335 | 0 | 3 | 1 |
| 59-60 | 1,070 | 0 | 1 | 1 |
| 16-17 | 813 | 0 | 4 | 1 |
| 45-46 | 782 | 0 | 7 | 2 |
| 4-5 | 764 | 0 | 4 | 1 |

21 of 127 neighbour pairs ended after one or two RANSAC iterations. The
adaptive termination in `ransacE` (`src/sfm/geometry.js`): `p = 1 - w^8`; on a
big pair whose first sample is contaminated (most are — eight points from a
50 %-inlier set are all inliers 0.4 % of the time) `count/n` is under 1 %,
`w^8` is below double epsilon, `p` rounds to exactly 1, `log(p)` is 0, `need`
is -Infinity and `iters` collapses to `it + 1`. The loop ends. It bit exactly
the strongest adjacent pairs, and `?pairiters=5000` could not help because the
cap was pinned. The line predates the library split (e745f4d, 08-19); the
deployed `arrival.space/splat-js/src/sfm/geometry.js` has it too — live solves
the same clip correctly through the plain-scene route (High tier, 48-image
focal subsample), which is the same knife-edge landing on the other side.

Fix: `need = p >= 1 ? maxIters : …`. Tom, headless, default settings:

| | before | after |
|---|---|---|
| neighbour pairs with 0 E-inliers | 21 | **0** |
| 7-8 inliers | 0 | 1,299 of 1,335 |
| first pass | 48/65, retry to 65/65 | **65/65, no retry** |
| BA final | 0.63 px, 16,708 pts | 0.63 px, 20,524 pts |
| nose residual (head windows) | 1.77 px | **0.98 px** |
| camera path | same shape (radius min/max 0.28 both), scale differs (arbitrary units) |

Quality gates with the fix (`tests/quality/run.mjs synthetic-solve truck-ate`):
synthetic 12/12, focal error 0.29 %, BA 0.475 px; Truck 42/42, BA 0.56 px,
ATE 0.02 % of the path (gate 0.1) — the rich graph does not move.

Still open, noted not changed: the pair gate is ratio-only by default
(`pairMinInliers ?? Infinity` since b806846; the comment says "default 100")
so neighbour pairs with 215 of 600 inliers are thrown away; and the retry is
accepted on camera COUNT, never on geometry. The pair stage is deterministic
(seeded; two runs identical) — the tab-vs-headless difference is the input.

Tooling that stays: `?pairdebug=1`, `?pairiters=N` (avatar sfm opts),
`ransacE(..., stats)`, `--solveonly` in the e2e, console lines kept whole
(they were cut at 600 chars, which manufactured a "non-monotonic" paradox —
pairs "usable at 600 iterations, 0 at 5000" — that cost an hour).

## 2026-09-16b (the skin term: works as a mechanism, no visual gain at 30k)

The user's idea (09-15 night): pull face splats onto the face mesh and
flatten them along its normal, hair untouched. Built as
`app/avatar/faceskin.js` (a signed-distance field: 39x40x40 cells of 5.5 mm
over 1,681 face triangles, weight fading at the face oval and beyond
2.5 cm, 0.7 s) + a term in the chain kernel (`trainer.skinField`/`skin`,
avatar `?skin=wPos,wNorm[,thickMm]`), derivatives checked numerically.
Tom 30k on the default (pressure stop at 15k):

| weight | package | face visible | needles | edge-on (frontal cam) | thinnest | longest |
|---|---|---|---|---|---|---|
| off | 175,035 | 2,700 | 3.0 % | 20.2 % | 0.12 mm | 4.2 mm |
| 1 / 1 | 178,159 | 3,068 | 2.4 % | 20.9 % | 0.05 mm | 4.2 mm |
| 10 / 10 | 175,062 | 4,058 | 1.7 % | 23.7 % | 0.04 mm | 4.0 mm |
| 50 / 50 | 169,686 | 5,035 | 1.6 % | 25.6 % | 0.04 mm | 4.0 mm |

- The term bites with weight: visible face nearly doubles at 50, needles
  halve, splats thin out (the normal-extent penalty). But the views do not
  improve (`scratch/skin2_views.jpg`, `_ears.jpg`): frontal and profile at
  the default's level, from 30° above dark rings around the eyes at 10 and
  50, from below blotchier at 50. The edge-on share measured against the
  frontal camera RISES, which is expected of discs lying in the cheek's
  skin (edge-on from the front by construction) — that metric cannot judge
  skin alignment; a normal-vs-skin metric would need the field offline.
- Verdict: stays off. The face-only disc model of 09-14 was smooth because
  nothing else shared its splats; pulling the default's splats onto the
  skin does not reproduce that. The idea survives as a tool for the long
  run (untested at 100k) and for a future face-only stage.

## 2026-09-16 (Lisa at 100k; the avatar's solve options never reached the solver)

Lisa, 100k + horizontal SH + needle off (the user's recipe, pressure stop
at 50k), all 208 frames at 885 px, focal 0.69x (subsampled search, 206/208):

| run | package | face rows / visible | median face opacity | needles | edge-on | longest |
|---|---|---|---|---|---|---|
| 30k default, full SH | 129,139 | 11,472 / 1,255 | 0.07 | 10.2 % | 29.4 % | 6.4 mm |
| 100k + hSH + needle off | 152,727 | 11,380 / **5,377** | 0.28 | 4.2 % | 34.1 % | 3.9 mm |
| same, no crops | 96,619 | 4,022 / 2,214 | 0.33 | 2.0 % | 42.5 % | 6.1 mm |

- The long run with the pressure stop is her sharpest model (4x the visible
  face of the 30k, `scratch/lisa_100k.jpg` row 3): eyes and skin readable,
  a few cheek blotches and a red mark at the mouth, a ghost line on the
  cheek in the right view — her poses again (no lens data, nose residual
  3.0 px). Without crops she falls apart (row 4, doubled features): on a 4K
  clip the crops are what registers the face to the training.
- **Plumbing bug found**: `createSession` in app.js set `sfm:` from the
  settings tier AFTER spreading the avatar's session options, so the
  avatar's `precise` tier and the new `?sfmall=1` (every-image focal
  search above 120 frames) never reached the solver — her "sfmall" run was
  a duplicate of the base. Fixed (the avatar's sfm merges over the tier).
- **Every-image search on Lisa** (208 images, 6 candidates + bracket on all
  of them): winner 0.78x against 0.69x subsampled, both 206/208 registered,
  both BA rms 0.72 px, nose residual 3.41 vs 2.98 px; face visible 5,841
  vs 5,377, edge-on 33 vs 34 %. Views (`scratch/lisa_sfmall.jpg`): the
  cheek ghost line a little softer at 0.78x, 30° above a little rougher —
  not decisive either way. Her clip has no lens metadata (an mp4 export);
  without it the orbit's focal stays ambiguous between the two, unlike Tom
  where 65/65 vs 62/65 registration separated 0.55x from the rest.

## 2026-09-15p (the pressure stops at half the run: the long run keeps its face)

The user: "produce more face splats, more sharpness" on his 100k +
horizontal SH + needle-off recipe. New `trainer.opaRegUntil` (avatar
`?opuntil=F`): the opacity pressure is 0 after F x the horizon — it exists to
prune while the model grows, as a per-iteration pull it scaled with the
run length (100k kept half the 30k's visible face).

| run | package | face rows / visible | median face opacity | longest | body visible |
|---|---|---|---|---|---|
| default 30k | 192,906 | 6,858 / 1,383 | 0.15 | 5.5 mm | 32,323 |
| 100k + hSH + needle off, pressure all the way | 201,181 | 8,328 / 926 | 0.13 | 7.8 mm | 23,489 |
| same, pressure stops at 50k | 216,765 | 7,293 / **3,370** | 0.28 | 3.6 mm | 112,867 |
| same, pressure stops at 30k | 141,828 | 4,369 / 2,455 | 0.34 | 4.6 mm | 91,055 |

- Stop at 50k: 3.6x the visible face of the same run with the pressure on
  throughout, splats half the size, skin texture and stubble readable in
  the profile, from above calm (horizontal SH), from below detailed
  (`scratch/opuntil_views.jpg`, `_ears.jpg`). A small bright artefact at
  the mouth corner in the three-quarter view. The best long run of the
  day.
- Stop at 30k: fewer splats overall (141k, the growth phase interplays),
  face 2,455, rougher from above and a ghost hint at the eye in the
  three-quarter. 50k is the value.
- **30k check** (default recipe, pressure stops at 15k): visible face
  1,383 -> 2,700, median face opacity 0.15 -> 0.36, longest 5.5 -> 4.2 mm,
  body visible 32k -> 112k, package 175k. Frontal and right sharper; from
  above and below at the default's level (`scratch/opuntil30k_views.jpg`).
  **The cut-off at half the run is the avatar default now** (opaRegUntil
  0.5, commit below).

## 2026-09-15o (the redo ladder on the corrected solve)

Seven Tom runs on the every-frame solve (all seven: first pass 0.78x with
48/65, retry, 0.55x with 65/65 — identical poses; decode 1583 px, crops
capped at 240). Sheets `scratch/ladder_views.jpg` (5 views) and
`scratch/ladder_ears.jpg` (profile + three-quarter).

| rung | package | face visible (10 cm) | needles | edge-on | longest |
|---|---|---|---|---|---|
| default: pressure 0.004, needle 0.03, full SH, crops, 30k | 192,906 | 1,383 | 3.0 % | 20.6 % | 5.5 mm |
| pressure 0.01 | 167,954 | 684 | 2.6 % | 20.2 % | 6.9 mm |
| needle term off | 190,385 | 1,263 | 6.3 % | 23.8 % | 5.6 mm |
| + face pass 1500 | 177,778 | 1,528 | 4.1 % | 23.1 % | 5.1 mm |
| horizontal SH | 187,784 | 1,404 | 2.6 % | 31.6 % | 5.7 mm |
| no person crops | 111,253 | 1,157 | 3.2 % | 23.5 % | 6.8 mm |
| 100k | 212,271 | 885 | 0.9 % | 27.5 % | 5.9 mm |

- With the poses right, every rung has a clean profile: the ghosting was
  the focal, not any of these knobs. The differences are now small and
  where they were before: pressure 0.01 halves the visible face; the
  needle term halves the needles; the face pass softens the eyes; horizontal
  SH keeps the skin calmer from 30°/60° above and from below (the user's
  case for it) at a higher edge-on share; no crops is smooth at eye level
  with 40 % fewer splats and a softer face; 100k is sharper frontal and
  rougher from above (the crown), visible face down to 885 (the pressure
  accumulates with the horizon, still open).
- Nothing reopens; the default stands. Horizontal SH remains the user's
  candidate and needs the export refit before it can be the default.
- **Added rung (the user's): 100k + horizontal SH + needle term off** —
  package 201,181, face visible 926, needles 0.9 %, edge-on 38 %, longest
  7.8 mm. Frontal and profile as sharp as the plain 100k; from 30°/60°
  above the skin stays calm where the plain 100k breaks into colour
  patches (`scratch/ladder_extra_views.jpg`, `_ears.jpg`); from below
  clean. The strongest long-run combination of the day; the crown stays
  soft (no view from above) and the pressure-over-horizon item stays open.

## 2026-09-15n (lens prior: logged, not trusted; thinning off; the 09-14 model identified)

- **The lens as a focal**: accepted at 0.37x (62/65) and bent
  (`scratch/prior_cmp.jpg`). **Narrowed search** on the lens x crop factors
  1.0–1.55: picked 0.46x, 62/65, ghosting again (`scratch/lensgrid_cmp.jpg`).
  The free every-frame search (0.55x, 65/65, BA 0.86 px) is the only solve
  of the day the user calls clean. Verdict: for video the container's lens
  is logged, the search keeps its range; the reader (`src/io/qtmeta.js`) and
  the frame exif stamping stay for the log and for later use.
- **Thinning off**: 208 → 100 frames broke Lisa's chain (74/100, wrong
  focal), 208 → 200 broke her landmark stage (nose residual 1e9 px, fit
  scale 45818, hull box 3000 units) — unthinned she solves 206/208 at 0.69x
  with the landmarks fine. The decode budget (1.1 GB for avatars, crops
  capped at 240) carries the resolution instead: Lisa 885 px, Tom 1583 px
  (was 1263). Her model at that (`scratch/lisa_cmp3.jpg`) is rougher than
  the 706 px run — her poses are the next suspect (no lens data, nose
  residual 3.0 px), not the recipe.
- **The model the user likes** (`ugc …/90333b40…_tom_avatar.sog`): avatar
  5669, uploaded 2026-09-14 12:48 UTC from his app run at commit d058bc5 —
  room training + cut at 20k, NO person crops, full SH, pressure 0.01, no
  needle term, face pass off, the same 0.44x solve; 63k splats after
  export. "Sharper, less contrast, not worse" → crops on/off joins the
  redo ladder (`?crops=0`).
- Redo ladder queued on the every-frame solve: default, pressure 0.01,
  needle off, face pass 1500, horizontal SH, crops off, 100k.

## 2026-09-15m (the focal is unobservable from a person orbit — the container knows it)

Three feature resolutions, three focals on Tom's clip with the every-frame
search: 960 px → 0.55x maxDim (the "stunning" model), 1280 px → 0.78x,
1600 px → 0.49x (48/65 registered). The orbit has almost no focal
observability: the room is far, the person close, the search's pixel
median cannot tell. The user: "with this whole focal shit we can literally
do all the things again, because the data was shit" — right: every rung of
the 09-15 ladder (pressure, needle, orientation, blob, pose refinement,
crops-only, face clamp) was measured on the 0.44x solve. The relative
verdicts may hold, the absolute ones do not; the key rungs are to be redone
on a correct solve.

- **The MOV knows the lens.** The static 'mdta' items in the container
  carry `camera.lens_model` ("iPhone 12 Pro Max back camera 1.54mm f/2.4",
  the 0.5x ultra-wide — the user confirms), `camera.focal_length.35mm_equivalent`
  ("14") and `camera.lens_irisfnumber` ("F2.40"). Both Tom's and Filip's
  clips carry it; Lisa's mp4 (another phone/app) carries nothing. New
  `src/io/qtmeta.js` reads them (moov at either end of the file).
- **Wired as a prior**: the app stamps `exif { f35, lens, video }` on every
  extracted frame (decodeFrames takes a caller-supplied exif), the session
  turns it into the existing `focalPrior` (tried first, accepted at ≥ 60 %
  registration), and for VIDEO the fallback search runs on a narrow grid
  of crop factors 1.0–1.55 around the prior (stabilisation and the video
  sensor crop lengthen the effective focal) instead of the whole range.
  14 mm at 1080x1920 = 0.37x maxDim nominal; the observed 0.44–0.55x is a
  1.2–1.5x crop of it, 0.78x is not.
- Also in this batch, pending their runs: crop windows undistorted with
  the body frames' convention when |k| ≥ 0.01; bracket verification (a
  bracket winner is re-solved against the grid winner, more registered
  frames wins); avatar decode budget 1.1 GB with crops capped at 240;
  frame thinning only above 200.

## 2026-09-15l (the ghosting was the focal: search on every frame)

The user, on every sheet of the day: "the view morphs into another face
pose when I turn the camera — the cameras are not well matched". Traced:
not the face pass, not solver randomness (every Tom solve ended BA at the
same 0.811 px), not the pose optimiser (moves millimetres). The focal
search ranked its candidates on a subsample — 33 of Tom's 65 frames — and
chose 0.44x maxDim; searched on all 65 frames the bracket registers 65/65
at 0.49–0.62x and the pixel median picks **0.55x**. With that solve the
profiles are clean, the ear sits where it belongs and the face no longer
morphs (`scratch/focal_cmp.jpg`, row 2). An orbit around a person has weak
focal observability (the room is far, the person close), and a subsample
hides it. Sets up to 120 images now search on every image (sfm.js).

- Features at 1600 px (the user's persisted gear, probably): the poses are
  precise where they register, but 48/65 frames registered and the front
  of the orbit was extrapolated (row 3). 1280/1600 with the every-frame
  search are running.
- Lisa still fails: on her 100 thinned frames the bracket walks to 0.39x
  (54→62 of 100 cameras registering, reproj 0.89→0.30 px) while 0.62–0.69x
  is right (206/208 registered on the full set). The bracket's rule — more
  cameras and lower pixel error — is satisfied by a wrong wide focal on a
  person orbit. Next: verify a bracket winner with a full BA solve against
  the grid winner and keep the one that registers more frames.
- The user on the 0.55x Tom (`scratch/ab_tom_g_pkg`): "the middle tom row
  looks stunning" — the reference model of the day.

## 2026-09-15k (the feet were cut; the e2e's hidden face pass; Lisa's 4K cut)

- **Feet cut off** (the user, from his localhost run: cut at the shins).
  The visual hull's box is median ± k·MAD of the subject's feature cloud —
  symmetric about a median that sits at chest height, so the bottom ended
  ~40 cm above the floor: Tom's visible splats spanned 153 cm along the up
  axis. Fix: `buildVisualHull` takes `opts.include`, and the cut stage
  passes the landmarks' joints plus a floor point under each foot joint
  (`floorY`), padded by the box margin. Tom: 189 cm span, shoes back
  (`scratch/feet_cmp.jpg`); Lisa 188 cm.
- **The e2e ran a face pass all day**: `tests/e2e/avatar_mode.mjs` passed
  `faceiters=1500` unless told otherwise, so every 09-15 ladder run (a–j)
  had a 1,500-iteration face pass the app itself does not run. The ladder's
  relative verdicts stand (same pipeline throughout); the absolute default
  had not been rendered. Now off unless `--faceiters` is given. Tom default
  with vs without the pass (`scratch/default_final.jpg`): with it the eyes
  are a touch crisper (face visible 1,873 vs 1,664, longest 4.7 vs 5.2 mm);
  the user's earlier "worse" verdict was on the old masked recipe with
  anisoReg. Worth a re-decision on the new recipe, later.
- **Lisa's 4K cut** failed with 'Array buffer allocation failed': the cut
  stage reloaded all 206 frames (2048 px) into a second session. It now
  reuses the source session's decoded frames (body cameras only) — no
  second decode, and a faster cut. Her default run: 208k person splats,
  face soft (`scratch/default_final.jpg`, row 3).

## 2026-09-15j (the default, decided — and the face-only clamp A/B on three people)

Too many variants to choose from (the user). One recipe, one A/B. The
avatar default is now: horizontal SH with the corrected gradient, opacity
pressure 0.004, needle term 0.03; everything else off (blob clamp,
orientation term, pose refinement, crops-only, face polish, seeds). The A/B:
that default against the same plus a blob clamp (ratio 3) on the face only —
the clamp pass takes a sphere (the landmarks' face points ×1.15, Tom 14 cm,
Filip 12 cm) so blobs sit on the skin and discs stay elsewhere. 30k each.

| person, run | face visible | needles | longest/shortest median (max) | edge-on to frontal cam | package |
|---|---|---|---|---|---|
| Tom, default | 1,873 | 1.7 % | 6.3 (138) | 22.9 % | 169,796 |
| Tom, face clamp | 3,441 | 0.0 % | 2.4 (3) | 17.8 % | 178,444 |
| Filip, default | 1,185 | 3.7 % | 5.1 (238) | 35.8 % | 87,981 |
| Filip, face clamp | 1,524 | 0.1 % | 2.3 (8) | 27.9 % | 84,562 |

- Tom (`scratch/ab_tom.jpg`): the default is the cleanest disc model of
  the series; the face clamp removes the last eye-level lines and brings
  the spots back from 30°/60° above and from below — the face is seen
  obliquely too, so "face only" does not escape the trade.
- Filip (`scratch/ab_filip.jpg`): the default is soft everywhere (the
  orbit's island, a pose problem); the clamp breaks the mouth and spots
  the skin. The user: Filip's default is better than the earlier runs.
- Verdict (user agreed): the default stands, the face clamp stays an
  experiment (`?blob=R&blobface=1`). Lisa's pair pending (her first pair
  overflowed the 2 GB target binding: 934 crop windows from 206 4K frames;
  fixed with a 320-window budget, 43a761f).

## 2026-09-15i (pose refinement, once more: the cameras move millimetres and the face blurs)

The user's premise: needles and edge-on discs are how the optimiser
reconciles cameras that disagree, so refine the poses photometrically
("we tried once, limited success — once more, without any needle clamp").
New this time: the trainer records the solve's poses and reports the drift
(`trainer.camDrift()`, logged at train-complete), the moved poses are
written back into `recon.cams` so the hull, cut and landmarks see the
trained frame, and `?camlr=N` scales the pose learning rates. Tom 30k at
0.003, no shape terms, one run each (scene 15.09 units/m):

| run | rotation median / max | camera centre median / max | face visible | face needles | edge-on to frontal cam | body needles |
|---|---|---|---|---|---|---|
| poses from the solve | – | – | 2,319 | 5.3 % | 21.4 % | 13.1 % |
| pose opt, all cameras | 0.037° / 0.19° | 1.6 mm / 9.1 mm | 2,096 | 5.4 % | 27.0 % | 14.0 % |
| pose opt, crop windows only | 0.023° / 0.14° | 0.9 mm / 6.9 mm | 2,095 | 4.4 % | 21.5 % | 13.2 % |
| pose opt, all cameras, 5x rate | 0.075° / 0.34° | 2.7 mm / 13.8 mm | 2,063 | 5.8 % | 27.9 % | 14.4 % |

- The cameras take millimetres, even at five times the rate: the solve is
  at its information limit on Tom (the pose landmarks' nose residual was
  1.8 px). The freedom is spent absorbing error, not fixing it.
- Needles do not go down and the edge-on share goes UP with all-camera
  refinement; the visible face count drops 10 %. Sheet
  `scratch/camopt_cmp1.jpg`: all-camera runs are softer in the eyes, the
  5x run doubles the mouth from below and the right; crop-only is the
  baseline with a few more streaks.
- Verdict: on Tom the discs and needles are not a pose problem. They are
  the surface representation under an eye-level orbit (thin, view-hiding
  primitives are the cheapest fit). Pose refinement stays off; the drift
  report and the write-back stay (they make the next Filip test honest).

## 2026-09-15h (only blobs: the lines are gone, the skin goes blotchy off-axis)

The user's rule: "only train blobs — the longest axis at most 3x the
shortest". `trainer.blobRatio` (avatar `?blob=R`): a pass after every Adam
step moves the longest and shortest log-scale toward each other by half the
excess over log R (the size is kept), the middle axis clamped into the
range. Tom 30k at 0.003, one run:

| run | package | face visible | longest/shortest median (max) | longest / shortest axis | body visible |
|---|---|---|---|---|---|
| 0.003, discs allowed | 179,778 | 2,319 | 5.75 (270) | 4.5 / 0.76 mm | 45,427 |
| 0.003 + needle 0.03 | 190,399 | 2,216 | 5.54 (207) | 4.3 / 0.74 mm | 47,304 |
| 0.003 + blob clamp 3 | 217,794 | 3,519 | 2.38 (3.00) | 2.9 / 1.31 mm | 66,230 |

- The clamp holds (max ratio exactly 3.00). Frontal and three-quarter: no
  lines at all, the first close-up of the series without a single streak;
  the skin reads as smooth clay, slightly softer than the disc model
  (`scratch/blob_cmp1.jpg`).
- Off-axis it pays: from 30° and 60° above and from below the face shows a
  field of dark and light spots (blobs that the level views placed can no
  longer hide behind each other as thin discs do), the crown is worse
  still. A blob has no direction to be right in; a disc has.
- 348k of the 600k splats are the person (against 271k with discs): round
  volumes need more of them for the same surface.
- **Ratio 5** (same recipe): face visible 3,499, longest/shortest median
  2.79 (max 5.00), longest 2.9 mm, shortest 1.08 mm, package 215,121.
  Frontal and three-quarter: no lines, a touch sharper than ratio 3 (eyes,
  brows). Off-axis the spots are the same as at ratio 3, from 30° above,
  60° above and from below (`scratch/blob_cmp2.jpg`). The ratio between 3
  and 5 does not buy the off-axis view back; the spots are the blob regime
  itself (the look the disc/needle set replaced in August).
- Verdict so far: discs give clean off-axis views and lines at eye level,
  blobs give clean eye-level views and spots off-axis. A face-only clamp
  would put the trade where the user looks closest; the crown is unsolved
  in both.

## 2026-09-15g (the lines are edge-on discs, not needles)

The user, on the needle-regularised model: "so the many lines I still see
are discs". Measured on the visible face splats (opacity > 0.3, 12 cm) of
the 0.003 + needle 0.03 run: 24 % have their disc normal more than 75° off
the frontal camera's view direction — a disc seen edge-on draws a line the
width of its thinnest axis (median 0.74 mm). Test by removal
(`scratch/edgeon_cmp1.jpg`): with those 2,463 splats taken out the lines on
the face are gone and the face stays intact; a crude cull by the head's
radial normal (5,276 splats) breaks the face, so the radial is not a usable
normal there.

- Shape regularisers cannot fix this: the needle term does its job (needles
  5.3 → 1.5 %) and the lines stay. The cure is orientation. New
  `trainer.orientReg` in the chain kernel: penalty `w (1 - |n . v|)`, n the
  shortest axis (the disc normal), v the view direction of the camera being
  trained — the gradient goes through the existing dR → quaternion chain.
  Over an orbit that turns discs toward the surface normal. Avatar
  `?orient=W`; runs at 0.01 and 0.03 on top of 0.003 + needle 0.03 queued.
- The cull itself is view-dependent and no export fix.
- **Orientation runs** (Tom 30k, 0.003 + needle 0.03): edge-on share of the
  visible face splats to the frontal camera 22.6 % → 17.6 % (0.01) → 15.0 %
  (0.03), median angle between disc normal and view 55° → 45° → 33°. The
  term turns the discs, but the lines in the frontal close-up barely change
  (`scratch/orient_cmp1.jpg`), and 0.03 is rougher from 30° above (a grey
  patch on the temple) and messier at the crown. Not a cure at these
  weights: what still draws lines is the 15 % that stay edge-on, and the
  data gradient defends them. The hard blob clamp (`?blob=3`) is the next
  test.

## 2026-09-15f (a needle regulariser that leaves discs alone)

The user: "at close up, every needle destroys the illusion". The old
anisotropy term pulled all three log-scales to their mean and turned the
face discs into round blobs (fp2). New `trainer.needleReg` (+ `needleRatio`,
default 3) in the chain kernel: only the excess of the LONGEST axis over the
MIDDLE one beyond the ratio is pulled in (longest down, middle up), so a
disc (two long axes) is untouched and a needle widens into a disc. Avatar
switch `?needle=W[,T]`. Tom 30k at opacity pressure 0.003, visible splats
(opacity > 0.3), needle = longest/middle > 3 with middle/shortest < 2:

| needle weight | face visible | face needles | face discs | body visible | body needles |
|---|---|---|---|---|---|
| 0 | 2,319 | 5.3 % | 32.9 % | 45,427 | 13.1 % |
| 0.01 | 2,274 | 2.8 % | 34.2 % | 46,515 | 6.0 % |
| 0.03 | 2,216 | 1.5 % | 33.3 % | 47,304 | 3.7 % |

- The needle share falls 3.5x on the face and on the body while the disc
  share and the visible count stay: the term does what it says and nothing
  else. Sheet `scratch/needle_cmp1.jpg`: at eye level the three are close,
  0.03 has the fewest fine streaks on the forehead from 30° above; the crown
  from 60° is the same mess in all three (supervision, not shape).
- Needles are not at zero; the next rung is weight 0.1 or ratio 2.5, and
  the question whether the remaining 1.5 % still show in the user's close-up.

## 2026-09-15e (100k at the new default 0.004: sharper at eye level, the crown pays)

Avatar default opacity pressure 0.004 (75b1abd). Tom 100k, corrected SH
gradient; 7.5 min of training on the 5080 (30k: 95 s).

| run | package | face rows / visible (10 cm) | median face opacity | face long axis | needles | body visible |
|---|---|---|---|---|---|---|
| 0.01, 30k (old default) | 119,504 | 6,198 / 1,107 | 0.14 | 6.7 mm | 4.2 % | 16,090 |
| 0.003, 30k | 179,778 | 8,225 / 2,319 | 0.18 | 4.5 mm | 5.3 % | 45,427 |
| 0.004, 100k | 164,680 | 8,317 / 1,560 | 0.15 | 5.0 mm | 2.1 % | 30,905 |

- Eye level: the cleanest frontal and three-quarter face of the series,
  crisp eyes, fewer needles (sheet `scratch/long_cmp1.jpg`).
- From 30° above the forehead is rougher than at 30k and a grey patch sits
  on the temple; from 60° above the crown is a coloured streak field, worse
  than every 30k run; the hair from behind streaks. More iterations
  extrapolate harder where nothing looks down (growth runs to 50k there).
- The pressure accumulates with length: at 0.004 for 100k the visible face
  count (1,560) sits below 0.003 for 30k (2,319). A per-iteration pull
  toward transparency is a function of the horizon, not a constant —
  candidate: apply it only during the growth phase (it exists to prune),
  or scale it by 30k/horizon.
- Open: the crown needs a view from above (capture guidance) or a rule for
  the unsupervised region; the horizontal-SH decision is still the user's.

## 2026-09-15d (the opacity pressure IS the face-density lever)

The face-only model had four times the visible face splats of the default
at the same shapes (09-15), and crops-only training did not move that count
(09-15c). The remaining suspect was the opacity pressure — 0.01 on every
splat, all the time (3DGS-MCMC default). `?opreg=N` on the avatar run,
Tom 30k, corrected SH gradient, one run each:

| opacity pressure | package | face rows / visible (10 cm) | median face opacity | face long axis | body visible | person after the cut |
|---|---|---|---|---|---|---|
| 0.01 (default) | 119,504 | 6,198 / 1,107 | 0.14 | 6.7 mm | 16,090 | 214,126 |
| 0.003 | 179,778 | 8,225 / 2,319 | 0.18 | 4.5 mm | 45,427 | 271,231 |
| 0 | 181,499 | 3,783 / 2,651 | 0.46 | 3.7 mm | 122,679 | 193,682 |

- Visible face splats double at 0.003 and the splats get smaller (long
  axis 6.7 → 4.5 mm): the pressure was dimming the face, not the schedule.
  Sheet `scratch/opreg_cmp1.jpg`: 0.003 has the cleanest frontal and
  three-quarter skin of the series (fewer streaks), 30° above about level
  with the default, the crown from 60° above rougher (more small splats in
  the unsupervised region), a dark patch under the jaw from below.
- 0: smoother still from the front but flatter, waxy; from above the
  forehead and eyes show dark spots and the crown streaks; the body keeps
  7.6× the visible splats of the default (nothing dies), package 1.5×.
- The pressure removes what the loss does not defend; on a person the face
  is exactly where that loses detail. 0.003 is the candidate default
  (user's eyes decide); the long run and the relocation window are next on
  it.

## 2026-09-15c (crops-only training: register in full, train on the person's windows)

The user's proposal from the knob discussion: keep the registration on the
full frames, put the loss only on the person crops (native rectangular
windows, room inside them, no mask). `session.opts.lossCams(cam)` marks
which registered cameras carry the loss (the rest keep their poses for the
hull, the cut and the landmarks); `?cropsonly=1` sets it to the crop
cameras. Tom 30k, corrected SH gradient in all three, one run each:

| run | person after the cut | face rows / visible (10 cm) | face long axis | body visible |
|---|---|---|---|---|
| default (62 room frames + 269 crops) | 214,126 | 6,198 / 1,107 | 6.7 mm | 16,090 |
| crops only, rectangular (`cropmask=0`) | 148,192 | 4,788 / 1,045 | 7.6 mm | 18,004 |
| crops only, person pixels (sentinel) | 233,070 | 6,235 / 1,078 | 6.6 mm | 15,668 |

- The visible face count does not move: 1,045–1,107 in all three. Three
  times the visits on the head do not keep more splats alive; the visible
  density is set by the opacity pressure and relocation, not by the
  schedule. Sheet `scratch/cropsonly_cmp1.jpg`.
- Rectangular crops: the room inside the windows takes 66k splats of the
  person's budget; the face is smoother but softer (larger splats, less eye
  detail), fewer streaks from 30° above, a dark patch under the jaw from
  below, and the top of the head smears from 60° above (the windows are
  cut from an eye-level orbit, nothing looks down).
- Person-pixel crops: close to the default, slightly more streaks from
  above.
- The switch stays in (off by default) as the base for a later long-run
  test; at 30k it is not a win.

## 2026-09-15b (the chin blob: a leaking position gradient in horizontal SH)

The user traced a 1 cm grey blob under the chin through the screenshots of
the last two days: every run with it trained horizontal-only SH, every clean
run predates the switch (the logs agree: `grep 'SH on the horizontal'`
over `scratch/avatar_tom_*_run.log`). Chin close-ups (`below:0:-25`,
`belowR:-35:-20` in `scratch/render_views.mjs`) show the default with a grey
smear under the chin where the pre-horizontal run has warm skin.

- **Defect** (`src/gs/shaders.js`, SH backward): the forward evaluates the
  SH on the view direction projected onto the horizontal plane; the backward
  pushed the colour gradient into the splat position with the chain rule of
  the UNPROJECTED direction, `(I - v v^T)/|u|`. The vertical part of the
  gradient, which the projection should remove, leaked into the position
  update: a colour-driven push along the up axis, strongest where the colour
  changes fastest with the vertical view angle (the shadow under the chin,
  the underside of the nose). Fixed with the full chain
  `(I - u u^T)/|u| . (I - up up^T) . (I - v v^T)/|h|`; the finite-difference
  check (`gradCheckSH` now takes `trainer: { shUp }`) passes for the full,
  the vertical and the tilted up.
- **Retrain** (Tom 30k, one run each): the blob under the chin is gone from
  below and from the front; from above the run is at the level of the old
  horizontal run (the reason horizontal SH exists). Face(10 cm) rows 6,198
  with 1,107 visible, against 5,827 / 775 with the leaking gradient and
  5,628 / 804 before horizontal SH.
- **Viewer mismatch, small**: the coefficients assume the projected direction
  but the app viewer and the client evaluate on the full direction.
  `?shup=x,y,z` on a `?model=` view (and `--shup=auto` in render_views)
  evaluates as trained; side by side the difference is a slightly different
  skin tone from the front and nothing at the chin. An export refit of the
  coefficients for full-direction viewers is the follow-up if horizontal SH
  stays.

## 2026-09-15 (the face polish stage: the transplant works, the seam does not — opt-in, off)

The user asked for "the discs again with the smoothed skin like before that
only had the halo issue": the face-only disc model (20k flat discs on the
triangulated face mesh, trained on the 33 native head crops with the loss
inside the landmark hull) as a stage that puts its face into the avatar.
`app/avatar/stages/facepolish.js`, after the cut, `?facepolish=1`. Eight
runs on Tom 30k, close-ups with `scratch/render_views.mjs`
(`scratch/facepolish_cmp*.jpg`):

| run | face model | transplant / stitch | result |
|---|---|---|---|
| fp2 | anisoReg on | 20 mm | discs go round (needle 1.1), blurry |
| fp3 | flat discs | 20 mm | haze: the halo of unsupervised discs rides in |
| fp4 | flat discs, opacity > 0.2 | 20 mm | the face itself is thrown out |
| fp5 | **masked** (random background outside the hull, `maskTraining`) | keep 30 mm, replace 25 mm, opacity ≥ 0.05, no stitch | halo gone, smoothest face yet; hard seam along the mask edge; 13,037 face splats replace 8,033 |
| fp6 | as fp5 | 1,500 stitch iterations on the full frames | fog (the cut-out model cannot explain the room) |
| fp7 | as fp5 | stitch on person pixels only (sentinel) | seam softer, bloom OUTSIDE the silhouette |
| fp8 | as fp5 | stitch with `maskTraining` + person crops, growth and relocation off | bloom gone, seam softer at eye level; from 30°/60° above the face is still a mask with a rim at the forehead and hollow eye sockets |

Face(10 cm) rows: default 5,827 (775 visible), fp8 14,123 (3,030 visible),
needle median 75 → 53. Frontal and side close-ups of fp8 are the smoothest
skin of the whole 09-14 series, and the numbers say the face has more
material. But the ruler is the user's eyes over all views, and from above
the transplant loses to the default: the face-only model never sees a view
from above (an eye-level orbit), so its shell has no roof, and the replaced
25 mm band takes the avatar's own forehead and hairline splats with it.
A feathered replacement band would soften the rim, not put the roof on.

- **Verdict**: the stage stays in the pipeline, opt-in and off by default.
  What it proves: a face trained alone IS smoother, the smoothness comes
  from not serving hair, silhouette and room; and a masked face model has
  no halo. What is missing is supervision of the transplant from above —
  the same gap the crown has in every orbit clip (capture guidance).
- Mask erosion (`?croperode=px`, chamfer on the person crops' sentinel,
  24 px tested): neutral to slightly smoother, no seam; off by default.
- Committed with this entry: facepolish stage, manifest/runner wiring,
  crop erosion switch.

## 2026-09-14b (invert the pipeline: train the room, cut the person out — the premise holds)

The user's hunch: full-frame training beats the masked avatar recipe. Tested
on his clip with the pieces that exist — the matte stage on the 65 frames in
a headless page, `buildVisualHull` against the run's own reconstruction,
`makeSplatTest` on every splat of the PLY (`scratch/cut_page.html`,
`scratch/cut_run.mjs`), close-ups with `scratch/render_views.mjs`.

| model | splats after the cut | needle ratio median | close-up |
|---|---|---|---|
| user's showcase scene (100k iters, 1280 px), hull cut | 95,294 of 310,043 | 130 | smooth skin, crisp eyes; colour fringe at the back of the head |
| full scene at the DEFAULT 20k (no avatar tick), hull cut | 91,339 of 354,895 | **15** | smooth skin, some hair streaks |
| masked avatar run, 20k + 12k face pass | 177,705 | 344 | streaks on skin |

- **Same budget, no masks: the needles go from 344 to 15.** The masked
  recipe (few seeds, random background at the silhouette, coverage/alpha
  pressure) is what drives the spiky surface, not the clip and not the
  iteration count alone; 100k on top adds the sharpness. The masked run's
  12k face pass did not help it against a full-scene run with no face pass.
- The hull cut is loose: wall colour rides along at the profile, a sliver of
  floor can survive under the shoes. Those are the vote cut (per-splat
  alpha-weighted inside/outside share over the views, a backward-kernel
  variant) and a short masked polish pass, both still to build.
- The user's downloaded PLY holds 310k splats while its recon says 1.19 M at
  100k iterations — a pruned/LOD export; the full model may be better still.
- Plan agreed in discussion: "Make an avatar from this scene" on a finished
  run (session + photos + recon; COLMAP data from elsewhere qualifies too):
  matte, face pass BEFORE the cut (crops see the real room), vote cut, short
  polish, then the existing landmarks / body fit / bind / publish. Native
  frames must be in the package for 4K crops. The video tick becomes one way
  to get a base, not the only one.

## 2026-09-14 (Tom's 19 s 1080p orbit vs Lisa: the spikes are the iteration count, and three defects on the way)

The user shot `tom_avatar.MOV` (iPhone, 1080x1920 portrait, H.264, 19.3 s,
579 frames, office with backlit windows) and ran avatar mode: "fine, but the
surface is quite spiky — is it worse because of missing data?" Ran the same
e2e (`tests/e2e/avatar_mode.mjs`, now with `--iters/--faceiters`) on both
clips at the app defaults (20k + 12k face) and at the quick setting (3k +
1.5k), and measured the OUTPUT distributions (scratchpad `splat_shape.py`:
exp(scale) per splat, needle ratio = longest / shortest axis).

| run | frames / registered | train res | splats | needle ratio median | >10 | body fit | face |
|---|---|---|---|---|---|---|---|
| Tom 1080p, 20k+12k | 65 / 62 | 1263 px | 177,705 | **344** | 81 % | 3.1 cm | 4.7 mm |
| Tom 1080p, 3k+1.5k | 65 / 62 | 1263 px | 103,749 | 3.6 | 16 % | 2.0 cm | 4.5 mm |
| Lisa 4K, 3k+1.5k (= dev avatar 5648) | 208 / 207 | 706 px | 78,878 | 3.0 | 7 % | 2.6 cm | 2.4 mm |
| Lisa 4K, 20k+12k | 208 / 206 | 706 px | 153,437 | 44 | 81 % | 2.6 cm | 2.3 mm |
| Lisa bench v3 SH3 (40k, CLI) | 186 | — | 336,674 | 583 | 99 % | — | — |

(body fit / face in REAL cm / mm, see the units defect below; the old
"1.0 cm" on Lisa was 2.6 cm.)

- **Verdict: not the data.** The avatar the user compares against (dev 5648)
  is the e2e's QUICK run — 3,020 iterations — and at 3k every model is a
  smooth blob (needle ratio ~3). At the app default the trainer's needle
  defaults (minScale 1e-5, anisoReg 0, 2026-09-08) take over: Tom 344, Lisa
  44, the CLI 40k Lisa 583. Close-ups in the app viewer from each run's own
  frontal camera (`scratch/spiky_cmp.jpg`, `scratch/render_views.mjs`)
  show the streaks on Lisa 20k exactly as on Tom 20k, and Tom 3k as soft as
  the dev Lisa. Tom's 20k face is the SHARPEST of the four: 65 frames train
  at 1263 px, Lisa's 208 frames at 706 px (the tab's frame budget divides
  the resolution by the frame count), and the face pass reached 29.4 dB.
  So a 19 s 1080p orbit is enough; the spikes are the same hair-edge needle
  streaks listed as open since 09-13 and now visible on skin at arm's
  length. Next: an avatar-mode aniso cell (trainingOptions in
  app/avatar/index.js: a scale floor / anisoReg for the person, judged on
  the needle-ratio distribution AND the close-ups).
- **Defect 1: scene units.** A solve's unit is arbitrary — Lisa's orbit came
  out at 0.32-0.38 units per metre (3 m per unit), Tom's at 15-19 (7 cm per
  unit). The body fitter (Huber 0.05, pose/shape regs), the head registration
  (pin floor 0.012), the interior cull (reach 0.06, cell 0.02) and every
  "cm/mm" report took scene units for metres, so on Tom the Huber was 3 mm,
  the cull reach 4 mm (nothing culled — the mouth cavity was back), and the
  fit read "105 cm". Now everything goes through the fit scale (residuals in
  metres inside the LM, thresholds x scale), with constants chosen to
  reproduce what Lisa's frame had validated (huber 0.13 m, regs 0.02, cull
  reach 0.16 m / cell 0.05 m, pin floor 0.032 m). Tom: 6.4 -> 3.1 cm real
  landmark residual, head 6.5 -> 4.7 mm. Lisa unchanged (2.6 cm / 2.3 mm).
  export-binding-core was NOT touched: it already divides by the fit scale
  (rig metres) — a first patch there smoothed weights over 1.35 m and leaked
  4.9 % between the legs; reverted (leak 0.1 %, mean near 1.67 cm).
- **Defect 2: the solve can lose the person.** Lisa 4K at 20k collapsed
  once: the focal search subsample (every 5th of 208) registered only 5-6
  of 42 cameras for EVERY candidate, the pixel median picked 1.20x maxDim
  for a 0.69x ultra-wide clip, the final pass still registered 201/208 (so
  the < 70 % retry never fired), and the mask filter kept 108 of 13,741
  sparse points on her: 14 seeds, 2,814 splats after 20k iterations, body
  fit and head garbage. The good runs got 0.69x only because the first
  pass registered 137/208 and the relaxed retry re-searched. Two changes in
  `src/sfm/sfm.js` / `src/session.js`: when the best search candidate holds
  under a third of the subsample, search again on every 2nd frame (Lisa:
  0.69x wins 71/104 vs 15/104 for 1.20x, +10 s; Tom's every-2nd search is
  untouched), and a masked run whose subject keeps < max(150, 1 %) of the
  sparse points stops with "the solve missed the person" instead of
  training. Verified: the rerun took the densified path and solved 206/208
  at 0.72 px.
- **Defect 3 (small):** `tests/e2e/avatar_mode.mjs` hard-coded 3k/1.5k, so
  the dev avatars 5647/5648 are quick runs — `--iters=20000 --faceiters=12000`
  now reproduces the app. Note for the record: the Git Bash shell rewrites a
  leading-slash argument into `C:/Program Files/Git/...` (MSYS path
  conversion) — pass paths without the slash or set MSYS_NO_PATHCONV=1.
- **Step 1 built** (abc5d61 + 7e49ffd): avatar mode trains the room
  (session `maskTraining: false`), the face pass runs on the room, a new
  `cut` stage isolates the person with the hull splat test into a fresh
  session, then body fit / bind / publish. Tom 20k+12k: 76,857 splats, bind
  0 far. The face pass brought streaks back around the head (needle median
  32): anisotropy regulariser 0.01 on the face session -> 2.8 with the same
  sharpness in the close-ups (`scratch/facepass_cmp.jpg`); scale floor 1e-3
  -> 7.7, streaks remain; no face pass -> 15 but softer. anisoReg 0.01 is now
  the face-pass default — and then the user's review: no visible sharpness
  gain from the pass on the room-trained model, so the face pass is OFF by
  default (`?faceiters=N` runs it); the isolate stage's fallback (a session
  rebuilt from the capture files) verified, 56,160 of 119,567 splats, bind
  0 far. Still open: the viewer keeps showing the room after
  the run (the app's view stays on the first session); the loose hull cut.
- **Person and head crops as extra cameras, from the start** (the user's
  design: "we still train on the full scene, but add cropped images to train
  with full res on the avatar"). `app/avatar/crops.js`, between solve and
  seed: per picked frame the matte's box at native scale, split into tiles
  of <= 1024 px (145 on Tom) plus a square head window of 0.3 x box height
  around the matte's mass in the top rows (62, sampled x2); a crop camera is
  the frame's pose with the principal point moved by the window origin, at
  the crop's own feature scale. Two decoder traps: the app's buffer factor
  (`trainScale` 0.67) and the per-set cap taken from the FIRST image (frame 1
  has the person far away) both shrank the crops to 685 px — no trainScale,
  largest window first. Tom 20k, one run, no face pass: face splats within
  8 cm of the nose 1,554 -> 2,389 (visible 543 -> 699), median longest axis
  6.2 -> 5.0 mm, person after the cut 79,726 -> 105,263; the close-ups are
  visibly crisper (eyes, nose, lips) with no streaks (`scratch/crops_cmp.jpg`).
  Not the doubling yet: the total splat count is fixed by the growth
  schedule (367k in both runs, growth stops at 75 % of the horizon), the
  crops only redirect it — a larger seed / growth rate for avatar runs is the
  next knob. Peak memory: the crops decode as float copies next to the
  frames (~0.6 GB on this clip); phones will need a stride.
- The face pass as a continuation cannot do this: with its own growth window
  it reached 2,387 face splats too, but three quarters of the growth went to
  the room, and the shots got streaky (`scratch/facepass_pair2.jpg`). It
  stays off; `?faceiters=N` keeps it for experiments.
- **Iterations for a person** (Tom, crops, 20k / 30k / 40k / 40k with a 1M
  cap): face splats within 10 cm of the nose 3,429 / 4,711 / 4,783 / 4,767;
  package 90k / 109k / 102k / 109k; 30k visibly sharper than 20k (skin,
  eyes, hairline), 40k the same as 30k, the lifted cap only grew
  low-opacity splats the export prunes. Avatar default 30k (AVATAR_ITERS in
  app.js), cap stays 600k. `scratch/iters_cmp.jpg`, `scratch/cap_cmp.jpg`.
- **Filip's clip** (17 s, 1080p, a second person walks through): 43/59
  registered, frames 17-30 form their own island (usable pairs among
  themselves, none to the rest), 31/32 are the blur dip (half the
  features). The new gap retry (>= 5 consecutive unregistered frames ->
  relaxed pair gate) fired and registered 38 — kept the first pass: no
  matching threshold bridges an island, one frame of it has to be PLACED
  (landmark PnP prior, then the chain continues by features). And the front
  views ghost: the head moved between the far start and the close-up end of
  the orbit — per-window pose freedom for the crops is the fix to test
  (`?camopt=1` = the trainer's photometric pose optimisation on all
  cameras, the first check). `scratch/filip40_views.jpg`.
- **Head-stabilised head windows** (the person as anchor, part 1). Filip's
  nose triangulated from the start / middle / end of the orbit sits within
  1.7-2.5 cm — enough to double the eyes at arm's length, and the trainer's
  photometric pose optimisation on all cameras did nothing (every camera
  also sees the room, which pins it). Person-only crops (pixels outside the
  matte carry the invalid sentinel) neither helped nor hurt at 30k; free
  crop cameras (`camOptOnly: 'crop'`, new trainer option) made the eyes
  worse. What works: the landmarks stage now runs right after the solve and
  its head-stabilised crop cameras (per-frame PnP on the 468-point face
  triangulated from the frames) become the head windows — Filip's frontal
  face goes from doubled to single (`scratch/filip_stab.jpg`, 29 of 43
  head windows stabilised; the mouth still smears from the right, the
  windows without a face keep the room pose); Tom neutral to slightly
  better, face splats 4,711 -> 5,632 (`scratch/tom_stab.jpg`); the person
  keeps far more splats after the cut (Filip 87k -> 133k, Tom 153k ->
  225k). The joints card is reviewed after training (reviewPending). Knobs
  kept for experiments: `?camopt=1|crop`, `?cropmask=0`.
- **When to take the face pose** (user: "Tom head stabilised got worse"):
  not head motion — the nose tip triangulated from the first vs last third
  of the face views shifts 0.58 cm on Tom and 0.59 cm on Filip (the earlier
  "2 cm" came from the body landmarks with a sloppy frame mapping); not the
  per-frame pose difference either (median 2.8 / 3.0 px on both). What
  separates them is how well the room's poses agree on the PERSON: the pose
  landmarks' multi-view nose residual, 1.8 px on Tom vs 3.2 px on Filip
  (feature scale). Rule: above 2.5 px the head windows take the face-PnP
  pose (Filip: 29/29, single face again, `scratch/filip_rule.jpg`), below
  they keep the room's (Tom). Two clips — the log prints both numbers on
  every run to find the threshold.
- **From above: the SH question** (user: heavy artifacts when the camera
  looks down; keep the forehead highlight if possible). Tom 30k at four
  elevations (`scratch/sh3_cmp.jpg`): the damage from 60 deg up is
  GEOMETRY (hair streaks, the crown is a hole no camera saw); the colour
  blotches at 30 deg are SH. **Horizontal-only SH** (new: the view direction
  loses its component along the cameras' dominant up before the basis, in
  training's forward and backward kernel — `session.shHorizontal`, Cam
  struct + `shup` vec4) removes the blotches and keeps the highlight; the
  export is stable in a plain full-SH viewer too (the vertical-only
  coefficients never got a gradient). Now the avatar default (`?shup=0`
  for full SH). SH0 as the "last resort" test collapsed in this pipeline
  (92 % dead capacity at the last refine, 24k splats in the package, a
  blurred face) — a defect of shDeg 0 with the current avatar recipe, not a
  verdict on SH0; parked. The crown itself is a capture problem: a
  tilt-down segment in the orbit.
- **Face-mesh seed** (the user's experiment: "we know it's a face, seed all
  of them uniformly"). Standalone first (`scratch/face_seed.html`): the 478
  triangulated face points + MediaPipe's tessellation (1,681 triangles),
  20k flat splats sampled by area, normals from the triangles, colours from
  the frontal crop, trained 8k iterations on the 33 face crops alone with
  everything outside the projected face hull masked out (invalid sentinel)
  — a clean single face in a minute, on par with the pipeline's face region
  in front and side views, but a halo of stretched splats where the hull
  let hair and background through, and worse from above (only a face shell
  was seeded); `scratch/faceseed_cmp.jpg`. Then as a SEED in the main run
  (`app/avatar/faceseed.js`, the samples join the sparse cloud before
  session.seed; `?faceseed=0|N`): Tom 30k face splats within 10 cm of the
  nose 5,827 -> 7,235, median longest axis 4.7 -> 4.0 mm, skin a touch
  smoother in the close-ups, from above unchanged (`scratch/faceseed_main.jpg`).
  Trap: the seed points went into the sparse cloud the isolate stage bounds
  the hull with — 20k on the head shrank the box to the head (package 54k
  instead of 128k); the isolate stage now drops `faceSeed` points first.
  The user saw it WORSE. Handed over as points the cloud seed sizes them by
  nearest neighbour (dust) and orients at random; as ready-made flat discs
  (`faceSeedGaussians`, `session.seed({ appendGaussians })`) it is neutral:
  face splats 5,827 (none) / 7,235 (points) / 6,690 (discs) with the same
  look (`scratch/faceseed3.jpg`). Is the mesh off? No: the triangulated
  face points drawn over the unseeded model sit on eyes, nose and mouth
  in every view (`scratch/face_overlay.jpg`, `scratch/overlay_face.py`),
  median 7.0 mm from the nearest visible splat centre, -2.3 mm along the
  view axis. The seed is placed right and then PRUNED: 20k seeded, ~1-1.5k
  kept — the face density is set by the growth/prune equilibrium, not by
  the start. Off by default (`?faceseed=1|N` keeps it for experiments);
  the lever, if wanted, is protecting the seed from relocation for the
  first thousands of iterations or a lower prune pressure on the head.
- **Head seed, protected** (user: "complete the head, ~50k, protect them
  from relocation"). `app/avatar/headseed.js`: Anny fitted to the joints
  before training (no splat pull), its head registered to the 478 face
  points (4.5 mm), 50k flat discs on 5,698 head triangles (1,087 cm²,
  1.5 mm spacing), each coloured from the frame that looks at it most
  squarely; `trainer.protect = {from, to, until}` keeps the rows out of the
  dead list and the donor list. Tom 30k, within 16 cm of the nose:
  none 13,313 (visible 1,845) / protected 8k 14,498 (1,851) / protected all
  30k 10,400 (2,028). With the 8k window the first refine after it declared
  83k dead (3x the usual) — the seed was only delayed. With full protection
  the seed splats DIED IN PLACE: opacity regularisation and decay took them
  below the export prune (fewer rows, +10 % visible). Views: no gain on the
  face, a slightly fuller crown from above, the fully protected face a touch
  softer (`scratch/headseed_cmp2.jpg`). Verdict: head density is set by the
  opacity pressure and the data's resolution (1.3 mm/px at orbit distance =
  1-2 px per splat at 50k), not by the seed. Off by default
  (`?headseed=N[,protectIters]`). Iteration 0 rendered
  (`scratch/seed_iter0.jpg`, `scratch/seed_view.html`): the 50k discs alone
  are a complete, well-shaped head; in the real initial model they were
  buried in the cloud seed's neighbour-sized blobs (fog). With the cloud
  seed cleared inside the head sphere (1.3x the fitted head, 1,239 points)
  the discs start alone — still pruned to the equilibrium (15,379 rows /
  1,918 visible within 16 cm vs 13,313 / 1,845), views the same
  (`scratch/headseed_cmp3.jpg`). Lever left: opacityReg per region — with
  the blur risk of keeping half-dead splats.
- **Frozen head seed only** (user: "fix the number of splats to the seed,
  only train these, keep positions fixed"). `scratch/head_only.html`: the
  50k discs alone, `posLrScale 0`, no growth/relocation (`growUntil` /
  `relocUntil` 0, cap = count), 8k iterations on 65 native head windows
  (a square around the projected head sphere in every frame), the room
  masked out by the matte, splat size capped at ~1.2 cm (first pass without
  the matte and the cap: streaks to the walls, 41 % of the discs dead).
  Result: a head from every side, including behind and the crown (the mesh
  is closed), but soft everywhere — 24,435 of 50k survive the export, only
  22 % above opacity 0.3; the optimisation dims discs that sit off the true
  surface (the Anny scalp has no hair volume, the face is 4-7 mm off in
  places), and frozen positions cannot correct that. Worse than the
  pipeline's head in every view except that the crown is filled (with
  blur). `scratch/headonly_cmp2.jpg`. Closes the seeding line: the fitted
  head is a good ANCHOR, not a good final surface.
- **Default run + head seed with PINNED positions** (user: "train the
  default in full, only protect the head seed positions"). New: the Adam
  kernel skips the position slots for a row range (`AdamU.bc.zw`,
  `trainer.setFreezePos`), the rows are also kept out of relocation for the
  whole run. Tom 30k: within 16 cm 11,183 rows / 3,724 visible (vs 13,313 /
  1,845) — twice the visible splats and a clearly WORSE face: dark and
  coloured blotches on the cheeks and chin, a mottled forehead from above
  (`scratch/headpin_cmp.jpg`). Pinned discs that sit off the true surface
  (4-7 mm on the face, no hair volume on the scalp) cannot move out of the
  way; they stay visible with colours from views where they are occluded,
  and the free splats have to paint around them. This is the last variant
  of the seeding idea; all of them lose to the plain sparse-cloud start.
  Tooling kept (`?headseed=N,P,f`).
- Still open on Filip: the back island (frames 17-30) — landmark PnP bridge;
  and the unstabilised head windows (no face seen) on the room pose.
- Packages: `scratch/avatar_tom_final_package.zip` (20k, metric fit,
  correct binding), `scratch/avatar_tom3k_package.zip`,
  `scratch/avatar_lisa20k_b_package.zip`. Nothing uploaded; dev still wears
  5648.

## 2026-09-13b (avatar mode in the Splat.js app — feature/avatar-mode)

User: "design a nicely separated pipeline that fits into the Splat.js app …
maybe a separate app". Design page: one app, three walls (library knows no
people; `app/avatar/` lazy-loaded; one service for the body fit); the
manifest on the capture record is the boundary. User: "Yes do it but on
another feature branch" -> `feature/avatar-mode` in Browser_3DGS and
client_git.

- **Step 1 (344235e)**: the video review card grows a box; `app/avatar/`
  (manifest, runner, stages/matte, ui/cutouts). RobustVideoMatting through
  onnxruntime-web: the WebGPU provider accepts the model and refuses
  AveragePool with ceil_mode at run time -> first-frame probe, wasm fallback
  at 1280 px, 0.34 s/frame (149 frames in 50 s). The cut-outs checkpoint
  works; masks ride on the frame entries into the session; the masked
  preset trains; the finished run hands off to the stage runner.
- **Shared rigger core (client_git 687df5984)**: `autofit-core.js`
  (landmarks -> markers -> fit) and `export-binding-core.js` (fit + centres
  [+ surface] -> SBA1), pure; the sidecar payload is byte-identical to
  `tools/export-binding.mjs` on Lisa. Snapshotted into `app/avatar/rig/`
  by `scripts/sync_rig.mjs` until it is a package.
- **Stages** landmarks (tasks-vision pose + face in the tab, CPU delegate:
  148 frames in 7 s; robust DLT with a Jacobi 4x4 eigen solver — inverse
  iteration was the first version and is numerically wrong on these
  systems; PnP by Huber-LM; unit-tested on synthetic cameras and
  cross-checked against the python pipeline's real observations: 0.09 mm
  mean vs `face_canon3d.json`), facepass (crop windows + a second session
  continued from the raw state, crops weighted by face size), bodyfit
  (service hook; rig mesh until the service exists), bind (the core, plus
  the leakage ruler), publish (upload + `POST /avatars/splat`, behind a
  click because sign-in needs one; a package download beside it).
- **Two library bugs the app path exposed** (the bench never hit them):
  the visual hull's median±MAD box collapsed to 1 cm on a cloud whose
  subject points sat in one cluster -> 0 % solid -> 0 Gaussians seeded and
  a run that trained NOTHING (the WebGPU "binding size is zero" errors);
  fixed with a 10-90 percentile floor on the box, a rejection of a hull that
  keeps < 5 % of the points, and a never-seed-from-nothing fallback in
  `seed()`.
- **The 1080p/40 s test clip solves degenerate** with the standard tier:
  camera centres within ~20 cm of one point (a rotation-only solution, BA
  rms fine) — the nose rays never meet, the fit scale came out 0.2. Avatar
  mode now asks for the precise tier and the landmarks stage refuses a
  collapsed camera set with a plain message. The 4K orbit (transcoded to
  H.264 for headless Chrome) is the real end-to-end test.
- **End to end on the 4K orbit** (`tests/e2e/avatar_mode.mjs --train`, test
  budget 3000 + 1500 iterations): 1708 frames scored, 208 picked, matte
  208 frames on wasm, precise solve 207 cameras (4 min), hull 4.8 % solid
  (1878 of 3296 mask-filtered points), 99,534 Gaussians seeded, landmarks in
  17 s (15 markers, residual 0.1 cm, 478/478 face points, 42 head-stabilised
  crop cameras), face pass +1500 with 117 crop samples, bind 81,534 splats
  at 2.73 cm / 0 far / leak 0.5 %, package 23 MB downloaded. The package
  registered through the API as dev avatar **5640** and renders in the
  fixed client with a clean face at 0.55 m (`scratch/closeup_app_sheet.jpg`).
  The "Use as my avatar" button is the same upload path; sign-in needs a
  human click, so that last step is untested headless.
- **SOG** (user: "I am sure sog is fine"): the publish stage encodes the
  PLY with the app's own encoder in the tab (21 MB -> 3.7 MB) and uploads
  the .sog as the splat; the client streams it and the driver's centre remap
  handles the reorder. Dev avatar **5642** from the app's SOG package renders
  the same face as the PLY one (5640) at 0.55 m.
- **The body fit, ported** (user: "Port it"; 1078de9): no service. Anny's
  shape space (624 MakeHuman macro targets, 102 MB) is sampled over the six
  phenotypes and snapshotted as a 23-component PCA over vertices + bone
  heads + bone tails (`tests/bench/export_anny.py`, 1.5 MB, 0.4 mm rms;
  the variance share is a bad criterion — 2 components hold 99.9 % of the
  variance and miss by 8 mm). `app/avatar/body/anny.js` reproduces torch's
  forward pass to ~1 mm (rest orientation from head/tail/roll, local-bone
  FK — root-relative, that cost one 82 cm offset — and LBS, 4.5 ms).
  `fit.js`: Levenberg-Marquardt with a forward-difference Jacobian over
  similarity + 30 body-bone rotations + shape (Lisa offline: landmark
  residual 1.4 cm vs Python's 2.6, markers 2 cm from the Python fit).
  `head.js`: correspondences from a canvas-rendered head through the same
  face landmarker, Laplacian deformation by conjugate gradients — the
  Python result to the last bit. In the app on the 4K orbit: body fit
  17.9 s, landmark residual 1.0 cm, 445 correspondences, face 0.6 mm,
  bind against the fitted body 1.86 cm / 0 far (rig mesh: 2.73 cm). Dev
  avatar **5647** from the app's package (SOG + body-model binding).
- **Walks**: the app-made avatar (5647) walks in the client — W held two
  seconds, four frames, legs separate, arms swing (`scratch/walk_sheet.jpg`).
- **User: "the face fit still has the eye balls and inner mouth"** — right.
  The largest-component filter caught the eyeballs (separate spheres) and
  the teeth/tongue, not the mouth CAVITY (connected to the lips) nor the
  socket lining. A normal-ray test misses the cavity too (closed mouth, the
  walls touch). `cullHeadInterior`: a head vertex is interior when < 20 % of
  20 Fibonacci-sphere rays from it escape within 6 cm — 529 interior
  vertices / 1402 faces on Lisa in 3.7 s; the only face landmarks that lose
  their triangle are the lip seam and the eye slits (25 of 468). Wired into
  the in-tab fit before the head registration.
- Not built: `pcsync` of the driver fix; merge to main.

## 2026-09-13 (the face in the APP: a client fix, one surface, and a head that sits on hers)

User: the renders looked good but not the app. Close-ups through the real
client (Playwright, camera parked 0.45 m in front of the Head bone -
`scratch/avatar_closeup.mjs`, with `--skin=0/--relight=0/--identbones/--rest`
probes) settled it in order:

- **Not relighting, not weights, not the order remap, not the sorter**: each
  toggled/measured in the live client; face splats are 99.9 % Head.
- **The SH0 export was one culprit**: stripping the bands of an SH3 model
  exposes needle splats the bands were hiding - the same file rendered
  smeared in MY renderer too. An SH0 *fine-tune* (bench `?stripsh=1&shdeg=0`,
  8k polish steps from v3, 0.6 min, 28.48 dB) is fine and ships at 18 MB
  (avatar 5637). The user wants the bands kept, so:
- **The real culprit, client side**: the SH3 file rendered sharp with
  skinning OFF and smeared with skinning ON. PlayCanvas's copy-to-workbuffer
  pass evaluates the SH for the UNSKINNED splat's view direction
  (`center.view * mat3(center.modelView)`) before the bone transform; on a
  strongly view-dependent scan every skinned splat showed a colour meant for
  another angle. Fix in `splat-avatar-driver.js` (client_git 473e391e6): the
  colour hook re-evaluates the SH for the skinned direction (world view
  vector from the skinned centre, back through the skin rotation and the
  wrapper rotation), driver-owned `uSkinCamPos/uSkinModelRot` uniforms.
  Verified through the local client build (the build serves the unbundled
  script). Needs `pcsync pushAll` to reach dev/live. This is also what the
  rigger's sidecar path showed on 09-12c.
- **One surface** (user rule): the nearest-surface mesh must be the outer
  skin only - the Anny game_engine surface carries two eyeballs and a mouth
  interior as separate closed components (370 verts); `anny_fit.py` now
  keeps the largest component (client_git 100c9f57d).
- **The head on her face** (user: "nose on nose, chin on chin, I hand-tune
  this"): `head_correspond.py` runs the face landmarker on a shaded RENDER of
  the fitted head and traces all 468 points to barycentric mesh points;
  `head_deform.py` fits a similarity then a Laplacian deformation of the
  head region to the triangulated landmarks (neck fixed, pins with residual
  > 2.5x median dropped: 425/468) - mean landmark-to-mesh 6.2 mm -> 0.4 mm,
  max vertex move 11 mm. Plain point-to-surface ICP (`head_register.py`)
  reached 1.2 mm but slides along the skin; correspondences are what put the
  nose on the nose. (A boundary-term bug first sent neck-band vertices 60 cm
  away - the Laplacian rows already carry the fixed neighbours' share.)
- Shipped: **5639** = v3 SH3 (83 MB) + binding from the face-registered
  single-surface head, assigned. 5638 = same splat, generic-head binding;
  5637 = SH0-trained 18 MB (needs no client fix). Relit close-ups of 5638 vs
  5639 differ only subtly at this light - the normals are right now, the
  visible gains were the SH direction and the SH bands themselves.
- Next: push the driver; head phenotypes in the fitter instead of a
  post-hoc deformation; hair-edge needles (anisoReg); an SH1/SH2 or SOG
  ship size between 18 and 83 MB.

## 2026-09-12d (a sharper face: native-resolution crops as head-stabilised cameras)

User: "research ways we can increase sharpness of the face, maybe retrain once
the surface is known, or get the best face images and reapply - be creative".

- **Diagnosis** (`scratch/face_stats.json`): the face is 133 px ear-to-ear
  at 4K (median; max 350) = 55 px in the 900x1600 training target, and the
  head moves against the body-registered camera (landmark reprojection
  median 37 px at 4K, p90 262 px). Two limits, both must go: resolution and
  head motion.
- **Stage** `tests/bench/face_crops.py`: MediaPipe FaceLandmarker (478 pts)
  on a head window of every native 4K frame (the 189 selected frames
  re-extracted with OpenCV - the ffmpeg select expression for 189 indices
  is too long for its parser; OpenCV applies the rotation metadata, all 189
  matched the training frames at diff 0.7/255) -> robust DLT of every
  landmark across the solved body cameras = a canonical 3D face (478/478,
  median reprojection 3.2 px at 4K) -> per-frame PnP of that face = a
  head-stabilised camera (landmark residual 5.1 -> 2.2 px; head-vs-body
  pose delta median 2.8 deg, p90 11.7 deg) -> a fixed 768x768 window at
  native resolution, cx/cy shifted, f native; RVM matte on the crop gated by
  the dilated body matte. 45 frames show a face (the orbit's back half does
  not), 6 held out (`heldOut` in `scratch/lisa_face_recon_all.json`).
  Session/bench/render_views now honour a camera's own principal point.
- **Continuation was broken** - three bugs found on the way, all fixed
  (c3ca855): (1) `seedFrom()` lacked the masked-set `randomBg` default, so a
  continued masked run trained its empty pixels against BLACK: 200 steps
  from the converged person grew ~240 live splats into opaque 33 cm needles
  (scale +1.3 log, opacity +4.4 logits, the maximum Adam allows at full lr)
  and killed 18k. Found by continuing from the RAW state zip (same wreck ->
  not the import) and matching the needles to their v12 twins by position
  (they were ordinary 10 %-opacity, 4 cm splats). (2) A bare .ply carries
  the Mip opacity compensation BAKED (`exportPlyBlob`) and the trainer
  compensated it again: `unbakeOpacityCompensation` (exact inverse, same f,
  cams, dilate) on import; render_views renders the unbaked model (the
  earlier v12 "baseline" renders were double-compensated). (3) seedFrom
  reset the blur exclusions and the eval split - a resume trained on the
  held-out views. Also `opts.lrWarmup` (ramp after a warm restart) and
  `?fromiter/?warmup/?poststate` in the bench. Probe: 1000 polish steps
  from lisa_v12 now change a held-out view by 1.1/255 mean; before, 85.
- **Results** (six held-out face crops, `tests/bench/face_eval.py`; face
  PSNR = centre quarter of the crop on subject pixels; sharpness = render /
  GT Laplacian variance):

  | model | steps | crops | cap | face PSNR | subject PSNR | sharpness |
  |---|---|---|---|---|---|---|
  | lisa_v12 (body only) | - | - | - | 22.03 | 18.28 | 0.21 |
  | v1: continue 15k (from iter 5000) | 15k | 39 x1 | 600k | 23.96 | 20.10 | 0.22 |
  | v2: continue 35k, crops sampled x3 | 35k | 39 x3 | 1M | 24.52 | 21.02 | **0.47** |
  | **v3: as v2, crops weighted by face size (x1..x6)** | 35k | 39 x1-6 | 1M | **25.47** | **21.99** | 0.44 |

  v2: eyes with catchlights, brows, nostrils and hair strands resolved;
  residual needle streaks at hair edges and speckle at the ear. The BODY
  gains too (held-out views 8/48: 25.3 -> 27.0, 25.7 -> 31.0 dB) - the
  extra steps at a 1M cap were worth having on their own. Bench psnrTest
  (mixed body + crops, 38 views) 29.0. 68 % dead at the cap - the export
  keeps 315k live splats. 5.1 min of training on the 5080.
- **Why it works**: a crop camera is just a camera with a shifted principal
  point and the native focal - no new loss, no new renderer path. The head
  motion goes into the crop's pose (PnP against the person's OWN
  triangulated face), so the crops agree with each other even where the
  body cameras disagree about the head.
- **v3** (crop duplicates `round(3 * facePx / 250)`, 1..6 - the close,
  350 px faces carry the most information): +3.4 dB face PSNR over v12 and
  the cleanest hair (fewer streaks than v2). Body held-out views 8 / 48:
  25.3 / 25.7 -> 26.8 / 31.6 dB. 5.3 min. **Shipped to dev**: SH0 PLY
  (336,674 splats, 22.9 MB) + a fresh Anny-surface binding (2.2 cm, 0 far)
  = avatar **5635**, assigned; runtime console "binding loaded (336674
  splats, 67 bones) -> skinning installed"; Tom Home screenshot
  `scratch/dev_avatar_v3.png`. Package `scratch/avatar_lisa_v3/`.
- Not done / next: the orbit's back half has no face landmarks (no crops
  for hair / back of head - would need ear- or hair-based stabilisation);
  the sharpest frames are the ceiling (350 px face) - a capture that steps
  closer for a few seconds would lift it; the needle streaks at hair edges
  (anisoReg is 0 by default - a small ratio bound for the continuation is
  worth a cell); one recipe cell each for "x3 sampling" vs "35k steps" vs
  "1M cap" to know which of v2's three levers mattered.

## 2026-09-12c (the avatar onto the account: an API route, deployed to dev)

User: "set the avatar for my account" -> "deploy to dev and upload the avatar
to me".

- **Why the public API could not do it**: (1) `/files/upload` stores every
  file as `<hashedUser>/<random>_<name>` and the client finds a splat avatar's
  config by NAME (`glb -> json` beside it) and recognises the type by
  `url.includes("/splat_avatar_")`; (2) `assign` needs an `avatars` row, and
  URL avatars only got rows through the legacy `addAvatarConfig` (browser
  session certificate). The MCP `create_avatar` is parts-only.
- **Route** `POST /api/v1/avatars/splat` (backend_git acc3d15): takes the
  resource keys of already-uploaded glb/splat/binding(+fit, thumbnail),
  COPIES the rig GLB (and thumb) to the legacy layout
  `<user>/splat_avatar_<hash>_<stamp>.glb`, writes the sibling config itself
  (byte-compatible with the client's own splat-done save), inserts the row,
  `assign:true` sets it active. `.bin` added to the upload allow-list. MCP
  tool `create_splat_avatar`; `scripts/upload_splat_avatar.mjs` = the future
  `arrival avatar upload` (there is no `arrival` CLI package yet - the plan
  exists, `api/spaces_cli.js` is its server half). No client change.
- **Deployed to dev** (`deploy_to_dev.sh`, git push + pm2 reload, clean
  boot). Smoke test `backend_test/splat_avatar_smoke.mjs` as the test admin -
  which IS the user's account (id 42485456, same on dev and live; the UGC
  bucket is shared too): avatar **5633** registered and assigned; row lists,
  config resolves, every URL answers. Note: `/loginUser/` returns no API key;
  `POST /api/v1/auth/login` does.
- **Runtime proof** (`backend_test/splat_avatar_view.mjs`: local client build
  -> dev backend, agent-inspection session params, Playwright): Tom Home
  shows the splat; console "binding loaded (336220 splats, 67 bones) ->
  skinning installed (unified work-buffer path)". The Apollo 11 space was
  the first try - a cutscene, camera on a rocket; pick a plain room.
- **A rigger finding, not fixed**: `index.html?fit=&bin=<url>` (reopening a
  saved avatar) renders exporter sidecars as a smear whenever the SIDECAR
  path wins; the page's own rebind (scheduled on entering Animate with no
  lastBinding) races it and masks the problem when it lands last. I removed
  the race (enter Animate after the sidecar) and the smear became
  deterministic - so the sidecar path itself
  (`new SplatSkin(..., placedFitWorld(currentFit), r.binding, ..., {worldSpace:
  true})`) is what disagrees with `export-binding.mjs` sidecars; the runtime
  driver reads the same sidecars correctly. Patch reverted; the rigger is
  unchanged. Yesterday's rpm-vs-Anny leg comparison in the rigger therefore
  rests on the in-page rebind for the rpm half and on whichever path won for
  the Anny half; the leakage RULER (from the sidecar bytes) and today's
  runtime render are the trustworthy evidence.
- Splat shipped as SH0 (22 MB, 336,220 splats, same order so the binding
  indices hold; client hash of the PLY = the md5 the API prefixes).
- For live: deploy backend_git main (acc3d15+fc18435) with
  `deploy_to_live.sh`, then `node scripts/upload_splat_avatar.mjs --api
  https://api-live.arrival.space/api/v1 --ply ... --binding ... --glb ...
  --fit ... --thumb ... --assign` with the live API key, or the MCP tool
  from here (files via upload_binary_file / upload_file_from_url; the 22 MB
  PLY is fine from a URL).

## 2026-09-12b (overnight: a rigged body model as the binding surface)

User: fit a surface model that is itself rigged, then align the bones to it -
better than the bone-only way; no SMPL licence available; "what you can
achieve over night".

- **Alternatives to SMPL, verified**: Anny (Naver Labs Europe, 2025,
  **Apache-2.0**, `pip install anny`): MakeHuman-based, differentiable in
  PyTorch, all ages, 6 phenotypes (gender, age, muscle, weight, height,
  proportions), a `game_engine` rig (53 bones, Unreal naming: pelvis,
  spine_01..03, clavicle/upperarm/lowerarm/hand, thigh/calf/foot/ball, neck_01,
  head) that maps one-to-one onto rpm_std, LBS weights, a COCO keypoint
  regressor with heels and toes. Z-up, metres, 13,718 verts. Also MHR (Meta,
  Nov 2025, Apache-2.0, 45 shape params, Momentum solvers; SAM 3D Body outputs
  MHR params from one image) - not tried tonight. Both are what SMPL was for,
  without the licence.
- **Fitter** (`client_git/splat-rigger/tools/anny_fit.py`): stage 1 fits
  shape + per-bone pose + global similarity to the triangulated landmarks
  (Huber 5 cm, per-landmark confidence from view count; cosine lr); stage 2
  a one-sided Chamfer from 4k model vertices to 12k opaque splat centres
  pulls the surface onto her actual body. First run plateaued at 3.8 cm with
  phenotypes stuck at 0.5 - my priors (pose 0.02, phenotype 0.05) were too
  strong; at 0.003 each: landmark residual 2.6 cm, surface rms 2.8 cm,
  height 0.60, gender 0.56. ~30 s on CPU.
- **Two mapping traps, both caught by the numbers**: (1) markers by bone
  NAME gave Spine 0.65x and Head 2.23x stretches - Anny's spine_03 and head
  sit at different heights than rpm's Spine2/Head; torso and head markers now
  by rpm proportion along the fitted chain, limbs one-to-one -> stretches
  **0.94-1.08**, the tightest fit so far. (2) The first surface binding put 70 %
  of the LEFT leg's splats on RIGHT-leg joints: not a mirror (arms were right)
  but `autofit.mjs` symmetrising the markers while the fitted surface kept
  her swayed pose - rig and surface one leg-width apart on one side. Body-model
  markers run with `--asym`.
- **`export-binding.mjs --surface`**: bind against the fitted surface; Anny
  bones -> rpm_std joints by name (fingers fold into the hand), top-4 weights,
  recomputed normals; sidecar format and runtime unchanged. Binding **2.2 cm
  mean, 0 far** (rig mesh: 4.1 cm).
- **Leakage ruler** (from the sidecar itself: for each leg's splats, the
  weight carried by the OTHER leg's joints): rig mesh **3.34 % / 0.59 %**,
  fitted body **0.31 % / 0.02 %**. On the Walk clip the trailing-leg smear is
  gone (cmp_legs.jpg, same animation times via `?bin=`).
- Owed: symmetry prior inside the fitter (instead of none/asym); hands
  (Anny has finger bones; MediaPipe has hand landmarks); the arm-to-torso
  weights where the arm hangs against the body (still the capture's A-pose
  problem); export the fitted body as the avatar's shadow/collision mesh;
  try MHR for comparison.

## 2026-09-12 (the rig fits itself: markers from the capture's cameras)

User: "now the hard part" - automate the rigger fit (hands, feet, the lot); the
existing auto-fit is a bounding-box guess (height -> scale, median XZ + min Y
-> position, a 90-degree yaw if deeper than wide) and everything else is
dragged by hand in Line up / fine-tune.

- **The asset the manual flow never had**: 186 solved cameras for the same
  body. So: MediaPipe PoseLandmarker (33 landmarks incl. heels and toes, 0.03
  s/frame CPU) on every registered frame -> triangulate each landmark across
  the cameras (DLT, then re-solved without views whose reprojection error is
  above max(3 px, 2x median); >= 4 views) -> the rigger's fifteen markers ->
  its own `solveFit` (align-solver.js, with bone stretch) -> fit JSON that
  `index.html?fit=` opens and `export-binding.mjs` binds. Tools live in
  `client_git/splat-rigger/tools/autofit_markers.py` + `autofit.mjs`
  (client_git 82feec163).
- **Frames**: the recon's PLY frame is Y-down (head at small y - confirmed on
  the splat's own width-per-slice profile and camera heights); the rigger
  flips 180deg about X and applies `splatRotation` on top; the same R is
  applied to the markers, so markers and splat stay self-consistent whatever
  the yaw. Fit `markers` are stored fit-local, (m - p)/s, like
  AlignMode._localMarkers.
- Lisa: 118/186 frames had a full-body detection (close-ups do not); every
  landmark triangulated, medians 1.6-8.6 px at feature scale (hips worst -
  she sways).
- **First fit**: scale 0.978, binding **2.4 cm mean, 0 far** - the rig lands
  on the splat everywhere - and it walks. Two tells in the stretch factors:
  Head 1.53 (the ear midpoint sits ~0.23 above the rig's Head joint, which is
  the top of the neck) and LeftArm 0.87 vs RightArm 1.19 (sway + far-side
  landmark error, not a body).
- **Fixes**: Head marker = shoulder line + 0.59 x (ears - shoulder line), the
  rig's own proportion; markers symmetrised across the sagittal plane
  (average of left and mirrored right; --asym to keep raw). The symmetry step
  exposed a **yaw sign bug**: rotY maps angle a to a - yaw, I had yaw = pi - a
  instead of a - pi, so the body was not facing +Z and the mirror plane
  crushed the clavicles to 0.48 (binding 5.8 cm, 5,143 far). The first fit had
  survived the same bug only because splat and markers get the same rotation.
  Now asserted: the shoulder line must land on -X or the tool exits.
- **Result**: scale 0.911 (1.70 m rig), all stretches 0.85-1.12, symmetric,
  marker residuals ~0 (worst Spine2 2 mm), binding **4.1 cm mean, 0 far**
  (the symmetric pose is a compromise between two swayed sides, hence > 2.4),
  walks squarely toward the camera on the standard clip.
- Visible left: trailing-leg smear mid-stride - weights leaking between legs
  that stand close together (nearest-triangle transfer), the rigger's known
  weakness, and the `Legs` bone bias exists for it; not touched tonight.
- Owed: hands (MediaPipe has 21 hand landmarks per hand - a wrist-to-finger
  fit for the rig's hand bones); a per-marker confidence from the
  triangulation residual so the manual step can show which markers to trust;
  the same tool run from the Browser_3DGS app after training (the recon and
  frames are already there); leg-weight bias by default for masked avatars.

## 2026-09-11d (the cleared area needs a real target: random background)

User: still far too fuzzy; a scene-trained cut-out is sharper; "more punishment
for splats on the cleared area". Right on all three, and the third names the
mechanism: a scene-trained cut-out is sharp because every pixel outside the
subject has a REAL target (the wall), so a bulging splat is punished at full
photometric strength on its SCALE and POSITION. My coverage loss only pushed
opacity - the one channel that dies at saturation.

- **Checked the reference first** (user: "masking is a standard feature of
  LichtFeld, you can give it a transparent PNG"). It is, and it is the same
  three mechanisms: `MaskMode::Segment` = `weight * mean(alpha * (1-mask)^power)`
  with weight 1.0, power 2 (our covW, linear instead of BCE);
  `AlphaConsistent` = L1(alpha, mask) x 10 (our covS); `use_alpha_as_mask`
  reads the PNG alpha; `BackgroundMode::Random`. `mask_mode` defaults to None,
  so a transparent PNG does nothing there until a mode is picked.
- **Random background** (`randomBg`, default on for masked sets): each step
  draws a background colour, empty pixels take it as their target, the render
  composites onto it. A fixed colour is the curtain trap (an opaque splat of
  that colour scores as empty); a moving one cannot be matched, so the
  photometric loss shoves whatever is in the cleared area out through scale
  and position. What the wall does, without the wall.
- **BUG on the first run (v8/v9), and its diagnosis was wrong.** 22.8 dB. I
  blamed per-image exposure (the empty target must be gain*bg + bias, or a
  clean pixel keeps a residual the model removes by tinting) - a real bug,
  fixed, but NOT the cause: v9 with the fix scored the same 22.86. The
  black/white render pair said the background was CLEAN; the loss was in the
  subject. Lesson re-learned: look at the render before theorising.
- **Silhouette ruler, v9 (13 held-out views): IoU 0.937, halo 0.005, edge
  band 2.6 px** - halo 28x below the afternoon's best (0.124), edge 3.7x
  tighter, no offline prune at all. The fuzz is gone.
- **The cost**: subject PSNR 26.15 -> 21.8 on the offline ruler. Split by
  region (outer 6 px vs body core): edge band 22.2 -> 16.0 dB, core 27.0 ->
  23.5, interior coverage 0.98 -> 0.95, signed error -0.006 -> -0.02 (body
  rendered ~2% darker). Two mechanisms: (1) where the matte is a pixel tight
  or the subject MOVED between frames, an "empty" vote is now as strong as a
  "photo" vote and the optimiser erodes thin structure (hair, fingers) - the
  view inconsistency I flagged on day one, moved from "halo" to "eroded";
  (2) the random background leaks through the small residual translucency
  every splat surface has (T ~ 0.03 -> colours converge to photo - T*E[bg]),
  which is a ~1.5% darkening on black. Original 3DGS sidesteps (2) by
  evaluating on the training background.
- **Soft alpha-composited target** (v11, the RGBA convention of 3DGS and
  LichtFeld): frames keep the photo whole plus a Uint8 alpha; the kernel
  composites `alpha*photo + (1-alpha)*(gain*bg+bias)` every step, the SSIM
  pass the same. Correct, and no lever here: the trimap band it replaced was
  0.7% of pixels; v11 = v9 on every ruler. Kept because it is right.
- **Subject-side BCE (covS=1) is unusable**: `-1/O` blows up on subject
  pixels early in training - 9 min for 18k cycles, PSNR falling to 10, splats
  climbing. Killed. Left opt-in with a warning.
- **Guard ring** (`maskGuard`, default 3 px): empty pixels within 3 px OUTSIDE
  the matte get no loss - a ring that votes neither way, so honest matte /
  motion slop does not erode the edge while everything beyond it is still
  punished. v12: bench **22.90 -> 24.40 dB**, offline 21.86 -> 22.49, edge
  band 15.7 -> 17.1, signed error -0.021 -> -0.013; silhouette unchanged
  (IoU **0.939**, halo 0.007, edge 3.4 px). Strictly better; now the default.
- **Where it stands** (13 held-out views):

  | pipeline | offline PSNR | edge / core | IoU | halo | edge px |
  |---|---|---|---|---|---|
  | coverage loss + hull + offline prune (09-11c) | 26.15 | 22.2 / 27.0 | 0.886 | 0.124 | 9.96 |
  | + random background (v9) | 21.77 | 16.0 / 23.5 | 0.937 | 0.005 | 2.6 |
  | + soft alpha target (v11) | 21.86 | 15.7 / 24.0 | 0.935 | 0.005 | 3.3 |
  | **+ 3 px guard ring (v12)** | 22.49 | 17.1 / 24.0 | **0.939** | 0.007 | 3.4 |

  The user's read: the results look good. They do - the remaining loss is a
  subtly thinner outline on hair and fingers and a ~1.3% darkening, neither
  visible at viewing size, both real on the ruler.
- Owed: (1) evaluate/export with the leak in mind (a neutral background at
  eval, or push T -> 0 on the subject by a stable means - NOT the BCE);
  (2) the capture experiment, still - the erosion is view disagreement and a
  20 s clip attacks it at the source; (3) guard width A/B (2/3/5 px).

## 2026-09-11c (in-loop hull pruning — density control, the other half)

Owed from 09-11b: mask-driven pruning INSIDE refine, because an opacity loss
cannot remove a splat that has already saturated. Built it as a carved volume
rather than a per-view test, so the refine loop pays a lookup, not 186
projections.

- **`src/gs/hull.js`**: visual hull carved from the mask sentinels + solved
  cams. Only a view that SEES a voxel and calls it TGT_EMPTY votes to carve it;
  the matte's soft band abstains, so a fuzzy edge cannot erode the subject.
  `refine()` (legacy path, the default — it already reads params back to the
  CPU) treats anything outside as dead capacity, and the existing MCMC
  relocation recycles it onto the body. No kernel change, no new kill path.
- **Two bugs worth recording, both found by looking at one number (`% solid`):**
  1. Carving mid-loop on the RATIO killed voxels on partial counts — a voxel
     with two empty votes in its first eight views died even though it would
     finish at 2/186. Sound bound instead: carve once misses exceed what the
     FULL camera set could forgive.
  2. The bbox. `maskPoints` cannot remove a point lying along the viewing ray
     THROUGH the subject in every view, so the filtered cloud keeps a long tail
     of far stragglers: the 1-99 percentile box came out **20 x 9 x 24 units**
     and the person was 0.1 % of it. Median +/- 4*MAD finds the actual body
     (0.56 x 1.75 x 0.55). The hull now also filters the seed (2203 of 3607).
- **It works, and it is not enough.** Halo with NO offline prune at all:
  0.64 (no hull) -> **0.47** (hull, centre test) -> **0.39** (hull + footprint,
  six axis probes at 2 sigma). PSNR 30.69 -> **31.04 dB**. But the offline
  per-view prune still reaches 0.124: a visual hull is a strictly looser bound
  than the 186 silhouettes it was carved from, and the gap is that looseness.
- **Tightening it backfires**: keep 0.97 / res 160 carves the subject —
  seeds 835 points instead of 2203 and scores **29.46 dB**. keep 0.85 stays.
- Best measured today, 13 held-out views:

  | pipeline | PSNR | splats | IoU | halo | edge | interior |
  |---|---|---|---|---|---|---|
  | seed filter + covW 1 + prune 6/9 | 30.69 | 216,603 | **0.886** | **0.124** | 9.96 px | 0.976 |
  | + in-loop hull, no prune | 31.04 | 439,734 | 0.696 | 0.474 | 37.3 px | 0.998 |
  | **+ in-loop hull + prune 6/9** | **31.04** | 211,185 | 0.861 | 0.169 | 10.8 px | **0.984** |

  The hull's real wins are the model (+0.35 dB), the interior (0.984), and that
  the prune now removes 8 % instead of 10 %. It did NOT retire the prune.
- **Where the remaining fuzz actually lives**: interior coverage is ~1.0 and
  the halo concentrates on arms, hands and hair — the parts that MOVED during
  57 s of standing still. Views disagree about where she was, and no mask can
  fix a disagreement about where the subject IS; the optimiser averages it into
  a soft edge. Next lever is the capture, not the code: a 20 s clip, or the
  same clip cut to its steadiest 20 s window, scored on this same ruler.

## 2026-09-11b (sharper silhouette: what actually removes a background)

User: the silhouette is fuzzy. It was, and the first two fixes were wrong in
instructive ways. Researched the literature mid-session after the user pushed
back — the standard is a BCE on the rendered ACCUMULATED OPACITY against the
mask (Street Gaussians' sky loss, from UCNeRF; Object-Centric 2DGS calls it a
background / alpha-polarisation loss), not anything done to colour.

- **Why it was fuzzy**: masking only *excludes* background pixels, so the ring
  just outside the subject is unconstrained and splats bulge into it for free.
- **Trimap instead of a binary mask** (`frames.js`): >= 0.75 subject, <= 0.25
  known-empty, the 2 px between excluded. Measured band width vs thresholds:
  0.9/0.05 = 4.1 px, 0.75/0.25 = 2.1 px, 0.5/0.5 = 0. RVM's soft edge is ~4 px
  and re-matting at the correct downsample ratio (short side -> 512, not long)
  did NOT sharpen it (4.13 -> 4.42): the deep guided filter already refines at
  full res. The threshold is the lever, not the inference resolution.
- **FAILED, degenerate: targeting background to BLACK.** The renderer
  composites onto black, so "black here" looked like "nothing here" — but an
  opaque BLACK Gaussian scores exactly as well as empty space. The model
  painted a black curtain: invisible on black, obvious on white. Caught with a
  new trick worth keeping — render the same pose on black AND on white, then
  `C_white - C_black = T` gives exact per-pixel coverage (`?bg=` on
  render_views, `_camUniform` now takes a background). Silhouette IoU 0.37.
- **Implemented the real loss** (`makeRenderSrc` covW/covSubjW, target code
  `TGT_EMPTY = 128`): empty pixels get no colour target at all and contribute
  `dL/dO = 1/T`, which chains through `dO/da_k = T/(1-a_k)` to `covW/(1-a_k)`
  per splat. No colour satisfies it, only transparency. Compiled out entirely
  at covW 0, so every existing bench path is unchanged.
- **And it did not fix it, which is the real lesson.** Verified the targets
  reach the kernel (79.5 % mask-empty) and the sign/slot match opacityReg —
  yet covW 0.1, 3 and 10 all left the background fully opaque.
  `dalpha/d(logit opacity) = o(1-o)(...)` **vanishes as o -> 1**: a splat that
  has already saturated sits in the sigmoid's dead zone and NO opacity loss can
  bring it back. The published method governs what GROWS; it cannot rescue a
  converged opaque scene. covW 10 was worse than covW 1 (halo 0.76 vs 0.64).
- **The actual root cause: we seed the thing we are deleting.** `maskPoints()`
  in session.js drops sparse-cloud points the masks put in empty space —
  **89 % of the Lisa cloud was room** (3,608 of 31,706 kept). Effects at 30k:
  subject PSNR **29.80 -> 30.69 dB**, splats 1.05M -> 453k, train **5.4 ->
  2.8 min**, black-render mean 0.23 -> 0.09. A small subject cloud also needs
  the seed clone cap lifted (24 -> 200 below 5k points; 468 points seeded only
  11.7k splats and cost ~2 dB).
- **Prune is now footprint-aware** (`prune_silhouette.py`): sample the splat's
  projected disc (centre + 8 rim points at 2 sigma), not just its centre — a
  flare CENTRED on the subject passed the old point test.
- **Silhouette ruler** (`tests/bench/silhouette_score.py`, 13 held-out views,
  coverage from the black/white pair):

  | pipeline | IoU | halo 3-25px | edge band | interior |
  |---|---|---|---|---|
  | ignore-bg + centre prune (09-11a) | 0.856 | 0.196 | 16.3 px | 0.983 |
  | seed filter + covW 1 + footprint prune 8/9 | 0.871 | 0.052 | 9.7 px | 0.867 |
  | **seed filter + covW 1 + footprint prune 6/9** | **0.886** | 0.124 | 9.96 px | 0.976 |

  8/9 has the least halo but eats holes in the person (interior 0.867); 6/9 is
  the balance. Halo down 37 %, edge 1.6x sharper, IoU up, interior kept.
- Owed: mask-driven pruning INSIDE the refine loop — the density-control half
  the papers pair with the loss, and the only thing that can remove a splat the
  loss has already lost hold of. That should retire the offline prune entirely.

## 2026-09-11 (subject masking: person out of the room)

Direction (user): a decent splat avatar from a single photo. One photo needs a
generative prior and a GPU service; a 30 s orbit needs neither and is already
proven here (LisaAvatar 176/181, 29.8 dB, 09-08). What the repo has never had
is a concept of a SUBJECT — the trained model is a room with a person in it,
and the rigger would happily skin the filing cabinet. So: matte the person,
mask the loss, see what is left.

- **Dataset `data/lisa`** — LisaAvatar.mov re-materialised offline as a photo
  set: ffmpeg every frame at 900x1600, sharpest survivor of each 0.3 s window
  (9 frames) = 189 images, plus `masks/` from RobustVideoMatting (15 MB ONNX,
  CPU, 43 s for 189 frames, temporal recurrence). Subject covers 3.5–36.4 % of
  a frame, median 19.3 %; no matte failures. Registers **186/189 at rms 0.749**
  — better than the in-browser extraction's 176/181, so the offline prep is not
  the weak link. Bench set `lisa` (`list: true`), `?masks=1` attaches the mattes.
- **FAILED, and the lesson of the day: never hand the matte to the solver.**
  First attempt baked alpha into the PNGs. Canvas compositing premultiplies, so
  the FEATURE path read a cut-out on black and the room — the only textured
  thing in the frame — was gone before SIFT ran. **33/189 registered.** A person
  in dark clothing is the textureless part of their own photograph. Fix is
  structural: `frames.js` takes the mask as a SEPARATE per-file input
  (`{source, name, mask}`) applied to the training target only, never to the
  grayscale. Solve on everything, train on the subject. Registration then comes
  back bit-identical to the unmasked control (186/189, rms 0.749).
- **Masked loss alone is not isolation.** 30k, 189 frames, 80.6 % of pixels
  excluded: the person trains correctly, and the surroundings fill with giant
  smeared flares. Nothing says "there should be nothing here" any more — a
  splat outside the mask in every view is unconstrained, and one big enough to
  cover the subject everywhere is nearly free. opacityReg does starve most of
  them (**deadPct 67.6 %** vs 12.6 % on the control) but ~1000 survivors swamp
  the frame.
- **Silhouette prune fixes it** (`tests/bench/prune_silhouette.py`, offline for
  now). Project every centre into all 186 cameras: keep it if ≥50 % of the views
  that see it call it subject (drops 16.7 %); then cap any axis at 4 % of the
  subject's own diagonal (6.9 cm on a 1.73 m body — drops 1,111 more). Result:
  **281,192 splats, a person alone on black**, 227 MB → 69 MB.
- **Numbers, subject pixels only, 13 held-out views** (both models rendered
  from the same solved poses, scored only inside the matte — the bench's
  whole-frame PSNRs, 28.61 control vs 29.80 masked, are NOT comparable):
  control **24.24 dB** aggregate / 25.47 per-view mean; masked+pruned **26.15 /
  28.58**. Isolation is not a quality tax — the budget and the cycles stop
  going to the carpet. Control 915,388 live splats vs 281,192.
- **New tooling**: `tests/bench/render_views.{html,js}` — headless novel-view
  renderer (posted .ply + recon → PNGs from chosen training poses), which is
  what made the comparison possible at all.
- Owed: prune inside the refine loop (the capacity those flares ate should go
  back to the body); a human preset (SH 0, ~100k cap — the rigger's reference
  scan is 60,744 splats); floor plane + stated height for metres/ground/facing;
  and a 20 s capture A/B, because 57 s of standing still is breathing and sway
  that the optimiser can only average into blur.

## 2026-09-09 (speed plan #0–#3/#6 implemented; 30-minute row)

- **Solve tiers** (user: training takes 2 min on default, the solve 10 — "more
  settings for draft and standard, not just for training, also for sfm").
  `SOLVE_TIERS` in src/sfm/sfm.js: quick = 3900 feats / octave 0 / no aspect
  (the pre-09-04 defaults, ~4 min truck solve), standard = 8000 / octave 0 /
  no aspect (provisional middle), precise = 8000 / octave −1 / aspect (the
  09-04 desktop defaults, ~12 min, the README numbers). App: a "Camera solve"
  row in the gear, settings key `solve`, quality macros Draft → quick,
  Standard → the device default (desktop standard, phone quick), High and
  Showcase → precise. Bench `?solve=` (tag `_sv<tier>`); the bench default
  stays precise. `opts.focalScales` narrows the focal search (for an EXIF
  prior later). Committed, NOT deployed: the tier benchmark
  (scratch/sfm_bench/cells_sfm_bench.json: each tier solved fresh + 30k) and
  the COLMAP run decide the standard tier's values first — the GPU is busy
  with the user's own solve right now.
- **Solve-tier benchmark run** (GPU idle, fresh solves + 30k, seed 1; table in
  docs/bench-sfm-colmap-2026-09-09.md): quick 3.6 min → 25.51; "8000 at
  octave 0" 3.5 min → **25.42 (worse than 3900)**; precise 10.8 min → 25.86;
  precise without aspect 10.6 → 25.72; 5000 feats octave −1 11.1 → 25.84. The
  quality is the upsampled octave (+ aspect 0.14), not the feature count; the
  time is the final registration pass: 40 interim global BAs = 270 s of 430 s
  (96 k points / 514 k obs at octave −1 vs 25 k / 124 k). The provisional
  standard tier is withdrawn.
- **Making precise cheaper, three levers tried.** (1) Geometric interim-BA
  cadence (×1.15, COLMAP-style): 40 → 19 BAs, solve 10.8 → 6.9 min, but the
  chain DIVED (rms 22.7 px before the last BA, ATE 1.77 %, 21.9 dB) — reverted
  to every 6 (`interimBARatio` stays opt-in). (2) Per-pair RANSAC in a worker
  pool (`pairworker.js`): pair geometry 86 → 44 s; the fixed-cadence control
  ALSO bent (ATE 1.36 %, 21.5 dB) — not the workers: the per-pair seeds gave
  pair 6+199 (3.7° median parallax) 1126 inliers vs 1028 for 8+198 (11.7°),
  and the init score capped the parallax bonus at 3.4°, so the low-parallax
  pair won and everything after it was bent (rms 7.4 → 4.1 at 12 cams, half
  the points). **Init fix**: cap raised to 0.2 rad, prefer ≥ 5° pairs when any
  exist. The inline-RANSAC A/B on the same code reproduced 25.82. (3) Interim
  BA on a 25 k-point subsample (`interimBAMaxPoints`): harmless in the A/B
  (25.82), time effect being measured with the fix.
- **COLMAP CPU run**: the exhaustive matcher exited after 2 of 36 blocks with no
  error line (mapper then registered 50/251 in 17 s); matcher rerun pending
  after the web cells (CPU contention). Script pitfalls fixed on the way:
  `$args` as a parameter name (PowerShell's automatic variable → colmap ran
  with no arguments), and `2>&1` on a native exe under `Stop` (colmap's
  stderr warning became a terminating error).
- **Init fix verified, precise made cheap**: with the fix the worker path picks
  8+198 (12.3°) again — 7.8 min / 25.93 on 25 k-point interim BAs, 10.1 min /
  25.88 on all points, **7.0 min / 26.03 on 10 k points** (interim BA sum 268
  → 129 → 78 s). Shipped: interimBAMaxPoints 10000, worker RANSAC, init fix;
  Standard/High/Showcase presets solve with the precise recipe (7 min), Draft
  with quick (3.6 min); the gear row offers Quick / Standard. README solve
  claims updated (12 → 7 minutes).
- **COLMAP result**: 4.1.1 CPU build (3.11.1's CPU matcher crashes) — features
  6 s, exhaustive matching 501 s, mapper 147 s = **10.9 min**, 251/251, ATE
  0.00 %. Splat.js Standard: 7.0 min at the same accuracy; our GPU matcher
  23 s vs their CPU 501 s, their mapper 147 s vs our focal search + final
  316 s. The focal search is the gap (COLMAP reads EXIF); CUDA COLMAP not
  measured. Table in docs/bench-sfm-colmap-2026-09-09.md.

## 2026-09-11 (video review card; own WebCodecs decode loop)

- **Review card** (user: "a UI that helps understand what the video frame
  selector does … the user may change the timeframe"). The extractor gained
  a `review(ctx)` hook between scan and capture and scan-time thumbnails
  (`thumbs`, ≤ 360 at 96 px); `planSelection(frames, opts, range)` re-runs
  the selection on a time range (pure, instant) and `suggestSpan` picks, for
  a long video, the span the device cap covers at natural density where the
  footage is sharpest. The app draws the timeline (focus curve normalised
  to its 95th percentile, blur dips, cuts, picks lane), a draggable range
  (ends or slide), a filmstrip of picks spread over the range, and a
  readout (frames, span, per second). On phones it is a fullscreen sheet.
  e2e video-smoke clicks `#vid-use`; `window.__splat.videoReview/videoPlan`
  expose the state.
- **Half a video silently lost** (skulli.mp4 from the QA folder, 1080p,
  4628 packets tagged 50 fps): it is a 25p field-coded stream (two packets
  per picture). The decoder emits 2314 frames with correct timestamps
  (ffmpeg: 2312), but Mediabunny's sample/canvas sinks restamp outputs
  sequentially from the packet list, so the take "ended" at 46 of 93 s and
  the second half was never scanned. Both passes now drive WebCodecs
  directly (EncodedPacketSink → VideoDecoder, container rotation applied
  in drawImage; capture = one continuous decode from the key packet before
  the first winner, matched by timestamp within half a frame). Lesson from
  the first cut: output frames are hardware-backed and few — close them
  from the output callback (a pump), never hold them until the next packet,
  or flush() deadlocks (camping.mov hung at 992/1014 with 22 frames open).
  camping.mov: scan + 145-frame capture 8.6 s; LisaAvatar (4K portrait,
  rotated 90°) upright, 2160×3840; skulli now 2314 frames over 92.5 s.
- Frame floor clamped to the cap (a cap below 24 used to re-widen the
  selection past it).

## 2026-09-10 (video: camping.mov through the extractor; density beats sharpness)

- **The ask**: run the original camping.mov (1920x1080, 29.97 fps, 1014 frames,
  33.8 s, iPhone walk) through the current extractor and see what it picks.
  Default extraction: **59 frames (1.7/s)**, 4 blur dips, motion proxy reads
  ~10 %/s on this walk so the 10 % budget and the 1.0 s ceiling coincide;
  picks cluster in the fast pans (4-6/s at 13-15 s and 27-29 s), 1/s
  elsewhere. Solve 59/59, 0.57 px, 0.9 min. The server set (113 frames,
  3.33/s) is every 9th video frame from frame 1 (matched by SAD at 96x54).
- **First ruler was wrong twice.** eval8 on each extraction's own frames:
  59 → 22.19, 77 (0.5 s ceiling) → 26.56, 95 (0.35 s) → 24.02, server 113 →
  25.54. Not comparable — different held-out photos per set. Second ruler
  (`?vidhold=` the server set's 15 held-out timestamps forced into every
  extraction, `evalFrames` on the Session): 22.97 / 27.07 / 26.62 / uniform
  3.33 fps 27.96 / 0.25 s 28.22 — inflated, the extractor puts a training
  frame 1-4 video frames from each test frame (min 0.02 s, median 0.11-0.18 s)
  where the server set's nearest neighbour is 0.3 s. Third ruler adds
  `?vidholdexcl=0.3` (no pick within 0.3 s of a test frame; both neighbours
  gone, so the hole is 0.6 s vs the server set's 0.3 s — our variants are
  handicapped against the 25.54 reference, but comparable to each other):

  | extraction (30k, standard solve, same 15 test photos) | train frames | solve | PSNR |
  |---|---:|---:|---:|
  | default (1.0 s ceiling) | 43 | 1.1 min | 22.76 |
  | 0.5 s ceiling | 55 | 2.0 | 22.63 |
  | uniform 3.33 fps, no scoring (control) | 76 | 2.4 | 23.87 |
  | 0.35 s ceiling | 72 | 2.2 | 24.06 |
  | 0.25 s ceiling | 88 | 2.0 | 25.30 |
  | 0.2 s ceiling | 101 | 2.5 | 23.88 |
  | 0.15 s ceiling (= the window floor) | 126 | 3.0 | 24.68 |
  | server set (neighbours at 0.3 s, favoured) | 98 | 2.4 | 25.54 |

  Every solve registered every frame (rms 0.52-0.59 px). The forward-walk
  lesson from charleston holds on a real phone walk: the motion proxy under-
  reads a walk (2-10 %/s), so the time ceiling paces it, and 1.0 s is far
  too sparse. Sharpness selection at equal count is worth ~+0.2 dB over
  uniform (noise band). Picks-per-second is the lever; single-seed cells on
  15 test photos scatter ±0.7 dB (0.2 s < 0.35 s < 0.15 s < 0.25 s is not a
  curve), so the read is "≥ 3/s on a walk", not a sharp optimum.
- **Default changed**: `maxGapSec` 1.0 → 0.25 (a walk yields ≥ 4/s;
  orbits already close windows by motion and are unaffected — LisaAvatar
  closed at 3.2/s by motion). Device cap widens the budget as before.
- Bench: `?vidmaxgap=`, `?vidpick=uniform&vidfps=`, `?vidhold=t,t,..&vidholdexcl=s`;
  Session `evalFrames` (named test set). Unit test 7 covers forced/uniform.

## 2026-09-10 (EXIF focal prior)

- **EXIF focal prior** (user: phone run "worked well"; next lever was the
  four-candidate focal search). `src/io/exif.js` reads the 35 mm-equivalent
  focal (JPEG APP1, HEIF/HEIC meta item), `decodeFrames` attaches it per frame,
  `session.solve` turns an agreeing set (≥ 60 % of photos, spread ≤ 10 %) into
  `focalPrior` = f35 · diagonal / 43.27 at the feature frame, and the solver
  registers at the prior first, keeping the search as the fallback when the
  prior registers < 60 % of the images. Statue (34 iPhone 14 Pro photos, 24 mm
  → 665.6 px at 720 px): prior 23/34, **19.62 dB** at 30k vs the search's
  23/34, **17.44** — the search's retry pass had picked 0.96× (24 % off the
  true 0.77×). Solve time unchanged on 34 photos (0.3 min either way); on a
  250-photo set the prior saves the ~80 s search. Truck (no EXIF) unaffected.
  Unit test `tests/unit/test_exif.mjs` (synthetic JPEG + the statue files);
  bench `?exiffocal=0` opts out. In-app camera captures carry no EXIF (canvas
  JPEGs) — a focal from the camera track is not available; library picks do.
- **Focal search anchored on lenses + edge bracket** (user: "why not have
  typical focal lengths ready, iPhone 1x, 0.5x"). The statue logs showed the
  true focal (0.69 × long side, a 24 mm phone lens) sat 12 % below the old
  grid's lowest candidate and BA did not follow (f moved 0.02 %). Grid now
  0.575 / 0.65 / 0.8 / 1.0 / 1.16 / 1.3 (24, 28, 33, 40, 48, 54 mm); when the
  winner is an edge candidate the search steps outward by 12 % while the
  camera count holds and the pixel median falls (≤ 5 steps: reaches 0.5×
  ultra-wide and 3× tele). Truck quick: search 0.69x → bracket 0.62x
  (251/251, median 0.48 px; truth 0.59x), solve 3.6 → 3.9 min, 25.38 dB vs
  25.51 (noise). Statue without EXIF: grid picks 0.69x directly. Correction to
  the EXIF entry: the three statue solves (search 0.78x, prior, grid 0.69x)
  are geometrically the same — same 23 cameras, same init pair, f moved
  0.02 % in all, k1 ≈ 0.10 — so the 17.4 / 19.6 / 17.9 dB spread is training
  and held-out noise on 3 held-out photos, not the focal; the statue is too
  small to grade focal choices by PSNR.
- **Statue showcase re-solved** (user: "we had huge quality issues with sky
  etc, could be explained with that"): Standard tier + EXIF focal (24 mm →
  665.6 px at the 720 px feature frame, prior accepted), 23/34 cameras, BA
  rms 0.72 px, 60k at 2400 px on all views in 10.7 min, 426 k splats →
  published `statue_ka_2026-09-10`. The 09-08 showcase had 30/34: its retry
  pass happened to seed from pair 29+30 (379 inliers, 11.5°); today that pair
  is not even an init candidate (shared-track ranking differs with the
  per-pair RANSAC seeds), and every candidate tried registers the same 23.
  Tried and kept as tools: init trials on sets ≤ 60 images (top-3 ranked
  pairs, cheap registration, best by camera count — `initTrials`), a named
  init pair (`initPair`, bench `?initpair=`), capture-order neighbours
  admitted to the init candidates (top-10 adjacent by shared tracks). None
  moved the statue past 23; the 4 flare images (IMG_0031–34) never register,
  the other 7 need a better track graph on this low-texture set — parked.
- **Focal search on a subsample** (user: "20 s more solve is not good, why?").
  Each candidate was a full no-BA registration of all images (5–25 s on
  truck-251); the search only ranks focals, so it now registers every k-th
  photo (≤ 48 images; rigs and sets ≤ 48 use all; falls back to all images if
  no candidate initialises on the subsample). Truck quick: six candidates +
  two bracket steps in ~3 s (was ~60 s), same winner 0.62x, solve 3.9 →
  **3.0 min**, 251/251, 25.49 dB. Camping (113 video frames, every 3rd):
  113/113 at 0.60 px, 1.2 min. Synthetic unchanged. `searchSubset: false`
  (bench `?searchsub=0`) opts out.
- **Incident**: the tier-decision edits (Standard = precise recipe, interim BA
  10 k, High/Showcase → standard, gear row without Precise) were made, then
  wiped by the `git checkout c050cef -- src app` / `git checkout HEAD -- src app`
  used to A/B the resume spec — HEAD did not hold them. Commit edee212 carried
  only docs + the session fix while its message claimed the tiers; live
  Standard therefore ran "8000 at octave 0" (the withdrawn tier) until the
  Standard-tier re-measure showed quick-tier feature counts (1074/image,
  13.8 s). Restored and committed (acab64b); rule in memory: commit or stash
  before any checkout-based A/B, and write commit messages from the diff.
- **Standard tier re-measured with the restored recipe + subsampled search**:
  SIFT 52.5 s (4513 feats/image, octave −1), pair geometry 50 s, focal search
  ~10 s on 42 images (bracket to 0.62x), final registration + BA 249 s →
  **6.0 min** (was 7.0 this morning, 10.8 yesterday), 251/251, ATE 0.00 %.
  README solve times: Standard 6 min, Quick 3 min.
- **30-minute row, first seed (needle default, 1.05 M, `evalmin=2`)**: 26.558 at
  120k cycles in 30.1 min, dead 33.8 % — above every published Truck number
  (SSS 26.41). The second seed loaded the freshly patched trainer mid-run and
  produced garbage (160k "cycles" in 72 s, no test PSNR): **never patch `src/`
  while a headless cell is running** — the bench page loads the working tree
  live. Both seeds rerun on the new code once it is verified.
- **Speed plan (docs/plan-webgpu-speed-2026-09-08.md) items 0, 1, 2, 3, 6
  implemented**: profiler counts production kernels only; camera/exposure
  gradients, refinement statistics (shared block 13 → 10 slots) and the robust
  vote compile out when their features are off; the shared sort runs the next
  power of two ≥ count and the profiler prints a tile-entry histogram; the
  conic normaliser is computed once in projection (`proj[12]`); Adam bias
  corrections come from the uniform. Bug on the way: a compiled-out buffer
  disappears from the `'auto'` pipeline layout → "binding index 8 not present
  in the bind group layout" → every dispatch dropped; fixed with a statically
  unreachable reference. Headless Chrome with `--enable-logging=stderr` was
  the tool that showed it.
- **Measured** (frozen models, 200 steps): truck 15.1 → **12.35 ms/step**
  (render 8.2 → 6.0, sort 1.9 → 1.7, chain 1.7 → 1.55); bicycle ≈ 8.9 →
  **6.85** (render 4.76 → 3.79, sort 1.3 → 0.47). Tile histogram: on truck 974 of
  2170 tiles exceed 2048 entries (max 20k) — the global bitonic path carries
  half the frame, so the small-tile sort fix is a bicycle win, not a truck one;
  a large-segment sorter and tighter binning (#5) are the next sort levers.
  Gradcheck passes on all rigs (bench `?gradcheck=1` mode added). Parity 30k
  same seed back to back: truck 25.74 new vs 25.89 old; garden 26.88 new vs
  26.75 reference — opposite signs. Same-day old/new pairs: seed 1 25.89 vs
  25.74 / 25.77, seed 2 25.78 vs 25.82 → two-seed means 25.83 vs 25.79.
  Then the seed-1 pattern persisted (lean 25.74/25.77 vs full 25.88/25.88;
  single toggles +stats 25.85, +camgrads 25.83) — and the refine logs showed
  why even same-code runs differ from the first refine: the refine trigger
  fires once per FRAME after an adaptive batch (~120 ms of GPU work), so
  kernel speed shifts refine iterations by tens of steps and the trajectories
  are chaotic at ±0.1. **Deterministic ruler**: bench `?ipf=15` pins the batch
  → runs repeat bit-for-bit (25.845 twice, identical refines); old code on the
  same ruler 25.807. The speed code is quality-neutral (+0.04); every A/B from
  now on pins the batch. Bench also gained `?usestats=1` / `?camgrads=1`.
  Deployed live 11:5xZ (83db5f6, overlay c4de0590e), pushed.
- **Plan #4 (refine data movement) and #5 (rectangular binning) in.** #4: the
  legacy refine downloads only the live rows of params; a `refine-patch`
  kernel applies the touched rows (params, moment reset, donor SH copy) —
  pinned parity 25.845 → 25.845 with byte-identical refinement logs. #5
  (opt-in `rectbin=1`): truck entries 5.07 M → 3.01 M per frame, big tiles
  974 → 330; bicycle 2.90 M → 1.08 M, step 6.85 → 5.91 ms on a SHARED GPU
  (the desktop session was active — every timing from this chain is
  contaminated: truck read 14.9 ms with chain/Adam slower too). Pinned parity
  seed 1: 25.816 vs 25.845 — the rectangle also decides frustum visibility,
  so a few edge splats change state and the trajectory diverges (seed 2:
  25.879 vs 25.923). Frustum test back on the circle → **25.845 exactly,
  refinement log byte-identical**: rectBin is a pure tile-list change and
  became the default (0cb3d67 + follow-up). Gradcheck passes with both. Idle
  GPU speed cells (truck/bicycle, and the per-refine wall time via
  `?postperf=`) still owed — the daytime chain ran on a shared GPU.
- **30-minute pair on the new code** (needle default, 1.05 M, `evalmin=2`, idle
  GPU): **26.468 / 26.638 at 126–127 k cycles in 30 min** → mean **26.55**, dead
  35 %. Curve (mean): 4 min 22.36, 8 24.54, 12 25.56, 16 26.22, 20 26.48, 24
  26.54, 28 26.58, 30 26.55 — flat from minute 24, above SSS (26.41) from
  minute 20. The old-code seed 1 earlier tonight read 26.558 at 120 k; the
  seed spread (0.17) is bigger than any code effect seen. README rebuilt
  around this run (user: "only train to 30 min should be enough to beat the
  papers", "a smoother table that shows how dB evolves"): the chart now
  follows the run (mean of two seeds, seed band), an 8-row evolution table sits
  under it, the comparison table keeps two Splat.js rows (10 min, 30 min); the
  Bar showcase link moved to v6. `scripts/readme_chart.mjs` takes the cells'
  status files and writes `docs/img/truck-curve.json` + both SVGs + the table.
## 2026-09-08 (video input v2: WebCodecs, sharp-frames metric, motion windows)

- **State of the art surveyed** (`docs/plan-video-2026-09-08.md`): Reflct Sharp
  Frames is the community standard — every frame via Mediabunny (WebCodecs),
  score = `normalized_laplacian_tenengrad_v1` (512-px gray, Gaussian 5×5 σ1,
  expm1(½ log1p LapVar + ½ log1p mean Sobel²)), selection best-N with a
  distribution term / batched (sharpest of 5) / local outlier removal (window
  15, sensitivity 60), iPhone HDR tone-mapped; capture guide: ≥ 10 fps, one
  frame per 0.5 s, ~80 % overlap. SLAM keyframing adds motion-based selection
  (covisibility / flow thresholds) — redundancy is the other half.
- **v2 extractor** (`src/io/video.js`, Mediabunny 1.55.7 vendored, MPL-2.0,
  660 KB ESM loaded lazily): decode every frame through `CanvasSink`, score
  with the sharp-frames hybrid metric + exposure stats + a motion proxy
  (median 4×4-block sub-pixel projection shift vs the previous frame, at
  256 px), local blur-dip removal, motion windows (close at 20 % of the width
  moved, bounded 0.15–1.0 s), sharpest survivor per window, device cap by
  widening windows; winners re-decoded at full size via `canvasesAtTimestamps`
  (no seeking) → JPEG q0.95. `<video>` path kept as fallback with the same
  scorer/selector. Bench `?set=video&video=/data/...` (+ `vidmode`, `vidmax`,
  `vidoverlap`, `postanalysis=`) runs extract → solve → train.
- **First smoke** (charleston.webm, 4K VP9 30 fps, 251 s, 7517 frames): every
  frame scored at ~90 fps, 1.9 min extraction; but the first motion proxy
  (integer shift of whole-frame projections at 128 px) read 0 on 90 % of the
  frames — a forward walk moves < 1 px/frame at that size — so windows closed
  on the 1.5 s cap only: 170 frames, 1.5 s apart, **37/170 registered**.
  Replaced by the block-flow proxy above; rerun queued behind a 502-frame
  server-extracted baseline solve of the same walk.
- **Rerun with block flow**: median measured motion 0.07 % of the width per frame
  (2 %/s — a forward walk barely shifts the image), so the 20 %-width budget
  never closes a window and the 1.0 s cap sets the pace: 249 frames, 1.0 s
  apart, **114/249 registered** (the relaxed-gate retry made it worse, 53, and
  was correctly discarded). Reading: the 80 %-overlap rule is an orbit rule;
  forward walks need parallax, i.e. time/distance density. Baseline queued:
  the 502-frame server extraction (2/s) of the same walk — at the bench's
  1600 px it OOMs the tab (2.9 GB of frames), rerun at 1088. App: video intake
  routed back to the extractor; e2e video-smoke (6 s clip from 180 truck
  photos → extract → solve → 500 cycles) passes with the full suite (8/8).
- **Density baseline**: the server's 502 frames (2/s) of the same walk register
  **306/502** (61 %) in a 50-min solve vs our 114/249 (46 %) at 1/s — density
  helps, but the incremental solver loses 40 % of a dense forward walk on its
  own. Two separate jobs: selection pace for walks (time/parallax, not
  overlap) and the solver on long sequences (where does the chain break —
  registered-run dump queued).
- **Correction — charleston is a drone montage, not a walk.** The registered
  runs (52–80, 85–99, 101–117, 182–208, 216–232, 240–248) are separate
  shots; the seam frames show hard cuts (80|81, 117|118, 181|182) and the
  neighbour pairs across them have hundreds of raw matches and 0 E-inliers.
  Neither density nor the solver was the story. Added to the extractor:
  shot-cut detection (frame difference > 0.12 and > 6× the rolling median),
  windows never span a cut, default keeps the longest shot (shots: all
  keeps every shot with a proportional cap; bench vidshots=all). Also added
  a registration retry for frames that failed against an early model (3
  rounds, support grown 1.5×) — no gain on charleston (montage), truck /
  statue probes pending.
- **Charleston's transitions are dissolves, not hard cuts**: the frame difference
  ramps 0.004 → 0.03 over ~1 s at each seam (max anywhere 0.037), so the
  spike detector sees one shot. Hard cuts are detected; cross-fades are a known
  gap (a sustained-diff-without-motion criterion would catch them). Low
  priority — phone captures are single takes. Registration retry: truck
  251/251 unchanged (no round triggered), statue 30/34 unchanged (one round,
  nothing new) — neutral and safe.
- **First real phone clip — `LisaAvatar.mov`** (iPhone HEVC, 4K portrait,
  rotation −90 metadata, 30 fps, 57 s, 1708 frames; an office, a person
  standing, the camera orbiting at arm's length and tilting head-to-feet).
  WebCodecs decoded HEVC in headless Chrome, rotation honoured, 1708 frames
  scored in 31 s; the motion proxy reads ~1 %/frame (an orbit, unlike the
  drone walk) so the 20 %-width budget paced picks at 0.57 s median → 96
  frames. Solve: **27/96 registered**, 1817 features/image (dark clothing,
  soft 30-fps frames, focus median 422 vs ~700 on charleston), 176 usable
  pairs for 96 frames, neighbour pairs at 30–72 % inlier ratios — many just
  under the 40 % gate (the probe ran with the relaxed retry OFF; the 30k
  cell has it on). Probes queued: 2× density (`vidoverlap=0.9`), features at
  1600 px, both. Chicago: 52 hard cuts detected, longest take 10 s → 17
  frames → no initialisation (correct; needs an app message).
- **Density is the lever on the phone orbit**: 2× frames (`vidoverlap=0.9`, 181
  frames at 0.3 s) → **176/181 registered** (from 27/96), rms 0.74, 587
  usable pairs. The relaxed-gate retry alone (176 → 224 pairs) changed
  nothing; the 30k on 96 frames read 12.4 dB. Default overlap → 0.9 (motion
  budget 10 % of the width); 30k training on the dense set queued.
- **Lisa, dense selection, 30k**: 181 frames (0.3 s), 176 registered, rms 0.74,
  **29.82 dB on 22 held-out frames**, 8.2 min training (from 12.4 dB on the
  96-frame set). Published `lisa_video_2026-09-08` (13.4 MB). Finer feature
  frames hurt again: 1600 px → 42/96 at 1.83 px alone, 128/181 at 1.34 px
  with density (vs 176/181 at 0.74 at 960 px) — same lesson as the statue,
  960 px stays. Charleston dropped from the evaluation (a zoom montage, not a
  capture, per the user).
- **Needle set revisited under the anneal-bound relocation** (user saw the
  ringing halos again on the synthetic corner — the 09-01 fix was a sticky
  opt-in, never the default, because it lost at 40k+). 30k with dilate 0.1 /
  anisoReg 0 / minScale 1e-5: truck **25.84** vs 25.70, garden 26.75 vs 26.72,
  synthetic **40.97** vs 40.38. The long-horizon degeneration was relocation
  churn, and that stops at the anneal end now. Queued: truck 40k, the hour
  curve, bicycle, playroom — if they hold, the needle set becomes the default.
  LichtFeld on the synthetic corner (MCMC 30k, GT cams, random init): needles
  everywhere per the user; rerun from our sparse cloud in progress.
- **Export bug found through the needle model**: the PLY bake of the Mip opacity
  compensation used a hardcoded 0.3 dilation and the mean of all three scales,
  so a needle-set export (dilate 0.1, thin axis) came out nearly transparent —
  "full of holes" in every viewer at 41 dB in the trainer. Bake now uses the
  run's dilation and the two largest axes (the 2-D Mip factor of the ellipse
  they span). Re-exports: synthetic needle 41.19, truck needle 25.88 vs 25.57
  default — user: "MUCH better". LichtFeld from our sparse cloud + cams on the
  12-view corner still shows needles/holes (its sparse-view behaviour).
- **Needle set becomes the default** (dilate 0.1, anisoReg 0, minScale 1e-5) after
  six guards: truck 30k 25.84 / 40k 26.12 / hour 26.59 (165k in a shared-GPU
  hour, plateau 26.5–26.64 from minute 37) vs 25.70 / 25.93 / 26.44; garden
  26.75 vs 26.72, bicycle 23.98 vs 23.82, playroom 27.73 vs 27.65, synthetic
  41.16 vs 40.41. README rows re-measured under the new default before deploy.

## 2026-09-08 (20-minute row; bar showcase night; statue set)

- **20-minute truck** (112k schedule, `minutes=20`, new defaults, idle GPU):
  **26.35 / 26.40** (seeds 1/2) at ~94k iterations, dead 26 %. Mean 26.38 —
  second in the README table, tied with SSS 26.41 inside the noise band, 0.25
  above LichtFeld/Brush at their default 30k. Row goes into the README with the
  next deploy (the anneal cap and relocation stop are not live yet).
- **Statue KA** (user's set, 34 photos 8064×6048, EXIF orientation 6 on all;
  `data/statue_ka`, bench `set=statue`). Registration probes (solve only):

  | solver | registered | rms px |
  |---|---|---|
  | desktop default (960 px feature frame, 8000, octave −1, aspect) | **19 / 34** | 0.71 |
  | old solver (3900, octave 0) | 15 | 0.70 |
  | 16000 feats @960 | 19 | 0.71 (identical — budget not binding) |
  | featres 2400 | 7 | — |
  | featres 2400 + peak 0.5 | 7 | — |
  | featres 2400 + 16000 | 14 | 3.43 |
  | featres 2400 + 16000 + peak 0.5 | 4 | — |
  | featres 3200 + 16000 (MAXF → 32768) | 8 | 4.26 |

  Finer feature frames make registration WORSE on this set (the opposite of
  camping's 720 → 960 gain) and the few registrations they get are bad (3–4
  px). Suspects: fixed pixel thresholds in matching / registration that
  tighten in angle as the feature frame grows; or a genuinely wide-baseline
  walk-around where 34 photos leave gaps no feature setting can bridge. Next:
  dump the registered subset (`postrecon`) to see whether the failures are one
  contiguous arc, and probe 1200 px.
- **Statue, root cause and fix.** The solver log (new `?sfmlog=1`, plus per-frame
  connectivity and rejected-neighbour lines in the log) showed the detector
  finds only ~2.5k features per image (white marble, plinth, gravel, sky) and
  the pair gate — E-inliers ≥ 40 % of raw matches — was throwing away real
  pairs: a 2400 px probe had a pair with 304 inliers of 2057 raw (15 %) and
  lost it; that is why finer feature frames registered FEWER images. Scaling
  the fixed pixel tolerances (6 px triangulation, 4 px guided radius, 2.5 px LK,
  1.5 px Huber) with the frame changed nothing (7/34 at 2400 either way) —
  the tolerances were not the limiter. New gate: ratio ≥ 40 % OR ≥ 100
  absolute inliers, and neighbours in capture order (|i−j| ≤ 2) pass at 15.

  | rule | registered | rms |
  |---|---|---|
  | ratio only (old) | 19 / 34 | 0.71 |
  | + absolute 100 | 19 (960) · 18 (1600, was 6) | 0.71 / 1.35 |
  | + absolute 40 | 21 | 0.72 |
  | + neighbour 15 (new default) | **24 / 34** | 0.70 |

  The remaining 10 (0031–0040) form an island: connected among themselves,
  no neighbour pair to the main component clears 15 inliers — the backlit,
  flare-heavy side of the walk-around. Truck/garden fresh-solve guards for
  the new gate are running; a per-pair dump of the rejected neighbour links
  follows to see how far below 15 the bridge sits.
- **Gate as a default: rejected; gate as a retry: shipped.** Truck fresh solves
  under the absolute-100 default registered 250/251 at rms 0.62 (reproducible
  in two solve-only reruns) and trained to 22.67 vs 25.72 (gate 40, 251/251)
  and 25.71 (old rule, 251/251, 96k points vs 88k): the extra pairs re-route
  the incremental reconstruction and cost a camera and 8 % of the points.
  Garden with the same gate: 26.75, 185/185 — truck-specific path fragility.
  New design (`runSfM` wraps `runSfMOnce`): first pass with the ratio rule;
  if registration < 70 % and no rigs, retry with features cached and the
  absolute gates (100 / neighbours 15, never same-rig faces), keep the pass
  with more cameras. `sfm.pairRelax = false` (bench `?relax=0`) disables it.
  Rejected-neighbour log on the statue: the 0030↔0031 bridge has 29 raw
  matches and 0 inliers, 0039↔0040 218 raw / 0 inliers — pure-rotation or
  flare pairs no gate can rescue; the island stays.
- **Registration depends on the training resolution (bug).** The statue showcase
  run at `res=2400` registered 20/34 where the same solver settings at 1600
  gave 30/34: the feature frame is downsampled from the decode-to-target
  intermediate (2 × max(featMaxDim, trainMaxDim)), so a different training
  resolution changes the feature pixels and the incremental path. The
  showcase was rerun on the frozen 30-camera recon (`gtrecon`). Fix to make:
  derive the feature frame from a resolution-independent intermediate.
- **Statue showcase published**: frozen 30-camera recon, all 30 views trained,
  2400 px, 60k iterations, 487k splats (dead 2 %), 36 min →
  `statue_ka_2026-09-08` (8.6 MB SOG). Held-out numbers from the 30k probes:
  18.17 (30 cams, 4 held out) / 17.03 (24 cams, 3 held out) — a 34-photo
  walk-around is far from dense; the showcase is for looking, not for the table.

- **Bar showcase night, findings so far.** The published `bar360_v5test` PLY
  (4 M rows, 372k iters, Aug trainer) has a median opacity of 3.3e-4: more
  than half its splats are invisible — the user's "doesn't look like 4 M" is
  literal. Overnight matrix at 100k, eval8: 1280 px faces OOM'd the feature
  worker (612 × 1280² frames > the tab's array-buffer budget) → 1024 px is the
  ceiling; the 912 px control gave 21.07 (vs 20.99 at 30k / 1.05 M) in 23 min
  with **dead 52 %** and n stuck at 1.78 M: the bench's `capMult 8` × 223k seed
  points caps the buffer below the 4 M asked for (`?capmult=20` from here on).
  Each refine relocates ~280k splats (16 % of n) with ~40 % survival — the
  360 rig kills splats far faster than truck; suspects: regs on rows invisible
  in the current face (`regVisOnly`), relocation to the end vs anneal-bound.
  Cells queued: 1024 px pair (res effect), then true-4M × {default, regVisOnly,
  relocate-to-end}; the showcase run (all views, 200k) follows the winner.
- **Bar at a true 4 M cap** (`capmult=20`, 912 px, 100k, eval8): 21.11 vs 21.07 at
  1.78 M — capacity buys +0.04. Dead at the end **75 %** (≈1 M live of 4 M);
  late refines relocate the 1 M ceiling every round with 33 % survival. The 360
  rig's economy kills splats that few faces see; more cap just makes more
  corpses. The `regVisOnly` and relocate-to-end cells decide whether weaker
  death pressure converts cap into live splats.
- **regVisOnly on the bar** (regs only on rows visible in the current face):
  20.74 vs 21.11, dead **6.6 %** vs 75 % (≈3.7 M live), 58 vs 45 min. The
  invisible-row regs were what killed three quarters of the model — and those
  kills were worth +0.37 dB on held-out faces (fewer floaters seen from
  elsewhere). Density vs fidelity trade for the showcase; weaker opacity reg
  (0.005 / 0.0025) cells queued to find the middle.
- **Relocate to the end on the bar** (4 M, 100k): 21.05 vs 21.11 (noise), dead
  **17.6 %** vs 75 % — ≈3.3 M live at equal fidelity, because dead rows keep
  being re-placed as jittered copies of well-supported splats (density near
  real structure, not floaters). For a showcase that is the better trade than
  regVisOnly (3.7 M live, −0.37). Bar recipe so far: 912 px (2 GB target
  limit), 4 M via `capmult=20`, `relocuntil=all`; opacity-reg cells pending.
- **Opacity reg ½ / ¼ on the bar**: 20.92 / 20.71 with dead 63 % / 50 % — worse
  than relocate-to-end on both axes; the matrix closes on: 912 px, 4 M
  (`capmult=20`), `relocuntil=all`. Showcase run (all 102 panos, 200k) launched
  ~06:50 after a name-order false start.
- **Bar showcase published** → `bar360_v6_2026-09-08` (44.9 MB SOG): all 102
  panos (588/612 faces registered, rig solve with the 09-07 octave clamp +
  intrinsics lock), 912 px, 4 M cap, relocation to the last step, 200k
  iterations in 83 min, dead 11.8 % at export (vs > 50 % invisible in v5test).
  Not swapped on the wall — the user decides.
- **Preset spaces re-stamped on live** (user: "if you have best in class also
  update the preset scenes on live with the correct desc and stats"; the
  09-08 approval lifts the 08-25 freeze for these three). Script
  `scripts/restamp_space.mjs <spaceId> <modelKey>` points the splat entity
  and the `splatjs` stamp (sog/recon/splats/iter/minutes/psnr) at a CDN model
  and rewrites the description; stats default to the model's recon.json,
  splats to the live SOG count. Truck `42485456_8883` → `truck_1h_v3_2026-09-06`
  (1,041,874 live splats, 200k, 56 min, 26.645 held-out; was the Aug 2 M /
  250k model at 26.30). Bar `42485456_4311` → `bar360_v6_2026-09-08`
  (3,517,115 live, 200k, 83 min, 20.47 on 48 held-out faces; was v5test with
  > 50 % invisible). Synthetic `42485456_9715` → `synthetic_needle_v2_2026-09-08`
  (160,945 live, 30k, 52.4 train / 41.2 on the held-out view; was the
  Aug 132.7k model at 49.5 train). Gallery feed verified. The cards now read
  held-out dB where the run had one; the intro camera paths were not re-recorded.
- **20-minute row re-measured on the idle GPU** (needle default, 1.05 M cap,
  `minutes=20`, two seeds): **26.419 / 26.405** at 72.6 k / 74.3 k cycles →
  README row "20 min · 73 k · 1.05 M · 26.41 dB" (the shared-GPU attempt had
  read 25.68 / 24.79 at half pace and was discarded). Same wall time now buys
  fewer cycles than the 09-07 default (95 k) — the thin-splat set costs more per
  step — and +0.03 dB.
- **Needle-default hour export on the idle GPU** (`sig5`, 200k, 1.05 M, our
  poses, postply): 200k in **43.7 min → 26.487**; curve 22 min 26.42, 29 min
  26.53, 33 min **26.58**, then 26.52 / 26.51 / 26.49 to the end. Below the
  published truck_1h_v3 (26.645, old schedule, 56 min) and the README's shared-GPU
  165 k reading (26.59) — inside the ±0.1 run noise, but the last 40 k cycles
  lose ~0.1 consistently (also on 09-07: 26.44 at the end vs higher mid-curve).
  Not published; the Truck space keeps v3. README 60-min row kept at 26.59 with
  a note giving the idle full-schedule number and the 26.4–26.6 band. Open
  question for the schedule: why the tail after the anneal end loses 0.1 —
  candidates are the fixed floor LR (0.01×) still moving positions with the MCMC
  noise on, or SH/opacity overfitting the train views once relocation stops.
- **README chart** (user: "so many splat.js entries"): `scripts/readme_chart.mjs`
  writes `docs/img/truck-psnr-vs-time-{light,dark}.svg` — held-out PSNR against
  training minutes, Splat.js budget points (6/10/20/60 min) as one curve,
  LichtFeld and Brush as marks at their measured times, the papers as dashed
  levels; GitHub picks the variant via `<picture prefers-color-scheme>`. The
  table keeps two Splat.js rows (10 min, 60 min); the 6- and 20-minute rows
  moved into the chart. Numbers unchanged, so no deploy — README pushed.

## 2026-09-07 (the same hour for LichtFeld and Brush; dB-over-time diagram)

- **Native trainers given the same hour** (truck, 979 px, eval8, COLMAP poses,
  RTX 5080; logs `C:\Dev\Lichtfeld\runs\truck-60min-mcmc`, `C:\Dev\brush\runs\truck-60min-head`):

  | trainer | schedule | final | wall-clock |
  |---|---|---|---|
  | LichtFeld MCMC, 2 M | 320k, refine window scaled ×10.7 | **26.42** | 51 min |
  | LichtFeld MCMC, 2 M (08-25) | default 30k | 26.14 | 5½ min |
  | Brush HEAD, 2 M | 150k (its LR schedule stretches, growth stops at 15k) | 25.83 (peak 25.91 @135k) | 64 min |
  | Brush HEAD, 2 M (09-02) | default 30k | 26.14 | 12 min |
  | Splat.js, 1.05 M, our poses | 200k | **26.65** | 56 min |

  LichtFeld converts the hour into +0.28 and flattens after 40 min (26.34 →
  26.42 over the last ten). Brush does not: with 150k total its mean LR decays
  five times slower, so at 30k it sits at 25.70 (vs 26.14 on the 30k
  schedule) and never recovers — "Brush given an hour" with defaults is
  worse than Brush at 12 minutes. Ours: 26.65 at 56 min. First LF attempt
  ran at `-r 2` = 489 px (the T&T images on disk are already 979 px) and was
  killed at 2 min; the eval smoke had shown 219/32 cameras and the PSNR log
  format. Bench gained `?evalmin=N` (held-out curve, train-only clock) for the
  dB-over-time diagram.
- **Splat.js hour curve** (same config + seed as the 26.645 signature, `?evalmin=2`):
  26.534 at 200k / 55.9 min — 0.11 below the published run with an identical
  seed: GPU atomics make repeated runs differ by ≈ ±0.1. The curve is slow
  early (20.6 @2 min, 23.2 @12 vs 25.7–26.1 for the native trainers at 12) and
  oscillates ±0.3 between evals late (relocation cycle), crossing LichtFeld
  around minute 30. Diagram published (claude.ai artifact "An Hour on Truck"):
  four curves + LichtFeld default 30k and the published run as marks,
  checkpoints 6/12/30/45 min, protocol notes (poses, undistortion, caps,
  Brush schedule, no Brush web build).

- **Why the Splat.js hour curve swings ±0.4 dB** (user question): relocation
  churn. Every 508 iterations the default relocates ~86k splats (8 % of 1.05 M)
  up to the last step (last refine @199,618, LR already ≈ 0), and only 62 % of
  the relocated survive the next round. Not a refine-phase sawtooth: evals
  right after a refine average the same as late-cycle evals (26.28 / 26.28).
  Tests (truck 30k s1/s2 vs 25.68/25.71; hour = 200k, 1.05 M, curve every 2 min):

  | knob | truck 30k | garden 30k | hour |
  |---|---|---|---|
  | default (relocate to the end) | 25.68 / 25.71 | 26.72 | 26.53 (curve run), 26.65 (published) |
  | `relocUntil` 85 % | 25.66 / 25.76 | — | **26.51**, tail flat (26.48–26.60 over the last 8 min) |
  | + `relocTaper` 0.5 (ceiling → 0 at 85 %) | 25.62 / 25.74, dead 16 % | 26.80, dead 1.8 % | — |

  Stopping late fixes the predictability of the endpoint, not the level; the
  swings before the stop are as large as ever (24.7 at min 37). Tapering the
  count leaves dead capacity unrelocated (16 % dead on truck) and is neutral.
  The lever is the 38 % immediate death rate of relocated splats (placement
  quality — the 09-02 ladder territory), not their number. Knobs stay opt-in
  (`?relocuntil=`, `?reloctaper=`).

- **Making the curve rise sooner** (user ask): the slow start is the schedule, not
  the trainer. The 100× position-LR decay ran over 0.75·H, so on the 200k hour
  schedule it still held 25 % of the base LR at minute 12 (the 30k schedule is
  at its 1 % floor there): 20.6 dB @6 min, 23.2 @12 vs 25.7–26.1 for the
  natives. New knobs `lrDecayFrac` / `lrDecayMax` (bench `?lrdecay=` / `?lrdecaymax=`):

  | decay length (truck, 200k hour, curve every 2 min) | @10 | @20 | @30 | final |
  |---|---|---|---|---|
  | 0.75·H = 150k (old default) | 22.9 | 24.4 | 26.1 | 26.53 |
  | 0.4·H = 80k | 24.8 | 26.26 | 26.45 | **26.61** |
  | 0.25·H = 50k | 26.05 | 25.9 | 26.1 | 26.52 |

  A fraction does not transfer to short runs: truck 30k 0.4·H (12k) 25.47 vs
  25.68, 0.25·H (7.5k) 25.38 / 25.34 vs 25.68 / 25.71; garden 30k 0.25·H 26.60,
  0.4·H 26.70 vs 26.72 — the anneal needs its ~22k iterations. **Default is now a cap: decay over min(0.75·H, 80k)** — 30k
  and 40k schedules unchanged, the hour schedule anneals over 80k (the 26.61
  run). Minutes on the 0.4 run are ~5 % inflated (shared GPU). The relocation
  swings remain; a combined run (cap + `relocUntil` 85 %) is the next hour cell.

- **Combined hour: capped decay (default) + `relocUntil` 85 %** (truck 200k, curve):
  25.6 @10 min, 26.15 @14, 26.4 @20; after the stop at 170k the tail is flat
  (26.47 → 26.56) and the final lands at **26.52 in 44 min** — no end-of-run
  dip, in the 26.5–26.65 band. 44 min for 200k on a free GPU (the earlier
  56-min runs overlapped the user's work) means ~260k iterations fit the hour
  now; a 260k-schedule signature (`_ru221000_m60_ev2_sig`) with PLY/recon
  export is queued behind a garden `relocUntil` guard.

- **260k-schedule signature (v4 candidate): 26.46 in 58.8 min — not published.**
  More iterations under the 80k anneal did not pay: 200k → 26.52 / 26.61, 260k
  → 26.46 (tail 26.43–26.48 after the stop at 221k). Reading: with the LR at
  its floor from 80k on, every extra relocation round (80k → 221k = 141k floor
  iterations vs 90k in the 200k run) places splats that can no longer settle;
  the churn is the limiter again, not the budget. Garden `relocUntil` guard
  26.68 vs 26.72 (neutral, 5.2 vs 5.9 min). README keeps 26.65 (old schedule,
  published run); the new default's hour lands 26.5–26.6 with the early curve
  fixed. Next lever if pursued: fewer / better relocations after the anneal
  (survival 62 %), or a floor LR above 1 % while relocation is active.

- **Relocation stopped at 50 % (100k of 200k), idle GPU**: 26.47 at 200k in
  **37.9 min**; the curve is smooth from minute 18 (26.37 → 26.45, no dip
  ≥ 0.1) and crosses the published top (26.41) at minute 24 for good. The
  level is within noise of the 85 % stop (26.52) — the second-half relocations
  bought nothing but swings, and skipping their refine read-backs saves ~6
  min per 100k iterations. Hypothesis for a default: relocate only while the
  LR anneals (`relocUntil` = anneal end = min(0.75·H, 80k)); guards queued
  (truck 30k ru22500 s1/s2, garden 30k) plus the hour at ru80000. User: the
  LichtFeld-hour value is not a target — nobody runs it that way; the bar is
  the published 26.41 and LF/Brush at their default 30k (26.14).

- **Default: relocate only while the LR anneals** (`relocUntil` = min(0.75·H, 80k);
  `?relocuntil=all` restores relocation to the last step). Guards: truck 30k
  25.69 / 25.68 vs 25.68 / 25.71 in 4.9 min (was 5.9); garden 30k 26.81 vs
  26.72; hour (stop at 80k) **26.44 at 200k in 35.5 min**, smooth from minute
  14, past the published 26.41 at minute 24 and holding. Level ladder at the
  hour: 26.52 (stop 85 %) → 26.47 (50 %) → 26.44 (anneal end) — a ~0.05 cost
  per step, inside noise individually, for a curve that reads and a run that
  is 20–35 % shorter (no refine read-backs after the stop).
- **Dead capacity is a third of the model.** Without late relocation the dead
  census at the end shows what the churn was hiding: truck 30k 20 % dead (was
  0.5 %), the hour 39 % dead (31.7 % even with the 85 % stop) — at equal PSNR.
  The 1.05 M model is really ~650 k live splats plus ~400 k that the opacity
  regulariser kills, relocation re-places and the next round kills again. The
  export already purges them (smaller SOGs for free); the smoke e2e's purge
  guard is relaxed from 85 % to 60 % of the trained count. Turning that dead
  third into live capacity is the opacity-economy problem from 09-01/09-02,
  now quantified.

## 2026-09-06 (speed day 1: per-kernel profile, three negatives, visibility compaction = 3 %)

- **Per-kernel timestamps** (`opts.profile` / bench `?gputime=N`, one pass per
  kernel on a frozen 1.04 M truck model, 979 px): render 10.7 ms
  (fwd 3.3, bwd ≈ 7.4), sort 1.9, chain 1.9, shAdam 1.65, scatter 0.75,
  adam 0.6, project 0.5, scan 0.02 → 17.3 ms/step; metrics are not a lever.
  Iteration time fits 3.2 ms + 13 ms per 1 M splats.
- **Three negatives, all kept opt-in with the numbers in comments**:
  subgroup-aggregated flush (the LichtFeld #1675 move) render 9.8 → 42 ms —
  13 subgroup reductions per splat for every lane cost more than the
  sparse shared atomics they replace; lane-spread partials (`?gspread=4/8`)
  14.4 / 15.2 ms — same-address contention is not the bottleneck; no
  tile-grad (global atomics) 19.8 ms.
- **Visibility compaction** (LichtFeld #1917 idea; `opts.compact`, bench
  `?compact=1`): GPU-built visible list (count → single-workgroup scan →
  stable scatter) + indirect dispatch for chain / Adam / SH-Adam; an
  'invis' Adam pass keeps regs + Langevin noise on hidden rows. Validates,
  runs: per-splat kernels 4.18 → 3.65 ms incl. the three new passes
  (chain 1.93 → 1.68, adam 0.60 → 0.40 + 0.40 invis, shAdam 1.65 → 1.03)
  = **3 % of the step**. The chain only shed 13 %: on an object-centric
  capture ≈ 85 % of the splats are in view from a typical camera, so
  there is little to skip. **Parity** truck 30k, frozen new-solve poses:
  25.699 vs 25.697 / 25.712 (perf, nf8000_oc-1 cells) — exact; 6.7 vs
  7.0 min. Stays opt-in (a default flip needs a wide-scene win).
- **Where the time is**: the backward walk pays two workgroup barriers per
  splat per tile (zero → accumulate → flush); the original 3DGS backward
  pays one per 256. **Batched flush** (`opts.gradBatch`, bench `?gbatch=K`;
  sg grows to 13·K ints, 13·K flush threads, u32-safe stride): render
  10.8 → 8.86 (K=4) → 8.32 (K=8) → 8.18 ms (K=16), the backward ≈ 7.4 →
  4.9 ms, the step ≈ −15 %. Fixed-point integer atomics make the sums
  order-independent; parity truck 30k 25.667 (K=16) / 25.717 (K=16 +
  compact) vs 25.70, garden 26.72 vs 26.48, and 30k runs take 5.9-6.2 min
  instead of 6.7-7.0. **Both are now defaults** (gradBatch 16, compact on);
  bench `?compact=0` / `?gbatch=1` restore the old paths.
- **Bicycle, LichtFeld's speed reference scene** (frozen 966 k sample model, its
  published poses, one-minute profile cells, ms per kernel):

  | | render fwd | render (fwd+bwd) | chain | adam (+invis) | shAdam | step |
  |---|---|---|---|---|---|---|
  | both off | 1.66 | 5.85 | 0.92 | 0.53 | 0.85 | 12.47 |
  | batched flush only | 1.65 | 4.78 | 0.92 | 0.54 | 0.83 | 11.41 |
  | compaction only | 1.64 | 5.82 | 0.34 | 0.16 + 0.48 | 0.26 | 11.57 |
  | both (default) | 1.66 | 4.76 | 0.34 | 0.15 + 0.45 | 0.26 | **10.51** |

  Compaction pays where it should: the chain shed 63 % (≈ 37 % of the splats
  visible per view on the wide scene vs 85 % on truck) → −0.9 ms; batched
  flush −1.1 ms; together −16 %. The 'invis' Adam pass (0.45) is now the
  largest per-splat kernel; a trimmed launch (8 lanes per splat) measured flat
  (0.451 → 0.445) — not launch-bound, kept for the idle lanes; the cost per
  working slot is ~3× the compact pass, cause open. Bench: `?gtrecon` now accepts an
  app-published recon (name remap, focal rescale, cloud → points).
- **Zero-skip atomics** flat (8.29 → 8.38 render), **K = 19** noise (8.16);
  defaults stay at K = 16.
- **vec4 proj reads** (`opts.projVec`, bench `?pvec=1`): four vec4 loads per splat
  instead of 11-15 scalars — truck render 8.29 → 8.19, bicycle 4.76 → 4.81,
  the forward slower (eager loads for culled splats). Load count is not the
  bottleneck; broadcast reads live in L1. Opt-in. **Day total**: 17.3 → ≈14.7
  ms/step on truck (−15 %), 12.5 → 10.5 on bicycle (−16 %); the remaining
  backward cost is the per-pixel-splat math and the sequential walk itself.
- **Remaining-sets check of the 09-05 solver default** (old solve `?classicsolve`
  vs new default, 30k, seed 1, held-out PSNR; solve minutes in brackets):

  | set | old solve | new default | Δ |
  |---|---|---|---|
  | bar360 (102 panos → 612 faces) | 20.69 (7.3) | 19.95 (10.7) | **−0.74** |
  | bicycle | 23.56 (2.0) | 23.82 (6.3) | +0.26 |
  | playroom | 26.89 (3.8) | 27.65 (4.7) | +0.76 |
  | train (301 imgs) | 21.20 (7.2) | 21.51 (22.5) | +0.31 |
  | synthetic (exact cams) | 38.99 | 40.47 | +1.47 |

  With truck +0.15 (hour), garden +0.26, camping ±0: 7 of 8 up, the one loss
  is the 360 rig set. Solve cost is real on big sets (train 7 → 22 min).
  **360 suspect**: sliced faces know f, k1 = k2 = 0 and a square pixel exactly,
  yet BA refines all of them (the known focal only skips the search); the new
  default adds a free aspect on top. Queued: octave-vs-aspect split
  (`_cs_nf8000_oc-1`, `_cs_nf8000_sa`) and an intrinsics lock for rigs
  (`sfm.lockIntrinsics`, bench `?lockk=1`, `_lk`) on both solves.
- **360 rig solve, resolved** (bar360 30k, seed 1, held-out; the 09-05 default
  had lost 0.74 here):

  | solve | PSNR | solve min |
  |---|---|---|
  | old (3900 feats, octave 0, BA refines f/k/aspect) | 20.69 | 7.3 |
  | 09-05 default (8000, octave −1, aspect) | 19.95 | 10.7 |
  | … minus aspect | 19.90 | 10.8 |
  | 8000 + aspect, octave 0 | 20.64 | 7.3 |
  | 09-05 default + intrinsics lock | 20.17 | 10.6 |
  | old + intrinsics lock | 20.98 | 7.1 |
  | **new rig default: octave clamp 0 + lock (8000 feats)** | **20.99** | 7.2 |

  Two facts: the upsampled octave finds features inside the bilinear
  resample that a sliced face is (the whole −0.74), and BA had been refining
  f, k1/k2 and aspect on faces whose values are exact by construction (lock
  +0.29). Rigs now clamp `siftFirstOctave ≥ 0` and set `lockIntrinsics`
  (session.solve; `sfm.lockIntrinsics: false` opts out). Net vs the old
  solve: +0.30, and 7 of 7 pinhole sets keep their gains.
- **Hour signature with the faster trainer**: truck, our poses (the 8000 /
  octave −1 / aspect solve), 1.05 M cap, seed 1, 200k schedule → **26.645 dB**
  at 200 015 iterations in 56.1 min (was 26.55 at 170k / 55.6 min; the COLMAP
  square-pixel reference sat at 26.60). The 15 % step speedup bought 30k
  more iterations inside the hour and +0.10 dB. Published as
  `truck_1h_v3_2026-09-06` (new CDN key); README row + deploy await the go.
- **README short rows re-measured** (frozen new-solve poses, seeds 1/2, train
  minutes): 30k / 1.05 M → 25.68 / 25.71 in 5.9 min; 40k / 1.4 M → 25.89 / 25.97
  in 10.5 min. The old 40k row (25.49, ~10 min) predates the solver default
  and the faster trainer; table now carries 25.70 (30k) and 25.93 (40k).
- **Rig incident** (night 09-05 → 06): a combined wrapper (gputime → newdef)
  was killed to fix its first stage and took the second with it; five
  background waiters watched an idle rig for ~9 h. Rules now in memory:
  one run per wrapper, list before killing, verify a fresh status
  timestamp after launch, watchdog Monitor (v2 excludes its own process
  listings). Remaining-sets check (`cells_newdef.json`) still to re-queue.

## 2026-09-05 (solver default ships: finer SIFT + BA aspect; camping tail explained)

- **Desktop solver default** → siftFeats 8000, siftFirstOctave −1
  (upsampled octave), refineAspect (BA solves fx/fy). User hypothesis
  confirmed: the feature resolution of the solve is what moves pose error
  angles, not the number of registered images. Truck (our poses) 26.40 →
  26.55 at the hour; camping 27.15 @30k (`camping_v2_2026-09-05`); garden
  26.77. Pushed + deployed live. MAXF 8192 → 16384 (garden with 8000
  feats + octave −1 hit "too many features per image").
- **Camping tail drift root cause**: 2 % non-square pixels in the video
  frames; with fx ≠ fy in BA the tail poses line up with the server COLMAP.
- **The pair ships together**: aspect alone collapsed camping (BA drift,
  −0.61), finer features alone regress at the hour (25.93); pixel RMS is
  not a valid gate for either.

## 2026-09-04 (solver: feature resolution → pose precision → the hour; 26.55 with our poses)

User's hypothesis: fewer images register at lower solve resolution, so
feature resolution may drive the pose residual too. Probes on truck (30k,
1.05M, seed 1, app solve with BA aspect; residuals = sim(3)-aligned to
COLMAP, `scratch/pose_resid.mjs`; baseline 25.33, rot 0.043°, ATE 0.032 %):

| solve | rot median | ATE median | 30k dB | solve |
|---|---|---|---|---|
| features at 640 | 0.078° | 0.096 % | 24.61 | 2.4 min |
| 960 (baseline) | 0.043° | 0.032 % | 25.33 | 4 min |
| 960, siftFeats 8000 | 0.043° | 0.032 % | 24.99 | 4 min (poses identical — the contrast threshold, not the cap, limits the count) |
| 960, 8000, peak 0.5 | 0.051° | 0.035 % | 25.28 | 4.4 min |
| **960, 8000, firstOctave −1** | 0.053° | **0.021 %** | **25.71** | 12.4 min |

Hour on the octave poses (1.05M, 170k in 55.6 min): **26.547** (our poses
26.40 → +0.15; COLMAP exact fx/fy 26.48; COLMAP square resample 26.60).
Published truck_1h_v2_2026-09-04; README signature + row updated (top of
the table, above SSS 26.41). Population: aniso p50 1.74, opacity p50
0.051 / p95 0.66, ratio > 20 2.4 % — same family as the 26.40 model.

Readings: the hypothesis holds — 640 px features nearly double the angular
residual and cost 0.7 dB. More keypoints at the same scale do nothing
(8000 cap not binding; lower threshold −0.05); FINER localisation does:
the upsampled first octave (COLMAP's default; ours was off since the
2026-08 flood at 1800 feats) halves the position residual and is worth
+0.38 at 30k, +0.15 at the hour, at 3× the solve time. The COLMAP rotation
residual is no longer the yardstick past ~0.04° (COLMAP has its own).
Safety (30k, seed 1, no aspect): camping 25.39 vs 25.46 (−0.07, noise; RMS
0.61 → 0.53), garden **26.74 vs 26.48 (+0.26)**, all cameras, RMS 0.52 —
after raising MAXF 8192 → 16384 (two orientations per keypoint at an 8000
budget overflowed the feature-id stride: "too many features per image").
**Shipped as the desktop default** (app + bench; `?classicsolve` restores
3900 / octave 0); phones keep the lean settings (4× SIFT work). A second
hour run on the stock defaults (in-browser solve, aspect OFF): **25.925**
(solve 12.2 min, ATE 0.033 %, rot 0.052°) — BELOW the flagged 26.55 (octave
+ 8000 + BA aspect, ATE 0.021 %) and below the old default's 26.40. Two
things tangled: the BA aspect was part of the 26.55 recipe (truck's 30k
octave cell had it on; the garden/camping safety cells did not), and the
solve varies run to run at these settings by more than the effect (ATE
0.021 vs 0.033 % between two solves). Untangled: the solve is DETERMINISTIC (two stock truck solves identical to
the digit) — no variance; the difference is the camera model. Finer
features WITHOUT the aspect fit a slightly wrong model with precise
keypoints and the bias grows with training (30k +0.36, hour −0.47).
**The pair is the recipe** (30k, seed 1; old default / finer / aspect /
both): truck 25.18 / 25.54 / 25.33 / **25.71**; garden 26.48 / 26.74 /
26.60 / **26.77**; camping 25.46 / 25.39 / 24.85 / **27.15** (aspect
1.0195 both times — the video frames really are 2 % non-square; the
aspect-alone collapse was BA convergence with 20k points, not the value;
with 58k points it is the best camping solve ever measured here). Pixel
RMS is NOT a valid acceptance test (camping octave-only 0.53 < pair 0.59
yet 1.8 dB worse — different surviving point sets), so no two-pass gate:
the aspect ships WITH the finer features or not at all. Desktop default =
siftFeats 8000 + firstOctave −1 + refineAspect (app + bench;
`?classicsolve` restores the old solve). The 26.55 hour run used exactly
these settings → it IS the stock-pipeline number; README sentence updated.
Deploy pending the user's call on the 3× solve time.
- **Camping's tail drift — root cause found.** Sim(3)-aligned to the server
  COLMAP reference (`camping_gtfull_recon.json`), rotation error head (first
  60 %) vs tail (last 20 %): old default 0.22° / **2.07°** (max 2.5°);
  finer features alone 0.43° / **3.47°**; finer features + aspect **0.13° /
  0.28°** (max 0.36°), position 0.27 % / 0.44 %. The video frames are 2 %
  non-square; a square-pixel solver absorbs that into the poses and the
  error accumulates along the walk — COLMAP (fx, fy) never had the tail.
  Sharper keypoints fit the wrong model MORE precisely (tail worse). The
  2026-08-27 verdict ("our video-tail drift is real error") stands; its
  cause was the camera model, not the tracking.

## 2026-09-04 (per-axis focal + pixel aspect: build, validate, measure)

Built from the fx≠fy finding: fy in the camera uniform (misc3.z), per-axis
projection in computeGeom / scan / backward, the shared-focal camera
gradient split into dL/dlog f and dL/dlog fy (aspect), `opts.aspectOpt`
(train-time shared log-aspect, Adam, ±3 %), `opts.aspectLr`; BA's existing
`refineAspect` now lands in the recon as `cams[].fy` (+ `recon.aspect`);
recon JSON carries fy; bench `?aspect= ?asplr= ?sfmaspect=`. Gradcheck rig
camera at aspect 0.95: pose check ok (logfy relErr 0.25 %), splat check
unchanged. Commit 50e003a.

Hour cells (truck, 1.05M, 170k, 60 min, seed 1; refs: our poses 26.40,
COLMAP square-pixel resample 26.60, COLMAP mean-f 25.88):

| cell | aspect found | dB |
|---|---|---|
| our frozen poses + training aspect | 0.99982 | 26.43 |
| fresh solve, BA aspect (0.9955) + training aspect | 0.99973 | 26.37 |
| COLMAP poses, exact fx/fy via the kernel (no resample) | — | **26.48** |

30k probes (1.05M; refs our poses 25.18, COLMAP square 25.53): training
aspect at 10× lr 25.24 (aspect 0.9998 — does not move); BA-aspect poses
**25.33** (+0.15); both 25.33.

Readings:
- The kernel path is right: exact fx/fy recovers 0.60 of the 0.72 the mean
  focal cost (26.48 vs 25.88; the resampled 26.60 keeps ~0.1 from its 549-
  row frames / resample noise).
- **Train-time aspect refinement is useless once poses are fixed**: the
  poses solved under square pixels already absorbed the error, so the
  aspect optimum given those poses is ≈1.000 (stays there even at 10× lr).
  The estimate belongs in BA — COLMAP 0.9940, our BA 0.9955 — where it is
  worth +0.15 at 30k on this camera; at the hour the fresh solve gave
  26.37 vs 26.40 (solve-to-solve noise ±0.1 swamps it). aspectOpt stays
  opt-in. **sfm refineAspect is NOT a default either**: garden estimates
  1.0020 and gains +0.11 (26.48 → 26.60, the Mip-NeRF frames are slightly
  non-square too), but camping (phone video, square pixels) estimates
  **1.0195**, its own BA RMS worsens 0.61 → 0.79 px and the score drops
  **−0.61** (25.46 → 24.85): on a walk with little roll variety the aspect
  is ill-conditioned and drifts into a worse local optimum. A prior cannot
  hold it (1e5 observations swamp any σ) — a two-pass RMS gate (plain BA,
  then aspect from that solution, keep the lower RMS) is the fix to build
  before it can be on. Until then: `?sfmaspect=1` / `sfm.refineAspect`
  opt-in; the README row stays the plain in-browser solve (26.40).
- **The rest is the poses.** Sim(3)-aligned to COLMAP: frozen solve ATE
  median 0.042 % of extent, rotation error median 0.058° (p90 0.080°);
  fresh BA-aspect solve 0.032 % / 0.043°. At f = 571 px, 0.05° ≈ 0.5 px of
  pointing error — invisible at 30k, worth 0.1–0.2 dB at the hour. COLMAP
  poses with a matched camera model are the better poses by that much.
- Candidates for the pose gap (not started): more BA (iterations, outlier
  rounds, principal point), or train-time pose refinement with a gauge
  lock + test-time pose alignment for the held-out views (camOpt is off
  because refining train poses while eval poses stay fixed costs ~1 dB).

## 2026-09-04 (2×2: Brush vs ours × COLMAP vs our poses, matched 1.05M; the fx≠fy finding)

User: the hour-signature truck is rounder than Brush's (text in Brush is
needles, ours spheres) — compare the assemblies, train Brush at matched
splats, compare dB at long budgets, and COLMAP poses vs ours. All cells
truck, 979 px, eval8, 1.05M cap. Brush = HEAD 8b7f5c6 (`--max-splats
1050000`), ours = default set, seed 1. Brush datasets: T&T COLMAP sparse and
`scratch/truck_colmap_ours` (our solve as COLMAP text, 2026-08-29).

| | COLMAP poses | our poses |
|---|---|---|
| Brush 30k (~10 min) | 26.00 | 25.81 |
| Brush 150k (~50 min) | 26.15 | 25.75 |
| ours 30k | 25.53 (square px) · 25.01 (mean f) | 25.18 |
| ours 60 min / 170k | **26.60** (square px) · 25.88 (mean f) | 26.40 |

- **The T&T truck camera has fx 1163.25 / fy 1156.28 (0.6 %)**: the
  1920×1080 frames were resized non-uniformly to 1957×1091. Brush models
  fx/fy; our trainer has ONE focal, so the COLMAP arm fed sqrt(fx·fy) was
  misaligned by up to 1.4 px at the frame edges: 25.01 / 25.88, i.e.
  −0.18 / −0.52 vs our own poses, growing with training. Resampling the
  images to square pixels (979×549, `data/truck_sq`, f = fx) and the
  same poses: **25.53 / 26.60** — COLMAP poses now beat our own by +0.35
  (30k) / +0.20 (60 min). Our SfM assumes square pixels too, so our poses
  carry that model error on this set; per-axis focal in solve + trainer
  is worth ~0.2 dB here (and on any non-uniformly resized dataset).
  (A "COLMAP poses + our cloud" cell was invalid — different frames.)
- **Brush's pose penalty grows with training** (0.19 at 30k → 0.40 at
  150k): its long run on our poses is BELOW its own 30k. Same mechanism
  the other way round: each trainer does best on the reconstruction that
  shares its intrinsics model.
- **Matched splats, long budget: ours wins.** Brush gains 0.15 from 5×
  the iterations (26.00 → 26.15 on COLMAP); ours in the same wall-clock
  26.60 (COLMAP, square) / 26.40 (our poses). Brush wins the short budget
  on COLMAP poses (26.00 vs 25.53 at 30k). Brush at 1.05M loses 0.14 vs
  its 2M run (26.14).
- **Assembly** (splat_stats, 1.05M unless noted):

  | run | aniso p50 / p95 | long axis p50 / p95 | opacity p50 / p95 | ratio > 20 |
  |---|---|---|---|---|
  | Brush HEAD 2M 30k | 4.5 / 22.6 | 0.045 / 0.61 | 0.099 / 0.63 | 6.3 % |
  | Brush 1.05M 30k (COLMAP) | 5.3 / 25.4 | 0.039 / 0.46 | 0.107 / 0.60 | 7.9 % |
  | Brush 1.05M 30k (ours) | 5.2 / 25.7 | 0.036 / 0.62 | 0.114 / 0.63 | 8.1 % |
  | Brush 1.05M 150k (COLMAP) | 8.5 / 89 | 0.071 / 1.22 | 0.182 / 0.92 | 25.5 % |
  | Brush 1.05M 150k (ours) | 8.1 / 84 | 0.067 / 1.19 | 0.189 / 0.93 | 24.3 % |
  | ours 60 min (our poses, 26.40) | 1.7 / 10.6 | 0.015 / 0.16 | 0.050 / 0.66 | 2.0 % |
  | ours 60 min (COLMAP sq, 26.60) | 1.9 / 11.4 | 0.023 / 0.23 | 0.052 / 0.66 | 2.2 % |
  | ours placement 2M 138k (26.05) | 109 / 846 | 0.023 / 0.17 | 0.069 / 0.30 | 83.5 % |

  Brush's splats are 3× larger, 3–5× more elongated and 2× more opaque at
  the median — the needles in the text — and its long runs go further that
  way (aniso p50 8.5, a quarter of splats > 20:1). Ours (default set) is
  small, round and dim at the median with a bright tail, and scores higher
  at the hour; the placement set is the needle extreme and scores lowest.
  The score does not follow the shape; the two trainers reach different
  optima with opposite populations.
- Published (reference, README untouched): `truck_1h_colmap_2026-09-04`
  (26.60, COLMAP poses, square pixels). Signature stays `truck_1h_2026-09-04`
  (26.40, our poses — the product pipeline).

## 2026-09-04 (truck 60-minute signature)

User's ask: a truck that shows what one HOUR of training gives, iterations
wherever they land, hopefully above the README's 250k row (26.37 @ ~65 min
on the 2026-08 code). Bench: `?minutes=60` hard stop, `?capmult=16` for a
true 2M cap (capMult 8 stops at 1.61M on truck's 25k-point seed),
`?postview=` viewer recon. Frozen poses, seed 1, eval8, 979 px, SH3.

| candidate | cap | iters in the hour | test PSNR | export |
|---|---|---|---|---|
| placement + relocUntil 0.9·H (horizon 120k) | 1.61M | 120k (46 min — horizon ended first) | 25.99 | dead 22.5 % |
| **default (MCMC set), horizon 130k** | **1.61M** | **130k (57 min)** | **26.20** | dead 1.5 %, 1.57M live |
| placement + relocUntil 0.9·H (horizon 140k) | 2M | 138k (60 min) | 26.05 | dead 33.8 % |
| default, horizon 140k | 2M | 114k (60 min) | 26.19 | dead 2.2 % |
| **default, horizon 170k (lean cap)** | **1.05M** | **170k (53 min)** | **26.397** | dead 1.1 %, 1.03M live |

Published: **truck_1h_2026-09-04** (15 MB SOG, 26.397 — the new README
signature: above the old 250k row's 26.37 with 170k cycles in 53 min at a
1.05M cap); the 1.61M/130k run is up as truck_60min_2026-09-04 (26.20).
README link, table row and the 2M paragraph updated (commit, not pushed).

Readings:
- **The hour buys 26.20, not 26.37.** The README row is 250k iterations;
  today's code does ~130k/h at 1.61M (the MCMC set fills the cap early and
  every iteration pays for it — the 2026-08-31 refresh needed 116 min for
  250k). Per-iteration speed, not the optimizer, is what separates a
  60-minute run from the published number.
- **Capacity trades against iterations inside the hour — and the lean end
  wins**: 2M/114k 26.19, 1.61M/130k 26.20, **1.05M/170k 26.40**. The 2026-08
  250k signature (26.37 @ 65 min) is beaten with 32 % fewer cycles because
  each one costs half at 1.05M. Population (splat_stats): opacity p50 0.05
  / p95 0.66 / p99 0.98, aniso p50 1.7, ratio > 20 in 2 %, nothing under
  1e-3 — a dim-but-solid isotropic population, the opposite shape to the
  placement set's needle field.
- **The placement set loses at long horizons on truck too** (−0.21 / −0.14
  vs default at the same budget), and the PLY says why: 97 % of splats
  thinner than 1e-3, aniso p50 109, a third dead at export — the needle
  wall in full, even with relocation stopped at 0.9·H. The default's hour
  population is the opposite failure: isotropic (aniso p50 1.8) and DIM
  (opacity p50 0.04, p95 0.40). Neither is Brush's population (opacity
  p50 0.10 / p95 0.63, aniso p50 4.5 at 30k).
- Consequence for the flip: placement stays a 20k-budget win (matrix: 6
  up, 2 flat, 0 down); at 40k+ it must not be the default without the
  long-horizon fix (relocUntil 0.9·H recovers garden; minScale 1e-4
  empties the wall; combination unmeasured). Signature/long runs stay on
  the default set for now.

## 2026-09-03 (opacity economy: packages P1/P2 → the scale reg was the wall)

Truck, frozen poses, 30k / 1.05M, on the rung-3 combo (base A + refineV2 +
growRate 0.1). Combo reference: s1 25.664 · s2 25.674 · s3 25.463 (seed 3
is a harder schedule; every seed-3 cell is judged against 25.463).
Knobs added (all opt-in, defaults untouched): `opaDecay` (Brush's
`o -= 0.004·(1−t)` per 200 it, applied per step in opacity space in the
Adam kernel, flg.z), `deadThr`, `poolMin`, `donorWeight 'opavis'`,
`deadTiny`, bench `?ratiocap`, packages `?econ=brush` / `?econ=lf`
(the packages set the SESSION refine cadence — `refineEvery` is not a
trainer option; the first package cell silently ran at 500 because of that).

- **Packages as packages LOSE.** Brush economy (opacityReg 0, decay
  0.004, dead < 1/255, relocate all every 200 it, donors ∝ o·rendered):
  25.32 / 25.37 = **−0.32**, in 4 min instead of 7. LichtFeld economy
  (dead < 0.005, pool 0, ratio cap 51, all dead every 100 it, grow 5 %):
  25.50 / 25.50 = **−0.17**. Their pieces: dead 1/255 + moveCap 1 −0.06;
  dead 0.005 + pool 0 + moveCap 1 +0.06; ratio cap 51 −0.20; donors ∝
  o·rendered +0.14 / −0.24 (seed-dependent, rejected); LF at 500 it −0.20.
- **Outputs first** (`splat_stats.mjs`): decay-for-reg alone (opacityReg 0
  + decay 0.004) turns the opacity distribution past Brush — p50 **0.39** /
  p95 **0.995** vs combo 0.08 / 0.28 vs Brush 0.10 / 0.63 — and reads +0.13
  (s1). But 5 % of its splats sit on the minScale wall on ALL axes (aniso
  p5 = 1.00: opaque dots no pixel integrates), and the Brush package parks
  **25 %** there (aniso p25 = 1.00, long-axis p25 = the wall) — that is why
  it is fast and why it loses. Mechanism: with opacity high and no data
  support, the Adam-normalised scaleReg (0.01, still on in the package —
  Brush has NO scale reg) walks the scales to the floor at full lr.
- **Decay strength peaks at Brush's 0.004**: 0.002 +0.06, 0.004 +0.13,
  0.008 +0.04 (s1). Relocating the collapsed dots (`deadTiny`) −0.04 vs
  decay alone: relocating them does not pay, removing the pressure does.
- **Scale reg off = the fix.** Brush package with scaleReg 0: **+0.14 /
  +0.04 / +0.25** (25.799 / 25.717 / 25.714), mean **+0.14**, 3 of 3
  seeds up. Decay-for-reg alone: +0.13 / +0.02 / +0.21 = **+0.12**, 3/3.
  Decay with both regs off: +0.16 / −0.16 / +0.27 = +0.09, one seed
  lost. Decay + donors ∝ o·rendered (no package): −0.32 / −0.22 — opaque
  donors under decay breed clones that collapse; only the whole package
  (dead 1/255, relocate all, cadence 200) carries that donor rule.
  Distributions of the two keepers: opacity p50 0.19–0.22 / p95 0.96,
  aniso p50 12–15 (combo 151, Brush HEAD 4.5), ratio > 20 in 38–42 %
  (combo 82 %), thin < 1e-3 in 29–33 % (combo 86 %): the first population
  of ours that looks like Brush's instead of a needle field.
- **Garden confirm — both REJECTED as defaults** (combo garden 26.544 /
  26.644): reg-free Brush package 26.515 / 26.478 = **−0.10**; decay-for-reg
  26.434 / 26.540 = **−0.105**. Truck's +0.12…0.14 is given back on
  garden. The 1/n argument (garden trains at 2M, truck at 1.05M → decay
  0.002 on garden) does not hold: 26.551 / 26.467 = −0.09, seed 2 always
  −0.18. Verdict: the opacity economy is scene-dependent at this stage —
  what raises truck's opaque tail costs garden — and stays an opt-in arm
  (`?econ=brush&scalereg=0`, `?opareg=0&opadecay=0.004`). Economy rung
  CLOSED (two negatives on garden). The distribution finding stands: a
  Brush-like population is reachable, but on garden it does not score.
  Keep rule +0.1 truck mean, no garden regression > 0.1. Cells: `gen_cells.mjs p1, p1c,
  p1d, p1e, p1f, p1g, gp1`; the ab_cells chains run DETACHED (PowerShell
  Start-Process) because a tool background task is capped at 10 min — and
  their `*>>` logs are UTF-16 (decode with iconv before grepping).
- **Rung 8 gate: 16-cell matrix × {default, placement set}** (app pose solve,
  unseeded, eval8; placement = `?aniso=0&minscale=1e-5&comp=0&refv2=1&growrate=0.1`,
  the `?placement=1` set). Same code, interleaved per cell.

  | set / iters | default | placement | Δ dB | train min | Δ time |
  |---|---|---|---|---|---|
  | synthetic 20k | 38.73 | 38.89 | +0.16 | 1.0→1.3 | +30 % |
  | synthetic 40k | 38.66 | 39.21 | +0.55 | 2.9→2.9 | 0 |
  | camping 20k | 25.19 | 25.49 | +0.31 | 4.1→6.6 | +61 % |
  | camping 40k | 25.33 | 25.45 | +0.12 | 11.9→19.0 | +60 % |
  | truck 20k | 24.51 | 25.16 | +0.64 | 3.1→4.6 | +48 % |
  | truck 40k | 25.62 | 25.72 | +0.10 | 11.4→13.4 | +18 % |
  | garden 20k | 25.95 | 26.23 | +0.28 | 3.5→4.2 | +20 % |
  | garden 40k | 26.91 | 26.65 | **−0.26** | 10.0→12.8 | +28 % |
  | bicycle 20k | (rerun) | 23.60 | | ?→4.1 | |
  | bicycle 40k | (rerun) | 23.39 | | ?→10.2 | |
  | playroom 20k | 26.66 | 26.93 | +0.27 | 3.2→3.5 | +9 % |
  | playroom 40k | 26.77 | 26.67 | −0.09 | 10.2→9.3 | −9 % |
  | train 20k | 21.20 | 21.20 | −0.01 | 3.4→4.0 | +18 % |
  | train 40k | 21.90 | 21.35 | **−0.55** | 11.8→12.5 | +6 % |
  | bar360 20k | 20.48 | 20.43 | −0.05 | 3.2→3.6 | +13 % |
  | bar360 40k | 20.66 | 19.85 | **−0.80** | 10.1→11.3 | +12 % |

  Reading: at the app's default 20k the set wins 5, ties 2, loses 0. At
  40k it loses on 4 of 6 measured sets, on the outdoor / 360 ones by a lot.
  Outputs first (placement PLYs 20k → 40k): garden thin-axis p50 1.1e-3 →
  1.48e-4 (= the 1e-5·r wall), thin < 1e-3 **49 % → 83 %**, aniso p50 27 →
  113, opacity p50 0.20 → 0.12, p95 0.60 → 0.35; truck the same drift.
  The long-run loss is **needle degeneration** — with anisoReg 0 and the
  scale floor at 1e-5·r, more iterations mean thinner, dimmer needles —
  not relocation churn. The two bicycle default cells were lost to a rig
  incident (a second chain merged into the matrix's browser; see memory)
  and rerun seeded afterwards, with a seeded frozen-pose garden 40k A/B.
  Bicycle reruns (seeded): 20k default 23.25 vs placement 23.60 (**+0.35**),
  40k 23.66 vs 23.39 (**−0.27**). Seeded frozen-pose garden 40k A/B:
  default 26.848 / 26.786, placement 26.633 / 26.542 = **−0.22 / −0.25**.
- **Garden 40k probes** (frozen poses, seed 1, vs default 26.848 / plain
  placement 26.633): minScale 1e-4 **26.781** (+0.15: thin < 1e-3 goes
  83 % → 0 %, aniso p50 113 → 14.5); anisoReg 0.001 26.62 (0: rounder,
  aniso p50 5.6, no score); **relocUntil 0.9·H = 26.844 — the whole loss
  back**. So the churn hypothesis was right at the score level: relocation
  running to the last iteration leaves quarter-population clone churn that
  never settles; the needle pile is real but costs ~0.07 on top. Neither
  probe restores the 40k opacity (p50 0.12 / p95 0.36 vs 20k's 0.20 /
  0.60) — the dim-tail economy is the residual. Long-horizon default
  candidate: placement + relocUntil 0.9·horizon (+ minScale 1e-4 to be
  measured in combination). Training time +10…60 % on the placement set
  (long splats touch more tiles) stays the second cost the flip must
  answer.
- **Truck signature** (user: 60 min of training, iterations wherever they
  land; the README's row is 26.37 @ 250k / ~65 min): bench `?minutes=`
  hard stop + `?postview=` viewer recon; two candidates queued at the 2M
  cap on frozen poses — placement + relocUntil 108k (horizon 120k) and the
  current default (horizon 130k).

## 2026-09-02 (placement ladder, docs/plan-placement-2026-09-02.md)

All cells: truck, frozen COLMAP-identical poses (`scratch/truck_ab_recon.json`),
30k, 1.05M cap, eval8 (32 frames), ~6.8 min each.

- **Rung 0 — seeded runs.** `opts.seed` (mulberry32) now drives the camera
  schedule and every refine draw; bench `?seed=`. Same-seed repeat:
  25.418 vs 25.412 (**0.006 dB**, was ~0.37 unseeded). Seed 2: 25.228 —
  the cross-seed spread (0.19) is now the noise floor, so A/Bs compare
  per seed pair and keepers must win on both.
- **Rung 1 — Mip comp off (`opts.mipComp`, bench `?comp=0`).** Brush
  semantics = dilate 0.3 + NO opacity compensation, which is also exactly
  what pcview renders (PlayCanvas 2.21.4 adds +0.3 unconditionally and
  only applies the Mip factor under GSPLAT_AA, which we don't enable).
  | cell | s1 | s2 | s3 | mean |
  |---|---|---|---|---|
  | C needle (dil 0.1, comp on) | 25.418 | 25.228 | 25.228 | 25.29 |
  | **A dil 0.3, comp off** | 25.308 | 25.425 | 25.368 | **25.37** |
  | B dil 0.1, comp off | 25.268 | 25.387 | — | 25.33 |
  Seeds disagree on the sign (seed × config interaction is real); A wins
  2 of 3 seeds, +0.08 mean → **A adopted as the base** for every later
  rung (it is also the only variant external viewers render exactly as
  trained: no export bake needed). Shape stats (seed-1 PLYs): A aniso
  p50 83.8, ratio>20 73 %, thin<1e-3 79 % — Brush was 88 / 72 % / 59 %;
  A also keeps opacity higher (p50 0.072 vs C 0.049: no fade).
  deadPct at horizon: A 0.7–0.9 %, B 1.3–1.5 %, C 0.85–1.2 %.
  Rung 7 (Mip 3D filter) is therefore skipped: it only pays if a
  dilate<0.3 base had won.
- Half the splats in every cell sit AT the minScale wall (thin p5..p50 =
  1.98e-4 = 1e-5·r). Under comp-off + 0.3 dilation a sub-pixel thin axis
  renders identically whatever its value, so the wall is harmless there.
- **Rung 2 — opacity/scale reg gated on visibility (`opts.regVisOnly`,
  bench `?regvis=1`) — DROPPED.** Hypothesis was that the unconditional
  reg is a "ratchet" (Adam walks a culled splat's logit to −9 at full lr)
  that kills usable splats. Result on base A: s1 25.285 (−0.02), s2 25.271
  (−0.15), **deadPct 0.00** on both, trainMin 4.6 vs 6.7. Reading: the
  ratchet IS the MCMC death signal — with it gated nothing ever crosses
  o<0.02, `_refineLegacy` never relocates, and placement freezes after
  the growth phase. (3DGS-MCMC applies opacity reg unconditionally for
  exactly this reason.) Side effects worth keeping in mind: opacity p50
  0.27 / p75 0.87 (vs 0.07 / 0.2 in A), aniso p50 20 (vs 84), wall
  splats drop from p50 to p25, and the 30 % speedup is real (denser
  transmittance floor ⇒ fewer splats blended per pixel). The regvis+
  opaFloor cells were cancelled (opaFloor is moot when nothing dies).
  `opts.opaFloor` alone (keeps dead logits at −7 instead of −9 so a
  relocated clone's neighbourhood recovers faster) stays as an optional
  2-cell appendix if rung 3 leaves the GPU idle. Dead/survived telemetry
  (`(dead N, last round S/L survived)` in the refine log) stays.
- **Rung 3 — placement knobs, one at a time on base A** (`scratch/gen_cells.mjs 3`,
  `scratch/rung_table.mjs` for the table). Base A per seed: 25.308 / 25.425.
  | knob | s1 | s2 | Δmean | dead % | min | verdict |
  |---|---|---|---|---|---|---|
  | growRate 0.1 (`?growrate=`) | 25.516 | 25.711 | **+0.25** | 1.0/1.6 | 7.8 | keep |
  | refineV2 (`?refv2=1`) | 25.417 | 25.548 | **+0.12** | 1.4/0.6 | 6.5 | keep |
  | refineEvery 250 | 25.451 | 25.441 | +0.08 | 0.0 | 8.3 | lean (no distribution move) |
  | growUntil 15000 | 25.284 | 25.357 | −0.05 | 0.5 | 5.8 | no — but only 751k splats |
  | errDonors | 25.281 | 24.953 | −0.25 | 3.0/2.8 | 7.2 | no (error-placed clones die) |
  | splitV2 | 24.929 | 24.978 | −0.41 | 1.1/1.4 | 5.8 | no |
  | refineV2 + refineEvery 100 | 24.846 | 24.853 | −0.52 | 0.1/0.3 | 7.6 | no |
  Reading: (1) the bench (and the app's MCMC set) pin `growRate` 0.05
  with capMult 8, so n(t) = n0·1.05^(t/500) needs ln 8 / ln 1.05 ≈ 43
  refines = **21.5k iters to reach the cap — 1k before growth freezes at
  0.75·30k**; the full population trains for only ~8k iters (and
  growUntil 15000 never got there: 751k). At 0.1 the cap lands at ~11k,
  at 0.15 at ~7.4k. The gain is iterations-at-capacity, not a placement
  effect — and it shrinks with the horizon (60k app default); (2) refineV2's
  eq-9 relocation is the only knob that moves the distribution toward
  Brush (aniso p50 148, ratio>20 81 %, opacity p95 0.28 vs A's 84 / 73 %
  / 0.42) and it is faster (no CPU round trip); (3) growth is per refine
  CALL, so refineEvery and growRate are confounded — re100 also grew 5×
  faster; the combo round runs the growth-normalised cadence cell
  (rv2 + gr0.05 + re250 ≡ rv2 + gr0.1 per iteration). Combo round
  (`gen_cells.mjs 3c`): rv2+gr0.1, gr0.15, rv2+gr0.05+re250, 2 seeds;
  then garden confirm (`gen_cells.mjs g --set=garden`) A vs rv2+gr0.1.
- **Rung 3 combo round** (truck, same seeds):
  | cell | s1 | s2 | mean | vs A | min |
  |---|---|---|---|---|---|
  | **rv2 + gr0.1** | 25.664 | 25.674 | **25.669** | **+0.30** | 7.1 |
  | gr0.15 (legacy) | 25.531 | 25.707 | 25.619 | +0.25 | 8.2 |
  | gr0.1 (legacy) | 25.516 | 25.711 | 25.613 | +0.25 | 7.8 |
  | rv2 + gr0.05 + re250 | 25.037 | 25.374 | 25.206 | −0.16 | 7.2 |
  The keepers stack (+0.06 over gr0.1 alone, but 0.7 min faster and a
  0.01 seed spread vs 0.20). Growth saturates between 0.1 and 0.15 →
  0.1. The growth-normalised cadence cell settles the refineEvery
  question: same splats-per-iteration curve as the combo, −0.46 mean —
  under refineV2 it is the relocation FREQUENCY that hurts (a relocated
  clone gets relocated again before it recovers), not growth speed.
  **refineEvery 500 is final.** Rung-3 result: base A + refineV2 +
  growRate 0.1 = 25.67 on truck 30k (was 24.97 stock two days ago;
  Brush-native 26.07 → 0.40 left).
- **Garden confirm** (frozen poses, 30k, 1.05M, eval8 24 frames, ~6.5 min):
  base A 26.557 / 26.580, combo 26.544 / 26.644 → **+0.03 mean, no
  regression.** Garden's denser SfM seed reaches the cap early even at
  0.05, so the growRate gain is a truck (sparse seed) effect; refineV2
  holds level. Rung 3 CLOSED: keepers refineV2 + growRate 0.1.
- **Rung 4 (capacity) first cell**: `?maxsplats=2000000` on the combo,
  s1 = **25.09** (−0.57 vs 25.67 at 1.05M), 1,609,024 splats, deadPct 0,
  8.4 min. Two findings before the second seed even lands:
  - The "2M" cell never had a 2M cap: `cap = min(seed·capMult, maxSplats)`
    (trainer.js:198) and the seed cloud is the 25,141 SfM points × 8
    clones, × capMult 8 = exactly 1,609,024. s2 shows the same count at
    iter 14.8k. So the cell is really a **1.61M** cell — which happens to
    be Brush's count (1.63M) on the same scene. At Brush's capacity we
    LOSE 0.57 dB while Brush is +0.4 over our 1.05M number: whatever
    dilutes at high n is ours, not a capacity law.
  - Growth reaches 1.61M at refine ~22 (201k·1.1^22, iter ~13k), so the
    cell spends 17k iterations at capacity — more than the combo does at
    1.05M (reached ~11k). Iterations-at-capacity was the rung-3 gain
    driver, so that is not the loss either.
  Prime suspect: the per-frame (key,id) entry budget, `entriesCap =
  maxSplats·24` (48M at 2M). The scan kernel flags tiles that overflow it
  and readLoss accumulates `trainer.entryOverflowTiles`, but no bench
  cell ever reported it. Added `overflowTiles` to the bench result and a
  `?entriescap=` passthrough (tag `_ec`); the 2M cells in the running
  chain predate the edit, so a probe cell follows the chain. If the count
  is non-zero the "capacity dilutes" verdict of 2026-09-01 was a budget
  bug, not placement.
- **Rung 4 second seed + rung 6** (all on the combo, vs 25.664 / 25.674):
  | cell | s1 | s2 | mean | vs combo | dead% |
  |---|---|---|---|---|---|
  | cap "2M" (= 1.61M) | 25.090 | 25.029 | 25.06 | **−0.61** | 0 / 12.0 |
  | poslr 0.07 (≈ Brush) | 25.551 | 25.506 | 25.53 | −0.14 | 0.8 |
  | poslr 0.3 | 25.700 | 25.771 | 25.74 | +0.07 | 0.65 |
  | SH ramp off | 25.289 | 25.687 | 25.49 | −0.18 | 0.8 |
  Rung 6: Brush's position LR is still wrong for us (−0.14, third time
  negative); 0.3 is +0.04/+0.10 — both seeds up but under the +0.1 keep
  line, so a 0.5 cell probes whether there is a peak between 0.3 and 1.0
  before anything is adopted. SH ramp off rejected (−0.18, 0.4 seed
  spread: the early full-SH fit is unstable).
  Rung 4: the 1.61M cell loses on both seeds, and the second one ends
  with **12 % dead** at the horizon (s1: 0 %). The new refine census log
  (`bench_*_refines.txt`, posted per cell from now on) shows what the
  population does at 1.05M: the moment growth reaches the cap (~11k) a
  **quarter of all splats is dead per refine** (relocated 262,500 =
  moveCap·n, dead 269k), and only 35–40 % of the relocated survive the
  next 500 iterations; churn decays to ~3 % dead per refine by 25k.
  Reading: our opacity/scale regs are per-splat CONSTANTS (adam kernel
  `g += reg·σ'`), while 3DGS-MCMC's are `mean()`-scaled, i.e. 1/n per
  splat. The data gradient a splat receives falls with n (more splats
  share the same pixels), so the reg/data balance tilts toward death as n
  grows — exactly the 1.61M distribution: opacity p50 0.055 vs 0.080,
  long axis p95 0.36 vs 0.26 (dimmer, longer, more of them). Probe cells
  queued (`gen_cells.mjs 4b`): overflowTiles at 1.61M, entry budget ×2,
  regs ×0.65 (= 1.05/1.61) at 1.61M, and the same regs at 1.05M as the
  control.
- **Rung 4b probes** (seed 1; the 1.61M cell was 25.09 in the first pass):
  | cell | psnr | dead% @30k | overflow | note |
  |---|---|---|---|---|
  | 1.61M again (same seed) | 24.571 | 9.0 | 0 | same cell as 25.09: **0.52 dB same-seed spread** at this n |
  | 1.61M, entry budget ×2 | 25.162 | 9.2 | 0 | inside that spread → budget is not it |
  | **1.61M, regs ×0.65** | **25.577** | 4.2 | 0 | +0.4…1.0 over the 1.61M cell |
  | 1.05M, regs ×0.65 (control) | 25.439 | 0.1 | — | **−0.23** vs the combo |
  Entry-budget hypothesis dead (overflow 0 everywhere, doubling it does
  nothing). The reg hypothesis holds on both arms: the same ×0.65 that
  costs 0.23 at 1.05M recovers ≥0.4 at 1.61M — the right reg weight
  scales with 1/n, as 3DGS-MCMC's mean() formulation implies. The 1.61M
  census explains the same-seed chaos: at the cap 948k of 1.61M are dead
  (59 %), moveCap relocates 402k per refine and 72 % of those die again
  within 500 iterations; with ×0.65 the peak is 53 % and the tail decays
  twice as fast (172k dead at 29.5k vs 314k). Brush's truck export for
  comparison (1.63M): opacity p50 0.094 / p95 0.57 / p99 0.90 vs ours
  0.080 / 0.28 / 0.51 — Brush keeps a genuinely opaque tail; our
  Adam-normalised constant reg never lets one form.
  Implemented `opts.regRefN` (+ `regRefMax`): per-step reg weights =
  configured × regRefN/n (bench `?regref=`, `?regrefmax=`). Rung 4c cells:
  regRefN 1.05M at 1.05M (differs from the combo only during growth) and
  at 1.61M (2 seeds), the ≤1-clamped variant, and opacityReg-only ×0.65
  for attribution.
- **Rung 6 poslr 0.5**: 25.763 / 25.729 = 25.746, **+0.08** (s1 +0.10,
  s2 +0.06). With 0.3 at +0.07 that is a plateau, 4 cells out of 4 above
  the combo (same-seed spread is 0.006) but under the +0.1 keep line.
  Not adopted on truck alone; carried as a separate arm into the final
  garden confirm — garden decides.
- **Rung 4c (regs ∝ 1/n)**:
  | cell | s1 | s2 | dead% | vs |
  |---|---|---|---|---|
  | 1.05M, both regs × 1.05M/n (stronger during growth) | 25.598 | 25.501 | 1.4 | −0.12 vs combo |
  | 1.61M, both regs × 1.05M/n | 25.551 | 25.312 | 5.4 / 7.0 | +0.37 vs 1.61M raw |
  | 1.61M, both regs, factor ≤ 1 | 25.401 | | 4.6 | |
  | **1.61M, opacityReg ×0.65 only** (scaleReg 0.01) | **25.701** | | 2.2 | **+0.04 vs the 1.05M combo** |
  Attribution is clean: the recovery is the OPACITY reg; scaling scaleReg
  along costs ~0.15 (25.55 vs 25.70) and a stronger reg during growth
  costs 0.12. So: `opts.opaRegRefN` (opacity only, factor ≤ 1 by default,
  bench `?oregref=`) replaces the two-reg knob. The or-only 1.61M cell is
  the first high-capacity run that does not lose to 1.05M — and it is
  seed 1 only, with the 1.61M seed spread at 0.24. Rung 4e: second seed,
  the 1/n rule at 1.61M (2 seeds), opacityReg 0.005 at 1.61M, and the
  1.05M side (0.0065 / 0.015) to see whether 0.01 is at the optimum.
- **Rung 4d (donor draw, `opts.donorWeight`)** — REJECTED. refineV2 draws
  relocation donors ∝ accumulated error mass; the pool's p50 opacity is
  0.08, so eq-9 clones are born at 0.02–0.04, the death line (65–70 % of
  relocated splats die within 500 iterations). 3DGS-MCMC draws ∝ opacity.
  Result on the combo: `opa` 25.512 / 25.651 (−0.09), `erropa` 25.593 /
  25.508 (−0.12). Error-guided placement is worth more than clone
  survival; the churn is a feature (bad clones die, good ones stay).
- **Rung 4e (opacityReg only, both caps) — RUNG 4 DROPPED.** Combo
  reference s1 25.664 / s2 25.674.

  | cell | s1 | s2 | dead % | Δ mean |
  |---|---|---|---|---|
  | 1.61M opacityReg 0.0065 | 25.701 | 25.260 | 0 / 0 | −0.19 |
  | 1.61M `opaRegRefN` 1.05M (×0.65 at cap, ≤1) | 25.652 | 25.084 | 2.2 / 1.6 | −0.30 |
  | 1.61M opacityReg 0.005 | 25.569 | — | 0 | −0.10 (s1) |
  | 1.05M opacityReg 0.0065 | 25.700 | — | 0.3 | +0.04 (s1) |
  | 1.05M opacityReg 0.015 | 25.384 | — | 4.0 | −0.28 (s1) |

  Reading: the reg fix recovers about half of the raw 1.61M loss (24.9 →
  25.4 mean) but 1.61M never beats 1.05M on truck, and seed 2 sits
  0.4–0.6 under seed 1 in every 1.61M cell — the 0.5 dB same-seed chaos
  measured in 4b is a property of that capacity, not of the reg. Stop
  rule (two negatives in a row) → rung 4 dropped; `opaRegRefN` stays
  opt-in, 1.05M stays the truck cap. On the 1.05M side the opacity reg is
  flat from 0.0065 to 0.01 and falls off a cliff at 0.015 (dead 4 %), so
  0.01 is at the safe edge of the plateau, not in the middle of it. The
  earlier −0.23 for "both regs ×0.65 at 1.05M" was entirely scaleReg.
  User check-in during this rung ("looks like parameter tuning — are the
  fundamentals solid?"): correct. The opacity economy (clone birth at
  0.02–0.04, 72 % relocation deaths, p95 opacity 0.28 vs Brush 0.57) is a
  system property; no constant fixes it. Next: source-level comparison
  of the LichtFeld MCMC and Brush relocation/pruning paths (pulled
  LichtFeld to e6645167, 78 commits incl. "training VRAM −30 % + faster"
  #1917) before any further cell.
- **Garden confirm, rung 6 arm (poslr 0.5 on the combo)**: 26.582 /
  26.657 vs combo 26.544 / 26.644 → +0.04 / +0.01, dead 0 %. Garden does
  not regress; truck +0.08 mean. Under the keep line on both sets, so
  poslr 0.5 stays a documented arm (bench `?poslr=0.5`), not a default.
  Combo unchanged: truck 25.67, garden 26.60.
- **Source reading (Brush HEAD 8b7f5c6 vs v0.3.0, LichtFeld e6645167)**
  — the loss normalisation was misread by the agent reports: our
  Charbonnier gradient is a raw per-pixel sum (no 1/P, `shaders.js:719`)
  while LichtFeld's L1 is a mean over pixels with regs `0.01·σ'(o)/N`; per
  splat the two reg/data ratios are within 2× at 1–2M. The reg strength is
  NOT the fundamental. The structural differences are: dead threshold
  (ours 0.02, LichtFeld 0.005, Brush 1/255), relocation cadence (500 /
  100 / 200 it) and count (0.25·n cap / all dead / all pruned), donor pool
  (o ≥ 0.05 ∝ err, ratio ≤ 3 / all ∝ err, ratio ≤ 51 / ∝ o·visible),
  child opacity (eq-9 from an 0.08-median pool → 0.02–0.04 / eq-9 floor
  0.005 / `1−(1−o)^(1/√2)`) and Brush's `o −= 0.004·(1−t)` opacity decay
  every 200 it in place of any loss-side reg. Brush HEAD changed nearly
  every training-math item since v0.3.0 (the 26.07 reference): random
  background black ± 0.1, Mip 3D scale floor, zeroed Adam moments on both
  split halves, LR schedule in median-scene units, opacity lr 0.012.
  Before porting any of it: re-run Brush at HEAD under the matched truck
  protocol (built from source — no release after v0.3.0; rustup installed
  via winget, `cargo build --release -p brush-cli`, flag rename
  `--total-steps` → `--total-train-iters`).
- **Brush HEAD (8b7f5c6) re-benchmark, truck, identical protocol** (219
  train / 32 eval, 979 px, SH3, 2M cap, 30k; runner
  `C:\Dev\brush\run-truck-benchmark-head.ps1`, log + PLY in
  `runs\truck-30k-head`). **26.139 / 0.8960, 1,596,378 splats, 710 s** vs
  v0.3.0 26.071 / 0.8962, 1,632,170, 458 s → **+0.07 dB at 30k, SSIM
  flat, 55 % slower wall-clock** (23.7 vs 15.3 ms/it, the splat count is
  2.5× higher through the first 10k).

  | iter | HEAD | v0.3.0 | Δ | HEAD splats | v0.3.0 splats |
  |---|---|---|---|---|---|
  | 5k | 24.42 | 24.05 | +0.37 | 1.01M | 408k |
  | 10k | 25.30 | 25.04 | +0.26 | 1.35M | 999k |
  | 15k | 25.59 | 25.38 | +0.21 | 1.57M | 1.63M |
  | 20k | 25.82 | 25.83 | −0.01 | | |
  | 25k | 25.96 | 25.90 | +0.06 | | |
  | 30k | **26.14** | **26.07** | +0.07 | 1.60M | 1.63M |

  Reading: the year of changes bought sample efficiency EARLY (the whole
  +0.2…0.4 lead is built before growth stops at 15k and comes from
  growing 2.5× faster) and almost nothing at the 30k ceiling — Brush's
  ceiling on truck is ~26.1 either way. Export distributions
  (`splat_stats.mjs`): HEAD bakes the Mip 3D scale floor into the PLY
  (`bake_min_scale`: `s' = sqrt(s² + f²)`, opacity × sqrt(det s²/det s'²)),
  so its export has thin-axis p5 1.25e-3 (v0.3.0 2.2e-6), aniso p50
  **4.5** (v0.3.0 88), ratio > 20 in **6.3 %** of splats (v0.3.0 72 %).
  Opacity is unchanged: p50 0.099 / p95 0.63 / p99 0.87 (v0.3.0 0.094 /
  0.57 / 0.90). Consequence for us: needles are neither necessary nor
  harmful for the ceiling — two Brush builds with opposite shape
  distributions land at the same PSNR with the same OPACITY distribution
  (p95 ≈ 0.6 vs our 0.28). The opacity economy is the fundamental, as
  the source reading said. Gap ours (25.67) → Brush HEAD: 0.47.
  Not adopted from HEAD for now: the 3D filter (it is an export-safety
  and aliasing feature, PSNR-neutral here), random background (truck has
  no alpha). Worth a cell later: their growth curve (1M splats by 5k).

## 2026-09-01 (the thinness ban: trt finds the ceiling in one closeup)

trt compared the San Pedro sign closeup, Brush vs ours: theirs thin
wispy strokes, ours blobs with dark ringing halos — "we don't allow
our splats to get smaller or thinner than x." Confirmed as a THREE
layer ban: (1) +0.3 px^2 screen dilation = sigma>=0.55px floor in every
direction; (2) Mip comp sqrt(detV/detVd) makes a thinning splat FADE,
so thinness is gradient-dead (Brush dilates 0.3 too but doesn't comp —
their thin splats stay opaque); (3) anisoReg pulls to isotropy exactly
where data gradients are weak. Distribution forensics (splat_stats.mjs,
should have run on day one): median aniso ratio OURS 1.03 (a sphere)
vs BRUSH 88 (a needle); ratio>20 1.3% vs 72%. Method lessons saved to
memory: outputs-first forensics; symmetric audit (our-extras are prime
suspects — "Brush does NOT use Mip compensation" sat in my own notes).

Ladder (truck 30k, frozen poses, auto 1.05M, eval8): stock 24.97 ->
dilate 0.1 +0.17 -> +anisoReg 0 = 25.36 -> +minScale 1e-5 = **25.53**
(the needle model piled p5=p25=p50 exactly at the 1e-4*r clamp — next
wall down; 1e-6 adds nothing). dilate 0.05 overshoots (-0.32; the Mip
paper's 3D filter is the unlock for lower). D-SSIM 0.2 retested under
shape freedom: STILL negative (truck -0.21, garden -0.37) — the old
"loss isn't the lever" verdict survives; Brush converts SSIM via their
placement system, not the loss alone. 2M cap under needle config =
25.10, WORSE than 1.05M — capacity dilutes without placement/prune;
that (not capacity) is the remaining 0.54 to Brush-native 26.07.
Garden honest delta vs today-stock: 26.52 -> 26.64 (+0.13; the Aug-26
baseline was stale, maxScale had already moved it). trt on synthetic
with the needle set: "ringing is now almost completely gone".

Corpse census: classic-era flagships carry >50% DEAD splats (opacity
~1e-6): truck_2m_500k AND bar360_v4 (2M+ of its 4M). Mechanism traced:
opa*comp < A_MIN in every view -> culled -> zero data gradient, but
the opacity regularizer subtracts UNCONDITIONALLY every step (Adam
kernel) -> one-way ratchet; relocation only recycles while refine
runs. Fresh MCMC 30k runs show no pile. Shipped: exportPlyBlob drops
alpha < 1/255 rows (PLY + SOG both derive from it); nightly needle set
?dilate=0.1&aniso=0&minscale=1e-5 (sticky, ?dilate=0 clears). Audit
suspects still open: eMax footprint shrink, gradFixed rounding
starvation on faint giants, logit floor -9 recovery, poslr/SH-ramp
retests under needle config. Defaults UNCHANGED pending the 3D
smoothing filter + pruning + export/viewer dilation consistency.

## 2026-09-01 (setup card: quality dropdown; % born at 50/100)

Follow-ups from the same live pass. (6) The dock's % opened at 50 or
100 and jumped to 1: paths that reach startPrep without open() — Train
on a shared scene, retry after a failed solve — kept the VIEWED model's
iter/maxIters until the first metrics tick (statue: 10000/10000 → 100%,
or 50% against the fresh 20k horizon). startPrep now zeroes every run
counter. (7) My "training plan" text line duplicated the set
description — what trt actually wanted was the quality DROPDOWN next to
Start: shipped as a pill select (Draft/Standard/High/Showcase) left of
the button, two-way synced with the gear (macro applies on pick, custom
gear edits flip it to Custom). Layout verified by screenshot at 390 and
1200 px; iter-reset and dropdown verified on nightly against the statue
share, then deployed live.

## 2026-09-01 (trt's live pass: five navigation/dead-end bugs)

trt walked the share->train loop on live and hit a cluster: (1) Train
from a shared scene, then `<` — landed on the home list with no way
back into the scene; (2) an "interrupted · 496 cycles" tile that could
only be deleted ("why even have it there?"); (3) a share link pulling
every FULL training photo just to draw 140px strip cards; (4) a failed
solve dumped you on the bare upload card — no presets, no Start, no
retry; (5) Back during training overlaid the wall on the live run.
Shipped, one commit: the setup card remembers the scene it came from
(`<` and a new X return INTO it); dead run tombstones are purged and
interrupted-with-source tiles retrain on tap (URL-backed sets rebuild
via a `urlList` preset); shares now pack a per-photo thumbnail zip
(`recon.source.thumbs`, ~10 KB/card, one fetch) that the strip prefers,
old shares fall back; solve failure returns to the real setup card with
settings one tap away; Back/back-gesture during a run now navigates
home like the logo (beforeunload guards the training) — the mid-run
wall-over-scene picker is deleted. Plus a plan line on every setup
card: "Training <set> · Standard quality · 20,000 cycles". E2E 7/7;
share-flow CDP check runs against nightly (UGC CDN CORS blocks
localhost).

## 2026-09-01 (field report #3: DEVICE_REMOVED reaches real users)

A user hit `requestDevice → DXGI_ERROR_DEVICE_REMOVED` — the EXACT
failure our headless rig saw on 08-31. Correction to that diagnosis:
not a rig quirk or the angle flag alone; Dawn/D3D12 device creation
fails this way in the wild (TDR, driver updates, power-gated laptop
GPUs). Worse, our failcard blamed their CAPTURE for it — photography
tips under a driver error. Shipped: (1) createGpu retries once after
1.5 s, re-requesting adapter AND device (the adapter handle dies with
the removal); (2) GPU-classed failures get their own card — your
photos are fine, restart the browser fully.

## 2026-08-31 (back-gesture repro: "my photos were not saved")

trt repro: pick own photos, press back during SfM → no trace of the
photos. The capture WAS saved (pick-time IndexedDB write, verified) —
three UI holes made it invisible: (1) the back gesture mid-run popped
the consumed detail-card history entry with NO visible effect (next
back exited the app); (2) the popstate detail-close branch and (3) the
detail-back fallback both revealed the wall WITHOUT mountWall(), so the
stale boot-time wall (pre-pick, no capture tile) is what greeted you.
Fixed: back mid-run now shows the front page over the live run (same as
header Back), and every wall-reveal path remounts. Also hardened the
save itself: pick-time write is tracked, retried once at solve start,
and a real failure (quota/strict storage) now flashes instead of
vanishing into a catch(()=>{}). CDP-verified: back mid-run → wall with
the capture tile, run alive behind.

## 2026-08-31 (field report #2: the 3-hour 3070)

Same reporter, second report: RTX 3070 desktop, runs took 3 h / 2 h+, then
the share froze 30 min at "Compressing to .sog" on a 169k-splat model
(black canvas). Diagnosis: (a) the compressor's second WebGPU device
request hangs forever on a wedged GPU process (our own documented failure
mode after heavy device churn) — the bundle awaits `createDevice` with no
guard; (b) 3 h ≈ 2 it/s = Intel iGPU, not the 3070 — the NVIDIA control
panel does NOT govern Chrome's WebGPU adapter (Windows Graphics settings
does), so her "fix" changed nothing. Shipped: finish-time raw-state
checkpoint (awaited BEFORE the export chain — a multi-hour result now
survives a frozen compressor), 15 s deadline on the compressor device with
an honest message, GPU row in the Timing tab, one-time Intel-adapter
warning with the actual Windows setting. Also UX: phone default 10k→8k
cycles; the dock now shows progress % and time-left instead of cycle
counts and cycles/s (verified at 390px — screenshots in scratch). E2E
suite green after all of it.

## 2026-08-31 (crash-safe training: pause = safe to close)

- **Pause checkpoint shipped** (from a real user report: 2h+ train, froze
  at finish, everything lost). Pausing (and, on desktop, hiding the tab)
  now persists the RAW trainer state into the run's IndexedDB record —
  one overwritten slot, a straight GPU readback (no PLY text, no SOG
  k-means, none of the export-path memory spike that likely froze her
  machine). The wall tile turns "paused · N cycles — tap to continue";
  resume is bit-exact (state.bin round-trip, node-tested both engines +
  legacy blobs), keeps the SAME run record, resumes toward the original
  horizon with the original growth cap (new `cap` field), and the blob is
  dropped when the run finishes properly. State header now records
  dc-convention + engine for the v2 bridge. E2E on synthetic (headless):
  pause@30k → reload → resume → 46.5 dB model restored param-identical
  (opacity/scale/pos stats match), trains on to 42→46 dB. Cold Adam
  moments cost a ~7 dB transient that recovers in ~15k iters.
- **MAJOR pre-existing bug found by the E2E: resumed runs trained against
  EMPTY targets whenever |k1| ≥ 0.01.** `undistortFrames` divides by
  `recon.fFeat`, which only the live SfM result carries — every
  `useReconstruction` consumer (the old sog "Keep training", restored
  session zips) fed it undefined → NaN remap → all pixels flagged
  invalid → zero photometric gradient, and opacityReg quietly faded the
  model to full transparency (looked like: black render, PSNR frozen,
  it/s ×3, oMean 0.108→0.001 in 14k iters). Real phone lenses are k1
  −0.05..−0.2, so effectively EVERY real continued run was ruined.
  Fixed in session.js (fFeat defaults to cams[0].f), stored in
  recon.json going forward. Our GT-recon benches dodged it (COLMAP
  PINHOLE / pre-undistorted sets, k=0).
- **Rig note**: `--use-angle=d3d11` now breaks headless WebGPU on this
  box (requestDevice → DXGI_ERROR_DEVICE_REMOVED; visible chrome fine,
  headless without the flag fine — dropped from the recipe). The Dawn
  d3d11 fallback backend is NOT a substitute: pipelines run but stats
  atomics silently zero — models train to garbage.
- **Client E2E suite shipped** (`tests/e2e/`, Playwright over system
  Chrome, `npm run test:e2e`): GPU preflight (fails loud on the flag
  breakage above / software adapters), full own-photos happy path
  (solve→train→finish→stored→viewer), the pause/resume contract
  (checkpoint bytes, same-record resume, param stats within bounds,
  target validity, PSNR recovers), and node-side state-blob round-trip
  incl. legacy blobs. Judges by NUMBERS (readbacks, IndexedDB, PSNR) —
  the fFeat bug hid behind a healthy DOM. Whole suite: **25 s** on the
  5080. Mutation-verified: stripping all three fFeat fix layers makes
  the resume spec fail at the target-validity guard. GPU-less CI can't
  run it; at 25 s it simply runs with every change during active dev
  (a nightly scheduled task was set up and dropped the same day —
  redundant while we build daily).

- **App (user-facing), same day**: `?placement=1` sticky set ships the ladder
  combo to nightly + live for hands-on testing (43a7104). Matching stage
  no longer flickers/blacks between pairs (29ed943: shown pair held ≥ 700 ms,
  switch only when both bitmaps are decoded). Done-state 1 fps bug: finish()
  used to start the PLY export (O(n·cams) bake on the main thread), the SOG
  k-means on a SECOND GPU device and per-camera PSNR readbacks the moment
  training ended — while the tour rendered every frame; Download .sog during
  that started a second k-means. Now finish() only checkpoints the raw state
  (+ thumb) and marks the run finished; a Compress button (or Share /
  Download .sog) runs ONE compression job with the tour paused, patches the
  sog into the library record; scoring runs when Details opens; a finished
  uncompressed run reopens from its state via the wall tile. Details sheet
  gains a GPU tab (adapter/limits/features, copyable report) that also works
  on the wall, and `?details=<tab>` in the URL so a refresh or a sent link
  reopens it.

## 2026-08-31 (defaults: measured rollout)

- **DC-convention bridge shipped** (b5b2356): PLY/SOG imports keep the
  standard SH-DC convention (tagged); trainer.setup converts per engine.
  v2 continuation round-trip now EXACT (25.914 vs 25.916 trained).
  Three bugs found by measurement: parse-time logit conversion crushed
  colors (~1.1 dB), seedFrom dropped the dc tag (double-conversion,
  −2.7), and v1's near-perfect wrong answer (sigmoid(x)≈0.5+x/4 mimics
  C0·x+0.5) almost masked it.
- **Point-scaled initTarget default**: min(250k, max(60k, points×8)),
  phones pinned at 60k. Bench validation: garden 30k 26.07 → **26.56**
  (+0.49 free), truck 40k 25.42 → 25.47 (noise). New bench baselines.
- **v2 desktop auto-select: built, measured, DORMANT.** The decisive
  number was storage, not training: SOG costs v2 models **−0.95** vs
  v1's −0.36 (8-bit palette vs unbounded DC) → stored/shared scenes
  land at parity (24.74 vs 24.75 truck 30k) despite v2's +0.58 live.
  Cross-engine continuation lossy both ways (2.5–3.2) → stored scenes
  must record+match engine. Gates for enabling: SOG extended-range DC
  (encoder) or a DC-range regularizer in v2 training. ?engine=v2
  override available.

## 2026-08-30 (overnight: trainer v2)

- **Flagship 250k refresh (v1, current defaults): 26.30 @116min train** —
  reproduces the published 26.37 within noise, but at ~2x the published
  ~60min: today's defaults fill the 2M population early, so most
  iterations carry full-population cost. SPEED DEBT (user: "tackle
  later"): pace the growth curve on long budgets + v2's 1.8x SSIM tax.

- **Closing-the-last-0.3 attempts, both NEGATIVE**: (A) Brush-style
  visibility-normalized growth stat (grad per rendered contribution) =
  25.20 vs 25.69 raw (−0.49 — diverts growth to rarely-seen periphery the
  ring eval never rewards; kept behind `growNorm` knob). (B) entry-buffer
  overflow at 2M: counter reads 0 — no silent tile drops, nothing to fix.
  Remaining candidates tested and ALL negative: windowed-MAX stat
  semantics −0.08 (noise), opacity pressure 0.003 flat, gradient
  precision 2× (gradFixed 32768, WGSL override) flat — the dithered i32
  quantum was already sub-noise. **The −0.3 hunt is closed**: five
  best-theory transplants failed to move it; the residual is distributed
  implementation minutiae, not a lever. Higher-yield backlog: guided
  matching (+0.28 measured headroom), v2 speed (1.8×), small-cap tuning.

- **Engine v2 built and measured** (`trainer.engine='v2'`, opt-in): clean
  Brush-style optimization system on our unchanged (faster) renderer —
  unbounded SH-DC color (standard PLY convention, export simplifies),
  Brush LR table + smooth decays, no SH ramp, no Langevin, L1+0.2·D-SSIM
  default, and refineV3: relocation ∝ opacity + growth triggered by a NEW
  window-accumulated screen-gradient stat (gradP slot 12), every op an
  alpha-conserving split pair with in-kernel ellipsoid offsets. All @30k:
  | scene | v1 | v2 | Brush (our inputs) |
  |---|---|---|---|
  | truck (2M) | 25.11 | **25.69** | 25.93 |
  | garden (2M, init250k) | 26.45* | **26.89** | 27.20 |
  | camping 50k | 26.08 | **26.36** | — |
  | shiny (60k cap) | 37.21 | 34.14 | 31.54 |
  *v1 garden at 1.05M formula-cap = 26.45; the 2M row is v2.
  Gap to Brush now a UNIFORM ~0.25-0.3 at equal inputs+capacity (was
  0.7-1.1). GT-vs-our inputs inverts for v2 too (25.54 GT vs 25.69 ours) —
  our poses keep out-rendering COLMAP's.
- **SSIM finally pays — but only in v2**: garden v2 26.21 without / 26.49
  with (+0.28). Same term, same scene: v1 −0.4. The coupling thesis
  (structural error must steer densification) demonstrated in our own
  codebase.
- **Two capacity ceilings unmasked**: garden growth froze at EXACTLY
  seed×capMult (752,496) — `initTarget` 60k default seed-binds every
  list-set bench cell (garden v1 26.07→26.45 just from init=250k!); and
  the iters×35 maxSplats formula (1.05M) sat below Brush's 2M. Much of
  the week's "trainer gap" was these.
- **v2 known costs**: ~1.7-1.9× train time (SSIM passes at 1600px);
  shiny tiny-cap synthetic REGRESSES (37.2→34.1 — conserving splits +
  SSIM misspend a 60k budget). v2 stays opt-in; product default remains
  v1 (speed) until the time cost and small-budget behavior are tuned.
- First v2 gate starved at 568k splats (heavy-tail stat × mean-multiple
  threshold) — fixed with a median-multiple; growth knobs growTau/
  growFrac/init/maxsplats/refevery exposed through both harnesses.

## 2026-08-29

- **Garden 2×2: trainer × inputs** (30k, eval8, identical 1297px images;
  ours = release defaults, Brush = truck protocol; ours→COLMAP text export
  + COLMAP GT parsed to our recon format, intrinsics at FEATURE scale —
  image-scale intrinsics first gave a bogus 18.28):
  | | our solve | GT COLMAP |
  |---|---|---|
  | Splat.js | 26.07 | 26.76 |
  | Brush | 27.20 | 27.60 |
  Inputs help both (+0.69 us, +0.40 Brush — their growth compensates
  sparse seeds better); Brush's trainer edge widens on texture-dense
  scenes (+0.8..1.1 vs truck's +0.6). Our garden cloud: 31k pts vs GT
  139k (4.4×) — same densification gap as truck.
- **SSIM re-test on garden** (user asked): 25.66 vs 26.07 default →
  **−0.41 dB**. With truck's flat result, D-SSIM is now two-scene
  negative in our trainer — stays opt-in/off.
- **SSIM cross-examination** (user: "everybody uses SSIM — bug in ours?"):
  Brush garden-GT with `--ssim-weight 0` = 26.68 vs 27.60 → SSIM is worth
  **+0.92** in THEIR system (and 2.4× their train time). L1-vs-charbonnier
  pairing fix in ours: 25.69 ≈ no change → not a pairing bug either.
  Conclusion: SSIM pays through gradient-driven densification (structural
  error steers capacity); our size/opacity-driven refine can't hear it.
  This is the strongest single argument for the clean trainer-v2 rewrite
  (shared renderer, Brush-style optimization system) proposed today.
- **SSAA supersampled training** (`trainer.ssaa = 2`: raster at 2×, box-
  downsample, loss at native res vs unmodified targets — dB stays
  comparable; built on the SSIM split-kernel chassis) — user's "ringing"
  hypothesis. Truck: 25.67 vs 25.59 (+0.08, noise-edge) at **2.3× train
  cost** → not worth it on photos (targets carry their own optical blur).
  Shiny (crisp synthetic targets): **36.54 → 38.06 (+1.5 dB)** — new
  record on the set, +6.5 over Brush. Verdict: big lever for synthetic /
  render-target content, PSNR-invisible on photographs; opt-in.

- **Input decomposition on truck (2×2 + controls)** — WORKED, surprising.
  Same 40k protocol, only the solve inputs swapped (COLMAP GT aligned into
  our frame via Umeyama):
  | poses | seed cloud | psnrTest |
  |---|---|---|
  | ours | ours (25k pts) | 25.59 (repeat; prior run 25.50 → noise ±0.09) |
  | ours | GT (60k pts) | **25.87** |
  | GT | ours | 25.35 |
  | GT | GT | 25.66 |
  The seed **cloud is worth +0.28 dB**; COLMAP's **poses cost −0.24** vs
  ours (both directions agree). Our BA poses out-render the COLMAP
  reference.
- **Seed densification via relaxed re-triangulation** (`sfm.denseSeed`,
  3× reproj budget, 0.0015 rad parallax floor on rejected tracks) —
  NO-OP (25.55 vs 25.59). Lesson: loosening acceptance on tracks we
  already formed recovers junk; COLMAP's extra points come from matches
  our budgeted matcher never made. The +0.28 lives in a **denser track
  graph** (guided epipolar re-matching) — open follow-up.
- **RobustNeRF-style transient tile vote** (`trainer.robustLoss`, per-16×16
  vote at κ× running mean loss) — implemented; first run COLLAPSED to
  4.7 dB (u32 overflow in the loss accumulator fed a ~0 threshold; every
  tile trimmed, opacityReg starved the model — fixed via MSE-derived
  reference with floor). Fixed A/B on truck: κ=0 25.50 / κ=3 25.38 /
  κ=6 25.48 → PSNR-flat, and **visually backfires** on truck's one real
  mover (the photographer, cam 60): baseline erases him via multi-view
  consensus, robust preserves his ghost (splats formed during warmup are
  uncorrectable once their only witnessing frame is voted out). Needs
  transient-splat decay to be useful; truck's movers too sparse to be the
  right test set. Flag stays opt-in experimental.
- **maxScale sweep {0.05, 0.5, 2}** → default **0.5·r committed**
  (`e919ca9`): synthetic 39.06 (best of all three; cap 2 regressed it
  −1.63), shiny 36.5, playroom 26.25. Full 16-cell matrix at the lifted
  default: 13/16 cells improved, playroom **+1.02/+0.84**, train +0.26,
  garden +0.14, nothing regressed.

## 2026-08-28

- **maxScale clamp discovered** — THE find of the week (user's tile-artifact
  hunch). The hardcoded 0.05·r splat-size cap forced sky/far content into
  per-view mosaics of small cards = the long-standing "tile artifacts" +
  massive holdout collapse on sky scenes. Shiny 3-sphere bench: defaults
  **18.47 → 37.21** with the cap lifted (single knob; cut relaxation and
  MCMC tweaks were second-order: +1.9 and +0.7). Beats Brush (31.54) on
  the same data by 5.7 dB. Sphere-border seams and sky blocks visually
  gone. Standing lesson recorded: a visible artifact with ~0 benchmark
  delta means the benchmark has a blind spot, not that the artifact is
  free (our gates had no sky-dominated scene).
- **Brush comparison suite** — native 26.07/SSIM 0.896 @30k/7.6min vs our
  25.49 @40k. Matched-constants run (GT poses+cloud, 2M cap, 30k) = 25.35
  → the gap was the trainer, and our trainer saturates (30k≈40k).
  **Browser Brush** (WASM demo driven via CDP, same zip, same split):
  **26.10/0.903 in 30m18s** — quality survives WASM perfectly at 4× the
  wall time. Equal-wall-clock answer: our 100k run = **26.00 @38min** →
  parity at long budgets; the 30k gap is sample efficiency, not a ceiling.
  Short budgets stay ours (25.35 in 7 min vs Brush <25). README got one
  measured Brush row (26.10, 30k cycles, ~30min).
- **Brush-recipe transplants into our trainer** — all FAILED or neutral:
  full cluster (error-guided donors + alpha-conserving splits + Brush LR +
  no SH ramp) = 24.85; minus LR = 24.73; error-donors alone = 25.40.
  Their densification works as a *system* (grow-by-error + conserving
  splits + pruning + recycling), pieces don't transplant.
- **D-SSIM loss term** (`trainer.ssimWeight`, split fwd/bwd kernels + 6
  image passes, FD-validated) — train +0.95 but holdout FLAT (25.38 vs
  25.49): the ceiling is capacity placement, not the loss. Infrastructure
  kept (any image-space loss can now plug in). WGSL lesson: unreachable
  code still counts toward the 8-storage-buffer per-stage limit.
- **PlayCanvas viewer angle-pop fixed** — engine `colorUpdateAngle`
  default 10° holds SH colors stale until the camera swings past the
  threshold; set to 0 (updates on any camera translation, statics free).
  Deployed nightly + live. Viewer stays WebGL2 by decision.
- **PR #5 merged** (long PLY headers; genuine human drive-by) + follow-up
  making the CRLF handling real.
- **Camping tail verdict** (user A/B in app): server-COLMAP poses train
  *notably better* than our 1920 solve → our video-tail drift is real
  pose error, not reference error. Registration is not the issue
  (113/113); detector saturates at ~5.3k feats/img at 1920 (blur erases
  fine scale; raising the cap to 15.6k changed nothing, bit-identical).
  Solve-tail quality on blurry video = standing backlog item.

## 2026-08-27

- **Local runs library** shipped (IndexedDB, create→progress→persist→
  view/train/share/delete, 12 kept), capture tiles, ⋯ menus, delete
  prompts, Local Scene naming, wall refresh on return.
- **iOS silent-purge guard** — iOS can wipe WebGPU buffers of a hidden tab
  WITHOUT device-loss; training continued on garbage. Fix: pause on
  hidden + 64-splat sanity probe on return → recovery. Works in field.
- **EXIF capture-time sort** + landmarks-beat time overlay (iOS picker
  shuffles selection order; strict marker walk — resync wanders into
  embedded preview JPEGs).
- **SPA history navigation** (Back closes layers, no implicit truck
  preset at boot), document-scroll phone home so iOS renders under the
  collapsed URL pill.
- **Solve resolution arc** — phone featMaxDim 720→960 (user field result:
  15/45 → 35/45 photos registered), Solve resolution gear option added.
  **Feature-density law measured**: fixed 3900 features at 1600px =
  2.8× sparser → camping ATE 0.17%→0.34%; budget scaled ∝ area (8192
  cap = COLMAP parity) → 0.19%. Truck 40k at 1600 solve: poses were
  already COLMAP-identical (0.004% ATE over 251 cams) → no dB change;
  resolution pays only when registration-limited.
- **Camping 1920 solve**: first-ever 113/113 registration; trajectory-tail
  disagreement vs server COLMAP grows (0.42% vs 0.19% @1600) — later
  settled by the in-app A/B (see 08-28): the tail drift is ours.

### 2026-09-13c — the mouth relight artifact, confirmed and gone

User report on avatar 5647 (app pipeline, before the interior cull): a
lighting artifact on the mouth when the head turns away from the light, the
size of the inner-mouth mesh. Read the relight normals straight out of both
binding sidecars (`nrm:i8` block) and plotted the front 12 mm shell of the face
through the frontal SfM camera (`scratch/mouth_normals_cmp.jpg`):

- 5647: a mouth-shaped patch of normals pointing sideways/down — the splats on
  the lips took their normal from the cavity walls behind them. Lit 55° from
  the side, that patch lights up while the rest of the face is dark. That is
  the artifact.
- 5648 (same run with `cullHeadInterior`, escape-fraction cull): the patch is
  gone, normals continuous across the lips; the side-lit map has no blob.

Client renders (three-quarter + profile, relight on) agree but are subtle at
those angles; the normal map is the ruler for this. 5648 is the assigned dev
avatar. Tooling: `scratchpad/nrm_face2.py` (binding parser + normal/lambert
scatter), `scratch/bindings/{id}_binding.bin` fetched from the avatar row's
config json.

### 2026-09-16 — WEB-7774: the share that could not be pressed twice

QA report: train without an account → Share → register → come back → "the
button does nothing", and a reopened Local Scene offers only Train. Reproduced
all of it on the 12-photo synthetic set (`?iters=2000`, 2,052 cycles, 31.1 dB)
in a real tab. Three separate defects on the same path:

- **The dead button.** The sign-in page's "Register on Arrival.Space" link
  carries `target="_blank"`, so registering opens a tab of its own and leaves
  the sign-in popup sitting there. The abandoned round-trip keeps
  `S.uploading` true for its full 5-minute timeout, and the Share button's
  `if (!S.uploading)` guard swallowed every click in that window — no card, no
  message. Now the press brings the sign-in window back to the front and says
  so (`focusSignIn()`); closing that window frees the next press (measured:
  `uploading` false ~1 s after close, card reopens).
- **Sharing a stored run threw.** `shareCreation` read `S.session.trainer.iter`
  for the splatjs block, but a record shared from the wall has no live session
  (`S.session === null`, `S.splats === 0`): a TypeError *after* the sog upload
  and `create-space`, leaving an orphan space with no splatjs block — the
  reporter's "the splat isn't transferred / the space is missing". The record
  now carries its own numbers (`stats` override). Verified end to end against
  a locally stubbed API: the PUT stamps 59,088 splats, 2,052 cycles, 1 min,
  31.1 dB, 12 frames, 640×480 — the run's real figures, where it used to
  crash.
- **Reopened own run = Download.** `buildExport` treated every `S.restored`
  scene as a stranger's. A run out of this device's own library with no
  `spaceId` is still the creator's: it gets Share again (downloads stay listed
  in the sheet). Guarded in `train-smoke.spec.mjs`.

Also: a completed share now sets `S.share` and re-renders the controls, so the
scene on screen shows Enter space + its link instead of offering to make a
second space on the next press. Gates: `npm test` 8/8, e2e 8/8.

### 2026-09-16b — WEB-7773: managing a share you already made

The other half of the QA pair. The Community listing failure is the same
TypeError as WEB-7774 (a space created, never stamped with its `splatjs` block
— the gallery endpoint only ever returns spaces that carry one, confirmed in
`user_server/api/splatjs_shares.js`). The management half was never built:
`share.js` has exported `deleteShare` since the wall shipped **with no caller
anywhere in the app**, `setSharePrivacy` was reachable only through `?admin`,
and `creationTile(it, mine)` declared `mine` and never read it — so a creator
could publish to Community and had no way to take it back.

Now every share you own wears the ⋯ the local runs already had: Rename (PUT
`{title}` — the spaces endpoint maps title/description/privacy to
roomTitle/roomDescription/roomPrivacy), Copy link, take it out of / put it back
into Community (privacy Open ↔ Link Only — the gallery lists "Open" only, the
link keeps resolving either way), and Delete share, behind tileMenu's existing
two-tap arming. A run that made a share carries the same entries: deleting the
share clears the record's spaceId, so the tile offers Share again — which is
what the reporter could not do.

One trap worth remembering: the share tile is an `<a>`, and tileMenu's handlers
call stopPropagation, so a bubble-phase guard on the tile never sees the click
and the anchor navigates mid-menu. The guard has to be **capture**.

Also on the stats line: the machine that trained a scene, short —
`59,088 splats · 31.1 dB · PC, RTX 5080`, or `· iPhone` (a handheld's GPU string
says nothing anyone wants). `deviceLabel()` reads the platform off the UA and
the marketing name out of the existing `webglName()`; comma inside because the
line itself is separated by `·`. And a Discord "Feedback" link in the top bar
(data.js `DISCORD`, empty hides it).

Gates: unit 8/8, e2e 8/8. Verified against a locally stubbed API: rename,
listing toggle, delete, and a fresh share stamping `device: "PC, RTX 5080"`.

### 2026-09-16c — an account corner, kept to what it is

You cannot tell whether you are signed in: there was no account UI anywhere
outside `?admin`, and `forgetRevokedToken` drops the stored key on any 401
without a word — so "logged out" and "never signed in" looked identical.

The header now ends with the account: **Login** when this browser holds no key,
otherwise the visitor's picture and name (`GET /api/v1/user/me`), and a press
signs out — armed twice over, the same idiom as the tile menus. A key the
server no longer honours is forgotten when `whoAmI()` sees the 401, so the
corner falls back to Login rather than lying. Signing in stays what it always
was: a publishing credential, never a gate — capture, solve and training do not
touch it, and nothing asks for it until you publish.

The About card's promise is re-scoped in the same commit. "No server, no cloud,
no queue, no account" stopped being true the day sharing shipped, and a visitor
who reads it and then finds an account loses trust for good. It now reads
"Nothing is uploaded unless you publish", and says what publishing sends: the
finished model, not the photographs, unless the box is ticked.

Deliberately NOT built (proposed, judged too much for what it buys): a network
ledger in the About card showing bytes out at 0 until you publish — the claim
made checkable instead of asserted. Worth revisiting.

A trap the local server hid: `boot()` is called at the top level of app.js
(line 215) and therefore runs **while the module is still evaluating**, so the
icon const declared next to the new functions at line ~5077 was in its temporal
dead zone — `signedOut()` set the title and then threw. On localhost
`document.readyState` was still `loading`, boot deferred to DOMContentLoaded
after evaluation finished, and it worked perfectly. On live, with the script
warm, boot ran synchronously and the corner rendered EMPTY. Anything boot
touches has to be declared above it; the constant now sits at line 26. Caught
by the standing rule to verify live by fetch after a deploy — the local check
said fine.

Gates: unit 8/8, e2e 8/8 (resume.spec flaked once on the first run of the batch,
passed on two full re-runs and in isolation; no artifact survived).

### 2026-09-16d — unlisting where it matters: the Community tab

Reported straight after the last deploy: signed in, and the ⋯ was only on the
This device pane — the place you actually look at your scene the way everyone
else sees it, Community, had no menu at all (`creationTile(it, false, …)` for
every gallery tile). Now a Community tile you own carries the same menu, and
someone else's carries none; ownership comes from the ids in `/splatjs/mine`,
so presets are excluded for free (they are filtered out of that pane already).

Both panes now share ONE state object per space, so flipping the listing on the
Community copy relabels the This device copy, and a rename moves both captions
plus the run record that made the share. The privacy flip and the delete redraw
the wall, so the scene visibly leaves Community in front of the creator instead
of sitting there looking listed. Delete also clears `spaceId` on any local run
that made it — one code path now, `patchRunsOfSpace()`, instead of a callback
per call site.

Gates: unit 8/8, e2e 8/8. Verified against a stubbed API: your tile in Community
has the menu and a stranger's does not; "Take out of Community" sends one PUT,
the tile leaves the pane, stays under This device, and its menu there reads
"List in Community".

### 2026-09-16e — the listing where the scene is

Third report of the same shape: standing inside your own shared scene
(`?space=…`), Share opened the link card — link, Enter the space, Copy, the
downloads — and no way to put the scene into Community. The listing lived only
on the wall tile's menu, which is exactly where you are NOT when you are
looking at the thing.

The link card now carries a Listing row when the scene is yours: one call to
`/splatjs/mine` when the card opens decides that (no token, or not in the list
— the row stays hidden and a stranger's card is unchanged), the select shows
the stored privacy, and a change is one `PUT {privacy}`. A failed call puts the
select back where it was rather than leaving it lying about the state.

Pattern worth naming: every one of these three reports was the same miss — an
action offered in one surface and not in the others the user can reach the
scene from. Wall tile, Community tile, viewer card are three doors to one
space; anything you can do to a share should be behind all three.

The control is a checkbox — **Publish to Community** — not a privacy dropdown:
the card is not the moment for a taxonomy, it is the moment for one decision.
The first-time share form got the same treatment straight after (the select was
still sitting there): checked stores "Open", off stores "Link Only" — the same
two values as before, verified by the requests — with a line under it saying
which is which, and "Tell my followers" following the toggle instead of the
select's value. The submit button follows it too: **Share** when the scene goes
to Community, **Get link** when it does not — a button should promise what
actually happens, and nothing is published in the link-only case.
The tile menus use the same two words ("Publish to Community" / "Remove from
Community") so the three doors stop inventing their own vocabulary. A trap on
the way: `.sh-link input { width: 100% }` is the URL field's rule and it caught
the checkbox too, which ate the row and wrapped the label — scoped with
`input[type="checkbox"] { width: auto }`. The numbers said "one line, 13x13"
only after the screenshot said otherwise.

Gates: unit 8/8, e2e 8/8. Verified on the real 42485456_2385 share with only
/splatjs/mine and the PUT stubbed: the toggle reads the stored privacy, and
each flip sends one PUT (Open, then Link Only).

### 2026-09-16f — WEB-7704: the intro flight, measured off the one that works

The report: a splat uploaded to Arrival gets no intro cutscene from its camera
reconstruction. I searched splat-js and found no cutscene code in any commit,
and said so — wrongly framed. The user pointed at 42485456_9670, and the client
loading that space fetches
`ugc.arrival.space/splatjs/models/lab360_intro.path`. The benchmark scenes DO
carry camera-path intros; they were made by hand once (sequence id
`splatjsintro`) and no generator survives in the repo — `scripts/` is
gitignored. So: not a code regression, a capability that only ever existed as a
one-off. Reading the repo's absence and concluding "never worked" was the
mistake; the artefact was one fetch away.

That artefact then did the hard part. Rather than deriving the recon → space
transform from first principles, I fitted it against the working intro:

- **position** — ICP over all 48 signed axis permutations: `(x,y,z) → (-x,-y,z)`,
  i.e. Rz(180°), residual **0.13** in a scene of radius 12.9. Next best
  candidate: 1.12. That is `createUserModel`'s default rotation for a `.sog`
  (`{x:0,y:0,z:180}`), which the model entity of every splat.js space gets.
- **rotation** — four camera-basis candidates: `q = quat(Rz(180) · Rᵀ ·
  diag(1,-1,-1))`, median error **0.20°** (the solver looks down +Z with +Y
  down, PlayCanvas down -Z with +Y up). Every other candidate was ~180° out.

`app/js/introcam.js` builds that Sequence from the run's own cameras — the
viewer's tour rules (collapse co-located rig poses, fly the longest unbroken
segment) so the space opens on the flight the creator already watched — uploads
it as a `.path`, and hangs it on the space as `user-model-introcam-<spaceId>`
with `autoPlay`, the same entity id the platform's own migration writes.
Wired into both Share and Upload, best-effort: a failed intro never fails an
upload.

Verified by regenerating the Lab's intro from its own recon: **55 keys vs the
authored 57, 33.8 s vs 34.0 s, position median 0.111 (p90 0.288) in a 12.9
scene, rotation median 0.01°**. One bug caught by that comparison and nothing
else: I had dropped the tour's `if (d > 1e-9)` when taking the median step, so
on a 360 rig — five of every six gaps are zero — the median collapsed to the
1e-3 fallback and every real stride read as a capture break. 112 panoramas came
out as a 5-node path. With the zeros excluded it is 55.

Gates: unit 8/8, e2e 8/8. The .path upload and the entity POST were exercised
against a stubbed API (`local_scene_intro.path`, 4.6 KB, then
`POST /spaces/<id>/entities` with entity_id `user-model-introcam-<id>`,
autoPlay true). Still unproven: a camera actually flying in a real space — that
needs a published scene on the account.

### 2026-09-16g — the toggle that vanished, and a moderator's broom

Two from the same afternoon's use.

**The toggle went missing right after a link-only share** — and came back on
reload, which is the whole diagnosis: the link card asked `/splatjs/mine`
whether the scene was the visitor's, and the row a share had just written is
not in that list the instant it is written. The card was racing the platform
for an answer the app already had. It now records what it chose —
`S.share = { id, title, privacy }` — and only falls back to the server when the
privacy is unknown (someone else's link opened cold). `fetchMine` also asks
`cache: 'no-store'`, since that list changes the moment anyone shares.
Reproduced and guarded with a spec that stubs `/splatjs/mine` to return NOTHING:
it fails without the fix (the row stays hidden) and passes with it.

**A moderator can now clear any scene off the wall.** `/user/me` already
carries `isAdmin` and `canEditSpace` already returns true for an admin — which
is what the `?admin` sheet has always leaned on — so the wall just needed to
ask. Every Community tile gets the ⋯ for an admin: Copy link, and Remove from
Community, which sets privacy to "Link Only". Unlisting, never deleting: the
creator keeps the scene and the link keeps resolving. `whoAmI()` is memoised so
the header chip and the wall share one request, and signing out clears it.

Kept as a real test (`community_moderation.spec.mjs`, stubbed, no GPU): a plain
visitor gets NO menu on a scene that is not theirs, and a moderator's first
press only arms — the PUT fires on the second, and carries exactly
`{privacy: "Link Only"}`. A permissions rule deserves a guard.

Gates: unit 8/8, e2e 10/10.

### 2026-09-16h — the share card keeps its own result

Pressing Share (or Get link) closed the card, threw the progress into the
corner note and left the finished link there too — the one thing the visitor
actually wanted, in the one place they were not looking. The card stays open
now: the form gives way to a status line and a progress bar (the `.prep-meter`
the compressor already uses), the heading says what is happening ("Publishing
your scene …" / "Making your link …"), and when the space is made the card
becomes the result — the link, Enter the space, Copy link, with the downloads
still underneath. A failure puts the form back so the press can be repeated.
The corner note survives for exactly one case: the visitor closed the card
while it worked, and then it is all there is.

Caught a self-inflicted one on the way. The share and upload handlers share an
identical opening block, and a whole-file replace took the FIRST match — so the
new progress code landed in `uploadDialog`, which has no `.sh-form` and no
`privacy` in scope: Upload would have thrown a ReferenceError on press.
`node --check` was happy, because an undefined identifier is a runtime problem.
What found it was a MutationObserver-style trace on the removal — overriding
`Element.prototype.remove` and printing the stack said `close()` at
app.js:3575, i.e. the handler I thought I had edited was untouched. Anchor
edits on something unique to the function, and when a test says "the thing you
changed did not change", read the stack before re-reading the diff.

Gates: unit 8/8, e2e 11/11 (`share_card_flow.spec.mjs` holds create-space open
to catch the working state, then asserts the link lands in the card).

### 2026-09-16i — a shared scene that forgot it was shared

Reported from a real sitting: Benchmarks → Synthetic Corner → train → Share →
Get link. Two faults in one flow.

**The switch was missing from the result.** My own hour-old change: the card
now ends on its link, but I built that result block with the link, Enter and
Copy and no listing switch — so choosing "link only" read as final. It is not a
one-shot decision; the switch belongs on the card that just made the link, and
now sits there, wired by the same helper the link card uses (one
`wireListing(row, box, spaceId, privacy)` instead of two copies).

**A reload lost the Share button entirely.** Reopening the run from This device
gave a Download and nothing else. `buildExport` reads `S._localRun.spaceId` to
decide a run is "still the creator's to share" — and once a run HAS been
shared, that check fails, while `S.share` is null on a fresh load (it is only
set by a `?space=` link or by sharing in this tab). So a shared run reopened
after a reload fell through to the stranger's branch. `restoreSession` now
reads the record: a run with a `spaceId` opens as the shared scene it is, with
its link, its listing switch and Enter space.

Guarded by `share_reopen.spec.mjs`, which walks exactly the reported path. Both
halves were checked against the unfixed code: without the result-card switch
the row stays `hidden`, without the restore line `window.__splat.share` is
`undefined` after the reload.

Gates: unit 8/8, e2e 12/12.

### 2026-09-16j — the address bar stops naming the scene you left

Reported while retraining: the URL keeps `?space=<old id>` after Train on a
shared scene. Reading it is confusing, and a refresh mid-run reopened that old
scene instead of the run. `startPrep()` consumed the detail card's history
entry but never touched the query. It now drops the scene keys — space, model,
recon, frame, cmp — and keeps the tuning flags (?iters, ?ipf, ?api …), which
describe the run that is actually starting. Guarded by `run_url.spec.mjs`
(fails against the unfixed code: the id is still there).

The privacy question from the same sitting closed itself: Get link produces
Link Only spaces, as the code reads. Nothing changed there.

**Open, not mine:** `resume.spec.mjs` fails intermittently in FULL-suite runs
and passes alone every time — twice this morning before any of today's work,
and again now. The assertion is real (`post.posAliveMax` 5.954 against a ±5 %
band on the pre-pause value, resume.spec:62), i.e. the resumed model's alive
extent moves more than the guard allows. It resumes purely from IndexedDB and
never reads the URL, so today's app/js work cannot reach it. Worth chasing as
its own question, with the suite order in mind — a stubbed UI spec now runs
before it.

### 2026-09-16k — the intro flies the tour's curve, not the raw poses

The intro cutscene read rougher in the space than the same path does in the
viewer, and the reason was exactly as the user guessed: `startTour` smooths,
`introcam` did not. The exporter was handing the platform a polyline of camera
shake — one keyframe per deduped pose, evenly spaced in TIME, so the camera
also lurched between close and distant poses.

It now runs the tour's own recipe: positions smoothed over ±3 neighbours with
triangular weights, quaternions sign-aligned and slerped twice towards their
neighbours' midpoint, a Catmull-Rom through the smoothed points, and keyframes
sampled at EQUAL ARC LENGTH so the player's own interpolation moves at constant
speed. `quatFromR` / `quatToR` / `qslerp` moved into viewport.js next to
`camCentre` and both callers import them — one copy of the maths, since the
viewer's flight and the space's flight are meant to be the same flight.

Measured on the Lab capture, regenerating its intro three ways (turn angle per
key, and step-length spread as σ/mean):

| | raw poses (before) | smoothed (now) | hand-made reference |
|---|---|---|---|
| turn median | 4.62° | **4.10°** | 5.25° |
| turn p90 | 17.94° | **12.09°** | 15.37° |
| worst corner | **72.25°** | **33.52°** | 29.20° |
| speed spread | 0.539 | **0.004** | 0.392 |

The worst jerk halved and the speed is now constant — the hand-made one it is
judged against carries ±39 % speed variation, so the export is, on that axis,
smoother than the thing being copied.

Two lessons from the same hour. A spec that says "the tour never starts" can
mean the tour was ALREADY running and the click toggled it off — `#c-play`
stops what a finished run starts by itself; read the state before pressing.
And `tour_smoke.spec.mjs` now guards the shared half, because moving maths out
of a 5,000-line file deserves a test that flies it.

Gates: unit 8/8, e2e 14/14 (resume.spec passed this time; see 09-16j).

### 2026-09-16l — the benchmark flights, re-exported

Regenerating the nine benchmark intros with the smoothed exporter turned up two
things the Lab alone had not shown.

**Uniform arc-length keys are not enough.** The first pass read: Garden 35.9°
of turn per key on median, Bicycle 24°, and worst-case kinks of 120-169° on the
walks (Truck, Playroom, Train, Bar, Camping). The medians were sampling — I was
thinning the nodes to 60 BEFORE splining, throwing away the path — and the
spikes were real U-turns in the captures, each landing whole between two keys.
Fixed by spending keys where they buy something: keys sit at equal COST
(distance in base-key units + turning in 8° units) while their frame numbers
follow ARC LENGTH, so a corner gets several keys and is rounded, and the speed
stays constant. Node thinning is gone; the ceiling is 480 keys (~170 KB against
a 4-20 MB .sog).

| scene | worst turn before | after |
|---|---|---|
| Truck | 142.1° | 25.9° |
| Playroom | 159.1° | 61.3° |
| Train | 120.2° | 24.7° |
| Bar | 131.5° | 20.7° |
| Camping | 168.6° | 29.8° |
| Lab | 44.4° | 6.9° |

Every scene now sits at or under the hand-made reference (median 5.25°, p90
15.4°, worst 29.2°); Playroom keeps one 61° corner, a reversal sharper than the
spline's 8-subdivisions-per-node can resolve.

**Those spaces do not hold their model at the origin.** Fitting each new flight
onto the authored one (translation-only ICP) gave a residual of 1-10 % of the
path extent — which PROVES the file-to-scene mapping, nothing else would fit —
and a model offset of ≈(0, 1.19, -4.0) on seven of nine, with Truck
(1.53, 1.18, -2.75) and the Bar (-10.36, 1.59, 10.26) genuinely elsewhere. The
exporter assumes the origin, which is what `createUserModel` gives a NEW space,
so each re-export carries its own measured offset instead.

Uploaded over the same CDN keys (originals backed up first). Note for next
time: `ugc.arrival.space` sits behind Cloudflare AS WELL as CloudFront — a
CloudFront invalidation left the bare URL serving a 24 Aug copy with `Age:
9673` and a 7-day TTL. The client always requests `?v=<updatedAt>`, and every
versioned URL returns the new file, so this is invisible in production; the
bare URL is the one to distrust when checking by hand.

**Open:** whether a freshly shared space needs that offset too. The nine
benchmarks were placed by hand or by an older script, and `restamp_space.mjs`
only swaps glbUrl. One published scene, opened and looked at, settles it.

### 2026-09-16m — the Truck was flying the previous solve's world

Reported: the truck is not framed. It was, and the cause is worth keeping.

Fitting each authored intro against its OWN recon cameras (a far tighter
correspondence than path-to-path — the authored keys were BUILT from those
cameras) splits the nine benchmarks in two:

- Train, Garden, Lab, Camping, Bicycle: residual 0.2-1.1 % of scene radius, all
  at ≈ **(0, 1.195, -4.01)**, scale 1. That is where a splat.js space holds its
  model, confirmed five times over.
- Truck, Bar, Synthetic: residual 7.6-10.4 %. Adding a uniform scale to the fit
  explains them — Truck's old intro only matches its cameras at **scale 1.854**
  — and those are exactly the three spaces whose models were re-stamped
  (`truck_1h_v3_2026-09-06`, `bar360_v6_2026-09-08`,
  `synthetic_needle_v2_2026-09-08`). A new training run is a new SOLVE, and a
  solve's world frame and scale are arbitrary: the intro kept flying the old
  one. My first re-export inherited that by fitting to the stale path.

The three now use the consensus placement with their CURRENT recon, which is
the same frame as the model they sit next to — the only thing framing needs.
The new Truck flight spans 3.7 m where the old spanned 6.0, the 1.85 again.
The Bar spans 69 m, which looked alarming until the original turned out to
span 63.7: that venue really is that size in its own units.

**Standing rule this implies:** re-stamping a space's model invalidates its
intro cutscene. `restamp_space.mjs` swaps `glbUrl` and nothing else, so the
flight has to be regenerated from the new recon at the same time — otherwise
the camera drifts off the subject by however much the two solves disagree.

Originals of all ten .path files are in the session's `intro_backup/`.

### 2026-09-16n — the file a space plays is not the file you found

Closing the Truck: every correction above was written to
`ugc.arrival.space/splatjs/models/truck_intro.path`, and the space plays
`ugc.arrival.space/42485456/truck_intro.path` — a byte-identical copy of the
original under the owner's own prefix, put there when the entity was attached.
So the space kept flying the pre-restamp path (43 keys, y 1.22-1.96) against a
model whose cameras sit at y 0.15-0.43 in a 3.8 m scene: too high and off
centre, exactly as reported, and nothing to do with the offset maths I kept
adjusting.

The mistake to remember: fitting a `.path` against a scene's recon proves the
file was BUILT from that capture. It says nothing about which file the space
REFERENCES. When an edit to a live artefact appears to do nothing, list the
bucket for other copies before assuming a cache — `aws s3 ls
s3://ugc.arrival.space/<ownerId>/ --recursive | grep .path` answered it in
thirty seconds, after an hour of refining the wrong file.

Attached cutscenes also live at `<ownerId>/api_uploads/<hash>_<name>.path` when
they were uploaded through the API, so a space may reference any of three
locations for what looks like one artefact. Without entity read access the only
honest way to know is to ask whoever attached it.

### 2026-09-16o — two keys on one frame, and the model transform nobody asked for

The user watching the Truck cutscene: "it seems it struggles", then the
diagnosis — **two keyframes on the same frame are not interpolated**. Counted
it: of Truck's 379 keys over 720 frames, **79 sat on the same frame as their
predecessor and 57 more were one frame apart**. The cause is structural: keys
are placed by TURNING while their clock follows DISTANCE, so a tight corner
advances the arc by almost nothing and rounds several keys onto one frame. The
denser I made it to fix corners, the more it collided.

Now every key keeps `MIN_FRAME_GAP = 3` (a corner simply takes a little
longer, which is how a corner should feel), the budget is back to the cadence
the player is known to handle — 1.5 keys/s plus one per 20° of turning, capped
at 90, against hand-made originals of 12-57 — and the count is clamped to
`span / gap` so collisions cannot be requested in the first place. Zero
same-frame keys across all nine, and the flights still beat the originals
(Garden median 59.8°→23.9°, Bicycle 42.8°→20.4°, Truck worst 169.7°→56.3°).

Then the entity read that should have come first. The nine benchmark models are
NOT placed alike:

| space | position | rotation | scale |
|---|---|---|---|
| Truck | 0,0,0 | 0,0,180 | 1 |
| Playroom, Bicycle, Bar, Lab, Camping | 0,1.2,-4 | 0,0,180 | 1 |
| Train | -0.29,1.05,-5.56 | 10.7,0,-178.9 | 0.7 |
| Synthetic | -0.40,1.49,-4.97 | -1.1,-4.4,178 | 0.77 |
| Garden | 0,2.60,-4 | **-25.9**,0.1,176.3 | 1 |

So the "consensus offset" fitted earlier was real — it was those five models'
actual position — while three spaces are tilted and scaled by hand and one sits
at the origin. `buildIntroSequence` now takes the model's transform and places
the flight as `P + R(euler) · (scale · X)`, with the camera basis turned the
same way, using PlayCanvas's own euler->quat so the angles mean what the editor
means. Validation: the Lab rebuilds to camera height 1.16..1.45, the hand-made
file's exact range.

All nine republished under stamped filenames with their entities repointed —
overwriting in place is not publishing here (Cloudflare sits in front of
CloudFront and kept serving a week-old copy), and a new URL is the only
reliable cache break.

### 2026-09-23 — WEB-7811: "Forgot your password?" on the sign-in popup

The Upload/Share sign-in popup is the backend's OAuth page (`backend_git/user_server/api/mcp-oauth.js`), and it had no password reset. It now has a "Forgot your password?" link under the password field, visible only once "Sign in with Email" is chosen. It sends the existing arrival.space reset mail (`/sendPasswordResetMail`) and keeps the popup open. backend 5d22d0c, on dev, not live. Nothing changed in Splat.js.
