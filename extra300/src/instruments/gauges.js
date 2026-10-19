// gauges.js — instrument faces drawn on a 2D canvas.
//
// Each function draws one instrument centred at (x, y) with radius r from
// the values Instruments.update() produced. No state: the needles' dynamics
// live in the instrument models, so a gauge is exactly as laggy as the real
// one and the drawing code stays dumb.

const TAU = Math.PI * 2;
const FACE = '#111214';
const INK = '#f1efe8';
const GREEN = '#2fa84f';
const YELLOW = '#e3c13b';
const RED = '#d6322b';
const WHITE_ARC = '#e9e9e9';

function bezel(ctx, x, y, r) {
  ctx.save();
  const g = ctx.createRadialGradient(x, y - r * 0.2, r * 0.6, x, y, r * 1.12);
  g.addColorStop(0, '#3b3d42');
  g.addColorStop(1, '#16171a');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r * 1.1, 0, TAU); ctx.fill();
  ctx.fillStyle = FACE;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.restore();
}

function glass(ctx, x, y, r) {
  ctx.save();
  const g = ctx.createLinearGradient(x - r, y - r, x + r * 0.2, y + r * 0.4);
  g.addColorStop(0, 'rgba(255,255,255,0.10)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.restore();
}

function label(ctx, text, x, y, size, color = INK, weight = '600') {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

/** Angle of a value on a dial from (v0, a0) to (v1, a1), angles in radians, 0 = 12 o'clock, clockwise. */
const dialAngle = (v, v0, v1, a0, a1) => a0 + ((Math.min(Math.max(v, v0), v1) - v0) / (v1 - v0)) * (a1 - a0);
const polar = (x, y, r, a) => [x + r * Math.sin(a), y - r * Math.cos(a)];

function arc(ctx, x, y, r, a0, a1, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, a0 - Math.PI / 2, a1 - Math.PI / 2);
  ctx.stroke();
}

function ticks(ctx, x, y, r, list, len, width, color = INK) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const a of list) {
    const [x0, y0] = polar(x, y, r, a);
    const [x1, y1] = polar(x, y, r - len, a);
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
  }
  ctx.stroke();
}

function needle(ctx, x, y, r, a, { width = 0.06, color = INK, tail = 0.18 } = {}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-r * width * 0.5, r * tail);
  ctx.lineTo(r * width * 0.5, r * tail);
  ctx.lineTo(r * width * 0.25, -r * 0.92);
  ctx.lineTo(0, -r);
  ctx.lineTo(-r * width * 0.25, -r * 0.92);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2a2b2f';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.08, 0, TAU); ctx.fill();
  ctx.restore();
}

/** Airspeed, knots. Extra 300L: green 55-158, yellow 158-219, red line 219. */
export function airspeed(ctx, x, y, r, v, lim) {
  bezel(ctx, x, y, r);
  const A0 = 0.12 * TAU / 2, A1 = TAU * 0.94;
  const f = (kt) => dialAngle(kt, 40, 260, A0, A1);
  arc(ctx, x, y, r * 0.88, f(lim.vs1), f(lim.vno), GREEN, r * 0.07);
  arc(ctx, x, y, r * 0.88, f(lim.vno), f(lim.vne), YELLOW, r * 0.07);
  ticks(ctx, x, y, r * 0.93, [f(lim.vne)], r * 0.2, r * 0.04, RED);
  const major = [], minor = [];
  for (let kt = 40; kt <= 260; kt += 10) (kt % 20 === 0 ? major : minor).push(f(kt));
  ticks(ctx, x, y, r * 0.95, major, r * 0.14, r * 0.025);
  ticks(ctx, x, y, r * 0.95, minor, r * 0.08, r * 0.015);
  for (let kt = 40; kt <= 260; kt += 40) { const [lx, ly] = polar(x, y, r * 0.66, f(kt)); label(ctx, String(kt), lx, ly, r * 0.15); }
  label(ctx, 'AIRSPEED', x, y + r * 0.28, r * 0.09, '#bdbab2');
  label(ctx, 'KNOTS', x, y + r * 0.40, r * 0.08, '#bdbab2');
  needle(ctx, x, y, r * 0.86, f(Math.max(40, v.ias)));
  glass(ctx, x, y, r);
}

