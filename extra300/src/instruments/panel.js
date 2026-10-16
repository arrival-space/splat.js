// panel.js — the instrument panel: lays the gauges out on one canvas, the
// way the early Flight Simulators put the panel along the bottom of the
// screen, and the way the Extra's own panel reads: flight instruments left,
// engine right, the whiskey compass on the glareshield.

import * as G from './gauges.js';

export class Panel {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, limits) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.limits = limits;
  }

  resize(cssWidth, cssHeight, dpr = 1) {
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.dpr = dpr;
  }

  /**
   * @param {object} v  Instruments.values
   * @param {object} s  extras: { throttle, prop, trim, parkingBrake, engineRunning, paused, message }
   */
  draw(v, s = {}) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    // panel body: matte black with a glareshield lip
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#26272b');
    grad.addColorStop(0.08, '#1b1c1f');
    grad.addColorStop(1, '#121315');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H * 0.06, W, H * 0.94);
    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, W, H * 0.07);

    // left to right: levers | ASI ALT VSI G | TACH MP | engine stack | lamps
    const r = Math.min(H * 0.36, W / 22.5);
    const gap = r * 2.3;
    const cy = H * 0.53;
    const contentW = r * 1.5 + gap * 4 + r * 0.3 + gap * 2 + r * 2.3 + r * 0.25 + r * 1.2;
    let x = Math.max(r * 0.4, (W - contentW) / 2);
    const lim = this.limits;

    // levers & lamps
    const leverX = x;
    const lever = (i, name, t, col) => {
      const lx = leverX + r * 0.2 + i * r * 0.5, y0 = cy - r, h = r * 1.8;
      ctx.fillStyle = '#0b0c0e'; ctx.fillRect(lx - 3, y0, 6, h);
      ctx.fillStyle = col; ctx.fillRect(lx - r * 0.16, y0 + (1 - t) * h - 6, r * 0.32, 12);
      ctx.fillStyle = '#bdbab2'; ctx.font = `600 ${Math.round(r * 0.15)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(name, lx, y0 + h + r * 0.18);
    };
    lever(0, 'THR', s.throttle ?? 0, '#d8d4c8');
    lever(1, 'PROP', s.prop ?? 1, '#2d5bd1');
    lever(2, 'TRIM', 0.5 + 0.5 * (s.trim ?? 0), '#888');
    x += r * 1.5 + r;

    const asiX = x;
    G.airspeed(ctx, x, cy, r, v, lim); x += gap;
    const altX = x;
    G.altimeter(ctx, x, cy, r, v); x += gap;
    G.vsi(ctx, x, cy, r, v); x += gap;
    G.gmeter(ctx, x, cy, r, v, lim); x += gap + r * 0.3;
    G.tach(ctx, x, cy, r, v, lim); x += gap;
    G.manifold(ctx, x, cy, r, v); x += r * 1.25;
    G.engineStack(ctx, x, cy - r, r * 2.3, r * 2, v);
    x += r * 2.3 + r * 0.25;

    const lamp = (i, on, text, col) => {
      const y = cy - r + i * r * 0.5;
      ctx.fillStyle = on ? col : '#2a2b2e';
      ctx.fillRect(x, y, r * 1.2, r * 0.38);
      ctx.fillStyle = on ? '#111' : '#55565b';
      ctx.font = `700 ${Math.round(r * 0.15)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x + r * 0.6, y + r * 0.19);
    };
    lamp(0, v.stallWarning, 'STALL', '#e0452f');
    lamp(1, !!s.parkingBrake, 'PARK BRK', '#e3c13b');
    lamp(2, !s.engineRunning, 'ENGINE OFF', '#e3c13b');
    lamp(3, !!s.paused, 'PAUSED', '#7fb0ff');

    // glareshield compass above the altimeter/VSI gap, the ball under ASI–ALT
    G.compass(ctx, altX + gap * 0.5, H * 0.035 + r * 0.24, r * 2.1, r * 0.44, v.compass);
    G.slipBall(ctx, (asiX + altX) / 2, cy + r * 1.2, r * 1.1, v.ball);
    ctx.restore();
  }
}
