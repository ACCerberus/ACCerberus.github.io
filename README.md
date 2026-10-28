# LightKeeper — web edition

LightKeeper puts the USCG Light List on one map with the boat ramps, lodging, tides, river
gages, dams and weather around every aid. This repository is the GitHub Pages site for the
browser edition and the public data files the apps read. By Evan Isakson.

| Path | What it is |
|---|---|
| `index.html` | Landing page |
| `lightkeeper/` | The web app (ES modules, no build step), `about.html`, bundled Leaflet + Inter |
| `lightkeeper/data/` | `aids-D<id>.json` (Light List per district), `districts.json`, `stations-tide.json`, `stations-current.json`, `pois-D<id>.json` (places), `manifest.json` |
| `tools/build_aids.py` | Rebuilds the Light List tables and NOAA station lists (stdlib only) |
| `tools/build_pois.py` | Crawls OpenStreetMap (Overpass) for ramps, lodging and parks per district (stdlib only, slow) |
| `.github/workflows/lightkeeper-data.yml` | Weekly job that runs both scripts and commits changed data files |

The desktop app's warm cache downloads the same files from `https://accerberus.github.io/lightkeeper/data/`, so those paths must not move.

## Run locally

```
python -m http.server 8080
```

Then open <http://localhost:8080/> (landing) or <http://localhost:8080/lightkeeper/> (app).
The app talks directly to NAVCEN-derived files on this site, OpenStreetMap, NOAA, USGS, the
National Weather Service and Open-Meteo from the browser; there is no server component.

## Release a new web version

```
python tools/set_version.py 2.0.8
```

stamps the version into `lightkeeper/version.json`, every module import (`?v=`), the CSS links, the
service-worker cache name and the pages. Browsers that ran an older version notice the change on their
next visit, drop their Cache Storage, service worker and IndexedDB data, and reload once. A page cannot
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
code and design are proprietary. Third-party data stays under its own licence (see
`lightkeeper/about.html`).
