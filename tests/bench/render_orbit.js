// render_orbit.js — a splat from VIRTUAL cameras: an orbit around the figure at
// chosen azimuths and elevations (from above too), not the training poses.
//   ?ply=tom_prior6_pkg/tom_prior6.ply&recon=keyhole/recon.json&views=0:0,90:0,180:0,0:60,0:85&dist=2.6&w=720&h=900&out=orbit
// views = az:el in degrees — az 0 faces the figure from the side the first
// camera saw it, el > 0 looks down from above. dist in body heights.
// Up is the cameras' up (the recon's dominant up); the figure's centre and
// height come from the splat itself (median position, vertical extent).
import { createSession } from '/src/index.js';
import { parsePlyGaussians } from '/app/js/session_io.js';
const Q = new URLSearchParams(location.search);
const logEl = document.getElementById('log');
const say = (m) => { logEl.textContent += m + '\n'; console.log('[RENDER]', m); };
const post = (name, body) => fetch(`/scratch/${name}`, { method: 'POST', body });
const OUT = Q.get('out') || 'orbit';
try {
  const recon = await (await fetch(`/scratch/${Q.get('recon')}`)).json();
  // a .sog renders what the client streams (the requantised export), a .ply the trainer's export
  const bytes = new Uint8Array(await (await fetch(`/scratch/${Q.get('ply')}`)).arrayBuffer());
  const g = /\.sog$/i.test(Q.get('ply')) ? await (await import('/app/js/session_io.js')).sogToGaussians(bytes) : parsePlyGaussians(bytes);
  // ?dilate=0.3&mipcomp=0 emulates a classic viewer (PlayCanvas, the client's
  // avatar driver): +0.3 px dilation, no mip compensation — needle-thin splats
  // show there as the streaks the trainer view filters away
  // ?pc=<file.sog>: render through the PlayCanvas engine (app/js/pcview.js) —
  // what the client, the share viewer and SuperSplat draw, tails and all; the
  // ?ply= still supplies the geometry for framing
  let ses;
  if (Q.get('pc')) {
    const { createSogView } = await import('/app/js/pcview.js');
    ses = await createSogView(`/scratch/${Q.get('pc')}`, { radius: recon.sceneRadius });
    say(`PlayCanvas renders ${Q.get('pc')}`);
    ses.view.attach(document.getElementById('cv'));
    for (let i = 0; i < 300 && !ses.entity; i++) await new Promise((r) => setTimeout(r, 100));   // the sog is loaded
    say(ses.entity ? 'sog loaded' : 'WARNING sog not loaded after 30 s');
  } else {
    ses = createSession({ trainer: { ...(Q.get('dilate') ? { dilate: +Q.get('dilate') } : {}), ...(Q.get('mipcomp') === '0' ? { mipComp: false } : {}) } });
    ses.useReconstruction(recon);
    await ses.seedFrom(g, { viewOnly: true, sceneRadius: recon.sceneRadius });
  }
  const settle = Q.get('pc') ? 1500 : 0;   // the engine renders on its own frame loop
  // world up: minus the mean of the cameras' second rows (image y points down)
  const up = [0, 0, 0];
  for (const c of recon.cams) { up[0] -= c.R[3]; up[1] -= c.R[4]; up[2] -= c.R[5]; }
  const nrm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const U = nrm(up);
  // the figure: median position, extent along up
  const n = g.n, xs = [], ys = [], zs = [], hs = [];
  for (let i = 0; i < n; i++) { const b = i * 16; xs.push(g.data[b]); ys.push(g.data[b + 1]); zs.push(g.data[b + 2]); hs.push(g.data[b] * U[0] + g.data[b + 1] * U[1] + g.data[b + 2] * U[2]); }
  const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  const pct = (a, p) => { const s = [...a].sort((p2, q) => p2 - q); return s[Math.floor(p * (s.length - 1))]; };
  const C = [med(xs), med(ys), med(zs)];
  const hLo = pct(hs, 0.01), hHi = pct(hs, 0.99), height = hHi - hLo;
  const mid = (hLo + hHi) / 2 - (C[0] * U[0] + C[1] * U[1] + C[2] * U[2]);
  let centre = [C[0] + U[0] * mid, C[1] + U[1] * mid, C[2] + U[2] * mid];
  // &target=head: the head's centre — the splats in the top 18 % of the height,
  // their median position (dist is still in body heights: use ~0.6, fov ~30)
  if (Q.get('target') === 'head') {
    const top = hHi - 0.18 * height, hx = [], hy = [], hz = [];
    for (let i = 0; i < n; i++) if (hs[i] > top) { hx.push(xs[i]); hy.push(ys[i]); hz.push(zs[i]); }
    const Ch = [med(hx), med(hy), med(hz)];
    const want = hHi - 0.09 * height - (Ch[0] * U[0] + Ch[1] * U[1] + Ch[2] * U[2]);
    centre = [Ch[0] + U[0] * want, Ch[1] + U[1] * want, Ch[2] + U[2] * want];
  }
  // azimuth 0: the direction from the figure to the first camera, flattened
  const c0 = recon.cams[0];
  const eye0 = [-(c0.R[0] * c0.t[0] + c0.R[3] * c0.t[1] + c0.R[6] * c0.t[2]), -(c0.R[1] * c0.t[0] + c0.R[4] * c0.t[1] + c0.R[7] * c0.t[2]), -(c0.R[2] * c0.t[0] + c0.R[5] * c0.t[1] + c0.R[8] * c0.t[2])];
  let a0 = [eye0[0] - centre[0], eye0[1] - centre[1], eye0[2] - centre[2]];
  const du = a0[0] * U[0] + a0[1] * U[1] + a0[2] * U[2];
  a0 = nrm([a0[0] - U[0] * du, a0[1] - U[1] * du, a0[2] - U[2] * du]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const b0 = nrm(cross(U, a0));
  say(`${g.n} splats, height ${height.toFixed(2)} units, centre ${centre.map((v) => v.toFixed(2)).join(',')}, up ${U.map((v) => v.toFixed(2)).join(',')}`);
  const W = +(Q.get('w') || 720), H = +(Q.get('h') || 900);
  const dist = +(Q.get('dist') || 2.6) * height;
  const fov = +(Q.get('fov') || 40);
  const f = (H / 2) / Math.tan((fov * Math.PI / 180) / 2);
  const cv = document.getElementById('cv'); cv.width = W; cv.height = H;
  ses.view.attach(cv);
  const views = (Q.get('views') || '0:0').split(',').map((s) => s.split(':').map(Number));
  let k = 0;
  for (const [az, el] of views) {
    const ca = Math.cos(az * Math.PI / 180), sa = Math.sin(az * Math.PI / 180);
    const ce = Math.cos(el * Math.PI / 180), se = Math.sin(el * Math.PI / 180);
    const dir = [0, 1, 2].map((i) => (a0[i] * ca + b0[i] * sa) * ce + U[i] * se);   // from the centre toward the eye
    const eye = [0, 1, 2].map((i) => centre[i] + dir[i] * dist);
    const fwd = nrm([-dir[0], -dir[1], -dir[2]]);
    const down = [-U[0], -U[1], -U[2]];
    let right = nrm(cross(down, fwd));
    if (Math.abs(el) > 89) right = nrm(cross([-a0[0], -a0[1], -a0[2]], fwd));   // straight down: keep the frame's own right
    const dn = nrm(cross(fwd, right));
    const R = [...right, ...dn, ...fwd];
    const t = [-(R[0] * eye[0] + R[1] * eye[1] + R[2] * eye[2]), -(R[3] * eye[0] + R[4] * eye[1] + R[5] * eye[2]), -(R[6] * eye[0] + R[7] * eye[1] + R[8] * eye[2])];
    ses.view.setCamera({ R, t, f, fy: f, cx: W / 2, cy: H / 2, w: W, h: H });
    ses.view.renderNow();
    await new Promise((r) => requestAnimationFrame(r));
    ses.view.renderNow();
    const name = `${OUT}_${String(k++).padStart(2, '0')}_az${az}_el${el}.png`;
    if (settle) {
      // PlayCanvas: the WebGL buffer is gone by the time toBlob runs — the
      // driver (page_run.mjs) screenshots the canvas when the title asks for it
      await new Promise((r) => setTimeout(r, settle));
      window.__shotDone = false;
      document.title = `shot:${name}`;
      for (let i = 0; i < 200 && !window.__shotDone; i++) await new Promise((r) => setTimeout(r, 100));
      document.title = 'render orbit';
      say(`${name} (driver screenshot)`);
      continue;
    }
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    await post(name, blob);
    say(`${name} ${(blob.size / 1024).toFixed(0)} kB`);
  }
  await post(`${OUT}_done.json`, JSON.stringify({ ok: true, views }));
  say('DONE');
} catch (e) {
  say('ERROR ' + (e.stack || e.message));
  await post(`${OUT}_done.json`, JSON.stringify({ error: e.message }));
}
