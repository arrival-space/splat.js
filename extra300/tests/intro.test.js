// The boarding intro: shots that stay above the ground and outside the airplane, captions for each,
// and an engine that really starts in the first shot (the sim's own starter, not a fake).
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTRO_CARDS, INTRO_LENGTH, INTRO_SHOTS, INTRO_STARTER, INTROS, introAt } from '../src/render/intro.js';
import { Aircraft } from '../src/sim/aircraft.js';
import EXTRA from '../src/sim/aircraft/extra300l.js';
import { buildMeigs } from '../src/world/meigs.js';

test('the shots run back to back from 0 to the end, each with its caption', () => {
  let t = 0;
  for (const s of INTRO_SHOTS) {
    assert.equal(s.t0, t);
    assert.ok(s.t1 > s.t0);
    assert.ok(INTRO_CARDS[s.card], `card ${s.card}`);
    t = s.t1;
  }
  assert.equal(t, INTRO_LENGTH);
  assert.ok(INTRO_LENGTH > 15 && INTRO_LENGTH < 35);
  assert.equal(introAt(INTRO_LENGTH + 1).done, true);
});

test('the camera stays above the ground, out of the airplane, until it flies into the cockpit', () => {
  for (let t = 0; t < INTRO_LENGTH; t += 0.05) {
    const { eye } = introAt(t);
    const [x, y, z] = eye;
    // ground in body axes with the tail down: z ≈ 1.33 + 0.2 x
    assert.ok(z < 1.33 + 0.2 * x - 0.3, `t ${t.toFixed(2)}: eye ${eye.map((v) => v.toFixed(2))} near the ground`);
    const last = t > INTRO_LENGTH - 2;
    // a box round the fuselage (wings excepted: the eye never comes close to them)
    const inFuselage = x > -4.8 && x < 2.4 && Math.abs(y) < 0.55 && z > -0.8 && z < 0.65;
    if (!last) assert.ok(!inFuselage, `t ${t.toFixed(2)}: eye inside the fuselage`);
  }
  // and it ends exactly where the cockpit view begins
  assert.deepEqual(introAt(INTRO_LENGTH - 1e-6).eye.map((v) => +v.toFixed(3)), EXTRA.eye.map((v) => +v.toFixed(3)));
});

test('the film at load keeps Google\'s tiles out of the frame: the sky behind the airplane, or our runway under it', () => {
  const load = { ...INTROS.extra300l, ...INTROS.extra300l.load };
  let t = 0;
  for (const s of load.shots) {
    assert.equal(s.t0, t);
    assert.ok(INTRO_CARDS[s.card], `card ${s.card}`);
    t = s.t1;
  }
  assert.equal(t, load.length);
  const deg = 180 / Math.PI;
  for (let t = 0; t < load.length; t += 0.05) {
    const { eye, at, fov } = introAt(t, load);
    const [x, y, z] = eye;
    assert.ok(z < 1.33 + 0.2 * x - 0.4, `t ${t.toFixed(2)}: eye ${eye.map((v) => v.toFixed(2))} near the ground`);
    assert.ok(!(x > -4.8 && x < 2.4 && Math.abs(y) < 0.55 && z > -0.8 && z < 0.65), `t ${t.toFixed(2)}: eye inside the fuselage`);
    assert.ok(!(x > -1.3 && x < 1.3 && Math.abs(y) < 4.1 && z > -0.3 && z < 0.7), `t ${t.toFixed(2)}: eye in a wing`);
    // looking up past half the field of view, less the bottom letterbox's share (11 % of the height):
    // the horizon under the bar; or (over the wing) steeply down, onto the runway round the airplane
    const d = at.map((v, k) => v - eye[k]);
    const up = Math.atan2(-d[2], Math.hypot(d[0], d[1])) * deg;
    if (up > 0) assert.ok(up >= fov / 2 * 0.78 - 0.5, `t ${t.toFixed(2)}: looking up ${up.toFixed(1)}° in ${fov.toFixed(0)}°: the horizon in frame`);
    else assert.ok(-up > 55, `t ${t.toFixed(2)}: looking down ${(-up).toFixed(1)}°: past the runway's edge`);
  }
});

test('the first shot starts the engine with the starter: still, cranking, then running at idle', () => {
  const world = buildMeigs();
  const ac = new Aircraft(EXTRA, { ground: world.ground, datumMsl: world.elevation });
  const s = world.startPosition();
  ac.placeOnGround(s.n, s.e, s.heading);
  ac.engine.running = false;
  ac.rpm = 0;
  let t = 0, rpmBefore = 0, ranAt = null;
  for (; t < INTRO_SHOTS[0].t1; t += 1 / 60) {
    const c = ac.controls;
    c.throttle = 0; c.parkingBrake = true;
    c.starter = t > INTRO_STARTER[0] && t < INTRO_STARTER[1] && !ac.engine.running;
    ac.update(1 / 60);
    if (t < INTRO_STARTER[0]) rpmBefore = Math.max(rpmBefore, ac.rpm);
    if (ranAt == null && ac.engine.running) ranAt = t;
  }
  assert.ok(rpmBefore < 1, 'the prop stands still at first');
  assert.ok(ranAt != null && ranAt < INTRO_STARTER[1], `caught at ${ranAt}`);
  assert.ok(ac.rpm > 550 && ac.rpm < 1000, `idling at ${ac.rpm.toFixed(0)} rpm`);
});
