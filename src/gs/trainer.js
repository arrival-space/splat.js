// trainer.js — WebGPU 3DGS optimizer (anisotropic, sorted; see shaders.js).

import {
  STRIDE, TILE, ENTRIES_CAP, makeProjectSrc, makeRenderSrc, makeChainSrc,
  SCAN_SRC, SCATTER_SRC, SORT_SRC, ADAM_SRC, SH_ADAM_SRC, BLIT_SRC, shRestCoefs,
  GATHER_SRC, REFINE_APPLY_SRC, SSIM_SRC, makeSsaaLossSrc,
} from './shaders.js';
import { rodrigues, m3mul, makeRng } from '../sfm/geometry.js';
import { createGpu } from '../gpu/context.js';

export class GSTrainer {
  /** opts.gpu: a GpuContext from createGpu() — share ONE device between the
   *  trainer and the SIFT matcher. When omitted, a private one is created. */
  static async create(opts = {}) {
    const gpu = opts.gpu || await createGpu(opts);
    return new GSTrainer(gpu.device, opts, gpu.info || {});
  }

  constructor(device, opts = {}, gpuInfo = {}) {
    this.device = device;
    this.opts = opts; // { eCut, aMin, opacityReg } — gradcheck uses strict cutoffs
    this.gpuInfo = gpuInfo;
    // Tile-shared gradient accumulation (see makeRenderSrc): built for Apple
    // (TBDR) GPUs where contended global atomics are ruinous, but measured
    // FASTER on desktop NVIDIA too (+11% synthetic it/s) — default ON
    // everywhere; opts.tileGrad = false restores the direct path.
    this.tileGrad = opts.tileGrad ?? true;
    this.iter = 0;
    this.pixelsSeen = 0;
    this.stride = STRIDE;
    // view-dependent color: SH degree (0 disables; coeffs live in a separate
    // channel-major buffer of 3*shK floats per splat)
    this.shDeg = opts.shDeg ?? 3;   // degree 3 is the standard since 2026-08-24 (matches the INRIA reference)
    this.shK = this.shDeg > 0 ? shRestCoefs(this.shDeg) : 0;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this._buildPipelines();
  }

