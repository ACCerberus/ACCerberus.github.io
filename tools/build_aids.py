#!/usr/bin/env python3
"""Build the LightKeeper web edition's Light List data files from USCG NAVCEN.

Downloads every published part file of the nine Coast Guard districts (8 in parallel,
gzip), parses the GeoJSON exactly like the desktop app's sync.py, and writes:

  lightkeeper/data/aids-D<id>.json        one compact table per district (fields + rows)
  lightkeeper/data/districts.json         the district table with record counts
  lightkeeper/data/stations-tide.json     NOAA CO-OPS tide-prediction stations (id, name, lat, lng, type, state)
  lightkeeper/data/stations-current.json  NOAA CO-OPS current-prediction stations (+ currbin)
  lightkeeper/data/manifest.json          built_at, per-district counts and file sizes

Standard library only (Python 3.11+). Run from anywhere:

  python tools/build_aids.py            # write into <repo>/lightkeeper/data
  python tools/build_aids.py --out DIR  # write elsewhere

Exit code is 0 when every district downloaded cleanly, 1 when one or more files failed
(the files that did download are still written, so a partial run never erases data).
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

NAVCEN_BASE_URL = "https://www.navcen.uscg.gov/sites/default/files/msi/"
NAVCEN_PARTS = {1: 10, 5: 9, 7: 15, 8: 10, 9: 5, 11: 2, 13: 3, 14: 1, 17: 2}  # part files per district
USER_AGENT = "LightKeeper/2.0.0 (web data build)"
NOAA_MDAPI_STATIONS_URL = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json"
NOAA_STATION_LISTS = {"tide": "tidepredictions", "current": "currentpredictions"}
STATION_FIELDS = ("id", "name", "lat", "lng", "type", "state", "currbin")
WORKERS = 8
TIMEOUT = 60
RETRIES = 2
AID_MAX_HEIGHT_FT = 1000
AID_MAX_RANGE_NM = 100
COORD_ROUND_AID = 7
COORD_ROUND_DEDUP = 3

# USCG districts (official map & Light List volumes); bounds are [w, s, e, n].
DISTRICTS: list[dict[str, Any]] = [
    {"id": 1, "name": "Northeast", "area": "Atlantic", "volume": "I", "color": "#4a6fa5",
     "desc": "New England & Mid-Atlantic (ME to NJ)", "bounds": [[-74.5, 40.0, -66.5, 47.5]]},
    {"id": 5, "name": "East", "area": "Atlantic", "volume": "II", "color": "#5a7fb5",
     "desc": "Mid-Atlantic & Southeast Coast (NJ to SC)", "bounds": [[-81.0, 32.0, -73.5, 40.8]]},
    {"id": 7, "name": "Southeast", "area": "Atlantic", "volume": "III", "color": "#3a5f95",
     "desc": "Southeast Coast & Caribbean (SC to FL, PR, USVI)", "bounds": [[-85.0, 24.0, -64.0, 34.0]]},
    {"id": 9, "name": "Great Lakes", "area": "Atlantic", "volume": "VII", "color": "#6a8fc5",
     "desc": "All five Great Lakes & St. Lawrence River", "bounds": [[-92.5, 41.0, -76.0, 49.5]]},
    {"id": 8, "name": "Heartland", "area": "Heartland", "volume": "IV/V", "color": "#2980b9",
     "desc": "Gulf Coast & Western Rivers (FL to TX, Mississippi System)", "bounds": [[-106.0, 25.0, -82.0, 49.0]]},
    {"id": 13, "name": "Northwest", "area": "Pacific", "volume": "VI", "color": "#c0392b",
     "desc": "Pacific Northwest (WA, OR, ID, MT)", "bounds": [[-130.0, 42.0, -104.0, 49.5]]},
    {"id": 11, "name": "Southwest", "area": "Pacific", "volume": "VI", "color": "#d44637",
     "desc": "California & Pacific Southwest (CA, NV, AZ, UT)", "bounds": [[-126.0, 32.0, -104.0, 42.0]]},
    {"id": 17, "name": "Arctic", "area": "Pacific", "volume": "VI", "color": "#8e3b2e",
     "desc": "Alaska & Arctic Region", "bounds": [[-180.0, 51.0, -130.0, 72.0]]},
    {"id": 14, "name": "Oceania", "area": "Pacific", "volume": "VI", "color": "#a04030",
     "desc": "Hawaii, Guam, Pacific Islands, American Samoa",
     "bounds": [[-180.0, 13.0, -154.0, 28.5], [140.0, 13.0, 180.0, 20.0]]},
]

# Column order of the compact per-district table. The browser adapter expands rows into
# objects keyed by these names; the first nine are the desktop's slim record, the rest feed
# the detail card.
FIELDS: tuple[str, ...] = (
    "objectid", "lightlistnumber", "aidname", "latitude", "longitude", "aid_type",
    "characteristics", "waterway", "district_id",
    "structure", "aidheight", "aidrange", "remark", "state", "color", "focal_plane",
    "sound_signal", "daymark_shape", "structure_remark", "cg_sector", "intl_llnr",
)

_WATERWAY_ABBREVS = tuple(
    (re.compile(rf"(?<![A-Za-z]){abbr}\.?(?=\s|$)", re.IGNORECASE), expansion)
    for abbr, expansion in (
        (r"I\.?C\.?W", "Intracoastal Waterway"), ("HBR", "Harbor"), ("CR", "Creek"), ("CK", "Creek"),
        ("CH", "Channel"), ("BR", "Branch"), ("SL", "Slough"), ("PT", "Point"), ("IS", "Island"),
        ("SD", "Sound"), ("R", "River"), ("L", "Lake"),
    )
)
_MULTI_SPACE = re.compile(r"\s{2,}")


# ── Parsing (ported from the desktop sync.py / db.py) ─────────────────────────

def classify_aid_type(name: str, aid_type_field: str, structure: str) -> str:
    """Bucket an aid into light / buoy / daybeacon / bridge / other from its text fields."""
    combined = f"{name or ''} {aid_type_field or ''} {structure or ''}".lower()
    if "bridge" in combined:
        return "bridge"
    if any(t in combined for t in ("daybeacon", "dayboard", "daymark")):
        return "daybeacon"
    if any(t in combined for t in ("buoy", " nun", " can ", "nun.", "can.", "ball", "spar")):
        return "buoy"
    if any(t in combined for t in ("light", "lighted", "beacon", "range front", "range rear")):
        return "light"
    return "other"


def normalize_waterway_name(name: str) -> str:
    """Expand abbreviations ("MISSOURI R" -> "Missouri River"), title-case, tidy spaces."""
    text = name.strip().rstrip(".")
    for pattern, expansion in _WATERWAY_ABBREVS:
        text = pattern.sub(expansion, text)
    return _MULTI_SPACE.sub(" ", text).strip().title()


def make_objectid(*parts: Any) -> int:
    """Deterministic 32-bit id from the given parts (same formula as the desktop app)."""
    digest = hashlib.md5("|".join(str(p) for p in parts).encode("utf-8"), usedforsecurity=False)
    return int(digest.hexdigest()[:8], 16)


_LLNR_NOISE = re.compile(r"\d+\.\d{6,}")

def clean_llnr(value: Any) -> str:
    """Light List number as text without float noise: "13672.300000000001" -> "13672.3"."""
    s = str(value or "").strip()
    if _LLNR_NOISE.fullmatch(s):
        s = f"{float(s):.4f}".rstrip("0").rstrip(".")
    return s


def _height_ft(props: dict[str, Any]) -> str:
    """Structure height in feet. NAVCEN names it STRUCTURE_HEIGHT (+ _UNIT); older files used HEIGHT_FEET."""
    raw = _prop(props, "STRUCTURE_HEIGHT", "HEIGHT_FEET", "AIDHEIGHT")
    if raw and _prop(props, "STRUCTURE_HEIGHT_UNIT").upper() in ("M", "METERS", "METRES"):
        try:
            return str(round(float(raw) * 3.28084, 1))
        except ValueError:
            return ""
    return raw


def _prop(props: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = props.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _valid(lat: float, lon: float) -> bool:
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def _coord_pair(lon: Any, lat: Any) -> tuple[float, float] | None:
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not _valid(lat_f, lon_f) or (lat_f == 0 and lon_f == 0):
        return None
    return lat_f, lon_f


def _sane_number(raw: Any, maximum: float) -> float | None:
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value < 0 or value > maximum:
        return None
    return value


def _feature_position(feature: dict[str, Any], props: dict[str, Any]) -> tuple[float, float] | None:
    coords = (feature.get("geometry") or {}).get("coordinates") or []
    position = _coord_pair(coords[0], coords[1]) if len(coords) >= 2 else None
    from_props = _coord_pair(_prop(props, "DECIMAL_LONGITUDE", "LONGITUDE"),
                             _prop(props, "DECIMAL_LATITUDE", "LATITUDE"))
    return from_props or position


def process_geojson_features(features: list[dict[str, Any]], district_id: int) -> list[dict[str, Any]]:
    """NAVCEN GeoJSON features → aid rows; drops bad coordinates, unnamed aids and exact duplicates."""
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, float, float]] = set()
    for feature in features:
        props = feature.get("properties") or {}
        position = _feature_position(feature, props)
        if position is None:
            continue
        lat, lon = position
        name = _prop(props, "NAME", "AID_NAME")
        if not name:
            continue
        dedup_key = (name, round(lat, COORD_ROUND_DEDUP), round(lon, COORD_ROUND_DEDUP))
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        structure = _prop(props, "STRUCTURE_TYPE", "STRUCTURE")
        focal_raw = _prop(props, "LIGHT_FOCAL_PLANE")
        focal_unit = _prop(props, "LIGHT_FOCAL_PLANE_UNIT") or "ft"
        sound = _prop(props, "SOUND_EMITTER_TYPE")
        rows.append({
            "objectid": make_objectid(name, round(lat, COORD_ROUND_DEDUP), round(lon, COORD_ROUND_DEDUP), district_id),
            "lightlistnumber": clean_llnr(_prop(props, "LIGHT_LIST_NUMBER", "LL_NUMBER")),
            "aidname": name,
            "latitude": round(lat, COORD_ROUND_AID),
            "longitude": round(lon, COORD_ROUND_AID),
            "aid_type": classify_aid_type(name, _prop(props, "AID_TYPE"), structure),
            "characteristics": _prop(props, "LIGHT_CHAR", "CHARACTERISTICS"),
            "waterway": normalize_waterway_name(_prop(props, "HWATERWAY_NAME", "WATERWAY")),
            "district_id": district_id,
            "structure": structure,
            "aidheight": _sane_number(_height_ft(props), AID_MAX_HEIGHT_FT),
            "aidrange": _sane_number(_prop(props, "LIGHT_NOM_RANGE", "NOMINAL_RANGE", "AIDRANGE"), AID_MAX_RANGE_NM),
            "remark": _prop(props, "REMARK", "REMARKS"),
            "state": _prop(props, "STATE"),
            "color": _prop(props, "COLOR"),
            "focal_plane": f"{focal_raw} {focal_unit}" if focal_raw else "",
            "sound_signal": "" if sound.upper() in ("N/A", "NONE") else sound,
            "daymark_shape": _prop(props, "DAYMARK_SHAPE"),
            "structure_remark": _prop(props, "STRUCTURE_REMARK"),
            "cg_sector": _prop(props, "GROUP_JURISDICTION"),
            "intl_llnr": _prop(props, "INTERNATIONAL_LLNR"),
        })
    return rows


def merge_district_rows(parts: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """Combine a district's part files: last (name, LL#) wins, objectids made unique."""
    by_identity: dict[tuple[str, str], dict[str, Any]] = {}
    for rows in parts:
        for row in rows:
            by_identity[(row["aidname"], row["lightlistnumber"])] = row
    merged = sorted(by_identity.values(), key=lambda r: (r["aidname"], r["lightlistnumber"]))
    taken: set[int] = set()
    for row in merged:
        while row["objectid"] in taken:
            row["objectid"] = make_objectid(row["aidname"], row["lightlistnumber"], row["latitude"],
                                            row["longitude"], row["district_id"], row["objectid"])
        taken.add(row["objectid"])
    return merged


