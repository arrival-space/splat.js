import test from 'node:test';
import assert from 'node:assert/strict';
import { atmosphere, pressureAltitude, casFromImpact, impactPressure } from '../src/sim/atmosphere.js';

test('ISA sea level and 3,000 m', () => {
  const sl = atmosphere(0);
  assert.ok(Math.abs(sl.p - 101325) < 1);
  assert.ok(Math.abs(sl.rho - 1.225) < 0.001);
  const h3 = atmosphere(3000);
  assert.ok(Math.abs(h3.p - 70121) < 100, `p ${h3.p}`);
  assert.ok(Math.abs(h3.T - 268.65) < 0.01);
  assert.ok(Math.abs(h3.rho - 0.9093) < 0.002);
});

test('pressure altitude inverts the standard atmosphere', () => {
  for (const h of [0, 180.7, 1500, 4000]) assert.ok(Math.abs(pressureAltitude(atmosphere(h).p) - h) < 0.01);
});

test('altimeter set to QNH reads true altitude on a non-standard day', () => {
  const qnh = 100300;
  const p = atmosphere(800, { qnh }).p;
  assert.ok(Math.abs(pressureAltitude(p, qnh) - 800) < 0.01);
  assert.ok(pressureAltitude(p) > 800 + 70, 'at 29.92 it over-reads on a low-pressure day');
});

test('CAS equals TAS at sea level and is below TAS at altitude', () => {
  const sl = atmosphere(0);
  assert.ok(Math.abs(casFromImpact(impactPressure(80, sl)) - 80) < 0.01);
  const hi = atmosphere(3000);
  const cas = casFromImpact(impactPressure(80, hi));
  assert.ok(cas < 80 * 0.9 && cas > 80 * 0.84, `cas ${cas}`);
});
