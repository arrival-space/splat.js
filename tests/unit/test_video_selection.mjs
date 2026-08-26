import assert from 'node:assert/strict';
import {
  planVideoFrames, selectSharpFrameSamples, videoFrameDimensions, videoPipelineResolution,
} from '../../src/io/video.js';

const samples = Array.from({ length: 12 }, (_, i) => ({ t: i * 0.1, s: i + 1 }));
assert.deepEqual(
  selectSharpFrameSamples(samples, 3).map((sample) => Math.round(sample.t * 10) / 10),
  [0.3, 0.7, 1.1],
);

// A very sharp pause at the end must not crowd the earlier camera path out.
const paused = Array.from({ length: 12 }, (_, i) => ({
  t: i,
  s: i >= 8 ? 100 + i : i,
}));
assert.deepEqual(
  selectSharpFrameSamples(paused, 3).map((sample) => sample.t),
  [3, 7, 11],
);

assert.deepEqual(selectSharpFrameSamples([], 10), []);
assert.equal(selectSharpFrameSamples(samples, 99).length, samples.length);

assert.deepEqual(planVideoFrames(30, { mode: 'fps', fps: 3, count: 80 }), {
  mode: 'fps', fps: 3, count: 80, targetFrames: 90, capped: false, valid: true,
});
assert.deepEqual(planVideoFrames(120, { mode: 'fps', fps: 3 }), {
  mode: 'fps', fps: 3, count: 120, targetFrames: 200, capped: true, valid: true,
});
assert.equal(planVideoFrames(90, { mode: 'count', count: 150 }).targetFrames, 150);
assert.equal(planVideoFrames(2, { mode: 'fps', fps: 3 }).valid, false);
assert.deepEqual(videoFrameDimensions(3840, 2160, 1920), [1920, 1080]);
assert.deepEqual(videoFrameDimensions(2160, 3840, 1920), [1080, 1920]);
assert.deepEqual(videoFrameDimensions(1280, 720, 1920), [1280, 720]);
assert.deepEqual(videoFrameDimensions(3840, 2160, 0), [3840, 2160]);
assert.equal(videoPipelineResolution(1280, 720), 1280);
assert.equal(videoPipelineResolution(1920, 1080), 1600);
assert.equal(videoPipelineResolution(1080, 1920), 1600);
assert.equal(videoPipelineResolution(1024, 768), 1024);

console.log('coverage-aware video frame selection');