# ── Download ──────────────────────────────────────────────────────────────────

def fetch(url: str) -> bytes | None:
    """Download one NAVCEN file (gzip accepted); None when NAVCEN has not published it (404)."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/geo+json, application/json",
               "Accept-Encoding": "gzip"}
    last_error: Exception | None = None
    for attempt in range(RETRIES + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=TIMEOUT) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding", "") == "gzip":
                    raw = gzip.decompress(raw)
                return raw
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            last_error = exc
        except (urllib.error.URLError, OSError, EOFError) as exc:
            last_error = exc
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url.rsplit('/', 1)[-1]}: {last_error}")


def download_part(district_id: int, part: int) -> tuple[int, int, list[dict[str, Any]] | None]:
    url = f"{NAVCEN_BASE_URL}lightListD{district_id:02d}_{part}.geojson"
    raw = fetch(url)
    if raw is None:
        return district_id, part, None
    features = json.loads(raw).get("features") or []
    return district_id, part, process_geojson_features(features, district_id)


def fetch_noaa_stations(kind: str) -> list[dict[str, Any]] | None:
    """Slim NOAA CO-OPS station list of one kind (tide | current); None when NOAA is unreachable."""
    url = f"{NOAA_MDAPI_STATIONS_URL}?type={NOAA_STATION_LISTS[kind]}&units=english"
    try:
        raw = fetch(url)
    except RuntimeError as exc:
        print(f"  NOAA {kind} stations: FAILED ({exc})", flush=True)
        return None
    if raw is None:
        return None
    stations = []
    for st in json.loads(raw).get("stations", []):
        try:
            lat, lng = float(st.get("lat")), float(st.get("lng"))
        except (TypeError, ValueError):
            continue
        if not _valid(lat, lng) or not str(st.get("id", "")).strip():
            continue
        row = {"id": str(st["id"]).strip(), "name": (st.get("name") or "").strip(), "lat": round(lat, 5),
               "lng": round(lng, 5), "type": st.get("type") or "", "state": st.get("state") or ""}
        if kind == "current" and st.get("currbin") is not None:
            row["currbin"] = st["currbin"]
        stations.append(row)
    stations.sort(key=lambda r: r["id"])
    print(f"  NOAA {kind} stations: {len(stations):,}", flush=True)
    return stations


# ── Output ────────────────────────────────────────────────────────────────────

def compact_table(district_id: int, rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {"district_id": district_id, "fields": list(FIELDS), "count": len(rows),
            "rows": [[row[f] for f in FIELDS] for row in rows]}


def write_json(path: Path, payload: Any) -> bool:
    """Write compact JSON; returns True when the file content changed."""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    data = text.encode("utf-8")
    if path.exists() and hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(data).digest():
        return False
    path.write_bytes(data)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    default_out = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
    parser.add_argument("--out", type=Path, default=default_out, help="output directory")
    parser.add_argument("--districts", default="", help="comma-separated district ids (default: all)")
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    wanted = [int(x) for x in args.districts.split(",") if x.strip()] or sorted(NAVCEN_PARTS)

    jobs = [(did, part) for did in wanted for part in range(1, NAVCEN_PARTS[did] + 1)]
    parts: dict[int, dict[int, list[dict[str, Any]]]] = {did: {} for did in wanted}
    failed: dict[int, list[str]] = {did: [] for did in wanted}
    started = time.time()
    print(f"Downloading {len(jobs)} Light List files for {len(wanted)} district(s)…", flush=True)
    with ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="navcen") as pool:
        futures = {pool.submit(download_part, did, part): (did, part) for did, part in jobs}
        for fut in as_completed(futures):
            did, part = futures[fut]
            try:
                _did, _part, rows = fut.result()
            except Exception as exc:  # noqa: BLE001 - keep going, report at the end
                failed[did].append(str(exc))
                print(f"  D{did:02d} part {part}: FAILED ({exc})", flush=True)
                continue
            if rows is None:
                print(f"  D{did:02d} part {part}: not published", flush=True)
                continue
            parts[did][part] = rows
            print(f"  D{did:02d} part {part}: {len(rows):,} aids", flush=True)

    print("Downloading NOAA CO-OPS station lists…", flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        station_lists = dict(zip(NOAA_STATION_LISTS, pool.map(fetch_noaa_stations, NOAA_STATION_LISTS)))

    manifest_path = out / "manifest.json"
    previous = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {}
    counts: dict[str, int] = dict(previous.get("counts", {}))
    sizes: dict[str, int] = dict(previous.get("sizes", {}))
    changed = False
    for did in wanted:
        if failed[did] or not parts[did]:
            print(f"D{did:02d}: incomplete, keeping the previous file", flush=True)
            continue
        rows = merge_district_rows([parts[did][p] for p in sorted(parts[did])])
        path = out / f"aids-D{did}.json"
        changed |= write_json(path, compact_table(did, rows))
        counts[str(did)] = len(rows)
        sizes[str(did)] = path.stat().st_size
        print(f"D{did:02d}: {len(rows):,} aids → {path.name} ({path.stat().st_size / 1e6:.1f} MB)", flush=True)

    stations: dict[str, int] = dict(previous.get("stations", {}))
    for kind, rows in station_lists.items():
        if rows is None:
            print(f"NOAA {kind} stations: keeping the previous file", flush=True)
            continue
        path = out / f"stations-{kind}.json"
        changed |= write_json(path, {"kind": kind, "source": "NOAA CO-OPS", "count": len(rows), "stations": rows})
        stations[kind] = len(rows)
        print(f"NOAA {kind}: {len(rows):,} stations → {path.name} ({path.stat().st_size / 1e6:.1f} MB)", flush=True)

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    built_at = now if changed or not previous.get("built_at") else previous["built_at"]
    districts = [{**d, "enabled": True, "last_sync": built_at, "record_count": counts.get(str(d["id"]), 0)}
                 for d in DISTRICTS]
    write_json(out / "districts.json", districts)
    write_json(manifest_path, {
        "built_at": built_at, "checked_at": now, "source": NAVCEN_BASE_URL, "version": "2.0.0",
        "fields": list(FIELDS), "counts": counts, "sizes": sizes, "total": sum(counts.values()),
        "stations": stations, "places": previous.get("places", {}), "places_checked_at": previous.get("places_checked_at", ""),
    })
    errors = sum(len(v) for v in failed.values()) + sum(1 for v in station_lists.values() if v is None)
    print(f"Done in {time.time() - started:.0f}s: {sum(counts.values()):,} aids, {errors} failed file(s), "
          f"{'data changed' if changed else 'no changes'}", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
