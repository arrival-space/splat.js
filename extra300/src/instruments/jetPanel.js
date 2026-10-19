// jetPanel.js — the jets' cluster along the bottom (the F-15, the X-wing, the 777), in every view: the
// thrust lever (its military-power detent, the afterburner above it), N2 and FTIT, fuel flow and fuel,
// and the gear and configuration lamps. Speed, height and attitude are the head-up display's
// (jetHud.js). The same frame as panel.js: transparent round the instruments, the lever draggable and
// the ENGINE OFF lamp a button (plugin/hud.js).

import * as G from './gauges.js';

/** Horizontal layout in units of the dial radius r. */
function layout(r) {
  const m = r * 0.25;
  const lev = { x: m, w: r * 1.05 };
  const n2 = lev.x + lev.w + r * 1.25;
  const ftit = n2 + r * 2.3;
  const digi = { x: ftit + r * 1.25, w: r * 1.7 };
  const lamps = { x: digi.x + digi.w + r * 0.3, w: r * 2.6 };
  return { m, lev, n2, ftit, digi, lamps, width: lamps.x + lamps.w + m };
}

function slot(r, h) {
  const L = layout(r), cy = h - r * 1.2;
  return { x: L.lev.x + L.lev.w / 2, top: cy - r * 0.86, travel: r * 1.5, plate: { x: L.lev.x, y: cy - r * 1.12, w: L.lev.w, h: r * 2.3 } };
}

// the lamps: two columns of four
const LAMPS = ['GEAR', 'SB', 'FLAP', 'HOOK', 'PARK BRK', 'ENGINE OFF', 'AOA', 'PAUSED'];
function lampBox(r, h, i) {
  const L = layout(r), cy = h - r * 1.2, lh = r * 0.4, lg = r * 0.1, cw = (L.lamps.w - r * 0.1) / 2;
  const y0 = cy - (4 * lh + 3 * lg) / 2;
  return { x: L.lamps.x + (i % 2) * (cw + r * 0.1), y: y0 + Math.floor(i / 2) * (lh + lg), w: cw, h: lh, y0, total: 4 * lh + 3 * lg };
}

export class JetPanel {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  static radiusFor(h) { return h * 0.34; }
  static widthFor(r) { return layout(r).width; }
  static throttleSlot(h) { return slot(JetPanel.radiusFor(h), h); }
  static lampBoxFor(h, key) { const i = LAMPS.indexOf(key); return i < 0 ? null : lampBox(JetPanel.radiusFor(h), h, i); }

  resize(cssWidth, cssHeight, dpr = 1) {
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
  }

