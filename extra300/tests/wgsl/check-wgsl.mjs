// check-wgsl.mjs — compile the plugin's WGSL with the browser's WebGPU (headless Chromium on
// SwiftShader): node tests/wgsl/check-wgsl.mjs. Prints the compiler's messages, exits 1 on errors.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../../scripts/serve.mjs';
import { toPlainWgsl } from './pcwgsl.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

// the engine's WGSL chunks, read out of its build (var <name>_default2 = `...`)
const engine = readFileSync(join(ROOT, 'node_modules/playcanvas/build/playcanvas.mjs'), 'utf8');
const chunk = (name) => {
  const base = name.replace(/PS$|VS$/, '');
  const m = engine.match(new RegExp(`var ${base}_default2 = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`no WGSL chunk ${name}`);
  return m[1];
};

// what to check: the clouds (pc globals stubbed: the module only reads pc when it builds)
globalThis.pc = new Proxy({}, { get: () => 0 });
const { CLOUD_SHADERS: S } = await import('../../src/plugin/clouds.js');
const { PLANE_SHADOW_SHADERS: P } = await import('../../src/plugin/planeShadow.js');
const shaders = [
  ['clouds march (vertex)', S.MARCH_VS_WGSL, 'vertex'],
  ['clouds march (fragment)', S.MARCH_FS_WGSL, 'fragment', 2],
  ['clouds shadow map (fragment)', S.SHADOW_FS_WGSL, 'fragment'],
  ['clouds composite (fragment)', S.COMP_FS_WGSL, 'fragment'],
  ['plane shadow depth (vertex)', P.DEPTH_VS_WGSL, 'vertex'],
  ['plane shadow depth (fragment)', P.DEPTH_FS_WGSL, 'fragment'],
];

const server = await serve(8762);
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] });
const page = await browser.newPage();
await page.goto('http://localhost:8762/tests/wgsl/check.html');
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
let failed = 0;
for (const [name, code, stage, outputs] of shaders) {
  const plain = toPlainWgsl(code, stage, chunk, outputs);
  const msgs = await page.evaluate((c) => window.compile(c), plain);
  const errors = msgs.filter((m) => m.startsWith('error'));
  console.log(`${errors.length ? 'FAIL' : 'ok  '} ${name}${msgs.length ? '\n  ' + msgs.join('\n  ') : ''}`);
  if (errors.length) failed++;
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
