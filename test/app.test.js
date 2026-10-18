// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and fake data sources.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HydroApp } from '../src/app.js';
import { ACTIONS, HOSTS, SCENE_TRIGGERS, TICK } from '../src/constants.js';
import { memoryStorage } from '../src/store.js';
import {
  FIXTURE_NOW,
  createFakeTimers,
  fixture,
  installFetch,
  json,
  quiet,
} from './helpers/fakes.js';

const BERN = 'ext:swiss-hydro:station:2135';

let fake;
afterEach(() => fake?.restore());

/** A LINDAS answer for observations: [{ id, time, discharge, level, temperature, danger }]. */
const lindas = (rows) =>
  json({
    results: {
      bindings: rows.map((r) => ({
        obs: { value: `https://environment.ld.admin.ch/foen/hydro/river/observation/${r.id}` },
        id: { value: r.id },
        name: { value: r.name ?? 'Bern, Schönau' },
        wbName: { value: r.waterBody ?? 'Aare' },
        time: { value: r.time },
        ...(r.discharge !== undefined ? { discharge: { value: String(r.discharge) } } : {}),
        ...(r.level !== undefined ? { level: { value: String(r.level) } } : {}),
        ...(r.temperature !== undefined ? { temperature: { value: String(r.temperature) } } : {}),
        ...(r.danger !== undefined ? { danger: { value: String(r.danger) } } : {}),
      })),
    },
  });

/** The FOEN clock: winter time all year. */
const foenTime = (ms) => {
  const d = new Date(ms + 3600_000).toISOString().slice(0, 19);
  return `${d}+01:00`;
};