  /**
   * @param {object} v  Instruments.values (n2, ftit, fuelFlow pph, fuelLb, stallWarning)
   * @param {object} s  { throttle, abDetent, boostLabel, gearPos, speedbrake, flaps, hook, sfoils, parkingBrake, engineRunning, paused,
   *                     buttons: the lamps that are clickable }
   */
  draw(v, s = {}) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    const r = JetPanel.radiusFor(H), L = layout(r), cy = H - r * 1.2;
    const plate = (x, y, w, h) => {
      ctx.fillStyle = 'rgba(14,15,17,0.82)';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r * 0.12); ctx.fill();
    };
    const text = (t, x, y, size, col = '#f1efe8', weight = 700, align = 'center') => {
      ctx.fillStyle = col; ctx.font = `${weight} ${Math.round(size)}px Arial`; ctx.textAlign = align; ctx.textBaseline = 'middle';
      ctx.fillText(t, x, y);
    };

    // the thrust lever: idle at the bottom, the detent (military power) marked, the afterburner above it
    const S = slot(r, H), t = Math.max(0, Math.min(1, s.throttle ?? 0));
    const det = s.abDetent != null && s.abDetent < 0.999 ? s.abDetent : null;
    plate(S.plate.x, S.plate.y, S.plate.w, S.plate.h);
    if (det != null) {
      ctx.fillStyle = 'rgba(255,140,40,0.28)';
      ctx.fillRect(S.x - r * 0.3, S.top, r * 0.6, (1 - det) * S.travel);
    }
    ctx.fillStyle = '#050506';
    ctx.beginPath(); ctx.roundRect(S.x - r * 0.05, S.top - r * 0.04, r * 0.1, S.travel + r * 0.08, r * 0.05); ctx.fill();
    ctx.strokeStyle = '#6d6b66'; ctx.lineWidth = Math.max(1, r * 0.015);
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      const y = S.top + (1 - q * (det ?? 1)) * S.travel, wd = q === 0 || q === 1 ? r * 0.3 : r * 0.18;
      ctx.beginPath(); ctx.moveTo(S.x - wd, y); ctx.lineTo(S.x - r * 0.1, y); ctx.moveTo(S.x + r * 0.1, y); ctx.lineTo(S.x + wd, y); ctx.stroke();
    }
    if (det != null) {
      const y = S.top + (1 - det) * S.travel;
      ctx.strokeStyle = '#ffb86b'; ctx.lineWidth = Math.max(1.5, r * 0.025);
      ctx.beginPath(); ctx.moveTo(S.x - r * 0.42, y); ctx.lineTo(S.x + r * 0.42, y); ctx.stroke();
    }
    const ky = S.top + (1 - t) * S.travel, kw = r * 0.74, kh = r * 0.24;
    const ab = det != null && t > det + 1e-3;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.roundRect(S.x - kw / 2 + r * 0.02, ky - kh / 2 + r * 0.04, kw, kh, r * 0.07); ctx.fill();
    ctx.fillStyle = '#1b1c1f';
    ctx.beginPath(); ctx.roundRect(S.x - kw / 2, ky - kh / 2, kw, kh, r * 0.07); ctx.fill();
    ctx.fillStyle = ab ? '#ffb86b' : '#efece4';
    ctx.beginPath(); ctx.roundRect(S.x - kw / 2 + r * 0.06, ky - kh * 0.18, kw - r * 0.12, kh * 0.36, r * 0.03); ctx.fill();
    text('THRUST', S.x, S.plate.y + r * 0.13, r * 0.13, '#bdbab2');
    const stage = ab ? Math.max(1, Math.round(((t - det) / (1 - det)) * 5)) : 0;
    text(ab ? `${s.boostLabel || 'AB'} ${stage}` : `${Math.round((t / (det ?? 1)) * 100)} %`, S.x, S.top + S.travel + r * 0.2, r * 0.15, ab ? '#ffb86b' : '#f1efe8');

    // the engine: N2 and turbine temperature
    G.dial(ctx, L.n2, cy, r, v.n2 || 0, { min: 0, max: 110, step: 20, name: 'N2 RPM', unit: ' %', bands: [[60, 100, 'green'], [100, 104, 'yellow'], [104, 110, 'red']] });
    G.dial(ctx, L.ftit, cy, r, v.ftit || 0, { min: 200, max: 1200, step: 200, scale: 100, name: 'FTIT', unit: ' °C', bands: [[300, 940, 'green'], [940, 1000, 'yellow'], [1000, 1200, 'red']] });

    // fuel flow and fuel on board
    const dx = L.digi.x, dw = L.digi.w;
    plate(dx, cy - r * 0.98, dw, r * 1.96);
    const row = (label, value, y) => {
      text(label, dx + dw / 2, y, r * 0.13, '#bdbab2');
      ctx.fillStyle = '#050506'; ctx.fillRect(dx + r * 0.12, y + r * 0.12, dw - r * 0.24, r * 0.42);
      text(value, dx + dw / 2, y + r * 0.33, r * 0.24, '#6dff9e', 700);
    };
    row('FUEL FLOW PPH', String(Math.round((v.fuelFlow || 0) / 100) * 100), cy - r * 0.8);
    row('FUEL LB', String(Math.round((v.fuelLb || 0) / 10) * 10), cy + r * 0.05);

    // the lamps (the ones that are buttons as well outlined: s.buttons)
    const b0 = lampBox(r, H, 0);
    plate(L.lamps.x - r * 0.08, b0.y0 - r * 0.08, L.lamps.w + r * 0.16, b0.total + r * 0.16);
    const g = s.gearPos ?? 1;
    const state = {
      GEAR: [g > 0.01, g > 0.99 ? '#3ad06a' : '#ffb86b', g > 0.99 ? 'GEAR ●●●' : g < 0.01 ? 'GEAR UP' : 'GEAR ◐'],
      SB: [s.speedbrake != null && s.speedbrake > 0.05, '#ffb86b', s.speedbrake == null ? null : 'SPD BRK'],
      FLAP: [s.flaps != null && s.flaps > 0.05, '#3ad06a', s.flaps == null ? (s.sfoils == null ? null : 'S-FOILS') : 'FLAPS'],
      HOOK: [s.hook != null && s.hook > 0.05, '#ffb86b', s.hook == null ? null : 'HOOK'],
      'PARK BRK': [!!s.parkingBrake, '#e3c13b', 'PARK BRK'],
      'ENGINE OFF': [!s.engineRunning, '#e3c13b', 'ENGINE OFF'],
      AOA: [!!v.stallWarning, '#e0452f', 'AOA'],
      PAUSED: [!!s.paused, '#7fb0ff', 'PAUSED'],
    };
    if (s.flaps == null && s.sfoils != null) state.FLAP[0] = s.sfoils > 0.05;
    LAMPS.forEach((key, i) => {
      const [on, col, label] = state[key];
      const b = lampBox(r, H, i);
      if (!label) { ctx.fillStyle = 'rgba(30,31,34,0.6)'; ctx.fillRect(b.x, b.y, b.w, b.h); return; }
      ctx.fillStyle = on ? col : 'rgba(42,43,46,0.85)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      const button = !!s.buttons?.has(key);
      if (button) { ctx.strokeStyle = on ? 'rgba(0,0,0,0.5)' : 'rgba(227,193,59,0.7)'; ctx.lineWidth = Math.max(1, r * 0.02); ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); }
      text(label, b.x + b.w / 2, b.y + b.h / 2, r * 0.13, on ? '#111' : button ? '#d9d2b4' : '#7a7b80');
    });
    ctx.restore();
  }
}
