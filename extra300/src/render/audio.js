// audio.js — synthesised cockpit sound, no samples to ship.
//
// A six-cylinder four-stroke fires three times a revolution and the
// three-blade prop passes three times a revolution, so both sit on the same
// fundamental: rpm / 20 Hz. Exhaust roar follows power, wind follows
// dynamic pressure, the stall horn follows the vane.

export class CockpitSound {
  constructor() {
    this.ctx = null;
    this.nodes = null;
    this.muted = false;
  }

  /** Must be called from a user gesture (entering the aircraft). */
  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s; };

    // engine: fundamental + harmonics through a low-pass that opens with power
    const engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 400;
    const engGain = ctx.createGain();
    engGain.gain.value = 0;
    engFilter.connect(engGain).connect(master);
    const oscs = [1, 2, 3, 0.5].map((mult, i) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'sawtooth' : 'triangle';
      const g = ctx.createGain();
      g.gain.value = [0.5, 0.25, 0.12, 0.3][i];
      o.connect(g).connect(engFilter);
      o.start();
      return { o, mult };
    });
    // exhaust roar
    const roarF = ctx.createBiquadFilter();
    roarF.type = 'bandpass'; roarF.frequency.value = 180; roarF.Q.value = 0.7;
    const roarG = ctx.createGain(); roarG.gain.value = 0;
    noise().connect(roarF).connect(roarG).connect(master);
    // wind
    const windF = ctx.createBiquadFilter();
    windF.type = 'bandpass'; windF.frequency.value = 900; windF.Q.value = 0.4;
    const windG = ctx.createGain(); windG.gain.value = 0;
    noise().connect(windF).connect(windG).connect(master);
    // stall horn
    const horn = ctx.createOscillator();
    horn.type = 'square'; horn.frequency.value = 1150; horn.start();
    const hornG = ctx.createGain(); hornG.gain.value = 0;
    horn.connect(hornG).connect(master);

    this.nodes = { master, engFilter, engGain, oscs, roarF, roarG, windF, windG, hornG };
  }

  /** @param {{ rpm:number, powerFrac:number, running:boolean, qbar:number, stall:boolean, inside:boolean }} s */
  update(s) {
    const n = this.nodes;
    if (!n) return;
    const t = this.ctx.currentTime;
    const k = 0.08; // smoothing time constant
    const f0 = Math.max(1, s.rpm / 20);
    for (const { o, mult } of n.oscs) o.frequency.setTargetAtTime(f0 * mult, t, k);
    const p = Math.max(0, Math.min(1.1, s.powerFrac));
    const spin = Math.min(1, s.rpm / 700);
    n.engGain.gain.setTargetAtTime((s.running ? 0.18 + 0.32 * p : 0.08 * spin) * spin, t, k);
    n.engFilter.frequency.setTargetAtTime(250 + 1600 * p, t, k);
    n.roarG.gain.setTargetAtTime(s.running ? 0.05 + 0.35 * p : 0, t, k);
    n.roarF.frequency.setTargetAtTime(120 + f0 * 1.5, t, k);
    const wind = Math.min(1, s.qbar / 9000);
    n.windG.gain.setTargetAtTime(0.5 * wind, t, 0.2);
    n.windF.frequency.setTargetAtTime(500 + 1500 * wind, t, 0.2);
    n.hornG.gain.setTargetAtTime(s.stall ? 0.06 : 0, t, 0.03);
    n.master.gain.setTargetAtTime(this.muted ? 0 : (s.inside ? 0.55 : 0.35), t, 0.2);
  }

  stop() {
    if (!this.ctx) return;
    try { this.ctx.close(); } catch (_) { /* already closed */ }
    this.ctx = null;
    this.nodes = null;
  }
}
