# LightKeeper — web edition

LightKeeper puts the USCG Light List on one map with the boat ramps, lodging, tides, river
gages, dams and weather around every aid. This repository is the GitHub Pages site for the
browser edition and the public data files the apps read. By Evan Isakson.

| Path | What it is |
|---|---|
| `index.html` | Landing page |
| `lightkeeper/` | The web app (ES modules, no build step), `about.html`, bundled Leaflet + Inter |
| `lightkeeper/data/` | `aids-D<id>.json` (Light List per district), `districts.json`, `stations-tide.json`, `stations-current.json`, `bnm-D<id>.json` (Broadcast Notices, hourly), `ndbc-latest.json` (NOAA buoys, hourly), `cwms-dams.json` (Army Corps dams), `manifest.json`. Places files (`DISTRICT_<id>_<Name>_Places.json`) are paused until they're built from OpenStreetMap state files |
| `tools/build_aids.py` | Rebuilds the Light List tables and NOAA station lists (stdlib only) |
| `tools/build_pois.py` | Crawls OpenStreetMap (Overpass) for ramps, lodging and parks per district (stdlib only, slow) |
| `tools/build_bnm.py`, `tools/build_ndbc.py` | Broadcast Notices for all nine districts and the latest NOAA buoy readings |
| `.github/workflows/lightkeeper-data.yml` | Weekly job: Light List and station lists (the places crawl only runs when started by hand) |
| `.github/workflows/lightkeeper-bnm.yml` | Hourly job: Broadcast Notices and NOAA buoys |
| `_headers` | Cloudflare Pages headers: caching, content security policy, no framing, permissions policy |

The desktop app's warm cache downloads the same files from `https://accerberus.github.io/lightkeeper/data/`, so those paths must not move.

## Run locally

```
python -m http.server 8080
```

Then open <http://localhost:8080/> (landing) or <http://localhost:8080/lightkeeper/> (app).
The app talks directly to NAVCEN-derived files on this site, OpenStreetMap, NOAA, USGS, the
National Weather Service, Open-Meteo, the Army Corps and OSRM from the browser (the trip planner runs in the page);
there is no server component. Hosted on Cloudflare Pages.

## Release a new web version

```
python tools/set_version.py 2.1.4      # or: 2.1.4 2  for a rebuild of the same version
```

stamps the version into `lightkeeper/version.json`, every module import (`?v=`), the CSS links, the
service-worker cache name and the pages. Browsers that ran an older version notice the change on their
next visit (or within 2 minutes while open: "Updating to version ..."), drop their Cache Storage and service worker,
and reload once. Downloaded data (IndexedDB) and the user's selections, trips and settings are kept. A page cannot
clear the browser's own HTTP cache; the `?v=` URLs make that cache irrelevant for the app code.

## Refresh the data by hand

```
python tools/build_aids.py            # Light List + NOAA stations, about a minute
python tools/build_pois.py            # places crawl, one Overpass request at a time (an hour or more)
python tools/build_pois.py --districts 13 --pause 3
```

Both scripts leave a district's previous file in place when its download fails.

## Notices

Not for navigation. LightKeeper © 2026 Evan Isakson, all rights reserved; the application, its
code and design are proprietary. Third-party data stays under its own license (see
`lightkeeper/about.html`).

## Turning on the Windows download

The "Windows app" buttons read `/download.json`. While `"enabled": false` they show "coming soon".
To publish a build: copy the exe to `downloads/LightKeeper.exe`, set `"enabled": true` and the
`"version"` in `download.json`, then commit. The buttons then download the exe straight from this
site (no GitHub page). GitHub Pages allows files up to 100 MB; the exe is about 27 MB.
