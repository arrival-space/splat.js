// The boarding intro: shots that stay above the ground and outside the airplane, captions for each,
// and an engine that really starts in the first shot (the sim's own starter, not a fake).
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTRO_CARDS, INTRO_LENGTH, INTRO_SHOTS, INTRO_STARTER, INTROS, introAt, framedFov, framedTilt } from '../src/render/intro.js';
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

test('the film at load keeps Google\'s tiles out of the frame: our runway behind the airplane, once the sky', () => {
  const load = { ...INTROS.extra300l, ...INTROS.extra300l.load };
  let t = 0;
  for (const s of load.shots) {
    assert.equal(s.t0, t);
    assert.ok(INTRO_CARDS[s.card], `card ${s.card}`);
    t = s.t1;
  }
  assert.equal(t, load.length);
  const deg = 180 / Math.PI;
  const skyShots = new Set();
  for (let t = 0; t < load.length; t += 0.05) {
    const { eye, at, fov } = introAt(t, load);
    const [x, y, z] = eye;
    assert.ok(z < 1.33 + 0.2 * x - 0.4, `t ${t.toFixed(2)}: eye ${eye.map((v) => v.toFixed(2))} near the ground`);
    assert.ok(!(x > -4.8 && x < 2.4 && Math.abs(y) < 0.55 && z > -0.8 && z < 0.65), `t ${t.toFixed(2)}: eye inside the fuselage`);
    assert.ok(!(x > -1.3 && x < 1.3 && Math.abs(y) < 4.1 && z > -0.3 && z < 0.7), `t ${t.toFixed(2)}: eye in a wing`);
    // the airplane the middle of the frame: aimed at a point on it
    assert.ok(at[0] > -6.5 && at[0] < 3 && Math.abs(at[1]) < 4.2 && at[2] > -1.7 && at[2] < 1.3, `t ${t.toFixed(2)}: aimed off the airplane`);
    // the horizon out of the frame (or under a letterbox bar, 11 % of the height): looking down past
    // the top edge (the runway behind), or once, up past the bottom edge (the sky behind)
    const d = at.map((v, k) => v - eye[k]);
    const up = Math.atan2(-d[2], Math.hypot(d[0], d[1])) * deg;
    assert.ok(Math.abs(up) >= fov / 2 * 0.78 - 0.5, `t ${t.toFixed(2)}: looking ${up.toFixed(1)}° in ${fov.toFixed(0)}°: the horizon in frame`);
    if (up > 0) skyShots.add(load.shots.findIndex((s) => t < s.t1));
  }
  assert.equal(skyShots.size, 1, 'one shot against the sky');
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

test('framing: on a narrower screen the view opens up until it is as wide as framed (a phone upright)', () => {
  const hfov = (v, a) => (2 * Math.atan(Math.tan((v * Math.PI) / 360) * a) * 180) / Math.PI;
  assert.equal(framedFov(40, 16 / 9), 40);
  assert.equal(framedFov(40, 2.4), 40);                                  // wider: as framed
  assert.ok(Math.abs(hfov(framedFov(40, 4 / 3), 4 / 3) - hfov(40, 16 / 9)) < 1e-9);
  const phone = framedFov(36, 390 / 844);
  assert.ok(phone > 36 && phone <= 105);
  assert.ok(hfov(phone, 390 / 844) > 0.8 * hfov(36, 16 / 9));          // nearly as wide as framed
  assert.equal(framedFov(60, 0.3), 105);                                 // to the limit
});

test('framing: upright, the shot looks a little below its target (the airplane above the caption); wide, not at all', () => {
  assert.equal(framedTilt(40, 16 / 9), -0);
  assert.equal(framedTilt(40, 1.2), -0);
  const t = framedTilt(100, 390 / 844);
  assert.ok(t < -0.2 && t > -0.35, `${t}`);
});
