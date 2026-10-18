// -----------------------------------------------------------------------------
// Endpoints, pacing, bounds and the keys users store (manifest keys, device
// type, feature keys): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

/**
 * The FOEN open data on LINDAS, the linked data service of the Swiss federal
 * administration: one SPARQL query gives the latest observation of every
 * station asked for (discharge, water level, water temperature, official
 * flood danger level, time of the measurement).
 */
export const LINDAS_URL = 'https://ld.admin.ch/query';

/**
 * The map layer of hydrodaten.admin.ch (FOEN): the official flood danger
 * thresholds of each station (`wl_1` .. `wl_4`) and the unit of its discharge
 * (m³/s or l/s). Read rarely: it changes only when the FOEN revises a station.
 */
export const THRESHOLDS_URL =
  'https://www.hydrodaten.admin.ch/web-hydro-maps/hydro_sensor_pq.geojson';

/** The REST API swisshydrodata (Bouni) reads: `/stations`, `/station/<id>`. */
export const SWISSHYDROAPI_URL = 'https://swisshydroapi.bouni.de/api/v1';

/** The hosts, as the pauses (429) are kept: one pause per host. */
export const HOSTS = {
  LINDAS: 'ld.admin.ch',
  HYDRODATEN: 'www.hydrodaten.admin.ch',
  SWISSHYDROAPI: 'swisshydroapi.bouni.de',
};

export const USER_AGENT = 'gladys-swiss-hydro (+https://github.com/LM1LC3N7/gladys-swiss-hydro)';

/** One HTTP call. */
export const HTTP_TIMEOUT = 20_000;

/** The most an answer may weigh. LINDAS for 20 stations: about 25 KB. */
export const MAX_LINDAS_BODY = 2 * 1024 * 1024;
/** The thresholds layer: about 250 KB for the whole country. */
export const MAX_THRESHOLDS_BODY = 4 * 1024 * 1024;
/** One station of swisshydroapi: under 1 KB; the list of stations: about 30 KB. */
export const MAX_STATION_BODY = 64 * 1024;
export const MAX_LIST_BODY = 1024 * 1024;

/** The data sources the user can choose (manifest `source`). */
export const SOURCES = {
  FOEN: 'foen',
  SWISSHYDROAPI: 'swisshydroapi',
};

/** At most this many stations. */
export const MAX_STATIONS = 20;

/** The station list kept for the search: more entries are dropped. */
export const MAX_LIST_ENTRIES = 2000;

/** How often the integration checks what is due. */
export const TICK = 60_000;

/** The FOEN measures every 10 minutes: never read faster. */
export const MIN_POLL_MINUTES = 10;

/** Two reads of the values never closer than this (a new station, the test button). */
export const MIN_READ_GAP = 60_000;

/** Between two station calls of swisshydroapi (one call per station). */
export const STATION_CALL_GAP = 1_000;

/** The thresholds and units of the stations: read again after this. */
export const THRESHOLDS_TTL = 24 * 60 * 60_000;
/** The thresholds layer failed: tried again after this (never sooner than the interval). */
export const THRESHOLDS_RETRY = 60 * 60_000;

/** The station list (search by name): read again after this. */
export const LIST_TTL = 7 * 24 * 60 * 60_000;
/** The station list failed: tried again after this (never sooner than the interval). */
export const LIST_RETRY = 60 * 60_000;

/** A 429: never shorter than a minute, never longer than 6 hours. */
export const LIMITED_MIN = 60_000;
export const LIMITED_MAX = 6 * 60 * 60_000;
/** A 429 without Retry-After: 10 minutes, doubling, up to 6 hours. */
export const LIMITED_BASE = 10 * 60_000;

/** A measurement older than this is not published as current. */
export const STALE_AFTER = 3 * 60 * 60_000;
/** A measurement older than this (a station out of service), or this far ahead, is aberrant. */
export const ABERRANT_PAST = 30 * 24 * 60 * 60_000;
export const ABERRANT_FUTURE = 15 * 60_000;
/** No measurement before this date is believed (a zero epoch, a year 1900...). */
export const OLDEST_BELIEVED = Date.parse('2000-01-01T00:00:00Z');

/** An unchanged value is re-sent this often, so Gladys keeps it recent. */
export const HEARTBEAT = 30 * 60_000;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 50_000;

/** The time zone of the station clocks, as the measurement date is shown. */
export const TIME_ZONE = 'Europe/Zurich';

/** The device type of the external ids (`ext:<selector>:station:<number>`). */
export const DEVICE_TYPE = 'station';

/** Feature keys (part of the external ids: forever). */
export const FEATURES = {
  FLOW: 'flow',
  LEVEL: 'level',
  TEMPERATURE: 'temperature',
  MEASURED_AT: 'measured-at',
  DANGER: 'danger-level',
  THRESHOLD_2: 'danger-threshold-2',
  THRESHOLD_3: 'danger-threshold-3',
  THRESHOLD_4: 'danger-threshold-4',
  THRESHOLD_5: 'danger-threshold-5',
};

/** The FOEN flood danger levels: 1 (no or low danger) to 5 (very high danger). */
export const DANGER_LEVELS = [1, 2, 3, 4, 5];

/** The "flow above" marks a scene can wait for (m³/s). */
export const FLOW_THRESHOLDS = [
  1, 2, 5, 10, 20, 50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000, 3000, 4000,
];

/** A crossed flow mark is re-armed once the flow falls below this share of it. */
export const FLOW_REARM = 0.95;

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
  SEARCH: 'search_stations',
};

/** Manifest `scene_triggers` keys. */
export const SCENE_TRIGGERS = {
  FLOW_ABOVE: 'flow_above',
  DANGER_REACHED: 'danger_level_reached',
};
