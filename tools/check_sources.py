#!/usr/bin/env python3
"""Daily health check of every data source LightKeeper uses, and of the data files the site publishes.

  python tools/check_sources.py            # writes lightkeeper/data/health.json; exit 1 if a must-have source is down

Each source is asked a small real question (one district's Light List file, Seattle's tides, a Seattle forecast...)
and the answer is checked for the shape the app expects, so a format change shows up as well as an outage. Each
check gets three tries a minute apart, so a short blip doesn't count. "Must-have" sources fail the GitHub job (and
GitHub emails the repo owner); the public OpenStreetMap servers are known to be flaky and only warn.

What to do when one fails: see "If a source breaks" in LightKeeper2/docs/repair.md.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "lightkeeper" / "data"
UA = "LightKeeper health check (cerberusac.dev/lightkeeper)"
TIMEOUT = 40
TRIES = 3
PAUSE_S = 60
DISTRICTS = (1, 5, 7, 8, 9, 11, 13, 14, 17)


class Bad(Exception):
    """The source answered, but not with what the app needs."""


def get(url: str, params: dict[str, Any] | None = None, accept: str = "application/json") -> bytes:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def get_json(url: str, params: dict[str, Any] | None = None, accept: str = "application/json") -> Any:
    return json.loads(get(url, params, accept))


def need(cond: Any, why: str) -> None:
    if not cond:
        raise Bad(why)


# ── Live sources (the app or the data jobs call these) ──

def navcen() -> str:
    d = get_json("https://www.navcen.uscg.gov/sites/default/files/msi/lightListD13_1.geojson")
    feats = d.get("features") or []
    need(len(feats) > 100, f"only {len(feats)} aids in lightListD13_1.geojson")
    need(feats[0].get("geometry", {}).get("coordinates"), "aids have no coordinates")
    return f"{len(feats)} aids in D13 part 1"


def govdelivery() -> str:
    body = get("https://public.govdelivery.com/topics/USDHSCG_393/feed.rss", accept="application/rss+xml").decode("utf-8", "replace")
    need("<rss" in body and "<item" in body, "D13 notices feed has no items")
    return f"{body.count('<item')} D13 notices"


def ndbc() -> str:
    lines = get("https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt", accept="text/plain").decode("utf-8", "replace").splitlines()
    need(len(lines) > 300 and lines[0].startswith("#STN"), f"{len(lines)} lines, header {lines[:1]}")
    return f"{len(lines) - 2} buoys"


def coops_stations() -> str:
    d = get_json("https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json", {"type": "tidepredictions"})
    n = len(d.get("stations") or [])
    need(n > 2000, f"only {n} tide stations")
    return f"{n} tide stations"


def coops_tides() -> str:
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    d = get_json("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter", {
        "station": "9447130", "product": "predictions", "datum": "MLLW", "interval": "hilo", "units": "english",
        "time_zone": "lst_ldt", "format": "json", "begin_date": day, "end_date": day, "application": "LightKeeper"})
    p = d.get("predictions") or []
    need(len(p) >= 2 and "t" in p[0] and "v" in p[0], f"Seattle tides: {str(d)[:120]}")
    return f"{len(p)} Seattle highs/lows today"


def nws() -> str:
    pt = get_json("https://api.weather.gov/points/47.6062,-122.3321", accept="application/geo+json")
    url = pt.get("properties", {}).get("forecast")
    need(url, "no forecast link for Seattle")
    fc = get_json(url, accept="application/geo+json")
    periods = fc.get("properties", {}).get("periods") or []
    need(periods and "temperature" in periods[0], "forecast has no periods")
    return f"{len(periods)} forecast periods"


def usgs() -> str:
    d = get_json("https://waterservices.usgs.gov/nwis/iv/", {"format": "json", "stateCd": "wa", "parameterCd": "00010", "siteStatus": "active"})
    ts = d.get("value", {}).get("timeSeries") or []
    need(len(ts) > 5, f"only {len(ts)} WA water-temperature gauges")
    return f"{len(ts)} WA water-temperature gauges"


def nid() -> str:
    d = get_json("https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/NID_v1/FeatureServer/0/query", {
        "where": "STATE='Washington' AND NID_HEIGHT>=10", "outFields": "NIDID,NAME,NID_HEIGHT,RIVER_OR_STREAM",
        "resultRecordCount": 5, "f": "json"})
    need("error" not in d, f"error {d.get('error')}")
    feats = d.get("features") or []
    need(feats and "RIVER_OR_STREAM" in feats[0].get("attributes", {}), "dam records missing expected fields")
    return "dam inventory answers with the expected fields"


def cwms() -> str:
    d = get_json("https://cwms-data.usace.army.mil/cwms-data/catalog/TIMESERIES", {"office": "NWDP", "like": "IHR.*", "page-size": 20},
                 accept="application/json;version=2")
    entries = d.get("entries") or []
    need(entries, "no Ice Harbor time series in the catalog")
    return f"{len(entries)} Ice Harbor series"


def open_meteo() -> str:
    d = get_json("https://api.open-meteo.com/v1/forecast", {"latitude": 47.6, "longitude": -122.3, "current": "temperature_2m,wind_speed_10m"})
    need("temperature_2m" in (d.get("current") or {}), "no current conditions")
    return "current conditions OK"


def noaa_charts() -> str:
    body = get("https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer", {
        "service": "WMS", "request": "GetMap", "version": "1.3.0", "layers": "0,1,2,3,4,5,6,7,8,9,10,11,12", "styles": "",
        "format": "image/png", "transparent": "true", "crs": "EPSG:3857", "width": 256, "height": 256,
        "bbox": "-13627361,6026906,-13617577,6036690"}, accept="image/png")
    need(body[:4] == b"\x89PNG" and len(body) > 1000, f"not a chart image ({len(body)} bytes)")
    return f"chart tile {len(body) // 1024} KB"


def osm_tiles() -> str:
    body = get("https://tile.openstreetmap.org/10/163/357.png", accept="image/png")
    need(body[:4] == b"\x89PNG", "not a PNG")
    return "street map tile OK"


def esri_tiles() -> str:
    body = get("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/10/357/163", accept="image/jpeg")
    need(len(body) > 1000, "empty satellite tile")
    return "satellite tile OK"


def wikimedia() -> str:
    d = get_json("https://commons.wikimedia.org/w/api.php", {"action": "query", "list": "geosearch", "gscoord": "47.6062|-122.3321",
                                                             "gsradius": 1000, "gsnamespace": 6, "gslimit": 3, "format": "json"})
    need("query" in d, f"{str(d)[:120]}")
    return "photo search OK"


def overpass() -> str:
    q = '[out:json][timeout:20];node["leisure"="slipway"](47.5,-122.5,47.7,-122.2);out 5;'
    d = json.loads(get("https://overpass-api.de/api/interpreter", {"data": q}))
    return f"{len(d.get('elements') or [])} ramps near Seattle"


def photon() -> str:
    d = get_json("https://photon.komoot.io/api/", {"q": "boat ramp", "lat": 47.6, "lon": -122.3, "limit": 3})
    need(d.get("features") is not None, "no features")
    return "place search OK"


def nominatim() -> str:
    d = get_json("https://nominatim.openstreetmap.org/search", {"q": "Seattle", "format": "json", "limit": 1})
    need(d, "no results")
    return "place search OK"


def osrm() -> str:
    d = get_json("https://router.project-osrm.org/route/v1/driving/-122.33,47.60;-122.20,47.61", {"overview": "false"})
    need(d.get("code") == "Ok", f"{d.get('code')}")
    return f"drive {round(d['routes'][0]['duration'] / 60)} min"


# ── Published files (built by this repo's own jobs) ──

def light_list_files() -> str:
    man = json.loads((DATA / "manifest.json").read_text("utf-8"))
    counts = man.get("counts") or {}
    for d in DISTRICTS:
        rows = len(json.loads((DATA / f"aids-D{d}.json").read_text("utf-8")).get("rows") or [])
        need(rows > 300, f"aids-D{d}.json has {rows} aids")
        need(rows == counts.get(str(d)), f"aids-D{d}.json has {rows} aids, manifest says {counts.get(str(d))}")
    built = datetime.fromisoformat(man["built_at"].replace("Z", "+00:00"))
    need(datetime.now(timezone.utc) - built < timedelta(days=15), f"Light List last built {man['built_at']} (weekly job stalled?)")
    return f"{man.get('total')} aids, built {man['built_at'][:10]}"


def bnm_feeds() -> str:
    """Every district's notice feeds, the way the hourly job reads them (it keeps the old file when one fails)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import bnm  # noqa: PLC0415
    total = 0
    for d in bnm.FEEDS:
        try:
            total += len(bnm.fetch_district(d, UA, strict=True))
        except Exception as exc:  # noqa: BLE001
            raise Bad(f"D{d} notice feeds failed: {exc}") from exc
    return f"{total} notices across {len(bnm.FEEDS)} districts"


