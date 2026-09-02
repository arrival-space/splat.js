# Lab log

What we tried, what it did, what it cost. Newest first. PSNR numbers are
held-out (eval8) unless noted; "noise band" on repeated truck 40k runs is
about ±0.1 dB.

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
