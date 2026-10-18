# gladys-swiss-hydro

[Gladys Assistant](https://gladysassistant.com) external integration for the
hydrological stations of the Swiss Federal Office for the Environment (FOEN):
flow, water level, water temperature, date of the measurement and official
flood danger level of the rivers and lakes you choose (Aare, Rhône, Lake
Geneva...), from the FOEN open data, without account. **Unofficial, not
affiliated with the FOEN. Never tested in a real Gladys installation yet**
(the parsing was checked against the real public services, read-only, during
development).

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys <-> SDK <-> src/app.js (HydroApp)   stations, what is due, devices, states, triggers, status, buttons
                    |- src/client.js        LINDAS, thresholds layer, swisshydroapi; 429 pauses per host
                    |- src/model.js         answers -> readings, devices, states (pure)
                    |- src/triggers.js      "flow above", "danger level reached" (pure)
                    |- src/store.js         the state kept in /data (checked when read back)
                    `- src/http.js          fetch, timeout, no redirect, bounded body, host-only errors
```

- **FOEN source** (default): one SPARQL query to `https://ld.admin.ch/query`
  (LINDAS) per interval for every station (`VALUES ?id { ... }`): discharge,
  water level, water temperature, danger level, measurement time.
- **Thresholds**: `https://www.hydrodaten.admin.ch/web-hydro-maps/hydro_sensor_pq.geojson`
  once a day: the danger thresholds (`wl_1` .. `wl_4`) and the discharge unit
  of each station (LINDAS gives a brook in l/s without saying so).
- **swisshydroapi source**: `GET https://swisshydroapi.bouni.de/api/v1/station/<id>`
  per station, one second apart (the port of swisshydrodata 0.3.1).
- **Pacing**: 10 minutes by default and at least; a failure or a 429 never
  reads sooner; 429 pauses (Retry-After, else 10 minutes doubling, 1 minute
  to 6 hours) and the last read are persisted.
- **Devices**: one per station, external id `station:<number>`, features
  `flow`, `level`, `temperature`, `measured-at`, `danger-level`,
  `danger-threshold-2` .. `danger-threshold-5`.

No runtime dependency besides the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

The fixtures in `test/fixtures/` are real answers of the public services,
read on 2026-10-18 and reduced to a few stations.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- Data: Swiss Federal Office for the Environment (FOEN), open government
  data on [LINDAS](https://lindas.admin.ch) ("Open use"), thresholds from
  [hydrodaten.admin.ch](https://www.hydrodaten.admin.ch).
- [swisshydrodata](https://github.com/Bouni/swisshydrodata) (MIT, Bouni):
  ported to JavaScript for the swisshydroapi source; its notice is in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0 ([LICENSE](LICENSE)).
