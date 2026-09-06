# Lab log

What we tried, what it did, what it cost. Newest first. PSNR numbers are
held-out (eval8) unless noted; "noise band" on repeated truck 40k runs is
about ±0.1 dB.

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
