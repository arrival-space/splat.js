// The deliverable: one ES module exporting one ArrivalScript class with a scriptName.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('build produces a self-contained vibe module', async () => {
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'pipe' });
  const file = join(root, 'dist', 'extra300-meigs.mjs');
  const src = readFileSync(file, 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'no imports left: Arrival loads a single file');
  // the baked OpenStreetMap city rides inside the bundle; keep it well under a few MB
  assert.ok(src.length < 4_000_000, `bundle size ${src.length}`);

  // load it the way the client does, with the globals it provides
  class Script { constructor() {} }
  globalThis.ArrivalScript = Script;
  globalThis.pc = {};
  const mod = await import(`${file}?t=${Date.now()}`);
  const classes = Object.values(mod).filter((v) => typeof v === 'function');
  assert.equal(classes.length, 1, 'exactly one export');
  const C = classes[0];
  assert.equal(C.scriptName, 'extra300Meigs');
  assert.ok(Object.getPrototypeOf(C) === Script, 'extends ArrivalScript');
  const inst = new C();
  for (const reserved of ['enabled', 'app', 'entity']) assert.ok(!Object.prototype.hasOwnProperty.call(inst, reserved), `reserved name ${reserved}`);
  for (const key of Object.keys(C.properties)) assert.ok(key in inst, `property ${key} has a default`);
});
