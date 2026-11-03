#!/usr/bin/env python3
"""Official USCG sector areas of responsibility -> lightkeeper/data/uscg_sectors.json, used to put each aid in the
right sector (tools/build_aids.py and the desktop app's sync), instead of trusting the Light List's own
GROUP_JURISDICTION field, which is blank or out of date for some aids.

  python tools/build_sectors.py

Source: "USCG Sectors (Public View)", published by the U.S. Coast Guard on ArcGIS Online (keyless). Boundaries follow
33 CFR and the EEZ, and include the Western Rivers sectors. Not for navigation. Polygons are simplified to ~100 m.
Each record: code (the Light List GROUP_JURISDICTION value, matching uscg_units.json), name, district, emergency
(24-hour number as published on the layer), polys ([[ring, hole, ...], ...] in lon/lat).
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
URL = "https://services9.arcgis.com/Fr5UUTVwNRJlXAkf/arcgis/rest/services/USCG_Sectors_view/FeatureServer/0/query"
UA = "LightKeeper data build (cerberusac.dev/lightkeeper)"
# Layer NAME -> Light List GROUP_JURISDICTION code (the key uscg_units.json uses)
CODES = {
    "Sector Boston": "CG SECTOR BOSTON", "Sector Charleston": "CG SECTOR CHARLESTON",
    "Sector Columbia River": "CG SECTOR COLUMBIA RIV", "Sector Corpus Christi": "CG SECTOR CORP CHRISTI",
    "Sector Delaware Bay": "CG SECTOR DELAWARE BAY", "Sector Detroit": "CG SECTOR DETROIT",
    "Sector Eastern Great Lakes": "CG SECTOR E GREATLAKES", "Sector Honolulu": "CG SECTOR HONOLULU",
    "Sector Houston - Galveston": "CG SECTOR HOUSTON GALV", "Sector Humboldt Bay": "CG SECTOR HUMBOLDT BAY",
    "Sector Jacksonville": "CG SECTOR JACKSONVILLE", "Sector Key West": "CG SECTOR KEY WEST",
    "Sector Lake Michigan": "CG SECTOR LAKE MICHIG", "Sector Long Island Sound": "CG SECTOR LNG IS SOUND",
    "Sector Los Angeles - Long Beach": "CG SECTOR LA LB", "Sector Lower Mississippi River": "CG SECTOR LOWER MISS",
    "Sector Maryland - NCR": "CG SECTOR MD-NCR", "Sector Miami": "CG SECTOR MIAMI", "Sector Mobile": "CG SECTOR MOBILE",
    "Sector New Orleans": "CG SECTOR NEW ORLEANS", "Sector New York": "CG SECTOR NEW YORK",
    "Sector North Carolina": "CG SECTOR N CAROLINA", "Sector Northern Great Lakes": "CG SECTOR N GREATLAKES",
    "Sector Northern New England": "CG SECTOR N NEWENGLAND", "Sector Ohio Valley": "CG SECTOR OHIO VALLEY",
    "Sector Puget Sound": "CG SECTOR PUGET SOUND", "Sector San Diego": "CG SECTOR SAN DIEGO",
    "Sector San Francisco": "CG SECTOR SANFRANCISCO", "Sector San Juan": "CG SECTOR SAN JUAN",
    "Sector Southeast AK": "CG SECTOR SE ALASKA", "Sector Southeastern New England": "CG SECTOR SE NEWENGLAN",
    "Sector St. Petersburg": "CG SECTOR STPETERSBURG", "Sector Upper Mississippi River": "CG SECTOR UPPER MISS",
    "Sector Virginia": "CG SECTOR VIRGINIA", "Sector Western Alaska and US Arctic": "CG SECTOR WEST ALASKA",
    "Forces Micronesia -Sector Guam": "CG FORCES MICRONESIA",
}


def fetch() -> dict:
    q = {"where": "1=1", "outFields": "NAME,SectorName,DistrictNa,Emergency_", "outSR": 4326, "f": "geojson",
         "maxAllowableOffset": 0.001, "geometryPrecision": 4}
    req = urllib.request.Request(f"{URL}?{urllib.parse.urlencode(q)}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def main() -> int:
    gj = fetch()
    out, unknown = [], []
    for f in gj["features"]:
        p = f["properties"]
        name = (p.get("NAME") or "").strip()
        code = CODES.get(name)
        if not code:
            unknown.append(name)
            continue
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        out.append({"code": code, "name": name, "district": p.get("DistrictNa") or "",
                    "emergency": (p.get("Emergency_") or "").strip(), "polys": polys})
    if unknown:
        print("New sector names (add them to CODES):", ", ".join(unknown))
    if len(out) < 30:
        print(f"Only {len(out)} sectors: keeping the previous file")
        return 1
    path = DATA / "uscg_sectors.json"
    path.write_text(json.dumps({"source": URL.rsplit('/query', 1)[0], "sectors": out}, separators=(",", ":")), "utf-8")
    print(f"{len(out)} sectors -> {path.name} ({path.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
