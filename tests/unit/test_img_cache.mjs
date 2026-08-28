import assert from 'node:assert/strict';

globalThis.screen = { width: 1280 };
globalThis.devicePixelRatio = 1;

let now = 1000;
let requests = 0;
const realNow = Date.now;
Date.now = () => now;
globalThis.fetch = async () => {
  requests++;
  return { ok: false, status: 404 };
};

try {
  const { bmp, readyBmp } = await import('../../app/js/img.js');
  const missing = '/data/truck/000001.jpg';

  assert.equal(await bmp(missing), null);
  for (let i = 0; i < 100; i++) assert.equal(readyBmp(missing), null);
  await Promise.resolve();
  assert.equal(requests, 1, 'a failed image must not be fetched every render frame');

  now += 30001;
  assert.equal(await bmp(missing), null);
  assert.equal(requests, 2, 'a transient failure may retry after the cooldown');
} finally {
  Date.now = realNow;
}

console.log('failed image requests use a bounded retry cooldown');
