// -----------------------------------------------------------------------------
// The answers of the data sources -> plain readings, and the Gladys devices
// and states built from them. Pure: `now` is a parameter.
//
// Everything read from the network is data, never a key: the station numbers
// are checked (digits only) and every lookup goes through a Map, so a hostile
// "__proto__" or "constructor" can never reach an object prototype.
//
// A reading (one station):
//   { id, name, waterBody, kind, time, flow, level, temperature, danger,
//     flowUnit, aberrant }
//   flow in m³/s (a discharge in l/s is converted), level in m, temperature
//   in °C, danger the FOEN flood danger level (1 to 5), time in ms (NaN when
//   missing or aberrant).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { searchable, stationId } from './config.js';
import {
  ABERRANT_FUTURE,
  ABERRANT_PAST,
  DANGER_LEVELS,
  DEVICE_TYPE,
  FEATURES,
  MAX_LIST_ENTRIES,
  OLDEST_BELIEVED,
  STALE_AFTER,
  TIME_ZONE,
} from './constants.js';

// --- Plain values ------------------------------------------------------------------

/** A finite number from a number or a plain decimal string ("57.783"), else null. */
export function num(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && /^\s*-?[0-9]+(\.[0-9]+)?\s*$/.test(value)) {
    return Number(value);
  }
  return null;
}

