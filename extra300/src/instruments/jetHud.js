// jetHud.js — the F-15's head-up display, drawn over the whole view: pitch
// ladder rolling with the bank, the flight-path marker, the heading tape,
// airspeed and altitude boxes, Mach, g and angle of attack, and below it a
// compact engine and gear strip. The ladder is to scale with the camera's
// field of view, so in the cockpit it lies on the real horizon; from outside
// (chase, tower, fly-by) only the numbers show.

const GREEN = '#6dff9e';
const DIM = 'rgba(109,255,158,0.55)';

const pad = (n, w) => String(Math.round(n)).padStart(w, '0');

export class JetHud {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize(cssWidth, cssHeight, dpr = 1) {
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.dpr = dpr;
  }

  /**
   * @param {object} v  Instruments.values (ias, altitude, vsi, g, mach, aoa, pitch, bank, flightPath, drift, heading, n2, ftit, fuelFlow, fuelLb, ab)
   * @param {object} s  { fov (vertical, deg), conformal (the cockpit view), throttle, abDetent, gearPos, speedbrake, flaps, parkingBrake, engineRunning, paused, stall, gMax }
   */
  draw(v, s = {}) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    const u = Math.min(W, H * 1.4) / 100;            // layout unit
    const cx = W / 2, cy = H * 0.47;
    const ppd = H / (s.fov || 70);                      // pixels per degree, vertically
    ctx.strokeStyle = GREEN;
    ctx.fillStyle = GREEN;
    ctx.lineWidth = Math.max(1.2, u * 0.16);
    ctx.shadowColor = 'rgba(40,255,120,0.55)';
    ctx.shadowBlur = u * 0.5;
    ctx.font = `600 ${Math.round(u * 1.9)}px "Helvetica Neue", Arial, sans-serif`;
    ctx.textBaseline = 'middle';

