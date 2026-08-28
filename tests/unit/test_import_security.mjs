import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlyGaussians, parseState, unzipStore } from '../../app/js/session_io.js';

const enc = new TextEncoder();

function stateBytes({ n = 1, shK = 0, iter = 0, payload = true } = {}) {
  const head = enc.encode(JSON.stringify({ magic: 'splatjs-state', version: 1, n, shK, iter }));
  const body = payload ? new Uint8Array(n * (16 + shK * 3) * 4) : new Uint8Array();
  const out = new Uint8Array(4 + head.length + body.length);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  out.set(body, 4 + head.length);
  return out;
}

const props = [
  'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
];

function plyBytes(properties = props, bodyFloats = properties.length, comments = '') {
  const head = enc.encode('ply\nformat binary_little_endian 1.0\n' + comments +
    'element vertex 1\n' + properties.map((p) => `property float ${p}`).join('\n') +
    '\nend_header\n');
  const out = new Uint8Array(head.length + bodyFloats * 4);
  out.set(head);
  return out;
}

assert.equal(parseState(stateBytes()).gaussians.data.length, 16);
assert.throws(() => parseState(stateBytes({ payload: false })), /length/);
assert.throws(() => parseState(stateBytes({ n: Number.MAX_SAFE_INTEGER, payload: false })), /length/);

const model = parsePlyGaussians(plyBytes());
assert.equal(model.n, 1);
assert.ok([...model.data].every(Number.isFinite));

const longHeaderModel = parsePlyGaussians(plyBytes(props, props.length, `comment ${'x'.repeat(5000)}\n`));
assert.equal(longHeaderModel.n, 1);
assert.ok([...longHeaderModel.data].every(Number.isFinite));
assert.throws(() => parsePlyGaussians(plyBytes(props.filter((p) => p !== 'f_dc_1'))), /f_dc_1/);
assert.throws(() => parsePlyGaussians(plyBytes(props, props.length - 1)), /truncated/);

const zip = new Uint8Array(30);
const zdv = new DataView(zip.buffer);
zdv.setUint32(0, 0x04034b50, true);
zdv.setUint32(18, 4, true);
assert.throws(() => unzipStore(zip), /truncated/);

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, '../../app/js/app.js'), 'utf8');
const hud = app.slice(app.indexOf('function renderHud()'), app.indexOf('// ── screen wake lock'));
assert.ok(!hud.includes('innerHTML'));
assert.ok(hud.includes('chip.textContent = S.flash.msg'));
assert.ok(!app.includes('onclick="navigator.clipboard'));

console.log('IMPORT SECURITY TESTS PASSED');
