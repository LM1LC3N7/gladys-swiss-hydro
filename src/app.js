// -----------------------------------------------------------------------------
// The integration itself: the stations to read, when each read is due, the
// Gladys devices and states built from the readings, the scene events, the
// connection status and the two buttons. index.js only wires the SDK
// handlers to it.
//
// Pacing: one read of the values per interval (10 minutes at least, the
// FOEN measures every 10 minutes), whatever happens: a failure, a 429, a
// restart of the container (the instant, the outcome, the source and the
// stations of the last read are persisted) or a reconnection to Gladys never
// makes it read sooner. The thresholds layer is read once a day, the station
// list (search by name) once a week; when they fail, the values go on
// without them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { HydroClient, HydroError } from './client.js';
import { normalizeConfig, searchable } from './config.js';
import {
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  EVENT_QUEUE_TTL,
  HEARTBEAT,
  HOSTS,
  LIST_RETRY,
  LIST_TTL,
  MAX_NETWORK_FAILURES,
  MAX_PENDING_EVENTS,
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
  mergeThresholds,
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
    /** id -> HydroError kind, the stations of the last round that failed alone. */
    this.stationErrors = new Map();
    this.lastError = undefined;
    this.nextRead = 0;
    this.interval = undefined;
    this.ticking = undefined;
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
    this.retryTimer = undefined;
    this.retryDelay = 0;
  }

  save() {
    try {
      this.storage.save(saveState(this.state));
    } catch (err) {
      this.logger.warn(`State not saved: ${err.message}`);
    }
  }

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * A (re)connection to Gladys: read the configuration, then start. When
   * Gladys does not give it, an error status, and a new try after 1 minute,
   * then 2, 4... up to 30 minutes (never a dead integration).
   */
  async connect(loadConfig) {
    this.cancelRetry();
    let config;
    try {
      config = await loadConfig();
    } catch (err) {
      this.logger.warn(`Configuration not read: ${err.message}`);
      this.retryDelay = this.retryDelay
        ? Math.min(this.retryDelay * 2, CONFIG_RETRY_MAX)
        : CONFIG_RETRY_MIN;
      this.lastStatus = undefined;
      await this.setStatus(false, T.configFailed(this.now() + this.retryDelay));
      this.retryTimer = this.timers.setTimeout(() => {
        this.retryTimer = undefined;
        return this.connect(loadConfig).catch((e) =>
          this.logger.warn(`Retry failed: ${e.message}`),
        );
      }, this.retryDelay);
      return;
    }
    this.retryDelay = 0;
    await this.start(config);
  }

  cancelRetry() {
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again on every start.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    this.resolveStations();
    this.scheduleRead();
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
    this.cancelRetry();
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /**
   * When the values are read next: the interval after the last read
   * (persisted). A station never tried, or another source than the last
   * read's, is read at once (still a minute after the last read), unless the
   * last read failed: then the interval, always.
   */
  scheduleRead() {
    const { lastReadAt, lastFailed, lastSource, attempted } = this.state;
    const unread = this.stations.some((id) => !attempted.has(id));
    const otherSource = lastSource !== null && lastSource !== this.config.source;
    const soon = !lastFailed && (unread || otherSource);
    this.nextRead = lastReadAt + (soon ? MIN_READ_GAP : this.intervalMs());
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
        matches = matches.filter(
          (s) =>
            searchable(labelOf(s)) === searchable(name) || searchable(s.name) === searchable(name),
        );
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

  /** The names resolved again (a new station list): a new station is read soon. */
  reresolve() {
    const before = this.stations.join(',');
    this.resolveStations();
    if (this.stations.join(',') !== before) {
      const soon =
        this.state.lastReadAt + (this.state.lastFailed ? this.intervalMs() : MIN_READ_GAP);
      this.nextRead = Math.min(this.nextRead, soon);
    }
  }

  // --- Reading -----------------------------------------------------------------------

  /** Run `work` after the running tick, never alongside it. */
  enqueue(work) {
    const generation = this.generation;
    const previous = this.ticking ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => work(generation))
      .finally(() => {
        if (this.ticking === run) {
          this.ticking = undefined;
        }
      });
    this.ticking = run;
    this.tickGeneration = generation;
    return run;
  }

  /** Read what is due (a tick never overlaps another). */
  tick() {
    if (this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    return this.enqueue((generation) => this.readDue(generation));
  }

  /** A tick that reads the values now if the last read is more than a minute old. */
  tickForced() {
    return this.enqueue((generation) => this.readDue(generation, { force: true }));
  }

  async readDue(generation, { force = false } = {}) {
    if (generation !== this.generation) {
      return;
    }
    await this.flushEvents();
    const now = this.now();
    let changed = false;
    if (this.listDue(now)) {
      await this.readList();
      this.reresolve();
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
    const gapOk = now >= this.state.lastReadAt + MIN_READ_GAP;
    const readNow = this.stations.length > 0 && (force ? gapOk : now >= this.nextRead);
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

  listRetryAt() {
    return this.state.list.failedAt + Math.max(LIST_RETRY, this.intervalMs());
  }

  listDue(now) {
    const { list } = this.state;
    if (this.config.names.length === 0) {
      return false;
    }
    const fresh = list.source === this.config.source && now - list.fetchedAt < LIST_TTL;
    return !fresh && now >= this.listRetryAt();
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
      this.state.list = { source, fetchedAt: this.now(), failedAt: 0, stations };
    } catch (err) {
      this.state.list.failedAt = this.now();
      this.logger.warn(`Station list failed: ${err.message}`);
    }
    this.save();
  }

  /**
   * The danger thresholds and discharge units, merged into the known ones (a
   * known unit is never lost). A layer without any discharge unit is refused.
   * A failure never stops the values.
   */
  async readThresholds() {
    try {
      const fresh = parseThresholds(await this.client.thresholds());
      if (![...fresh.values()].some((m) => m.flowUnit)) {
        throw new HydroError('answer', HOSTS.HYDRODATEN, 'no discharge unit in the layer');
      }
      this.state.meta = {
        fetchedAt: this.now(),
        failedAt: 0,
        stations: mergeThresholds(this.state.meta.stations, fresh),
      };
    } catch (err) {
      this.state.meta.failedAt = this.now();
      this.logger.warn(`Thresholds layer failed (the values go on without it): ${err.message}`);
    }
    this.save();
  }

  /** Read the values of every station; never throws. */
  async readValues(generation) {
    const now = this.now();
    const source = this.config.source;
    this.state.lastReadAt = now;
    this.state.lastSource = source;
    for (const id of this.stations) {
      this.state.attempted.add(id);
    }
    this.nextRead = now + this.intervalMs();
    const result =
      source === SOURCES.SWISSHYDROAPI
        ? await this.readSwissHydroApi(generation)
        : await this.readFoen();
    if (generation !== this.generation) {
      return;
    }
    this.lastError = result.error;
    this.state.lastFailed = Boolean(result.error);
    this.stationErrors = result.errors;
    if (result.error) {
      this.logger.warn(`Read failed: ${result.error.message}`);
      if (result.error.kind === 'limited') {
        this.nextRead = Math.max(this.nextRead, this.client.pausedUntil(result.error.host));
      }
    }
    if (result.missing) {
      this.missing = result.missing;
    }
    for (const [id, reading] of result.readings) {
      this.accept(id, reading);
    }
    this.save();
    await this.flushEvents();
  }

  /** LINDAS: one query for every station. */
  async readFoen() {
    const readings = new Map();
    try {
      const body = await this.client.observations(this.stations);
      const raws = parseLindasObservations(body, this.now());
      for (const id of this.stations) {
        const raw = raws.get(id);
        if (raw) {
          readings.set(id, foenReading(raw, this.state.meta.stations.get(id)));
        }
      }
    } catch (err) {
      return { readings, errors: new Map(), error: asHydroError(err), missing: undefined };
    }
    const missing = new Set(this.stations.filter((id) => !readings.has(id)));
    return { readings, errors: new Map(), error: undefined, missing };
  }

  /**
   * swisshydroapi: one call per station, a second apart. A station that
   * fails is noted and the round goes on; only a 429, or three network
   * failures in a row (the host is down), stop it.
   */
  async readSwissHydroApi(generation) {
    const readings = new Map();
    const errors = new Map();
    const missing = new Set();
    let error;
    let networkFailures = 0;
    let lastFailure;
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
        networkFailures = 0;
      } catch (err) {
        const failure = asHydroError(err);
        if (failure.kind === 'not_found') {
          missing.add(id);
          networkFailures = 0;
          continue;
        }
        if (failure.kind === 'limited') {
          error = failure;
          break;
        }
        errors.set(id, failure.kind);
        lastFailure = failure;
        networkFailures = failure.kind === 'network' ? networkFailures + 1 : 0;
        if (networkFailures >= MAX_NETWORK_FAILURES) {
          error = failure;
          break;
        }
      }
    }
    if (!error && readings.size === 0 && errors.size > 0) {
      error = lastFailure;
    }
    return { readings, errors, error, missing: error ? undefined : missing };
  }

  /**
   * A new reading of a station: kept, its features remembered, its triggers
   * checked. A reading older than the one kept, or with an aberrant date when
   * the kept one was good, is ignored (the station still counts as read).
   */
  accept(id, reading) {
    const previous = this.state.readings.get(id);
    if (previous && !previous.aberrant && Number.isFinite(previous.time)) {
      const older = Number.isFinite(reading.time) && reading.time < previous.time;
      if (older || reading.aberrant || !Number.isFinite(reading.time)) {
        return;
      }
    }
    this.missing.delete(id);
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
      this.config.source,
    );
    this.state.triggers.set(id, state);
    const at = this.now();
    this.state.pendingEvents.push(...events.map((e) => ({ ...e, at })));
    // Bounded: the oldest go first.
    this.state.pendingEvents = this.state.pendingEvents.slice(-MAX_PENDING_EVENTS);
  }

  /**
   * Send the scene events waiting, in order. One Gladys refuses (down,
   * restarting, rate limit) stays queued, persisted, and is tried again at
   * the next tick or connection; past 30 minutes it is dropped (a late
   * alarm is a wrong alarm).
   */
  async flushEvents() {
    const now = this.now();
    const before = this.state.pendingEvents.length;
    this.state.pendingEvents = this.state.pendingEvents.filter(
      (e) => now - e.at <= EVENT_QUEUE_TTL,
    );
    let changed = this.state.pendingEvents.length !== before;
    while (this.state.pendingEvents.length > 0) {
      const [event] = this.state.pendingEvents;
      try {
        await this.gladys.publishSceneEvent(event.key, event.data);
      } catch (err) {
        this.logger.warn(`Scene event ${event.key} not sent, kept for later: ${err.message}`);
        break;
      }
      this.state.pendingEvents.shift();
      changed = true;
    }
    if (changed) {
      this.save();
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
    const failed = this.stations.filter((id) => this.stationErrors.has(id));
    if (failed.length > 0 && !this.lastError) {
      notes.push(T.someFailed(failed.length, reason(this.stationErrors.get(failed[0]))));
    }
    const { meta } = this.state;
    if (this.config.source === SOURCES.FOEN && meta.failedAt > meta.fetchedAt) {
      notes.push(meta.stations.size > 0 ? T.thresholdsStale : T.thresholdsMissing);
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
      const failed = this.stationErrors.get(id);
      const why = this.missing.has(id)
        ? reason('missing')[lang]
        : failed
          ? reason(failed)[lang]
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
      parts.push(
        lang === 'fr'
          ? `degré de danger officiel ${reading.danger}/5`
          : `official danger level ${reading.danger}/5`,
      );
    }
    if (meta?.thresholds) {
      const unit = meta.metric === 'flow' ? 'm³/s' : 'm';
      const values = meta.thresholds.map((t) => numberText(t, lang, 2)).join(' / ');
      parts.push(
        lang === 'fr'
          ? `seuils wl_1 à wl_4 de la carte hydrodaten : ${values} ${unit}`
          : `hydrodaten map thresholds wl_1 to wl_4: ${values} ${unit}`,
      );
    }
    if (this.stationErrors.has(id)) {
      parts.push(`(${reason(this.stationErrors.get(id))[lang]})`);
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
    if (this.stations.length === 0) {
      return this.join(this.unresolved.length > 0 ? this.notes() : [T.noStation]);
    }
    const en = [];
    const fr = [];
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
    const now = this.now();
    const { list } = this.state;
    const usable = list.source === this.config.source && list.stations.length > 0;
    const stale = !usable || now - list.fetchedAt >= LIST_TTL;
    // A click may read the list again, never sooner than the usual retry
    // after a failure, and never alongside a tick.
    if (stale && now >= this.listRetryAt()) {
      await this.before(now + TEST_DEADLINE, () =>
        this.enqueue(async (generation) => {
          await this.readList();
          if (generation === this.generation) {
            this.reresolve();
          }
        }),
      );
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
    const kind = (s, lang) => {
      if (s.kind === 'lake') {
        return lang === 'fr' ? ' (lac)' : ' (lake)';
      }
      if (s.kind === 'river') {
        return lang === 'fr' ? ' (cours d’eau)' : ' (river)';
      }
      return '';
    };
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

/** Any failure as a HydroError (a bug of a parser counts as an unexpected answer). */
function asHydroError(err) {
  return err instanceof HydroError ? err : new HydroError('answer', '?', String(err?.message));
}
