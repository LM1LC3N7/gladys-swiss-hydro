// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake and a BOM (a manifest once shipped broken).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ACTIONS, FLOW_THRESHOLDS, SCENE_TRIGGERS, SOURCES } from '../src/constants.js';
import { FEATURE_DEFS, deviceOf } from '../src/model.js';
import { newTriggerState, stationEvents } from '../src/triggers.js';

const readBuffer = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const read = (path) => readBuffer(path).toString('utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('no mojibake and no BOM in the manifest, the docs and the code', () => {
  const files = [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'THIRD_PARTY_NOTICES.md',
    'index.js',
    ...readdirSync(new URL('../src/', import.meta.url))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `src/${name}`),
    ...readdirSync(new URL('../test/fixtures/', import.meta.url)).map((n) => `test/fixtures/${n}`),
  ];
  assert.ok(files.length > 20, 'every source file is checked');
  for (const file of files) {
    const buffer = readBuffer(file);
    assert.ok(
      !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    const text = buffer.toString('utf8');
    assert.ok(!text.includes('�'), `${file} holds an invalid UTF-8 sequence`);
    for (const bad of ['Ã', 'Â', 'â€']) {
      assert.ok(!text.includes(bad), `${file} holds mojibake (${bad})`);
    }
    // Combining marks only as \u escapes (a regex class of them is invisible).
    assert.doesNotMatch(text, /[\u0300-\u036f]/, `${file} holds a bare combining mark`);
  }
  // The French texts really hold their accents.
  assert.match(read('docs/fr.md'), /é/);
  assert.match(manifest.config_schema[0].description.fr, /température/);
});

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /swisshydrodata/, `docs/${lang}.md credits swisshydrodata`);
    assert.match(docs, /LINDAS/);
  }
  assert.match(read('docs/en.md'), /never been tested/i);
  assert.match(read('docs/fr.md'), /jamais été test/i);
  assert.match(read('docs/en.md'), /Source: FOEN/);
  assert.match(read('docs/fr.md'), /Source : OFEV/);
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  assert.match(manifest.config_schema[0].description.en, /not affiliated with the Swiss Federal/);
});

test('version 0.1.0 everywhere, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-swiss-hydro:${manifest.version}`);
});

test('the license and the notices ship with the image, without any name in LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the bare template');
  assert.doesNotMatch(license, /Louis|lmilcent|LM1LC3N7|Bouni/i);
  assert.equal(pkg.license, 'Apache-2.0');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /swisshydrodata/);
  assert.match(notices, /Copyright \(c\) 2018 Bouni/);
  assert.match(notices, /Permission is hereby granted/);
  assert.match(notices, /FOEN|OFEV/);
  assert.match(notices, /opendata\.swiss/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('sections are purely presentational, with https links', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} is too long`);
    }
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(fields[key]?.default, value, key);
  }
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, field.key);
    }
  }
  assert.deepEqual(fields.source.options.map((o) => o.value).sort(), Object.values(SOURCES).sort());
  // The FOEN measures every 10 minutes: never read faster.
  assert.equal(fields.poll_interval.min, 10);
  assert.ok(fields.poll_interval.default >= 10 && fields.poll_interval.default <= 15);
  // No account, no secret.
  assert.ok(!manifest.config_schema.some((f) => f.type === 'secret'));
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onAction(ACTIONS.SEARCH'));
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds <= 120);
  }
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});

test('the scene triggers: their filters and variables are what the events carry', () => {
  const triggers = Object.fromEntries(manifest.scene_triggers.map((t) => [t.key, t]));
  const flow = triggers[SCENE_TRIGGERS.FLOW_ABOVE];
  assert.deepEqual(
    flow.fields.find((f) => f.key === 'threshold').options.map((o) => Number(o.value)),
    FLOW_THRESHOLDS,
  );
  const danger = triggers[SCENE_TRIGGERS.DANGER_REACHED];
  assert.deepEqual(
    danger.fields.find((f) => f.key === 'level').options.map((o) => o.value),
    ['2', '3', '4', '5'],
  );
  for (const trigger of manifest.scene_triggers) {
    assert.equal(trigger.fields.find((f) => f.key === 'device').source, 'devices');
    assert.ok(trigger.key.length <= 40);
    assert.ok(trigger.fields.length <= 10 && trigger.variables.length <= 20);
  }
  // Fire both, and check every declared key is in the event data.
  let state = newTriggerState();
  const base = { id: '2135', name: 'Bern', waterBody: 'Aare', level: 500, time: Date.now() };
  ({ state } = stationEvents(state, { ...base, flow: 10, danger: 1 }, 'ext:x:station:2135'));
  const { events } = stationEvents(state, { ...base, flow: 600, danger: 3 }, 'ext:x:station:2135');
  for (const key of Object.values(SCENE_TRIGGERS)) {
    const event = events.find((e) => e.key === key);
    assert.ok(event, key);
    for (const declared of [...triggers[key].fields, ...triggers[key].variables]) {
      assert.ok(declared.key in event.data, `${key}.${declared.key}`);
    }
    for (const sent of Object.keys(event.data)) {
      const declared = [...triggers[key].fields, ...triggers[key].variables].some(
        (d) => d.key === sent,
      );
      assert.ok(declared, `${key}: ${sent} is sent but not declared`);
    }
  }
});

// DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js (Gladys core),
// for the categories this integration uses; `text` and `unknown` have no unit.
const CORE_UNITS = {
  'level-sensor': ['mm', 'cm', 'm', 'km', 'inch', 'feet', 'mile', 'percent'],
  'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  text: [],
  unknown: [],
};

test('every feature uses a unit the core lists for its category', () => {
  const gladys = createFakeGladys({ selector: 'swiss-hydro' });
  const device = deviceOf(
    gladys,
    { id: '2135', name: 'Bern', waterBody: 'Aare' },
    new Set(FEATURE_DEFS.keys()),
  );
  assert.equal(device.features.length, FEATURE_DEFS.size);
  for (const feature of device.features) {
    assert.ok(feature.category in CORE_UNITS, `${feature.category} is not checked`);
    const allowed = CORE_UNITS[feature.category];
    if (allowed.length === 0) {
      assert.equal(feature.unit, undefined, feature.external_id);
    } else {
      assert.ok(allowed.includes(feature.unit), `${feature.external_id}: ${feature.unit}`);
    }
    // Never a switch: an "everything off" must never reach this integration.
    assert.ok(!['switch', 'binary'].includes(feature.category));
    assert.equal(feature.read_only, true);
  }
});
