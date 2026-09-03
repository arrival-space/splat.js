// session_io.js — save a trained run, load it back, share it as a link.
//
// Two artifacts, packed into one session zip next to the web-ready SOG:
//
//   recon.json — cameras at feature scale, frame metadata, a downsampled
//     sparse cloud, the source file list: everything the app needs to
//     PRESENT a model (capture-path tour, frustums, orbit pivot) without
//     re-solving, and to refetch the images for a training resume.
//   state.bin  — the trainer's raw float parameters and SH coefficients:
//     a bit-exact resume, no opacity baking, no SOG quantization.
//
// ?model=<url> accepts a session .zip, a .ply, or a .sog (decoded via the
// vendored splat-transform); &recon=<url> adds presentation state to bare
// model files. Bare exports carry baked opacities — fine for viewing, and
// re-exports pass them through unchanged.

import { zipStore } from './zip.js';
import { loadST } from './sog.js';

const STRIDE = 16;
const SH_C0 = 0.28209479177387814;

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

/** Presentation + resume metadata for the current run. */
/** The trainer RECIPE: every option the session's trainer was created with
 *  except the per-run sizing (maxSplats / capMult, recorded as the run's cap),
 *  plus the session's refine cadence. Saved in the state header and the recon
 *  JSON so a resume, a continue-from-share or a view-from-state rebuilds the
 *  SAME trainer — mipComp, anisoReg, minScale, refineV2, growRate, the MCMC
 *  set … Before this (2026-09-03) every resume fell back to bare defaults,
 *  and a model trained without Mip compensation would have been un-baked and
 *  re-rendered with it. Absent recipe (old records) = the legacy defaults. */
export function trainRecipe(ses) {
  const t = { ...((ses.opts && ses.opts.trainer) || {}) };
  delete t.maxSplats; delete t.capMult;
  if (ses.opts && ses.opts.refineEvery != null) t.refineEvery = ses.opts.refineEvery;
  return t;
}

export function buildReconJson(S) {
  const ses = S.session;
  const recon = ses.recon;
  const r6 = (a) => Array.from(a, (v) => +v.toPrecision(7));
  const pts = recon.points || [];
  const step = Math.max(1, Math.ceil(pts.length / 4000));
  const cloud = { xyz: [], rgb: [] };
  for (let i = 0; i < pts.length; i += step) {
    cloud.xyz.push(+pts[i].X[0].toPrecision(5), +pts[i].X[1].toPrecision(5), +pts[i].X[2].toPrecision(5));
    const c = pts[i].rgb;
    cloud.rgb.push(Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255));
  }
  return {
    version: 1,
    app: 'splat.js',
    name: S.preset && S.preset.name || 'splat',
    recipe: trainRecipe(ses),
    iter: ses.trainer.iter,
    splats: ses.trainer.n,
    shK: ses.trainer.shK,
    sceneRadius: ses.model.radius,
    center: ses.model.center ? r6(ses.model.center) : null,
    k1: recon.k1, k2: recon.k2, fFeat: recon.fFeat ?? null,
    cams: recon.cams.map((c) => ({
      imgIdx: c.imgIdx, name: ses.frames[c.imgIdx].name,
      R: r6(c.R), t: r6(c.t), f: +c.f.toPrecision(7),
      cx: c.cx, cy: c.cy,
    })),
    frames: ses.frames.map((f) => ({ name: f.name, fw: f.fw, fh: f.fh, tw: f.tw, th: f.th })),
    source: {
      preset: S.preset && !String(S.preset.id).startsWith('__') ? S.preset.id : null,
      names: (S.loadedFiles || []).map((f) => f.name),
      // absolute URLs where the images live (preset runs resolve against the
      // deployment's data root — own captures have no URL and stay names-only)
      urls: (S.loadedFiles || []).map((f) => f.url ? new URL(f.url, location.href).href : null),
    },
    stats: {
      minutes: S.minutes || 0,
      psnrTrain: S.psnrTrain ?? null,
      psnrHold: S.psnrHold ?? null,
      psnrTest: S.psnrTest ? { psnr: S.psnrTest.psnr, frames: S.psnrTest.frames.length } : null,
      // the training curve, decimated to ~400 points
      chart: decimate(ses.lossHistory || [], 400).map(([i, p]) => [i, +p.toFixed(3)]),
      holds: (S.holdHist || []).map(([i, p]) => [i, +p.toFixed(3)]),
    },
    cloud,
  };
}

