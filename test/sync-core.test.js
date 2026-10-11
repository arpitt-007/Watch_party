'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { expectedPosition, decide, ClockSync, CFG } = require('../public/sync-core');

test('expectedPosition advances only while playing', () => {
  assert.strictEqual(expectedPosition({ playing: false, pos: 10, at: 1000 }, 5000), 10);
  assert.strictEqual(expectedPosition({ playing: true, pos: 10, at: 1000 }, 3500), 12.5);
  assert.strictEqual(expectedPosition({ playing: true, pos: 10, at: 5000 }, 3000), 10, 'scheduled start holds the position');
  assert.strictEqual(expectedPosition({ playing: true, pos: 10, at: 0 }, 100000, 60), 60, 'clamped to duration');
});

test('decide: none / rate / seek bands', () => {
  assert.strictEqual(decide({ drift: 0.01 }).action, 'none');
  const behind = decide({ drift: -0.2 });
  assert.strictEqual(behind.action, 'rate');
  assert.ok(behind.rate > 1 && behind.rate <= 1 + CFG.maxRateDelta, 'behind -> speed up');
  const ahead = decide({ drift: 0.2 });
  assert.ok(ahead.rate < 1 && ahead.rate >= 1 - CFG.maxRateDelta, 'ahead -> slow down');
  assert.strictEqual(decide({ drift: 1.5 }).action, 'seek');
  assert.strictEqual(decide({ drift: 1.5, sinceSeekMs: 100 }).action, 'rate', 'no seek storm during cooldown');
});

test('ClockSync recovers a known offset and prefers low-RTT samples', () => {
  const c = new ClockSync();
  const trueOffset = 4200; // server clock is 4.2 s ahead
  for (let i = 0; i < 12; i++) {
    const t0 = 1000 + i * 100;
    const up = i % 3 === 0 ? 2 : 40; // asymmetric congested samples are noisy
    const down = 2;
    c.addSample(t0, t0 + up + trueOffset, t0 + up + down);
  }
  assert.ok(Math.abs(c.offset - trueOffset) < 25, `offset ${c.offset}`);
});

const { simulate } = require('../scripts/driftsim');

test('closed-loop sim: drift stays <= 500 ms with rate error, clock skew and 2.5 s stalls', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = simulate({ seed });
    assert.ok(r.worstAfterSettle <= 0.5, `seed ${seed}: worst steady drift ${r.worstAfterSettle}`);
    assert.ok(r.p95 <= 0.2, `seed ${seed}: p95 ${r.p95}`);
  }
});