async function setup({
  config = { stations: '2135, 2009, 520' },
  storage = memoryStorage(),
  now = FIXTURE_NOW,
  devices = [],
  start = true,
} = {}) {
  const answers = {
    values: () => json(fixture('lindas-values.json')),
    stations: () => json(fixture('lindas-stations.json')),
    thresholds: () => json(fixture('thresholds.geojson')),
    swiss: (id) =>
      id === '2135' || id === '2206'
        ? json(fixture(`swisshydroapi-${id}.json`))
        : json({ detail: 'not found' }, 404),
    swissList: () => json(fixture('swisshydroapi-stations.json')),
  };
  fake = installFetch([
    [
      /^https:\/\/ld\.admin\.ch\/query$/,
      (c) => (/VALUES/.test(c.body) ? answers.values(c) : answers.stations(c)),
    ],
    [/hydro_sensor_pq\.geojson$/, (c) => answers.thresholds(c)],
    [/^https:\/\/swisshydroapi\.bouni\.de\/api\/v1\/stations$/, (c) => answers.swissList(c)],
    [
      /^https:\/\/swisshydroapi\.bouni\.de\/api\/v1\/station\//,
      (c) => answers.swiss(c.url.split('/').pop()),
    ],
  ]);
  const gladys = createFakeGladys({ selector: 'swiss-hydro', config, devices });
  const timers = createFakeTimers();
  const clock = { now };
  const app = new HydroApp({
    gladys,
    logger: quiet,
    now: () => clock.now,
    timers,
    storage,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.SEARCH, (fields) => app.search(fields));
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  if (start) {
    await app.start(config);
  }
  return { app, gladys, timers, clock, answers, storage };
}

const calls = (pattern) => fake.calls.filter((c) => pattern.test(c.url));
const valueCalls = () =>
  fake.calls.filter((c) => /ld\.admin\.ch/.test(c.url) && /VALUES/.test(c.body));
const GEO = /hydro_sensor_pq/;

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

/** Let the clock run `minutes`, ticking every minute as the timer would. */
async function runMinutes(timers, clock, minutes) {
  for (let i = 0; i < minutes; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
  }
}

const status = (gladys) => gladys.fake.connectionStatus;

/** The message of an action ack, in one language. */
const msg = (ack, lang) => String(ack.data?.message?.[lang] ?? ack.data?.message ?? ack.error);

test('a start reads the thresholds, then the values: devices, states, status', async () => {
  const { gladys } = await setup();
  assert.equal(calls(GEO).length, 1);
  assert.equal(valueCalls().length, 1);
  const query = new URLSearchParams(valueCalls()[0].body).get('query');
  assert.match(query, /VALUES \?id \{ 2135 2009 520 \}/);
  assert.equal(valueCalls()[0].init.method, 'POST');
  assert.match(valueCalls()[0].init.headers['User-Agent'], /gladys-swiss-hydro/);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Aare - Bern, Schönau', 'Rhône - Porte du Scex', 'Töss - Rämismühle'],
  );
  // 520 is not in the thresholds layer: its discharge unit is unknown.
  const toss = devices[2].features.map((f) => f.external_id.split(':').pop());
  assert.ok(!toss.includes('flow'));
  assert.ok(toss.includes('level'));
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /3 station\(s\), 3 with a current value/);
  assert.match(status(gladys).message.fr, /unité du débit est encore inconnue/);
  // Nothing published before the user creates the devices; then at once.
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${BERN}:flow`), 57.783);
  assert.equal(gladys.fake.lastState(`${BERN}:temperature`), 15.12);
  assert.equal(gladys.fake.lastState(`${BERN}:danger-level`), 1);
  assert.equal(gladys.fake.lastState(`${BERN}:danger-threshold-4`), 500);
  assert.equal(gladys.fake.lastState(`${BERN}:measured-at`), '2026-10-18 05:30 CEST');
  // 520: LINDAS says Undefined: no danger level feature, nothing published.
  assert.equal(gladys.fake.lastState('ext:swiss-hydro:station:520:danger-level'), undefined);
  assert.ok(!toss.includes('danger-level'));
});

test('never faster than the interval: ticks, reconnections, restarts', async () => {
  const storage = memoryStorage();
  const { app, gladys, timers, clock } = await setup({ storage });
  assert.equal(valueCalls().length, 1);
  await runMinutes(timers, clock, 9);
  assert.equal(valueCalls().length, 1);
  // A reconnection to Gladys: no read, but the status and the Discovery
  // list are published again (the core keeps them in memory only).
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await app.start({ stations: '2135, 2009, 520' });
  assert.equal(valueCalls().length, 1);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  app.stop();
  // A restart of the container 30 s later: the last read is on disk.
  const second = await setup({ storage, now: clock.now + 30_000 });
  assert.equal(valueCalls().length, 0, 'the restarted app does not read');
  assert.equal(second.gladys.fake.discoveredDevices.length, 3, 'the last readings are kept');
  assert.equal(status(second.gladys).connected, true);
  await runMinutes(second.timers, second.clock, 1);
  assert.equal(valueCalls().length, 1, 'read 10 minutes after the last read');
  assert.equal(calls(GEO).length, 0, 'the thresholds are read once a day');
});

test('429: the pause is persisted, clamped, and never shorter than the interval', async () => {
  const storage = memoryStorage();
  const { app, gladys, timers, clock, answers } = await setup({ storage, start: false });
  answers.values = () => json({}, 429, { 'retry-after': '5' });
  await app.start({ stations: '2135' });
  assert.equal(valueCalls().length, 1);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /paused until/);
  const pause = app.state.pauses.get(HOSTS.LINDAS);
  assert.equal(pause.until, clock.now + 60_000, 'a 5 s Retry-After is a 1 minute pause');
  await runMinutes(timers, clock, 9);
  assert.equal(valueCalls().length, 1, 'the pause ended, the interval did not');
  await runMinutes(timers, clock, 1);
  assert.equal(valueCalls().length, 2);
  // A long pause (1 hour), then a restart: still no call before its end.
  answers.values = () => json({}, 429, { 'retry-after': '3600' });
  await runMinutes(timers, clock, 10);
  assert.equal(valueCalls().length, 3);
  app.stop();
  const second = await setup({ storage, config: { stations: '2135' }, now: clock.now + 60_000 });
  second.answers.values = () => json(fixture('lindas-values.json'));
  assert.equal(valueCalls().length, 0);
  await runMinutes(second.timers, second.clock, 50);
  assert.equal(valueCalls().length, 0, 'within the hour');
  await runMinutes(second.timers, second.clock, 10);
  assert.equal(valueCalls().length, 1, 'after the hour');
  assert.equal(second.app.state.pauses.size, 0, 'a good answer ends the pause');
});

test('a 429 without Retry-After: 10 minutes, doubling', async () => {
  const { app, timers, clock, answers } = await setup({ start: false });
  answers.values = () => json({}, 429);
  await app.start({ stations: '2135' });
  assert.equal(app.state.pauses.get(HOSTS.LINDAS).until, clock.now + 10 * 60_000);
  await runMinutes(timers, clock, 10);
  assert.equal(valueCalls().length, 2);
  assert.equal(app.state.pauses.get(HOSTS.LINDAS).until, clock.now + 20 * 60_000);
  await runMinutes(timers, clock, 19);
  assert.equal(valueCalls().length, 2);
});

test('5xx and network errors: the last values stay, retried at the interval only', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  await app.start({ stations: '2135' });
  await createAll(gladys);
  answers.values = () => json({ error: 'boom' }, 503);
  await runMinutes(timers, clock, 10);
  assert.equal(valueCalls().length, 2);
  assert.match(status(gladys).message.en, /Last read failed \(service unavailable\)/);
  assert.equal(status(gladys).connected, true, 'the values are still current');
  answers.values = () => {
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  };
  await runMinutes(timers, clock, 9);
  assert.equal(valueCalls().length, 2);
  await runMinutes(timers, clock, 1);
  assert.equal(valueCalls().length, 3);
  assert.match(status(gladys).message.fr, /erreur réseau/);
  assert.equal(gladys.fake.lastState(`${BERN}:flow`), 57.783);
  // Three hours later the values are stale: not current any more.
  answers.values = () => json({}, 500);
  await runMinutes(timers, clock, 180);
  assert.equal(status(gladys).connected, false);
});

test('the thresholds layer failing never stops the values', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  answers.thresholds = () => json({}, 500);
  await app.start({ stations: '2135' });
  assert.equal(valueCalls().length, 1);
  assert.equal(status(gladys).connected, true);
  const features = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').pop(),
  );
  assert.ok(features.includes('level') && features.includes('danger-level'));
  assert.ok(!features.includes('flow'), 'the unit of the discharge is not known yet');
  await runMinutes(timers, clock, 59);
  assert.equal(calls(GEO).length, 1, 'retried after an hour, not at every tick');
  answers.thresholds = () => json(fixture('thresholds.geojson'));
  await runMinutes(timers, clock, 1);
  assert.equal(calls(GEO).length, 2);
  await runMinutes(timers, clock, 10);
  const after = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').pop(),
  );
  assert.ok(after.includes('flow') && after.includes('danger-threshold-2'));
});

test('a republished device never loses a feature', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  await app.start({ stations: '2135' });
  await createAll(gladys);
  const created = gladys.fake.discoveredDevices[0].features.length;
  // The temperature sensor fails, the danger level is undefined.
  answers.values = () =>
    lindas([{ id: '2135', time: foenTime(clock.now - 300_000), discharge: 60, level: 501.7 }]);
  await runMinutes(timers, clock, 10);
  assert.equal(gladys.fake.discoveredDevices[0].features.length, created);
  // A new process, an empty state: the features of the created device count.
  app.stop();
  const second = await setup({
    config: { stations: '2135' },
    devices: gladys.fake.devices,
    now: clock.now,
  });
  second.answers.values = answers.values;
  assert.equal(second.gladys.fake.discoveredDevices[0].features.length, created);
});

test('scene events: flow above a mark, danger level reached, once each', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  await app.start({ stations: '2135' });
  assert.equal(gladys.fake.sceneEvents.length, 0, 'the first reading only arms');
  answers.values = () =>
    lindas([
      {
        id: '2135',
        time: foenTime(clock.now - 120_000),
        discharge: 520,
        level: 503.1,
        temperature: 12,
        danger: 3,
      },
    ]);
  await runMinutes(timers, clock, 10);
  const events = gladys.fake.sceneEvents;
  const flow = events
    .filter((e) => e.key === SCENE_TRIGGERS.FLOW_ABOVE)
    .map((e) => e.data.threshold);
  assert.deepEqual(flow, ['100', '150', '200', '300', '400', '500']);
  const danger = events
    .filter((e) => e.key === SCENE_TRIGGERS.DANGER_REACHED)
    .map((e) => e.data.level);
  assert.deepEqual(danger, ['2', '3']);
  assert.equal(events[0].data.device, BERN);
  // The same measurement again (the FOEN did not publish a newer one): nothing.
  await runMinutes(timers, clock, 10);
  assert.equal(gladys.fake.sceneEvents.length, events.length);
});

test('the trigger states survive a restart: nothing fires twice', async () => {
  const storage = memoryStorage();
  const { app, timers, clock, answers, gladys } = await setup({ storage, start: false });
  await app.start({ stations: '2135' });
  const high = (t) => () =>
    lindas([{ id: '2135', time: foenTime(t), discharge: 600, level: 503, danger: 4 }]);
  answers.values = high(clock.now);
  await runMinutes(timers, clock, 10);
  const fired = gladys.fake.sceneEvents.length;
  assert.ok(fired > 0);
  app.stop();
  const second = await setup({ storage, config: { stations: '2135' }, now: clock.now + 600_000 });
  second.answers.values = high(clock.now + 600_000);
  await runMinutes(second.timers, second.clock, 1);
  assert.equal(valueCalls().length, 1);
  assert.equal(second.gladys.fake.sceneEvents.length, 0);
});

test('names in the configuration are resolved from the station list', async () => {
  const { gladys } = await setup({ config: { stations: 'Rhône Porte du Scex, Rhein' } });
  const listCalls = fake.calls.filter((c) => /ld\.admin\.ch/.test(c.url) && !/VALUES/.test(c.body));
  assert.equal(listCalls.length, 1);
  assert.match(new URLSearchParams(valueCalls()[0].body).get('query'), /VALUES \?id \{ 2009 \}/);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    ['ext:swiss-hydro:station:2009'],
  );
  assert.match(status(gladys).message.en, /ambiguous, use the station number: Rhein/);
});

test('the search button', async () => {
  const { gladys } = await setup({ config: {} });
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /No station chosen/);
  const ack = await gladys.fake.action(ACTIONS.SEARCH, { query: 'rhein' });
  const text = msg(ack, 'en');
  assert.match(text, /2289: Rhein - Basel, Rheinhalle \(river\)/);
  assert.match(text, /2602: Rhein - Domat\/Ems/);
  const none = await gladys.fake.action(ACTIONS.SEARCH, { query: 'Mississippi' });
  assert.match(msg(none, 'fr'), /Aucune station/);
  assert.equal(
    fake.calls.filter((c) => !/VALUES/.test(c.body ?? '')).length,
    1,
    'the list is read once',
  );
});

test('the test button reads at most once a minute and shows every station', async () => {
  const { gladys, clock } = await setup();
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(valueCalls().length, 1, 'read less than a minute ago');
  const en = msg(ack, 'en');
  assert.match(
    en,
    /- 2135 Aare - Bern, Schönau: 57\.8 m³\/s, 501\.71 m, 15\.1 °C, official danger level 1\/5/,
  );
  assert.match(en, /hydrodaten map thresholds wl_1 to wl_4: 360 \/ 430 \/ 500 \/ 560 m³\/s/);
  assert.match(en, /measured 2026-10-18 05:30 CEST \(Swiss time\)/);
  assert.match(en, /- 520 Töss - Rämismühle: flow: unit unknown/);
  clock.now += 61_000;
  const again = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(valueCalls().length, 2);
  assert.match(msg(again, 'fr'), /mesure du 2026-10-18 05:30 CEST \(heure suisse\)/);
});

test('an old measurement is shown but never published', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  answers.values = () =>
    lindas([{ id: '2135', time: foenTime(clock.now - 5 * 3600_000), discharge: 60, level: 501 }]);
  await app.start({ stations: '2135' });
  await createAll(gladys);
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(status(gladys).connected, true, 'the read worked');
  assert.match(status(gladys).message.en, /0 with a current value/);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(msg(ack, 'en'), /too old, not published/);
  await runMinutes(timers, clock, 1);
});

test('swisshydroapi: one call per station, a 404 is a missing station', async () => {
  const { gladys } = await setup({
    config: { stations: '2135, 2206, 9999', source: 'swisshydroapi' },
  });
  const stationCalls = calls(/swisshydroapi\.bouni\.de\/api\/v1\/station\//);
  assert.deepEqual(
    stationCalls.map((c) => c.url.split('/').pop()),
    ['2135', '2206', '9999'],
  );
  assert.equal(valueCalls().length, 0, 'LINDAS is not called');
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  assert.match(status(gladys).message.en, /1 station\(s\) without data/);
  await createAll(gladys);
  assert.equal(gladys.fake.lastState('ext:swiss-hydro:station:2206:flow'), 0.015);
  // swisshydroapi has no danger level: none published, no feature.
  assert.equal(gladys.fake.lastState(`${BERN}:danger-level`), undefined);
  for (const device of gladys.fake.discoveredDevices) {
    assert.ok(!device.features.some((f) => f.external_id.endsWith(':danger-level')));
  }
});

test('a 429 of swisshydroapi stops the round, the stations read so far are kept', async () => {
  const { app, gladys, answers } = await setup({ start: false });
  answers.swiss = (id) =>
    id === '2135' ? json(fixture('swisshydroapi-2135.json')) : json({}, 429);
  await app.start({ stations: '2135, 2206, 2009', source: 'swisshydroapi' });
  assert.equal(calls(/bouni\.de\/api\/v1\/station\//).length, 2, 'stopped at the 429');
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.ok(app.state.pauses.has(HOSTS.SWISSHYDROAPI));
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /paused until/);
});

// --- Review round 1 -----------------------------------------------------------------

/** A swisshydroapi answer for one station at `ms`. */
const swissAt = (ms, flow) =>
  json({
    name: 'Bern, Schönau',
    'water-body-name': 'Aare',
    'water-body-type': 'river',
    parameters: {
      discharge: { unit: 'm3/s', datetime: foenTime(ms), value: flow },
      level: { unit: 'm', datetime: foenTime(ms), value: 503 },
    },
  });

test('swisshydroapi: a flood fires the flow marks, never a danger level', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  await app.start({ stations: '2135', source: 'swisshydroapi' });
  answers.swiss = () => swissAt(clock.now - 60_000, 900);
  await runMinutes(timers, clock, 10);
  const keys = new Set(gladys.fake.sceneEvents.map((e) => e.key));
  assert.ok(keys.has(SCENE_TRIGGERS.FLOW_ABOVE));
  assert.ok(!keys.has(SCENE_TRIGGERS.DANGER_REACHED));
});

test('restart loops: a station without data, then a 503, read once per interval at most', async () => {
  const storage = memoryStorage();
  const config = { stations: '2135, 7777' };
  let s = await setup({ storage, config });
  let total = valueCalls().length;
  assert.equal(total, 1);
  assert.match(status(s.gladys).message.en, /1 station\(s\) without data/);
  for (let k = 0; k < 8; k += 1) {
    s.app.stop();
    s = await setup({ storage, config, now: s.clock.now + 60_000 });
    total += valueCalls().length;
  }
  assert.equal(total, 1, '8 restarts in 8 minutes: no new read');
  s.app.stop();
  s = await setup({ storage, config, now: s.clock.now + 2 * 60_000 });
  total += valueCalls().length;
  assert.equal(total, 2, 'read again once the interval passed');
  // A 503, then restarts with a station added: still the interval.
  s.answers.values = () => json({}, 503);
  await runMinutes(s.timers, s.clock, 10);
  total += valueCalls().length - 1;
  assert.equal(total, 3);
  const more = { stations: '2135, 7777, 2009' };
  for (let k = 0; k < 9; k += 1) {
    s.app.stop();
    s = await setup({ storage, config: more, now: s.clock.now + 60_000 });
    total += valueCalls().length;
  }
  assert.equal(total, 3, 'after a failure, a new station waits the interval too');
  s.app.stop();
  await setup({ storage, config: more, now: s.clock.now + 60_000 });
  total += valueCalls().length;
  assert.equal(total, 4);
});

test('swisshydroapi: a failing station is noted and the round goes on; 3 network failures stop it', async () => {
  const { app, gladys, answers } = await setup({ start: false });
  const down = () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  };
  answers.swiss = (id) =>
    id === '2135'
      ? down()
      : id === '2206'
        ? json(fixture('swisshydroapi-2206.json'))
        : json({}, 404);
  await app.start({ stations: '2135, 2206, 2009', source: 'swisshydroapi' });
  assert.equal(calls(/bouni\.de\/api\/v1\/station\//).length, 3, 'the round went on');
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.en, /1 station\(s\) not read this time \(network error\)/);
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(msg(ack, 'en'), /- 2135: network error/);
  // The host is down: the round stops after three failures in a row.
  const second = await setup({ start: false });
  second.answers.swiss = down;
  await second.app.start({ stations: '2135, 2206, 2009, 2043, 2044', source: 'swisshydroapi' });
  assert.equal(calls(/bouni\.de\/api\/v1\/station\//).length, 3);
  assert.equal(second.app.lastError.kind, 'network');
  assert.equal(status(second.gladys).connected, false);
});

test('scene events Gladys refuses are queued, persisted, replayed, and dropped after 30 minutes', async () => {
  const storage = memoryStorage();
  const { app, gladys, timers, clock, answers } = await setup({ storage, start: false });
  await app.start({ stations: '2135' });
  gladys.publishSceneEvent = async () => {
    throw new Error('Gladys restarting');
  };
  answers.values = () =>
    lindas([{ id: '2135', time: foenTime(clock.now - 60_000), discharge: 160, danger: 1 }]);
  await runMinutes(timers, clock, 10);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  assert.equal(app.state.pendingEvents.length, 2, '100 and 150');
  assert.equal(storage.load().pendingEvents.length, 2, 'persisted');
  // Gladys is back: the next tick sends them, in order, once.
  delete gladys.publishSceneEvent;
  await runMinutes(timers, clock, 1);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => e.data.threshold),
    ['100', '150'],
  );
  assert.equal(app.state.pendingEvents.length, 0);
  // Refused for more than 30 minutes: dropped, never sent late.
  gladys.publishSceneEvent = async () => {
    throw new Error('Gladys down');
  };
  answers.values = () =>
    lindas([{ id: '2135', time: foenTime(clock.now - 60_000), discharge: 210, danger: 1 }]);
  await runMinutes(timers, clock, 10);
  assert.equal(app.state.pendingEvents.length, 1);
  await runMinutes(timers, clock, 31);
  delete gladys.publishSceneEvent;
  await runMinutes(timers, clock, 1);
  assert.equal(gladys.fake.sceneEvents.length, 2, 'the late one was dropped');
  assert.equal(app.state.pendingEvents.length, 0);
});

test('an older or aberrant reading keeps the previous one', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  await app.start({ stations: '2135' });
  answers.values = () =>
    lindas([{ id: '2135', time: foenTime(FIXTURE_NOW - 2 * 3600_000), discharge: 99, level: 500 }]);
  await runMinutes(timers, clock, 10);
  assert.equal(app.state.readings.get('2135').flow, 57.783);
  answers.values = () =>
    lindas([{ id: '2135', time: '2025-01-01T00:00:00+01:00', discharge: 99, level: 500 }]);
  await runMinutes(timers, clock, 10);
  assert.equal(app.state.readings.get('2135').flow, 57.783);
  assert.ok(!app.missing.has('2135'), 'still counted as read');
  assert.doesNotMatch(status(gladys).message.en, /without data/);
});

test('the thresholds layer: refused without any unit, merged without losing a unit', async () => {
  const { app, gladys, answers, clock, timers } = await setup({ start: false });
  answers.thresholds = () => json({ features: [{ properties: { key: '2135', metric: 'nope' } }] });
  await app.start({ stations: '2135' });
  assert.ok(app.state.meta.failedAt > 0, 'refused');
  assert.match(
    status(gladys).message.en,
    /thresholds layer of hydrodaten\.admin\.ch is unavailable: no flow/,
  );
  assert.match(status(gladys).message.fr, /pas de débit ni de seuils avec la source OFEV/);
  // A good layer, then a day later one without Bern: its unit stays.
  answers.thresholds = () => json(fixture('thresholds.geojson'));
  clock.now += 3600_000;
  await timers.runIntervals();
  assert.equal(app.state.meta.stations.get('2135').flowUnit, 'm3/s');
  const partial = fixture('thresholds.geojson');
  partial.features = partial.features.filter((f) => f.properties.key !== '2135');
  answers.thresholds = () => json(partial);
  clock.now += 24 * 3600_000 + 60_000;
  await timers.runIntervals();
  assert.equal(app.state.meta.failedAt, 0, 'accepted');
  assert.equal(app.state.meta.stations.get('2135').flowUnit, 'm3/s', 'kept');
  assert.equal(
    app.state.meta.stations.get('2135').thresholds,
    null,
    'thresholds from the fresh layer only',
  );
});

test('a configuration Gladys does not give: error status, retried by a timer, more and more spaced', async () => {
  const { app, gladys, timers, clock } = await setup({ start: false });
  let failures = 2;
  const load = async () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('timeout');
    }
    return { stations: '2135' };
  };
  await app.connect(load);
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /configuration could not be read from Gladys/);
  assert.deepEqual(
    timers.timeouts().map((t) => t.ms),
    [60_000],
  );
  clock.now += 60_000;
  await timers.runTimeouts();
  assert.deepEqual(
    timers.timeouts().map((t) => t.ms),
    [120_000],
  );
  assert.equal(valueCalls().length, 0);
  clock.now += 120_000;
  await timers.runTimeouts();
  assert.equal(timers.timeouts().length, 0);
  assert.equal(valueCalls().length, 1);
  assert.equal(status(gladys).connected, true);
  // A disconnection cancels a pending retry.
  failures = 1;
  await app.connect(load);
  assert.equal(timers.timeouts().length, 1);
  app.stop();
  assert.equal(timers.timeouts().length, 0);
});

test('a scene event Gladys refuses for good is dropped at once, the queue goes on', async () => {
  const { app, gladys, timers, clock, answers } = await setup({ start: false });
  await app.start({ stations: '2135' });
  let refused = 0;
  const original = gladys.publishSceneEvent.bind(gladys);
  gladys.publishSceneEvent = async (key, data) => {
    if (data.threshold === '100') {
      refused += 1;
      const err = new Error('bad payload');
      err.status = 400;
      throw err;
    }
    return original(key, data);
  };
  answers.values = () =>
    lindas([{ id: '2135', time: foenTime(clock.now - 60_000), discharge: 160, danger: 1 }]);
  await runMinutes(timers, clock, 10);
  assert.equal(refused, 1, 'tried once, never again');
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => e.data.threshold),
    ['150'],
    'the next one was not blocked',
  );
  assert.equal(app.state.pendingEvents.length, 0);
  await runMinutes(timers, clock, 1);
  assert.equal(refused, 1);
});
