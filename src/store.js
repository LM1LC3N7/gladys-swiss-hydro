// -----------------------------------------------------------------------------
// The state that must survive a restart of the container, in one JSON file
// under /data (the one writable volume): the 429 pauses of each host, the
// instant of the last read (a restart loop never reads faster than the
// interval), the last readings, the thresholds of the stations, the station
// list of the search, what the scene triggers already announced and the
// features each device ever declared.
//
// The file is data from a previous run, not trusted: every id is checked,
// every number bounded, and nothing of it is ever used as an object key
// (Maps only).
// -----------------------------------------------------------------------------

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stationId } from './config.js';
import {
  DANGER_LEVELS,
  FLOW_THRESHOLDS,
  HOSTS,
  LIMITED_MAX,
  MAX_LIST_ENTRIES,
  SOURCES,
} from './constants.js';
import { FEATURE_DEFS, cleanText } from './model.js';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    load: () => value,
    save: (next) => {
      value = next;
    },
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const time = (v) => (finite(v) !== null && v > 0 ? v : 0);
const list = (v) => (Array.isArray(v) ? v : []);
const nullable = (v, min, max) => {
  const n = finite(v);
  return n !== null && n >= min && n <= max ? n : null;
};

/** The pairs [id, value] of a persisted list, with a valid station id. */
function* entries(value, max = MAX_LIST_ENTRIES) {
  let count = 0;
  for (const pair of list(value)) {
    if (count >= max) {
      return;
    }
    const id = Array.isArray(pair) ? stationId(pair[0]) : null;
    if (id) {
      count += 1;
      yield [id, pair[1]];
    }
  }
}

const station = (s) => {
  const id = stationId(s?.id);
  return id
    ? {
        id,
        name: cleanText(s.name),
        waterBody: cleanText(s.waterBody),
        kind: s.kind === 'river' || s.kind === 'lake' ? s.kind : null,
      }
    : null;
};

const reading = (r) => {
  const base = station(r);
  if (!base) {
    return null;
  }
  return {
    ...base,
    time: finite(r.time) ?? NaN,
    aberrant: r.aberrant === true,
    flow: nullable(r.flow, 0, 20_000),
    flowUnit: ['m3/s', 'l/s', 'unknown'].includes(r.flowUnit) ? r.flowUnit : null,
    level: nullable(r.level, -100, 5_000),
    temperature: nullable(r.temperature, -2, 45),
    danger: DANGER_LEVELS.includes(r.danger) ? r.danger : null,
  };
};

const meta = (m) => {
  if (!m || typeof m !== 'object') {
    return null;
  }
  const thresholds =
    Array.isArray(m.thresholds) &&
    m.thresholds.length === 4 &&
    m.thresholds.every((t, i) => finite(t) !== null && (i === 0 || t > m.thresholds[i - 1]))
      ? [...m.thresholds]
      : null;
  return {
    kind: m.kind === 'river' || m.kind === 'lake' ? m.kind : null,
    metric: m.metric === 'flow' || m.metric === 'level' ? m.metric : null,
    flowUnit: m.flowUnit === 'm3/s' || m.flowUnit === 'l/s' ? m.flowUnit : null,
    thresholds,
  };
};

const trigger = (t) => ({
  armed: new Set(list(t?.armed).filter((v) => FLOW_THRESHOLDS.includes(v))),
  danger: DANGER_LEVELS.includes(t?.danger) ? t.danger : null,
  started: t?.started === true,
});

/** An empty state. */
export function emptyState() {
  return {
    pauses: new Map(),
    lastReadAt: 0,
    readings: new Map(),
    meta: { fetchedAt: 0, failedAt: 0, stations: new Map() },
    list: { source: null, fetchedAt: 0, failedAt: 0, stations: [] },
    triggers: new Map(),
    known: new Map(),
  };
}

/** A persisted state -> the state, every untrusted part checked. */
export function loadState(raw, now = Date.now()) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || raw.v !== 1) {
    return state;
  }
  const hosts = Object.values(HOSTS);
  for (const p of list(raw.pauses)) {
    if (hosts.includes(p?.host) && time(p.until) > now) {
      // A pause read back is never longer than a fresh one.
      state.pauses.set(p.host, {
        until: Math.min(p.until, now + LIMITED_MAX),
        streak: Math.min(10, Math.max(0, Math.round(finite(p.streak) ?? 0))),
      });
    }
  }
  state.lastReadAt = Math.min(time(raw.lastReadAt), now);
  for (const r of list(raw.readings).slice(0, MAX_LIST_ENTRIES)) {
    const value = reading(r);
    if (value) {
      state.readings.set(value.id, value);
    }
  }
  state.meta.fetchedAt = Math.min(time(raw.meta?.fetchedAt), now);
  state.meta.failedAt = Math.min(time(raw.meta?.failedAt), now);
  for (const [id, value] of entries(raw.meta?.stations)) {
    const m = meta(value);
    if (m) {
      state.meta.stations.set(id, m);
    }
  }
  if (Object.values(SOURCES).includes(raw.list?.source)) {
    state.list.source = raw.list.source;
    state.list.fetchedAt = Math.min(time(raw.list.fetchedAt), now);
    state.list.failedAt = Math.min(time(raw.list.failedAt), now);
    state.list.stations = list(raw.list.stations)
      .slice(0, MAX_LIST_ENTRIES)
      .map(station)
      .filter(Boolean);
  }
  for (const [id, value] of entries(raw.triggers)) {
    state.triggers.set(id, trigger(value));
  }
  for (const [id, keys] of entries(raw.known)) {
    state.known.set(id, new Set(list(keys).filter((k) => FEATURE_DEFS.has(k))));
  }
  return state;
}

/** The state -> plain JSON. */
export function saveState(state) {
  return {
    v: 1,
    pauses: [...state.pauses.entries()].map(([host, p]) => ({ host, ...p })),
    lastReadAt: state.lastReadAt,
    readings: [...state.readings.values()],
    meta: {
      fetchedAt: state.meta.fetchedAt,
      failedAt: state.meta.failedAt,
      stations: [...state.meta.stations.entries()],
    },
    list: state.list,
    triggers: [...state.triggers.entries()].map(([id, t]) => [
      id,
      { armed: [...t.armed], danger: t.danger, started: t.started },
    ]),
    known: [...state.known.entries()].map(([id, keys]) => [id, [...keys]]),
  };
}
