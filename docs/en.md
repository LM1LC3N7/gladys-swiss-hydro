# Swiss Hydro for Gladys

Unofficial connector, not affiliated with the Swiss Federal Office for the
Environment (FOEN). It brings the hydrological stations of the FOEN into
Gladys: the Aare in Bern, the Rhône at the Porte du Scex, Lake Geneva, the
Rhine in Basel and about 230 other rivers and lakes.

> **Status: never been tested in a real Gladys installation.** The parsing was
> checked by hand against the real public services during development
> (read-only calls, 2026-10-18), but the module has not run in Gladys yet.
> Please report what you see.

Source: FOEN. Public open data, no account, no key.

## What you get

One device per station, with:

| Feature                  | Unit      | Notes                                                                                                                   |
| ------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Flow                     | m³/s      | A plain value: Gladys has no m³/s unit, so it shows in the name. A brook measured in l/s is converted. Lakes have none. |
| Water level              | m         | Most stations give the altitude of the water (m above sea level), a few a relative height.                              |
| Water temperature        | °C        | Only the stations that measure it. Kept out of the room temperature of Gladys.                                          |
| Measured at              | text      | The date of the measurement, in Swiss time ("2026-10-18 05:30"), whatever the time zone of your Gladys.                 |
| Flood danger level       | 1 to 5    | The official FOEN level: 1 no or low danger, 2 moderate, 3 considerable, 4 high, 5 very high.                           |
| Danger thresholds 2 to 5 | m³/s or m | Where each level starts at this station (flow for a river, level for a lake), when the FOEN publishes them.             |

A feature only appears when the station gives its value. Once a device is
created, a feature never disappears from it, even if the station stops
sending it for a while.

## Configuration

1. Install the integration from the store, then open its configuration.
2. **Stations**: FOEN station numbers, separated by commas, for example
   `2135, 2009`. A name works too (`Rhône Porte du Scex`) if it matches one
   station only. 20 stations at most.
3. To find a number, type a river, a lake or a place in the **Search
   stations** button (for example `Rhone` or `Leman`), or use the
   [FOEN map](https://www.hydrodaten.admin.ch/en/aktuelle-lage).
4. **Data source**:
   - _FOEN open data (LINDAS)_, the default: the official values and danger
     level, published by the FOEN on LINDAS, the linked data service of the
     Swiss federal administration.
   - _swisshydroapi (Bouni)_: the service read by the
     [swisshydrodata](https://github.com/Bouni/swisshydrodata) library (and
     the Home Assistant integration), run by its author. It knows more
     stations; the danger level is then computed from the official
     thresholds.
5. **Read interval**: 10 minutes by default, 10 at least (the FOEN measures
   every 10 minutes), 60 at most. All the stations are read together, in one
   request (one request per station with swisshydroapi).
6. Click **Test the stations**, then add the devices from the Discovery tab.

## Scenes

Two triggers:

- **Flow above (Swiss Hydro)**: the flow of a station reached a chosen value
  (1 to 4,000 m³/s). It fires once per rise, and again only after the flow
  fell under 95 % of the value. For any other value, use the usual device
  trigger on the Flow feature ("value above").
- **Flood danger level reached (Swiss Hydro)**: the danger level rose to the
  chosen level (2 to 5). A jump from 1 to 3 fires level 2 and level 3. It
  fires again after the level went down and up again.

The first reading after an installation only arms the triggers: nothing fires
because a river is already high when Gladys starts. Their state is kept
across restarts, so nothing fires twice. Both give the station, its flow, its
level, the date of the measurement and a summary in English and French.

These triggers follow the published data, with up to 10 minutes of delay and
more if the service is down: they never replace the official warnings of the
FOEN and of your canton ([natural hazards portal](https://www.natural-hazards.ch)).

## Limits and behavior

- A measurement older than 3 hours (a station out of service) is not
  published; nor is one with an aberrant date (in the future, or more than 30
  days old). The test button still shows it.
- If a service answers "too many requests" (429), the integration pauses for
  the time it asks (one minute to six hours), even across restarts. A
  failure never makes it read sooner than the interval.
- The thresholds and units come from the map layer of hydrodaten.admin.ch,
  read once a day; if it fails, the values go on without them. With the FOEN
  source, a station missing from that layer has no flow (its unit, m³/s or
  l/s, is unknown): choose the swisshydroapi source for it.
- Nothing is sent but the station numbers. The integration writes only its
  state file in `/data`.

## Credits

- Data: Swiss Federal Office for the Environment (FOEN), "Current
  hydrological monitoring data from the FOEN", open government data on
  [LINDAS](https://lindas.admin.ch), terms "Open use" of opendata.swiss; the
  thresholds from [hydrodaten.admin.ch](https://www.hydrodaten.admin.ch).
- Code: a JavaScript port of
  [swisshydrodata](https://github.com/Bouni/swisshydrodata) 0.3.1 by Bouni
  (MIT). See `THIRD_PARTY_NOTICES.md`.
