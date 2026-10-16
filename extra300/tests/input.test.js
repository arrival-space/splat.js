import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlMapper } from '../src/input/controlMapper.js';
import { defaultControls } from '../src/sim/aircraft.js';

const step = (m, raw, s, c = defaultControls()) => { for (let i = 0; i < s * 60; i++) m.update(raw, 1 / 60, c); return c; };

test('keyboard elevator ramps in while held and springs back when released', () => {
  const m = new ControlMapper();
  const c = defaultControls();
  m.update({ keys: new Set(['ArrowDown']) }, 1 / 60, c);
  assert.ok(c.elevator > 0 && c.elevator < 0.01, 'a tap is a nudge');
  step(m, { keys: new Set(['ArrowDown']) }, 0.5, c);
  assert.ok(c.elevator < 0.15, `half a second in: ${c.elevator}`);
  step(m, { keys: new Set(['ArrowDown']) }, 1.5, c);
  assert.ok(Math.abs(c.elevator - 0.75) < 1e-9, `held: ${c.elevator} (capped short of full travel)`);
  step(m, { keys: new Set(['ArrowDown', 'Shift']) }, 0.5, c);
  assert.equal(c.elevator, 1, 'Shift: full travel');
  step(m, { keys: new Set() }, 0.5, c);
  assert.equal(c.elevator, 0);
});

test('arrow up is nose down (Flight Simulator convention), WASD mirrors arrows', () => {
  assert.ok(step(new ControlMapper(), { keys: new Set(['ArrowUp']) }, 0.3).elevator < 0);
  assert.ok(step(new ControlMapper(), { keys: new Set(['w']) }, 0.3).elevator < 0);
  assert.ok(step(new ControlMapper(), { keys: new Set(['d']) }, 0.3).aileron > 0);
});

test('throttle keys move the throttle and it stays put', () => {
  const m = new ControlMapper();
  const c = step(m, { keys: new Set(['PageUp']) }, 1);
  assert.ok(Math.abs(c.throttle - 0.5) < 0.02);
  step(m, { keys: new Set() }, 1, c);
  assert.ok(Math.abs(c.throttle - 0.5) < 0.02);
  step(m, { keys: new Set(['Home']) }, 0.1, c);
  assert.equal(c.throttle, 0);
});

test('gamepad: deadzone, expo, pull back = nose up, triggers = differential brakes', () => {
  const m = new ControlMapper();
  const c = defaultControls();
  m.update({ keys: new Set(), pad: { axes: [0.05, 0, 0, 0], buttons: [] } }, 1 / 60, c);
  assert.equal(c.aileron, 0, 'inside the deadzone');
  m.update({ keys: new Set(), pad: { axes: [0.5, 1, 0, 0], buttons: [0, 0, 0, 0, 0, 0, 0.8, 0] } }, 1 / 60, c);
  assert.ok(c.aileron > 0 && c.aileron < 0.5, `expo softens the middle: ${c.aileron}`);
  assert.equal(c.elevator, 1);
  assert.equal(c.brakeL, 0.8);
  assert.equal(c.brakeR, 0);
});

test('touch sticks: push forward = nose down, right stick up = more throttle', () => {
  const m = new ControlMapper();
  const c = step(m, { keys: new Set(), left: { x: 0, y: 1 }, right: { x: 0, y: 1 } }, 1);
  assert.equal(c.elevator, -1);
  assert.ok(c.throttle > 0.5);
});

test('R / F work the throttle on keyboards without PgUp / PgDn', () => {
  const m = new ControlMapper();
  const c = step(m, { keys: new Set(['r']) }, 2.1);
  assert.ok(c.throttle > 0.999, `${c.throttle}`);
  step(m, { keys: new Set(['f']) }, 1, c);
  assert.ok(Math.abs(c.throttle - 0.5) < 0.02);
});
