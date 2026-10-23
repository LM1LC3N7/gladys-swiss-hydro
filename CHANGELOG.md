# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-18

### Added

- The hydrological stations of the Swiss Federal Office for the Environment
  (FOEN) in Gladys, from its open data (LINDAS), without account: one device
  per station with the flow (m³/s, l/s converted), the water level (m), the
  water temperature (°C), the date of the measurement in Swiss time, the
  official flood danger level (1 to 5) and the thresholds of levels 2 to 5.
- Stations chosen by number or by name (20 at most), and a "Search stations"
  button that finds them by river, lake or place.
- A second source, swisshydroapi, the service read by the swisshydrodata
  library (ported to JavaScript); it has no danger level, so none is
  published with it.
- Two scene triggers: "Flow above" (1 to 4,000 m³/s, once per rise) and
  "Flood danger level reached" (2 to 5).
- Read every 10 minutes by default, never faster than the interval: 429
  pauses (1 minute to 6 hours), the last read, the readings and the trigger
  states are kept in `/data` across restarts.
- A "Test the stations" button that shows the values of every station.

### Changed

- The danger level is never computed: only the official FOEN level of
  LINDAS is published, and only it fires "Flood danger level reached". The
  `wl_1` to `wl_4` values of the hydrodaten map are shown as assumed
  thresholds.
- A danger level fires again only after staying under it for 30 minutes.
- The measurement date carries CET or CEST; the end of a pause is shown in
  Swiss time.
- The docs and the configuration screen say first that this is not an
  official warning system, nor the FOEN regional warning.

### Fixed

- A restart loop never reads faster than the interval, also with a station
  without data or after a failed read.
- swisshydroapi: one failing station no longer stops the round (only a 429
  or a host down do).
- A scene event Gladys refused is kept and sent again for 30 minutes.
- A change of source or of discharge unit, or a gap of more than 3 hours,
  only re-arms the triggers.
- An older or aberrant reading no longer replaces a good one.
- A known discharge unit is never lost when the thresholds layer changes; a
  layer without any unit is refused and the status says so.
- A configuration Gladys does not give at start is asked again by a timer.
- swisshydroapi: a stopped sensor and a temperature not in °C are left out.
- A scene event Gladys refuses for good (a 4xx other than 429) is dropped at
  once instead of blocking the events behind it.
- The danger thresholds always come from the latest hydrodaten layer (only the
  discharge units are kept from one layer to the next).
- The docs warn that an old danger level may stay shown with swisshydroapi or
  when LINDAS stops giving one.

[Unreleased]: https://github.com/LM1LC3N7/gladys-swiss-hydro/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-swiss-hydro/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-swiss-hydro/releases/tag/v0.1.1
