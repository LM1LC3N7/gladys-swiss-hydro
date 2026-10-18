// -----------------------------------------------------------------------------
// The integration itself: the stations to read, when each read is due, the
// Gladys devices and states built from the readings, the scene events, the
// connection status and the two buttons. index.js only wires the SDK
// handlers to it.
//
// Pacing: one read of the values per interval (10 minutes at least, the
// FOEN measures every 10 minutes), whatever happens: a failure, a 429, a
// restart of the container (the instant of the last read is persisted) or a
// reconnection to Gladys never makes it read sooner. The thresholds layer is
// read once a day, the station list (search by name) once a week; when they
// fail, the values go on without them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { HydroClient, HydroError } from './client.js';
import { normalizeConfig } from './config.js';
import {
  HEARTBEAT,
  HOSTS,
  LIST_RETRY,
  LIST_TTL,
  MAX_STATIONS,
  MIN_READ_GAP,
  SOURCES,
  STATION_CALL_GAP,
  TEST_DEADLINE,
  THRESHOLDS_RETRY,
  THRESHOLDS_TTL,
  TICK,
} from './constants.js';
import { SOURCE_NAMES, T, reason } from './i18n.js';
import {
  deviceOf,
  foenReading,
  idsOf,
  isFresh,
  labelOf,
  parseLindasObservations,
  parseLindasStations,
  parseSwissStations,
  parseThresholds,
  searchStations,
  statesOf,
  swissReading,
  swissTime,
  valuesOf,
} from './model.js';
import { searchable } from './config.js';
import { emptyState, loadState, memoryStorage, saveState } from './store.js';
import { newTriggerState, stationEvents } from './triggers.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };

