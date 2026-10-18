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

- [ ] `wl_1` .. `wl_4` of the hydrodaten.admin.ch layer are shown as the
      assumed start of the danger levels 2 to 5. The check of 2026-10-18
      proves nothing: every station read that day was at level 1 (Aare in
      Bern: 58 m³/s against 360 / 430 / 500 / 560). Confirm during a flood
      by comparing the official LINDAS level with the `wl_N` crossed. They
      are never used to compute a level (review B1).
- [ ] That map layer is the data of the FOEN website, not a documented API:
      it may change without notice. Read once a day, merged into the known
      units; without it (never read yet), the FOEN source gives no flow.
- [ ] LINDAS gives the discharge without its unit. On 2026-10-18: LINDAS had
      233 stations, the map layer 207 features; 6 of them in l/s
      (`metric: discharge_ls`). 27 LINDAS stations are missing from the
      layer, 14 of which have a discharge (2041, 2079, 2156, 2251, 2252,
      2329, 2353, 2356, 2404, 2492, 2631, 2632, 2650, 520): no flow for them
      with the FOEN source (2492 gives 749, l/s by the look of it);
      swisshydroapi gives their unit. Ask the FOEN to add the unit to
      LINDAS?- [ ] A water level of exactly 0.000 m is dropped (how LINDAS shows a broken
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
  units and more stations (331 against 233).
- **No computed danger level (review B1, Louis's decision)**: the danger
  level and the `danger_level_reached` event come only from LINDAS (the
  official level); an `Undefined` level publishes nothing. With
  swisshydroapi there is no danger-level feature and no danger event. The
  `wl_1` .. `wl_4` values stay as features named "Hydrodaten map threshold
  wl_N (assumed start of danger level N+1)" (feature keys
  `danger-threshold-2` .. `-5`, unchanged), shown, never compared with
  anything. `m ü.M.` (`masl`) and `m` are two units, never compared.
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
- **Restart loops (review I1)**: the stations tried and the source of the
  last read are persisted, with its outcome. A station never tried, or
  another source than the last read's, is read a minute after the last read;
  after a failed read, always the interval (a station without data, a 503,
  a new station: at most one read per interval).
- **swisshydroapi rounds (review I2)**: a failing station is noted (status,
  test button) and the round goes on; only a 429, or three network failures
  in a row (host down), stop it. Every station failing counts as a failed
  read.
- **Scene events (review I3)**: the trigger state is committed with the
  reading, the events go to a persisted queue (50 at most) sent at once,
  replayed at every tick and connection when Gladys refused them, dropped
  after 30 minutes (a late alarm is a wrong alarm). Never sent twice: an
  event leaves the queue only once Gladys took it.
- **Trigger resets (reviews I4, M2)**: the trigger state of a station holds
  its source, its discharge unit and the date of its last reading; another
  source, another unit or a gap over 3 hours gives a fresh state that only
  arms.
- **Older readings (review I5)**: a reading older than the one kept, or with
  an aberrant date while the kept one is good, is ignored; the station still
  counts as read.
- **Thresholds layer (review I6)**: merged into the known one (a known unit
  or threshold is never replaced by none, a station missing from a new layer
  keeps its facts); a layer where no station has a discharge unit is
  refused; a dedicated status line says when it is unavailable.
- **Danger hysteresis (review I7)**: a fired level is re-armed only after the
  danger level stayed under it for 30 minutes (2, 3, 2, 3, 2, 3 fires once).
- **Configuration not read (review I8)**: `connect()` asks Gladys again by a
  timer, 1 minute then doubling up to 30, with an error status; a
  disconnection cancels it.
- **swisshydroapi parameters (review M1)**: a parameter whose date is not
  current is left out (a sensor stopped while the others go on); the
  temperature needs `°C`.
- **Dates (review M5)**: the published date carries CET or CEST
  ("2026-10-18 05:30 CEST"), so the repeated hour of the end of summer time
  is not ambiguous; the end of a pause is shown in Swiss time too.
- **Not an alarm (review M6)**: "not an official warning system, nor the
  FOEN regional warning" opens the docs and the manifest intro.
- **Search button (review M4)**: it reads the list again only after the usual
  retry delay (`max(LIST_RETRY, interval)` after a failure), through the
  tick queue, never alongside a read.
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
