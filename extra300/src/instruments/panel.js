// panel.js — the instrument cluster: flight instruments left, engine right,
// the whiskey compass above them, the way the Extra's own panel reads. Only
// the instruments are drawn; the canvas is exactly as wide as the cluster
// and transparent around and between the dials, so the 3D view stays visible
// everywhere else.

import * as G from './gauges.js';

/** Horizontal layout in units of the gauge radius r. */
function layout(r) {
  const m = r * 0.25;                 // outer margin
  const gap = r * 2.3;                // between gauge centres
  const lev = { x: m, w: r * 1.5 };
  const asi = lev.x + lev.w + r * 1.15;
  const centres = [asi, asi + gap, asi + 2 * gap, asi + 3 * gap];
  const tach = centres[3] + gap + r * 0.3;
  const mp = tach + gap;
  const stack = { x: mp + r * 1.2, w: r * 2.3 };
  return { m, gap, lev, centres, tach, mp, stack, width: stack.x + stack.w + m };
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

  resize(cssWidth, cssHeight, dpr = 1) {
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.dpr = dpr;
  }

  /**
   * @param {object} v  Instruments.values
   * @param {object} s  extras: { throttle, prop, trim, parkingBrake, engineRunning, paused }
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

    // levers on their own small plate
    plate(L.lev.x - r * 0.1, cy - r * 1.12, L.lev.w + r * 0.2, r * 2.3);
    const lever = (i, name, t, col) => {
      const lx = L.lev.x + r * 0.25 + i * r * 0.5, y0 = cy - r * 0.95, h = r * 1.65;
      ctx.fillStyle = '#050506'; ctx.fillRect(lx - 3, y0, 6, h);
      ctx.fillStyle = col; ctx.fillRect(lx - r * 0.16, y0 + (1 - t) * h - 6, r * 0.32, 12);
      ctx.fillStyle = '#bdbab2'; ctx.font = `600 ${Math.round(r * 0.15)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(name, lx, y0 + h + r * 0.17);
    };
    lever(0, 'THR', s.throttle ?? 0, '#d8d4c8');
    lever(1, 'PROP', s.prop ?? 1, '#2d5bd1');
    lever(2, 'TRIM', 0.5 + 0.5 * (s.trim ?? 0), '#888');

    // the dials draw their own bezels; nothing between them
    const [asi, alt, vsi, gm] = L.centres;
    G.airspeed(ctx, asi, cy, r, v, lim);
    G.altimeter(ctx, alt, cy, r, v);
    G.vsi(ctx, vsi, cy, r, v);
    G.gmeter(ctx, gm, cy, r, v, lim);
    G.tach(ctx, L.tach, cy, r, v, lim);
    G.manifold(ctx, L.mp, cy, r, v);

    // engine monitor and lamps
    plate(L.stack.x - r * 0.08, cy - r * 1.08, L.stack.w + r * 0.16, r * 2.16);
    G.engineStack(ctx, L.stack.x, cy - r, L.stack.w, r * 2, v);
    // the four lamps in a row on the glareshield, above the engine monitor
    const lw = (L.stack.w + r * 0.16 - r * 0.15) / 2, lh = r * 0.3;
    const lamp = (i, on, text, col) => {
      const x = L.stack.x - r * 0.08 + (i % 2) * (lw + r * 0.15);
      const y = cy - r * 1.82 + Math.floor(i / 2) * (lh + r * 0.06);
      ctx.fillStyle = on ? col : 'rgba(42,43,46,0.85)';
      ctx.fillRect(x, y, lw, lh);
      ctx.fillStyle = on ? '#111' : '#7a7b80';
      ctx.font = `700 ${Math.round(r * 0.13)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(text, x + lw / 2, y + lh / 2);
    };
    lamp(0, v.stallWarning, 'STALL', '#e0452f');
    lamp(1, !!s.parkingBrake, 'PARK BRK', '#e3c13b');
    lamp(2, !s.engineRunning, 'ENGINE OFF', '#e3c13b');
    lamp(3, !!s.paused, 'PAUSED', '#7fb0ff');

    // on the glareshield: the whiskey compass over the altimeter–VSI gap, the ball over ASI–ALT
    G.compass(ctx, (alt + vsi) / 2, cy - r * 1.42, r * 2.1, r * 0.44, v.compass);
    plate((asi + alt) / 2 - r * 0.62, cy - r * 1.66, r * 1.24, r * 0.46);
    G.slipBall(ctx, (asi + alt) / 2, cy - r * 1.6, r * 1.1, v.ball);
    ctx.restore();
  }
}