/** 12.345 -> "12.3"; "12,3" in French. */
const numberText = (value, lang, digits = 1) => {
  const text = String(Math.round(value * 10 ** digits) / 10 ** digits);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const hostOf = (source) => (source === SOURCES.SWISSHYDROAPI ? HOSTS.SWISSHYDROAPI : HOSTS.LINDAS);

export class HydroApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'swiss-hydro' }),
    now = Date.now,
    timers = defaultTimers,
    storage = memoryStorage(),
    sleep,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.storage = storage;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)));
    let raw;
    try {
      raw = storage.load();
    } catch {
      raw = undefined;
    }
    this.state = raw ? loadState(raw, now()) : emptyState();
    // The client and its pauses live as long as the process: a reconnection
    // to Gladys or a new configuration never clears a 429 pause.
    this.client = new HydroClient({
      pauses: this.state.pauses,
      now,
      onChange: () => this.save(),
    });
    this.config = normalizeConfig();
    this.stations = [];
    this.unresolved = [];
    this.dropped = 0;
    this.missing = new Set();
    this.lastError = undefined;
    this.nextRead = 0;
    this.interval = undefined;
    this.ticking = undefined;
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
    this.started = false;
  }

  save() {
    try {
      this.storage.save(saveState(this.state));
    } catch (err) {
      this.logger.warn(`State not saved: ${err.message}`);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    const previous = this.started ? this.config : undefined;
    this.config = normalizeConfig(raw);
    this.started = true;
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again on every start.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    this.resolveStations();
    this.scheduleRead(previous);
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${err.message}`)),
      TICK,
    );
    await this.publishDiscovered();
    await this.refreshStatus();
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /**
   * When the values are read next. Never before the interval since the last
   * read (persisted), except for a station never read or another source,
   * read at once, but still never closer than a minute to the last read.
   */
  scheduleRead(previous) {
    const { lastReadAt } = this.state;
    const interval = this.config.pollMinutes * 60_000;
    const unread = this.stations.some((id) => !this.state.readings.has(id));
    const otherSource = previous && previous.source !== this.config.source;
    this.nextRead = lastReadAt + (unread || otherSource ? MIN_READ_GAP : interval);
  }

  // --- The stations ---------------------------------------------------------------

  /** The station numbers of the configuration, the names found in the station list. */
  resolveStations() {
    const ids = [...this.config.ids];
    const unresolved = [];
    const list = this.state.list.source === this.config.source ? this.state.list.stations : [];
    for (const name of this.config.names) {
      let matches = searchStations(list, name);
      if (matches.length > 1) {
        // "Bern" matches several: an exact label wins.
        const exact = matches.filter(
          (s) =>
            searchable(labelOf(s)) === searchable(name) || searchable(s.name) === searchable(name),
        );
        matches = exact;
      }
      if (matches.length === 1) {
        if (!ids.includes(matches[0].id)) {
          ids.push(matches[0].id);
        }
      } else {
        unresolved.push(name);
      }
    }
    this.dropped = Math.max(0, ids.length - MAX_STATIONS);
    this.stations = ids.slice(0, MAX_STATIONS);
    this.unresolved = unresolved;
  }

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read what is due (a tick never overlaps another). */
  tick() {
    if (this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const previous = this.ticking ?? Promise.resolve();
    const generation = this.generation;
    const run = previous
      .catch(() => {})
      .then(() => this.readDue(generation))
      .finally(() => {
        if (this.ticking === run) {
          this.ticking = undefined;
        }
      });
    this.ticking = run;
    this.tickGeneration = generation;
    return run;
  }

  async readDue(generation, { force = false } = {}) {
    if (generation !== this.generation) {
      return;
    }
    const now = this.now();
    let changed = false;
    if (this.listDue(now)) {
      await this.readList();
      const before = this.stations.join(',');
      this.resolveStations();
      if (this.stations.join(',') !== before) {
        // A name found: its station is read at once (a minute after the last read).
        this.nextRead = Math.min(this.nextRead, this.state.lastReadAt + MIN_READ_GAP);
      }
      changed = true;
    }
    if (generation !== this.generation) {
      return;
    }
    if (this.stations.length > 0 && this.thresholdsDue(now)) {
      await this.readThresholds();
      changed = true;
    }
    if (generation !== this.generation) {
      return;
    }
    const readNow =
      this.stations.length > 0 &&
      (force ? now >= this.state.lastReadAt + MIN_READ_GAP : now >= this.nextRead);
    const pausedUntil = this.client.pausedUntil(hostOf(this.config.source));
    if (readNow && !pausedUntil) {
      await this.readValues(generation);
      changed = true;
    } else if (readNow && !force) {
      // Paused (429): the read waits for the end of the pause, and never
      // comes sooner than the interval.
      this.nextRead = Math.max(now + this.intervalMs(), pausedUntil);
    }
    if (changed && generation === this.generation) {
      await this.publish();
      await this.refreshStatus();
    }
  }

  listDue(now) {
    const { list } = this.state;
    if (this.config.names.length === 0) {
      return false;
    }
    const fresh = list.source === this.config.source && now - list.fetchedAt < LIST_TTL;
    const retry = list.failedAt + Math.max(LIST_RETRY, this.intervalMs());
    return !fresh && now >= retry;
  }

  thresholdsDue(now) {
    const { meta } = this.state;
    const retry = meta.failedAt + Math.max(THRESHOLDS_RETRY, this.intervalMs());
    return now - meta.fetchedAt >= THRESHOLDS_TTL && now >= retry;
  }

  /** The station list of the current source (search by name); never throws. */
  async readList() {
    const source = this.config.source;
    try {
      const stations =
        source === SOURCES.SWISSHYDROAPI
          ? parseSwissStations(await this.client.swissStations())
          : parseLindasStations(await this.client.lindasStations());
      if (stations.length === 0) {
        throw new HydroError('answer', hostOf(source), 'empty station list');
      }
      this.state.list = {
        source,
        fetchedAt: this.now(),
        failedAt: 0,
        stations,
      };
    } catch (err) {
      this.state.list.failedAt = this.now();
      this.logger.warn(`Station list failed: ${err.message}`);
    }
    this.save();
  }

  /** The danger thresholds and discharge units; a failure never stops the values. */
  async readThresholds() {
    try {
      const stations = parseThresholds(await this.client.thresholds());
      if (stations.size === 0) {
        throw new HydroError('answer', HOSTS.HYDRODATEN, 'no station');
      }
      this.state.meta = { fetchedAt: this.now(), failedAt: 0, stations };
    } catch (err) {
      this.state.meta.failedAt = this.now();
      this.logger.warn(`Thresholds layer failed (the values go on without it): ${err.message}`);
    }
    this.save();
  }

  /** Read the values of every station; never throws. */
  async readValues(generation) {
    const now = this.now();
    this.state.lastReadAt = now;
    this.nextRead = now + this.intervalMs();
    let readings;
    try {
      readings =
        this.config.source === SOURCES.SWISSHYDROAPI
          ? await this.readSwissHydroApi(generation)
          : await this.readFoen();
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof HydroError ? err : new HydroError('network', '?', 'failed');
      if (this.lastError.kind === 'limited') {
        this.nextRead = Math.max(this.nextRead, this.client.pausedUntil(this.lastError.host));
      }
      this.logger.warn(`Read failed: ${err.message}`);
      readings = err.partial ?? new Map();
    }
    if (generation !== this.generation) {
      return;
    }
    if (!this.lastError) {
      this.missing = new Set(this.stations.filter((id) => !readings.has(id)));
    }
    for (const [id, reading] of readings) {
      await this.accept(id, reading);
    }
    this.save();
  }

  async readFoen() {
    const body = await this.client.observations(this.stations);
    const raws = parseLindasObservations(body, this.now());
    const readings = new Map();
    for (const id of this.stations) {
      const raw = raws.get(id);
      if (raw) {
        readings.set(id, foenReading(raw, this.state.meta.stations.get(id)));
      }
    }
    return readings;
  }

  /** One call per station, a second apart; a 429 stops the round. */
  async readSwissHydroApi(generation) {
    const readings = new Map();
    for (const [i, id] of this.stations.entries()) {
      if (generation !== this.generation) {
        break;
      }
      if (i > 0) {
        await this.sleep(STATION_CALL_GAP);
      }
      try {
        const body = await this.client.swissStation(id);
        readings.set(id, swissReading(id, body, this.state.meta.stations.get(id), this.now()));
      } catch (err) {
        if (err instanceof HydroError && err.kind === 'not_found') {
          continue;
        }
        err.partial = readings;
        throw err;
      }
    }
    return readings;
  }

  /** A new reading of a station: kept, its features remembered, its triggers checked. */
  async accept(id, reading) {
    const previous = this.state.readings.get(id);
    this.state.readings.set(id, reading);
    const known = this.state.known.get(id) ?? new Set();
    for (const key of valuesOf(reading, this.state.meta.stations.get(id)).keys()) {
      known.add(key);
    }
    this.state.known.set(id, known);
    // A measurement already seen (the FOEN did not publish a newer one) or
    // too old to be current fires nothing.
    const isNew = !previous || !(reading.time <= previous.time);
    if (!isFresh(reading, this.now()) || !isNew) {
      return;
    }
    const { state, events } = stationEvents(
      this.state.triggers.get(id) ?? newTriggerState(),
      reading,
      idsOf(this.gladys, id).device,
    );
    this.state.triggers.set(id, state);
    for (const event of events) {
      await this.gladys
        .publishSceneEvent(event.key, event.data)
        .catch((err) => this.logger.warn(`Scene event ${event.key} failed: ${err.message}`));
    }
  }

  // --- Gladys devices and states --------------------------------------------------

  /** The feature keys of the device the user created for a station. */
  createdKeys(id) {
    const ids = idsOf(this.gladys, id);
    const prefix = `${ids.device}:`;
    const keys = new Set();
    for (const device of this.gladys.devices ?? []) {
      if (device.external_id !== ids.device) {
        continue;
      }
      for (const feature of device.features ?? []) {
        const externalId = String(feature.external_id ?? '');
        if (externalId.startsWith(prefix)) {
          keys.add(externalId.slice(prefix.length));
        }
      }
    }
    return keys;
  }

  /** The devices of the configured stations already read. */
  devices() {
    const devices = [];
    for (const id of this.stations) {
      const reading = this.state.readings.get(id);
      if (!reading) {
        continue;
      }
      const keys = new Set([
        ...(this.state.known.get(id) ?? []),
        ...this.createdKeys(id),
        ...valuesOf(reading, this.state.meta.stations.get(id)).keys(),
      ]);
      const device = deviceOf(this.gladys, reading, keys);
      if (device.features.length > 0) {
        devices.push(device);
      }
    }
    return devices;
  }

  async publish() {
    await this.publishDiscovered();
    await this.publishStates();
  }

  /** The Discovery tab, published again only when it changed (or on demand). */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** The current values of the created features, only what changed (plus a heartbeat). */
  async publishStates() {
    const created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        created.add(feature.external_id);
      }
    }
    if (created.size === 0) {
      return;
    }
    const now = this.now();
    const states = this.stations
      .map((id) => this.state.readings.get(id))
      .filter((reading) => reading && isFresh(reading, now))
      .flatMap((reading) =>
        statesOf(this.gladys, reading, this.state.meta.stations.get(reading.id)),
      )
      .filter((state) => created.has(state.device_feature_external_id));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: HEARTBEAT });
    } catch (err) {
      this.logger.warn(`Publishing the states failed: ${err.message}`);
    }
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  freshCount() {
    const now = this.now();
    return this.stations.filter((id) => isFresh(this.state.readings.get(id), now)).length;
  }

  notes() {
    const notes = [];
    if (this.unresolved.length > 0) {
      notes.push(T.unresolved(this.unresolved));
    }
    if (this.dropped > 0) {
      notes.push(T.tooMany(MAX_STATIONS));
    }
    const missing = this.stations.filter((id) => this.missing.has(id)).length;
    if (missing > 0) {
      notes.push(T.notFound(missing));
    }
    const unknownUnit = this.stations.filter(
      (id) => this.state.readings.get(id)?.flowUnit === 'unknown',
    ).length;
    if (unknownUnit > 0) {
      notes.push(T.unknownUnit(unknownUnit));
    }
    return notes;
  }

  join(texts) {
    return {
      en: texts.map((t) => t.en).join(' '),
      fr: texts.map((t) => t.fr).join(' '),
    };
  }

  async refreshStatus() {
    if (this.stations.length === 0) {
      return this.setStatus(
        false,
        this.join(this.unresolved.length > 0 ? this.notes() : [T.noStation]),
      );
    }
    const fresh = this.freshCount();
    const texts = [];
    const pausedUntil = this.client.pausedUntil(hostOf(this.config.source));
    if (pausedUntil) {
      texts.push(T.paused(pausedUntil));
    } else if (this.lastError) {
      texts.push(T.failed(reason(this.lastError.kind)));
    }
    texts.push(
      T.ok({
        stations: this.stations.length,
        interval: this.config.pollMinutes,
        source: SOURCE_NAMES[this.config.source],
        fresh,
      }),
    );
    texts.push(...this.notes());
    const connected = fresh > 0 || (!this.lastError && !pausedUntil);
    return this.setStatus(connected, this.join(texts));
  }

  // --- The configuration screen buttons -------------------------------------------------

  line(id, lang) {
    const reading = this.state.readings.get(id);
    const colon = lang === 'fr' ? ' :' : ':';
    if (!reading) {
      const why = this.missing.has(id)
        ? reason('missing')[lang]
        : lang === 'fr'
          ? 'pas encore lue'
          : 'not read yet';
      return `- ${id}${colon} ${why}`;
    }
    const meta = this.state.meta.stations.get(id);
    const parts = [];
    if (reading.flow !== null) {
      parts.push(`${numberText(reading.flow, lang, reading.flow < 10 ? 3 : 1)} m³/s`);
    } else if (reading.flowUnit === 'unknown') {
      parts.push(lang === 'fr' ? 'débit : unité inconnue' : 'flow: unit unknown');
    }
    if (reading.level !== null) {
      parts.push(`${numberText(reading.level, lang, 2)} m`);
    }
    if (reading.temperature !== null) {
      parts.push(`${numberText(reading.temperature, lang)} °C`);
    }
    if (reading.danger !== null) {
      parts.push(lang === 'fr' ? `danger ${reading.danger}/5` : `danger level ${reading.danger}/5`);
    }
    if (meta?.thresholds) {
      const unit = meta.metric === 'flow' ? 'm³/s' : 'm';
      const values = meta.thresholds.map((t) => numberText(t, lang, 2)).join(' / ');
      parts.push(
        lang === 'fr'
          ? `seuils des degrés 2 à 5 : ${values} ${unit}`
          : `thresholds of levels 2 to 5: ${values} ${unit}`,
      );
    }
    if (Number.isFinite(reading.time) && !reading.aberrant) {
      parts.push(
        lang === 'fr'
          ? `mesure du ${swissTime(reading.time)} (heure suisse)`
          : `measured ${swissTime(reading.time)} (Swiss time)`,
      );
      if (!isFresh(reading, this.now())) {
        parts.push(lang === 'fr' ? 'trop ancienne, non publiée' : 'too old, not published');
      }
    } else {
      parts.push(lang === 'fr' ? 'date aberrante, non publiée' : 'aberrant date, not published');
    }
    return `- ${id} ${labelOf(reading)}${colon} ${parts.join(', ')}`;
  }

  /** Run `work`, but stop waiting at `deadline`. */
  async before(deadline, work) {
    const left = deadline - this.now();
    if (left <= 0) {
      return;
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, left);
    });
    try {
      await Promise.race([work(), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** "Test": read now (never closer than a minute to the last read), show every station. */
  async testConnection() {
    const deadline = this.now() + TEST_DEADLINE;
    await this.before(deadline, () => this.tickForced());
    const en = [];
    const fr = [];
    if (this.stations.length === 0) {
      const text = this.join(this.unresolved.length > 0 ? this.notes() : [T.noStation]);
      return text;
    }
    const pausedUntil = this.client.pausedUntil(hostOf(this.config.source));
    if (pausedUntil) {
      en.push(T.paused(pausedUntil).en);
      fr.push(T.paused(pausedUntil).fr);
    } else if (this.lastError) {
      en.push(T.failed(reason(this.lastError.kind)).en);
      fr.push(T.failed(reason(this.lastError.kind)).fr);
    }
    const source = SOURCE_NAMES[this.config.source];
    en.push(`Stations (${source.en}, read every ${this.config.pollMinutes} min):`);
    fr.push(`Stations (${source.fr}, lues toutes les ${this.config.pollMinutes} min) :`);
    for (const id of this.stations) {
      en.push(this.line(id, 'en'));
      fr.push(this.line(id, 'fr'));
    }
    for (const note of this.notes()) {
      en.push(note.en);
      fr.push(note.fr);
    }
    return { en: en.join('\n'), fr: fr.join('\n') };
  }

  /** A tick that reads the values now if the last read is more than a minute old. */
  tickForced() {
    const generation = this.generation;
    const previous = this.ticking ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.readDue(generation, { force: true }))
      .finally(() => {
        if (this.ticking === run) {
          this.ticking = undefined;
        }
      });
    this.ticking = run;
    this.tickGeneration = generation;
    return run;
  }

  /** "Search stations": the stations whose number, name or water body match. */
  async search(fields = {}) {
    const query = String(fields?.query ?? '')
      .trim()
      .slice(0, 80);
    if (!searchable(query)) {
      return {
        en: 'Type a few letters of a river, a lake or a place.',
        fr: "Tapez quelques lettres d'une rivière, d'un lac ou d'un lieu.",
      };
    }
    const { list } = this.state;
    const now = this.now();
    const usable = list.source === this.config.source && list.stations.length > 0;
    const stale = !usable || now - list.fetchedAt >= LIST_TTL;
    // A click may read the list again, but never within a minute of a failure.
    if (stale && now >= list.failedAt + MIN_READ_GAP) {
      await this.before(now + TEST_DEADLINE, () => this.readList());
      const before = this.stations.join(',');
      this.resolveStations();
      if (this.stations.join(',') !== before) {
        // A name of the configuration found: read it at the next tick.
        this.nextRead = Math.min(this.nextRead, this.state.lastReadAt + MIN_READ_GAP);
      }
    }
    const stations = this.state.list.source === this.config.source ? this.state.list.stations : [];
    if (stations.length === 0) {
      const pausedUntil = this.client.pausedUntil(hostOf(this.config.source));
      return pausedUntil
        ? T.paused(pausedUntil)
        : {
            en: 'The station list could not be read: try again later.',
            fr: "La liste des stations n'a pas pu être lue : réessayez plus tard.",
          };
    }
    const matches = searchStations(stations, query);
    if (matches.length === 0) {
      return {
        en: `No station matches "${query}".`,
        fr: `Aucune station ne correspond à « ${query} ».`,
      };
    }
    const kind = (s, lang) =>
      s.kind === 'lake'
        ? lang === 'fr'
          ? ' (lac)'
          : ' (lake)'
        : s.kind === 'river'
          ? lang === 'fr'
            ? ' (cours d’eau)'
            : ' (river)'
          : '';
    const shown = matches.slice(0, 15);
    const more = matches.length - shown.length;
    const lines = (lang) => [
      ...shown.map((s) => `- ${s.id}: ${labelOf(s)}${kind(s, lang)}`),
      ...(more > 0 ? [lang === 'fr' ? `… et ${more} de plus.` : `… and ${more} more.`] : []),
    ];
    return {
      en: [`Copy the number into "Stations":`, ...lines('en')].join('\n'),
      fr: ['Copiez le numéro dans « Stations » :', ...lines('fr')].join('\n'),
    };
  }
}
