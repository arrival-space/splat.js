// The whole thing, end to end: one Platzrunde at Meigs in the real world
// (the OSM land and lake). Takeoff from 36, right traffic over
// the lake, a loop on downwind flown by holding the pitch key, base, final,
// flare, three-point landing, stop on the runway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flyPattern } from './lib/flyPattern.js';

test('Platzrunde: takeoff, loop, landing — on the runway, nothing broken, nothing stalled', async () => {
  const r = await flyPattern();
  const phases = r.events.map((e) => e.phase);
  for (const p of ['climb', 'crosswind', 'downwind', 'loop', 'recover', 'base', 'final', 'flare', 'rollout', 'stopped']) {
    assert.ok(phases.includes(p), `never reached ${p} (got ${phases.join(' → ')})`);
  }
  assert.ok(!r.damage.propStrike && !r.damage.crashed, `damage ${JSON.stringify(r.damage)}`);
  assert.equal(r.stallBeforeFlare, 0, 'the wing never stalled between lift-off and the flare');
  // the loop: round, on line, not much height gained or lost
  assert.ok(r.loop.seconds > 7 && r.loop.seconds < 14, `loop ${r.loop.seconds} s`);
  assert.ok(Math.abs(r.loop.headingChange) < 10, `loop heading ${r.loop.headingChange}°`);
  assert.ok(Math.abs(r.loop.altChange) < 100, `loop height ${r.loop.altChange} m`);
  assert.ok(r.maxG < 7, `max ${r.maxG} g`);
  // the landing
  const td = r.touchdown;
  assert.equal(td.surface, 'asphalt');
  assert.ok(td.n > r.runway.thr36[0] && td.n < r.runway.thr36[0] + 400, `touchdown ${td.n - r.runway.thr36[0]} m past the threshold`);
  assert.ok(Math.abs(td.e) < 8, `touchdown ${td.e} m off the centreline`);
  assert.ok(td.kt < 72, `touchdown at ${td.kt} kt`);
  assert.ok(td.vs < 1.6, `sink rate at touchdown ${td.vs} m/s`);
  assert.equal(r.stop.surface, 'asphalt', 'stopped on the runway');
  assert.ok(Math.abs(r.stop.e) < 10);
});
