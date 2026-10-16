// hud.js — the DOM side: instrument panel canvas, the boarding prompt, the
// keyboard card, status messages, and touch buttons on phones.

import { Panel } from '../instruments/panel.js';

export const CREDIT = 'Map data © OpenStreetMap contributors (ODbL) · City of Chicago';

const QUICK_START = [
  'Hold <b>R</b> for full throttle, keep it straight with <b>Q</b> / <b>E</b>',
  'At 60 kt ease back on <b>S</b> (or <b>↓</b>) and it flies',
  '<b>W A S D</b> or the arrows fly it, <b>V</b> changes the view, <b>Esc</b> gets out',
];

const HELP = [
  ['Pitch', 'S / ↓ nose up (pull)    W / ↑ nose down (push)'],
  ['Roll', 'A / ←  left    D / →  right'],
  ['Rudder', 'Q  left    E  right    (Z / X too)'],
  ['Throttle', 'R  more    F  less    (also + / − or PgUp / PgDn)    Home idle    End full'],
  ['Brakes', 'B or .  (hold)    ,  parking brake'],
  ['Trim', ';  nose down    \'  nose up'],
  ['Prop rpm', '[  lower    ]  higher'],
  ['Engine', 'M  mixture run / cut-off    K  starter (hold, if it stopped)'],
  ['Views', 'V  cockpit · chase · tower · fly-by    drag the mouse to look    C  centre'],
  ['Panel', 'I  show / hide    G  reset g-meter    N  set altimeter'],
  ['Mouse yoke', 'Y  fly with the mouse (screen centre = neutral)'],
  ['Sim', 'P  pause    Backspace  back to runway 36    Esc  leave the airplane'],
  ['Gamepad', 'left stick flies, right stick rudder / throttle, triggers brake'],
];

