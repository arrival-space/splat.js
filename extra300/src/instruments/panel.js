// panel.js — the instrument cluster: the throttle lever, the four flight instruments, the lamps, the
// whiskey compass and the slip ball above the dials. Only the instruments are drawn; the canvas is
// exactly as wide as the cluster and transparent around and between them, so the 3D view stays
// visible everywhere else. The throttle can be dragged with the mouse (plugin/hud.js: throttleSlot).

import * as G from './gauges.js';

/** Horizontal layout in units of the gauge radius r. */
function layout(r) {
  const m = r * 0.25;                 // outer margin
  const gap = r * 2.3;                // between gauge centres
  const lev = { x: m, w: r * 1.05 };
  const asi = lev.x + lev.w + r * 1.25;
  const centres = [asi, asi + gap, asi + 2 * gap, asi + 3 * gap];
  const lamps = { x: centres[3] + r * 1.25, w: r * 1.35 };
  return { m, gap, lev, centres, lamps, width: lamps.x + lamps.w + m };
}

/** Lamp i of the four (STALL, PARK BRK, ENGINE OFF, PAUSED): its box, for a cluster of height h. */
function lampBox(r, h, i) {
  const L = layout(r), cy = h - r * 1.2, lh = r * 0.38, lg = r * 0.12, y0 = cy - (4 * lh + 3 * lg) / 2;
  return { x: L.lamps.x, y: y0 + i * (lh + lg), w: L.lamps.w, h: lh, y0, total: 4 * lh + 3 * lg };
}

/** The throttle's slot: its centre line x, its top (full) and its travel, for a cluster of height h. */
function slot(r, h) {
  const L = layout(r), cy = h - r * 1.2;
  return { x: L.lev.x + L.lev.w / 2, top: cy - r * 0.86, travel: r * 1.5, plate: { x: L.lev.x, y: cy - r * 1.12, w: L.lev.w, h: r * 2.3 } };
}

