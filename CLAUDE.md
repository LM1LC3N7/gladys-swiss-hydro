# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads the hydrological stations of the Swiss
FOEN (open data on LINDAS, or swisshydroapi, the service of the swisshydrodata
library it ports) and publishes one read-only device per station.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
node .github/scripts/cover.mjs            # draws cover.png
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `test` and
`npm audit --omit=dev` on Node 22 and 24, and builds the Docker image: run them
before pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        HydroApp: stations, pacing, devices, states, triggers, status, buttons
src/client.js                     the three sources, the 429 pauses per host
src/model.js                      answers -> readings, devices, states (pure)
src/triggers.js                   scene events of two readings (pure)
src/store.js                      the state persisted in /data, checked when read back
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js                  endpoints, bounds, feature and manifest keys
src/http.js                       fetch with timeout, no redirect, bounded body
gladys-assistant-integration.json manifest: name, config_schema, actions, scene_triggers...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **External ids are forever**: `station:<FOEN number>`, then the feature keys
  of `FEATURES` (`src/constants.js`). Never rename one; never drop a feature
  from a published device (`deviceOf` keeps every key ever declared).
- **Never faster than the interval** (10 minutes at least): a failure, a 429,
  a restart or a reconnection never brings a read forward. Every call goes
  through `HydroClient.call`, which honours the pauses.
- **Network data is data**: station numbers are checked (digits only), lookups
  go through Maps, numbers through `num()`, dates need an offset and are
  dropped when aberrant. The persisted state is checked the same way.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core's
  `server/utils/constants.js`): the core has no m³/s, so the flow is `unknown`.
- **Reconnection** (`connected`): the client, the pauses and the last read
  stay; the status and the Discovery list are published again.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release); 0.1.0 was
  set by hand once. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync. Files are
  UTF-8 without BOM (a test refuses mojibake).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