const decimate = (arr, max) => {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
  return out;
};

/** The trainer's exact float state as one binary blob. */
export async function packState(ses) {
  const { data, n, sh, shK, dc } = await ses.exportRawState();
  const head = new TextEncoder().encode(JSON.stringify({
    magic: 'splatjs-state', version: 1, n, shK, iter: ses.trainer.iter,
    // convention tags (absent in old blobs = the v1 defaults): dc names the
    // color-slot encoding, engine picks the trainer a resume must rebuild
    dc: dc || 'sigmoid', engine: ses.trainer.v2 ? 'v2' : 'v1',
    recipe: trainRecipe(ses),
  }));
  const params = new Uint8Array(data.buffer, data.byteOffset, n * STRIDE * 4);
  const shBytes = sh ? new Uint8Array(sh.buffer, sh.byteOffset, n * shK * 3 * 4) : new Uint8Array(0);
  const out = new Uint8Array(4 + head.length + params.length + shBytes.length);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(params, 4 + head.length);
  out.set(shBytes, 4 + head.length + params.length);
  return out;
}

/** model.sog + recon.json + state.bin -> one resumable zip. */
export async function buildSessionZip(S, sogBlob) {
  const recon = buildReconJson(S);
  const state = await packState(S.session);
  return zipStore([
    { name: 'model.sog', data: new Uint8Array(await sogBlob.arrayBuffer()) },
    { name: 'recon.json', data: new TextEncoder().encode(JSON.stringify(recon)) },
    { name: 'state.bin', data: state },
  ]);
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

/** STORED-entry zip reader (the writer next door emits nothing else). */
export function unzipStore(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  let o = 0;
  while (o + 30 <= bytes.length && dv.getUint32(o, true) === 0x04034b50) {
    const method = dv.getUint16(o + 8, true);
    const size = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const nameEnd = o + 30 + nameLen;
    const start = nameEnd + extraLen;
    const end = start + size;
    if (nameEnd > bytes.length || start > bytes.length || end > bytes.length) {
      throw new Error('truncated zip entry');
    }
    const name = new TextDecoder().decode(bytes.subarray(o + 30, nameEnd));
    if (method !== 0) throw new Error(`zip entry ${name} is compressed — not a splat.js session zip`);
    out.set(name, bytes.subarray(start, end));
    o = end;
  }
  return out;
}

export function parseState(bytes) {
  if (bytes.length < 4) throw new Error('truncated state header');
  const headLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  if (headLen > bytes.length - 4) throw new Error('truncated state header');
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headLen)));
  if (head.magic !== 'splatjs-state' || head.version !== 1) {
    throw new Error('not a supported splat.js state blob');
  }
  if (!Number.isSafeInteger(head.n) || head.n < 1 ||
      ![0, 3, 8, 15].includes(head.shK) ||
      !Number.isSafeInteger(head.iter) || head.iter < 0) {
    throw new Error('invalid state metadata');
  }
  let o = 4 + headLen;
  const expected = head.n * (STRIDE * 4 + head.shK * 3 * 4);
  if (!Number.isSafeInteger(expected) || bytes.length - o !== expected) {
    throw new Error('state data length does not match its header');
  }
  const params = new Float32Array(head.n * STRIDE);
  new Uint8Array(params.buffer).set(bytes.subarray(o, o + params.byteLength));
  o += params.byteLength;
  let sh = null;
  if (head.shK) {
    sh = new Float32Array(head.n * head.shK * 3);
    new Uint8Array(sh.buffer).set(bytes.subarray(o, o + sh.byteLength));
  }
  return {
    gaussians: { data: params, n: head.n, sh, shK: head.shK, dc: head.dc === 'sh' ? 'sh' : 'sigmoid' },
    iter: head.iter,
    engine: head.engine === 'v2' ? 'v2' : 'v1',
    recipe: head.recipe && typeof head.recipe === 'object' ? head.recipe : null,
  };
}

