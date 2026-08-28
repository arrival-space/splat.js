import assert from 'node:assert/strict';
import {
  planVideoFrames, seekToDecodedVideoFrame, selectSharpFrameSamples, VIDEO_MAX_FRAMES,
  videoFrameDimensions, videoPipelineResolution,
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
  mode: 'fps', fps: 3, count: 120, targetFrames: 360, capped: false, valid: true,
});
assert.equal(planVideoFrames(90, { mode: 'count', count: 150 }).targetFrames, 150);
assert.equal(VIDEO_MAX_FRAMES, 500);
assert.deepEqual(planVideoFrames(600, { mode: 'fps', fps: 3 }), {
  mode: 'fps', fps: 3, count: 120, targetFrames: 500, capped: true, valid: true,
});
assert.deepEqual(planVideoFrames(90, { mode: 'count', count: 999 }), {
  mode: 'count', fps: 3, count: 500, targetFrames: 500, capped: true, valid: true,
});
assert.equal(planVideoFrames(2, { mode: 'fps', fps: 3 }).valid, false);
assert.deepEqual(videoFrameDimensions(3840, 2160, 1920), [1920, 1080]);
assert.deepEqual(videoFrameDimensions(2160, 3840, 1920), [1080, 1920]);
assert.deepEqual(videoFrameDimensions(1280, 720, 1920), [1280, 720]);
assert.deepEqual(videoFrameDimensions(3840, 2160, 0), [3840, 2160]);
assert.equal(videoPipelineResolution(1280, 720), 1280);
assert.equal(videoPipelineResolution(1920, 1080), 1600);
assert.equal(videoPipelineResolution(1080, 1920), 1600);
assert.equal(videoPipelineResolution(1024, 768), 1024);

// A video left at EOF may dispatch `seeked` before its newly decoded frame is
// available to canvas. Capture must wait for rVFC as well, or the final video
// frame can incorrectly become extracted frame 1.
class MockSeekVideo extends EventTarget {
  constructor() {
    super();
    this.ended = true;
    this.presented = 'last-frame';
    this.frameCallback = null;
  }

  requestVideoFrameCallback(callback) {
    this.frameCallback = callback;
    return 1;
  }

  set currentTime(time) {
    queueMicrotask(() => {
      this.dispatchEvent(new Event('seeked'));
      queueMicrotask(() => {
        this.presented = `frame-at-${time}`;
        this.frameCallback(0, { mediaTime: time });
      });
    });
  }
}

const mockVideo = new MockSeekVideo();
await seekToDecodedVideoFrame(mockVideo, 0.25);
assert.equal(mockVideo.presented, 'frame-at-0.25');

// Subsequent paused seeks must not depend on rVFC: Chromium can omit that
// callback after several seeks even though `seeked` continues normally.
class MockPausedSeekVideo extends EventTarget {
  constructor() {
    super();
    this.ended = false;
    this.frameCallbackRequests = 0;
  }

  requestVideoFrameCallback() {
    this.frameCallbackRequests++;
    return 1; // deliberately never invokes the callback
  }

  set currentTime(time) {
    this.time = time;
    queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
  }
}

const pausedVideo = new MockPausedSeekVideo();
await seekToDecodedVideoFrame(pausedVideo, 1.25);
assert.equal(pausedVideo.time, 1.25);
assert.equal(pausedVideo.frameCallbackRequests, 0);

console.log('coverage-aware video frame selection');