  _buildPipelines() {
    const d = this.device;
    const mk = (code, label) => d.createShaderModule({ code, label });
    // screen-space AA dilation (px^2 added to the 2D covariance diagonal).
    // 0.3 = the classic 3DGS constant; with Mip opacity comp it is ALSO the
    // floor on how thin a splat can render (thinner axes fatten AND fade),
    // which is what text/edge ringing compensates for. Lowering it trades
    // that floor against distant-texture aliasing.
    this.dilate = this.opts.dilate ?? 0.3;
    // opts.mipComp false: no opacity compensation for the dilation (Brush /
    // classic-3DGS semantics, and what external viewers rasterize)
    this.mipComp = this.opts.mipComp ?? true;
    this.pipeProject = d.createComputePipeline({
      label: 'project', layout: 'auto',
      compute: { module: mk(makeProjectSrc(this.opts.eCut, this.opts.aMin, this.opts.radClamp, this.shDeg, this.dcMode, this.dilate, this.mipComp), 'project'), entryPoint: 'main' },
    });
    // the (key,id) entry budget scales with an explicit splat ceiling — the
    // fixed 12M cap silently dropped tiles at 800k splats (fast iterations,
    // collapsing PSNR); default unchanged unless maxSplats is raised
    this.entriesCap = this.opts.entriesCap ??
      (this.opts.maxSplats ? Math.max(ENTRIES_CAP, this.opts.maxSplats * 24) : ENTRIES_CAP);
    // SSAA renders ssaa^2 x the pixels; entries scale with covered pixels
    this.ssaa = this.opts.ssaa ?? 0;
    this.gradFixed = this.opts.gradFixed ?? 16384;
    // engine v2: clean Brush-style optimization system on the same renderer
    this.v2 = this.opts.engine === 'v2';
    this.dcMode = this.v2 ? 'sh' : 'sigmoid';
    if (this.ssaa >= 2 && !this.opts.entriesCap) this.entriesCap *= 2;
    this.pipeScan = d.createComputePipeline({
      label: 'tile-scan', layout: 'auto',
      compute: {
        module: mk(SCAN_SRC, 'tile-scan'), entryPoint: 'main',
        constants: { ENTCAP: this.entriesCap },
      },
    });
    this.pipeScatter = d.createComputePipeline({
      label: 'tile-scatter', layout: 'auto',
      compute: { module: mk(SCATTER_SRC, 'tile-scatter'), entryPoint: 'main' },
    });
    this.pipeSort = d.createComputePipeline({
      label: 'tile-sort', layout: 'auto',
      compute: { module: mk(SORT_SRC, 'tile-sort'), entryPoint: 'main' },
    });
    // subgroup-aggregated gradient atomics — DEFAULT OFF (2026-08-25):
    // Tint only allows subgroup builtins in fully-uniform flow, and the
    // unconditional 10-reduction flush that satisfies it TDR-crashed truck
    // training; the subgroupAny-gated version fails validation (Tint's
    // uniformity analysis doesn't track subgroup-uniform conditions).
    // Revisit when the analysis learns subgroup scopes.
    this.subgroupAgg = this.tileGrad && (this.opts.subgroupAgg ?? false) &&
      d.features && d.features.has('subgroups');
    this.pipeRender = d.createComputePipeline({
      label: 'render', layout: 'auto',
      compute: { module: mk(makeRenderSrc(this.opts.eCut, this.opts.aMin, this.tileGrad, this.subgroupAgg, 0, 0.2, 2, this.dilate), 'render'), entryPoint: 'main', constants: { FIXED: this.gradFixed } },
    });
    // D-SSIM loss (opts.ssimWeight > 0): split renderer + image passes.
    // The fused kernel stays untouched for the default path.
    this.ssimW = this.opts.ssimWeight ?? (this.v2 ? 0.2 : 0);
    if (this.ssimW > 0 && this.ssaa >= 2) throw new Error('ssimWeight and ssaa are mutually exclusive');
    if (this.ssimW > 0 || this.ssaa >= 2) {
      this.pipeRenderFwd = d.createComputePipeline({
        label: 'render-fwd', layout: 'auto',
        compute: { module: mk(makeRenderSrc(this.opts.eCut, this.opts.aMin, this.tileGrad, this.subgroupAgg, 1, 0.2, 2, this.dilate), 'render-fwd'), entryPoint: 'main', constants: { FIXED: this.gradFixed } },
      });
    }
    if (this.ssaa >= 2) {
      // supersampled training: raster at ssaa x, box-downsample + loss at 1x
      this.pipeRenderBwd3 = d.createComputePipeline({
        label: 'render-bwd-ssaa', layout: 'auto',
        compute: { module: mk(makeRenderSrc(this.opts.eCut, this.opts.aMin, this.tileGrad, this.subgroupAgg, 3, 0, this.ssaa, this.dilate), 'render-bwd-ssaa'), entryPoint: 'main', constants: { FIXED: this.gradFixed } },
      });
      this.pipeSsaaLoss = d.createComputePipeline({
        label: 'ssaa-loss', layout: 'auto',
        compute: { module: mk(makeSsaaLossSrc(this.ssaa), 'ssaa-loss'), entryPoint: 'main' },
      });
    }
    if (this.ssimW > 0) {
      this.pipeRenderBwd = d.createComputePipeline({
        label: 'render-bwd', layout: 'auto',
        compute: { module: mk(makeRenderSrc(this.opts.eCut, this.opts.aMin, this.tileGrad, this.subgroupAgg, 2, this.ssimW, 2, this.dilate), 'render-bwd'), entryPoint: 'main', constants: { FIXED: this.gradFixed } },
      });
      const ssimMod = mk(SSIM_SRC, 'ssim');
      const sp = (entry, constants) => d.createComputePipeline({
        label: `ssim-${entry}`, layout: 'auto',
        compute: { module: ssimMod, entryPoint: entry, ...(constants ? { constants } : {}) },
      });
      this.pipeSsimPrep = sp('prep');
      this.pipeSsimBH15 = sp('blurH', { NCH: 15 });
      this.pipeSsimBV15 = sp('blurV', { NCH: 15 });
      this.pipeSsimCoeff = sp('coeff');
      this.pipeSsimBH9 = sp('blurH', { NCH: 9 });
      this.pipeSsimFinal = sp('finalv');
    }
    this.pipeChain = d.createComputePipeline({
      label: 'chain', layout: 'auto',
      // anisoReg default 0.005 (was 0.02): with SIFT-grade poses the needle
      // pathology is gone (camping p99 ratio 42:1) and the stronger pull
      // toward isotropy measurably blurs edges (-0.8dB holdout on train-84)
      compute: { module: mk(makeChainSrc(this.opts.anisoReg ?? (this.v2 ? 0 : 0.005), this.shDeg, this.dcMode, this.opts.statMax ?? false, this.dilate, this.mipComp), 'chain'), entryPoint: 'main', constants: { FIXED: this.gradFixed } },
    });
    this.pipeAdam = d.createComputePipeline({
      label: 'adam', layout: 'auto',
      compute: { module: mk(ADAM_SRC, 'adam'), entryPoint: 'main' },
    });
    if (this.shK) {
      this.pipeSHAdam = d.createComputePipeline({
        label: 'sh-adam', layout: 'auto',
        compute: { module: mk(SH_ADAM_SRC, 'sh-adam'), entryPoint: 'main' },
      });
    }
    this.pipeGather = d.createComputePipeline({
      label: 'refine-gather', layout: 'auto',
      compute: { module: mk(GATHER_SRC, 'refine-gather'), entryPoint: 'main' },
    });
    this.pipeRefineApply = d.createComputePipeline({
      label: 'refine-apply', layout: 'auto',
      compute: { module: mk(REFINE_APPLY_SRC, 'refine-apply'), entryPoint: 'main' },
    });
    const blitModule = mk(BLIT_SRC, 'blit');
    this.pipeBlit = d.createRenderPipeline({
      label: 'blit', layout: 'auto',
      vertex: { module: blitModule, entryPoint: 'vs' },
      fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format: this.canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * gaussians: { data: Float32Array (n*STRIDE), n }
   * cams: [{ R, t, f, cx, cy, w, h, imgIdx }]  (training-resolution intrinsics)
   * images: [{ tw, th, rgb }] indexed by cam.imgIdx
   */
  setup(gaussians, cams, images, maxViewW, maxViewH, sceneRadius) {
    const d = this.device;
    this.n = gaussians.n;
    // DC color convention bridge: seeds/imports tagged 'sh' carry standard
    // SH-DC (engine v2's native format); untagged/'sigmoid' carry the v1
    // logit convention. Convert in place to THIS trainer's convention so
    // v2 exports re-import for continuation under either engine.
    const srcDc = gaussians.dc || 'sigmoid';
    if ((this.dcMode === 'sh') !== (srcDc === 'sh')) {
      const dd = gaussians.data;
      const C0 = 0.28209479177387814;
      for (let i = 0; i < gaussians.n; i++) {
        const b = i * STRIDE;
        for (let k = 10; k <= 12; k++) {
          if (this.dcMode === 'sh') {
            const sgm = 1 / (1 + Math.exp(-dd[b + k]));
            dd[b + k] = (sgm - 0.5) / C0;
          } else {
            const c = Math.min(0.9999, Math.max(1e-4, C0 * dd[b + k] + 0.5));
            dd[b + k] = Math.log(c / (1 - c));
          }
        }
      }
      gaussians.dc = this.dcMode;
    }
    // buffers are allocated for `cap` so refine() can also GROW the splat
    // count (MCMC-style) without reallocating
    this.cap = Math.min(
      Math.max(Math.floor(gaussians.n * (this.opts.capMult ?? 4)), gaussians.n),
      this.opts.maxSplats ?? 600000);
    if (this.n > this.cap) {
      // seed clone rounding can overshoot maxSplats (e.g. 7825 pts x 4 clones
      // = 31300 vs a 30000 budget). A seed larger than cap made the boot
      // upload FAIL SILENTLY (WebGPU drops the whole writeBuffer): the model
      // then trained from all-zero params and every refine write-back no-oped
      // the same way. Truncating clones is harmless — they're duplicates.
      this.n = this.cap;
    }
    this.cams = cams;
    this.sceneRadius = sceneRadius;

    // Targets are packed RGBA8 (one u32 per pixel; alpha 0 marks pixels the
    // undistortion resampled out of frame). The source photographs are 8-bit,
    // so this is lossless vs f32 — and 4x less GPU memory and loss-read
    // bandwidth, which is what lets full sets fit on phones.
    let total = 0; // in PIXELS
    this.camMeta = cams.map((c) => {
      const im = images[c.imgIdx];
      const meta = { ...c, w: im.tw, h: im.th, offset: total };
      total += im.tw * im.th;
      return meta;
    });
    const limit = this.device.limits.maxStorageBufferBindingSize;
    if (total * 4 > limit) {
      throw new Error(`training targets (${(total * 4 / 1e6).toFixed(0)}MB) exceed the device ` +
        `binding limit (${(limit / 1e6).toFixed(0)}MB) — reduce image count or resolution`);
    }
    const targetData = new Uint32Array(total);
    for (const meta of this.camMeta) {
      const rgb = images[meta.imgIdx].rgb;
      const np = meta.w * meta.h;
      for (let p = 0; p < np; p++) {
        const r = rgb[p * 3];
        if (r < 0) { targetData[meta.offset + p] = 0; continue; } // invalid sentinel
        targetData[meta.offset + p] = (255 << 24)
          | (Math.min(255, Math.round(rgb[p * 3 + 2] * 255)) << 16)
          | (Math.min(255, Math.round(rgb[p * 3 + 1] * 255)) << 8)
          | Math.min(255, Math.round(r * 255));
      }
    }

    const maxPix = Math.max(maxViewW * maxViewH,
      ...this.camMeta.map((m) => m.w * m.h));
    const maxTiles = Math.max(
      Math.ceil(maxViewW / TILE) * Math.ceil(maxViewH / TILE),
      ...this.camMeta.map((m) => Math.ceil(m.w / TILE) * Math.ceil(m.h / TILE)));
    // SSAA raster covers ssaa^2 x the pixels/tiles of the loss resolution
    const ssq = this.ssaa >= 2 ? this.ssaa * this.ssaa : 1;
    this.maxTiles = maxTiles * ssq;
    this.tileZero = new Uint32Array(this.maxTiles);

    const B = GPUBufferUsage;
    const buf = (size, usage, label) => d.createBuffer({ size, usage, label });
    const nb = this.cap * STRIDE * 4;
    this.bufParams = buf(nb, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'params');
    d.queue.writeBuffer(this.bufParams, 0, gaussians.data.buffer, gaussians.data.byteOffset,
      this.n * STRIDE * 4);
    this.bufProj = buf(nb, B.STORAGE | B.COPY_SRC, 'proj');
    this.bufGradP = buf(nb, B.STORAGE | B.COPY_SRC, 'gradP'); // COPY_SRC: precision diagnostics
    this.bufGradF = buf(nb, B.STORAGE | B.COPY_SRC, 'gradF');
    this.bufM = buf(nb, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'adam-m');
    this.bufV = buf(nb, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'adam-v');
    d.queue.writeBuffer(this.bufM, 0, new Float32Array(this.cap * STRIDE));
    d.queue.writeBuffer(this.bufV, 0, new Float32Array(this.cap * STRIDE));
    this.bufTileCnt = buf(this.maxTiles * 4, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'tileCnt');
    this.bufTileStart = buf((this.maxTiles + 1) * 4, B.STORAGE | B.COPY_SRC, 'tileStart');
    this.bufTileCursor = buf(this.maxTiles * 4, B.STORAGE | B.COPY_SRC, 'tileCursor');
    this.bufEntries = buf(this.entriesCap * 2 * 4, B.STORAGE | B.COPY_SRC, 'entries');
    this.bufOut = buf(maxPix * ssq * 4 * 4, B.STORAGE | B.COPY_SRC, 'outImg');
    this.bufTarget = buf(Math.max(16, total * 4), B.STORAGE | B.COPY_DST, 'targets');
    d.queue.writeBuffer(this.bufTarget, 0, targetData);
    this.bufStats = buf(16, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'stats');
    d.queue.writeBuffer(this.bufStats, 0, new Uint32Array(4));
    this.bufStatsRead = buf(16, B.COPY_DST | B.MAP_READ, 'statsRead');
    this.bufParamsRead = buf(nb, B.COPY_DST | B.MAP_READ, 'paramsRead'); // cap-sized
    this.bufCamGrad = buf((cams.length + 1) * 8 * 4, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'camGrad');
    d.queue.writeBuffer(this.bufCamGrad, 0, new Int32Array((cams.length + 1) * 8));
    if (this.shK) {
      // SH coeffs + their (non-atomic: written once per splat by the chain
      // pass) gradients + Adam moments; zero-initialized per the WebGPU spec
      const shb = this.cap * this.shK * 3 * 4;
      this.bufSH = buf(shb, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'sh');
      this.bufSHGrad = buf(shb, B.STORAGE | B.COPY_SRC, 'shGrad');
      // COPY_SRC is load-bearing: refine() reads these back to relocate donor
      // moments — without it the readback encoder errors and refine silently
      // wrote back ZEROED SH Adam moments every 2500 iters
      this.bufSHM = buf(shb, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'sh-adam-m');
      this.bufSHV = buf(shb, B.STORAGE | B.COPY_DST | B.COPY_SRC, 'sh-adam-v');
      this.uniSHAdam = buf(32, B.UNIFORM | B.COPY_DST, 'uniSHAdam');
    }

    this.uniTrain = buf(144, B.UNIFORM | B.COPY_DST, 'uniTrain');
    this.uniView = buf(144, B.UNIFORM | B.COPY_DST, 'uniView');
    this.uniAdam = buf(128, B.UNIFORM | B.COPY_DST, 'uniAdam');

    // phase-2 refine: 16 bytes/splat gathered for the CPU decision, a plan of
    // 32-byte ops back, executed GPU-side (no params/moments round trip).
    // Plan bound: every dead/new row is one op + at most one op per donor.
    this.bufGather = buf(this.cap * 16, B.STORAGE | B.COPY_SRC, 'refine-gather');
    this.bufGatherRead = buf(this.cap * 16, B.COPY_DST | B.MAP_READ, 'refine-gatherRead');
    this.planCap = Math.ceil(this.cap * 0.75);
    this.bufPlan = buf(this.planCap * 32, B.STORAGE | B.COPY_DST, 'refine-plan');
    this.uniGather = buf(16, B.UNIFORM | B.COPY_DST, 'uniGather');
    this.uniRefine = buf(16, B.UNIFORM | B.COPY_DST, 'uniRefine');   // clone slice
    this.uniRefineB = buf(16, B.UNIFORM | B.COPY_DST, 'uniRefineB'); // donor slice
    if (!this.shK) {
      // refine-apply statically references the SH bindings; distinct dummies
      // (aliased writable bindings are a dispatch-time validation error)
      this.bufShDummy = [buf(16, B.STORAGE, 'shd0'), buf(16, B.STORAGE, 'shd1'), buf(16, B.STORAGE, 'shd2')];
    }

    const bgProject = (uni) => d.createBindGroup({
      layout: this.pipeProject.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: this.bufParams } },
        { binding: 2, resource: { buffer: this.bufProj } },
        { binding: 3, resource: { buffer: this.bufTileCnt } },
        ...(this.shK ? [{ binding: 4, resource: { buffer: this.bufSH } }] : []),
      ],
    });
    const bgScan = (uni) => d.createBindGroup({
      layout: this.pipeScan.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: this.bufTileCnt } },
        { binding: 2, resource: { buffer: this.bufTileStart } },
        { binding: 3, resource: { buffer: this.bufTileCursor } },
        { binding: 4, resource: { buffer: this.bufStats } },
      ],
    });
    const bgScatter = (uni) => d.createBindGroup({
      layout: this.pipeScatter.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: this.bufProj } },
        { binding: 2, resource: { buffer: this.bufTileCursor } },
        { binding: 3, resource: { buffer: this.bufEntries } },
        { binding: 4, resource: { buffer: this.bufTileStart } },
      ],
    });
    const bgRender = (uni) => d.createBindGroup({
      layout: this.pipeRender.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: this.bufProj } },
        { binding: 2, resource: { buffer: this.bufTileStart } },
        { binding: 3, resource: { buffer: this.bufEntries } },
        { binding: 4, resource: { buffer: this.bufTarget } },
        { binding: 5, resource: { buffer: this.bufOut } },
        { binding: 6, resource: { buffer: this.bufGradP } },
        { binding: 7, resource: { buffer: this.bufStats } },
        { binding: 8, resource: { buffer: this.bufCamGrad } },
      ],
    });
    const bgBlit = (uni) => d.createBindGroup({
      layout: this.pipeBlit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: this.bufOut } },
      ],
    });
    this.bgProjectTrain = bgProject(this.uniTrain);
    this.bgProjectView = bgProject(this.uniView);
    this.bgScanTrain = bgScan(this.uniTrain);
    this.bgScanView = bgScan(this.uniView);
    this.bgScatterTrain = bgScatter(this.uniTrain);
    this.bgScatterView = bgScatter(this.uniView);
    this.bgRenderTrain = bgRender(this.uniTrain);
    this.bgRenderView = bgRender(this.uniView);
    if (this.ssimW > 0) {
      // SSIM working buffers: A/B pixel-major 16 f32/px, gssim 4 f32/px,
      // endBuf 1 u32/px (per-pixel walk end handed from fwd to bwd kernel)
      this.bufEnd = buf(maxPix * 4, B.STORAGE, 'ssim-end');
      this.bufSsimA = buf(maxPix * 64, B.STORAGE, 'ssim-A');
      this.bufSsimB = buf(maxPix * 64, B.STORAGE, 'ssim-B');
      this.bufGssim = buf(maxPix * 16, B.STORAGE, 'ssim-grad');
      this.bgRenderFwd = d.createBindGroup({
        layout: this.pipeRenderFwd.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniTrain } },
          { binding: 1, resource: { buffer: this.bufProj } },
          { binding: 2, resource: { buffer: this.bufTileStart } },
          { binding: 3, resource: { buffer: this.bufEntries } },
          { binding: 4, resource: { buffer: this.bufTarget } },
          { binding: 5, resource: { buffer: this.bufOut } },
          { binding: 7, resource: { buffer: this.bufStats } },
          { binding: 8, resource: { buffer: this.bufCamGrad } },
          { binding: 9, resource: { buffer: this.bufEnd } },
        ],
      });
      this.bgRenderBwd = d.createBindGroup({
        layout: this.pipeRenderBwd.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniTrain } },
          { binding: 1, resource: { buffer: this.bufProj } },
          { binding: 2, resource: { buffer: this.bufTileStart } },
          { binding: 3, resource: { buffer: this.bufEntries } },
          { binding: 4, resource: { buffer: this.bufTarget } },
          { binding: 5, resource: { buffer: this.bufOut } },
          { binding: 6, resource: { buffer: this.bufGradP } },
          { binding: 9, resource: { buffer: this.bufEnd } },
          { binding: 10, resource: { buffer: this.bufGssim } },
        ],
      });
      const bgSsim = (pipe, entries) => d.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      });
      this.bgSsimPrep = bgSsim(this.pipeSsimPrep, [
        [0, this.uniTrain], [2, this.bufSsimA], [3, this.bufOut], [4, this.bufTarget]]);
      this.bgSsimBH15 = bgSsim(this.pipeSsimBH15, [
        [0, this.uniTrain], [1, this.bufSsimA], [2, this.bufSsimB]]);
      this.bgSsimBV15 = bgSsim(this.pipeSsimBV15, [
        [0, this.uniTrain], [1, this.bufSsimB], [2, this.bufSsimA]]);
      this.bgSsimCoeff = bgSsim(this.pipeSsimCoeff, [
        [0, this.uniTrain], [1, this.bufSsimA], [2, this.bufSsimB]]);
      this.bgSsimBH9 = bgSsim(this.pipeSsimBH9, [
        [0, this.uniTrain], [1, this.bufSsimB], [2, this.bufSsimA]]);
      this.bgSsimFinal = bgSsim(this.pipeSsimFinal, [
        [0, this.uniTrain], [1, this.bufSsimA], [3, this.bufOut], [4, this.bufTarget], [5, this.bufGssim]]);
    }
    if (this.ssaa >= 2) {
      this.bufEnd = buf(maxPix * ssq * 4, B.STORAGE, 'ssaa-end');
      this.bufGssim = buf(maxPix * 16, B.STORAGE, 'ssaa-grad');
      // raster passes at ssaa x need their own scaled cam uniforms; the fwd
      // one carries trainMode 0 (render + walk-end only, loss lives in the
      // downsample pass), the bwd one trainMode 1
      this.uniTrain2f = buf(144, B.UNIFORM | B.COPY_DST, 'uniTrain2f');
      this.uniTrain2b = buf(144, B.UNIFORM | B.COPY_DST, 'uniTrain2b');
      this.bgProject2 = bgProject(this.uniTrain2f);
      this.bgScan2 = bgScan(this.uniTrain2f);
      this.bgScatter2 = bgScatter(this.uniTrain2f);
      this.bgRenderFwdSsaa = d.createBindGroup({
        layout: this.pipeRenderFwd.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniTrain2f } },
          { binding: 1, resource: { buffer: this.bufProj } },
          { binding: 2, resource: { buffer: this.bufTileStart } },
          { binding: 3, resource: { buffer: this.bufEntries } },
          { binding: 4, resource: { buffer: this.bufTarget } },
          { binding: 5, resource: { buffer: this.bufOut } },
          { binding: 7, resource: { buffer: this.bufStats } },
          { binding: 8, resource: { buffer: this.bufCamGrad } },
          { binding: 9, resource: { buffer: this.bufEnd } },
        ],
      });
      this.bgRenderBwd3 = d.createBindGroup({
        layout: this.pipeRenderBwd3.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniTrain2b } },
          { binding: 1, resource: { buffer: this.bufProj } },
          { binding: 2, resource: { buffer: this.bufTileStart } },
          { binding: 3, resource: { buffer: this.bufEntries } },
          { binding: 5, resource: { buffer: this.bufOut } },
          { binding: 6, resource: { buffer: this.bufGradP } },
          { binding: 9, resource: { buffer: this.bufEnd } },
          { binding: 10, resource: { buffer: this.bufGssim } },
        ],
      });
      this.bgSsaaLoss = d.createBindGroup({
        layout: this.pipeSsaaLoss.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniTrain } },
          { binding: 1, resource: { buffer: this.bufOut } },
          { binding: 2, resource: { buffer: this.bufTarget } },
          { binding: 3, resource: { buffer: this.bufGssim } },
          { binding: 4, resource: { buffer: this.bufStats } },
          { binding: 5, resource: { buffer: this.bufCamGrad } },
        ],
      });
    }
    this.bgBlitTrain = bgBlit(this.uniTrain);
    this.bgBlitView = bgBlit(this.uniView);
    this.bgSort = d.createBindGroup({
      layout: this.pipeSort.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bufTileStart } },
        { binding: 1, resource: { buffer: this.bufTileCursor } },
        { binding: 2, resource: { buffer: this.bufEntries } },
      ],
    });
    this.bgChain = d.createBindGroup({
      layout: this.pipeChain.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniTrain } },
        { binding: 1, resource: { buffer: this.bufParams } },
        { binding: 2, resource: { buffer: this.bufProj } },
        { binding: 3, resource: { buffer: this.bufGradP } },
        { binding: 4, resource: { buffer: this.bufGradF } },
        { binding: 5, resource: { buffer: this.bufCamGrad } },
        ...(this.shK ? [
          { binding: 6, resource: { buffer: this.bufSH } },
          { binding: 7, resource: { buffer: this.bufSHGrad } },
        ] : []),
      ],
    });
    this.bgAdam = d.createBindGroup({
      layout: this.pipeAdam.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniAdam } },
        { binding: 1, resource: { buffer: this.bufParams } },
        { binding: 2, resource: { buffer: this.bufGradF } },
        { binding: 3, resource: { buffer: this.bufM } },
        { binding: 4, resource: { buffer: this.bufV } },
      ],
    });
    this.bgGather = d.createBindGroup({
      layout: this.pipeGather.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniGather } },
        { binding: 1, resource: { buffer: this.bufParams } },
        { binding: 2, resource: { buffer: this.bufGradP } },
        { binding: 3, resource: { buffer: this.bufGather } },
      ],
    });
    const shTriple = this.shK ? [this.bufSH, this.bufSHM, this.bufSHV] : this.bufShDummy;
    const bgApply = (uni) => d.createBindGroup({
      layout: this.pipeRefineApply.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uni } },
        { binding: 1, resource: { buffer: this.bufPlan } },
        { binding: 2, resource: { buffer: this.bufParams } },
        { binding: 3, resource: { buffer: this.bufM } },
        { binding: 4, resource: { buffer: this.bufV } },
        { binding: 5, resource: { buffer: shTriple[0] } },
        { binding: 6, resource: { buffer: shTriple[1] } },
        { binding: 7, resource: { buffer: shTriple[2] } },
      ],
    });
    this.bgRefineApply = bgApply(this.uniRefine);
    this.bgRefineApplyB = bgApply(this.uniRefineB);
    if (this.shK) {
      this.bgSHAdam = d.createBindGroup({
        layout: this.pipeSHAdam.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniSHAdam } },
          { binding: 1, resource: { buffer: this.bufSH } },
          { binding: 2, resource: { buffer: this.bufSHGrad } },
          { binding: 3, resource: { buffer: this.bufSHM } },
          { binding: 4, resource: { buffer: this.bufSHV } },
        ],
      });
      // Adam hp + lr for the SH coeffs; INRIA convention: rest lr = DC/20,
      // directly applicable since our bands also add in color space
      this.shAdamData = new Float32Array([
        0.9, 0.999, 1e-15, 1,
        this.opts.shLr ?? 1.25e-4, this.n * this.shK * 3, 0, 0,
      ]);
    }

    for (const m of this.camMeta) { m.f0 = m.f; m.fy0 = m.fy ?? m.f; } // original focals (shared scale + aspect are optimized)
    this.logAspect = 0; // log(fy/fx) refinement (opts.aspectOpt)
    this.camUniforms = this.camMeta.map((m, i) => this._camUniform(m, 1, m.offset, i));
    // camera-pose optimizer state (opts.camOpt enables it)
    this.holdout = -1;
    this.logfScale = 0;
    this.camStep = 0;
    this.camM = new Float64Array((cams.length + 1) * 8);
    this.camV = new Float64Array((cams.length + 1) * 8);

    // hyperparameters loosely following LichtFeld/3DGS conventions
    // schedule horizon: pos-lr decay and growth scale with the intended
    // training length (default matches main.js auto-stop) instead of a
    // hardcoded 30k that predates the longer default runs
    this.horizon = this.opts.maxIters ?? 60000;
    this.adamData = new Float32Array(32);
    const r = sceneRadius;
    // posLrScale: experiment knob — the reference implementations run their
    // position lr 20-60x LOWER relative to scene extent (median vs our P90,
    // 1.6e-5 vs 3e-4 coefficient); sweepable before touching the default
    this.basePosLr = (this.v2 ? 2e-5 : 3e-4) * r * (this.opts.posLrScale ?? 1);
    const lrs = new Float32Array(16);
    lrs[0] = lrs[1] = lrs[2] = this.basePosLr;      // position
    lrs[3] = lrs[4] = lrs[5] = this.v2 ? 1e-2 : 5e-3;  // log scales
    lrs[6] = lrs[7] = lrs[8] = lrs[9] = 1e-3;       // quaternion
    lrs[10] = lrs[11] = lrs[12] = this.v2 ? 2e-3 : 1.5e-2; // DC color
    lrs[13] = this.v2 ? 1e-2 : 2.5e-2;              // opacity logit
    this.adamData.set(lrs, 0);
    this.adamData.set([
      0.9, 0.999, 1e-15, 1,                          // beta1, beta2, eps, t
      // min scale default 1e-4*r: the old 1e-3*r floor is a WORLD-space size
      // and projects inversely with depth — close surfaces hit a 2-5px floor
      // ("inverted depth of field", user-diagnosed) while far ones stay
      // sub-pixel. Dropping it: truck +2.9dB train / +1.6dB holdout. Needle
      // risk is handled by anisoReg (ratio bound), not this absolute floor.
      // zero-width needle axes the optimizer happily saturated)
      // maxScale default 0.5*r (was 0.05*r until 2026-08-28): the tight cap
      // forced sky/far content into mosaics of small per-view cards — the
      // shiny-bench tile artifacts (train 41 / holdout 18.5 dB). Swept
      // {0.05, 0.5, 2}: 0.5 dominates — shiny 18.5->36.5, playroom +0.65,
      // truck +0.2, synthetic +0.15 (cap 2 regressed synthetic -1.6, its
      // room-scale giants overfit). Runaway sanity beyond that is anisoReg
      // + scaleReg's job, not an absolute ceiling's.
      Math.log(r * (this.opts.minScale ?? 1e-4)), Math.log(r * (this.opts.maxScale ?? 0.5)), 8.0, this.n * STRIDE,
      // 0.01 (was 0.05): matches standard 3DGS-MCMC; the strong early-era pull
      // kept splats semi-transparent and layered ("milky")
      this.v2 ? (this.opts.opacityReg ?? 0) : (this.opts.opacityReg ?? 0.01),
      this.v2 ? 0 : (this.opts.scaleReg ?? 0),          // 3DGS-MCMC scale pressure
      // v2: no Langevin — apply-kernel split offsets do the dispersing
      this.v2 ? 0 : (this.opts.mcmcNoise === true ? 5e5 : (this.opts.mcmcNoise ?? 0)),
      this.v2 ? 1 : 0,                                  // reg.w: unbounded DC color
      // flg: regVisOnly (regs act only on rendered splats — the opacity /
      // scale ratchet fix) and the opacity logit floor
      this.opts.regVisOnly ? 1 : 0, this.opts.opaFloor ?? 0, 0, 0,
    ], 16);
    // opts.opaRegRefN: the splat count at which opacityReg applies as
    // configured; the per-step weight scales by opaRegRefN/n (capped by
    // opaRegRefMax). The reg is a per-splat constant while the data gradient
    // a splat receives falls with n (3DGS-MCMC's reg is mean()-scaled, i.e.
    // 1/n per splat), so a weight tuned at ~1M starves a 1.6M model (lab log
    // 2026-09-02, rung 4: 59 % dead at the cap, −0.6 dB; the same weight
    // ×0.65 recovers it — scaleReg must NOT scale along, that costs 0.12).
    this.opaRegBase = this.adamData[24];
    this.lastRefine = 0;
    // opts.seed: deterministic camera schedule + refine draws (bench A/B —
    // unseeded, the same cell spreads ~0.37 dB run to run on truck 30k).
    // Atomic float order in the kernels stays nondeterministic, so this
    // narrows the spread, it does not zero it.
    this.rand = Number.isFinite(this.opts.seed) ? makeRng(this.opts.seed) : () => Math.random();

    // gradcheck metadata
    this.hBySlot = [
      r * 2e-3, r * 2e-3, r * 2e-3, 0.02, 0.02, 0.02,
      0.02, 0.02, 0.02, 0.02, 0.05, 0.05, 0.05, 0.05, 0, 0,
    ];
    this.slotNames = [
      'pos.x', 'pos.y', 'pos.z', 'logSx', 'logSy', 'logSz',
      'q.w', 'q.x', 'q.y', 'q.z', 'c.r', 'c.g', 'c.b', 'opa', 'pad', 'pad',
    ];
  }

  _camUniform({ R, t, f, fy, cx, cy, w, h, g = 0, b = 0 }, trainMode, offset, camIdx = 0) {
    const u = new Float32Array(36);
    u.set([R[0], R[1], R[2], 0], 0);
    u.set([R[3], R[4], R[5], 0], 4);
    u.set([R[6], R[7], R[8], 0], 8);
    u.set([t[0], t[1], t[2], 0.05], 12);          // near plane
    u.set([f, cx, cy, Math.exp(g)], 16);          // .w = exposure gain
    u.set([w, h, Math.ceil(w / TILE), this.n], 20);
    u.set([0, 0, 0, 0], 24);                      // black background
    u.set([trainMode, camIdx, this.camMeta ? this.camMeta.length : 0, b], 28); // .w = exposure bias
    u[32] = this.shDeg; // active SH degree (stepOnce ramps this during training)
    // per-axis focal: fy (0 = same as f). Cameras from a non-uniformly
    // resized dataset (T&T truck: fx/fy = 1.006) or COLMAP PINHOLE carry it;
    // one shared focal fed sqrt(fx·fy) misaligned targets by 1.4 px at the
    // edges and cost 0.5 dB at the hour (lab log 2026-09-04)
    u[34] = fy != null && fy !== f ? fy : 0;
    // target offset as raw u32 bits (f32 is exact only to 2^24; full-res
    // target buffers exceed that) — shader reads it via bitcast
    new Uint32Array(u.buffer)[27] = offset >>> 0;
    return u;
  }

  /** Write the training cam uniform, plus the ssaa-scaled variants when
   *  supersampling (f/cx/cy/w/h/tilesX scaled; fwd gets trainMode 0). */
  _writeTrainUniforms(u) {
    const d = this.device;
    d.queue.writeBuffer(this.uniTrain, 0, u);
    if (this.ssaa >= 2) {
      const s = this.ssaa;
      const u2 = new Float32Array(u);
      u2[16] *= s; u2[17] *= s; u2[18] *= s;              // f, cx, cy
      u2[34] *= s;                                         // fy
      u2[20] *= s; u2[21] *= s;                            // w, h
      u2[22] = Math.ceil(u2[20] / TILE);                   // tilesX
      u2[28] = 0; // fwd pass: render + walk-end only
      d.queue.writeBuffer(this.uniTrain2f, 0, u2);
      u2[28] = 1;
      d.queue.writeBuffer(this.uniTrain2b, 0, u2);
    }
  }

  /** Encode the full raster sequence (project -> scan -> scatter -> sort ->
   *  render) into an open compute pass for the given camera dims. */
  encodeRaster(p, meta, train) {
    if (train && this.ssaa >= 2) {
      // supersampled training: raster at ssaa x, then box-downsample + loss
      // at the native target resolution, then the backward at ssaa x with
      // the per-1x-pixel gradients. PSNR/loss stats stay 1x-comparable.
      const s = this.ssaa;
      const gx2 = Math.ceil((meta.w * s) / TILE), gy2 = Math.ceil((meta.h * s) / TILE);
      p.setPipeline(this.pipeProject);
      p.setBindGroup(0, this.bgProject2);
      p.dispatchWorkgroups(Math.ceil(this.n / 256));
      p.setPipeline(this.pipeScan);
      p.setBindGroup(0, this.bgScan2);
      p.dispatchWorkgroups(1);
      p.setPipeline(this.pipeScatter);
      p.setBindGroup(0, this.bgScatter2);
      p.dispatchWorkgroups(Math.ceil(this.n / 256));
      p.setPipeline(this.pipeSort);
      p.setBindGroup(0, this.bgSort);
      p.dispatchWorkgroups(gx2 * gy2);
      p.setPipeline(this.pipeRenderFwd);
      p.setBindGroup(0, this.bgRenderFwdSsaa);
      p.dispatchWorkgroups(gx2, gy2);
      p.setPipeline(this.pipeSsaaLoss);
      p.setBindGroup(0, this.bgSsaaLoss);
      p.dispatchWorkgroups(Math.ceil(meta.w / TILE), Math.ceil(meta.h / TILE));
      p.setPipeline(this.pipeRenderBwd3);
      p.setBindGroup(0, this.bgRenderBwd3);
      p.dispatchWorkgroups(gx2, gy2);
      return;
    }
    const numTiles = Math.ceil(meta.w / TILE) * Math.ceil(meta.h / TILE);
    p.setPipeline(this.pipeProject);
    p.setBindGroup(0, train ? this.bgProjectTrain : this.bgProjectView);
    p.dispatchWorkgroups(Math.ceil(this.n / 256));
    p.setPipeline(this.pipeScan);
    p.setBindGroup(0, train ? this.bgScanTrain : this.bgScanView);
    p.dispatchWorkgroups(1);
    p.setPipeline(this.pipeScatter);
    p.setBindGroup(0, train ? this.bgScatterTrain : this.bgScatterView);
    p.dispatchWorkgroups(Math.ceil(this.n / 256));
    p.setPipeline(this.pipeSort);
    p.setBindGroup(0, this.bgSort);
    p.dispatchWorkgroups(numTiles);
    const gx = Math.ceil(meta.w / TILE), gy = Math.ceil(meta.h / TILE);
    if (train && this.ssimW > 0) {
      // split renderer with the D-SSIM image passes in between; dispatch
      // ordering within one pass makes each stage's writes visible to the next
      const run = (pipe, bg) => { p.setPipeline(pipe); p.setBindGroup(0, bg); p.dispatchWorkgroups(gx, gy); };
      run(this.pipeRenderFwd, this.bgRenderFwd);
      run(this.pipeSsimPrep, this.bgSsimPrep);
      run(this.pipeSsimBH15, this.bgSsimBH15);
      run(this.pipeSsimBV15, this.bgSsimBV15);
      run(this.pipeSsimCoeff, this.bgSsimCoeff);
      run(this.pipeSsimBH9, this.bgSsimBH9);
      run(this.pipeSsimFinal, this.bgSsimFinal);
      run(this.pipeRenderBwd, this.bgRenderBwd);
      return;
    }
    p.setPipeline(this.pipeRender);
    p.setBindGroup(0, train ? this.bgRenderTrain : this.bgRenderView);
    p.dispatchWorkgroups(gx, gy);
  }

  /** Profiling-only training steps: the same kernel sequence as stepOnce
   *  (non-ssaa, non-ssim path), one compute pass per kernel with GPU
   *  timestamps at the pass boundaries — WebGPU times passes, not
   *  dispatches, so the production step (one pass) cannot be broken down.
   *  Returns per-kernel mean ms over k steps (also trains the model k steps).
   *  Needs the 'timestamp-query' device feature (requested when available). */
  async profileSteps(k = 100) {
    const d = this.device;
    if (!d.features.has('timestamp-query')) return { error: 'timestamp-query not available' };
    const names = ['project', 'scan', 'scatter', 'sort', 'renderFwd', 'render', 'chain', 'adam', 'shAdam'];
    const nq = names.length * 2;
    const qs = d.createQuerySet({ type: 'timestamp', count: nq });
    const qbuf = d.createBuffer({ size: nq * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const rb = d.createBuffer({ size: nq * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const sum = new Float64Array(names.length);
    let steps = 0;
    for (let s = 0; s < k; s++) {
      let ci = (this.rand() * this.camMeta.length) | 0;
      for (let tries = 0; tries < 16 && (ci === this.holdout || (this.excluded && this.excluded.has(ci))); tries++) ci = (ci + 1) % this.camMeta.length;
      const meta = this.camMeta[ci];
      this._writeTrainUniforms(this.camUniforms[ci]);
      d.queue.writeBuffer(this.bufTileCnt, 0, this.tileZero);
      this.adamData[19] = (this.iter + 1) - (this.adamT0 || 0);
      d.queue.writeBuffer(this.uniAdam, 0, this.adamData);
      if (this.shK) { this.shAdamData[3] = this.iter + 1; this.shAdamData[5] = this.n * this.shK * 3; d.queue.writeBuffer(this.uniSHAdam, 0, this.shAdamData); }
      const gx = Math.ceil(meta.w / TILE), gy = Math.ceil(meta.h / TILE);
      const nGroups = Math.ceil(this.n / 256);
      const d1 = (pass, total) => { const g = Math.ceil(total / 256); if (g <= 65535) pass.dispatchWorkgroups(g); else pass.dispatchWorkgroups(65535, Math.ceil(g / 65535)); };
      // forward-only estimate: the fused kernel with trainMode 0 (misc2.x)
      // walks the same tile lists and blends but skips the backward, so
      // render − renderFwd ≈ the backward's share
      const uFwd = new Float32Array(this.camUniforms[ci]); uFwd[28] = 0;
      const seq = [
        ['project', this.pipeProject, this.bgProjectTrain, (p) => p.dispatchWorkgroups(nGroups)],
        ['scan', this.pipeScan, this.bgScanTrain, (p) => p.dispatchWorkgroups(1)],
        ['scatter', this.pipeScatter, this.bgScatterTrain, (p) => p.dispatchWorkgroups(nGroups)],
        ['sort', this.pipeSort, this.bgSort, (p) => p.dispatchWorkgroups(gx * gy)],
        ['renderFwd', this.pipeRender, this.bgRenderTrain, (p) => p.dispatchWorkgroups(gx, gy), uFwd],
        ['render', this.pipeRender, this.bgRenderTrain, (p) => p.dispatchWorkgroups(gx, gy), this.camUniforms[ci]],
        ['chain', this.pipeChain, this.bgChain, (p) => p.dispatchWorkgroups(nGroups)],
        ['adam', this.pipeAdam, this.bgAdam, (p) => d1(p, this.n * STRIDE)],
        ...(this.shK ? [['shAdam', this.pipeSHAdam, this.bgSHAdam, (p) => d1(p, this.n * this.shK * 3)]] : []),
      ];
      const enc = d.createCommandEncoder();
      seq.forEach(([name, pipe, bg, disp, uni], i) => {
        // a per-kernel uniform swap (renderFwd) rides the same encoder: the
        // queue-ordered writeBuffer is not possible mid-encoder, so stage it
        if (uni) { const st = d.createBuffer({ size: uni.byteLength, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true }); new Float32Array(st.getMappedRange()).set(uni); st.unmap(); enc.copyBufferToBuffer(st, 0, this.uniTrain, 0, uni.byteLength); }
        const p = enc.beginComputePass({ timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } });
        p.setPipeline(pipe); p.setBindGroup(0, bg); disp(p); p.end();
      });
      enc.resolveQuerySet(qs, 0, seq.length * 2, qbuf, 0);
      enc.copyBufferToBuffer(qbuf, 0, rb, 0, seq.length * 16);
      d.queue.submit([enc.finish()]);
      this.iter++;
      await rb.mapAsync(GPUMapMode.READ);
      const t = new BigUint64Array(rb.getMappedRange().slice(0));
      rb.unmap();
      for (let i = 0; i < seq.length; i++) sum[names.indexOf(seq[i][0])] += Number(t[2 * i + 1] - t[2 * i]) / 1e6;
      steps++;
    }
    qs.destroy(); qbuf.destroy(); rb.destroy();
    const out = { steps, n: this.n, msPerStep: 0 };
    names.forEach((nm, i) => { if (sum[i] > 0) { out[nm] = +(sum[i] / steps).toFixed(3); out.msPerStep += sum[i] / steps; } });
    out.msPerStep = +out.msPerStep.toFixed(3);
    return out;
  }

  /** Run one training iteration (own submit; queue-ordered).
   *  Set trainer.holdout = <camIdx> to exclude a camera from training
   *  (evaluate it with evalCamPsnr for an honest novel-view metric). */
  stepOnce() {
    const d = this.device;
    let ci = (this.rand() * this.camMeta.length) | 0;
    // skip the holdout and any excluded (e.g. motion-blurred) cameras
    for (let tries = 0; tries < 16; tries++) {
      const bad = ci === this.holdout || (this.excluded && this.excluded.has(ci));
      if (!bad) break;
      ci = (ci + 1) % this.camMeta.length;
    }
    const meta = this.camMeta[ci];
    this.lastCam = ci; // which camera this step trains on (UI pulse)
    if (this.shK && (this.opts.shRamp ?? true)) {
      // INRIA-style band ramp: one SH degree per 1000 iters
      // (opts.shRamp = false trains full degree from step 0, Brush-style)
      this.camUniforms[ci][32] = Math.min(this.shDeg, Math.floor(this.iter / 1000));
    }
    // robust-loss threshold (misc3.y): kappa x running mean per-pixel loss,
    // active after warmup so the static scene converges before tiles are
    // voted out as transients (0 = off; the shader ignores it)
    this.camUniforms[ci][33] =
      (this.opts.robustLoss && this.meanPerr && this.iter > (this.opts.robustWarmup ?? 2000))
        ? this.opts.robustLoss * this.meanPerr : 0;
    this._writeTrainUniforms(this.camUniforms[ci]);
    d.queue.writeBuffer(this.bufTileCnt, 0, this.tileZero);
    this.iter++;
    this.pixelsSeen += meta.w * meta.h;
    // Adam's bias-correction step count runs from the moments' birth, not the
    // run's: a resume restores params at iteration N with ZERO moments, and
    // t = N would make the first steps 3-6x lr for hundreds of iterations
    // (1-b1^t ≈ 1 while m, v are still tiny) — the warm-restart kick the
    // resume e2e measured once the resumed trainer got its real config back
    this.adamData[19] = this.iter - (this.adamT0 || 0);
    // exponential position-lr decay to 1% at 75% of the horizon, then a
    // floor-lr polish phase. A/B'd vs INRIA-style full-length decay on
    // camping @40k: full-length gains +0.18 train but LOSES 0.15dB holdout
    // (positions moving late = overfit); the polish phase wins.
    // opts.lrExp = <end fraction>: Brush-style smooth exponential over the
    // FULL horizon (e.g. 0.05 = decay to 5%), replacing the 100x-by-75% +
    // floor-polish default. Sweepable together with posLrScale.
    const posLr = this.v2
      // v2: Brush schedules — smooth 20x position decay over the horizon
      ? this.basePosLr * Math.pow(0.05, Math.min(1, this.iter / this.horizon))
      : this.opts.lrExp
        ? this.basePosLr * Math.pow(this.opts.lrExp, Math.min(1, this.iter / this.horizon))
        : this.basePosLr * Math.pow(0.01, Math.min(1, this.iter / (0.75 * this.horizon)));
    this.adamData[0] = this.adamData[1] = this.adamData[2] = posLr;
    if (this.opts.opaDecay > 0) {
      // opts.opaDecay in Brush units (opacity per 200 iterations at t=0),
      // applied per step with their linear (1-t) ramp — flg.z in the kernel
      this.adamData[30] = (this.opts.opaDecay / 200) * (1 - Math.min(1, this.iter / this.horizon));
    }
    if (this.opts.opaRegRefN > 0) {
      // opaRegRefMax caps the factor (1 = only ever weaken above the ref;
      // a stronger reg during growth measured −0.12 at 1.05M)
      const f = Math.min(this.opts.opaRegRefMax ?? 1, this.opts.opaRegRefN / Math.max(1, this.n));
      this.adamData[24] = this.opaRegBase * f;
    }
    if (this.v2) { // log-scale 1e-2 -> 6e-3 exponential
      const sLr = 1e-2 * Math.pow(0.6, Math.min(1, this.iter / this.horizon));
      this.adamData[3] = this.adamData[4] = this.adamData[5] = sLr;
    }
    d.queue.writeBuffer(this.uniAdam, 0, this.adamData);
    if (this.shK) {
      this.shAdamData[3] = this.iter;
      this.shAdamData[5] = this.n * this.shK * 3;
      d.queue.writeBuffer(this.uniSHAdam, 0, this.shAdamData);
    }

    const enc = d.createCommandEncoder();
    const p = enc.beginComputePass();
    this.encodeRaster(p, meta, true);
    p.setPipeline(this.pipeChain);
    p.setBindGroup(0, this.bgChain);
    p.dispatchWorkgroups(Math.ceil(this.n / 256));
    // 2D-safe dispatch: at high splat counts these linear passes exceed the
    // 65535 workgroups-per-dimension limit (SH-Adam broke first: n*24/256 >
    // 65535 above ~620k splats — invalid command buffers, whole frames
    // silently no-oping)
    const dispatch1D = (pass, total) => {
      const groups = Math.ceil(total / 256);
      if (groups <= 65535) pass.dispatchWorkgroups(groups);
      else {
        const x = 65535;
        pass.dispatchWorkgroups(x, Math.ceil(groups / x));
      }
    };
    p.setPipeline(this.pipeAdam);
    p.setBindGroup(0, this.bgAdam);
    dispatch1D(p, this.n * STRIDE);
    if (this.shK) {
      p.setPipeline(this.pipeSHAdam);
      p.setBindGroup(0, this.bgSHAdam);
      dispatch1D(p, this.n * this.shK * 3);
    }
    p.end();
    d.queue.submit([enc.finish()]);

    // camera pose/focal optimization (default ON — validated +0.4..0.7dB
    // holdout on both test scenes): apply accumulated gradients every 25
    // iterations after a splat warmup
    // default OFF since SIFT-grade SfM (2026-08-19): poses arrive at the
    // information limit (train-84 ATE 0.04% before AND after training), so
    // photometric pose gradients only drift the global frame and cost the
    // holdout ~1dB raw. Re-enable via trainerOpts { camOpt: true } for
    // captures where SfM quality is in doubt.
    // opts.aspectOpt: refine only the shared pixel aspect (log fy/fx) — one
    // global parameter, well posed from hundreds of views, cannot drift the
    // frame the way per-camera pose gradients do. For datasets whose pixels
    // are not square (non-uniform resizes) and whose SfM assumed they were.
    if (((this.opts.camOpt ?? false) || (this.opts.aspectOpt ?? false)) && this.iter > 1500 && this.iter % 25 === 0) {
      this._applyCamGrads();
    }
  }

  /** Read the accumulated per-camera gradients and take one Adam step on
   *  every camera pose (R <- exp(dw)R, t += dt) plus the shared log-focal.
   *  Camera 0 is pinned (gauge anchor); the holdout camera is skipped. */
  async _applyCamGrads() {
    if (this._camApplying) return;
    this._camApplying = true;
    try {
      const d = this.device;
      const rows = this.camMeta.length + 1;
      const rb = d.createBuffer({ size: rows * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(this.bufCamGrad, 0, rb, 0, rows * 32);
      d.queue.submit([enc.finish()]);
      d.queue.writeBuffer(this.bufCamGrad, 0, new Int32Array(rows * 8));
      await rb.mapAsync(GPUMapMode.READ);
      const g = new Int32Array(rb.getMappedRange()).slice();
      rb.unmap(); rb.destroy();

      this.camStep++;
      const t = this.camStep;
      const decay = Math.pow(0.02, Math.min(1, this.iter / (0.75 * this.horizon)));
      const rotLr = 2e-4 * decay;
      const trnLr = 2e-4 * this.sceneRadius * decay;
      const focLr = 1e-4 * decay;
      const aspLr = (this.opts.aspectLr ?? 1e-4) * decay;
      const full = this.opts.camOpt ?? false;
      const b1 = 0.9, b2 = 0.99, eps = 1e-15;
      const step = (row, slot, lr) => {
        const j = row * 8 + slot;
        const grad = g[j] / 64;
        this.camM[j] = b1 * this.camM[j] + (1 - b1) * grad;
        this.camV[j] = b2 * this.camV[j] + (1 - b2) * grad * grad;
        const mh = this.camM[j] / (1 - Math.pow(b1, t));
        const vh = this.camV[j] / (1 - Math.pow(b2, t));
        return lr * mh / (Math.sqrt(vh) + eps);
      };
      // default OFF: A/B on the camping video showed no holdout gain (its
      // exposure is stable; the freedom only absorbs error). Enable for
      // captures with real auto-exposure drift via opts.expComp.
      const expLr = 5e-3;
      const doExp = this.opts.expComp ?? false;
      for (let r = 1; full && r < this.camMeta.length; r++) { // cam 0 pinned (gauge + exposure anchor)
        if (r === this.holdout) continue;
        const meta = this.camMeta[r];
        const dw = [-step(r, 0, rotLr), -step(r, 1, rotLr), -step(r, 2, rotLr)];
        meta.R = Array.from(m3mul(rodrigues(dw), meta.R));
        meta.t = [
          meta.t[0] - step(r, 3, trnLr),
          meta.t[1] - step(r, 4, trnLr),
          meta.t[2] - step(r, 5, trnLr),
        ];
        if (doExp) {
          // tight clamps: real auto-exposure drift is a few percent; wider
          // freedom gets abused as per-image error absorption (measured:
          // -0.55dB holdout with +-60% range)
          meta.g = Math.max(-0.1, Math.min(0.1, (meta.g || 0) - step(r, 6, expLr)));
          meta.b = Math.max(-0.05, Math.min(0.05, (meta.b || 0) - step(r, 7, expLr)));
        }
      }
      const nr = this.camMeta.length;
      if (full) this.logfScale = Math.max(-0.3, Math.min(0.3, this.logfScale - step(nr, 0, focLr)));
      if (this.opts.aspectOpt ?? false) {
        // ±3 %: real non-square pixels are well under 1 %; more is error absorption
        this.logAspect = Math.max(-0.03, Math.min(0.03, this.logAspect - step(nr, 1, aspLr)));
      }
      for (const m of this.camMeta) {
        m.f = m.f0 * Math.exp(this.logfScale);
        m.fy = m.fy0 * Math.exp(this.logfScale + this.logAspect);
      }
      this.camUniforms = this.camMeta.map((m, i) => this._camUniform(m, 1, m.offset, i));
    } finally {
      this._camApplying = false;
    }
  }

  /** One training-path pass for camera ci (optionally with a pose override);
   *  returns { psnr, camGrad (Int32Array row ci + focal row) }. Drains all
   *  gradient pollution so training state stays clean. */
  async _evalPass(ci, override) {
    const d = this.device;
    const meta = this.camMeta[ci];
    const uni = override
      ? this._camUniform({ ...meta, ...override }, 1, meta.offset, ci)
      : this.camUniforms[ci];
    const rows = this.camMeta.length + 1;
    d.queue.writeBuffer(this.bufStats, 0, new Uint32Array(4));
    this._writeTrainUniforms(uni);
    d.queue.writeBuffer(this.bufTileCnt, 0, this.tileZero);
    const enc = d.createCommandEncoder();
    const p = enc.beginComputePass();
    this.encodeRaster(p, meta, true);
    p.setPipeline(this.pipeChain); p.setBindGroup(0, this.bgChain); // zeroes gradP
    p.dispatchWorkgroups(Math.ceil(this.n / 256));
    p.end();
    enc.copyBufferToBuffer(this.bufStats, 0, this.bufStatsRead, 0, 16);
    const rbC = d.createBuffer({ size: rows * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(this.bufCamGrad, 0, rbC, 0, rows * 32);
    d.queue.submit([enc.finish()]);
    d.queue.writeBuffer(this.bufCamGrad, 0, new Int32Array(rows * 8)); // drain
    await Promise.all([this.bufStatsRead.mapAsync(GPUMapMode.READ), rbC.mapAsync(GPUMapMode.READ)]);
    const sarr = new Uint32Array(this.bufStatsRead.getMappedRange());
    const v = sarr[0];
    const validPx = Math.max(1, sarr[2]);
    this.bufStatsRead.unmap();
    const camGrad = new Int32Array(rbC.getMappedRange()).slice();
    rbC.unmap(); rbC.destroy();
    d.queue.writeBuffer(this.bufStats, 0, new Uint32Array(4));
    this.pixelsSeen = 0; // running train-psnr window was clobbered
    const mse = v / 16 / (validPx * 3);
    return { psnr: mse > 0 ? -10 * Math.log10(mse) : Infinity, camGrad };
  }

  /** PSNR of one camera (typically the holdout) at its current pose. */
  async evalCamPsnr(ci) {
    return (await this._evalPass(ci)).psnr;
  }

  /** PSNR of the holdout after test-time pose refinement: optimizes ONLY this
   *  camera's 6-DOF pose against its photo (splats frozen), the standard
   *  protocol when training refines camera poses. */
  async evalCamPsnrRefined(ci, steps = 200) {
    const meta = this.camMeta[ci];
    let R = Array.from(meta.R);
    let t = meta.t.slice();
    let g = 0, b = 0; // holdout exposure refined at test time too
    const doExp = this.opts.expComp ?? false;
    const m = new Float64Array(8), v = new Float64Array(8);
    const b1 = 0.9, b2 = 0.99, eps = 1e-15;
    const rotLr = 3e-4, trnLr = 3e-4 * this.sceneRadius, expLr = 5e-3;
    for (let s = 1; s <= steps; s++) {
      const { camGrad } = await this._evalPass(ci, { R, t, g, b });
      const upd = new Float64Array(8);
      for (let k = 0; k < 8; k++) {
        const grad = camGrad[ci * 8 + k] / 64;
        m[k] = b1 * m[k] + (1 - b1) * grad;
        v[k] = b2 * v[k] + (1 - b2) * grad * grad;
        const mh = m[k] / (1 - Math.pow(b1, s));
        const vh = v[k] / (1 - Math.pow(b2, s));
        upd[k] = (k < 3 ? rotLr : (k < 6 ? trnLr : expLr)) * mh / (Math.sqrt(vh) + eps);
      }
      R = Array.from(m3mul(rodrigues([-upd[0], -upd[1], -upd[2]]), R));
      t = [t[0] - upd[3], t[1] - upd[4], t[2] - upd[5]];
      if (doExp) {
        g = Math.max(-0.1, Math.min(0.1, g - upd[6]));
        b = Math.max(-0.05, Math.min(0.05, b - upd[7]));
      }
    }
    return (await this._evalPass(ci, { R, t, g, b })).psnr;
  }

  /** Read and reset accumulated squared-error stats -> mean L2 per pixel-channel. */
  async readLoss() {
    const d = this.device;
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.bufStats, 0, this.bufStatsRead, 0, 16);
    d.queue.submit([enc.finish()]);
    d.queue.writeBuffer(this.bufStats, 0, new Uint32Array(4));
    const px = this.pixelsSeen;
    this.pixelsSeen = 0;
    await this.bufStatsRead.mapAsync(GPUMapMode.READ);
    const s = new Uint32Array(this.bufStatsRead.getMappedRange());
    const v = s[0];
    const validPx = s[2]; // valid-pixel count (undistortion borders excluded)
    this.entryOverflowTiles = (this.entryOverflowTiles || 0) + s[3];
    this.bufStatsRead.unmap();
    if (px === 0 || validPx === 0) return null;
    const mse = v / 16 / (validPx * 3);
    // running mean per-pixel charbonnier — the robust-loss tile vote's
    // reference level. NOT from stats[1]: the x32768 fixed-point loss sum
    // wraps u32 within a single truck-sized step (534k px), which fed the
    // vote a near-zero threshold and trimmed EVERY tile (the 4.7 dB
    // collapse: photometric gradients gone, opacityReg starved the model).
    // Approximate from the overflow-safe MSE instead — E|err| =~ 0.8*sigma
    // per channel, 3 channels — with a floor so a bad estimate can only
    // make the vote MORE conservative, never trigger-happy.
    this.meanPerr = Math.max(2.4 * Math.sqrt(mse), 0.01);
    return mse;
  }

  /** Render an arbitrary camera into a WebGPU canvas context. */
  renderView(camParams, ctx, trainMode = 0, offset = 0) {
    const d = this.device;
    const u = this._camUniform(camParams, trainMode, offset);
    d.queue.writeBuffer(this.uniView, 0, u);
    d.queue.writeBuffer(this.bufTileCnt, 0, this.tileZero);
    const enc = d.createCommandEncoder();
    const p = enc.beginComputePass();
    this.encodeRaster(p, camParams, false);
    p.end();
    const rp = enc.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    rp.setPipeline(this.pipeBlit);
    rp.setBindGroup(0, this.bgBlitView);
    rp.draw(3);
    rp.end();
    d.queue.submit([enc.finish()]);
  }

  renderTrainCam(ci, ctx) {
    const meta = this.camMeta[ci];
    this.renderView(meta, ctx, 0, meta.offset);
  }

  /** Phase-2 MCMC refine (default): dead splats relocate as EXACT copies of
   *  donors sampled by ERROR MASS (gradP slots 10/11, accumulated since the
   *  last refine), with 3DGS-MCMC eq-9 conserving each donor group's density
   *  (opacity 1-(1-o)^(1/n), scale x o/denom) — no more 0.25-opacity clones
   *  that can't mature inside short budgets. Growth spends new capacity
   *  through the same mechanic. The readback is 16 bytes/splat (opacity +
   *  error mass + mean log-scale); relocation executes GPU-side from a plan
   *  buffer, so refineEvery 100 is affordable. opts.refineV2 = false restores
   *  the legacy jitter-clone path. Returns { moved, grown, n }. */
  /** Engine-v2 refine: one coherent Brush-style system. Dead splats
   *  (opacity < 2/255 or degenerate scale) RELOCATE onto donors sampled by
   *  opacity (prune+recycle without compaction); growth is triggered by the
   *  per-splat screen-gradient stat (gradP slot 12, window-accumulated —
   *  the channel that lets the D-SSIM loss steer capacity) and spends new
   *  rows where the image is structurally wrong. Every op is an
   *  alpha-conserving split (o -> 1-sqrt(1-o), scales /sqrt2, +/- ellipsoid
   *  offset pair via the apply kernel) — image-neutral at birth, no
   *  Langevin needed. Readback stays 16 bytes/splat. */
  async _refineV3(rng = this.rand) {
    const d = this.device;
    const canReloc = this.iter < (this.opts.relocUntil ?? Infinity);
    const limit = Math.min(this.cap, this.growLimit || this.cap);
    const canGrow = this.iter < (this.opts.growUntil ?? 0.5 * this.horizon) && this.n < limit;
    if (!canReloc && !canGrow) return { moved: 0, grown: 0, n: this.n };

    d.queue.writeBuffer(this.uniGather, 0, new Uint32Array([this.n, 1, this.opts.statMax ? 1 : 0, 0]));
    {
      const enc = d.createCommandEncoder();
      const p = enc.beginComputePass();
      p.setPipeline(this.pipeGather);
      p.setBindGroup(0, this.bgGather);
      const groups = Math.ceil(this.n / 256);
      if (groups <= 65535) p.dispatchWorkgroups(groups);
      else p.dispatchWorkgroups(65535, Math.ceil(groups / 65535));
      p.end();
      enc.copyBufferToBuffer(this.bufGather, 0, this.bufGatherRead, 0, this.n * 16);
      d.queue.submit([enc.finish()]);
    }
    await this.bufGatherRead.mapAsync(GPUMapMode.READ, 0, this.n * 16);
    const g = new Float32Array(this.bufGatherRead.getMappedRange(0, this.n * 16)).slice();
    this.bufGatherRead.unmap();

    const sig = (x) => 1 / (1 + Math.exp(-x));
    const minLog = Math.log(this.sceneRadius * (this.opts.minScale ?? 1e-4)) + 0.05;
    let dead = [];
    const pool = [];
    for (let i = 0; i < this.n; i++) {
      const o = sig(g[i * 4]);
      if (o < 2 / 255 || g[i * 4 + 3] < minLog) { if (canReloc) dead.push(i); }
      else if (o >= 0.05) pool.push(i);
    }
    if (pool.length < 16) return { moved: 0, grown: 0, n: this.n };

    // relocation donors ~ opacity; growth donors ~ grad-stat above threshold
    const opCdf = new Float64Array(pool.length);
    let opAcc = 0;
    for (let k = 0; k < pool.length; k++) { opAcc += sig(g[pool[k] * 4]); opCdf[k] = opAcc; }
    const drawOp = () => {
      const r = rng() * opAcc;
      let lo = 0, hi = pool.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (opCdf[mid] < r) lo = mid + 1; else hi = mid; }
      return pool[lo];
    };

    let grown = 0;
    let gCands = [], gsAcc = 0, gsCdf = null;
    if (canGrow) {
      // threshold at a MEDIAN multiple — the stat is heavy-tailed, so a
      // mean multiple marks almost nothing and growth starves (first v2
      // gate: 568k of a 2M cap). Median from a subsample for speed.
      // growNorm: Brush-style visibility normalization — measured -0.49 on
      // truck (diverts growth to rarely-seen periphery the ring eval never
      // rewards); raw window-sum is the default
      const st = (this.opts.growNorm)
        ? (i) => g[i * 4 + 1] / (g[i * 4 + 2] + 1e-3)
        : (i) => g[i * 4 + 1];
      const sample = [];
      const step = Math.max(1, pool.length >> 13);
      for (let k = 0; k < pool.length; k += step) sample.push(st(pool[k]));
      sample.sort((a, b) => a - b);
      const med = sample[sample.length >> 1] || 0;
      const tau = (this.opts.growTau ?? 1) * med;
      if (med > 0) {
        for (const i of pool) if (st(i) > tau) gCands.push(i);
        grown = Math.min(Math.ceil(gCands.length * (this.opts.growFrac ?? 0.1)), limit - this.n);
        if (grown > 0) {
          gsCdf = new Float64Array(gCands.length);
          for (let k = 0; k < gCands.length; k++) { gsAcc += st(gCands[k]); gsCdf[k] = gsAcc; }
        }
      }
    }
    const drawGs = () => {
      const r = rng() * gsAcc;
      let lo = 0, hi = gCands.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (gsCdf[mid] < r) lo = mid + 1; else hi = mid; }
      return gCands[lo];
    };
    if (dead.length + grown === 0) return { moved: 0, grown: 0, n: this.n };
    const budget = Math.floor(this.planCap / 2) - 1;
    if (dead.length > budget) dead = dead.slice(0, budget);
    grown = Math.min(grown, budget - dead.length);

    // plan: clone-copy ops first, donor adjustments second (ordered
    // dispatches). Op = copy + set-opacity + dls + ellipsoid offset (+side),
    // donor op = same adjustments with the opposite offset sign.
    const SHRINK = Math.log(1 / Math.SQRT2);
    const SIGMA = this.opts.splitSigma ?? 0.5;
    const u32 = new Uint32Array(this.planCap * 8);
    const f32 = new Float32Array(u32.buffer);
    const pushOp = (at, dst, src, flags, newO, dls, seed, sign, sigma) => {
      const o = at * 8;
      u32[o] = dst; u32[o + 1] = src; u32[o + 2] = flags; u32[o + 3] = seed;
      f32[o + 4] = newO; f32[o + 5] = dls; f32[o + 6] = sign; f32[o + 7] = sigma;
    };
    const used = new Set();
    const donorOps = [];
    let nClone = 0;
    const splitOnto = (dst, drawFn) => {
      let don = drawFn();
      for (let tries = 0; used.has(don) && tries < 8; tries++) don = drawFn();
      used.add(don);
      const o = sig(g[don * 4]);
      const oNew = Math.min(0.9999, Math.max(1e-4, 1 - Math.sqrt(1 - o)));
      const lgt = Math.log(oNew / (1 - oNew));
      const seed = (rng() * 4294967295) >>> 0;
      // dst: copy row, set opacity, shrink, offset +
      pushOp(nClone++, dst, don, 1 | 2 | 4 | 32, lgt, SHRINK, seed, 1, SIGMA);
      // donor keeps its moments (no bit 8): shape change is the conserving
      // half of a split, not a reset-worthy rebirth
      donorOps.push([don, lgt, seed]);
    };
    for (const i of dead) splitOnto(i, drawOp);
    for (let k = 0; k < grown; k++) splitOnto(this.n + k, drawGs);
    let dk = nClone;
    for (const [don, lgt, seed] of donorOps) pushOp(dk++, don, don, 2 | 4 | 32, lgt, SHRINK, seed, -1, SIGMA);
    const nOps = nClone + donorOps.length;

    d.queue.writeBuffer(this.bufPlan, 0, u32, 0, nOps * 8);
    d.queue.writeBuffer(this.uniRefine, 0, new Uint32Array([nClone, this.shK * 3, 0, 0]));
    d.queue.writeBuffer(this.uniRefineB, 0, new Uint32Array([donorOps.length, this.shK * 3, nClone, 0]));
    {
      const enc = d.createCommandEncoder();
      const p = enc.beginComputePass();
      p.setPipeline(this.pipeRefineApply);
      const disp = (bg, count) => {
        if (!count) return;
        p.setBindGroup(0, bg);
        const groups = Math.ceil(count / 256);
        if (groups <= 65535) p.dispatchWorkgroups(groups);
        else p.dispatchWorkgroups(65535, Math.ceil(groups / 65535));
      };
      disp(this.bgRefineApply, nClone);
      disp(this.bgRefineApplyB, donorOps.length);
      p.end();
      d.queue.submit([enc.finish()]);
    }
    if (grown > 0) {
      this.n += grown;
      this.adamData[23] = this.n * STRIDE;
      this.camUniforms = this.camMeta.map((mm, i) => this._camUniform(mm, 1, mm.offset, i));
    }
    return { moved: dead.length, grown, n: this.n };
  }

  async refine(rng = this.rand) {
    if (this.v2 && (this.opts.v2Refine ?? true)) return this._refineV3(rng);
    // OPT-IN while unproven: at truck 40k the v2 mechanics plateau 0.1-0.2 dB
    // BELOW the legacy path (best 25.38 vs 25.49) and one knob combination
    // (v1 opacity semantics + error-guided donors, eq9=0) death-spiraled to
    // 12.7 dB over a full run while passing every 3k smoke. The cheap
    // gather/plan infrastructure is sound — the donor policy is not.
    if (this.opts.refineV2 !== true) return this._refineLegacy(rng);
    const canReloc = this.iter < (this.opts.relocUntil ?? Infinity);
    const limit = Math.min(this.cap, this.growLimit || this.cap);
    const canGrow = this.iter < (this.opts.growUntil ?? 0.75 * this.horizon) && this.n < limit;
    if (!canReloc && !canGrow) return { moved: 0, grown: 0, n: this.n };
    const d = this.device;

    // gather (o, w-mass, e-mass, mean logS) and zero the accumulator window
    d.queue.writeBuffer(this.uniGather, 0, new Uint32Array([this.n, 0, 0, 0]));
    {
      const enc = d.createCommandEncoder();
      const p = enc.beginComputePass();
      p.setPipeline(this.pipeGather);
      p.setBindGroup(0, this.bgGather);
      const groups = Math.ceil(this.n / 256);
      if (groups <= 65535) p.dispatchWorkgroups(groups);
      else p.dispatchWorkgroups(65535, Math.ceil(groups / 65535));
      p.end();
      enc.copyBufferToBuffer(this.bufGather, 0, this.bufGatherRead, 0, this.n * 16);
      d.queue.submit([enc.finish()]);
    }
    await this.bufGatherRead.mapAsync(GPUMapMode.READ, 0, this.n * 16);
    const g = new Float32Array(this.bufGatherRead.getMappedRange(0, this.n * 16)).slice();
    this.bufGatherRead.unmap();

    const sig = (x) => 1 / (1 + Math.exp(-x));
    // opts.deadThr: below it a splat is relocated (ours 0.02; LichtFeld
    // 0.005, Brush 1/255). opts.poolMin: donors need at least this opacity
    // (0 = the whole live population, as 3DGS-MCMC / Brush draw)
    const deadThr = this.opts.deadThr ?? 0.02;
    const poolMin = this.opts.poolMin ?? 0.05;
    // opts.deadTiny: a splat whose mean log-scale sits on the minScale wall
    // (all three axes collapsed — an opaque dot no pixel integrates) is dead
    // capacity too; relocate it like an opacity death. Decay-for-reg runs
    // (2026-09-02) parked 5–25 % of the population there.
    const tinyAt = this.opts.deadTiny ? this.adamData[20] + 0.05 : -Infinity;
    let dead = [];
    const pool = [];      // donor candidates (alive enough to carry mass)
    let deadAll = 0;
    for (let i = 0; i < this.n; i++) {
      const o = sig(g[i * 4]);
      if (o < deadThr || g[i * 4 + 3] <= tinyAt) { deadAll++; if (canReloc) dead.push(i); }
      else if (o >= poolMin) pool.push(i);
    }
    let survived = 0;
    if (this._lastReloc) for (const i of this._lastReloc) if (sig(g[i * 4]) >= deadThr) survived++;
    const census = { dead: deadAll, survived, lastReloc: this._lastReloc ? this._lastReloc.length : 0 };
    if (pool.length < 16) return { moved: 0, grown: 0, n: this.n, ...census };
    const moveCap = Math.ceil(this.n * (this.opts.moveCap ?? 1.0));
    if (dead.length > moveCap) dead = dead.slice(0, moveCap);
    const grown = canGrow
      ? Math.max(0, Math.min(Math.ceil(this.n * (this.opts.growRate ?? 0.15)), limit - this.n)) : 0;
    if (dead.length === 0 && grown === 0) return { moved: 0, grown: 0, n: this.n };

    // donor sampling ∝ accumulated error mass (fallback: opacity, e.g. the
    // first refine of a run before any window has accumulated)
    // opts.donorWeight: 'err' (default), 'opa' (3DGS-MCMC exact: donors ∝
    // opacity, so eq-9 clones are born visible — with error mass the pool's
    // p50 opacity 0.08 splits into clones at 0.02–0.04, the death line), or
    // 'erropa' (product), 'opavis' (Brush: ∝ opacity among the splats that
    // rendered in the window — error mass > 0 is the visibility record)
    const dw = this.opts.donorWeight ?? 'err';
    const cdf = new Float64Array(pool.length);
    let acc = 0;
    for (let k = 0; k < pool.length; k++) {
      const p = pool[k] * 4;
      acc += dw === 'opa' ? sig(g[p])
        : dw === 'erropa' ? g[p + 2] * sig(g[p])
        : dw === 'opavis' ? (g[p + 2] > 0 ? sig(g[p]) : 0)
        : g[p + 2];
      cdf[k] = acc;
    }
    if (!(acc > 0)) {
      acc = 0;
      for (let k = 0; k < pool.length; k++) { acc += sig(g[pool[k] * 4]); cdf[k] = acc; }
    }
    const draw = () => {
      const r = rng() * acc;
      let lo = 0, hi = pool.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
      return pool[lo];
    };

    // growth first: legacy-style SPLIT of the biggest donors (footprint
    // conserved, both halves /1.6) — the one v1 heuristic eq-9 cloning
    // measurably undershoots; error-guided eq-9 stays for relocation only.
    // Split donors are chosen up front and EXCLUDED from relocation draws:
    // a row adjusted by two concurrent donor ops is a lost-update race.
    // opts.growSplit = false grows through the eq-9 mechanic instead.
    const splitOps = [];
    const splitDonors = new Set();
    const eqGrow = [];
    if (grown > 0 && (this.opts.growSplit ?? false)) {
      const bigs = pool.filter((p) => g[p * 4] > -0.405).sort((a, b) => g[b * 4 + 3] - g[a * 4 + 3])
        .slice(0, Math.min(pool.length - 8, Math.max(16, pool.length >> 2)));
      let bi = 0;
      for (let k = 0; k < grown; k++) {
        if (bi >= bigs.length) { eqGrow.push(this.n + k); continue; } // ran out: eq-9 clone
        const don = bigs[bi++]; // one split per donor per refine
        splitOps.push([this.n + k, don]);
        splitDonors.add(don);
      }
    } else {
      for (let k = 0; k < grown; k++) eqGrow.push(this.n + k);
    }
    // relocation (+ eq-9 growth overflow): donor -> destination rows.
    // ratioCap spreads selection across the error distribution: unbounded
    // error-weighted sampling piles dozens of clones onto the few hottest
    // donors and eq-9 then slashes exactly those splats' opacity to dust
    const groupsMap = new Map();
    const ratioCap = this.opts.ratioCap ?? 3;
    const assign = (dst, mustPlace) => {
      let don = draw();
      for (let t = 0; t < 6 &&
        (splitDonors.has(don) || (groupsMap.get(don) || []).length >= ratioCap); t++) don = draw();
      if (splitDonors.has(don)) {
        // a NEW row must be written (it goes live when n grows) — any
        // non-split donor will do; a dead slot can simply stay dead a round
        if (!mustPlace) return;
        don = pool.find((p) => !splitDonors.has(p));
        if (don == null) return;
      }
      if (!groupsMap.has(don)) groupsMap.set(don, []);
      groupsMap.get(don).push(dst);
    };
    for (const slot of dead) assign(slot, false);
    for (const dst of eqGrow) assign(dst, true);
    this._lastReloc = dead;

    // eq-9 per donor group (binoms are tiny — compute on the fly)
    if (!this._binoms) {
      const NMAX = 51;
      const b = [];
      for (let i = 0; i < NMAX; i++) {
        b.push(new Float64Array(i + 1));
        for (let k = 0; k <= i; k++) b[i][k] = k === 0 || k === i ? 1 : b[i - 1][k - 1] + b[i - 1][k];
      }
      this._binoms = b;
    }
    // plan layout: clone-copies first, donor adjustments after — executed as
    // two ORDERED dispatches so no clone can copy an already-adjusted donor
    // row (single-dispatch racing double-applied the eq-9 shrink at random)
    const u32 = new Uint32Array(this.planCap * 8);
    const f32 = new Float32Array(u32.buffer);
    const donorOps = [];
    let nClone = 0;
    const pushOp = (at, dst, src, flags, newO, dls, seed = 0) => {
      const o = at * 8;
      u32[o] = dst; u32[o + 1] = src; u32[o + 2] = flags; u32[o + 3] = seed;
      f32[o + 4] = newO; f32[o + 5] = dls;
    };
    // opts.eq9 = false swaps in v1 opacity semantics (clone born 0.25 at
    // x0.85 scale, donor untouched) while keeping error-guided donor CHOICE —
    // the isolation knob for whether eq-9's donor tax pays for itself
    const useEq9 = this.opts.eq9 ?? true;
    for (const [don, dsts] of groupsMap) {
      if (!useEq9) {
        const nO = Math.log(0.25 / 0.75), dl = Math.log(0.85);
        for (const dst of dsts) pushOp(nClone++, dst, don, 1 | 2 | 4 | 16, nO, dl, (rng() * 4294967295) >>> 0);
        continue;
      }
      const ratio = Math.min(51, dsts.length + 1);
      const oldO = sig(g[don * 4]);
      const newO = Math.max(1 - Math.pow(1 - oldO, 1 / ratio), 0.005);
      let denom = 0;
      for (let i = 1; i <= ratio; i++) {
        for (let k = 0; k <= i - 1; k++) {
          denom += this._binoms[i - 1][k] * (Math.pow(-1, k) / Math.sqrt(k + 1)) * Math.pow(newO, k + 1);
        }
      }
      const dls = Math.log(Math.max(1e-6, oldO / denom));
      const newLogit = Math.log(newO / (1 - newO));
      donorOps.push([don, newLogit, dls]);
      for (const dst of dsts) pushOp(nClone++, dst, don, 1 | 2 | 4 | 16, newLogit, dls, (rng() * 4294967295) >>> 0);
    }
    // splits ride the same two ordered dispatches: clone-copy first (copy +
    // /1.6 shrink, opacity inherited via the copy), donor shrink second
    const SHRINK = Math.log(1 / 1.6);
    for (const [dst, don] of splitOps) pushOp(nClone++, dst, don, 1 | 4 | 16, 0, SHRINK, (rng() * 4294967295) >>> 0);
    const nDonor = donorOps.length + splitOps.length;
    let dk = nClone;
    donorOps.forEach(([don, newLogit, dls]) => pushOp(dk++, don, don, 2 | 4 | 8, newLogit, dls));
    for (const [, don] of splitOps) pushOp(dk++, don, don, 4 | 8, 0, SHRINK);
    const nOps = nClone + nDonor;

    d.queue.writeBuffer(this.bufPlan, 0, u32, 0, nOps * 8);
    d.queue.writeBuffer(this.uniRefine, 0, new Uint32Array([nClone, this.shK * 3, 0, 0]));
    d.queue.writeBuffer(this.uniRefineB, 0, new Uint32Array([nDonor, this.shK * 3, nClone, 0]));
    {
      const enc = d.createCommandEncoder();
      const p = enc.beginComputePass();
      p.setPipeline(this.pipeRefineApply);
      const disp = (bg, count) => {
        if (!count) return;
        p.setBindGroup(0, bg);
        const groups = Math.ceil(count / 256);
        if (groups <= 65535) p.dispatchWorkgroups(groups);
        else p.dispatchWorkgroups(65535, Math.ceil(groups / 65535));
      };
      disp(this.bgRefineApply, nClone);
      disp(this.bgRefineApplyB, nDonor);
      p.end();
      d.queue.submit([enc.finish()]);
    }
    if (grown > 0) {
      this.n += grown;
      this.adamData[23] = this.n * STRIDE;
      this.camUniforms = this.camMeta.map((mm, i) => this._camUniform(mm, 1, mm.offset, i));
    }
    return { moved: dead.length, grown, n: this.n, ...census };
  }

  /** Legacy MCMC-lite refinement: relocate dead splats onto jittered copies of
   *  well-supported donors (resetting their Adam state) and grow the splat
   *  count by up to 5% per call until the buffer cap is reached.
   *  opts.relocUntil stops the relocation churn after that iteration so the
   *  final stretch consolidates a stable population (a relocated clone is
   *  born at opacity 0.25 and half-trained clones would otherwise ship in
   *  the export); default Infinity = relocate for the whole run.
   *  Returns { moved, grown, n }. */
  async _refineLegacy(rng = this.rand) {
    const canReloc = this.iter < (this.opts.relocUntil ?? Infinity);
    const canGrow = this.iter < (this.opts.growUntil ?? 0.75 * this.horizon) && this.n < Math.min(this.cap, this.growLimit || this.cap);
    if (!canReloc && !canGrow) return { moved: 0, grown: 0, n: this.n };
    const d = this.device;
    const nb = this.cap * STRIDE * 4;
    const readBuf = async (buf, bytes = nb) => {
      const rb = d.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(buf, 0, rb, 0, bytes);
      d.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(rb.getMappedRange()).slice();
      rb.unmap(); rb.destroy();
      return out;
    };
    const params = await readBuf(this.bufParams);
    const m = await readBuf(this.bufM);
    const v = await readBuf(this.bufV);
    const shr = this.shK * 3;
    const sh = this.shK ? await readBuf(this.bufSH, this.cap * shr * 4) : null;
    const shM = this.shK ? await readBuf(this.bufSHM, this.cap * shr * 4) : null;
    const shV = this.shK ? await readBuf(this.bufSHV, this.cap * shr * 4) : null;
    const sig = (x) => 1 / (1 + Math.exp(-x));

    // opts.errDonors: read the per-splat error-mass window (gradP slot 11,
    // accumulated since the last refine; the gather zeroes it) through the
    // refineV2 gather pass. Donor choice ∝ error instead of ∝ size — new
    // capacity goes where the image is wrong, not where splats are big.
    let emass = null;
    if (this.opts.errDonors) {
      d.queue.writeBuffer(this.uniGather, 0, new Uint32Array([this.n, 0, 0, 0]));
      const encG = d.createCommandEncoder();
      const pg = encG.beginComputePass();
      pg.setPipeline(this.pipeGather);
      pg.setBindGroup(0, this.bgGather);
      const groups = Math.ceil(this.n / 256);
      if (groups <= 65535) pg.dispatchWorkgroups(groups);
      else pg.dispatchWorkgroups(65535, Math.ceil(groups / 65535));
      pg.end();
      encG.copyBufferToBuffer(this.bufGather, 0, this.bufGatherRead, 0, this.n * 16);
      d.queue.submit([encG.finish()]);
      await this.bufGatherRead.mapAsync(GPUMapMode.READ, 0, this.n * 16);
      emass = new Float32Array(this.bufGatherRead.getMappedRange(0, this.n * 16)).slice();
      this.bufGatherRead.unmap();
    }

    let dead = [];
    const donors = [];
    let deadAll = 0;
    const deadThr = this.opts.deadThr ?? 0.02;
    for (let i = 0; i < this.n; i++) {
      const o = sig(params[i * STRIDE + 13]);
      if (o < deadThr) { deadAll++; if (canReloc) dead.push(i); }
      else if (o > 0.4) donors.push(i);
    }
    // telemetry: how many of the rows relocated last round are still alive
    let survived = 0;
    if (this._lastReloc) {
      for (const i of this._lastReloc) if (sig(params[i * STRIDE + 13]) >= deadThr) survived++;
    }
    const census = { dead: deadAll, survived, lastReloc: this._lastReloc ? this._lastReloc.length : 0 };
    if (donors.length < 16) return { moved: 0, grown: 0, n: this.n, ...census };
    // relocation ceiling per refine — at the old hard 5%, any dead fraction
    // above it stayed dead FOREVER (a monotonic capacity leak; the reference
    // relocates every dead splat every 100 iters)
    const moveCap = Math.ceil(this.n * (this.opts.moveCap ?? 0.05));
    if (dead.length > moveCap) dead = dead.slice(0, moveCap);

    const gauss = () => {
      const u = Math.max(1e-9, rng()), w = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
    };
    // Blur is carried by LARGE well-supported splats (typically background —
    // SfM points cluster on foreground, and uniform cloning compounds that
    // imbalance: measured 5x capacity = +0.4dB only). Growth therefore
    // prefers SPLITTING the biggest donors, classic-3DGS style: both halves
    // shrink /1.6 so the footprint is conserved and each half can sharpen.
    const meanLogScale = (i) =>
      (params[i * STRIDE + 3] + params[i * STRIDE + 4] + params[i * STRIDE + 5]) / 3;
    const bigDonors = [...donors]
      .sort((a, b) => meanLogScale(b) - meanLogScale(a))
      .slice(0, Math.max(16, donors.length >> 2));
    // error-weighted donor draw (only when the window carries any mass)
    let drawErr = null;
    if (emass) {
      const cdf = new Float64Array(donors.length);
      let acc = 0;
      for (let k = 0; k < donors.length; k++) { acc += Math.max(0, emass[donors[k] * 4 + 2]); cdf[k] = acc; }
      if (acc > 0) {
        drawErr = () => {
          const r = rng() * acc;
          let lo = 0, hi = donors.length - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
          return donors[lo];
        };
      }
    }
    const splitV2 = this.opts.splitV2 === true;
    const usedSplit = new Set();
    const spawnAt = (bi, allowSplit) => {
      const doSplit = splitV2
        ? true
        : (allowSplit && rng() < 0.7 && (drawErr ? donors.length > 16 : bigDonors.length > 16));
      let don;
      if (drawErr) {
        don = drawErr();
        if (doSplit) { // prefer one split per donor per refine
          for (let tries = 0; usedSplit.has(don) && tries < 8; tries++) don = drawErr();
          usedSplit.add(don);
        }
      } else if (doSplit && !splitV2) {
        const di = (rng() * bigDonors.length) | 0;
        don = bigDonors[di];
        bigDonors[di] = bigDonors[bigDonors.length - 1];
        bigDonors.pop(); // a splat splits at most once per refine call
      } else {
        don = donors[(rng() * donors.length) | 0];
      }
      const bd = don * STRIDE;
      if (splitV2) {
        // Brush/classic-3DGS split: offset drawn from the donor's OWN
        // ellipsoid (rotated frame, sigma 0.5), applied +/- to the two
        // halves; scales /sqrt(2) on both; opacity alpha-conserving
        // o -> 1-sqrt(1-o) on both. Image-neutral at birth — the optimizer
        // never spends iterations undoing the add. Donor keeps its moments.
        let qw = params[bd + 6], qx = params[bd + 7], qy = params[bd + 8], qz = params[bd + 9];
        const qn = Math.hypot(qw, qx, qy, qz) || 1;
        qw /= qn; qx /= qn; qy /= qn; qz /= qn;
        const ex = gauss() * 0.5 * Math.exp(params[bd + 3]);
        const ey = gauss() * 0.5 * Math.exp(params[bd + 4]);
        const ez = gauss() * 0.5 * Math.exp(params[bd + 5]);
        const ox = (1 - 2 * (qy * qy + qz * qz)) * ex + 2 * (qx * qy - qw * qz) * ey + 2 * (qx * qz + qw * qy) * ez;
        const oy = 2 * (qx * qy + qw * qz) * ex + (1 - 2 * (qx * qx + qz * qz)) * ey + 2 * (qy * qz - qw * qx) * ez;
        const oz = 2 * (qx * qz - qw * qy) * ex + 2 * (qy * qz + qw * qx) * ey + (1 - 2 * (qx * qx + qy * qy)) * ez;
        params[bi] = params[bd] + ox;
        params[bi + 1] = params[bd + 1] + oy;
        params[bi + 2] = params[bd + 2] + oz;
        params[bd] -= ox; params[bd + 1] -= oy; params[bd + 2] -= oz;
        for (let k = 3; k <= 12; k++) params[bi + k] = params[bd + k];
        const shrink = Math.log(1 / Math.SQRT2);
        for (let k = 3; k <= 5; k++) { params[bi + k] += shrink; params[bd + k] += shrink; }
        const o = sig(params[bd + 13]);
        const oNew = Math.min(0.9999, Math.max(1e-4, 1 - Math.sqrt(1 - o)));
        const lgt = Math.log(oNew / (1 - oNew));
        params[bi + 13] = lgt; params[bd + 13] = lgt;
      } else {
        const s = Math.exp(meanLogScale(don));
        params[bi] = params[bd] + gauss() * s * 0.7;
        params[bi + 1] = params[bd + 1] + gauss() * s * 0.7;
        params[bi + 2] = params[bd + 2] + gauss() * s * 0.7;
        for (let k = 3; k <= 12; k++) params[bi + k] = params[bd + k];
        if (doSplit) {
          const shrink = Math.log(1 / 1.6);
          for (let k = 3; k <= 5; k++) { params[bi + k] += shrink; params[bd + k] += shrink; }
          params[bi + 13] = params[bd + 13]; // split keeps the donor's opacity
          for (let k = 0; k < STRIDE; k++) { m[bd + k] = 0; v[bd + k] = 0; } // donor changed shape: reset its moments
        } else {
          params[bi + 3] += Math.log(0.85);
          params[bi + 4] += Math.log(0.85);
          params[bi + 5] += Math.log(0.85);
          params[bi + 13] = Math.log(0.25 / 0.75);
        }
      }
      params[bi + 14] = 0; params[bi + 15] = 0;
      for (let k = 0; k < STRIDE; k++) { m[bi + k] = 0; v[bi + k] = 0; }
      if (sh) { // clones/splits inherit the donor's view-dependence, fresh moments
        const so = (bi / STRIDE) * shr;
        const sd = don * shr;
        for (let k = 0; k < shr; k++) {
          sh[so + k] = sh[sd + k];
          shM[so + k] = 0; shV[so + k] = 0;
          if (doSplit && !splitV2) { shM[sd + k] = 0; shV[sd + k] = 0; }
        }
      }
    };
    for (const i of dead) spawnAt(i * STRIDE, false); // relocation: to mass, as before
    this._lastReloc = dead;
    // growth: new capacity where mass already is (stop late in training so
    // the last iterations refine a stable population)
    // 0.15/step with the 1e-4 minScale floor: capacity converts to real
    // sharpness now (truck 52k -> 235k splats = +0.84dB holdout); the old
    // timid 0.05 predates the floor fix, when extra splats bought nothing
    // growLimit: a soft, raisable ceiling below cap — LOD training holds the
    // model at each detail level, snapshots it, then lets it grow on
    const limit = Math.min(this.cap, this.growLimit || this.cap);
    const grown = this.iter < (this.opts.growUntil ?? 0.75 * this.horizon)
      ? Math.max(0, Math.min(Math.ceil(this.n * (this.opts.growRate ?? 0.15)), limit - this.n)) : 0;
    for (let k = 0; k < grown; k++) spawnAt((this.n + k) * STRIDE, true);
    if (grown > 0) {
      this.n += grown;
      this.adamData[23] = this.n * STRIDE;
      this.camUniforms = this.camMeta.map((mm, i) => this._camUniform(mm, 1, mm.offset, i));
    }
    d.queue.writeBuffer(this.bufParams, 0, params);
    d.queue.writeBuffer(this.bufM, 0, m);
    d.queue.writeBuffer(this.bufV, 0, v);
    if (sh) {
      d.queue.writeBuffer(this.bufSH, 0, sh);
      d.queue.writeBuffer(this.bufSHM, 0, shM);
      d.queue.writeBuffer(this.bufSHV, 0, shV);
    }

    // tile-pressure telemetry (counts from the most recent render)
    const rbT = d.createBuffer({ size: this.maxTiles * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encT = d.createCommandEncoder();
    encT.copyBufferToBuffer(this.bufTileCnt, 0, rbT, 0, this.maxTiles * 4);
    d.queue.submit([encT.finish()]);
    await rbT.mapAsync(GPUMapMode.READ);
    const cnts = new Uint32Array(rbT.getMappedRange());
    let maxTile = 0;
    for (let i = 0; i < this.maxTiles; i++) {
      if (cnts[i] > maxTile) maxTile = cnts[i];
    }
    rbT.unmap(); rbT.destroy();
    // entry-budget drops (whole tiles skipped) are counted by the scan pass
    // into stats[3] and surfaced via readLoss -> this.entryOverflowTiles
    return { moved: dead.length, grown, n: this.n, maxTile, overflow: this.entryOverflowTiles || 0, ...census };
  }

  /** Cheap health probe: sample the head of the params buffer. iOS Safari
   *  can purge WebGPU buffer contents from a backgrounded tab WITHOUT firing
   *  device-loss — the model keeps "training" on zeroed or garbage state.
   *  Returns false when the sample is all-zero / non-finite / unreadable. */
  async sanityProbe() {
    try {
      const d = this.device;
      const bytes = Math.min(this.n, 64) * STRIDE * 4;
      const rb = d.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(this.bufParams, 0, rb, 0, bytes);
      d.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const v = new Float32Array(rb.getMappedRange());
      let nonzero = false;
      for (let i = 0; i < v.length; i++) {
        if (!Number.isFinite(v[i])) { rb.unmap(); rb.destroy(); return false; }
        if (v[i] !== 0) nonzero = true;
      }
      rb.unmap(); rb.destroy();
      return nonzero;
    } catch {
      return false; // unreadable = the device is gone in all but name
    }
  }

  /** Read back current Gaussian parameters (+ SH coeffs when enabled). */
  async readGaussians() {
    const d = this.device;
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.bufParams, 0, this.bufParamsRead, 0, this.n * STRIDE * 4);
    d.queue.submit([enc.finish()]);
    await this.bufParamsRead.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(this.bufParamsRead.getMappedRange()).slice();
    this.bufParamsRead.unmap();
    let sh = null;
    if (this.shK) {
      const bytes = this.n * this.shK * 3 * 4;
      const rb = d.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const e2 = d.createCommandEncoder();
      e2.copyBufferToBuffer(this.bufSH, 0, rb, 0, bytes);
      d.queue.submit([e2.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      sh = new Float32Array(rb.getMappedRange()).slice();
      rb.unmap(); rb.destroy();
    }
    return { data, n: this.n, sh, shK: this.shK, dc: this.dcMode };
  }
}
