# Swiss Hydro for Gladys

> **Not an official warning system, nor the FOEN regional warning.** For
> floods, follow the official warnings of the FOEN and of your canton
> ([natural hazards portal](https://www.natural-hazards.ch)).

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

| Feature                                | Unit      | Notes                                                                                                                                                                           |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flow                                   | m³/s      | A plain value: Gladys has no m³/s unit, so it shows in the name. A brook measured in l/s is converted. Lakes have none.                                                         |
| Water level                            | m         | Most stations give the altitude of the water (m above sea level), a few a relative height.                                                                                      |
| Water temperature                      | °C        | Only the stations that measure it. Kept out of the room temperature of Gladys.                                                                                                  |
| Measured at                            | text      | The date of the measurement, in Swiss time with CET or CEST ("2026-10-18 05:30 CEST"), whatever the time zone of your Gladys.                                                   |
| Flood danger level                     | 1 to 5    | FOEN source only: the official FOEN level, as LINDAS gives it (1 no or low danger, 2 moderate, 3 considerable, 4 high, 5 very high). Never computed; none when LINDAS has none. |
| Hydrodaten map thresholds wl_1 to wl_4 | m³/s or m | The values `wl_1` to `wl_4` of the hydrodaten.admin.ch map (flow for a river, level for a lake), assumed to be where the levels 2 to 5 start. Shown only, never used.           |

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
     stations and gives the unit of each value, but no danger level: with it,
     no danger level is published and the danger trigger never fires.
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
- **Flood danger level reached (Swiss Hydro)**: FOEN source only. The
  official danger level rose to the chosen level (2 to 5). A jump from 1 to 3
  fires level 2 and level 3. It fires again only after the level stayed under
  it for 30 minutes (a level wavering between 2 and 3 fires 3 once).

Nothing fires, the triggers are only armed, on the first reading of a
station, after a gap of more than 3 hours without a current measurement, and
when the source or the discharge unit of the station changed. Their state is
kept across restarts, so nothing fires twice. An event Gladys could not take
(restarting, down) is kept and sent again for 30 minutes, then dropped. Both
give the station, its flow, its level, the date of the measurement and a
summary in English and French.

These triggers follow the published data, with up to 10 minutes of delay and
more if a service is down: they never replace the official warnings.

## Limits and behavior

- A measurement older than 3 hours (a station out of service) is not
  published; nor is one with an aberrant date (in the future, or more than 30
  days old). The test button still shows it. A reading older than the one
  already kept is ignored.
- If a service answers "too many requests" (429), the integration pauses for
  the time it asks (one minute to six hours), even across restarts. A
  failure never makes it read sooner than the interval, restarts included.
- The thresholds and the discharge units come from the map layer of
  hydrodaten.admin.ch, read once a day; a unit once known is kept. **Without
  that layer, the FOEN source gives no flow** (LINDAS does not say whether a
  station is in m³/s or l/s); the other values go on. A station missing from
  the layer has no flow with the FOEN source: choose swisshydroapi for it.
- **Do not rely on an old danger level.** With the swisshydroapi source, or when LINDAS stops giving a level for a station, nothing new is published for it: Gladys keeps showing the last value it received, which may be outdated. Check the date of the measurement and the official warnings.
- If Gladys does not give the configuration at start, the integration says it
  in its status and asks again after 1 minute, then 2, 4... up to 30.
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
