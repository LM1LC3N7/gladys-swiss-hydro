// -----------------------------------------------------------------------------
// Readings of a station -> "flow above" and "danger level reached" (pure).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_TRIGGERS } from '../src/constants.js';
import { newTriggerState, stationEvents } from '../src/triggers.js';

const DEVICE = 'ext:swiss-hydro:station:2135';
const T0 = Date.parse('2026-10-18T03:30:00Z');

const reading = (flow, danger = 1, i = 0) => ({
  id: '2135',
  name: 'Bern, Schönau',
  waterBody: 'Aare',
  time: T0 + i * 600_000,
  flow,
  level: 501.7,
  danger,
});

/** Feed the readings one after the other; the events of each step. */
function run(readings) {
  let state = newTriggerState();
  return readings.map((r, i) => {
    const result = stationEvents(state, { ...r, time: T0 + i * 600_000 }, DEVICE);
    state = result.state;
    return result.events;
  });
}

const marks = (events) =>
  events.filter((e) => e.key === SCENE_TRIGGERS.FLOW_ABOVE).map((e) => e.data.threshold);
const levels = (events) =>
  events.filter((e) => e.key === SCENE_TRIGGERS.DANGER_REACHED).map((e) => e.data.level);

test('the first reading only arms, even far above a mark', () => {
  const [first] = run([reading(1200, 4)]);
  assert.deepEqual(first, []);
});

test('flow above: once per rise, several marks at once, re-armed under 95 %', () => {
  const steps = run([
    reading(180),
    reading(320), // 200 and 300
    reading(305), // still above 300: nothing
    reading(298), // under 300, but above 285 (95 %): not re-armed
    reading(302), // nothing
    reading(280), // under 285: 300 re-armed
    reading(301), // 300 again
  ]);
  assert.deepEqual(steps.map(marks), [[], ['200', '300'], [], [], [], [], ['300']]);
  const [event] = steps[1];
  assert.equal(event.data.device, DEVICE);
  assert.equal(event.data.station, '2135');
  assert.equal(event.data.station_name, 'Aare - Bern, Schönau');
  assert.equal(event.data.flow, 320);
  assert.equal(event.data.measured_at, '2026-10-18 05:40');
  assert.match(event.data.summary, /above 200 m³\/s/);
  assert.match(event.data.summary_fr, /au-dessus de 200 m³\/s/);
});

test('flow above: a missing flow changes nothing', () => {
  const steps = run([reading(180), reading(null), reading(220)]);
  assert.deepEqual(steps.map(marks), [[], [], ['200']]);
});

test('danger level reached: each level crossed, again after a fall', () => {
  const steps = run([
    reading(100, 1),
    reading(100, 3), // 2 and 3
    reading(100, 3),
    reading(100, 2),
    reading(100, 3), // 3 again
    reading(100, 5), // 4 and 5
  ]);
  assert.deepEqual(steps.map(levels), [[], ['2', '3'], [], [], ['3'], ['4', '5']]);
  const [event] = steps[1];
  assert.equal(event.data.danger_level, 3);
  assert.equal(event.data.previous_level, 1);
  assert.match(event.data.summary_fr, /degré 3 sur 5/);
});

test('danger level: an unknown level in between only re-arms', () => {
  const steps = run([reading(100, 1), reading(100, null), reading(100, 2)]);
  assert.deepEqual(steps.map(levels), [[], [], ['2']], 'the last known level stays');
  const gap = run([reading(null, null), reading(100, 3)]);
  assert.deepEqual(gap.map(levels), [[], []], 'the first known level is no rise');
});

test('the event data is flat and small (the core limits)', () => {
  const steps = run([reading(10, 1), reading(5000, 5)]);
  for (const event of steps[1]) {
    const keys = Object.keys(event.data);
    assert.ok(keys.length <= 30);
    for (const value of Object.values(event.data)) {
      assert.ok(
        value === null || ['string', 'number', 'boolean'].includes(typeof value),
        `${event.key}: ${value}`,
      );
      if (typeof value === 'string') {
        assert.ok(value.length <= 1000);
      }
    }
  }
});
