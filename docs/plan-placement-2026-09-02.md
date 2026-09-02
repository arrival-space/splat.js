# Plan: placement / prune / base semantics — ordered for max PSNR

Written 2026-09-02, after the thinness-ban day (lab log 2026-09-01).
Target: close the remaining 0.54 dB to Brush-native (truck 30k, frozen
poses, eval8: needle set 25.53 / repeat 25.15 vs Brush 26.07), without
regressing garden, and end with a default that external viewers render
exactly as trained.

## Facts the order is built on

- Bench cell (truck, 30k, 1.05M cap, frozen poses `scratch/truck_ab_recon.json`)
  costs ~7 min. Run-to-run noise on the needle config is ~0.37 dB
  (25.53 vs 25.15, same cell), because the camera schedule
  (`trainer.js:719`, `this.rand = Math.random`) and every refine draw
  (`refine(rng = Math.random)`) are unseeded.
- Default refine path is `_refineLegacy` (`trainer.js:1373`): relocation
  births a 0.25-opacity jittered clone of a uniform donor (o > 0.4), fresh
  Adam moments; growth 5 %/refine (bench) until 0.75·horizon; six full
  buffers round-trip through the CPU every refine (~770 MB at 1.05M/SH3).
  `_refineV2`/`_refineV3` (eq-9 conserving, error-mass donors, GPU plan
  buffer) exist but are opt-in and were last judged UNDER the thinness ban.
- Opacity ratchet: `opa·comp < A_MIN` ⇒ culled ⇒ no data gradient, while
  the Adam kernel subtracts `opacityReg` every step ⇒ logit → −9.
  Fresh 30k run: 6.4 % dead at export; classic-era flagships > 50 %.
- Export bake (`src/io/ply.js:33`) hard-codes `+0.3` and an ISOTROPIC
  mean-scale approximation of the Mip comp. Under the needle set
  (dilate 0.1, needles with thin/long ratio 50+) both assumptions are
  wrong → exported models are NOT what the bench measured.
- Brush semantics: dilate 0.3, NO opacity compensation, no aniso spring,
  tiny min scale. That is also what every external rasterizer does.

## Rungs (in execution order)

| # | Change | Code touch | Gate | Expected | Why here |
|---|--------|-----------|------|----------|----------|
| 0 | `seed` opt: mulberry32 for camera schedule + refine rng; bench `?seed=` | trainer.js 601/719/1174, bench_run.js | 2 same-seed repeats of the needle cell: spread must drop well under 0.37 | 0 dB, halves every later gate's cost | Every gate after this is cheaper and sharper |
| 1 | `mipComp` opt (default on): comp ≡ 1 in project + chain kernels; bench `?comp=0` | shaders.js cutConsts + 273/284/973, trainer.js opts | Cells: A = dilate 0.3 / comp 0 / aniso 0 / ms 1e-5 (Brush-exact); B = dilate 0.1 / comp 0; C = current needle (dilate 0.1 / comp 1). 2 seeds each | A ≥ C −0.1 → adopt A as BASE | Fixes the base representation before any placement work (otherwise every placement verdict is retaken again), and A makes exports viewer-exact with no bake |
| 2 | Ratchet fix + dead telemetry: opacityReg only for splats that received a data gradient this step (touched flag from render bwd, or `v > 0`), logit floor −7; refine returns `dead`, `relocated`, `survived` (relocated last round still alive); metrics emit `deadN` | shaders.js adam kernel (~1228), trainer.js refine paths, session.js metrics | Same base as rung 1 winner, 2 seeds; deadN at 30k must fall from 6.4 % toward < 1 %; PSNR ≥ base | +0.05…0.15 (30k), much more on long runs | Cheap; changes the population every later rung operates on |
| 3 | Placement matrix, NO new kernels — retest the existing opt-in knobs on the new base: (a) `refineV2:true` (eq-9 relocation, GPU plan), (b) `errDonors`, (c) `splitV2`, (d) `refineEvery` 100/250/500, (e) `growUntil` 0.5/0.75/0.9, (f) `growRate` 0.05/0.15 | bench_run.js passthroughs only | One-factor-at-a-time from the base, 2 seeds; keep a factor only if mean ≥ +0.1; then the combination of keepers, 3 seeds; garden confirm on the combo | +0.2…0.4 — this is the "placement" 0.54 | Highest dB per hour: code exists, all prior verdicts were taken under the ban |
| 4 | Capacity retest: 2M cap and `capMult` on the rung-3 combo | none | 2 seeds truck | 0…+0.2 | Only meaningful after placement is fixed (2M was −0.4 under the ban) |
| 5 | GPU compaction (true prune): mark → scan → scatter over params/m/v/sh, one cap-sized scratch, hysteresis (compact when dead > 3 %), at growth freeze and near horizon; relocation budget tapered instead of stopped | trainer.js new kernels + shaders.js | Fixed-ITERS PSNR must be ≥ combo (it should be neutral); WALL-CLOCK-matched run (same minutes) must be ≥ +0.1; splat count and export size reported | ~0 at fixed iters, + via speed; −files | "Speed and splat count" — sequenced after 3 because with relocation live the whole horizon, prune's PSNR value is already captured; compaction pays in ms/iter and MB |
| 6 | LR retests on the new base: `poslr` (0.07 of ours ≈ Brush), SH ramp off, opacity LR | bench passthroughs | 2 seeds each, keep at ≥ +0.1 | +0.1…0.2 | Previously negative only under the ban |
| 7 | Mip 3D smoothing filter (per-splat max-frequency from training cams) | trainer.js init + after refine, shaders.js | Only if rung 1 picked B/C (dilate < 0.3): try dilate 0.05/0 with the filter | +0.1 if needed | Conditional — skipped entirely if A wins |
| 8 | Default flip + consistency: new defaults in app + bench; export bake = identity when comp off (else exact anisotropic comp with the real dilate); verify pcview.js / SuperSplat render the exported PLY at parity (screenshot diff vs trainer view); README/matrix re-baseline; flagship re-exports with user approval | app.js, ply.js, session.js, README, baselines | Live URL fetch after deploy; e2e green; 18-cell matrix rerun | — | Ships only after 1–6 settle |

