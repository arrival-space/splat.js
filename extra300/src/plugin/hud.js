// hud.js — the DOM side: the instrument panel canvas (the Extra) or the
// head-up display (the F-15), the boarding prompt, the keyboard card, status
// messages, the top bar (airplane, easy mode, controls) and touch buttons on
// phones. The words on the cards are the airplane's (plugin/profiles.js).

import { Panel } from '../instruments/panel.js';
import { JetHud } from '../instruments/jetHud.js';

export const CREDIT = 'Map data © OpenStreetMap contributors (ODbL) · City of Chicago';

export class Hud {
  /**
   * @param {HTMLElement} container  the script's UI container (click-through: pointer-events none)
   * @param {(tag: string, opts: object) => HTMLElement} createUI  the plugin API's createUI: the only way to
   *   get an element the pointer can reach — it sets pointer-events:auto and pauses the game's mouse
   *   capture while hovered, so the click lands on the button instead of the camera
   */
  constructor(container, profile, isMobile, createUI) {
    this.container = container;
    this.isMobile = isMobile;
    this.createUI = createUI;
    const css = (el, s) => Object.assign(el.style, s);

    this.panelCanvas = document.createElement('canvas');
    css(this.panelCanvas, { position: 'fixed', left: '50%', bottom: '4px', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 20, display: 'none' });
    container.appendChild(this.panelCanvas);
    this.panel = new Panel(this.panelCanvas, profile.spec.limits);
    // the throttle lever, dragged with the mouse (or a finger): over its slot on the panel, which
    // stays click-through everywhere else; onThrottle(0..1) hands the setting to the plugin
    this.onThrottle = null;
    this.throttleGrip = document.createElement('div');
    css(this.throttleGrip, { position: 'fixed', zIndex: 21, display: 'none', cursor: 'ns-resize', touchAction: 'none', pointerEvents: 'auto' });
    container.appendChild(this.throttleGrip);
    const setFrom = (ev) => {
      const sl = this._slot, top = this.throttleGrip.getBoundingClientRect().top;
      if (!sl) return;
      this.onThrottle?.(Math.max(0, Math.min(1, 1 - (ev.clientY - top - (sl.top - sl.plate.y)) / sl.travel)));
    };
    this.throttleGrip.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      this.throttleGrip.setPointerCapture?.(ev.pointerId);
      this._dragging = true;
      setFrom(ev);
    });
    this.throttleGrip.addEventListener('pointermove', (ev) => { if (this._dragging) { ev.stopPropagation(); setFrom(ev); } });
    const end = (ev) => { this._dragging = false; this.throttleGrip.releasePointerCapture?.(ev.pointerId); };
    this.throttleGrip.addEventListener('pointerup', end);
    this.throttleGrip.addEventListener('pointercancel', end);
    // the ENGINE OFF lamp, clicked: onEngineOff() (the engine stopped, the throttle closed)
    this.onEngineOff = null;
    this.engineButton = document.createElement('div');
    css(this.engineButton, { position: 'fixed', zIndex: 21, display: 'none', cursor: 'pointer', pointerEvents: 'auto' });
    this.engineButton.title = 'Switch the engine off (raise the throttle to start it again)';
    this.engineButton.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); ev.preventDefault(); this.onEngineOff?.(); });
    container.appendChild(this.engineButton);
    // the jet's head-up display: the whole view, click-through
    this.hudCanvas = document.createElement('canvas');
    css(this.hudCanvas, { position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 19, display: 'none' });
    container.appendChild(this.hudCanvas);
    this.jetHud = new JetHud(this.hudCanvas);

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
    container.appendChild(this.help);

    // what a new pilot needs, and nothing else: shown at the start, gone once the airplane is flying
    this.quick = document.createElement('div');
    css(this.quick, {
      position: 'fixed', left: '16px', top: '58px', padding: '10px 14px', maxWidth: '330px',
      background: 'rgba(12,13,16,0.78)', color: '#ece9e1', font: '13px/1.6 "Helvetica Neue", Arial, sans-serif',
      borderRadius: '10px', zIndex: 22, display: 'none', pointerEvents: 'none', boxShadow: '0 6px 24px rgba(0,0,0,0.3)',
    });
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
    // the top bar: which airplane, easy mode (switchable any time in flight) and the controls card
    const pill = {
      top: '12px', height: '34px', padding: '0 10px', borderRadius: '17px', display: 'none',
      border: '1px solid rgba(255,255,255,0.22)', color: '#f4f2ec', background: 'rgba(12,13,16,0.66)',
      font: `600 ${isMobile ? 12 : 13}px "Helvetica Neue", Arial, sans-serif`, boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
      backdropFilter: 'blur(6px)', whiteSpace: 'nowrap', textAlign: 'center', overflow: 'hidden',
    };
    const [wA, wE, wC, wD, wW] = isMobile ? [118, 118, 80, 108, 92] : [146, 132, 92, 126, 106];
    const x0 = -(wA + wE + wC + wD + wW + 32) / 2;
    this.aircraftButton = button({ ...pill, width: `${wA}px`, left: `calc(50% + ${x0}px)` });
    this.easyButton = button({ ...pill, width: `${wE}px`, left: `calc(50% + ${x0 + wA + 8}px)` });
    this.controlsButton = button({ ...pill, width: `${wC}px`, left: `calc(50% + ${x0 + wA + wE + 16}px)` });
    // where to fly: a dropdown of the airports (in the airplane and out of it)
    this.placeButton = button({ ...pill, width: `${wD}px`, left: `calc(50% + ${x0 + wA + wE + wC + 24}px)`, display: 'block' });
    this.setPlace('Chicago');
    // the weather: sliders in a dropdown (setSliders)
    this.weatherButton = button({ ...pill, width: `${wW}px`, left: `calc(50% + ${x0 + wA + wE + wC + wD + 32}px)`, display: 'block' });
    this.weatherButton.innerHTML = '<span style="opacity:0.8;margin-right:5px">☁</span>Weather<span style="opacity:0.6;margin-left:5px">▾</span>';
    this.weatherButton.title = 'Clouds, time of day, season, temperature';
    // the airplane and place buttons open dropdowns (setMenu): one at a time, closed by a pick, a
    // click anywhere else or Esc
    this._menu = createUI('div', { interactive: true, lockKeyboard: false });
    css(this._menu, {
      position: 'fixed', top: '52px', zIndex: 1001, display: 'none', minWidth: '210px', padding: '6px',
      borderRadius: '12px', background: 'rgba(12,13,16,0.9)', border: '1px solid rgba(255,255,255,0.18)',
      boxShadow: '0 8px 28px rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', pointerEvents: 'auto',
      font: `600 ${isMobile ? 13 : 14}px "Helvetica Neue", Arial, sans-serif`, color: '#f4f2ec',
    });
    this._menus = {};
    this._menuOpen = null;
    this._onOutside = (e) => {
      if (!this._menuOpen || this._menu.contains(e.target) || e.target === this._menus[this._menuOpen]?.button) return;
      this.closeMenu();
    };
    this._onMenuKey = (e) => { if (e.key === 'Escape' && this._menuOpen) this.closeMenu(); };
    window.addEventListener('pointerdown', this._onOutside, true);
    window.addEventListener('keydown', this._onMenuKey, true);
    this.controlsButton.innerHTML = 'Controls';
    this.controlsButton.title = 'All the keys (H)';
    this.setProfile(profile);
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
      mk('board', `Fly the ${profile.title}`, { left: '50%', bottom: '26%', transform: 'translateX(-50%)', display: 'none' });
      mk('exit', 'Exit', { right: '12px', top: '22%' });
      mk('view', 'View', { right: '12px', top: 'calc(22% + 48px)' });
      mk('brake', 'Brake', { right: '12px', top: 'calc(42% + 56px)' });
      mk('reset', 'Reset', { right: '12px', top: 'calc(42% + 104px)' });
      mk('fire', 'Fire', { right: '12px', top: 'calc(42% + 8px)', background: 'rgba(196,40,30,0.75)' });
    }
    this.layout();
  }

  /** The place button names where we are (or are going, busy), its dropdown the others. */
  setPlace(here, busy = false) {
    this.placeButton.innerHTML = `<span style="opacity:0.75;margin-right:5px">${busy ? '…' : '✈'}</span>${here}<span style="opacity:0.6;margin-left:5px">▾</span>`;
    this.placeButton.title = 'Where to fly';
  }

  /**
   * A dropdown on one of the top bar's buttons.
   * @param {'aircraft'|'place'} key
   * @param {{ id: string, title: string }[] | (() => { id: string, title: string }[])} items  (a function: listed as it is when opened)
   * @param {() => string} current  the id that is in use now (marked)
   * @param {(id: string) => void} pick
   * @param {{ placeholder: string, find: (q: string, more: boolean) => Promise<{ title: string, sub?: string, go?: () => void }[]>,
   *           focus?: () => void, blur?: () => void }} [search]  a box above the list: what's typed, found (`more`: after a
   *        pause in the typing, the slower search may be tried too)
   */
  setMenu(key, items, current, pick, search = null) {
    const button = key === 'aircraft' ? this.aircraftButton : this.placeButton;
    this._menus[key] = { button, items, current, pick, search };
    button.onclick = (ev) => { ev.stopPropagation(); this._menuOpen === key ? this.closeMenu() : this.openMenu(key); };
  }

  /**
   * A dropdown of sliders on a top bar button (the weather).
   * @param {'weather'} key
   * @param {{ key: string, label: string, min: number, max: number, step: number, value: () => number,
   *           format: (v: number) => string }[]} fields
   * @param {(key: string, value: number) => void} change  as a slider moves
   */
  setSliders(key, fields, change) {
    const button = this.weatherButton;
    this._menus[key] = { button, fields, change };
    button.onclick = (ev) => { ev.stopPropagation(); this._menuOpen === key ? this.closeMenu() : this.openMenu(key); };
  }

  _sliders(m) {
    // one look in every browser: Firefox draws its own grey slider unless the parts are styled for it too
    if (!document.getElementById('extra300-range')) {
      const st = document.createElement('style');
      st.id = 'extra300-range';
      const track = 'height:4px;border-radius:2px;background:rgba(255,255,255,0.22);border:none';
      const thumb = 'width:16px;height:16px;border-radius:50%;background:#c41e2a;border:2px solid #f4f2ec;box-shadow:0 1px 4px rgba(0,0,0,0.5);cursor:pointer';
      st.textContent = `
input.extra300-range{-webkit-appearance:none;appearance:none;width:100%;height:18px;margin:0;background:transparent;cursor:pointer}
input.extra300-range:focus{outline:none}
input.extra300-range::-webkit-slider-runnable-track{${track}}
input.extra300-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;margin-top:-6px;${thumb}}
input.extra300-range::-moz-range-track{${track}}
input.extra300-range::-moz-range-progress{height:4px;border-radius:2px;background:#c41e2a}
input.extra300-range::-moz-range-thumb{${thumb}}`;
      document.head.appendChild(st);
    }
    for (const f of m.fields) {
      const row = document.createElement('div');
      Object.assign(row.style, { padding: '8px 10px 6px', width: '240px' });
      const head = document.createElement('div');
      Object.assign(head.style, { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' });
      const name = document.createElement('span'), val = document.createElement('span');
      name.textContent = f.label;
      Object.assign(val.style, { color: '#ff8a90', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', marginLeft: '12px' });
      head.append(name, val);
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: f.min, max: f.max, step: f.step });
      input.value = String(f.value());
      input.className = 'extra300-range';
      // the filled part, left of the thumb (Chrome and Safari have no part for it: a gradient behind)
      const fill = () => {
        const pct = ((Number(input.value) - f.min) / (f.max - f.min)) * 100;
        input.style.background = `linear-gradient(to right, #c41e2a ${pct}%, transparent ${pct}%) center / 100% 4px no-repeat`;
      };
      fill();
      val.textContent = f.format(Number(input.value));
      input.oninput = () => { const v = Number(input.value); val.textContent = f.format(v); fill(); m.change(f.key, v); };
      // let go, the keys fly the airplane again (a focused slider would take the arrows)
      input.onpointerup = () => input.blur();
      input.onchange = () => input.blur();
      row.append(head, input);
      this._menu.appendChild(row);
    }
  }

  openMenu(key) {
    const m = this._menus[key];
    if (!m) return;
    this._menuOpen = key;
    this._menu.innerHTML = '';
    if (m.fields) {
      this._sliders(m);
      this._menu.style.display = 'block';
      this._placeMenu(m);
      return;
    }
    const now = m.current();
    if (m.search) this._searchBox(m);
    for (const it of typeof m.items === 'function' ? m.items() : m.items) {
      const row = document.createElement('div');
      const on = it.id === now;
      row.innerHTML = `<span style="display:inline-block;width:18px;color:#ff5a64">${on ? '✓' : ''}</span>${it.title}`;
      Object.assign(row.style, {
        padding: '8px 12px 8px 8px', borderRadius: '8px', cursor: 'pointer', whiteSpace: 'nowrap',
        background: on ? 'rgba(196,30,42,0.28)' : 'transparent',
      });
      row.onpointerenter = () => { if (!on) row.style.background = 'rgba(255,255,255,0.08)'; };
      row.onpointerleave = () => { if (!on) row.style.background = 'transparent'; };
      row.onclick = (ev) => { ev.stopPropagation(); this.closeMenu(); if (!on) m.pick(it.id); };
      this._menu.appendChild(row);
    }
    this._menu.style.display = 'block';
    this._placeMenu(m);
  }

  /** Under its button, kept on the screen (again as it grows: a search's results widen it). */
  _placeMenu(m) {
    const r = m.button.getBoundingClientRect();
    const w = this._menu.offsetWidth;
    this._menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
    this._menu.style.top = `${r.bottom + 6}px`;
  }

  closeMenu() {
    if (this._menuOpen && this._menus[this._menuOpen]?.search && this._menu.contains(document.activeElement)) document.activeElement.blur();
    this._menuOpen = null;
    this._menu.style.display = 'none';
  }

  /** The search box at a dropdown's top, and what it finds under it (each found row goes there). */
  _searchBox(m) {
    const box = document.createElement('input');
    box.type = 'text';
    box.placeholder = m.search.placeholder;
    Object.assign(box.style, {
      display: 'block', boxSizing: 'border-box', width: '100%', margin: '2px 0 6px', padding: '8px 10px', borderRadius: '8px',
      border: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.08)', color: '#f4f2ec', font: 'inherit', outline: 'none',
    });
    const found = document.createElement('div');
    this._menu.appendChild(box);
    this._menu.appendChild(found);
    let seq = 0, idle = null;
    const show = (rows, note = '') => {
      found.innerHTML = '';
      if (note) {
        const n = document.createElement('div');
        n.textContent = note;
        Object.assign(n.style, { padding: '6px 10px', opacity: '0.65', fontWeight: '500' });
        found.appendChild(n);
      }
      for (const r of rows) {
        const row = document.createElement('div');
        row.innerHTML = `<div>${r.title}</div>${r.sub ? `<div style="font-weight:500;font-size:12px;opacity:0.65;margin-top:1px">${r.sub}</div>` : ''}`;
        Object.assign(row.style, { padding: '7px 10px', borderRadius: '8px', cursor: r.go ? 'pointer' : 'default', whiteSpace: 'nowrap', maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis' });
        if (r.go) {
          row.onpointerenter = () => { row.style.background = 'rgba(255,255,255,0.08)'; };
          row.onpointerleave = () => { row.style.background = 'transparent'; };
          row.onclick = (ev) => { ev.stopPropagation(); this.closeMenu(); r.go(); };
        }
        found.appendChild(row);
      }
      if (rows.length || note) found.appendChild(Object.assign(document.createElement('div'), { style: 'height:1px;margin:6px 4px;background:rgba(255,255,255,0.12)' }));
      this._placeMenu(m);
    };
    const run = async (more) => {
      const q = box.value.trim(), my = ++seq;
      if (q.length < 2) { show([]); return; }
      if (!more) show([], 'Searching…');
      let rows;
      try { rows = await m.search.find(q, more); } catch { rows = null; }
      if (my !== seq) return;   // typed on since
      if (!rows) show([], 'The airfields could not be fetched');
      else show(rows, rows.length ? '' : more ? 'Nothing found' : 'Searching places…');
      if (!more && rows && rows.length < 3) { clearTimeout(idle); idle = setTimeout(() => { if (my === seq) run(true); }, 700); }
    };
    let typing = null;
    box.oninput = () => { clearTimeout(typing); clearTimeout(idle); typing = setTimeout(() => run(false), 220); };
    box.onkeydown = (e) => {
      e.stopPropagation();   // the airplane's keys and the space's stay out of the box
      if (e.key === 'Enter') { clearTimeout(typing); clearTimeout(idle); run(true).then(() => found.querySelector('div[style*="pointer"]')?.click()); }
      if (e.key === 'Escape') this.closeMenu();
    };
    box.onkeyup = (e) => e.stopPropagation();
    box.onfocus = () => m.search.focus?.();
    box.onblur = () => m.search.blur?.();
    box.onpointerdown = (e) => e.stopPropagation();
    setTimeout(() => box.focus(), 0);
  }

  /** The map data's credit line, for the place on screen. */
  setCredit(text) { this.credit.textContent = text; }

  /** Another airplane: its cards, its cockpit display, its name on the top bar. */
  setProfile(p, next = null) {
    this.profile = p;
    const isMobile = this.isMobile;
    this.help.innerHTML = `<div style="font-weight:700;margin-bottom:6px">${p.title} — controls</div>`
      // the double spaces in the help separate key groups; HTML would collapse them
      + p.help.map(([a, b]) => `<div><span style="display:inline-block;width:92px;color:#9d9a92">${a}</span>${b.replace(/ {2,}/g, ' <span style="color:#6f6c66">·</span> ')}</div>`).join('')
      + `<div style="margin-top:8px;color:#9d9a92">H or Controls hides this card.</div>`
      + `<div style="margin-top:4px;color:#9d9a92;font-size:11px">${CREDIT}</div>`;
    this.quick.innerHTML = `<div style="font:700 11px 'Helvetica Neue',Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:#e0505a;margin-bottom:4px">Take off · ${p.title}</div>`
      + (isMobile ? p.quickMobile : p.quick).map((t) => `<div>${t}</div>`).join('')
      + (isMobile ? `<div style="margin-top:6px;color:#9d9a92;font-size:12px">Easy mode is on: ${p.easyOn.replace(/^Easy mode: /, '')}</div>`
        : `<div style="margin-top:6px;color:#9d9a92;font-size:12px">Everything else: <b>Controls</b> (or H)</div>`);
    this.aircraftButton.innerHTML = `${p.title}<span style="opacity:0.6;margin-left:5px">▾</span>`;
    this.aircraftButton.title = 'Which airplane (T: the next)';
    this.panel.limits = p.spec.limits;
    this.setEasy(this._easy ?? false);
    // (from the constructor, the rest of the DOM isn't built yet)
    if (this.buttons) {
      if (this.buttons.board) this.buttons.board.textContent = `Fly the ${p.title}`;
      this.setFlying(this._flying ?? false, this._panelVisible ?? false);
    }
  }

  layout() {
    this.jetHud.resize(window.innerWidth, window.innerHeight, Math.min(2, window.devicePixelRatio || 1));
    // the cluster is only as wide as its instruments, centred on the bottom edge
    let h = Math.round(Math.min(window.innerHeight * 0.21, 175));
    let w = Panel.widthFor(Panel.radiusFor(h));
    const maxW = window.innerWidth - 16;
    if (w > maxW) { h = Math.floor(h * (maxW / w)); w = Panel.widthFor(Panel.radiusFor(h)); }
    this.panel.resize(Math.ceil(w), h, Math.min(2, window.devicePixelRatio || 1));
    this.panelHeight = h;
    // the throttle grip over the lever's plate (the panel: centred, 4 px off the bottom)
    const sl = this._slot = Panel.throttleSlot(h), px = (window.innerWidth - Math.ceil(w)) / 2, py = window.innerHeight - 4 - h;
    Object.assign(this.throttleGrip.style, {
      left: `${px + sl.plate.x}px`, top: `${py + sl.plate.y}px`, width: `${sl.plate.w}px`, height: `${sl.plate.h}px`,
    });
    const eb = Panel.engineLamp(h);
    Object.assign(this.engineButton.style, { left: `${px + eb.x}px`, top: `${py + eb.y}px`, width: `${eb.w}px`, height: `${eb.h}px` });
  }

  /** The throttle grip and the engine button show with the panel. */
  _syncGrip() { this.throttleGrip.style.display = this.engineButton.style.display = this.panelCanvas.style.display; }

  showPrompt(text) {
    this.prompt.textContent = text || '';
    this.prompt.style.display = text ? 'block' : 'none';
    if (this.buttons.board) this.buttons.board.style.display = text ? 'block' : 'none';
  }

  /** Easy-mode switch: what it is now, and what a click does. */
  setEasy(on) {
    this._easy = on;
    const knob = `<span style="display:inline-block;vertical-align:-3px;width:28px;height:16px;border-radius:8px;margin-right:8px;`
      + `background:${on ? '#2fa35a' : 'rgba(255,255,255,0.25)'};position:relative">`
      + `<span style="position:absolute;top:2px;left:${on ? 14 : 2}px;width:12px;height:12px;border-radius:6px;background:#fff"></span></span>`;
    this.easyButton.innerHTML = `${knob}Easy mode`;
    this.easyButton.title = on
      ? `${this.profile.easyOn}. Click (or L) for the real thing`
      : this.profile.easyTitle;
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
    // the film at load opens out of black
    this.introFade = document.createElement('div');
    css(this.introFade, { position: 'fixed', inset: 0, background: '#000', zIndex: 29, pointerEvents: 'none', display: 'none', opacity: 0 });
    container.appendChild(this.introFade);
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
    if (!on) this.setIntroFade(0);
    this._introCardShown = -1;
    if (on) { this.panelCanvas.style.display = 'none'; this._syncGrip(); this.hudCanvas.style.display = 'none'; this.quick.style.display = 'none'; this.help.style.display = 'none'; }
    for (const b of [this.aircraftButton, this.easyButton, this.controlsButton, this.placeButton, this.weatherButton]) b.style.display = on ? 'none' : b.style.display;
  }

  /** Black over the scene (0 none … 1 all), under the letterbox and the captions. */
  setIntroFade(a) {
    this.introFade.style.display = a > 0 ? 'block' : 'none';
    this.introFade.style.opacity = a.toFixed(3);
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
    this._flying = flying;
    this._panelVisible = panelVisible;
    const hud = this.profile.display === 'hud';
    this.panelCanvas.style.display = flying && panelVisible && !hud ? 'block' : 'none';
    this._syncGrip();
    this.hudCanvas.style.display = flying && panelVisible && hud ? 'block' : 'none';
    this.credit.style.display = flying ? 'block' : 'none';
    this.aircraftButton.style.display = 'block';   // which airplane: on foot as well, before boarding
    this.easyButton.style.display = flying ? 'block' : 'none';
    this.controlsButton.style.display = flying ? 'block' : 'none';
    this.placeButton.style.display = 'block';
    this.weatherButton.style.display = 'block';
    for (const id of ['exit', 'view', 'brake', 'reset']) if (this.buttons[id]) this.buttons[id].style.display = flying ? 'block' : 'none';
    if (this.buttons.fire) this.buttons.fire.style.display = flying && this.profile.lasers ? 'block' : 'none';
    if (!flying) { this.help.style.display = 'none'; this.quick.style.display = 'none'; this.showIntro(false); }
  }

  toggleHelp(show) {
    const on = show ?? this.help.style.display === 'none';
    this.help.style.display = on ? 'block' : 'none';
    if (on) this.quick.style.display = 'none';
    this.controlsButton.style.background = on ? 'rgba(196,30,42,0.85)' : 'rgba(12,13,16,0.66)';
  }

  destroy() {
    window.removeEventListener('pointerdown', this._onOutside, true);
    window.removeEventListener('keydown', this._onMenuKey, true);
    this._menu.remove();
    for (const el of [this.panelCanvas, this.throttleGrip, this.engineButton, this.hudCanvas, this.prompt, this.message, this.help, this.quick, this.credit, this.aircraftButton, this.easyButton, this.controlsButton, this.placeButton, this.weatherButton,
      this.demoStatus, this.introTop, this.introBottom, this.introCard, this.introProgress, this.introFade, this.skipButton, ...Object.values(this.buttons)]) el.remove();
  }
}