function readPlyHeader(bytes) {
  // PLY headers can exceed a few KiB when tools add comments or many
  // properties. Scan a bounded prefix instead of assuming the terminator is in
  // the first 4096 bytes, but still reject files with an unreasonably large or
  // missing header before allocating typed-array views for the body.
  const limit = Math.min(bytes.length, 1024 * 1024);
  const headText = new TextDecoder().decode(bytes.subarray(0, limit));
  // LF or CRLF terminator — some Windows tools write CRLF headers
  const m = headText.match(/end_header\r?\n/);
  if (!m) throw new Error('not a PLY file');
  return {
    header: headText.slice(0, m.index).replace(/\r\n/g, '\n'),
    bodyAt: m.index + m[0].length,
  };
}

/** Standard 3DGS PLY -> the trainer's raw layout (exact inverse of the
 *  exporter's activations; opacities stay as stored — baked is fine to view
 *  and passes through re-exports unchanged). */
export function parsePlyGaussians(bytes) {
  const { header, bodyAt } = readPlyHeader(bytes);
  if (!header.startsWith('ply\n')) throw new Error('not a PLY file');
  if (!/^format binary_little_endian 1\.0$/m.test(header)) {
    throw new Error('PLY must use binary_little_endian 1.0');
  }
  let n = 0, vertex = false;
  const props = [];
  for (const l of header.split('\n')) {
    const me = l.match(/^element (\S+) (\d+)/);
    if (me) {
      vertex = me[1] === 'vertex';
      if (vertex) n = +me[2];
      continue;
    }
    const mp = l.match(/^property (\S+) (\S+)/);
    if (vertex && mp) {
      if (mp[1] !== 'float') throw new Error(`unsupported PLY vertex property type ${mp[1]}`);
      props.push(mp[2]);
    }
  }
  if (!Number.isSafeInteger(n) || n < 1 || new Set(props).size !== props.length) {
    throw new Error('invalid PLY vertex header');
  }
  const idx = Object.fromEntries(props.map((p, i) => [p, i]));
  const need = [
    'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  ];
  for (const k of need) if (idx[k] == null) throw new Error(`PLY has no ${k} — not a 3DGS splat file`);
  const rest = props.filter((p) => p.startsWith('f_rest_'));
  const K = rest.length / 3;
  if (![0, 3, 8, 15].includes(K) ||
      rest.some((_, k) => idx[`f_rest_${k}`] == null)) {
    throw new Error('unsupported or incomplete PLY spherical harmonics');
  }
  const stride = props.length;
  const bodyBytes = n * stride * 4;
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes > bytes.length - bodyAt) {
    throw new Error('truncated PLY vertex data');
  }
  // slice: the body must land 4-aligned for the Float32Array view (a PLY
  // header has arbitrary length, and zip entries sit at arbitrary offsets)
  const body = bytes.slice(bodyAt, bodyAt + bodyBytes);
  const src = new Float32Array(body.buffer, 0, n * stride);
  const data = new Float32Array(n * STRIDE);
  const sh = K ? new Float32Array(n * K * 3) : null;
  const logit = (v) => {
    const c = Math.min(1 - 1e-5, Math.max(1e-5, v));
    return Math.log(c / (1 - c));
  };
  for (let i = 0; i < n; i++) {
    const s = i * stride, d = i * STRIDE;
    data[d] = src[s + idx.x]; data[d + 1] = src[s + idx.y]; data[d + 2] = src[s + idx.z];
    data[d + 3] = src[s + idx.scale_0]; data[d + 4] = src[s + idx.scale_1]; data[d + 5] = src[s + idx.scale_2];
    data[d + 6] = src[s + idx.rot_0]; data[d + 7] = src[s + idx.rot_1];
    data[d + 8] = src[s + idx.rot_2]; data[d + 9] = src[s + idx.rot_3];
    // keep the STANDARD SH-DC convention (tagged below): converting to
    // sigmoid logits here destroyed out-of-range colors before the trainer
    // could see them (v2 exports lost ~1.1 dB on re-import). The trainer's
    // setup() bridges to whichever convention its engine needs.
    data[d + 10] = src[s + idx.f_dc_0];
    data[d + 11] = src[s + idx.f_dc_1];
    data[d + 12] = src[s + idx.f_dc_2];
    data[d + 13] = src[s + idx.opacity];
    for (let k = 0; k < 3 * K; k++) sh[i * 3 * K + k] = src[s + idx[`f_rest_${k}`]];
  }
  return { data, n, sh, shK: K, dc: 'sh' };
}

