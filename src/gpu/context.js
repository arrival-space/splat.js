// gpu/context.js — one WebGPU device for the whole pipeline.
//
// The trainer and the SIFT matcher share it (two devices double descriptor
// VRAM and can never share buffers), and a host that already owns a device —
// e.g. a PlayCanvas app — can hand it in instead.

/**
 * @typedef {object} GpuContext
 * @property {GPUDevice} device
 * @property {GPUAdapter|null} adapter   null when the device was handed in
 * @property {boolean} owned             whether dispose() destroys the device
 * @property {() => void} dispose
 */

/**
 * @param {{ device?: GPUDevice, powerPreference?: GPUPowerPreference }} [opts]
 * @returns {Promise<GpuContext>}
 */
export async function createGpu(opts = {}) {
  if (opts.device) {
    return watchLost({ device: opts.device, adapter: null, info: opts.info || {}, owned: false, dispose() {} });
  }
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU not available in this environment');
  }
  const attempt = async () => {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: opts.powerPreference || 'high-performance',
    });
    if (!adapter) throw new Error('no WebGPU adapter');
    // full-res training-target buffers can exceed the 128MB default binding
    // limit — ask for everything the adapter offers, up to 4GB (measured: 426
    // pano faces at 1024px = 1.79GB of packed targets; desktop NVIDIA adapters
    // offer 2GB). Asking for the adapter's own maximum can never fail.
    const want = 4 * (1 << 30);
    const device = await adapter.requestDevice({
      // subgroups (when the adapter has them) let the render backward
      // aggregate its workgroup-shared gradient atomics per-subgroup —
      // optional: shaders compile a fallback without it
      requiredFeatures: [
        ...(adapter.features.has('subgroups') ? ['subgroups'] : []),
        // per-pass GPU timestamps for the profiling step (trainer.profileSteps)
        ...(adapter.features.has('timestamp-query') ? ['timestamp-query'] : []),
      ],
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, want),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, want),
      },
    });
    return { adapter, device };
  };
  let got;
  try {
    got = await attempt();
  } catch (e) {
    // DXGI_ERROR_DEVICE_REMOVED at requestDevice is often a momentary driver
    // stall (seen in the wild on user machines, not just test rigs). The
    // adapter handle dies with the device, so wait a beat and re-request
    // BOTH once before surfacing the failure.
    await new Promise((r) => setTimeout(r, 1500));
    got = await attempt();
  }
  const { adapter, device } = got;
  const info = adapter.info || {};
  return watchLost({ device, adapter, info, owned: true, dispose() { device.destroy(); } });
}

/** Surface real device loss (iOS reclaims WebGPU devices from backgrounded
 *  tabs; drivers reset). An intentional dispose() also settles device.lost,
 *  with reason 'destroyed' — that one is not a loss. */
function watchLost(ctx) {
  ctx.lost = false;
  if (ctx.device.lost && typeof ctx.device.lost.then === 'function') {
    ctx.device.lost.then((info) => {
      if (info && info.reason === 'destroyed') return;
      ctx.lost = true;
      if (ctx.onLost) ctx.onLost(info);
    }).catch(() => {});
  }
  return ctx;
}
