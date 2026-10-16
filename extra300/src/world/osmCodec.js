// osmCodec.js — the compact binary the baked OpenStreetMap scenery travels in.
//
//   [u32 header length][header JSON][body]
//
// body: buildings, then polygon layers (land, water, parks), then line layers
// (roads, rail), then the land/water mask as run lengths. Coordinates are
// (east, north) metres in the Meigs local frame, quantised to QUANTUM and
// stored as zigzag varint deltas; each feature's first point is a delta from
// the previous feature's first point, so a spatially sorted list stays small.

export const QUANTUM = 0.25;     // m
export const MASK_CELL = 4;      // m

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 20); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v) { this.ensure(1); this.buf[this.len++] = v & 255; }
  uvar(v) {
    v = Math.max(0, Math.round(v));
    this.ensure(10);
    while (v >= 128) { this.buf[this.len++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.buf[this.len++] = v;
  }
  svar(v) { v = Math.round(v); this.uvar(v < 0 ? -2 * v - 1 : 2 * v); }
  bytes(u8) { this.ensure(u8.length); this.buf.set(u8, this.len); this.len += u8.length; }
  done() { return this.buf.slice(0, this.len); }
}

class Reader {
  constructor(u8, pos = 0) { this.u8 = u8; this.pos = pos; }
  byte() { return this.u8[this.pos++]; }
  uvar() {
    let v = 0, mul = 1, b;
    do { b = this.u8[this.pos++]; v += (b & 127) * mul; mul *= 128; } while (b & 128);
    return v;
  }
  svar() { const u = this.uvar(); return u % 2 ? -(u + 1) / 2 : u / 2; }
}

const q = (v) => Math.round(v / QUANTUM);

function writeRing(w, ring, prev) {
  w.uvar(ring.length);
  let px = prev[0], py = prev[1];
  for (const [x, y] of ring) {
    const qx = q(x), qy = q(y);
    w.svar(qx - px); w.svar(qy - py);
    px = qx; py = qy;
  }
  prev[0] = q(ring[0][0]); prev[1] = q(ring[0][1]);
}
function readRing(r, prev) {
  const n = r.uvar();
  const ring = new Array(n);
  let px = prev[0], py = prev[1];
  for (let i = 0; i < n; i++) {
    px += r.svar(); py += r.svar();
    ring[i] = [px * QUANTUM, py * QUANTUM];
    if (i === 0) { prev[0] = px; prev[1] = py; }
  }
  return ring;
}

/**
 * @param {{ header: object, buildings: object[], land: number[][][], water: number[][][], parks: number[][][],
 *           roads: {pts:number[][], w:number}[], rail: {pts:number[][], w:number}[], mask: {nx:number, ny:number, data:Uint8Array} }} d
 * @returns {Uint8Array}
 */
export function encodeOsm(d) {
  const styles = d.header.styles;
  const colours = [...new Set(d.buildings.map((b) => b.colour).filter(Boolean))];
  const names = d.buildings.filter((b) => b.name && b.h > 60).map((b) => b.name);
  const header = { ...d.header, colours, counts: { buildings: d.buildings.length } };
  const w = new Writer();
  const prev = [0, 0];
  w.uvar(d.buildings.length);
  for (const b of d.buildings) {
    w.byte(styles.indexOf(b.style) | ((b.roof & 7) << 4) | (b.holes.length ? 128 : 0));
    w.uvar(b.h * 10);
    w.uvar(b.minH * 10);
    w.uvar(b.year ? b.year - 1800 : 0);
    w.uvar(b.colour ? colours.indexOf(b.colour) + 1 : 0);
    w.uvar(b.name && b.h > 60 ? names.indexOf(b.name) + 1 : 0);
    writeRing(w, b.outer, prev);
    if (b.holes.length) {
      w.uvar(b.holes.length);
      const hp = prev.slice();
      for (const h of b.holes) writeRing(w, h, hp);
    }
  }
  for (const layer of [d.land, d.water, d.parks]) {
    w.uvar(layer.length);
    const lp = [0, 0];
    for (const poly of layer) writeRing(w, poly, lp);
  }
  for (const layer of [d.roads, d.rail]) {
    w.uvar(layer.length);
    const lp = [0, 0];
    for (const l of layer) { w.uvar(l.w * 2); writeRing(w, l.pts, lp); }
  }
  // mask as alternating run lengths, starting with water
  const m = d.mask;
  w.uvar(m.nx); w.uvar(m.ny);
  let cur = 0, run = 0;
  const runs = [];
  for (let i = 0; i < m.data.length; i++) {
    if (m.data[i] === cur) run++;
    else { runs.push(run); cur = m.data[i]; run = 1; }
  }
  runs.push(run);
  w.uvar(runs.length);
  for (const r of runs) w.uvar(r);

  const hj = new TextEncoder().encode(JSON.stringify({ ...header, names }));
  const out = new Writer();
  out.byte(hj.length & 255); out.byte((hj.length >> 8) & 255); out.byte((hj.length >> 16) & 255); out.byte((hj.length >> 24) & 255);
  out.bytes(hj);
  out.bytes(w.done());
  return out.done();
}

/** @param {Uint8Array} u8 */
export function decodeOsm(u8) {
  const hl = u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + hl)));
  const r = new Reader(u8, 4 + hl);
  const n = r.uvar();
  const buildings = new Array(n);
  const prev = [0, 0];
  for (let i = 0; i < n; i++) {
    const f = r.byte();
    const h = r.uvar() / 10;
    const minH = r.uvar() / 10;
    const y = r.uvar();
    const ci = r.uvar();
    const ni = r.uvar();
    const outer = readRing(r, prev);
    const holes = [];
    if (f & 128) {
      const k = r.uvar();
      const hp = prev.slice();
      for (let j = 0; j < k; j++) holes.push(readRing(r, hp));
    }
    buildings[i] = {
      style: header.styles[f & 15], roof: (f >> 4) & 7, h, minH, year: y ? y + 1800 : 0,
      colour: ci ? header.colours[ci - 1] : '', name: ni ? header.names[ni - 1] : '', outer, holes,
    };
  }
  const polys = () => { const k = r.uvar(); const lp = [0, 0]; const out = []; for (let i = 0; i < k; i++) out.push(readRing(r, lp)); return out; };
  const land = polys(), water = polys(), parks = polys();
  const lines = () => { const k = r.uvar(); const lp = [0, 0]; const out = []; for (let i = 0; i < k; i++) { const w = r.uvar() / 2; out.push({ w, pts: readRing(r, lp) }); } return out; };
  const roads = lines(), rail = lines();
  const nx = r.uvar(), ny = r.uvar();
  const data = new Uint8Array(nx * ny);
  const runs = r.uvar();
  let pos = 0, v = 0;
  for (let i = 0; i < runs; i++) { const len = r.uvar(); if (v) data.fill(1, pos, pos + len); pos += len; v ^= 1; }
  return { header, buildings, land, water, parks, roads, rail, mask: { nx, ny, data } };
}

/** base64(gzip(bytes)) → decoded scenery. Works in browsers and Node 18+. */
export async function inflateOsm(b64) {
  const bin = typeof atob === 'function' ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : new Uint8Array(Buffer.from(b64, 'base64'));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  const u8 = new Uint8Array(await new Response(stream).arrayBuffer());
  return decodeOsm(u8);
}

/** Land/water lookup from the mask: true if (e, n) is land. Outside the box: land west of it, lake east. */
export function maskLookup(mask, box) {
  return (e, n) => {
    const i = Math.floor((e - box.x0) / MASK_CELL), j = Math.floor((n - box.y0) / MASK_CELL);
    if (i < 0) return true;
    if (i >= mask.nx || j < 0 || j >= mask.ny) return false;
    return mask.data[j * mask.nx + i] === 1;
  };
}