/** Three-pointer altimeter with Kollsman window (inHg). */
export function altimeter(ctx, x, y, r, v) {
  bezel(ctx, x, y, r);
  const major = [], minor = [];
  for (let i = 0; i < 50; i++) (i % 5 === 0 ? major : minor).push((i / 50) * TAU);
  ticks(ctx, x, y, r * 0.95, major, r * 0.14, r * 0.025);
  ticks(ctx, x, y, r * 0.95, minor, r * 0.07, r * 0.015);
  for (let i = 0; i < 10; i++) { const [lx, ly] = polar(x, y, r * 0.68, (i / 10) * TAU); label(ctx, String(i), lx, ly, r * 0.2); }
  // Kollsman window
  ctx.fillStyle = '#000';
  ctx.fillRect(x + r * 0.28, y - r * 0.1, r * 0.46, r * 0.2);
  label(ctx, v.kollsmanInHg.toFixed(2), x + r * 0.51, y, r * 0.12);
  label(ctx, 'ALT', x, y - r * 0.32, r * 0.1, '#bdbab2');
  const h = v.altitude;
  // striped low-altitude flag below 10,000 ft
  if (h < 10000) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x - r * 0.18, y + r * 0.22, r * 0.36, r * 0.12); ctx.clip();
    for (let k = -6; k < 6; k++) {
      ctx.fillStyle = k % 2 ? '#fff' : '#000';
      ctx.beginPath();
      ctx.moveTo(x + k * r * 0.06, y + r * 0.22); ctx.lineTo(x + (k + 1) * r * 0.06, y + r * 0.22);
      ctx.lineTo(x + (k + 3) * r * 0.06, y + r * 0.34); ctx.lineTo(x + (k + 2) * r * 0.06, y + r * 0.34); ctx.fill();
    }
    ctx.restore();
  }
  const a100 = ((h % 1000) / 1000) * TAU;
  const a1k = ((h % 10000) / 10000) * TAU;
  const a10k = ((h % 100000) / 100000) * TAU;
  needle(ctx, x, y, r * 0.95, a10k, { width: 0.03, tail: 0 });
  needle(ctx, x, y, r * 0.55, a1k, { width: 0.16 });
  needle(ctx, x, y, r * 0.88, a100, { width: 0.07 });
  glass(ctx, x, y, r);
}

/** Vertical speed, ft/min ×1000, ±6. */
export function vsi(ctx, x, y, r, v) {
  bezel(ctx, x, y, r);
  // 0 at 9 o'clock, up clockwise to +6000 at ~3:30, down counter-clockwise
  const f = (fpm) => -Math.PI / 2 + (Math.max(-6000, Math.min(6000, fpm)) / 6000) * Math.PI * 0.9;
  const major = [], minor = [];
  for (let k = -6000; k <= 6000; k += 500) (k % 1000 === 0 ? major : minor).push(f(k));
  ticks(ctx, x, y, r * 0.95, major, r * 0.14, r * 0.025);
  ticks(ctx, x, y, r * 0.95, minor, r * 0.07, r * 0.015);
  for (const k of [0, 1, 2, 4, 6]) {
    for (const s of k === 0 ? [1] : [1, -1]) { const [lx, ly] = polar(x, y, r * 0.68, f(s * k * 1000)); label(ctx, String(k), lx, ly, r * 0.16); }
  }
  label(ctx, 'UP', x - r * 0.35, y - r * 0.32, r * 0.09, '#bdbab2');
  label(ctx, 'DOWN', x - r * 0.35, y + r * 0.32, r * 0.09, '#bdbab2');
  label(ctx, 'VERTICAL SPEED', x + r * 0.1, y + r * 0.02, r * 0.07, '#bdbab2');
  label(ctx, '1000 FT PER MIN', x + r * 0.1, y + r * 0.13, r * 0.06, '#bdbab2');
  needle(ctx, x, y, r * 0.9, f(v.vsi));
  glass(ctx, x, y, r);
}