/** .sog bytes -> gaussians, via the vendored splat-transform (sog -> ply in
 *  memory -> parse). */
export async function sogToGaussians(bytes) {
  const st = await loadST();
  const rfs = new st.MemoryReadFileSystem();
  rfs.set('model.sog', bytes);
  const [source] = await st.readFile({ filename: 'model.sog', inputFormat: 'sog', fileSystem: rfs });
  const out = new st.MemoryFileSystem();
  const pool = st.createChunkDataPool();
  try {
    await st.writeSource({ filename: 'model.ply', outputFormat: 'ply', source, pool, options: {} }, out);
  } finally {
    source.close?.();
  }
  const ply = out.results.get('model.ply');
  if (!ply) throw new Error('SOG decode produced no PLY');
  return parsePlyGaussians(ply);
}

/** Fetch + identify + decode a ?model= target.
 *  Returns { gaussians, reconJson|null, state:{iter}|null }. */
export async function fetchModel(modelUrl, reconUrl) {
  const resp = await fetch(modelUrl);
  if (!resp.ok) throw new Error(`model fetch failed (${resp.status})`);
  return decodeModel(new Uint8Array(await resp.arrayBuffer()), reconUrl);
}

/** Same, from bytes already in hand (a dropped file). */
export async function decodeModel(bytes, reconUrl) {
  let gaussians = null, reconJson = null, state = null;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // PK: either our session zip — or a bare SOG bundle, which is a zip too
    let entries = null;
    try { entries = unzipStore(bytes); } catch { /* compressed: not ours */ }
    if (entries && entries.has('recon.json')) {
      reconJson = JSON.parse(new TextDecoder().decode(entries.get('recon.json')));
    }
    if (entries && entries.has('state.bin')) {
      const st = parseState(entries.get('state.bin'));
      gaussians = st.gaussians;
      state = { iter: st.iter };
    } else if (entries && entries.has('model.sog')) {
      gaussians = await sogToGaussians(entries.get('model.sog'));
    } else if (entries && entries.has('model.ply')) {
      gaussians = parsePlyGaussians(entries.get('model.ply'));
    } else {
      gaussians = await sogToGaussians(bytes);
    }
  } else if (headTextIs(bytes, 'ply')) {
    gaussians = parsePlyGaussians(bytes);
  } else {
    gaussians = await sogToGaussians(bytes);
  }
  if (!gaussians) throw new Error('nothing loadable in the model file');
  if (!reconJson && reconUrl) {
    const r = await fetch(reconUrl);
    if (r.ok) {
      // the upload API takes no bare .json — a shared recon travels as a
      // one-entry STORED zip, so accept both forms here
      const rb = new Uint8Array(await r.arrayBuffer());
      if (rb[0] === 0x50 && rb[1] === 0x4b) {
        const entries = unzipStore(rb);
        const entry = entries.get('recon.json') || [...entries.values()][0];
        if (entry) reconJson = JSON.parse(new TextDecoder().decode(entry));
      } else {
        reconJson = JSON.parse(new TextDecoder().decode(rb));
      }
    }
  }
  return { gaussians, reconJson, state };
}

const headTextIs = (bytes, tag) =>
  new TextDecoder().decode(bytes.subarray(0, tag.length)) === tag;
