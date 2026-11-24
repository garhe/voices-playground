import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueTiming } from '../server/queueTiming.js';

test('estimates the current pass and entire batch using recent settled work', () => {
  const timing = new QueueTiming(0);
  for (let n = 1; n <= 6; n++) timing.record(n * 3000);
  assert.deepEqual(timing.minutesLeft(19_000, 30, 60, false), {});
  assert.deepEqual(timing.minutesLeft(30_000, 30, 60, false), { currentMinutes: 3, batchMinutes: 8 });
  assert.deepEqual(timing.minutesLeft(30_000, 30, 60, true), { currentMinutes: 3, batchMinutes: undefined });
  assert.deepEqual(timing.minutesLeft(30_000, 0, 60, false), { currentMinutes: undefined, batchMinutes: 5 });
  assert.deepEqual(timing.minutesLeft(139_000, 30, 60, false), {});
});

test('does not estimate from too few results or double-count previous passes', () => {
  const timing = new QueueTiming(90_000);
  for (let n = 1; n <= 5; n++) timing.record(90_000 + n * 5000);
  assert.deepEqual(timing.minutesLeft(120_000, 12, 24, false), {});
  timing.record(120_000);
  assert.deepEqual(timing.minutesLeft(120_000, 12, 24, false), { currentMinutes: 1, batchMinutes: 3 });
  assert.deepEqual(new QueueTiming(120_000).minutesLeft(150_000, 6, 24, false), {});
});
