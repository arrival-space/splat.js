// cockpitDisplay.js — the Advanced Eagle's large area display, live: a canvas drawn a few times a
// second and shown on the touchscreen across the panel (scripts/blender/f15c.py leaves its place: LAD).
//
// Three windows under a row of option-button legends, after the F-15EX's:
//   left    the attitude director: sky and ground ball rolling with the bank, pitch ladder, heading,
//           speed and altitude boxes
//   middle  a situation map, north up: Meigs' runway, the shore, the carrier with its angled deck,
//           the jet's own symbol and track
//   right   the jet's state: gear, flaps, hook, speed brake, two engines' N2 / FTIT, fuel, g
// and the moving-map scale, the time and the master-arm style legends along the bottom.

import { fromBody, MeshBuilder } from '../render/geometry.js';
import { toMesh } from './pcMesh.js';

// as scripts/blender/f15c.py LAD: centre (body), width, height, the panel's lean (deg)
const LAD = { c: [6.553, 0, -0.856], w: 0.50, h: 0.27, tilt: 25 };
const W = 1024, H = 552;

export class CockpitDisplay {
  /**
   * @param {object} app
   * @param {object} parent  the airplane's root entity (body axes, render units)
   * @param {object} world   buildMeigs(): the runway; world.carrier if there is one
   */
  constructor(app, parent, world) {
    this.world = world;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new pc.Texture(app.graphicsDevice, { width: W, height: H, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE });
    this.tex.setSource(this.canvas);
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(0, 0, 0);
    m.emissive = new pc.Color(1, 1, 1);
    m.emissiveMap = this.tex;
    m.useLighting = false;
    m.useFog = false;
    m.update();
    this.mat = m;
    // the screen: a quad on the panel's face, leaning back with it
    const t = (LAD.tilt * Math.PI) / 180;
    const n = [-Math.cos(t), 0, -Math.sin(t)], u = [Math.sin(t), 0, -Math.cos(t)];
    const c = LAD.c.map((v, k) => v + n[k] * 0.002);
    const at = (dy, du) => fromBody([c[0] + u[0] * du, c[1] + dy, c[2] + u[2] * du]);
    const mb = new MeshBuilder({ uv: true });
    const nr = fromBody(n);
    // (the canvas's first row is its top: v runs down the screen)
    const a = mb.vertex(at(-LAD.w / 2, -LAD.h / 2), nr, [0, 1]);
    mb.vertex(at(LAD.w / 2, -LAD.h / 2), nr, [1, 1]);
    mb.vertex(at(LAD.w / 2, LAD.h / 2), nr, [1, 0]);
    mb.vertex(at(-LAD.w / 2, LAD.h / 2), nr, [0, 0]);
    mb.indices.push(a, a + 2, a + 1, a, a + 3, a + 2, a, a + 1, a + 2, a, a + 2, a + 3);
    this.entity = new pc.Entity('largeAreaDisplay');
    this.entity.addComponent('render', { meshInstances: [new pc.MeshInstance(toMesh(app.graphicsDevice, mb), m)], castShadows: false, receiveShadows: false });
    parent.addChild(this.entity);
    this.track = [];
    this._acc = 1;
  }

  /** Draw (a few times a second, and only when someone is looking). */
  update(ac, v, dt, visible) {
    this._acc += dt;
    if (ac && Math.round(ac.time * 2) !== this._trackT) {
      this._trackT = Math.round(ac.time * 2);
      this.track.push([ac.state.pos[0], ac.state.pos[1]]);
      if (this.track.length > 240) this.track.shift();
    }
    if (!visible || this._acc < 1 / 12) return;
    this._acc = 0;
    this.draw(ac, v);
    this.tex.upload();
  }

