// -----------------------------------------------------------------------------
// The answers of the sources -> readings, devices and states (pure).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseStations, stationId } from '../src/config.js';
import { FEATURES } from '../src/constants.js';
import {
  believable,
  deviceOf,
  foenReading,
  isFresh,
  labelOf,
  mergeThresholds,
  num,
  parseLindasObservations,
  parseLindasStations,
  parseSwissStations,
  parseThresholds,
  parseTime,
  quantity,
  searchStations,
  statesOf,
  swissReading,
  swissTime,
  valuesOf,
} from '../src/model.js';
import { FIXTURE_NOW, fixture } from './helpers/fakes.js';

const NOW = FIXTURE_NOW;
const TZ = process.env.TZ;
afterEach(() => {
  if (TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = TZ;
  }
});

test('station numbers and the configuration', () => {
  assert.equal(stationId('2135'), '2135');
  assert.equal(stationId(' 0520 '), '520');
  assert.equal(stationId('0'), null);
  assert.equal(stationId('21a5'), null);
  assert.equal(stationId('__proto__'), null);
  assert.equal(stationId('1234567'), null);
  assert.deepEqual(parseStations('2135, 2009;2135\nRhône Porte du Scex, ,'), {
    ids: ['2135', '2009'],
    names: ['Rhône Porte du Scex'],
  });
  const config = normalizeConfig({ stations: '2135', source: 'nope', poll_interval: 3 });
  assert.equal(config.source, 'foen');
  assert.equal(config.pollMinutes, 10, 'never under 10 minutes');
  assert.equal(normalizeConfig({ poll_interval: '600' }).pollMinutes, 60);
  assert.equal(normalizeConfig({ source: 'swisshydroapi' }).source, 'swisshydroapi');
});

test('numbers: plain decimals only', () => {
  assert.equal(num('57.783'), 57.783);
  assert.equal(num(-0.065), -0.065);
  assert.equal(num('1e9'), null);
  assert.equal(num('0x10'), null);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num(Infinity), null);
  assert.equal(num('https://cube.link/Undefined'), null);
});

test('LINDAS: the latest observation of each station', () => {
  const stations = parseLindasObservations(fixture('lindas-values.json'), NOW);
  assert.deepEqual([...stations.keys()].sort(), ['2009', '2043', '2135', '2602', '520']);
  const bern = stations.get('2135');
  assert.equal(bern.name, 'Bern, Schönau');
  assert.equal(bern.waterBody, 'Aare');
  assert.equal(bern.kind, 'river');
  assert.equal(bern.time, Date.parse('2026-10-18T03:30:00Z'));
  assert.equal(bern.discharge, 57.783);
  assert.equal(bern.level, 501.712);
  assert.equal(bern.temperature, 15.12);
  assert.equal(bern.danger, 1);
  // Two observations of 520: the most recent one.
  assert.equal(stations.get('520').time, Date.parse('2026-10-18T03:20:00Z'));
  // "https://cube.link/Undefined": no danger level.
  assert.equal(stations.get('520').danger, null);
  assert.equal(stations.get('2043').kind, 'lake');
  assert.equal(stations.get('2043').discharge, null);
});

test('LINDAS: a broken level sensor (0 m) and implausible values are dropped', () => {
  const body = {
    results: {
      bindings: [
        {
          id: { value: '2602' },
          time: { value: '2026-10-18T04:30:00+01:00' },
          level: { value: '0.000' },
          temperature: { value: '99.0' },
          discharge: { value: '-5' },
        },
      ],
    },
  };
  const raw = parseLindasObservations(body, NOW).get('2602');
  assert.equal(raw.level, null);
  assert.equal(raw.temperature, null);
  assert.equal(foenReading(raw, { flowUnit: 'm3/s' }).flow, null);
});

