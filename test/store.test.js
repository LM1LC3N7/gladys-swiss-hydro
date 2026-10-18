// -----------------------------------------------------------------------------
// The persisted state: what a previous run wrote is checked, never trusted.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOSTS, LIMITED_MAX } from '../src/constants.js';
import { emptyState, fileStorage, loadState, saveState } from '../src/store.js';

const NOW = Date.parse('2026-10-18T03:40:00Z');

test('a round trip keeps everything', () => {
  const state = emptyState();
  state.pauses.set(HOSTS.LINDAS, { until: NOW + 60_000, streak: 2 });
  state.lastReadAt = NOW - 1000;
  state.readings.set('2135', {
    id: '2135',
    name: 'Bern, Schönau',
    waterBody: 'Aare',
    kind: 'river',
    time: NOW - 600_000,
    aberrant: false,
    flow: 57.8,
    flowUnit: 'm3/s',
    level: 501.7,
    temperature: 15.1,
    danger: 1,
  });
  state.meta.fetchedAt = NOW - 5000;
  state.meta.stations.set('2135', {
    kind: 'river',
    metric: 'flow',
    flowUnit: 'm3/s',
    thresholds: [360, 430, 500, 560],
  });
  state.triggers.set('2135', { armed: new Set([500, 700]), danger: 1, started: true });
  state.known.set('2135', new Set(['flow', 'level']));
  const back = loadState(JSON.parse(JSON.stringify(saveState(state))), NOW);
  assert.deepEqual(back.pauses.get(HOSTS.LINDAS), { until: NOW + 60_000, streak: 2 });
  assert.equal(back.lastReadAt, NOW - 1000);
  assert.deepEqual(back.readings.get('2135'), state.readings.get('2135'));
  assert.deepEqual(back.meta.stations.get('2135'), state.meta.stations.get('2135'));
  assert.deepEqual([...back.triggers.get('2135').armed], [500, 700]);
  assert.deepEqual([...back.known.get('2135')], ['flow', 'level']);
});

test('a hostile or broken file: nothing reaches a prototype, bounds hold', () => {
  const raw = JSON.parse(`{
    "v": 1,
    "pauses": [
      { "host": "ld.admin.ch", "until": ${NOW + 30 * 24 * 3600_000}, "streak": 99 },
      { "host": "__proto__", "until": ${NOW + 1000} },
      { "host": "www.hydrodaten.admin.ch", "until": ${NOW - 1000} }
    ],
    "lastReadAt": ${NOW + 999_999},
    "readings": [
      { "id": "__proto__", "name": "x" },
      { "id": "2135", "flow": -1, "level": "501", "danger": 7, "temperature": 15, "__proto__": { "polluted": true } }
    ],
    "meta": { "stations": [["__proto__", {}], ["constructor", {}], ["2135", { "thresholds": [3, 2, 1, 0] }]] },
    "list": { "source": "evil", "stations": [{ "id": "1" }] },
    "triggers": [["2135", { "armed": [500, 123, "x"], "danger": 9 }]],
    "known": [["2135", ["flow", "__proto__", "nope"]]]
  }`);
  const state = loadState(raw, NOW);
  assert.equal(state.pauses.get(HOSTS.LINDAS).until, NOW + LIMITED_MAX, 'capped at 6 hours');
  assert.equal(state.pauses.get(HOSTS.LINDAS).streak, 10);
  assert.equal(state.pauses.size, 1);
  assert.equal(state.lastReadAt, NOW, 'never in the future');
  assert.deepEqual([...state.readings.keys()], ['2135']);
  const r = state.readings.get('2135');
  assert.equal(r.flow, null);
  assert.equal(r.level, null, 'a string is no number');
  assert.equal(r.danger, null);
  assert.equal(r.temperature, 15);
  assert.equal(state.meta.stations.get('2135').thresholds, null);
  assert.equal(state.meta.stations.size, 1);
  assert.equal(state.list.source, null);
  assert.deepEqual(state.list.stations, []);
  assert.deepEqual([...state.triggers.get('2135').armed], [500]);
  assert.equal(state.triggers.get('2135').danger, null);
  assert.deepEqual([...state.known.get('2135')], ['flow']);
  assert.equal({}.polluted, undefined);
  // Not a state at all.
  assert.equal(loadState('nope', NOW).readings.size, 0);
  assert.equal(loadState({ v: 2 }, NOW).readings.size, 0);
});

test('the file storage: atomic write, a corrupt file starts afresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swiss-hydro-'));
  try {
    const warnings = [];
    const path = join(dir, 'sub', 'state.json');
    const storage = fileStorage(path, { logger: { warn: (t) => warnings.push(t) } });
    assert.equal(storage.load(), undefined, 'no file yet');
    storage.save({ v: 1, lastReadAt: 5 });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { v: 1, lastReadAt: 5 });
    writeFileSync(path, '{ not json');
    assert.equal(storage.load(), undefined);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /not json/, 'the content is never logged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