## Status (kept current; details in docs/lab-log.md)

| # | Verdict |
|---|---------|
| 0 | PASS — same-seed spread 0.006 dB; cross-seed 0.19 is the floor |
| 1 | PASS — A adopted (3 seeds: A 25.37 mean vs C 25.29); rung 7 skipped |
| 2 | DROPPED — regvis −0.02 / −0.15; dead 0 % ⇒ relocation never fires; the unconditional reg is the MCMC death signal, not a bug. Telemetry kept |
| 3 | CLOSED — KEEPERS: refineV2 (+0.12) and growRate 0.1 (+0.25); combo +0.30 → truck 25.67, garden +0.03. Rejected: errDonors, splitV2, growUntil, refineEvery 250/100 (cadence itself hurts under refineV2) |
| 4 | DIAGNOSED — "2M" cell is really 1.61M (cap = seed·capMult = 25,141·8·8): −0.61 mean, 59 % dead at the cap, 0.5 dB same-seed chaos. Entry budget cleared (overflow 0). Regs ×0.65 at 1.61M +0.4…1.0 while the same at 1.05M is −0.23 → reg weight must scale 1/n. 4c attribution: the recovery is the OPACITY reg alone (or-only at 1.61M 25.70 = first high-capacity cell at par with 1.05M; scaling scaleReg along −0.15; stronger reg during growth −0.12) → `opts.opaRegRefN` / `opaRegRefMax` (opacity only, factor ≤ 1). 4d donor draw ∝ opacity / err×opa (MCMC-exact) rejected (−0.09 / −0.12). 4e: 1/n rule at 1.61M over 2 seeds −0.30 (seed 2 always 0.4–0.6 under seed 1 at that capacity) → **DROPPED** by the stop rule; `opaRegRefN` opt-in, 1.05M stays the cap. 1.05M side: opacityReg flat 0.0065–0.01, cliff at 0.015 (−0.28) |
| 5 | RE-RANKED behind 4/6: with moveCap 0.25 every dead splat is relocated each refine, so compaction cannot cut n or ms/iter at fixed cap; only worth building if a keeper raises deadPct |
| 6 | poslr 0.07 −0.14 (rejected, third time), poslr 0.3 +0.07 / 0.5 +0.08 (4 of 4 cells up, under the keep line → separate arm in the garden confirm), SH ramp off −0.18 (rejected). Garden confirm of poslr 0.5: +0.04 / +0.01 — non-regressing, still under the line → documented arm, not a default |

## Gate protocol

- Truck first (7 min/cell), garden only to confirm keepers (never to
  screen). Same seed pairs across arms; report mean and spread.
- Decision thresholds: keep ≥ +0.1 mean over 2 seeds (3 seeds when the
  two disagree by > 0.2); any garden regression > 0.1 rejects.
- Every cell writes `scratch/*.ply` via `?postply=` and gets the
  `splat_stats.mjs` table appended to the lab log — a PSNR move without a
  distribution move (or vice versa) is a flag, not a result.
- Stop rule per rung: two negative cells in a row → drop the rung, note in
  lab log, move on. No rung is retried with "one more knob".

## Not in this plan (deliberately)

Device/location share fields, VR button, thumb-pack regeneration, sw.js
warnings — UI work, unaffected by any of this. Robust loss / D-SSIM stay
opt-in (re-verdict negative under the needle set).
