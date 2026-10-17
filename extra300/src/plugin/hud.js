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
  ['Pitch', 'S / ↓ nose up (pull)    W / ↑ nose down (push)    + Shift: pull through the buffet'],
  ['Roll', 'A / ←  left    D / →  right'],
  ['Easy mode', 'L  on / off, any time: no stalls, rudder and bank held against the torque'],
  ['Rudder', 'Q  left    E  right    (Z / X too)    U  auto-rudder on / off'],
  ['Throttle', 'R  more    F  less    (also + / − or PgUp / PgDn)    Home idle    End full'],
  ['Brakes', 'B or .  (hold)    ,  parking brake'],
  ['Trim', ';  nose down    \'  nose up'],
  ['Prop rpm', '[  lower    ]  higher'],
  ['Engine', 'M  mixture run / cut-off    K  starter (hold, if it stopped)'],
  ['Views', 'V  cockpit · chase · tower · fly-by    drag the mouse to look (chase: orbit)    wheel: zoom    C  centre'],
  ['Intro', 'Space / Enter / Esc skips it'],
  ['Panel', 'I  show / hide    G  reset g-meter    N  set altimeter'],
  ['Mouse yoke', 'Y  fly with the mouse (screen centre = neutral)'],
  ['Sim', 'P  pause    Backspace  back to runway 36    Esc  leave the airplane'],
  ['Demo', 'O  watch a Platzrunde flown for you    any flight key takes over'],
  ['Gamepad', 'left stick flies, right stick rudder / throttle, triggers brake'],
];

