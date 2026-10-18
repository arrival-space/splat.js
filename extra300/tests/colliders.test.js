// The parked airplane's colliders (plugin/aircraftColliders.js): boxes from its own model, so a visitor
// can stand on the wing and not walk through the fuselage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { colliderBoxes } from '../src/plugin/aircraftColliders.js';
import { PROFILES } from '../src/plugin/profiles.js';
import { fromBody } from '../src/render/geometry.js';

const inside = (b, p) => [0, 1, 2].every((k) => Math.abs(p[k] - b.c[k]) <= b.h[k] + 1e-6);
const topAt = (boxes, x, z) => Math.max(-Infinity, ...boxes.filter((b) => Math.abs(x - b.c[0]) <= b.h[0] && Math.abs(z - b.c[2]) <= b.h[2]).map((b) => b.c[1] + b.h[1]));

test('the Extra: something to stand on mid-wing on both sides, thin there, and clear air a metre over it', () => {
  const boxes = colliderBoxes(PROFILES.extra300l.buildModel());
  for (const side of [-1, 1]) {
    const [x, , z] = fromBody([-0.3, side * 2.5, 0]);   // mid-chord, mid-span
    const top = topAt(boxes, x, z);
    assert.ok(Number.isFinite(top), `no wing under ${side > 0 ? 'right' : 'left'} mid-span`);
    assert.ok(!boxes.some((b) => inside(b, [x, top + 1, z])), 'a box a metre over the wing');
    // the wing's box is a slice, not the airplane's whole height
    const under = boxes.filter((b) => Math.abs(x - b.c[0]) <= b.h[0] && Math.abs(z - b.c[2]) <= b.h[2]);
    assert.ok(under.every((b) => b.h[1] < 0.4), `boxes ${under.map((b) => (2 * b.h[1]).toFixed(2)).join(', ')} m deep at mid-span`);
  }
  // the fuselage is solid beside the cockpit, and the prop's disc isn't a wall
  assert.ok(boxes.some((b) => inside(b, fromBody([-2.8, 0, 0]))), 'nothing in the rear fuselage');
  assert.ok(!boxes.some((b) => inside(b, fromBody([2.05, 0, -0.8]))), 'a box where the prop blades turn');
});

test('every airplane gets a sensible number of boxes', () => {
  for (const [id, p] of Object.entries(PROFILES)) {
    const n = colliderBoxes(p.buildModel()).length;
    assert.ok(n > 20 && n < 500, `${id}: ${n} boxes`);
  }
});
