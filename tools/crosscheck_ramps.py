#!/usr/bin/env python3
"""Check each district's boat ramps against official agency lists (state fish & wildlife / boating agencies, the
Forest Service and the Park Service), after the OpenStreetMap build.

  python tools/crosscheck_ramps.py                    # all districts
  python tools/crosscheck_ramps.py --districts 13

For every ramp in DISTRICT_<id>_<Name>_Places.json:
  - an official ramp close by (similar name, or practically the same spot) -> sources gets the agency, quality
    "verified", the official name replaces a made-up one ("Boat Ramp (48.496, -117.872)"), and lanes, trailer
    parking, surface, fee, phone and status are added to its tags;
  - the agency lists it as permanently closed / destroyed -> dropped; temporarily closed -> tags.status.
Official ramps OpenStreetMap lacks are added when they are near the district's aids.

All sources are public ArcGIS layers without a key (found and tested 2026-11-02). A source that fails is skipped
for the run; the rest still count. North Carolina's list is left out: its terms allow non-commercial use only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pois as bp  # noqa: E402
import build_places_osm as bo  # noqa: E402
from crosscheck_overture import similar  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
UA = "LightKeeper data build (cerberusac.dev/lightkeeper)"
MATCH_MI = 0.25
SAME_SPOT_MI = 0.05
NAME_MIN = 0.5
PAGE = 1000

# name / lanes / parking / surface / fee / phone / status: field names (first one present wins).
# where: ArcGIS filter. name_from: build a name when the layer has none. ramp_only: keep rows where this is truthy.
SOURCES = [
    {"agency": "Florida FWC", "url": "https://gis.myfwc.com/mapping/rest/services/Open_Data/FWC_Florida_Boat_Ramp_Inventory/MapServer/4",
     "name": ["RampName"], "lanes": ["TotalLanes"], "parking": ["Trailer"], "surface": ["RampSurface"], "fee": ["FeeAmount", "isFeeRequired"],
     "phone": ["ContactPhone"], "status": ["Status"], "web": ["URL"]},
    {"agency": "Oregon State Marine Board", "url": "https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/Boating_Access_Sites_OA/FeatureServer/0",
     "name": ["name"], "lanes": ["ramp_lanes"], "parking": ["PARKING"], "phone": ["manager_phone"],
     "status": ["oa_status"], "web": ["web_url"]},
    {"agency": "Michigan DNR", "url": "https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services/PRDBASPublicView/FeatureServer/0",
     "name": ["name"], "lanes": ["nlanes"], "parking": ["ntrailerableparking"], "surface": ["rampdflttype"], "phone": ["phone"], "status": ["launch_status"]},
    {"agency": "Minnesota DNR", "url": "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_dnr/struc_water_access_sites/FeatureServer/0",
     "name": ["access_name"], "lanes": ["number_of_ramps"], "parking": ["trailer_parking_spaces_non_ada"], "surface": ["ramp_surface"],
     "ramp_only": "number_of_ramps"},
    {"agency": "Wisconsin DNR", "url": "https://dnrmaps.wi.gov/arcgis2/rest/services/PR_Recreation/PR_Boat_Access_Shore_Fishing_WTM_Ext/MapServer/2",
     "name": ["LMS_BOAT_LANDING_NAME"], "surface": ["RAMP_TYPE_CODE"], "phone": ["OWNERSHIP_MANAGER_PHONE_TEXT"], "closed_flag": "ABANDON_FLAG"},
    {"agency": "Washington WDFW", "url": "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_RealEstate/WaterAccessSites/MapServer/1",
     "name": ["WaterAccessSiteName"], "lanes": ["BoatRamps"], "surface": ["BoatRampSurfaceTypes"], "status": ["ClosureType"], "ramp_only": "BoatRamps"},
    {"agency": "Washington State Parks", "url": "https://services5.arcgis.com/4LKAHwqnBooVDUlX/arcgis/rest/services/WAStateParks_BoatLaunches/FeatureServer/0",
     "name": ["Identifier"], "add": False},
    {"agency": "New York DEC", "url": "https://services6.arcgis.com/DZHaqZm9cxOD4CWM/arcgis/rest/services/Boat_Launch_Sites/FeatureServer/4",
     "name_from": ["WATERBODY"], "surface": ["ACCESS_TYP"], "web": ["WEBLINK"], "add": False},
    {"agency": "Maryland DNR", "url": "https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/Public_Water_Access_2020/FeatureServer/0",
     "name": ["SiteName"], "lanes": ["RampLanes"], "parking": ["TrailerSpaces"], "surface": ["RampSurface"], "fee": ["FeeOrPermitRequired"],
     "phone": ["OwnerManagerPhone"], "ramp_only": "BoatRamp"},
    {"agency": "Louisiana LDWF", "url": "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/LA_Boat_Launch_Marina/FeatureServer/0",
     "name": ["Boat_Launc"], "surface": ["Ramp_and_P"], "phone": ["Phone"], "public_field": "Access"},
    {"agency": "Alaska boat launches (UAA / ADF&G)", "url": "https://services7.arcgis.com/DlE4MSUhoXlyq64t/arcgis/rest/services/Boat_Launches___Ramps/FeatureServer/0",
     "name": ["Name"], "surface": ["LaunchRamp"], "parking": ["Parking"], "fee": ["Permit"]},
    {"agency": "Idaho Fish and Game", "url": "https://services.arcgis.com/FjJI5xHF2dUPVrgK/arcgis/rest/services/IDFG_Fishing_and_Boating_Access_FFW_App/FeatureServer/1",
     "name": ["site_name"], "status": ["status"], "where": "ramp='yes'"},
    {"agency": "Texas TPWD", "url": "https://services1.arcgis.com/1mtXwieMId59thmg/arcgis/rest/services/BoatRamps_Public/FeatureServer/0",
     "name_from": ["AccessTypeDescription"], "add": False},
    {"agency": "US Forest Service", "url": "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecInfraRecreationSites_02/MapServer/0",
     "name": ["public_site_name", "site_name"], "fee": ["fee_charged"], "status": ["seasonal_operational_status"], "web": ["rec1stop_url"],
     "where": "site_type='BOATING SITE'"},
    {"agency": "National Park Service", "url": "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_POIs/FeatureServer/0",
     "name": ["POINAME"], "status": ["POISTATUS"], "where": "POITYPE in ('Boat Launch','Boat Ramp')"},
]
NOT_FOR_BOATS = re.compile(r"kayak|paddle|canoe|airboat|hand launch|carry.?in|tube|swim", re.I)   # not a trailer ramp: never added
CLOSED_FOR_GOOD = re.compile(r"permanent|destroyed|abandon|removed|decommission", re.I)
CLOSED_NOW = re.compile(r"clos|restrict", re.I)
NOT_CLOSED = re.compile(r"^\s*(no|none|open)\b", re.I)          # "No closure", "Open"


def closed_now(status: str) -> bool:
    return bool(status) and bool(CLOSED_NOW.search(status)) and not NOT_CLOSED.search(status)


def lanes_ok(o: dict) -> bool:
    """Added ramps need at least one launch lane when the agency counts lanes (skips put-ins and hand launches)."""
    if not o["has_lanes"]:
        return True
    try:
        return float(o["tags"].get("lanes", "0")) >= 1
    except ValueError:
        return False


def fetch_layer(src: dict) -> list[dict]:
    feats, offset = [], 0
    while True:
        q = {"where": src.get("where", "1=1"), "outFields": "*", "outSR": 4326, "f": "geojson",
             "resultOffset": offset, "resultRecordCount": PAGE}
        req = urllib.request.Request(f"{src['url']}/query?{urllib.parse.urlencode(q)}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as resp:
            gj = json.loads(resp.read())
        if "error" in gj:
            raise RuntimeError(gj["error"])
        page = gj.get("features") or []
        feats.extend(page)
        if not page or not (gj.get("exceededTransferLimit") or gj.get("properties", {}).get("exceededTransferLimit")) and len(page) < PAGE:
            return feats
        offset += len(page)
        time.sleep(0.5)


def _get(props: dict, keys: list[str] | None) -> str:
    lower = {k.lower(): v for k, v in props.items()}
    for k in keys or ():
        v = lower.get(k.lower())
        if v not in (None, "", " ") and str(v).strip().lower() not in ("null", "none", "n/a", "unknown"):
            return str(v).strip()
    return ""


def _point(geom: dict | None) -> tuple[float, float] | None:
    if not geom:
        return None
    if geom["type"] == "Point":
        lon, lat = geom["coordinates"][:2]
        return lat, lon
    ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0] if geom["type"] == "MultiPolygon" else None
    if not ring:
        return None
    return sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring)


def official_ramps(src: dict) -> list[dict]:
    out = []
    for f in fetch_layer(src):
        props, pt = f.get("properties") or {}, _point(f.get("geometry"))
        if not pt or not bp.valid_coords(*pt):
            continue
        if src.get("ramp_only"):
            v = _get(props, [src["ramp_only"]]).lower()
            if v in ("", "0", "no", "n", "false"):
                continue
        if src.get("public_field") and "private" in _get(props, [src["public_field"]]).lower():
            continue
        name = _get(props, src.get("name"))
        if not name and src.get("name_from"):
            water = _get(props, src["name_from"])
            name = f"{water} Boat Ramp" if water else ""
        status = _get(props, src.get("status"))
        if src.get("closed_flag") and _get(props, [src["closed_flag"]]).lower() in ("y", "yes", "1", "true"):
            status = "abandoned"
        out.append({
            "agency": src["agency"], "name": bp.tidy_name(name) if name else "", "lat": pt[0], "lon": pt[1], "status": status,
            "tags": {k: v for k, v in {"lanes": _get(props, src.get("lanes")), "trailer_parking": _get(props, src.get("parking")),
                                        "surface": _get(props, src.get("surface")), "fee": _get(props, src.get("fee"))}.items() if v},
            "phone": bp.clean_phone(_get(props, src.get("phone"))), "website": _get(props, src.get("web")),
            "add": src.get("add", True), "has_lanes": bool(src.get("lanes")),
        })
    return out


def crosscheck(places: list[dict], official: list[dict], cells: set) -> tuple[list[dict], dict]:
    grid: dict[tuple[int, int], list[dict]] = {}
    for o in official:
        grid.setdefault((int(o["lat"] * 50), int(o["lon"] * 50)), []).append(o)   # ~1.4 mi cells
    used: set[int] = set()
    c = {"ramps": 0, "confirmed": 0, "renamed": 0, "closed": 0, "added": 0}
    kept = []
    for p in places:
        if p["kind"] != "ramp" or p["id"].startswith("official:"):
            kept.append(p)
            continue
        c["ramps"] += 1
        cy, cx = int(p["lat"] * 50), int(p["lon"] * 50)
        best, best_score = None, -1.0
        for o in (o for dy in (-1, 0, 1) for dx in (-1, 0, 1) for o in grid.get((cy + dy, cx + dx), ())):
            d = bp.haversine_miles(p["lat"], p["lon"], o["lat"], o["lon"])
            if d > MATCH_MI:
                continue
            score = similar(p["name"], o["name"]) if p.get("name_source") == "osm" and o["name"] else 0.0
            if d <= SAME_SPOT_MI:
                score = max(score, NAME_MIN)
            if score >= NAME_MIN and score - d > best_score:
                best, best_score = o, score - d
        if best is None:
            kept.append(p)
            continue
        used.add(id(best))
        if CLOSED_FOR_GOOD.search(best["status"]):
            c["closed"] += 1
            continue
        c["confirmed"] += 1
        p["sources"] = sorted(set((p.get("sources") or [p.get("source", "OpenStreetMap")]) + [best["agency"]]))
        p["quality"] = "verified"
        if p.get("name_source") != "osm" and best["name"]:
            p["name"], p["name_source"] = best["name"], "official"
            c["renamed"] += 1
        p.setdefault("tags", {}).update({k: v for k, v in best["tags"].items() if v})
        if closed_now(best["status"]):
            p["tags"]["status"] = best["status"]
        for field in ("phone", "website"):
            if not p.get(field) and best[field]:
                p[field] = best[field]
        kept.append(p)
    for o in official:
        if id(o) in used or not o["add"] or not o["name"] or NOT_FOR_BOATS.search(o["name"]) or not lanes_ok(o) or CLOSED_FOR_GOOD.search(o["status"]) or not bo.near_aids(o, cells):
            continue
        kept.append({"id": f"official:{o['agency']}:{o['lat']:.5f},{o['lon']:.5f}", "kind": "ramp", "name": o["name"],
                     "name_source": "official", "lat": round(o["lat"], 6), "lon": round(o["lon"], 6), "address": "",
                     "phone": o["phone"], "website": o["website"], "operator": o["agency"],
                     "tags": dict(o["tags"], **({"status": o["status"]} if closed_now(o["status"]) else {})),
                     "quality": "verified", "source": o["agency"], "sources": [o["agency"]]})
        c["added"] += 1
    return (bp.dedup_by_kind(kept) if c["added"] else kept), c


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--districts", default="")
    args = ap.parse_args()
    official: list[dict] = []
    for src in SOURCES:
        t0 = time.time()
        try:
            rows = official_ramps(src)
            official.extend(rows)
            print(f"  {src['agency']}: {len(rows):,} ramps ({time.time() - t0:.0f}s)", flush=True)
        except Exception as exc:  # noqa: BLE001 - one agency down doesn't stop the rest
            print(f"  {src['agency']}: FAILED ({exc})", flush=True)
    man = json.loads((DATA / "manifest.json").read_text("utf-8"))
    wanted = {x.strip() for x in args.districts.split(",") if x.strip()}
    for did, entry in sorted((man.get("places") or {}).items(), key=lambda kv: int(kv[0])):
        if wanted and did not in wanted:
            continue
        path = DATA / entry["file"]
        cells = bo.aid_cells(int(did))
        result, c = crosscheck(json.loads(path.read_text("utf-8")), official, cells)
        result.sort(key=lambda r: (r["kind"], r["name"]))
        bp.write_district(path, result)
        print(f"D{int(did):02d}: {c['ramps']:,} ramps checked, {c['confirmed']:,} confirmed ({c['renamed']} renamed), "
              f"{c['closed']} closed dropped, {c['added']} official ramps added", flush=True)
    bp.update_manifest(DATA)
    return 0


if __name__ == "__main__":
    sys.exit(main())
