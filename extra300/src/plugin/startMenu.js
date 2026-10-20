// startMenu.js — the first thing on screen: where to fly and what in. Nothing heavy loads before both
// are picked (the city, the airport's ground, Google's tiles); picking the second one starts.

const css = (el, s) => Object.assign(el.style, s);
const FONT = "'Helvetica Neue', Arial, sans-serif";   // single quotes: it goes inside style="…" too
const ACCENT = '#3fc5cc';

export class StartMenu {
  /**
   * @param {(tag: string, opts: object) => HTMLElement} createUI  the plugin API's: an element the pointer reaches
   * @param {{ id: string, title: string, blurb: string }[]} places
   * @param {{ id: string, title: string, blurb: string }[]} aircraft
   * @param {{ place?: string|null, aircraft?: string|null, isMobile?: boolean, onStart: (place: string, aircraft: string) => void }} o
   *        place / aircraft: already chosen (the address named one)
   */
  constructor(createUI, places, aircraft, o) {
    this.onStart = o.onStart;
    this.choice = { place: o.place || null, aircraft: o.aircraft || null };
    const narrow = o.isMobile || window.innerWidth < 640;
    this.root = createUI('div', { interactive: true, lockKeyboard: false });
    css(this.root, {
      position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 1001,
      width: `min(${narrow ? 420 : 760}px, calc(100vw - 24px))`, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
      boxSizing: 'border-box', padding: narrow ? '16px 14px' : '22px 24px', borderRadius: '14px',
      background: 'rgba(12,13,16,0.88)', color: '#f1efe8', font: `14px/1.4 ${FONT}`,
      boxShadow: '0 12px 40px rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', pointerEvents: 'auto',
    });
    const head = document.createElement('div');
    head.innerHTML = `<div style="font:700 12px ${FONT};letter-spacing:0.22em;text-transform:uppercase;color:#6fdcdc">Flight</div>`
      + `<div style="font:700 ${narrow ? 20 : 24}px ${FONT};margin:4px 0 2px">Where, and in what?</div>`
      + '<div style="opacity:0.65;font-size:13px">Pick an airport and an airplane: the flight starts with the second.</div>';
    this.root.appendChild(head);
    this.cards = { place: new Map(), aircraft: new Map() };
    this._group('Airport', 'place', places, narrow);
    this._group('Airplane', 'aircraft', aircraft, narrow);
    this.status = document.createElement('div');
    css(this.status, { marginTop: '12px', minHeight: '16px', font: `600 13px ${FONT}`, color: '#7fe3e0' });
    this.root.appendChild(this.status);
    this._refresh();
  }

  _group(label, key, items, narrow) {
    const t = document.createElement('div');
    t.textContent = label;
    css(t, { margin: '16px 0 8px', font: `700 11px ${FONT}`, letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.7 });
    this.root.appendChild(t);
    const row = document.createElement('div');
    css(row, { display: 'grid', gap: '8px', gridTemplateColumns: `repeat(${narrow ? 1 : items.length}, minmax(0, 1fr))` });
    for (const it of items) {
      const b = document.createElement('button');
      b.innerHTML = `<div style="font:700 14px ${FONT}">${it.title}</div><div style="font:12px/1.35 ${FONT};opacity:0.7;margin-top:3px">${it.blurb}</div>`;
      css(b, {
        textAlign: 'left', padding: '10px 12px', borderRadius: '9px', cursor: 'pointer', color: '#f1efe8',
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.16)', transition: 'background 0.12s, border-color 0.12s',
      });
      b.onclick = (ev) => { ev.stopPropagation(); this._pick(key, it.id); };
      row.appendChild(b);
      this.cards[key].set(it.id, b);
    }
    this.root.appendChild(row);
  }

  _pick(key, id) {
    if (this.started) return;
    this.choice[key] = id;
    this._refresh();
    if (this.choice.place && this.choice.aircraft) {
      this.started = true;
      this.onStart(this.choice.place, this.choice.aircraft);
    }
  }

  _refresh() {
    for (const key of ['place', 'aircraft']) {
      for (const [id, b] of this.cards[key]) {
        const on = this.choice[key] === id;
        b.style.background = on ? 'rgba(63,197,204,0.28)' : 'rgba(255,255,255,0.06)';
        b.style.borderColor = on ? ACCENT : 'rgba(255,255,255,0.16)';
      }
    }
  }

  /** While the chosen place loads. */
  setStatus(text) { this.status.textContent = text; }

  destroy() { this.root.remove(); }
}
