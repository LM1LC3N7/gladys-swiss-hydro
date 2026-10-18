# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).
It ports work of others, and reads public data, credited below.

## swisshydrodata

The client of the swisshydroapi source (`src/client.js`: the `/stations` and
`/station/<id>` endpoints, the shape of their answers with a unit, a date and
24-hour statistics per parameter) is a JavaScript port of
[swisshydrodata](https://github.com/Bouni/swisshydrodata) 0.3.1, the Python
library behind the Swiss hydrological data integration of Home Assistant. No
code was copied verbatim: the logic was re-implemented. swisshydrodata is
distributed under the MIT License:

```
MIT License

Copyright (c) 2018 Bouni

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The swisshydroapi service itself (`swisshydroapi.bouni.de`) is run by the
author of swisshydrodata; this integration only reads it, and only when the
user chooses that source.

## Data: Swiss Federal Office for the Environment (FOEN / OFEV / BAFU)

Source: FOEN. The values come from the Swiss Federal Office for the
Environment; this integration is not affiliated with it, and the FOEN gives no
warranty on the data nor on its availability.

- **Current hydrological monitoring data from the FOEN** ("Données de mesure
  hydrologiques actuelles de l'OFEV"), published as open government data on
  [LINDAS](https://lindas.admin.ch), the linked data service of the Swiss
  federal administration, under the terms of use "Open use"
  (`https://ld.admin.ch/vocabulary/TermsOfUse/Open-Use`, the "open use" terms
  of [opendata.swiss](https://opendata.swiss/en/terms-of-use)): free use,
  commercial use allowed. The source is named anyway.
  The flood danger level (1 to 5) is published only as LINDAS gives it, never
  computed.
- **The values `wl_1` to `wl_4` and the discharge units of the stations**,
  read once a day from the public map layer of
  [hydrodaten.admin.ch](https://www.hydrodaten.admin.ch), under the
  [terms of use of the federal administration websites](https://www.admin.ch/gov/en/start/terms-and-conditions.html).
  The `wl_N` values are shown as thresholds assumed to start the danger
  levels 2 to 5; the FOEN does not document them as such.

This integration is not an official warning system, nor the FOEN regional
warning: the official warnings are those of the FOEN and of the cantons
([natural hazards portal](https://www.natural-hazards.ch)).