export class Panel {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, limits) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.limits = limits;
  }

  /** Gauge radius for a cluster of css height h. */
  static radiusFor(h) { return h * 0.34; }   // dials + compass above them fill the height
  /** Css width of the cluster for gauge radius r. */
  static widthFor(r) { return layout(r).width; }
  /** The throttle lever's slot in css px of a cluster h high: { x, top, travel, plate }. */
  static throttleSlot(h) { return slot(Panel.radiusFor(h), h); }
  /** A lamp by its name (the clickable ones are buttons too, plugin/hud.js): its box in css px of a cluster h high. */
  static lampBoxFor(h, key) { const i = ['STALL', 'PARK BRK', 'ENGINE OFF', 'PAUSED'].indexOf(key); return i < 0 ? null : lampBox(Panel.radiusFor(h), h, i); }

  resize(cssWidth, cssHeight, dpr = 1) {
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.dpr = dpr;
  }

  /**
   * @param {object} v  Instruments.values
   * @param {object} s  extras: { throttle, parkingBrake, engineRunning, paused, buttons: the lamps that are clickable }
   */
  draw(v, s = {}) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    const r = Panel.radiusFor(H);
    const L = layout(r);
    const cy = H - r * 1.2;           // dials sit on the bottom edge, the compass above them
    const lim = this.limits;

    const plate = (x, y, w, h) => {
      ctx.fillStyle = 'rgba(14,15,17,0.82)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r * 0.12);
      ctx.fill();
    };

    // the throttle: a slot with idle and full marked, a black T-handle with a white grip, its setting
    const S = slot(r, H), t = Math.max(0, Math.min(1, s.throttle ?? 0));
    plate(S.plate.x, S.plate.y, S.plate.w, S.plate.h);
    ctx.fillStyle = '#050506';
    ctx.beginPath(); ctx.roundRect(S.x - r * 0.05, S.top - r * 0.04, r * 0.1, S.travel + r * 0.08, r * 0.05); ctx.fill();
    ctx.strokeStyle = '#6d6b66'; ctx.lineWidth = Math.max(1, r * 0.015);
    for (let k = 0; k <= 4; k++) {
      const y = S.top + (k / 4) * S.travel, wd = k % 4 === 0 ? r * 0.3 : r * 0.18;
      ctx.beginPath(); ctx.moveTo(S.x - wd, y); ctx.lineTo(S.x - r * 0.1, y); ctx.moveTo(S.x + r * 0.1, y); ctx.lineTo(S.x + wd, y); ctx.stroke();
    }
    const ky = S.top + (1 - t) * S.travel, kw = r * 0.74, kh = r * 0.24;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.roundRect(S.x - kw / 2 + r * 0.02, ky - kh / 2 + r * 0.04, kw, kh, r * 0.07); ctx.fill();
    ctx.fillStyle = '#1b1c1f';
    ctx.beginPath(); ctx.roundRect(S.x - kw / 2, ky - kh / 2, kw, kh, r * 0.07); ctx.fill();
    ctx.fillStyle = '#efece4';
    ctx.beginPath(); ctx.roundRect(S.x - kw / 2 + r * 0.06, ky - kh * 0.18, kw - r * 0.12, kh * 0.36, r * 0.03); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#bdbab2'; ctx.font = `700 ${Math.round(r * 0.13)}px Arial`;
    ctx.fillText('THROTTLE', S.x, S.plate.y + r * 0.13);
    ctx.fillStyle = '#f1efe8'; ctx.font = `700 ${Math.round(r * 0.15)}px Arial`;
    ctx.fillText(`${Math.round(t * 100)} %`, S.x, S.top + S.travel + r * 0.2);

    // the dials draw their own bezels; nothing between them
    const [asi, alt, vsi, gm] = L.centres;
    G.airspeed(ctx, asi, cy, r, v, lim);
    G.altimeter(ctx, alt, cy, r, v);
    G.vsi(ctx, vsi, cy, r, v);
    G.gmeter(ctx, gm, cy, r, v, lim);

    // the four lamps stacked beside the G-meter; the ones that are buttons as well outlined (s.buttons)
    const b0 = lampBox(r, H, 0);
    plate(b0.x - r * 0.08, b0.y0 - r * 0.08, b0.w + r * 0.16, b0.total + r * 0.16);
    const lamp = (i, on, text, col, button = false) => {
      const b = lampBox(r, H, i);
      ctx.fillStyle = on ? col : 'rgba(42,43,46,0.85)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      if (button) { ctx.strokeStyle = on ? 'rgba(0,0,0,0.5)' : 'rgba(227,193,59,0.7)'; ctx.lineWidth = Math.max(1, r * 0.02); ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); }
      ctx.fillStyle = on ? '#111' : button ? '#d9d2b4' : '#7a7b80';
      ctx.font = `700 ${Math.round(r * 0.13)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, b.x + b.w / 2, b.y + b.h / 2);
    };
    const btn = (k) => !!s.buttons?.has(k);
    lamp(0, v.stallWarning, 'STALL', '#e0452f');
    lamp(1, !!s.parkingBrake, 'PARK BRK', '#e3c13b', btn('PARK BRK'));
    lamp(2, !s.engineRunning, 'ENGINE OFF', '#e3c13b', btn('ENGINE OFF'));
    lamp(3, !!s.paused, 'PAUSED', '#7fb0ff', btn('PAUSED'));

    // on the glareshield: the whiskey compass over the altimeter–VSI gap, the ball over ASI–ALT
    G.compass(ctx, (alt + vsi) / 2, cy - r * 1.42, r * 2.1, r * 0.44, v.compass);
    plate((asi + alt) / 2 - r * 0.62, cy - r * 1.66, r * 1.24, r * 0.46);
    G.slipBall(ctx, (asi + alt) / 2, cy - r * 1.6, r * 1.1, v.ball);
    ctx.restore();
  }
}