/** Accelerometer with max/min tell-tales, -10 … +10 g. */
export function gmeter(ctx, x, y, r, v, lim) {
  bezel(ctx, x, y, r);
  const f = (g) => -Math.PI / 2 + ((Math.max(-10, Math.min(10, g)) + 10) / 20) * Math.PI * 1.8 - Math.PI * 0.4;
  arc(ctx, x, y, r * 0.88, f(lim.gNeg), f(-6), YELLOW, r * 0.06);
  arc(ctx, x, y, r * 0.88, f(-6), f(8), GREEN, r * 0.06);
  arc(ctx, x, y, r * 0.88, f(8), f(lim.gPos), YELLOW, r * 0.06);
  ticks(ctx, x, y, r * 0.95, [f(lim.gPos), f(lim.gNeg)], r * 0.2, r * 0.04, RED);
  const major = [], minor = [];
  for (let g = -10; g <= 10; g++) (g % 2 === 0 ? major : minor).push(f(g));
  ticks(ctx, x, y, r * 0.95, major, r * 0.13, r * 0.025);
  ticks(ctx, x, y, r * 0.95, minor, r * 0.07, r * 0.015);
  for (let g = -10; g <= 10; g += 2) { const [lx, ly] = polar(x, y, r * 0.68, f(g)); label(ctx, String(Math.abs(g)), lx, ly, r * 0.14); }
  label(ctx, 'G', x, y + r * 0.35, r * 0.16);
  needle(ctx, x, y, r * 0.86, f(v.gMax), { width: 0.04, color: '#e58a2a' });
  needle(ctx, x, y, r * 0.86, f(v.gMin), { width: 0.04, color: '#e58a2a' });
  needle(ctx, x, y, r * 0.88, f(v.g));
  glass(ctx, x, y, r);
}

/** Whiskey compass: a card strip seen through a window, lubber line in the middle. */
export function compass(ctx, x, y, w, h, headingDeg) {
  ctx.save();
  ctx.fillStyle = '#0b0c0e';
  ctx.fillRect(x - w / 2 - 4, y - h / 2 - 4, w + 8, h + 8);
  ctx.beginPath(); ctx.rect(x - w / 2, y - h / 2, w, h); ctx.clip();
  ctx.fillStyle = '#1a1b1e';
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
  const pxPerDeg = w / 60;
  for (let d = Math.floor(headingDeg) - 40; d <= headingDeg + 40; d++) {
    const dd = ((d % 360) + 360) % 360;
    const px = x + (d - headingDeg) * pxPerDeg;
    if (dd % 5 === 0) {
      ctx.fillStyle = INK;
      ctx.fillRect(px - 0.5, y + h * 0.1, 1, dd % 10 === 0 ? h * 0.3 : h * 0.15);
    }
    if (dd % 30 === 0) {
      const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
      label(ctx, names[dd] || String(dd / 10), px, y - h * 0.15, h * 0.36);
    }
  }
  ctx.fillStyle = '#e58a2a';
  ctx.fillRect(x - 1, y - h / 2, 2, h);
  ctx.restore();
}

/** Inclinometer ball in its curved tube; ball in -1..1. */
export function slipBall(ctx, x, y, w, ball) {
  const h = w * 0.18;
  ctx.save();
  ctx.fillStyle = '#d9d4c4';
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y - h * 0.2);
  ctx.quadraticCurveTo(x, y + h * 0.9, x + w / 2, y - h * 0.2);
  ctx.lineTo(x + w / 2, y + h * 0.5);
  ctx.quadraticCurveTo(x, y + h * 1.6, x - w / 2, y + h * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.fillRect(x - h * 0.65, y - h * 0.1, 2, h * 1.2);
  ctx.fillRect(x + h * 0.65 - 2, y - h * 0.1, 2, h * 1.2);
  const bx = x + ball * (w / 2 - h * 0.5);
  const t = (bx - x) / (w / 2);
  const by = y + h * 0.55 - t * t * h * 0.55;
  ctx.fillStyle = '#0d0d0d';
  ctx.beginPath(); ctx.arc(bx, by, h * 0.42, 0, TAU); ctx.fill();
  ctx.restore();
}

export const COLORS = { GREEN, YELLOW, RED, WHITE_ARC };