test('network ids never reach an object prototype', () => {
  const hostile = {
    results: {
      bindings: [
        { id: { value: '__proto__' }, name: { value: 'x' } },
        { id: { value: 'constructor' } },
        { __proto__: { polluted: true }, id: { value: '2135' }, name: { value: 'ok' } },
        { id: { value: '2009', toString: 'x' }, name: { value: { polluted: true } } },
      ],
    },
  };
  const stations = parseLindasObservations(hostile, NOW);
  assert.deepEqual([...stations.keys()].sort(), ['2009', '2135']);
  assert.equal(stations.get('2009').name, '');
  parseLindasStations(hostile);
  parseThresholds({
    features: [
      { properties: { key: '__proto__', metric: 'discharge_ms', wl_1: '1 m³/s' } },
      JSON.parse('{"properties":{"key":"2135","__proto__":{"polluted":true},"metric":"masl"}}'),
    ],
  });
  parseSwissStations([{ id: '__proto__' }, JSON.parse('{"__proto__":{"polluted":true}}')]);
  swissReading('2135', JSON.parse('{"parameters":{"__proto__":{"value":1}}}'), null, NOW);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('dates: an offset is required, aberrant dates are refused', () => {
  assert.equal(parseTime('2026-10-18T04:30:00+01:00'), Date.parse('2026-10-18T03:30:00Z'));
  assert.equal(parseTime('2026-10-18T03:30:00Z'), Date.parse('2026-10-18T03:30:00Z'));
  assert.ok(Number.isNaN(parseTime('2026-10-18T04:30:00')), 'no offset: container time zone');
  assert.ok(Number.isNaN(parseTime('yesterday')));
  assert.ok(believable(NOW - 60_000, NOW));
  assert.ok(!believable(NOW + 20 * 60_000, NOW), 'in the future');
  assert.ok(!believable(Date.parse('2025-05-28T13:20:00Z'), NOW), 'a station out of service');
  assert.ok(!believable(0, NOW), '1970');
  // An observation with an aberrant date only: kept, marked, never fresh.
  const body = {
    results: {
      bindings: [{ id: { value: '2356' }, time: { value: '2025-05-28T14:20:00+01:00' } }],
    },
  };
  const raw = parseLindasObservations(body, NOW).get('2356');
  assert.equal(raw.aberrant, true);
  assert.ok(!isFresh(foenReading(raw, null), NOW));
  // A believable date wins over an aberrant one of the same station.
  body.results.bindings.push({
    id: { value: '2356' },
    time: { value: '2026-10-18T04:20:00+01:00' },
  });
  assert.equal(parseLindasObservations(body, NOW).get('2356').aberrant, false);
  // Stale after 3 hours.
  const reading = { time: NOW - 3 * 60 * 60_000 - 1 };
  assert.ok(!isFresh(reading, NOW));
});

test('the measurement date in Swiss time, whatever the time zone of the container', () => {
  const offsets = new Set();
  for (const zone of ['Europe/Lisbon', 'Europe/Helsinki', 'UTC', 'America/New_York']) {
    process.env.TZ = zone;
    // The zone really changed for this process (else the test proves nothing).
    offsets.add(new Date(NOW).getTimezoneOffset());
    // Around midnight: 00:30 in Bern is still the previous day in Lisbon.
    assert.equal(swissTime(Date.parse('2026-10-17T22:30:00Z')), '2026-10-18 00:30 CEST', zone);
    assert.equal(swissTime(Date.parse('2026-10-17T21:59:00Z')), '2026-10-17 23:59 CEST', zone);
    // The end of summer time (2026-10-25): 02:30 twice, told apart by the zone.
    assert.equal(swissTime(Date.parse('2026-10-25T00:30:00Z')), '2026-10-25 02:30 CEST', zone);
    assert.equal(swissTime(Date.parse('2026-10-25T01:30:00Z')), '2026-10-25 02:30 CET', zone);
    // The start of summer time (2026-03-29): 02:xx does not exist.
    assert.equal(swissTime(Date.parse('2026-03-29T01:30:00Z')), '2026-03-29 03:30 CEST', zone);
    // The FOEN writes its winter time all year: the instant is what counts.
    assert.equal(swissTime(parseTime('2026-10-18T04:30:00+01:00')), '2026-10-18 05:30 CEST', zone);
    // Freshness does not depend on the zone either.
    assert.ok(isFresh({ time: parseTime('2026-10-18T04:30:00+01:00') }, NOW), zone);
  }
  assert.equal(offsets.size, 4, 'four different offsets were tried');
});

test('thresholds: units, lakes, l/s brooks, missing or broken thresholds', () => {
  const meta = parseThresholds(fixture('thresholds.geojson'));
  assert.deepEqual(meta.get('2135'), {
    kind: 'river',
    metric: 'flow',
    flowUnit: 'm3/s',
    thresholds: [360, 430, 500, 560],
  });
  assert.equal(meta.get('2206').thresholds.length, 4);
  assert.equal(meta.get('2206').flowUnit, 'l/s');
  assert.equal(meta.get('2206').thresholds[0], 1.45, '1450 l/s = 1.45 m³/s');
  assert.deepEqual(meta.get('2031'), {
    kind: 'lake',
    metric: 'level',
    flowUnit: null,
    thresholds: [724.1, 724.45, 725, 725.25],
  });
  assert.equal(meta.get('2384').thresholds, null, 'no thresholds');
  assert.equal(meta.get('2384').flowUnit, 'l/s');
  const broken = parseThresholds({
    features: [
      {
        properties: {
          key: '1',
          metric: 'discharge_ms',
          wl_1: '500 m³/s',
          wl_2: '400 m³/s',
          wl_3: '600 m³/s',
          wl_4: '700 m³/s',
        },
      },
      {
        properties: {
          key: '2',
          metric: 'discharge_ms',
          wl_1: '1 m ü.M.',
          wl_2: '2 m³/s',
          wl_3: '3 m³/s',
          wl_4: '4 m³/s',
        },
      },
    ],
  });
  assert.equal(broken.get('1').thresholds, null, 'not increasing');
  assert.equal(broken.get('2').thresholds, null, 'another unit');
  assert.deepEqual(quantity('724.10 m ü.M.'), { value: 724.1, unit: 'masl' });
  assert.deepEqual(quantity('2.5 m'), { value: 2.5, unit: 'm' }, 'a height is not an altitude');
  assert.equal(quantity('12 furlongs'), null);
});

test('the discharge unit of LINDAS comes from the thresholds layer', () => {
  const raws = parseLindasObservations(fixture('lindas-values.json'), NOW);
  const meta = parseThresholds(fixture('thresholds.geojson'));
  assert.equal(foenReading(raws.get('2135'), meta.get('2135')).flow, 57.783);
  const brook = foenReading({ ...raws.get('2135'), id: '2206', discharge: 15 }, meta.get('2206'));
  assert.equal(brook.flow, 0.015, '15 l/s');
  // No station facts: the flow waits, the other values go on.
  const unknown = foenReading(raws.get('520'), undefined);
  assert.equal(unknown.flow, null);
  assert.equal(unknown.flowUnit, 'unknown');
  assert.equal(unknown.level, 523.718);
});

test('the thresholds layer merged: units kept, thresholds always fresh', () => {
  const known = new Map([
    ['2135', { kind: 'river', metric: 'flow', flowUnit: 'm3/s', thresholds: [360, 430, 500, 560] }],
    ['2206', { kind: 'river', metric: 'flow', flowUnit: 'l/s', thresholds: null }],
  ]);
  const fresh = new Map([
    ['2135', { kind: 'river', metric: null, flowUnit: null, thresholds: null }],
    [
      '2009',
      { kind: 'river', metric: 'flow', flowUnit: 'm3/s', thresholds: [700, 1000, 1200, 1400] },
    ],
  ]);
  const merged = mergeThresholds(known, fresh);
  assert.equal(merged.get('2135').flowUnit, 'm3/s', 'a known unit is never replaced by null');
  assert.equal(merged.get('2135').thresholds, null, 'thresholds only from the fresh layer');
  assert.equal(merged.get('2206').flowUnit, 'l/s', 'missing from the new layer: kept');
  assert.equal(merged.get('2206').thresholds, null);
  assert.equal(merged.get('2009').flowUnit, 'm3/s');
  assert.deepEqual(merged.get('2009').thresholds, [700, 1000, 1200, 1400]);
});

test('swisshydroapi: one station, its units and its dates, never a danger level', () => {
  const meta = parseThresholds(fixture('thresholds.geojson'));
  const bern = swissReading('2135', fixture('swisshydroapi-2135.json'), meta.get('2135'), NOW);
  assert.equal(bern.flow, 57.783);
  assert.equal(bern.level, 501.712);
  assert.equal(bern.temperature, 15.12);
  assert.equal(bern.danger, null, 'never computed from the thresholds');
  assert.ok(!valuesOf(bern, meta.get('2135')).has(FEATURES.DANGER));
  assert.equal(bern.time, Date.parse('2026-10-18T03:30:00Z'));
  assert.equal(labelOf(bern), 'Aare - Bern, Schönau');
  const melera = swissReading('2206', fixture('swisshydroapi-2206.json'), meta.get('2206'), NOW);
  assert.equal(melera.flow, 0.015, 'l/s converted');
  assert.equal(melera.temperature, null);
  assert.equal(melera.danger, null);
  const odd = swissReading(
    '1',
    {
      parameters: {
        discharge: { unit: 'gal/min', value: 3, datetime: '2026-10-18T04:30:00+01:00' },
        temperature: { unit: '°F', value: 50, datetime: '2026-10-18T04:30:00+01:00' },
      },
    },
    null,
    NOW,
  );
  assert.equal(odd.flow, null);
  assert.equal(odd.flowUnit, 'unknown');
  assert.equal(odd.temperature, null, '°C only');
  const old = swissReading(
    '1',
    { parameters: { level: { unit: 'm', value: 400, datetime: '2025-01-01T00:00:00+01:00' } } },
    null,
    NOW,
  );
  assert.equal(old.aberrant, true);
  assert.ok(!isFresh(old, NOW));
  // A sensor stopped while the others go on: its last value is left out.
  const mixed = swissReading(
    '1',
    {
      parameters: {
        level: { unit: 'm', value: 400, datetime: '2026-10-18T04:30:00+01:00' },
        temperature: { unit: '°C', value: 9, datetime: '2026-10-17T04:30:00+01:00' },
      },
    },
    null,
    NOW,
  );
  assert.equal(mixed.level, 400);
  assert.equal(mixed.temperature, null);
  assert.ok(isFresh(mixed, NOW));
});

test('the station lists and the search', () => {
  const lindas = parseLindasStations(fixture('lindas-stations.json'));
  assert.ok(lindas.length >= 8);
  assert.equal(new Set(lindas.map((s) => s.id)).size, lindas.length, 'no duplicate');
  const swiss = parseSwissStations(fixture('swisshydroapi-stations.json'));
  assert.equal(swiss.find((s) => s.id === '2044').name, 'Andelfingen');
  assert.deepEqual(
    searchStations(swiss, 'rhone').map((s) => s.id),
    ['2009'],
  );
  assert.deepEqual(
    searchStations(swiss, 'Aare Bern').map((s) => s.id),
    ['2135'],
  );
  assert.deepEqual(
    searchStations(swiss, 'schonau').map((s) => s.id),
    ['2135'],
    'without the accent',
  );
  assert.deepEqual(searchStations(swiss, '  '), []);
  assert.deepEqual(
    searchStations(lindas, 'Rhein')
      .map((s) => s.id)
      .sort(),
    ['2289', '2602', '2615'],
  );
});

test('devices and states: the features of the values present, plain units', () => {
  const gladys = createFakeGladys({ selector: 'swiss-hydro' });
  const meta = parseThresholds(fixture('thresholds.geojson')).get('2135');
  const raw = parseLindasObservations(fixture('lindas-values.json'), NOW).get('2135');
  const reading = foenReading(raw, meta);
  const values = valuesOf(reading, meta);
  const device = deviceOf(gladys, reading, new Set(values.keys()));
  assert.equal(device.external_id, 'ext:swiss-hydro:station:2135');
  assert.equal(device.name, 'Aare - Bern, Schönau');
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    [
      FEATURES.FLOW,
      FEATURES.LEVEL,
      FEATURES.TEMPERATURE,
      FEATURES.MEASURED_AT,
      FEATURES.DANGER,
      FEATURES.THRESHOLD_2,
      FEATURES.THRESHOLD_3,
      FEATURES.THRESHOLD_4,
      FEATURES.THRESHOLD_5,
    ],
  );
  for (const feature of device.features) {
    assert.equal(feature.read_only, true);
  }
  const states = Object.fromEntries(
    statesOf(gladys, reading, meta).map((s) => [s.device_feature_external_id.split(':').pop(), s]),
  );
  assert.deepEqual(states.flow, {
    device_feature_external_id: `${device.external_id}:flow`,
    state: 57.783,
  });
  assert.equal(states['measured-at'].text, '2026-10-18 05:30 CEST');
  assert.equal(states['danger-level'].state, 1);
  assert.equal(states['danger-threshold-5'].state, 560);
  // A lake: no flow, its thresholds in m.
  const lake = foenReading(
    parseLindasObservations(fixture('lindas-values.json'), NOW).get('2043'),
    undefined,
  );
  assert.ok(!valuesOf(lake, undefined).has(FEATURES.FLOW));
});