export class Hud {
  /**
   * @param {HTMLElement} container  the script's UI container (click-through: pointer-events none)
   * @param {(tag: string, opts: object) => HTMLElement} createUI  the plugin API's createUI: the only way to
   *   get an element the pointer can reach — it sets pointer-events:auto and pauses the game's mouse
   *   capture while hovered, so the click lands on the button instead of the camera
   */
  constructor(container, limits, isMobile, createUI) {
    this.container = container;
    this.isMobile = isMobile;
    this.createUI = createUI;
    const css = (el, s) => Object.assign(el.style, s);

    this.panelCanvas = document.createElement('canvas');
    css(this.panelCanvas, { position: 'fixed', left: '50%', bottom: '4px', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 20, display: 'none' });
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

    // the full controls table: only when asked for (Controls button or H)
    this.help = document.createElement('div');
    css(this.help, {
      position: 'fixed', right: '16px', top: '58px', padding: '12px 16px', maxWidth: '520px',
      background: 'rgba(12,13,16,0.88)', color: '#e6e3da', font: '13px/1.55 "Helvetica Neue", Arial, sans-serif',
      borderRadius: '10px', zIndex: 22, display: 'none', pointerEvents: 'none', boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
    });
    this.help.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Extra 300L — controls</div>`
      // the double spaces in HELP separate key groups; HTML would collapse them
      + HELP.map(([a, b]) => `<div><span style="display:inline-block;width:92px;color:#9d9a92">${a}</span>${b.replace(/ {2,}/g, ' <span style="color:#6f6c66">·</span> ')}</div>`).join('')
      + `<div style="margin-top:8px;color:#9d9a92">H or Controls hides this card.</div>`
      + `<div style="margin-top:4px;color:#9d9a92;font-size:11px">${CREDIT}</div>`;
    container.appendChild(this.help);

    // what a new pilot needs, and nothing else: shown at the start, gone once the airplane is flying
    this.quick = document.createElement('div');
    css(this.quick, {
      position: 'fixed', left: '16px', top: '58px', padding: '10px 14px', maxWidth: '330px',
      background: 'rgba(12,13,16,0.78)', color: '#ece9e1', font: '13px/1.6 "Helvetica Neue", Arial, sans-serif',
      borderRadius: '10px', zIndex: 22, display: 'none', pointerEvents: 'none', boxShadow: '0 6px 24px rgba(0,0,0,0.3)',
    });
    this.quick.innerHTML = `<div style="font:700 11px 'Helvetica Neue',Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:#e0505a;margin-bottom:4px">Take off</div>`
      + QUICK_START.map((t) => `<div>${t}</div>`).join('')
      + `<div style="margin-top:6px;color:#9d9a92;font-size:12px">Everything else: <b>Controls</b> (or H)</div>`;
    container.appendChild(this.quick);

    // ODbL: the map data is credited wherever the city is on screen
    this.credit = document.createElement('div');
    this.credit.textContent = CREDIT;
    css(this.credit, {
      position: 'fixed', right: '8px', bottom: '4px', color: 'rgba(240,238,232,0.7)', font: '10px Arial, sans-serif',
      textShadow: '0 1px 2px #000', zIndex: 21, display: 'none', pointerEvents: 'none',
    });
    container.appendChild(this.credit);

    const button = (style) => {
      const b = createUI('button', { interactive: true, lockKeyboard: false });
      css(b, { position: 'fixed', zIndex: 1000, pointerEvents: 'auto', cursor: 'pointer', ...style });
      return b;
    };
    // the top bar: easy mode (switchable any time in flight) and the controls card
    const pill = {
      top: '12px', height: '34px', padding: '0 14px', borderRadius: '17px', display: 'none',
      border: '1px solid rgba(255,255,255,0.22)', color: '#f4f2ec', background: 'rgba(12,13,16,0.66)',
      font: '600 13px "Helvetica Neue", Arial, sans-serif', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
      backdropFilter: 'blur(6px)', whiteSpace: 'nowrap',
    };
    this.easyButton = button({ ...pill, left: 'calc(50% - 5px)', transform: 'translateX(-100%)' });
    this.controlsButton = button({ ...pill, left: 'calc(50% + 5px)' });
    this.controlsButton.innerHTML = 'Controls';
    this.controlsButton.title = 'All the keys (H)';
    this.setEasy(false);

    this._buildIntro(container, button);

    this.demoStatus = document.createElement('div');
    css(this.demoStatus, {
      position: 'fixed', left: '50%', top: '40px', transform: 'translateX(-50%)', padding: '6px 14px',
      background: 'rgba(12,13,16,0.72)', color: '#f1efe8', font: '600 15px "Helvetica Neue", Arial, sans-serif',
      borderRadius: '6px', zIndex: 21, display: 'none', pointerEvents: 'none',
    });
    container.appendChild(this.demoStatus);

    this.buttons = {};
    if (isMobile) {
      const mk = (id, text, style) => {
        const b = button({
          padding: '10px 14px', borderRadius: '8px', border: 'none',
          background: 'rgba(12,13,16,0.7)', color: '#f1efe8', font: '600 13px Arial', display: 'none', ...style,
        });
        b.textContent = text;
        this.buttons[id] = b;
        return b;
      };
      mk('board', 'Fly the Extra', { left: '50%', bottom: '26%', transform: 'translateX(-50%)', display: 'none' });
      mk('exit', 'Exit', { right: '12px', top: '22%' });
      mk('view', 'View', { right: '12px', top: 'calc(22% + 48px)' });
      mk('brake', 'Brake', { right: '12px', top: 'calc(42% + 56px)' });
      mk('reset', 'Reset', { right: '12px', top: 'calc(42% + 104px)' });
    }
    this.layout();
  }

  layout() {
    // the cluster is only as wide as its instruments, centred on the bottom edge
    let h = Math.round(Math.min(window.innerHeight * 0.21, 175));
    let w = Panel.widthFor(Panel.radiusFor(h));
    const maxW = window.innerWidth - 16;
    if (w > maxW) { h = Math.floor(h * (maxW / w)); w = Panel.widthFor(Panel.radiusFor(h)); }
    this.panel.resize(Math.ceil(w), h, Math.min(2, window.devicePixelRatio || 1));
    this.panelHeight = h;
  }

  showPrompt(text) {
    this.prompt.textContent = text || '';
    this.prompt.style.display = text ? 'block' : 'none';
    if (this.buttons.board) this.buttons.board.style.display = text ? 'block' : 'none';
  }

  /** Easy-mode switch: what it is now, and what a click does. */
  setEasy(on) {
    const knob = `<span style="display:inline-block;vertical-align:-3px;width:28px;height:16px;border-radius:8px;margin-right:8px;`
      + `background:${on ? '#2fa35a' : 'rgba(255,255,255,0.25)'};position:relative">`
      + `<span style="position:absolute;top:2px;left:${on ? 14 : 2}px;width:12px;height:12px;border-radius:6px;background:#fff"></span></span>`;
    this.easyButton.innerHTML = `${knob}Easy mode`;
    this.easyButton.title = on
      ? 'Easy mode is on: no stalls, torque handled for you. Click (or L) for the real thing'
      : 'Easy mode (L): the wing can\'t stall, rudder and bank are held against the torque';
  }

