# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The hydrological stations of the Swiss Federal Office for the Environment
  (FOEN) in Gladys, from its open data (LINDAS), without account: one device
  per station with the flow (m³/s, l/s converted), the water level (m), the
  water temperature (°C), the date of the measurement in Swiss time, the
  official flood danger level (1 to 5) and the thresholds of levels 2 to 5.
- Stations chosen by number or by name (20 at most), and a "Search stations"
  button that finds them by river, lake or place.
- A second source, swisshydroapi, the service read by the swisshydrodata
  library (ported to JavaScript), with the danger level computed from the
  official thresholds.
- Two scene triggers: "Flow above" (1 to 4,000 m³/s, once per rise) and
  "Flood danger level reached" (2 to 5).
- Read every 10 minutes by default, never faster than the interval: 429
  pauses (1 minute to 6 hours), the last read, the readings and the trigger
  states are kept in `/data` across restarts.
- A "Test the stations" button that shows the values of every station.

[Unreleased]: https://github.com/LM1LC3N7/gladys-swiss-hydro/commits/main