def ndbc_file() -> str:
    items = json.loads((DATA / "ndbc-latest.json").read_text("utf-8")).get("items") or []
    need(len(items) > 300, f"only {len(items)} buoys in ndbc-latest.json")
    return f"{len(items)} buoys"


# name, check, must-have
CHECKS: list[tuple[str, Callable[[], str], bool]] = [
    ("USCG Light List (NAVCEN)", navcen, True),
    ("Broadcast Notices (GovDelivery)", govdelivery, True),
    ("NOAA buoys (NDBC)", ndbc, True),
    ("NOAA tide stations", coops_stations, True),
    ("NOAA tide predictions", coops_tides, True),
    ("National Weather Service", nws, True),
    ("USGS water temperature", usgs, True),
    ("Dam inventory (NID)", nid, True),
    ("Army Corps dam readings (CWMS)", cwms, True),
    ("Open-Meteo weather", open_meteo, True),
    ("NOAA charts", noaa_charts, True),
    ("OpenStreetMap tiles", osm_tiles, True),
    ("Esri satellite tiles", esri_tiles, True),
    ("Wikimedia photos", wikimedia, False),
    ("Overpass (places)", overpass, False),
    ("Photon (place search)", photon, False),
    ("Nominatim (place search)", nominatim, False),
    ("OSRM (drive times)", osrm, False),
    ("Published Light List files", light_list_files, True),
    ("Notice feeds, all districts", bnm_feeds, True),
    ("Published buoy file", ndbc_file, True),
]