    // ── pitch ladder, rolled with the bank, clipped to the HUD's field ──
    const fieldW = u * 30, fieldH = Math.min(H * 0.62, u * 40);
    const pitch = v.pitch || 0;
    if (s.conformal !== false) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - fieldW, cy - fieldH / 2, fieldW * 2, fieldH);
      ctx.clip();
      ctx.translate(cx, cy);
      ctx.rotate(-(v.bank || 0) * Math.PI / 180);
      for (let a = -90; a <= 90; a += 5) {
        const y = (pitch - a) * ppd;
        if (Math.abs(y) > fieldH) continue;
        if (a === 0) {
          ctx.beginPath();
          ctx.moveTo(-u * 24, y); ctx.lineTo(-u * 5, y);
          ctx.moveTo(u * 5, y); ctx.lineTo(u * 24, y);
          ctx.stroke();
          continue;
        }
        const w = u * 7, gap = u * 4, tick = a > 0 ? u * 1.2 : -u * 1.2;
        ctx.setLineDash(a < 0 ? [u * 1.1, u * 0.8] : []);
        ctx.beginPath();
        ctx.moveTo(-gap - w, y + tick); ctx.lineTo(-gap - w, y); ctx.lineTo(-gap, y);
        ctx.moveTo(gap, y); ctx.lineTo(gap + w, y); ctx.lineTo(gap + w, y + tick);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.abs(a)), -gap - w - u * 0.8, y);
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.abs(a)), gap + w + u * 0.8, y);
      }
      ctx.restore();

      // ── boresight (the nose): a W ──
      ctx.beginPath();
      ctx.moveTo(cx - u * 3.2, cy); ctx.lineTo(cx - u * 1.6, cy); ctx.lineTo(cx - u * 0.8, cy + u * 1.2);
      ctx.lineTo(cx, cy); ctx.lineTo(cx + u * 0.8, cy + u * 1.2); ctx.lineTo(cx + u * 1.6, cy); ctx.lineTo(cx + u * 3.2, cy);
      ctx.stroke();

      // ── flight-path marker: where the airplane is actually going ──
      const fpmX = cx + Math.max(-fieldW, Math.min(fieldW, (v.drift || 0) * ppd));
      const fpmY = cy + Math.max(-fieldH / 2, Math.min(fieldH / 2, (pitch - (v.flightPath || 0)) * ppd));
      ctx.beginPath();
      ctx.arc(fpmX, fpmY, u * 1.0, 0, Math.PI * 2);
      ctx.moveTo(fpmX - u * 1.0, fpmY); ctx.lineTo(fpmX - u * 2.6, fpmY);
      ctx.moveTo(fpmX + u * 1.0, fpmY); ctx.lineTo(fpmX + u * 2.6, fpmY);
      ctx.moveTo(fpmX, fpmY - u * 1.0); ctx.lineTo(fpmX, fpmY - u * 2.2);
      ctx.stroke();
    }

    // ── heading tape across the top ──
    const hdg = ((v.heading || 0) % 360 + 360) % 360;
    const tapeY = cy - fieldH / 2 - u * 2.5, tapeW = u * 22, perDeg = u * 0.7;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - tapeW, tapeY - u * 4, tapeW * 2, u * 6);
    ctx.clip();
    for (let d = Math.floor((hdg - 40) / 5) * 5; d <= hdg + 40; d += 5) {
      const x = cx + (d - hdg) * perDeg;
      const major = ((d % 10) + 10) % 10 === 0;
      ctx.beginPath();
      ctx.moveTo(x, tapeY); ctx.lineTo(x, tapeY - (major ? u * 1.4 : u * 0.7));
      ctx.stroke();
      if (major) {
        ctx.textAlign = 'center';
        ctx.fillText(pad(((d % 360) + 360) % 360 / 10, 2), x, tapeY - u * 2.6);
      }
    }
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(cx, tapeY + u * 0.4); ctx.lineTo(cx - u * 0.8, tapeY + u * 1.6); ctx.lineTo(cx + u * 0.8, tapeY + u * 1.6); ctx.closePath();
    ctx.stroke();

    // ── airspeed (left) and altitude (right) boxes, the rest under them ──
    const box = (x, y, text, align) => {
      const bw = u * 9, bh = u * 3.4;
      ctx.strokeRect(align === 'left' ? x : x - bw, y - bh / 2, bw, bh);
      ctx.textAlign = 'center';
      ctx.font = `700 ${Math.round(u * 2.3)}px "Helvetica Neue", Arial, sans-serif`;
      ctx.fillText(text, align === 'left' ? x + bw / 2 : x - bw / 2, y);
      ctx.font = `600 ${Math.round(u * 1.9)}px "Helvetica Neue", Arial, sans-serif`;
    };
    const lx = cx - fieldW - u * 2, rx = cx + fieldW + u * 2;
    box(lx, cy, String(Math.round(v.ias || 0)), 'right');
    const alt = Math.round((v.altitude || 0) / 10) * 10;
    box(rx, cy, alt.toLocaleString('en-US'), 'left');
    ctx.textAlign = 'right';
    const lines = [
      [`M ${(v.mach || 0).toFixed(2)}`, false],
      [`G ${(v.g || 0).toFixed(1)}`, (v.g || 0) > (s.gMax || 9) - 1],
      [`α ${(v.aoa || 0).toFixed(1)}`, !!s.stall],
    ];
    lines.forEach(([t, warn], i) => {
      ctx.fillStyle = warn ? '#ffd166' : GREEN;
      ctx.fillText(t, lx - u * 0.5, cy + u * (4.5 + i * 2.6));
    });
    ctx.fillStyle = GREEN;
    ctx.textAlign = 'left';
    const vs = Math.round((v.vsi || 0) / 100) * 100;
    ctx.fillText(`${vs >= 0 ? '+' : ''}${vs}`, rx + u * 0.5, cy + u * 4.5);
    ctx.fillStyle = DIM;
    ctx.fillText('KCAS', lx - u * 9, cy - u * 3.2);
    ctx.fillText('FT', rx + u * 0.3, cy - u * 3.2);
    ctx.fillStyle = GREEN;
    if (s.stall) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd166';
      ctx.fillText('AOA', cx, cy + fieldH / 2 - u * 2);
      ctx.fillStyle = GREEN;
    }

    // ── engine and configuration strip along the bottom ──
    ctx.shadowBlur = 0;
    const sy = H - u * 4.2;
    const items = [];
    items.push(`N2 ${Math.round(v.n2 || 0)}%`);
    items.push(`FTIT ${Math.round(v.ftit || 0)}°`);
    items.push(`FF ${Math.round((v.fuelFlow || 0) / 100) * 100}`);
    items.push(`FUEL ${Math.round((v.fuelLb || 0) / 10) * 10}`);
    const thr = s.throttle ?? 0, det = s.abDetent ?? 0.8;
    items.push(thr > det ? `AB ${Math.round(((thr - det) / (1 - det)) * 5) || 1}` : `THR ${Math.round((thr / det) * 100)}%`);
    ctx.font = `700 ${Math.round(u * 1.8)}px "Helvetica Neue", Arial, sans-serif`;
    const gapX = u * 2.2;
    const widths = items.map((t) => ctx.measureText(t).width);
    const total = widths.reduce((a, b) => a + b, 0) + gapX * (items.length - 1) + u * 26;
    let x = cx - total / 2;
    ctx.fillStyle = 'rgba(8,12,10,0.55)';
    ctx.fillRect(x - u, sy - u * 1.9, total + 2 * u, u * 3.8);
    ctx.textAlign = 'left';
    items.forEach((t, i) => {
      ctx.fillStyle = i === 4 && thr > det ? '#ffb86b' : GREEN;
      ctx.fillText(t, x, sy);
      x += widths[i] + gapX;
    });
    // gear: three lights, green down and locked, amber in transit; speed brake, flaps, brake, pause
    const g = s.gearPos ?? 1;
    const lamp = (label, on, col) => {
      ctx.fillStyle = on ? col : 'rgba(109,255,158,0.18)';
      ctx.fillText(label, x, sy);
      x += ctx.measureText(label).width + u * 1.2;
    };
    lamp(g > 0.99 ? '●●●' : g < 0.01 ? '○○○' : '◐◐◐', g > 0.01, g > 0.99 ? GREEN : '#ffb86b');
    lamp('SB', (s.speedbrake || 0) > 0.05, '#ffb86b');
    lamp('FLAP', (s.flaps || 0) > 0.05, GREEN);
    lamp('PARK', !!s.parkingBrake, '#ffd166');
    if (!s.engineRunning) lamp('ENG OFF', true, '#ffd166');
    if (s.paused) lamp('PAUSED', true, '#7fb0ff');
    ctx.restore();
  }
}
