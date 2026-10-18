// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

import { MAX_STATIONS, MIN_POLL_MINUTES, SOURCES } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  stations: '',
  source: SOURCES.FOEN,
  poll_interval: 10,
};

const number = (value, fallback, min, max) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

/** A FOEN station number: digits only, without leading zeros ("0520" -> "520"). */
export function stationId(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]{1,6}$/.test(text)) {
    return null;
  }
  const id = String(Number(text));
  return id === '0' ? null : id;
}

/** "Bern, Schönau" -> "bern schonau": lower case, no accents, words only. */
export function searchable(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * "2135, 2009; Rhône Porte du Scex" -> the station numbers, and the names to
 * look up in the station list. Separated by `,`, `;` or a line break. A
 * station number is kept as is; any other entry is a search.
 */
export function parseStations(text) {
  const ids = [];
  const names = [];
  const seen = new Set();
  for (const entry of String(text ?? '').split(/[,;\n]+/)) {
    const value = entry.trim().slice(0, 80);
    if (!value) {
      continue;
    }
    const id = stationId(value);
    if (id) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    } else if (searchable(value) && !names.includes(value)) {
      names.push(value);
    }
  }
  return { ids, names };
}

export function normalizeConfig(raw = {}) {
  const { ids, names } = parseStations(raw.stations ?? DEFAULT_CONFIG.stations);
  const source = Object.values(SOURCES).includes(raw.source) ? raw.source : DEFAULT_CONFIG.source;
  return {
    ids,
    names: names.slice(0, MAX_STATIONS),
    source,
    // 10 minutes at least: the FOEN measures every 10 minutes.
    pollMinutes: number(raw.poll_interval, DEFAULT_CONFIG.poll_interval, MIN_POLL_MINUTES, 60),
  };
}