export class Hud {
  constructor(container, limits, isMobile) {
    this.container = container;
    this.isMobile = isMobile;
    const css = (el, s) => Object.assign(el.style, s);

    this.panelCanvas = document.createElement('canvas');
    css(this.panelCanvas, { position: 'fixed', left: '0', bottom: '0', pointerEvents: 'none', zIndex: 20, display: 'none' });
    container.appendChild(this.panelCanvas);
    this.panel = new Panel(this.panelCanvas, limits);

    this.prompt = document.createElement('div');
    css(this.prompt, {
      position: 'fixed', left: '50%', bottom: '18%', transform: 'translateX(-50%)', padding: '10px 18px',
      background: 'rgba(12,13,16,0.82)', color: '#f1efe8', font: '600 15px "Helvetica Neue", Arial, sans-serif',
      borderRadius: '6px', zIndex: 21, display: 'none', pointerEvents: 'none', letterSpacing: '0.02em',
    });
    container.appendChild(this.prompt);

    this.message = document.createElement('div');
    css(this.message, {
      position: 'fixed', left: '50%', top: '9%', transform: 'translateX(-50%)', padding: '8px 16px',
      background: 'rgba(12,13,16,0.75)', color: '#f1efe8', font: '600 14px "Helvetica Neue", Arial, sans-serif',
      borderRadius: '6px', zIndex: 21, display: 'none', pointerEvents: 'none',
    });
    container.appendChild(this.message);
    this._msgUntil = 0;

    this.help = document.createElement('div');
    css(this.help, {
      position: 'fixed', right: '16px', top: '16px', padding: '12px 16px', maxWidth: '520px',
      background: 'rgba(12,13,16,0.86)', color: '#e6e3da', font: '13px/1.55 "Helvetica Neue", Arial, sans-serif',
      borderRadius: '8px', zIndex: 22, display: 'none', pointerEvents: 'none',
    });
    this.help.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Extra 300L — Meigs Field (CGX), runway 36</div>`
      + `<div style="margin:0 0 8px;padding:6px 8px;background:rgba(255,255,255,0.07);border-radius:6px">`
      + QUICK_START.map((t, i) => `<div>${i + 1}. ${t}</div>`).join('') + `</div>`
      // the double spaces in HELP separate key groups; HTML would collapse them
      + HELP.map(([a, b]) => `<div><span style="display:inline-block;width:92px;color:#9d9a92">${a}</span>${b.replace(/ {2,}/g, ' <span style="color:#6f6c66">·</span> ')}</div>`).join('')
      + `<div style="margin-top:8px;color:#9d9a92">H hides this card.</div>`
      + `<div style="margin-top:4px;color:#9d9a92;font-size:11px">${CREDIT}</div>`;
    container.appendChild(this.help);

    // ODbL: the map data is credited wherever the city is on screen
    this.credit = document.createElement('div');
    this.credit.textContent = CREDIT;
    css(this.credit, {
      position: 'fixed', right: '8px', top: '6px', color: 'rgba(240,238,232,0.75)', font: '11px Arial, sans-serif',
      textShadow: '0 1px 2px #000', zIndex: 21, display: 'none', pointerEvents: 'none',
    });
    container.appendChild(this.credit);

    this.readout = document.createElement('div');
    css(this.readout, {
      position: 'fixed', left: '12px', top: '12px', color: '#f1efe8', font: '600 12px ui-monospace, Menlo, monospace',
      textShadow: '0 1px 2px #000', zIndex: 21, display: 'none', pointerEvents: 'none', whiteSpace: 'pre',
    });
    container.appendChild(this.readout);

    this.buttons = {};
    if (isMobile) {
      const mk = (id, text, style) => {
        const b = document.createElement('button');
        b.textContent = text;
        css(b, {
          position: 'fixed', zIndex: 23, padding: '10px 14px', borderRadius: '8px', border: 'none',
          background: 'rgba(12,13,16,0.7)', color: '#f1efe8', font: '600 13px Arial', display: 'none', ...style,
        });
        container.appendChild(b);
        this.buttons[id] = b;
        return b;
      };
      mk('board', 'Fly the Extra', { left: '50%', bottom: '26%', transform: 'translateX(-50%)', display: 'none' });
      mk('exit', 'Exit', { right: '12px', top: '12px' });
      mk('view', 'View', { right: '12px', top: '60px' });
      mk('brake', 'Brake', { right: '12px', top: '108px' });
      mk('reset', 'Reset', { right: '12px', top: '156px' });
    }
    this.layout();
  }

  layout() {
    const w = window.innerWidth;
    const h = Math.round(Math.min(window.innerHeight * 0.26, w * 0.17));
    this.panel.resize(w, h, Math.min(2, window.devicePixelRatio || 1));
    this.panelHeight = h;
  }

  showPrompt(text) {
    this.prompt.textContent = text || '';
    this.prompt.style.display = text ? 'block' : 'none';
    if (this.buttons.board) this.buttons.board.style.display = text ? 'block' : 'none';
  }

  flash(text, seconds = 3) {
    this.message.textContent = text;
    this.message.style.display = 'block';
    this._msgUntil = performance.now() + seconds * 1000;
  }

  tick() {
    if (this._msgUntil && performance.now() > this._msgUntil) {
      this.message.style.display = 'none';
      this._msgUntil = 0;
    }
  }

  setFlying(flying, panelVisible) {
    this.panelCanvas.style.display = flying && panelVisible ? 'block' : 'none';
    this.readout.style.display = flying ? 'block' : 'none';
    this.credit.style.display = flying ? 'block' : 'none';
    for (const id of ['exit', 'view', 'brake', 'reset']) if (this.buttons[id]) this.buttons[id].style.display = flying ? 'block' : 'none';
    if (!flying) this.help.style.display = 'none';
  }

  toggleHelp(show) {
    const on = show ?? this.help.style.display === 'none';
    this.help.style.display = on ? 'block' : 'none';
  }

  destroy() {
    for (const el of [this.panelCanvas, this.prompt, this.message, this.help, this.readout, this.credit, ...Object.values(this.buttons)]) el.remove();
  }
}