def run(check: Callable[[], str], tries: int) -> tuple[bool, str, int]:
    detail = ""
    for attempt in range(tries):
        t0 = time.monotonic()
        try:
            return True, check(), round((time.monotonic() - t0) * 1000)
        except Bad as exc:
            detail = f"wrong answer: {exc}"
        except Exception as exc:  # noqa: BLE001 - any failure is a finding
            detail = f"{type(exc).__name__}: {exc}"[:300]
        if attempt < tries - 1:
            time.sleep(PAUSE_S)
    return False, detail, 0


def main() -> int:
    tries = 1 if "--quick" in sys.argv else TRIES
    results = []
    for name, check, must in CHECKS:
        ok, detail, ms = run(check, tries)
        results.append({"name": name, "ok": ok, "must_have": must, "detail": detail, "ms": ms})
        print(f"{'OK  ' if ok else ('FAIL' if must else 'WARN')}  {name}: {detail}")
    report = {"checked_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "sources": results}
    (DATA / "health.json").write_text(json.dumps(report, indent=1) + "\n", "utf-8", newline="\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("| | Source | Result |\n|---|---|---|\n")
            for r in results:
                f.write(f"| {'✅' if r['ok'] else ('❌' if r['must_have'] else '⚠️')} | {r['name']} | {r['detail']} |\n")
    down = [r["name"] for r in results if not r["ok"] and r["must_have"]]
    if down:
        print("\nDOWN or CHANGED: " + ", ".join(down))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