/** A printable string: control characters removed, trimmed, bounded. */
export function cleanText(value, max = 80) {
  if (typeof value !== 'string') {
    return '';
  }
  return [...value]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const within = (value, min, max) => (value !== null && value >= min && value <= max ? value : null);

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The value of a SPARQL binding (`{ type, value }`), or undefined. */
const bound = (binding, name) => {
  const cell = binding && Object.hasOwn(binding, name) ? binding[name] : undefined;
  return cell && typeof cell === 'object' && typeof cell.value === 'string'
    ? cell.value
    : undefined;
};

// --- Dates -------------------------------------------------------------------------

/**
 * An ISO date with an offset ("2026-10-18T04:30:00+01:00", the FOEN writes
 * its winter time all year) -> ms. A date without an offset is refused: it
 * would be read in the time zone of the container.
 */
export function parseTime(text) {
  if (typeof text !== 'string' || !/(Z|[+-][0-9]{2}:?[0-9]{2})$/.test(text.trim())) {
    return NaN;
  }
  const t = Date.parse(text.trim());
  return Number.isFinite(t) ? t : NaN;
}

/** A measurement date the integration believes: not in the future, not from another era. */
export function believable(time, now) {
  return (
    Number.isFinite(time) &&
    time >= OLDEST_BELIEVED &&
    time <= now + ABERRANT_FUTURE &&
    time >= now - ABERRANT_PAST
  );
}

/** A reading recent enough to be published as current. */
export function isFresh(reading, now) {
  return believable(reading?.time, now) && now - reading.time <= STALE_AFTER && !reading.aberrant;
}

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * The time of a measurement as the Swiss stations show it, whatever the time
 * zone of the container: "2026-10-18 05:30" (Europe/Zurich).
 */
export function swissTime(ms) {
  const parts = Object.fromEntries(clock.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// --- Plausible values ----------------------------------------------------------------

/** m³/s: the Rhine at Basel peaks near 5 000; more is a sensor fault. */
const flowValue = (v) => within(v, 0, 20_000);
/**
 * m: most stations give the altitude of the water (m a.s.l.), a few a
 * relative height. Exactly 0 is how a broken level sensor shows on LINDAS
 * (a station at 0 m does not exist in Switzerland): dropped.
 */
const levelValue = (v) => (v === 0 ? null : within(v, -100, 5_000));
/** °C. */
const temperatureValue = (v) => within(v, -2, 45);
/** The FOEN danger level, 1 to 5. */
const dangerValue = (v) => (Number.isInteger(v) && DANGER_LEVELS.includes(v) ? v : null);

/** A discharge in its unit -> m³/s; an unknown unit gives null. */
export function toCubicMeters(value, unit) {
  if (value === null) {
    return null;
  }
  if (unit === 'm3/s') {
    return flowValue(value);
  }
  if (unit === 'l/s') {
    return flowValue(value / 1000);
  }
  return null;
}

/** "m³/s", "m3/s", "l/s", "m ü.M.", "m", "°C" -> a known unit, or null. */
export function unitOf(text) {
  const u = cleanText(text, 20).toLowerCase().replace(/\s+/g, ' ');
  if (u === 'm³/s' || u === 'm3/s') {
    return 'm3/s';
  }
  if (u === 'l/s') {
    return 'l/s';
  }
  if (u === 'm' || u === 'm ü.m.' || u === 'm a.s.l.') {
    return 'm';
  }
  return null;
}

const kindOf = (text) => {
  const k = cleanText(text, 10).toLowerCase();
  return k === 'river' || k === 'lake' ? k : null;
};

/** The kind of a LINDAS observation, from its address (`.../river/observation/<id>`). */
const kindOfObservation = (uri) => {
  const match = typeof uri === 'string' ? /\/hydro\/(river|lake)\/observation\//.exec(uri) : null;
  return match ? match[1] : null;
};

/** The name of a station as Gladys shows it: "Aare - Bern, Schönau". */
export function labelOf(reading) {
  const name = reading.name || reading.id;
  return reading.waterBody ? `${reading.waterBody} - ${name}`.slice(0, 120) : name;
}

// --- FOEN open data (LINDAS) -----------------------------------------------------------

const bindingsOf = (body) => {
  const rows = body?.results?.bindings;
  return Array.isArray(rows) ? rows : [];
};

/**
 * The latest observation of each station of a LINDAS answer -> Map(id ->
 * raw). The discharge stays unit-less: LINDAS gives it in the unit of the
 * station (m³/s, or l/s for a brook), which only the thresholds layer tells.
 * Several observations of one station: the most recent believable one wins.
 */
export function parseLindasObservations(body, now) {
  const stations = new Map();
  for (const row of bindingsOf(body)) {
    const id = stationId(bound(row, 'id'));
    if (!id) {
      continue;
    }
    const time = parseTime(bound(row, 'time'));
    const believed = believable(time, now);
    const raw = {
      id,
      name: cleanText(bound(row, 'name')),
      waterBody: cleanText(bound(row, 'wbName')),
      kind: kindOfObservation(bound(row, 'obs')),
      time: believed ? time : NaN,
      aberrant: !believed,
      discharge: num(bound(row, 'discharge')),
      level: levelValue(num(bound(row, 'level'))),
      temperature: temperatureValue(num(bound(row, 'temperature'))),
      danger: dangerValue(num(bound(row, 'danger'))),
    };
    const previous = stations.get(id);
    if (!previous || (believed && (previous.aberrant || time > previous.time))) {
      stations.set(id, raw);
    }
  }
  return stations;
}

/** The stations of a LINDAS list answer -> [{ id, name, waterBody, kind }]. */
export function parseLindasStations(body) {
  const stations = new Map();
  for (const row of bindingsOf(body)) {
    const id = stationId(bound(row, 'id'));
    if (!id || stations.has(id) || stations.size >= MAX_LIST_ENTRIES) {
      continue;
    }
    stations.set(id, {
      id,
      name: cleanText(bound(row, 'name')),
      waterBody: cleanText(bound(row, 'wbName')),
      kind: kindOfObservation(bound(row, 'obs')),
    });
  }
  return [...stations.values()];
}

/** A LINDAS observation and the station facts -> a reading. */
export function foenReading(raw, meta) {
  const unit = meta?.flowUnit ?? null;
  const flow = toCubicMeters(raw.discharge, unit);
  return {
    id: raw.id,
    name: raw.name,
    waterBody: raw.waterBody,
    kind: raw.kind ?? meta?.kind ?? null,
    time: raw.time,
    aberrant: raw.aberrant,
    flow,
    // A discharge LINDAS gives but whose unit nobody told: not published.
    flowUnit: raw.discharge !== null && flow === null && !unit ? 'unknown' : unit,
    level: raw.level,
    temperature: raw.temperature,
    danger: raw.danger,
  };
}

// --- The thresholds layer (hydrodaten.admin.ch) ----------------------------------------------

/** "780 m³/s", "1450 l/s", "724.10 m ü.M." -> { value, unit }, or null. */
export function quantity(text) {
  const match = typeof text === 'string' ? /^\s*(-?[0-9]+(?:\.[0-9]+)?)\s*(.*)$/.exec(text) : null;
  if (!match) {
    return null;
  }
  const unit = unitOf(match[2]);
  return unit ? { value: Number(match[1]), unit } : null;
}

/**
 * The thresholds layer -> Map(id -> { kind, metric, flowUnit, thresholds }):
 *   metric      'flow' (thresholds in m³/s) or 'level' (in m), or null
 *   flowUnit    the unit LINDAS uses for the discharge of the station
 *   thresholds  the lower bounds of the danger levels 2, 3, 4 and 5, or null
 * Thresholds that are missing, of another unit or not increasing are dropped.
 */
export function parseThresholds(body) {
  const stations = new Map();
  const features = Array.isArray(body?.features) ? body.features : [];
  for (const feature of features) {
    const p = feature && typeof feature === 'object' ? feature.properties : undefined;
    if (!p || typeof p !== 'object') {
      continue;
    }
    const id = stationId(typeof p.key === 'string' ? p.key : undefined);
    if (!id || stations.has(id) || stations.size >= MAX_LIST_ENTRIES) {
      continue;
    }
    const metricName = typeof p.metric === 'string' ? p.metric : '';
    const flowUnit =
      metricName === 'discharge_ms' ? 'm3/s' : metricName === 'discharge_ls' ? 'l/s' : null;
    const metric = flowUnit ? 'flow' : metricName === 'masl' ? 'level' : null;
    let thresholds = null;
    if (metric) {
      const values = ['wl_1', 'wl_2', 'wl_3', 'wl_4'].map((k) => {
        const q = quantity(Object.hasOwn(p, k) ? p[k] : undefined);
        if (!q) {
          return null;
        }
        return metric === 'flow' ? toCubicMeters(q.value, q.unit) : q.unit === 'm' ? q.value : null;
      });
      const increasing = values.every((v, i) => v !== null && (i === 0 || v > values[i - 1]));
      thresholds = increasing ? values.map((v) => round(v, 3)) : null;
    }
    stations.set(id, { kind: kindOf(p.kind), metric, flowUnit, thresholds });
  }
  return stations;
}

/** The danger level a value reaches against the thresholds of its station (1 to 5), or null. */
export function dangerFrom(reading, meta) {
  if (!meta?.thresholds) {
    return null;
  }
  const value =
    meta.metric === 'flow' ? reading.flow : meta.metric === 'level' ? reading.level : null;
  if (value === null || value === undefined) {
    return null;
  }
  return 1 + meta.thresholds.filter((t) => value >= t).length;
}

// --- swisshydroapi (the API swisshydrodata reads) -----------------------------------------------

const parameter = (body, name) => {
  const params = body?.parameters;
  const p =
    params && typeof params === 'object' && Object.hasOwn(params, name) ? params[name] : null;
  return p && typeof p === 'object' ? p : null;
};

/**
 * `/station/<id>` -> a reading. Each parameter carries its unit and its
 * date; the most recent believable date is the date of the reading. The
 * danger level is not part of this API: it is computed from the official
 * thresholds when they are known.
 */
export function swissReading(id, body, meta, now) {
  const discharge = parameter(body, 'discharge');
  const level = parameter(body, 'level');
  const temperature = parameter(body, 'temperature');
  const times = [discharge, level, temperature]
    .filter(Boolean)
    .map((p) => parseTime(p.datetime))
    .filter((t) => Number.isFinite(t));
  const believed = times.filter((t) => believable(t, now));
  const time = believed.length > 0 ? Math.max(...believed) : NaN;
  const flowUnit = discharge ? unitOf(discharge.unit) : null;
  const levelUnit = level ? unitOf(level.unit) : null;
  const reading = {
    id,
    name: cleanText(body?.name),
    waterBody: cleanText(body?.['water-body-name']),
    kind: kindOf(body?.['water-body-type']) ?? meta?.kind ?? null,
    time,
    aberrant: times.length > 0 && believed.length === 0,
    flow: discharge ? toCubicMeters(num(discharge.value), flowUnit) : null,
    flowUnit: discharge && !flowUnit ? 'unknown' : flowUnit,
    level: level && levelUnit === 'm' ? levelValue(num(level.value)) : null,
    temperature: temperature ? temperatureValue(num(temperature.value)) : null,
    danger: null,
  };
  reading.danger = dangerFrom(reading, meta);
  return reading;
}

/** `/stations` -> [{ id, name, waterBody, kind }]. */
export function parseSwissStations(body) {
  const stations = new Map();
  for (const entry of Array.isArray(body) ? body : []) {
    const id = stationId(entry && typeof entry === 'object' ? entry.id : undefined);
    if (!id || stations.has(id) || stations.size >= MAX_LIST_ENTRIES) {
      continue;
    }
    stations.set(id, {
      id,
      name: cleanText(entry.name),
      waterBody: cleanText(entry['water-body-name']),
      kind: kindOf(entry['water-body-type']),
    });
  }
  return [...stations.values()];
}

// --- Search ------------------------------------------------------------------------------------

/** The stations whose number, name or water body hold every word of the query. */
export function searchStations(list, query) {
  const words = searchable(query).split(' ').filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  return list.filter((s) => {
    const haystack = ` ${searchable(`${s.id} ${s.waterBody} ${s.name}`)} `;
    return words.every((w) => haystack.includes(w));
  });
}

// --- Gladys devices and states ------------------------------------------------------------------

/**
 * Every feature this integration can publish, by key. Only the units the
 * core lists for the category (DEVICE_FEATURE_UNITS_BY_CATEGORY of
 * server/utils/constants.js): the core has no m³/s, so the flow is a plain
 * value (`unknown`), its unit in its name.
 */
export const FEATURE_DEFS = new Map([
  [
    FEATURES.FLOW,
    {
      name: 'Flow (m³/s)',
      category: CAT.UNKNOWN,
      type: TYPES.UNKNOWN.UNKNOWN,
      min: 0,
      max: 20_000,
      keep_history: true,
    },
  ],
  [
    FEATURES.LEVEL,
    {
      name: 'Water level (m)',
      category: CAT.LEVEL_SENSOR,
      type: TYPES.LEVEL_SENSOR.LIQUID_DEPTH,
      unit: UNITS.M,
      min: -100,
      max: 5_000,
      keep_history: true,
    },
  ],
  [
    FEATURES.TEMPERATURE,
    {
      name: 'Water temperature',
      category: CAT.TEMPERATURE_SENSOR,
      // `probe`: kept out of the room temperature of Gladys.
      type: TYPES.TEMPERATURE_SENSOR.PROBE,
      unit: UNITS.CELSIUS,
      min: -2,
      max: 45,
      keep_history: true,
    },
  ],
  [
    FEATURES.MEASURED_AT,
    {
      name: 'Measured at (Swiss time)',
      category: CAT.TEXT,
      type: TYPES.TEXT.TEXT,
      min: 0,
      max: 0,
      keep_history: false,
    },
  ],
  [
    FEATURES.DANGER,
    {
      name: 'Flood danger level (1-5)',
      category: CAT.UNKNOWN,
      type: TYPES.UNKNOWN.UNKNOWN,
      min: 1,
      max: 5,
      keep_history: true,
    },
  ],
  ...[2, 3, 4, 5].map((level) => [
    FEATURES[`THRESHOLD_${level}`],
    {
      name: `Danger level ${level} threshold`,
      category: CAT.UNKNOWN,
      type: TYPES.UNKNOWN.UNKNOWN,
      min: -100,
      max: 20_000,
      keep_history: false,
    },
  ]),
]);

/** The feature keys a reading (and the thresholds of its station) gives values to. */
export function valuesOf(reading, meta) {
  const values = new Map();
  if (reading.flow !== null && reading.flow !== undefined) {
    values.set(FEATURES.FLOW, { state: round(reading.flow, 3) });
  }
  if (reading.level !== null && reading.level !== undefined) {
    values.set(FEATURES.LEVEL, { state: round(reading.level, 3) });
  }
  if (reading.temperature !== null && reading.temperature !== undefined) {
    values.set(FEATURES.TEMPERATURE, { state: round(reading.temperature, 2) });
  }
  if (Number.isFinite(reading.time) && !reading.aberrant) {
    values.set(FEATURES.MEASURED_AT, { text: swissTime(reading.time) });
  }
  if (reading.danger !== null && reading.danger !== undefined) {
    values.set(FEATURES.DANGER, { state: reading.danger });
  }
  if (meta?.thresholds) {
    for (const [i, value] of meta.thresholds.entries()) {
      values.set(FEATURES[`THRESHOLD_${i + 2}`], { state: value });
    }
  }
  return values;
}

export const idsOf = (gladys, id) => gladys.externalIds(DEVICE_TYPE, id);

/**
 * The Gladys device of a station. `keys` are the feature keys to declare: the
 * ones of this reading, plus every one declared before (a feature that
 * disappears from a device makes the core mark it changed, and "Update"
 * would delete its history), in the fixed order of FEATURE_DEFS.
 */
export function deviceOf(gladys, reading, keys) {
  const ids = idsOf(gladys, reading.id);
  return {
    name: labelOf(reading),
    external_id: ids.device,
    // The integration reads the FOEN at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features: [...FEATURE_DEFS.entries()]
      .filter(([key]) => keys.has(key))
      .map(([key, def]) => ({
        name: def.name,
        external_id: ids.feature(key),
        category: def.category,
        type: def.type,
        ...(def.unit ? { unit: def.unit } : {}),
        min: def.min,
        max: def.max,
        read_only: true,
        has_feedback: false,
        keep_history: def.keep_history,
      })),
  };
}

/** The states of a reading, for publishChangedStates. */
export function statesOf(gladys, reading, meta) {
  const ids = idsOf(gladys, reading.id);
  return [...valuesOf(reading, meta).entries()].map(([key, value]) => ({
    device_feature_external_id: ids.feature(key),
    ...value,
  }));
}
