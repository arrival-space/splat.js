import assert from 'node:assert/strict';
import { featureStrideForCounts, siftWorkerCount } from '../../src/sfm/sfm.js';

assert.equal(featureStrideForCounts([3900, 7800]), 8192);
assert.equal(featureStrideForCounts([8192]), 16384);
assert.equal(featureStrideForCounts([12000, 15999]), 16384);

const imagesAt = (dim, count = 20) => Array.from({ length: count }, () => ({ fw: dim, fh: dim * 0.75 }));
assert.equal(siftWorkerCount(imagesAt(960), 16), 8);
assert.equal(siftWorkerCount(imagesAt(1280), 16), 6);
assert.equal(siftWorkerCount(imagesAt(1600), 16), 4);
assert.equal(siftWorkerCount(imagesAt(960), 16, 3), 3);
assert.equal(siftWorkerCount(imagesAt(2048), 16), 2);
assert.equal(siftWorkerCount(imagesAt(1600, 3), 16), 3);

console.log('adaptive feature stride and SIFT worker limits');
