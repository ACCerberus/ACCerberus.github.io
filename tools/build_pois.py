#!/usr/bin/env python3
"""Build the pre-crawled places dataset for LightKeeper from OpenStreetMap (Overpass).

For every Coast Guard district in lightkeeper/data/districts.json the script walks a 0.75° grid over
the district bounds, skips cells that contain no Light List aid, and runs ONE Overpass query per cell
(the desktop app's fast ramp, lodging and park selectors, `nwr<sel>(around:60000,lat,lon)`, `out center`).
Requests go out one at a time with a pause between them, alternating mirrors, with retries and backoff
on 429 / 504 / timeouts. Records are built with the same naming / address / phone / no-hostel / dedup
rules as the app (poi.py) and written as a JSON list to:

  lightkeeper/data/DISTRICT_<id>_<Name>_Places.json   e.g. DISTRICT_13_Northwest_Places.json
                                       (loaded by the web app and by the desktop app; the manifest lists each file)

A district whose crawl fails keeps its previous file. Standard library only (Python 3.11+).

  python tools/build_pois.py                 # all districts
  python tools/build_pois.py --districts 13  # one district
  python tools/build_pois.py --pause 3 --cell 1.0
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
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

USER_AGENT = "LightKeeper/2.0.0 (places data build; github.com/ACCerberus/ACCerberus.github.io)"
try:  # optional: a current CA bundle when the OS store is stale (the desktop app does the same)
    import certifi
    import ssl
    urllib.request.install_opener(urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=certifi.where()))))
except ImportError:
    pass
MIRRORS = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.openstreetmap.fr/api/interpreter")
CELL_DEG = 0.75
RADIUS_M = 60000
PAUSE_S = 5.0
RETRIES = 3
QUERY_TIMEOUT_S = 90
SOURCE_OSM = "OpenStreetMap"
EARTH_RADIUS_NM = 3440.065
NM_TO_MI = 1.15078
PARK_RAMP_LINK_MI = 1.5
DEDUP_DISTANCE_MI = 0.06
POI_MIN_NAME_LEN = 3
NAME_COORD_DECIMALS = 3
QUALITY_VERIFIED_MIN = 7
QUALITY_LIKELY_MIN = 4
RESORT_MIN_STARS = 4
PER_CELL_CAP = {"ramp": 400, "marina": 400, "lodging": 500, "park": 600}
FILE_SIZE_LIMIT = 10 * 1024 * 1024
DROP_WHEN_LARGE = ("website", "operator")
_DASH = " – "

LODGING_KINDS = ("hotel", "motel", "resort", "campground")
RAMP_KINDS = ("ramp", "marina")
QUALITY_RANK = {"verified": 0, "likely": 1, "unverified": 2}
KIND_LABEL = {"ramp": "Boat Ramp", "marina": "Marina", "hotel": "Hotel", "motel": "Motel", "resort": "Resort",
              "campground": "Campground", "park": "Park", "place": "Place"}
NAME_TAGS = ("name", "official_name", "alt_name", "loc_name", "seamark:name", "ref")
TOURISM_TO_KIND = {"hotel": "hotel", "motel": "motel", "resort": "resort", "camp_site": "campground",
                   "caravan_site": "campground", "guest_house": "hotel", "bed_and_breakfast": "hotel", "inn": "hotel",
                   "apartment": "hotel", "chalet": "resort", "cabin": "resort"}
EXTRA_TAGS = {
    "ramp": ("surface", "fee", "access", "opening_hours", "capacity", "parking", "tidal", "description"),
    "marina": ("surface", "fee", "access", "opening_hours", "capacity", "fuel:diesel", "fuel:gasoline",
               "seamark:small_craft_facility:category", "description"),
    "hotel": ("stars", "brand", "rooms", "opening_hours", "internet_access", "description"),
    "motel": ("stars", "brand", "rooms", "opening_hours", "internet_access", "description"),
    "resort": ("stars", "brand", "rooms", "opening_hours", "internet_access", "description"),
    "campground": ("fee", "opening_hours", "capacity", "tents", "caravans", "brand", "description"),
    "park": ("opening_hours", "fee", "access", "description"),
}
MOTEL_WORDS = ("motel", "motor inn", "motor lodge", "motor court", "super 8", "motel 6", "red roof", "econolodge",
               "econo lodge", "travelodge", "days inn")
RESORT_WORDS = ("resort", "spa ", " spa", "lodge", "chalet", "villa", "retreat", "plantation", "ranch")
CAMPGROUND_WORDS = ("campground", "rv park", "rv resort", "camp site", "campsite")
HOTEL_CHAINS = ("holiday inn", "best western", "comfort inn", "comfort suites", "hampton inn", "hilton", "marriott",
                "courtyard", "fairfield", "residence inn", "springhill", "hyatt", "sheraton", "westin", "doubletree",
                "embassy suites", "la quinta", "quality inn", "days inn", "super 8", "motel 6", "red roof", "sleep inn",
                "clarion", "econolodge", "econo lodge", "ramada", "wyndham", "travelodge", "microtel", "candlewood",
                "staybridge", "homewood suites", "towneplace", "country inn", "drury", "four points", "aloft",
                "element", "ac hotel")
PUBLIC_OPERATOR_WORDS = ("usace", "corps of engineers", "army corps", "state", "county", "city of", "department",
                         "parks", "wildlife", "fish and", "port of", "port authority", "dnr", "forest service",
                         "bureau of", "national park")
CLOSED_NAME_WORDS = ("closed", "demolished", "decommissioned", "under construction", "coming soon",
                     "permanently closed", "out of business", "shut down")
LIFECYCLE_PREFIXES = ("disused:", "abandoned:", "demolished:", "razed:", "was:")
PRIVATE_ACCESS = ("private", "no")
GENERIC_NAME_WORDS = frozenset(("public", "ramps", "launches", "boating", "site", "area", "facility", "a", "boat", "ramp", "launch", "launching", "slipway", "marina", "dock", "landing",
                                "access", "hotel", "motel", "inn", "suites", "resort", "lodge", "campground", "camp",
                                "park", "rv", "the", "and", "of", "at", "by", "on"))
_NAME_NORMALIZE_RE = re.compile(r"[^a-z0-9 ]+")

# The desktop app's FAST selectors (poi.py) — one combined query per cell.
RAMP_SELECTORS_FAST = (
    '["leisure"="slipway"]', '["amenity"="boat_ramp"]', '["leisure"="marina"]', '["waterway"="slipway"]',
    '["waterway"="boat_ramp"]', '["sport"="boat_launching"]', '["highway"="service"]["boat"="yes"]',
)
LODGING_SELECTORS_FAST = ('["tourism"~"^(hotel|motel|resort)$"]', '["building"~"^(hotel|motel)$"]')
PARK_SELECTORS = (
    '["leisure"="park"]["name"]', '["tourism"="camp_site"]["name"]', '["tourism"="caravan_site"]["name"]',
    '["boundary"="national_park"]["name"]', '["leisure"="nature_reserve"]["name"]',
    '["boundary"="protected_area"]["protection_title"~"[Pp]ark|[Rr]ecreation"]["name"]',
)


# ── Geometry / small helpers ──────────────────────────────────────────────────

def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS_NM * 2 * math.asin(min(1.0, math.sqrt(a))) * NM_TO_MI


def valid_coords(lat: float, lon: float) -> bool:
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def is_in_us(lat: float, lon: float) -> bool:
    boxes = ((24.0, 49.0, -125.5, -66.5), (51.0, 72.0, -180.0, -130.0), (18.5, 22.5, -160.5, -154.5),
             (17.5, 18.7, -67.5, -65.5), (13.0, 14.0, 144.0, 145.5))
    return any(s <= lat <= n and w <= lon <= e for s, n, w, e in boxes)


def normalize_phone(raw: str) -> str:
    digits = "".join(ch for ch in (raw or "") if ch.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return f"+1 {digits[:3]}-{digits[3:6]}-{digits[6:]}" if len(digits) == 10 else ""


def _first(tags: dict, *keys: str) -> str:
    for key in keys:
        value = tags.get(key)
        if value:
            return str(value).strip()
    return ""


def _clean_name(raw: Any) -> str:
    name = str(raw or "").strip()
    if len(name) < POI_MIN_NAME_LEN or name.isdigit():
        return ""
    return name if _name_tokens(name) else ""   # "Boat Ramp" alone is not a name; build one instead


def _coord_name(label: str, lat: float, lon: float) -> str:
    return f"{label} ({lat:.{NAME_COORD_DECIMALS}f}, {lon:.{NAME_COORD_DECIMALS}f})"


def _format_address(house: Any, road: Any, town: Any, state: Any, postcode: Any) -> str:
    street = " ".join(p for p in (house, road) if p).strip()
    region = " ".join(p for p in (state, postcode) if p).strip()
    return ", ".join(p for p in (street, town, region) if p)


def _name_tokens(name: str) -> frozenset[str]:
    return frozenset(_NAME_NORMALIZE_RE.sub("", name.lower()).split()) - GENERIC_NAME_WORDS


def _nearest(records: list[dict], lat: float, lon: float, max_mi: float) -> dict | None:
    best, best_d = None, max_mi
    for rec in records:
        d = haversine_miles(lat, lon, rec["lat"], rec["lon"])
        if d < best_d:
            best, best_d = rec, d
    return best


def _rank_key(rec: dict):
    return (QUALITY_RANK.get(rec.get("quality"), 3), 0 if rec.get("name_source") == "osm" else 1, rec["name"])


# ── OSM tag interpretation (poi.py rules) ─────────────────────────────────────

def osm_name(tags: dict) -> str:
    for key in NAME_TAGS:
        name = _clean_name(tags.get(key))
        if name:
            return name
    return ""


def osm_address(tags: dict) -> str:
    return _format_address(tags.get("addr:housenumber"), tags.get("addr:street"), tags.get("addr:city"),
                           tags.get("addr:state"), tags.get("addr:postcode"))


def clean_phone(raw: Any) -> str:
    first = str(raw or "").split(";")[0].strip()
    return normalize_phone(first) or first


def is_closed(tags: dict, name: str) -> bool:
    if any(key.startswith(LIFECYCLE_PREFIXES) for key in tags):
        return True
    if tags.get("opening_hours", "").strip().lower() in ("closed", "off"):
        return True
    return any(word in name.lower() for word in CLOSED_NAME_WORDS)


def is_hostel(name: str, tags: dict) -> bool:
    return tags.get("tourism") == "hostel" or "hostel" in name.lower()


def lodging_kind(name: str, tags: dict) -> str:
    lower = name.lower()
    tourism = tags.get("tourism", "")
    if tourism in ("camp_site", "caravan_site") or any(w in lower for w in CAMPGROUND_WORDS):
        return "campground"
    try:
        stars = float(tags.get("stars") or 0)
    except (TypeError, ValueError):
        stars = 0
    if tourism == "resort" or stars >= RESORT_MIN_STARS or any(w in lower for w in RESORT_WORDS):
        return "resort"
    if tourism == "motel" or tags.get("building") == "motel" or any(w in lower for w in MOTEL_WORDS):
        return "motel"
    return TOURISM_TO_KIND.get(tourism, "hotel")


def _is_public_operator(operator: str) -> bool:
    return any(word in operator.lower() for word in PUBLIC_OPERATOR_WORDS)


def quality_score(kind: str, tags: dict) -> str:
    name = tags.get("name", "")
    phone = bool(tags.get("phone") or tags.get("contact:phone"))
    website = bool(tags.get("website") or tags.get("contact:website"))
    has_addr = bool(tags.get("addr:full") or (tags.get("addr:street") and tags.get("addr:city")))
    operator = tags.get("operator", "")
    score = 1 if name else 0
    if kind in LODGING_KINDS:
        chain = any(c in name.lower() for c in HOTEL_CHAINS)
        score += 2 * phone + 2 * has_addr + 2 * website + 2 * chain
        score += bool(operator or tags.get("brand")) + bool(tags.get("rooms") or tags.get("stars"))
        score += bool(tags.get("opening_hours"))
        if not (phone or website or chain):
            score = max(0, score - 2)
    elif kind in RAMP_KINDS:
        surface = tags.get("surface", "").lower()
        score += 2 * bool(operator) + 2 * _is_public_operator(operator)
        score += 2 if surface in ("concrete", "paved", "asphalt") else surface in ("gravel", "compacted")
        score += bool(tags.get("fee")) + (tags.get("access", "").lower() in ("public", "yes"))
        score += bool(tags.get("opening_hours")) + bool(tags.get("capacity") or tags.get("parking"))
        score += phone + website
        if kind == "marina":
            score += 1 + bool(tags.get("fuel:diesel") or tags.get("fuel:gasoline"))
    else:
        score += 2 * bool(operator) + 2 * _is_public_operator(operator) + 2 * has_addr
        score += phone + website + bool(tags.get("opening_hours"))
    if score >= QUALITY_VERIFIED_MIN:
        return "verified"
    return "likely" if score >= QUALITY_LIKELY_MIN else "unverified"


# ── Records ───────────────────────────────────────────────────────────────────

def _element_point(el: dict) -> tuple[float, float] | None:
    center = el if el.get("lat") is not None else (el.get("center") or {})
    try:
        lat, lon = float(center.get("lat")), float(center.get("lon"))
    except (TypeError, ValueError):
        return None
    return (lat, lon) if valid_coords(lat, lon) and is_in_us(lat, lon) else None


def _derived_name(label: str, tags: dict, lat: float, lon: float, parks: list[dict]) -> str:
    operator = tags.get("operator", "").strip()
    if operator:
        return f"{operator} {label}"
    park = _nearest(parks, lat, lon, PARK_RAMP_LINK_MI)
    if park:
        return f"{park['name']} {label}"
    street, city = tags.get("addr:street", "").strip(), tags.get("addr:city", "").strip()
    if street and city:
        return f"{label}{_DASH}{street}, {city}"
    return _coord_name(label, lat, lon)


def _record(el: dict, kind: str, parks: list[dict]) -> dict | None:
    tags = el.get("tags") or {}
    pt = _element_point(el)
    if not pt:
        return None
    lat, lon = pt
    name = osm_name(tags)
    name_source = "osm" if name else "derived"
    if not name:
        name = _derived_name(KIND_LABEL.get(kind, "Place"), tags, lat, lon, parks)
    return {
        "id": f"osm:{el.get('type')}:{el.get('id')}", "kind": kind, "name": name, "name_source": name_source,
        "lat": round(lat, 6), "lon": round(lon, 6), "address": osm_address(tags),
        "phone": clean_phone(_first(tags, "phone", "contact:phone", "contact:mobile")),
        "website": _first(tags, "website", "contact:website", "url"), "operator": tags.get("operator", ""),
        "tags": {k: str(tags[k]) for k in EXTRA_TAGS.get(kind, ()) if tags.get(k)},
        "quality": quality_score(kind, tags), "source": SOURCE_OSM,
    }


def _is_ramp_element(tags: dict) -> bool:
    return (tags.get("leisure") in ("slipway", "marina") or tags.get("amenity") == "boat_ramp"
            or tags.get("waterway") in ("slipway", "boat_ramp") or tags.get("sport") == "boat_launching"
            or (tags.get("highway") == "service" and tags.get("boat") == "yes"))


def _is_lodging_element(tags: dict) -> bool:
    return tags.get("tourism") in ("hotel", "motel", "resort") or tags.get("building") in ("hotel", "motel")


def _is_park_element(tags: dict) -> bool:
    return bool(tags.get("name")) and (
        tags.get("leisure") in ("park", "nature_reserve") or tags.get("tourism") in ("camp_site", "caravan_site")
        or tags.get("boundary") == "national_park"
        or (tags.get("boundary") == "protected_area" and re.search(r"[Pp]ark|[Rr]ecreation", tags.get("protection_title", ""))))


def ramp_record(el: dict, parks: list[dict]) -> dict | None:
    tags = el.get("tags") or {}
    kind = "marina" if tags.get("leisure") == "marina" else "ramp"
    name = osm_name(tags)
    if is_closed(tags, name):
        return None
    if kind == "ramp" and (tags.get("access", "").lower() in PRIVATE_ACCESS or "private" in name.lower()):
        return None
    return _record(el, kind, parks)


def lodging_record(el: dict) -> dict | None:
    tags = el.get("tags") or {}
    name = osm_name(tags)
    if is_hostel(name, tags) or is_closed(tags, name):
        return None
    return _record(el, lodging_kind(name, tags), [])


def park_record(el: dict) -> dict | None:
    tags = el.get("tags") or {}
    if is_closed(tags, osm_name(tags)):
        return None
    rec = _record(el, "park", [])
    if rec:
        rec["tags"]["type"] = "campground" if tags.get("tourism") in ("camp_site", "caravan_site") else \
            _first(tags, "boundary", "leisure") or "park"
    return rec


# ── Dedup / linking (poi.py rules) ────────────────────────────────────────────

def _names_match(a: str, b: str) -> bool:
    ta, tb = _name_tokens(a), _name_tokens(b)
    return bool(ta and tb) and (ta <= tb or tb <= ta)


def _same_place(a: dict, b: dict) -> bool:
    if a["id"] == b["id"]:
        return True
    if haversine_miles(a["lat"], a["lon"], b["lat"], b["lon"]) >= DEDUP_DISTANCE_MI:
        return False
    if a["name_source"] != "osm" or b["name_source"] != "osm":
        return True
    return _names_match(a["name"], b["name"])


def _merge_into(keep: dict, dup: dict) -> None:
    for field in ("address", "phone", "website", "operator"):
        if not keep[field] and dup.get(field):
            keep[field] = dup[field]
    for key, value in dup.get("tags", {}).items():
        keep["tags"].setdefault(key, value)


def dedup(records: list[dict]) -> list[dict]:
    """Collapse records within DEDUP_DISTANCE_MI that share a name; best quality wins. Uses a coarse grid
    so a whole district (tens of thousands of records) stays fast."""
    kept: list[dict] = []
    grid: dict[tuple[int, int], list[dict]] = {}
    for rec in sorted(records, key=_rank_key):
        cx, cy = int(rec["lat"] * 500), int(rec["lon"] * 500)   # ~0.14 mi cells
        dup = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for cand in grid.get((cx + dx, cy + dy), ()):
                    if _same_place(cand, rec):
                        dup = cand
                        break
                if dup:
                    break
            if dup:
                break
        if dup is None:
            kept.append(rec)
            grid.setdefault((cx, cy), []).append(rec)
        else:
            _merge_into(dup, rec)
    return kept


def link_parks(ramps: list[dict], parks: list[dict]) -> list[dict]:
    grid: dict[tuple[int, int], list[dict]] = {}
    for park in parks:
        grid.setdefault((int(park["lat"] * 40), int(park["lon"] * 40)), []).append(park)   # ~1.7 mi cells

    def near_parks(lat: float, lon: float) -> list[dict]:
        cx, cy = int(lat * 40), int(lon * 40)
        return [p for dx in (-1, 0, 1) for dy in (-1, 0, 1) for p in grid.get((cx + dx, cy + dy), ())]

    linked_ids: set[str] = set()
    for ramp in ramps:
        park = _nearest(near_parks(ramp["lat"], ramp["lon"]), ramp["lat"], ramp["lon"], PARK_RAMP_LINK_MI)
        if park:
            ramp["tags"]["park"] = park["name"]
            park["tags"].setdefault("ramp_name", ramp["name"])
            linked_ids.add(park["id"])
    return [p for p in parks if p["id"] in linked_ids]


# ── Overpass ──────────────────────────────────────────────────────────────────

class Overpass:
    """One request at a time, alternating mirrors, pause between calls, retries with backoff."""

    def __init__(self, pause: float, mirrors: tuple[str, ...] = MIRRORS) -> None:
        self.pause = pause
        self.mirrors = mirrors
        self.turn = 0
        self.requests = 0
        self.failures = 0

    def query(self, ql: str) -> list[dict]:
        data = urllib.parse.urlencode({"data": ql}).encode()
        last: Exception | None = None
        for attempt in range(RETRIES + 1):
            server = self.mirrors[self.turn % len(self.mirrors)]
            self.turn += 1
            req = urllib.request.Request(server, data=data, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
            try:
                self.requests += 1
                with urllib.request.urlopen(req, timeout=QUERY_TIMEOUT_S + 15) as resp:
                    raw = resp.read()
                    if resp.headers.get("Content-Encoding", "") == "gzip":
                        raw = gzip.decompress(raw)
                payload = json.loads(raw)
                if payload.get("remark", "").startswith("runtime error"):
                    raise RuntimeError(payload["remark"])
                time.sleep(self.pause)
                return payload.get("elements") or []
            except urllib.error.HTTPError as exc:
                last = exc
                wait = self.pause * (2 ** attempt) * (3 if exc.code in (429, 504) else 1)
            except Exception as exc:  # noqa: BLE001 - timeouts, resets, bad JSON: retry on another mirror
                last = exc
                wait = self.pause * (2 ** attempt)
            self.failures += 1
            print(f"    retry {attempt + 1}/{RETRIES} after {wait:.0f}s ({server.split('/')[2]}: {last})", flush=True)
            time.sleep(wait)
        raise RuntimeError(f"Overpass failed after {RETRIES + 1} attempts: {last}")


def cell_query(lat: float, lon: float, radius_m: int) -> str:
    around = f"(around:{radius_m},{lat:.4f},{lon:.4f})"
    body = "\n".join(f"  nwr{sel}{around};" for sel in RAMP_SELECTORS_FAST + LODGING_SELECTORS_FAST + PARK_SELECTORS)
    return f"[out:json][timeout:{QUERY_TIMEOUT_S}][maxsize:268435456];\n(\n{body}\n);\nout center;"


# ── Districts / cells ─────────────────────────────────────────────────────────

def load_aid_points(data_dir: Path, district_id: int) -> list[tuple[float, float]]:
    path = data_dir / f"aids-D{district_id}.json"
    if not path.exists():
        return []
    table = json.loads(path.read_text("utf-8"))
    fields = table["fields"]
    i_lat, i_lon = fields.index("latitude"), fields.index("longitude")
    return [(row[i_lat], row[i_lon]) for row in table["rows"]]


def district_cells(bounds: list[list[float]], aids: list[tuple[float, float]], cell: float) -> list[tuple[float, float]]:
    """Centers of grid cells (lat, lon) over the district bounds that contain at least one aid."""
    occupied: set[tuple[int, int]] = set()
    for lat, lon in aids:
        occupied.add((math.floor(lat / cell), math.floor(lon / cell)))
    cells: list[tuple[float, float]] = []
    seen: set[tuple[int, int]] = set()
    for west, south, east, north in bounds:
        for iy in range(math.floor(south / cell), math.ceil(north / cell)):
            for ix in range(math.floor(west / cell), math.ceil(east / cell)):
                if (iy, ix) in occupied and (iy, ix) not in seen:
                    seen.add((iy, ix))
                    cells.append(((iy + 0.5) * cell, (ix + 0.5) * cell))
    return cells


def crawl_district(district: dict, data_dir: Path, client: Overpass, cell: float, radius_m: int) -> list[dict]:
    did = district["id"]
    aids = load_aid_points(data_dir, did)
    cells = district_cells(district["bounds"], aids, cell)
    print(f"D{did:02d} {district['name']}: {len(cells)} cells with aids", flush=True)
    ramps: list[dict] = []
    lodging: list[dict] = []
    parks: list[dict] = []
    for n, (lat, lon) in enumerate(cells, 1):
        t0 = time.time()
        elements = client.query(cell_query(lat, lon, radius_m))
        cell_parks = [r for r in (park_record(e) for e in elements if _is_park_element(e.get("tags") or {})) if r]
        cell_parks = dedup(cell_parks)
        cell_ramps = [r for r in (ramp_record(e, cell_parks) for e in elements if _is_ramp_element(e.get("tags") or {})) if r]
        cell_lodging = [r for r in (lodging_record(e) for e in elements if _is_lodging_element(e.get("tags") or {})) if r]
        ramps += sorted(cell_ramps, key=_rank_key)[:PER_CELL_CAP["ramp"] + PER_CELL_CAP["marina"]]
        lodging += sorted(cell_lodging, key=_rank_key)[:PER_CELL_CAP["lodging"]]
        parks += sorted(cell_parks, key=_rank_key)[:PER_CELL_CAP["park"]]
        print(f"  cell {n}/{len(cells)} ({lat:.2f},{lon:.2f}): {len(elements)} elements → "
              f"{len(cell_ramps)} ramps, {len(cell_lodging)} lodging, {len(cell_parks)} parks ({time.time() - t0:.0f}s)", flush=True)
    ramps = dedup(ramps)
    lodging = dedup(lodging)
    parks = link_parks(ramps, dedup(parks))
    return sorted(ramps + lodging + parks, key=lambda r: (r["kind"], r["name"]))


def write_district(path: Path, records: list[dict]) -> int:
    def dump(recs: list[dict]) -> bytes:
        return json.dumps(recs, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    data = dump(records)
    if len(data) > FILE_SIZE_LIMIT:
        for rec in records:
            for field in DROP_WHEN_LARGE:
                rec.pop(field, None)
        data = dump(records)
        print(f"  {path.name}: over 10 MB, dropped {', '.join(DROP_WHEN_LARGE)}", flush=True)
    if path.exists() and hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(data).digest():
        return 0
    path.write_bytes(data)
    return len(data)


def places_filename(district: dict) -> str:
    """DISTRICT_13_Northwest_Places.json: number, name (spaces → underscores), _Places."""
    name = re.sub(r"[^A-Za-z0-9]+", "_", str(district.get("name", ""))).strip("_")
    return f"DISTRICT_{district['id']}_{name}_Places.json" if name else f"DISTRICT_{district['id']}_Places.json"


def update_manifest(data_dir: Path) -> None:
    """Record which district place files exist (the web app only requests files listed here)."""
    path = data_dir / "manifest.json"
    manifest = json.loads(path.read_text("utf-8")) if path.exists() else {}
    places: dict[str, dict[str, Any]] = {}
    for file in sorted(data_dir.glob("DISTRICT_*_Places.json")):
        did = file.stem.split("_")[1]
        try:
            count = len(json.loads(file.read_text("utf-8")))
        except (ValueError, OSError):
            continue
        places[did] = {"file": file.name, "count": count, "size": file.stat().st_size}
    manifest["places"] = places
    manifest["places_checked_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    path.write_bytes(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Crawl OpenStreetMap places per USCG district into lightkeeper/data.")
    default_data = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
    parser.add_argument("--data", type=Path, default=default_data, help="lightkeeper/data directory")
    parser.add_argument("--districts", default="", help="comma-separated district ids (default: all)")
    parser.add_argument("--cell", type=float, default=CELL_DEG, help="grid cell size in degrees")
    parser.add_argument("--radius", type=int, default=RADIUS_M, help="query radius in meters")
    parser.add_argument("--pause", type=float, default=PAUSE_S, help="seconds between Overpass requests")
    parser.add_argument("--mirrors", default="", help="comma-separated Overpass endpoints to use instead of the defaults")
    args = parser.parse_args()
    mirrors = tuple(m.strip() for m in args.mirrors.split(",") if m.strip()) or MIRRORS

    districts = json.loads((args.data / "districts.json").read_text("utf-8"))
    wanted = [int(x) for x in args.districts.split(",") if x.strip()]
    if wanted:
        districts = [d for d in districts if d["id"] in wanted]
    client = Overpass(args.pause, mirrors)
    started = time.time()
    failed: list[int] = []
    for district in districts:
        t0 = time.time()
        path = args.data / places_filename(district)
        try:
            records = crawl_district(district, args.data, client, args.cell, args.radius)
        except Exception as exc:  # noqa: BLE001 - keep the previous file for this district
            failed.append(district["id"])
            print(f"D{district['id']:02d}: crawl failed, keeping previous file ({exc})", flush=True)
            continue
        kinds = {}
        for r in records:
            kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
        written = write_district(path, records)
        print(f"D{district['id']:02d}: {len(records):,} places {kinds} → {path.name} "
              f"({path.stat().st_size / 1e6:.1f} MB, {'written' if written else 'unchanged'}) in {time.time() - t0:.0f}s", flush=True)
    update_manifest(args.data)
    print(f"Done in {(time.time() - started) / 60:.1f} min: {client.requests} requests, {client.failures} retries, "
          f"failed districts: {failed or 'none'}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
