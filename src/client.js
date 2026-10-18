// -----------------------------------------------------------------------------
// The calls to the data sources, and their 429 pauses (one per host, kept in
// the persisted state so a restart never shortens them).
//
//   LINDAS (FOEN open data)   one SPARQL query for every station asked for
//   hydrodaten.admin.ch       the thresholds layer (danger thresholds, units)
//   swisshydroapi             the API swisshydrodata reads, one call per station
//
// swisshydroapi is the port of swisshydrodata 0.3.1 (MIT, Bouni): the same
// two endpoints (`/stations`, `/station/<id>`) and the same answer shape.
// -----------------------------------------------------------------------------

import {
  HOSTS,
  LIMITED_BASE,
  LIMITED_MAX,
  LIMITED_MIN,
  LINDAS_URL,
  MAX_LINDAS_BODY,
  MAX_LIST_BODY,
  MAX_STATION_BODY,
  MAX_THRESHOLDS_BODY,
  SWISSHYDROAPI_URL,
  THRESHOLDS_URL,
} from './constants.js';
import { NetworkError, requestJson } from './http.js';

/**
 * A failed call. `kind`:
 *   limited    429, or a pause still running (no call made)
 *   server     5xx
 *   not_found  404 (a station the API does not know)
 *   http       another status
 *   answer     a 2xx that is not the expected JSON
 *   network    DNS, timeout, a body too large...
 */
export class HydroError extends Error {
  constructor(kind, host, detail = kind) {
    super(`${host}: ${detail}`);
    this.name = 'HydroError';
    this.kind = kind;
    this.host = host;
  }
}

const PREFIXES = `PREFIX schema: <http://schema.org/>
PREFIX h: <https://environment.ld.admin.ch/foen/hydro/dimension/>
`;

/** The latest observations of the stations (ids: digits only, checked by the caller). */
export function observationsQuery(ids) {
  return `${PREFIXES}SELECT ?obs ?id ?name ?wbName ?time ?discharge ?level ?temperature ?danger WHERE {
  VALUES ?id { ${ids.filter((id) => /^[0-9]{1,6}$/.test(id)).join(' ')} }
  ?station schema:identifier ?id ; schema:name ?name .
  ?obs h:station ?station .
  OPTIONAL { ?station schema:containedInPlace ?waterBody . ?waterBody schema:name ?wbName }
  OPTIONAL { ?obs h:measurementTime ?time }
  OPTIONAL { ?obs h:discharge ?discharge }
  OPTIONAL { ?obs h:waterLevel ?level }
  OPTIONAL { ?obs h:waterTemperature ?temperature }
  OPTIONAL { ?obs h:dangerLevel ?danger }
}`;
}

/** Every station that has an observation, for the search. */
export const STATIONS_QUERY = `${PREFIXES}SELECT ?obs ?id ?name ?wbName WHERE {
  ?obs h:station ?station .
  ?station schema:identifier ?id ; schema:name ?name .
  OPTIONAL { ?station schema:containedInPlace ?waterBody . ?waterBody schema:name ?wbName }
}`;

export class HydroClient {
  /**
   * pauses: Map(host -> { until, streak }), shared with the persisted state.
   * onChange: called after a pause changed (the state is saved then).
   */
  constructor({ pauses = new Map(), now = Date.now, onChange = () => {} } = {}) {
    this.pauses = pauses;
    this.now = now;
    this.onChange = onChange;
  }

  /** The end of the pause of a host, 0 when none runs. */
  pausedUntil(host) {
    const pause = this.pauses.get(host);
    return pause && pause.until > this.now() ? pause.until : 0;
  }

  /** One call: refused while the host pauses; a 429 starts (or lengthens) its pause. */
  async call(host, url, options, accept) {
    if (this.pausedUntil(host)) {
      throw new HydroError('limited', host, 'paused (429)');
    }
    let answer;
    try {
      answer = await requestJson(url, { ...options, now: this.now });
    } catch (err) {
      throw err instanceof NetworkError ? new HydroError('network', host, err.message) : err;
    }
    const { status, body, retryAfterMs } = answer;
    if (status === 429) {
      const streak = (this.pauses.get(host)?.streak ?? 0) + 1;
      const wait = retryAfterMs ?? LIMITED_BASE * 2 ** (streak - 1);
      this.pauses.set(host, {
        until: this.now() + Math.min(LIMITED_MAX, Math.max(LIMITED_MIN, wait)),
        streak: Math.min(streak, 10),
      });
      this.onChange();
      throw new HydroError('limited', host, 'http 429');
    }
    if (this.pauses.has(host)) {
      this.pauses.delete(host);
      this.onChange();
    }
    if (status >= 500) {
      throw new HydroError('server', host, `http ${status}`);
    }
    if (status === 404) {
      throw new HydroError('not_found', host, 'http 404');
    }
    if (status < 200 || status >= 300) {
      throw new HydroError('http', host, `http ${status}`);
    }
    if (!accept(body)) {
      throw new HydroError('answer', host, 'unexpected answer');
    }
    return body;
  }

  sparql(query, maxBytes) {
    return this.call(
      HOSTS.LINDAS,
      LINDAS_URL,
      {
        method: 'POST',
        body: new URLSearchParams({ query }).toString(),
        contentType: 'application/x-www-form-urlencoded',
        accept: 'application/sparql-results+json',
        maxBytes,
      },
      (body) => Array.isArray(body?.results?.bindings),
    );
  }

  /** LINDAS: the latest observations of these stations. */
  observations(ids) {
    return this.sparql(observationsQuery(ids), MAX_LINDAS_BODY);
  }

  /** LINDAS: every station, for the search. */
  lindasStations() {
    return this.sparql(STATIONS_QUERY, MAX_LIST_BODY);
  }

  /** hydrodaten.admin.ch: the thresholds layer (GeoJSON). */
  thresholds() {
    return this.call(
      HOSTS.HYDRODATEN,
      THRESHOLDS_URL,
      { accept: 'application/geo+json, application/json', maxBytes: MAX_THRESHOLDS_BODY },
      (body) => Array.isArray(body?.features),
    );
  }

  /** swisshydroapi: every station (swisshydrodata `async_get_stations`). */
  swissStations() {
    return this.call(
      HOSTS.SWISSHYDROAPI,
      `${SWISSHYDROAPI_URL}/stations`,
      { maxBytes: MAX_LIST_BODY },
      (body) => Array.isArray(body),
    );
  }

  /** swisshydroapi: one station (swisshydrodata `async_get_station`). */
  swissStation(id) {
    if (!/^[0-9]{1,6}$/.test(id)) {
      throw new HydroError('answer', HOSTS.SWISSHYDROAPI, 'bad station number');
    }
    return this.call(
      HOSTS.SWISSHYDROAPI,
      `${SWISSHYDROAPI_URL}/station/${id}`,
      { maxBytes: MAX_STATION_BODY },
      (body) => body !== null && typeof body === 'object' && !Array.isArray(body),
    );
  }
}
