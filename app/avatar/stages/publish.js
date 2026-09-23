// publish.js — the last stage, in one of two shapes.
//
// HAND-OFF (ctx.handoff, the embedded route): the finished avatar goes to
// whoever opened this tool — the splat rigger — and that is the end of Splat.js'
// job. The rigger inspects it, attaches the animation clips and puts it on the
// account, which is where all of that already lives (the user, 2026-09-18:
// "splat-js need to hand off the avatar once it's finished ... the ui is just
// for the creation"). Nothing is uploaded here and no account is touched.
//
// THE ACCOUNT (standalone, arrival.space/splat-js and the open-source build):
// rig GLB, splat, sidecar, fit and thumbnail through the arrival.space upload
// flow, then POST /avatars/splat (the backend copies the GLB to
// <user>/splat_avatar_<hash>_<stamp>.glb, writes the sibling config, inserts
// the row and assigns it). Sign-in needs a click (the OAuth popup can only open
// inside one), so this stage draws the button and waits for it.
import { getToken, api, uploadFile, hasToken, forgetRevokedToken } from '../../js/arrival.js';

export const id = 'publish';
export const needs = ['bind'];

const fmtMB = (b) => `${(b / 1e6).toFixed(b > 1e7 ? 0 : 1)} MB`;

/** the zip of everything, on #av-dl — the way out of both endings */
function wireDownload(body, { name, ply, bin, fit, glb, sog, thumb }) {
  const el = body.querySelector('#av-dl');
  if (!el) return;
  el.onclick = async () => {
    const { zipStore } = await import('../../js/zip.js');
    const files = [
      { name: `${name}.ply`, data: new Uint8Array(await ply.arrayBuffer()) },
      { name: `${name}_binding.bin`, data: bin },
      { name: `${name}_fit.json`, data: new TextEncoder().encode(JSON.stringify(fit, null, 1)) },
      { name: 'rig.glb', data: new Uint8Array(glb) },
    ];
    if (sog) files.push({ name: `${name}.sog`, data: new Uint8Array(await sog.arrayBuffer()) });
    if (thumb) files.push({ name: thumb.type === 'image/webp' ? 'thumb.webp' : 'thumb.png', data: new Uint8Array(await thumb.arrayBuffer()) });
    const zip = zipStore(files);
    const a = document.createElement('a'); a.href = URL.createObjectURL(zip); a.download = `${name}_avatar.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
}

export async function run(ctx, manifest, hooks) {
  const body = hooks.body?.(); const log = hooks.log || (() => {});
  const ply = ctx.plyBlob, bin = ctx.bindingBytes, fit = ctx.fitJson, glb = ctx.rigGlb;
  if (!ply || !bin || !fit || !glb) throw new Error('nothing to publish (bind first)');
  const name = (manifest.source?.video || 'avatar').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'avatar';
  let thumb = null;
  try { thumb = ctx.thumb ? await ctx.thumb() : null; } catch { thumb = null; }
  // the splat ships as SOG: the client streams a .sog directly and the driver
  // remaps the binding by splat centres (SOG reorders and requantises), so
  // the 20-80 MB PLY becomes a few MB with no runtime change. The PLY stays
  // in the package for the rigger and for re-fits.
  let sog = ctx.sogBlob || null;
  if (!sog && !ctx.handoff) {   // the rigger takes the PLY and compresses later
    try {
      const { plyToSog } = await import('../../js/sog.js');
      sog = await plyToSog(new Uint8Array(await ply.arrayBuffer()), { onProgress: ({ label, frac }) => hooks.progress?.(frac ?? 0, 1, `compressing the splat${label ? ' · ' + label : ''}`) });
      ctx.sogBlob = sog;
      log(`sog: ${fmtMB(ply.size)} ply -> ${fmtMB(sog.size)} sog`);
    } catch (e) { log(`sog failed (${e.message || e}) — shipping the PLY`); sog = null; }
  }
  // ── the hand-off: post the package to whoever opened this tool ────────────
  if (ctx.handoff) {
    const buf = async (b) => (b instanceof Blob ? await b.arrayBuffer() : b.buffer ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b);
    const assets = [
      { assetType: 'splat', name: `${name}.ply`, buffer: await buf(ply) },
      { assetType: 'binding', name: `${name}_binding.bin`, buffer: await buf(bin) },
      { assetType: 'fit', name: `${name}_fit.json`, buffer: await buf(new TextEncoder().encode(JSON.stringify(fit))) },
    ];
    if (thumb) assets.push({ assetType: 'thumbnail', name: `${name}.png`, buffer: await buf(thumb) });
    hooks.progress?.(0.5, 1, 'handing the avatar over …');
    await ctx.handoff({ name, assets });
    log(`handed over: ${assets.map((a) => a.assetType).join(', ')} (${fmtMB(assets.reduce((t, a) => t + a.buffer.byteLength, 0))})`);
    if (body) {
      body.innerHTML = `<div class="upcard-row"><p class="fine">Your avatar has gone back to the rigger — inspect it, give it its animations and put it on your account there.</p>
        <span style="display:flex;gap:8px"><button class="btn btn-outline" id="av-dl">Download package</button></span></div>
        <p class="fine" id="av-status"></p>`;
      wireDownload(body, { name, ply, bin, fit, glb, sog, thumb });
    }
    return { handedOff: true, format: 'ply', note: 'handed to the rigger' };
  }

  // the button — and the download, for anyone who wants the package instead
  const clicked = await new Promise((resolve) => {
    if (!body) return resolve('go');
    body.innerHTML = `<div class="upcard-row"><p class="fine">Splat ${sog ? `${fmtMB(sog.size)} (SOG, from ${fmtMB(ply.size)})` : fmtMB(ply.size)} · binding ${fmtMB(bin.byteLength)} · rig ${fmtMB(glb.byteLength)}. ${hasToken() ? '' : 'You will be asked to sign in to arrival.space.'}</p>
      <span style="display:flex;gap:8px"><button class="btn btn-outline" id="av-dl">Download package</button><button class="btn btn-accent" id="av-go">Use as my avatar</button></span></div>
      <p class="fine" id="av-status"></p>`;
    wireDownload(body, { name, ply, bin, fit, glb, sog, thumb });
    body.querySelector('#av-go').onclick = () => {
      // a popup for the first sign-in must be opened inside the click
      const popup = hasToken() ? null : window.open('', 'arrival-signin', 'width=520,height=640');
      resolve({ popup });
    };
  });
  const status = (m) => { const el = body?.querySelector('#av-status'); if (el) el.textContent = m; hooks.progress?.(0, 1, m); log(m); };
  const popup = clicked && clicked.popup;
  let token;
  try {
    token = await getToken(status, popup);
  } catch (e) { forgetRevokedToken(e); throw e; }
  const up = async (blob, fname, label) => (await uploadFile(blob, fname, { token, onStatus: status, onProgress: (p) => hooks.progress?.(p, 1, `${label} …`) })).resourceKey;
  const keys = {};
  keys.glb = await up(new Blob([glb], { type: 'model/gltf-binary' }), 'rig.glb', 'rig');
  keys.splat = sog ? await up(sog, `${name}.sog`, 'splat') : await up(ply, `${name}.ply`, 'splat');
  keys.binding = await up(new Blob([bin], { type: 'application/octet-stream' }), `${name}_binding.bin`, 'binding');
  keys.fit = await up(new Blob([JSON.stringify(fit)], { type: 'application/json' }), `${name}_fit.json`, 'fit');
  if (thumb) keys.thumbnail = await up(thumb, thumb.type === 'image/webp' ? 'thumb.webp' : 'thumb.png', 'thumbnail');
  status('Registering the avatar …');
  const res = await api('/avatars/splat', token, { ...keys, originalName: `${name} (Splat.js)`, assign: true });
  const d = res.data || {};
  status(`Done — avatar ${d.id} is on your account.`);
  if (body) body.innerHTML = `<p class="fine">Your avatar is on your account (id ${d.id}). Open <a href="https://arrival.space" target="_blank" rel="noopener">arrival.space</a> and you are wearing it.</p>`;
  return { avatarId: d.id, url: d.url, assigned: !!d.assigned, format: sog ? 'sog' : 'ply', note: `avatar ${d.id}` };
}
