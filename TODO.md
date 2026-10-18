# TODO

## Before announcing

- [ ] Run it in a real Gladys 5.1+: the devices of the Discovery tab, their
      values, the status, both buttons, both scene triggers (the trigger
      editor with its `devices` select). Never done yet.
- [ ] Check the CI (Docker build, Node 22 and 24), then run the store
      validator once the image is published (at milestone 1 its only error
      is `docker_image` not yet pullable from GHCR). The Docker image was
      never built locally (no Docker on the development PC).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm

- [ ] `wl_1` .. `wl_4` of the hydrodaten.admin.ch layer are read as the lower
      bounds of the danger levels 2 to 5. Consistent with the official levels
      seen on 2026-10-18 (Aare in Bern: 58 m³/s, level 1, thresholds 360 /
      430 / 500 / 560), but not documented by the FOEN: confirm during a
      flood (the LINDAS level and the computed one should agree).
- [ ] That map layer is the data of the FOEN website, not a documented API:
      it may change without notice. Read once a day; when it fails, only the
      thresholds and the l/s detection are missing.
- [ ] LINDAS gives the discharge without its unit; 6 stations of the map layer are in
      l/s (`metric: discharge_ls` on the map layer). The ~27 LINDAS stations
      missing from the layer get no flow with the FOEN source (their unit is
      unknown); the swisshydroapi source gives the unit. Ask the FOEN to add
      the unit to LINDAS?
- [ ] A water level of exactly 0.000 m is dropped (how LINDAS shows a broken
      level sensor, e.g. 2602 Domat/Ems on 2026-10-18). A relative-height
      station could truly read 0: never seen.
- [ ] Rate limits: neither LINDAS nor swisshydroapi documents one; 429 and
      Retry-After are handled anyway.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-swiss-hydro:0.1.0`); the first patch release
  gives 0.1.1.
- **Flow unit: `unknown`.** The core has no m³/s
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY`); `cubic-meter-per-hour` exists only for
  the `water-valve` category, whose UI is a valve's, and m³/h would give the
  Rhine at 360,000. So the flow is `unknown`/`unknown`, no unit, "(m³/s)" in
  its name. If the core gains m³/s, a new feature key would be needed (units
  are fixed at creation): ask the core maintainers for
  `cubic-meter-per-second` on a generic flow category first.
- **Other features**: water level `level-sensor`/`liquid-depth` in `m`;
  water temperature `temperature-sensor`/`probe` in `celsius` (kept out of the
  room temperature); measurement date `text`/`text` in Swiss time
  (`Europe/Zurich`, independent of the container time zone; tested with
  Lisbon, Helsinki, UTC and New York, around midnight and both DST changes);
  danger level and thresholds `unknown`/`unknown`. All read-only; never a
  `switch` or `binary`.
- **Two sources, FOEN by default.** LINDAS is the FOEN's own open data
  ("Open use") with the official danger level, one query for all stations.
  swisshydroapi is what swisshydrodata (the reference to port) reads: ported
  as the second source (`/stations`, `/station/<id>`), because it has the
  units and more stations (331 against 233); its danger level is computed
  from the official thresholds.
- **swisshydrodata (MIT) as the reference**, not copied: Python, so its two
  calls and their answer shape are re-implemented, credited in the docs and
  `THIRD_PARTY_NOTICES.md` (copied into the image with `LICENSE`). Its
  24-hour min/mean/max are not published (not asked; easy to add).
- **Pacing**: 10 minutes by default (the FOEN rhythm), 10 to 60. One request
  per interval for all stations (FOEN), or one per station a second apart
  (swisshydroapi). The thresholds layer once a day (retry after 1 hour), the
  station list once a week (retry after 1 hour), each never sooner than the
  interval. A new station or another source is read at once, but never
  within a minute of the last read; the test button likewise.
- **Never faster than the interval**: the instant of the last read is
  persisted, so a restart loop or a reconnection never reads sooner. A
  failure (network, 5xx, bad answer) waits the interval; a 429 waits the
  later of the interval and its pause.
- **429**: one pause per host, `Retry-After` when given, else 10 minutes
  doubling, always clamped to 1 minute – 6 hours, honoured by every call
  (values, thresholds, list, buttons), persisted in `/data`, capped at 6
  hours when read back, never cleared by a reconnection. A good answer ends
  it.
- **Persisted state** (`/data/swiss-hydro-state.json`, atomic write): pauses,
  last read, readings, thresholds, station list, trigger states, feature keys
  ever declared. Read back through validators (ids, numbers, keys), Maps
  only: nothing of it reaches an object prototype. Unreadable: start afresh.
- **No prototype pollution**: station numbers from the network are checked
  (`^[0-9]{1,6}$`, leading zeros dropped) and used as Map keys only; JSON
  fields are read with `Object.hasOwn`; tested with `__proto__` and
  `constructor` ids and keys.
- **Dates**: an ISO date must carry its offset (the FOEN writes winter time,
  +01:00, all year); a date more than 15 minutes ahead, older than 30 days or
  before 2000 is aberrant (never published, shown by the test button); older
  than 3 hours is stale (not published). Several observations of one
  station: the latest believable one wins.
- **Plausible values**: flow 0 – 20,000 m³/s, level -100 – 5,000 m, water
  temperature -2 – 45 °C, danger level 1 – 5; else dropped.
- **No lost feature**: a device declares every feature key it ever had
  (persisted) plus those of the device the user created (`gladys.devices`),
  so a sensor that stops for a while never makes the core mark the device
  changed.
- **Status and Discovery republished at every `connected`** (the core keeps
  them in memory only); their dedup caches are reset in `start()`.
- **Scene triggers**: the core compares a trigger filter for equality only,
  so "flow above X" offers fixed marks (1 to 4,000 m³/s), fired once per
  rise with a 95 % re-arm; any other value: the native device trigger on the
  flow feature. "Danger level reached" fires each level crossed (2 to 5).
  The first reading only arms; the states are persisted, so a restart never
  fires twice. Summaries in English and French (`summary`, `summary_fr`).
- **Search**: by number, river, lake or place, without accents; a name in
  the configuration is used only when it matches one station (or one exact
  label); otherwise the status lists it.
- **Limits**: 20 stations; answers bounded (2 MB LINDAS, 4 MB map layer,
  64 KB per swisshydroapi station, 1 MB lists); no redirect followed; error
  messages carry the host only.
- **LICENSE**: the bare Apache-2.0 text, no name in it.

## Ideas

- The 24-hour min / mean / max of swisshydroapi.
- The FOEN flow forecasts (stations with a forecast).
- Groundwater stations (another FOEN dataset on LINDAS).
- A dashboard widget with the stations and their danger levels.