  draw(ac, v) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#030608';
    g.fillRect(0, 0, W, H);
    g.font = '600 15px "Helvetica Neue", Arial, sans-serif';
    g.textBaseline = 'middle';
    // the option-button legends along the top, as the real one has them
    const legends = ['CAUTION', 'A/P OFF', 'R1 OFF', 'R2 OFF', 'IFF', 'PP-EG11', 'LAM OFF', 'TCN OFF', 'ILS OFF', 'HUD', 'GCWS ON', 'NF-OFF', 'POS UPD', 'KEY PAD'];
    const cw = W / legends.length;
    legends.forEach((l, i) => {
      g.strokeStyle = '#4a6b55'; g.lineWidth = 1.5;
      g.strokeRect(i * cw + 2, 2, cw - 4, 36);
      g.fillStyle = l === 'CAUTION' ? '#ffd23f' : l === 'GCWS ON' ? '#6dff9e' : '#cfe8d8';
      g.textAlign = 'center';
      g.fillText(l, i * cw + cw / 2, 20);
    });
    const top = 46, bot = H - 30, ww = W / 3;
    this.adi(g, 6, top, ww - 12, bot - top, ac, v);
    this.map(g, ww + 6, top, ww - 12, bot - top, ac);
    this.systems(g, 2 * ww + 6, top, ww - 12, bot - top, ac, v);
    // the bottom legends
    g.fillStyle = '#9fc2ad'; g.textAlign = 'center';
    ['PROG', 'BIT', 'EVENT', 'ENG', 'HSI', 'TSD', 'S/T-P', 'FCS', 'FUEL', 'ARMT'].forEach((l, i, a) => g.fillText(l, (i + 0.5) * (W / a.length), H - 14));
  }

  adi(g, x, y, w, h, ac, v) {
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = '#000'; g.fillRect(x, y, w, h);
    const cx = x + w / 2, cy = y + h * 0.52, r = Math.min(w, h) * 0.36;
    const pitch = v.pitch || 0, bank = v.bank || 0, ppd = r / 30;
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
    g.translate(cx, cy);
    g.rotate((-bank * Math.PI) / 180);
    const hy = pitch * ppd;
    g.fillStyle = '#2f6fd6'; g.fillRect(-2 * r, -3 * r + hy, 4 * r, 3 * r);
    g.fillStyle = '#c9b246'; g.fillRect(-2 * r, hy, 4 * r, 3 * r);
    g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-2 * r, hy); g.lineTo(2 * r, hy); g.stroke();
    g.font = '600 12px Arial'; g.fillStyle = '#fff'; g.textAlign = 'left';
    for (let a = -60; a <= 60; a += 10) {
      if (!a) continue;
      const yy = hy - a * ppd, half = a % 20 ? r * 0.18 : r * 0.32;
      g.beginPath(); g.moveTo(-half, yy); g.lineTo(half, yy); g.stroke();
      if (!(a % 20)) g.fillText(String(Math.abs(a)), half + 4, yy);
    }
    g.restore();
    // the airplane symbol and the bank scale
    g.strokeStyle = '#ffd23f'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx - r * 0.55, cy); g.lineTo(cx - r * 0.18, cy); g.lineTo(cx - r * 0.1, cy + 10);
    g.moveTo(cx + r * 0.55, cy); g.lineTo(cx + r * 0.18, cy); g.lineTo(cx + r * 0.1, cy + 10); g.stroke();
    g.strokeStyle = '#e8f0ea'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    // heading along the top, speed and altitude either side
    g.font = '700 18px Arial'; g.fillStyle = '#e8f0ea'; g.textAlign = 'center';
    const hdg = ((v.heading || 0) % 360 + 360) % 360;
    for (let d = -30; d <= 30; d += 10) {
      const hd = Math.round((hdg + d) / 10) * 10, dx = (hd - hdg) * (w / 90);
      g.fillText(String(((hd % 360) + 360) % 360 / 10 | 0).padStart(2, '0'), cx + dx, y + 18);
    }
    g.strokeRect(cx - 24, y + 30, 48, 22);
    g.fillText(String(Math.round(hdg)).padStart(3, '0'), cx, y + 41);
    const boxv = (bx, text, label) => {
      g.strokeRect(bx - 34, cy - 14, 68, 28);
      g.fillText(text, bx, cy);
      g.font = '600 12px Arial'; g.fillText(label, bx, cy - 26); g.font = '700 18px Arial';
    };
    boxv(x + 40, String(Math.round(v.ias || 0)), 'KCAS');
    boxv(x + w - 40, String(Math.round((v.altitude || 0) / 10) * 10), 'ALT');
    g.font = '600 14px Arial';
    g.fillText(`M ${(v.mach || 0).toFixed(2)}`, x + 40, cy + 34);
    g.fillText(`${(v.vsi || 0) >= 0 ? '+' : ''}${Math.round((v.vsi || 0) / 10) * 10}`, x + w - 40, cy + 34);
    g.restore();
    g.strokeStyle = '#3c5c48'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
  }

  map(g, x, y, w, h, ac) {
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = '#071019'; g.fillRect(x, y, w, h);
    const cx = x + w / 2, cy = y + h / 2;
    const p = ac ? ac.state.pos : [0, 0, 0];
    const range = 8000;                         // m across the window
    const s = w / range;
    const P = (n, e) => [cx + (e - p[1]) * s, cy - (n - p[0]) * s];
    // a range ring every 2 km
    g.strokeStyle = 'rgba(120,170,140,0.35)'; g.lineWidth = 1;
    for (const rr of [2000, 4000]) { g.beginPath(); g.arc(cx, cy, rr * s, 0, Math.PI * 2); g.stroke(); }
    // the shore and the island
    const wld = this.world;
    g.strokeStyle = '#7b6a4a'; g.lineWidth = 2;
    g.beginPath(); wld.shore.forEach(([n, e], i) => { const [px, py] = P(n, e); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
    g.fillStyle = '#3d4a33';
    g.beginPath(); wld.island.forEach(([n, e], i) => { const [px, py] = P(n, e); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); g.fill();
    // the runway
    const rw = wld.runway;
    const [ax, ay] = P(rw.thr36[0], rw.thr36[1]), [bx, by] = P(rw.thr18[0], rw.thr18[1]);
    g.strokeStyle = '#e8f0ea'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    g.fillStyle = '#e8f0ea'; g.font = '600 13px Arial'; g.textAlign = 'left';
    g.fillText('KCGX', bx + 6, by);
    // the carrier: its deck outline and the angled deck's line
    const cv = wld.carrier;
    if (cv) {
      g.strokeStyle = '#7fd0ff'; g.lineWidth = 2;
      g.beginPath();
      cv.data.deck.forEach(([ss, tt], i) => { const [n, e] = cv.toNE(ss, tt); const [px, py] = P(n, e); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.closePath(); g.stroke();
      const [n0, e0] = cv.onLanding(-1500), [n1, e1] = cv.onLanding(cv.data.landing.length);
      const [lx0, ly0] = P(n0, e0), [lx1, ly1] = P(n1, e1);
      g.setLineDash([6, 6]); g.beginPath(); g.moveTo(lx0, ly0); g.lineTo(lx1, ly1); g.stroke(); g.setLineDash([]);
      const [tx, ty] = P(...cv.toNE(160, 60));
      g.fillStyle = '#7fd0ff'; g.fillText('CVN-68', tx, ty);
    }
    // the track behind, and ownship
    g.strokeStyle = 'rgba(109,255,158,0.6)'; g.lineWidth = 2;
    g.beginPath(); this.track.forEach(([n, e], i) => { const [px, py] = P(n, e); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
    if (ac) {
      g.save();
      g.translate(cx, cy);
      g.rotate(ac.euler.psi);
      g.fillStyle = '#6dff9e';
      g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 9); g.lineTo(0, 4); g.lineTo(-8, 9); g.closePath(); g.fill();
      g.restore();
    }
    g.fillStyle = '#9fc2ad'; g.textAlign = 'left'; g.font = '600 13px Arial';
    g.fillText('TSD  8 km  N↑', x + 8, y + 14);
    g.restore();
    g.strokeStyle = '#3c5c48'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
  }

  systems(g, x, y, w, h, ac, v) {
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.fillStyle = '#000'; g.fillRect(x, y, w, h);
    g.font = '700 15px Arial'; g.textAlign = 'left';
    const line = (txt, yy, col = '#cfe8d8', xx = x + 12) => { g.fillStyle = col; g.fillText(txt, xx, yy); };
    const gp = ac ? ac.gearPos : 1;
    line('GEAR', y + 22);
    for (let i = 0; i < 3; i++) {
      g.fillStyle = gp > 0.99 ? '#6dff9e' : gp < 0.01 ? '#333' : '#ffb238';
      g.fillRect(x + 80 + i * 34, y + 12, 24, 20);
    }
    const flaps = ac?.controls.flaps || 0, sb = ac?.speedbrakePos || 0, hook = ac?.hookPos || 0;
    line(`FLAPS  ${flaps > 0.9 ? 'DN' : flaps > 0.05 ? 'TRANS' : 'UP'}`, y + 54, flaps > 0.05 ? '#6dff9e' : '#cfe8d8');
    line(`SPD BRK  ${sb > 0.05 ? 'OUT' : 'IN'}`, y + 78, sb > 0.05 ? '#ffb238' : '#cfe8d8');
    line(`HOOK  ${hook > 0.9 ? 'DOWN' : hook > 0.05 ? 'TRANS' : 'UP'}`, y + 102, hook > 0.05 ? '#ffb238' : '#cfe8d8');
    // the two engines: N2 and FTIT bars
    const bar = (bx, by, frac, col, label, val) => {
      g.strokeStyle = '#4a6b55'; g.strokeRect(bx, by, 26, 120);
      g.fillStyle = col; g.fillRect(bx + 2, by + 118 - 116 * frac, 22, 116 * frac);
      g.fillStyle = '#cfe8d8'; g.font = '600 12px Arial'; g.textAlign = 'center';
      g.fillText(label, bx + 13, by + 134); g.fillText(val, bx + 13, by - 10);
    };
    const n2 = (v.n2 || 0) / 100, ft = Math.min(1, (v.ftit || 0) / 1000);
    const ey = y + 150;
    bar(x + 20, ey, n2, '#6dff9e', 'N2 L', `${Math.round(v.n2 || 0)}`);
    bar(x + 56, ey, n2, '#6dff9e', 'N2 R', `${Math.round(v.n2 || 0)}`);
    bar(x + 110, ey, ft, ft > 0.92 ? '#ff4a3a' : '#ffb238', 'FTIT L', `${Math.round(v.ftit || 0)}`);
    bar(x + 146, ey, ft, ft > 0.92 ? '#ff4a3a' : '#ffb238', 'FTIT R', `${Math.round(v.ftit || 0)}`);
    if ((v.ab || 0) > 0.05) { g.fillStyle = '#ff9a3c'; g.font = '700 16px Arial'; g.textAlign = 'left'; g.fillText('A/B', x + 200, ey + 20); }
    g.textAlign = 'left'; g.font = '700 15px Arial';
    line(`FUEL  ${Math.round((v.fuelLb || 0) / 10) * 10} LB`, ey + 172);
    line(`FF  ${Math.round((v.fuelFlow || 0) / 100) * 100} PPH`, ey + 196);
    line(`G  ${(v.g || 0).toFixed(1)}   MAX ${(v.gMax || 1).toFixed(1)}`, ey + 220, (v.g || 0) > 7.5 ? '#ffb238' : '#cfe8d8');
    line(`AOA  ${(v.aoa || 0).toFixed(1)}`, ey + 244, v.stallWarning ? '#ffb238' : '#cfe8d8');
    g.restore();
    g.strokeStyle = '#3c5c48'; g.lineWidth = 2; g.strokeRect(x, y, w, h);
  }

  destroy() {
    this.entity.destroy();
    this.tex.destroy();
    this.mat.destroy?.();
  }
}