  // ── the intro: letterbox, caption cards, progress, skip ─────────────────
  _buildIntro(container, button) {
    const css = (el, st) => Object.assign(el.style, st);
    const bar = (edge) => {
      const d = document.createElement('div');
      css(d, { position: 'fixed', left: 0, right: 0, [edge]: 0, height: '0', background: '#000', zIndex: 30, pointerEvents: 'none', transition: 'height 0.6s ease' });
      container.appendChild(d);
      return d;
    };
    this.introTop = bar('top');
    this.introBottom = bar('bottom');
    this.introCard = document.createElement('div');
    css(this.introCard, {
      position: 'fixed', left: '6vw', bottom: 'calc(11vh + 26px)', zIndex: 31, pointerEvents: 'none', display: 'none',
      color: '#fff', textShadow: '0 2px 14px rgba(0,0,0,0.65)', font: '15px/1.5 "Helvetica Neue", Arial, sans-serif',
      maxWidth: 'min(860px, 82vw)', transition: 'opacity 0.25s linear, transform 0.25s ease',
    });
    container.appendChild(this.introCard);
    this.introProgress = document.createElement('div');
    css(this.introProgress, { position: 'fixed', left: 0, bottom: 0, height: '3px', width: '0', background: '#c41e2a', zIndex: 32, pointerEvents: 'none', display: 'none' });
    container.appendChild(this.introProgress);
    this.skipButton = button({
      right: '24px', bottom: 'calc(11vh + 22px)', padding: '8px 16px', borderRadius: '18px', display: 'none', zIndex: 1001,
      border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(12,13,16,0.55)', color: '#fff',
      font: '600 13px "Helvetica Neue", Arial, sans-serif', letterSpacing: '0.04em',
    });
    this.skipButton.textContent = 'Skip intro ›';
    this.skipButton.title = 'Space, Enter or Esc';
    this._introCardShown = -1;
  }

  showIntro(on) {
    this.introTop.style.height = on ? '11vh' : '0';
    this.introBottom.style.height = on ? '11vh' : '0';
    this.introCard.style.display = on ? 'block' : 'none';
    this.introProgress.style.display = on ? 'block' : 'none';
    this.skipButton.style.display = on ? 'block' : 'none';
    this._introCardShown = -1;
    if (on) { this.panelCanvas.style.display = 'none'; this.quick.style.display = 'none'; this.help.style.display = 'none'; }
    for (const b of [this.easyButton, this.controlsButton]) b.style.display = on ? 'none' : b.style.display;
  }

  /** One caption card: { kicker, title, lines }, faded by alpha; progress 0..1 along the bottom edge. */
  setIntroCard(card, alpha, progress) {
    this.introProgress.style.width = `${(progress * 100).toFixed(2)}%`;
    if (!card) { this.introCard.style.opacity = '0'; return; }
    if (this._introCardShown !== card) {
      this._introCardShown = card;
      this.introCard.innerHTML = `<div style="font:700 12px 'Helvetica Neue',Arial,sans-serif;letter-spacing:0.22em;text-transform:uppercase;color:#ff5a64;margin-bottom:6px">${card.kicker}</div>`
        + `<div style="font:800 clamp(26px,4.2vw,54px)/1.05 'Helvetica Neue',Arial,sans-serif;letter-spacing:-0.01em;margin-bottom:10px;white-space:nowrap">${card.title}</div>`
        + card.lines.map((l) => `<div style="opacity:0.92">${l}</div>`).join('');
    }
    this.introCard.style.opacity = alpha.toFixed(3);
    this.introCard.style.transform = `translateY(${((1 - alpha) * 10).toFixed(1)}px)`;
  }

  /** The small take-off card (the start of a flight); hides itself once flying, see the plugin. */
  showQuick(on) { this.quick.style.display = on ? 'block' : 'none'; }

  showDemoStatus(text) {
    this.demoStatus.textContent = text || '';
    this.demoStatus.style.display = text ? 'block' : 'none';
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
    this.credit.style.display = flying ? 'block' : 'none';
    this.easyButton.style.display = flying ? 'block' : 'none';
    this.controlsButton.style.display = flying ? 'block' : 'none';
    for (const id of ['exit', 'view', 'brake', 'reset']) if (this.buttons[id]) this.buttons[id].style.display = flying ? 'block' : 'none';
    if (!flying) { this.help.style.display = 'none'; this.quick.style.display = 'none'; this.showIntro(false); }
  }

  toggleHelp(show) {
    const on = show ?? this.help.style.display === 'none';
    this.help.style.display = on ? 'block' : 'none';
    if (on) this.quick.style.display = 'none';
    this.controlsButton.style.background = on ? 'rgba(196,30,42,0.85)' : 'rgba(12,13,16,0.66)';
  }

  destroy() {
    for (const el of [this.panelCanvas, this.prompt, this.message, this.help, this.quick, this.credit, this.easyButton, this.controlsButton,
      this.demoStatus, this.introTop, this.introBottom, this.introCard, this.introProgress, this.skipButton, ...Object.values(this.buttons)]) el.remove();
  }
}
