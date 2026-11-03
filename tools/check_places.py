#!/usr/bin/env python3
"""Accuracy checks on each district's places after the OpenStreetMap / Overture / agency builds.

  python tools/check_places.py                          # all districts, every check
  python tools/check_places.py --districts 13,14
  python tools/check_places.py --no-websites --no-wikidata

Checks (each can be switched off), in this order:
  ridb      Recreation.gov (RIDB) full export: a ramp / marina / campground that matches a federal facility (within
            MATCH_MI and a similar name, or within SAME_SPOT_MI whatever the name) gets "Recreation.gov" in sources,
            quality "verified", a missing phone, and the official name instead of a made-up one. A park matches a
            federal campground / recreation site only by a near-identical name. Nothing is added.
  wikidata  Wikidata (SPARQL, one request a second at most): US marinas, hotels / motels / resorts, campgrounds, parks,
            slipways and dams with coordinates near the district. A match gets "Wikidata" in sources and a missing
            website (P856) or phone (P1329). Dams are matched against DISTRICT_<id>_<Name>_Dams.json.
  census    US Census Bureau batch geocoder (no key): street addresses are geocoded; a point more than FAR_MI from the
            pin -> tags.address_check "far" and tags.address_point "lat,lon"; within FAR_MI -> "US Census address" in
            sources. No match -> left alone.
  phones    Numbers that cannot exist (not 10 digits, area code or exchange starting 0/1, N11, 555-01xx, all one
            digit, area code not in service) are removed (tags.phone_check "invalid"); a geographic area code from a
            different state than the address -> tags.phone_check "area_code_state". The area-code table is NANPA's
            npa_report.csv, read at run time (if it can't be read only the digit rules run).
  websites  Each website is fetched (first 64 KB, 10 s timeout, 32 threads). DNS failure, 404 / 410 or a refused /
            reset connection on three tries -> tags.website_check "dead" (the link, not necessarily the place); for
            hotels / motels / resorts / marinas / campgrounds, page text saying the place has permanently closed (not
            just its dock, pool, trail...) -> "closed". 403 / 429 / 5xx, timeouts and servers that hang up (bot
            blocking, outages) are never flagged. Nothing is removed. A single GET is used rather than HEAD + GET:
            the closed-text test needs the page anyway, and many servers answer HEAD wrongly (404 / 405).
  Census, phones and websites run after ridb / wikidata so filled-in phones and websites are checked too.
Finally a place with two or more independent sources (OpenStreetMap, Overture, an agency list, Recreation.gov,
Wikidata, US Census address) becomes "verified"; other places keep their quality. The manifest is updated.
"""

from __future__ import annotations

import argparse
import csv
import http.client
import io
import json
import math
import re
import socket
import ssl
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pois as bp  # noqa: E402
import build_places_osm as bo  # noqa: E402
from crosscheck_overture import similar  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
UA = "LightKeeper data check (cerberusac.dev/lightkeeper)"
MATCH_MI = 0.25                 # same place: within this distance and a similar name ...
SAME_SPOT_MI = 0.05             # ... or this close whatever the name
NAME_MIN = 0.5
FAR_MI = 1.0                    # Census point this far from the pin -> address_check "far"
SRC_CENSUS, SRC_RIDB, SRC_WIKIDATA = "US Census address", "Recreation.gov", "Wikidata"

# Independent sources for the final quality rule; every agency list counts as one ("an agency list").
SOURCE_GROUP = {"OpenStreetMap": "osm", "Overture": "overture", SRC_RIDB: "ridb", SRC_WIKIDATA: "wikidata", SRC_CENSUS: "census"}

STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY", "puerto rico": "PR", "guam": "GU",
    "american samoa": "AS", "northern mariana islands": "MP", "virgin islands": "VI", "u.s. virgin islands": "VI",
}
ABBR = set(STATES.values())
CENSUS_STATES = ABBR - {"GU", "AS", "MP", "VI"}        # the Census address ranges stop at the states, DC and PR


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch(url: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def sources_of(p: dict) -> list[str]:
    return list(p.get("sources") or [p.get("source") or "OpenStreetMap"])


def add_source(p: dict, src: str) -> None:
    p["sources"] = sorted(set(sources_of(p)) | {src})


def tags_of(p: dict) -> dict:
    if not isinstance(p.get("tags"), dict):
        p["tags"] = {}
    return p["tags"]


# ── Matching official records to places ──────────────────────────────────────

def best_match(p: dict, grid: dict, kinds_ok, name_only: tuple = (), name_only_min: float = 0.8) -> dict | None:
    """Nearest candidate of a compatible kind within MATCH_MI with a similar name, or within SAME_SPOT_MI.
    Kinds in name_only need a name this similar (name_only_min) and never match on distance alone."""
    cy, cx = int(p["lat"] * 50), int(p["lon"] * 50)
    best, best_score = None, -1.0
    for o in (o for dy in (-1, 0, 1) for dx in (-1, 0, 1) for o in grid.get((cy + dy, cx + dx), ())):
        if not kinds_ok(p["kind"], o):
            continue
        d = bp.haversine_miles(p["lat"], p["lon"], o["lat"], o["lon"])
        if d > MATCH_MI:
            continue
        score = 0.0
        if p.get("name_source") != "derived" and o["name"]:
            score = max(similar(p["name"], n) for n in o["names"])
        if p["kind"] in name_only:
            if score < name_only_min:
                continue
        elif d <= SAME_SPOT_MI:
            score = max(score, NAME_MIN)
        if score >= NAME_MIN and score - d > best_score:
            best, best_score = o, score - d
    return best


def make_grid(rows: list[dict]) -> dict:
    grid: dict[tuple[int, int], list[dict]] = {}
    for o in rows:
        grid.setdefault((int(o["lat"] * 50), int(o["lon"] * 50)), []).append(o)   # ~1.4 mi cells
    return grid


# ── Recreation.gov (RIDB) ────────────────────────────────────────────────────

RIDB_URL = "https://ridb.recreation.gov/downloads/RIDBFullExport_V1_CSV.zip"
RIDB_RAMP = re.compile(r"\b(boat (ramp|launch|area|access|dock|landing)|boating (site|access|area)|launch(ing)? (ramp|site|area)|"
                       r"ramp|launch)\b", re.I)
RIDB_MARINA = re.compile(r"\b(marina|moorage|harbou?r)\b", re.I)
RIDB_CAMP = re.compile(r"\b(campground|camp ?site|rv park|camping|recreation site|day use)\b", re.I)
AGENCY_PREFIX = re.compile(r"(national (forest|park|recreation area|wildlife refuge|seashore|lakeshore|grassland)s?|"
                           r"recreation area|\bnra\b|\bnf\b|corps|usace|blm|ranger district|district|project)", re.I)
# RIDB kind -> our kinds. A park is matched to a federal campground / recreation site only by a near-identical name
# ("Hunters Campground", "Blackwell Island Recreation Site"): many parks sit next to an unrelated campground.
RIDB_KINDS = {"ramp": ("ramp", "marina"), "marina": ("marina", "ramp"), "campground": ("campground", "park")}


def ridb_name(raw: str) -> str:
    """'Shasta-Trinity National Forest - Bailey Cove Boat Ramp' -> 'Bailey Cove Boat Ramp'."""
    parts = [x.strip() for x in raw.split(" - ")]
    while len(parts) > 1 and AGENCY_PREFIX.search(parts[0]):
        parts.pop(0)
    return bp.tidy_name(" - ".join(parts))


def load_ridb() -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="ridb_") as tmp:
        path = Path(tmp) / "ridb.zip"
        req = urllib.request.Request(RIDB_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=300) as resp, open(path, "wb") as out:
            while chunk := resp.read(1 << 20):
                out.write(chunk)
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.lower().startswith("facilities_api"))
            text = z.read(name).decode("utf-8-sig", errors="replace")
    csv.field_size_limit(1 << 30)
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        if (r.get("Enabled") or "").lower() == "false":
            continue
        try:
            lat, lon = float(r["FacilityLatitude"]), float(r["FacilityLongitude"])
        except (TypeError, ValueError):
            continue
        if not bp.valid_coords(lat, lon) or (lat == 0 and lon == 0) or not bp.is_in_us(lat, lon):
            continue
        raw = (r.get("FacilityName") or "").strip()
        ftype = (r.get("FacilityTypeDescription") or "").strip()
        if RIDB_MARINA.search(raw):
            kind = "marina"
        elif RIDB_RAMP.search(raw):
            kind = "ramp"
        elif ftype == "Campground" or RIDB_CAMP.search(raw):
            kind = "campground"
        else:
            continue
        name = ridb_name(raw)
        out.append({"name": name, "names": {name, bp.tidy_name(raw)}, "kind": kind, "lat": lat, "lon": lon,
                    "phone": bp.normalize_phone(r.get("FacilityPhone") or "")})
    return out


def check_ridb(places: list[dict], grid: dict) -> dict:
    c = {"matched": 0, "phones": 0, "renamed": 0}
    ok = lambda kind, o: kind in RIDB_KINDS[o["kind"]]  # noqa: E731
    for p in places:
        if p["kind"] not in ("ramp", "marina", "campground", "park"):
            continue
        o = best_match(p, grid, ok, name_only=("park",))
        if o is None:
            continue
        c["matched"] += 1
        add_source(p, SRC_RIDB)
        p["quality"] = "verified"
        if not p.get("phone") and o["phone"]:
            p["phone"] = o["phone"]
            c["phones"] += 1
        if p.get("name_source") == "derived" and o["name"]:
            p["name"], p["name_source"] = o["name"], "official"
            c["renamed"] += 1
    return c


# ── Wikidata ─────────────────────────────────────────────────────────────────

WDQS = "https://query.wikidata.org/sparql"
WD_CLASSES = {          # Wikidata class (with all its subclasses) -> place kinds it can confirm
    "Q721207": ("marina", "ramp"),                      # marina
    "Q361945": ("ramp", "marina"),                      # slipway
    "Q137788954": ("ramp", "marina"),                   # boat ramp
    "Q27686": ("hotel", "motel", "resort"),             # hotel
    "Q216212": ("hotel", "motel", "resort"),            # motel
    "Q875157": ("resort", "hotel", "motel"),            # resort
    "Q27108230": ("campground",),                       # campground
    "Q22698": ("park",),                                # park (national, state, county parks...)
    "Q12323": ("dam",),                                 # dam
}
WD_TILE_DEG = 2.0
WD_PAD_DEG = 0.4                # places reach ~40 km past the aids
WD_QUERY = """SELECT ?item ?label ?cls ?coord ?web ?phone WHERE {
  SERVICE wikibase:box { ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(%(w)f %(s)f)"^^geo:wktLiteral ;
                    wikibase:cornerNorthEast "Point(%(e)f %(n)f)"^^geo:wktLiteral . }
  ?item wdt:P31 ?t .
  VALUES ?cls { %(classes)s }
  ?t wdt:P279* ?cls .
  ?item wdt:P17 wd:Q30 .
  OPTIONAL { ?item rdfs:label ?label FILTER(lang(?label) = "en") }
  OPTIONAL { ?item wdt:P856 ?web }
  OPTIONAL { ?item wdt:P1329 ?phone }
}"""


class RateLimit:
    def __init__(self, per_s: float):
        self.gap, self.next, self.lock = 1.0 / per_s, 0.0, threading.Lock()

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            delay = self.next - now
            self.next = max(now, self.next) + self.gap
        if delay > 0:
            time.sleep(delay)


_WD_LIMIT = RateLimit(1.0)
_WD_CACHE: dict[tuple, list[dict]] = {}


def _wd_box(s: float, w: float, n: float, e: float, depth: int = 0) -> list[dict]:
    q = WD_QUERY % {"s": s, "w": w, "n": n, "e": e, "classes": " ".join(f"wd:{k}" for k in WD_CLASSES)}
    for attempt in range(3):
        _WD_LIMIT.wait()
        try:
            raw = fetch(WDQS, urllib.parse.urlencode({"query": q}).encode(), timeout=75,
                        headers={"Accept": "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded"})
            return json.loads(raw)["results"]["bindings"]
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                time.sleep(int(exc.headers.get("Retry-After") or 30))
                continue
            if exc.code in (500, 502, 503, 504) and depth < 2:   # the 60 s query limit: split the box in four
                break
            if attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError, socket.timeout, ValueError):
            if depth < 2:
                break
            if attempt == 2:
                raise
        time.sleep(5)
    if depth >= 2:
        raise RuntimeError(f"Wikidata box {s},{w},{n},{e} failed")
    ms, mw = (s + n) / 2, (w + e) / 2
    return [b for box in ((s, w, ms, mw), (s, mw, ms, e), (ms, w, n, mw), (ms, mw, n, e)) for b in _wd_box(*box, depth + 1)]


def wikidata_items(cells: set[tuple[int, int]]) -> tuple[list[dict], int]:
    tiles = sorted({(math.floor(cy * bo.CELL_DEG / WD_TILE_DEG), math.floor(cx * bo.CELL_DEG / WD_TILE_DEG)) for cy, cx in cells})
    todo = [t for t in tiles if t not in _WD_CACHE]

    def run(t):
        s, w = t[0] * WD_TILE_DEG - WD_PAD_DEG, t[1] * WD_TILE_DEG - WD_PAD_DEG
        n, e = s + WD_TILE_DEG + 2 * WD_PAD_DEG, w + WD_TILE_DEG + 2 * WD_PAD_DEG
        try:                                     # the service rejects longitudes past +-180 (Aleutians)
            _WD_CACHE[t] = _wd_box(max(s, -90.0), max(w, -180.0), min(n, 90.0), min(e, 180.0))
        except Exception as exc:  # noqa: BLE001 - one tile failing doesn't stop the rest
            log(f"  Wikidata tile {t}: FAILED ({exc})")
            _WD_CACHE[t] = []

    with ThreadPoolExecutor(3) as pool:          # at most 3 in flight, started at most once a second
        list(pool.map(run, todo))
    items: dict[str, dict] = {}
    for t in tiles:
        for b in _WD_CACHE[t]:
            qid = b["item"]["value"].rsplit("/", 1)[-1]
            m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", b["coord"]["value"])
            if not m:
                continue
            it = items.setdefault(qid, {"id": qid, "name": bp.tidy_name(b.get("label", {}).get("value", "")), "kinds": set(),
                                        "lat": float(m.group(2)), "lon": float(m.group(1)), "website": "", "phone": ""})
            it["kinds"].update(WD_CLASSES.get(b["cls"]["value"].rsplit("/", 1)[-1], ()))
            if not it["website"] and b.get("web"):
                it["website"] = b["web"]["value"]
            if not it["phone"] and b.get("phone"):
                it["phone"] = bp.normalize_phone(b["phone"]["value"])
    out = []
    for it in items.values():
        if it["name"] and not re.fullmatch(r"Q\d+", it["name"]):
            it["names"] = {it["name"]}
            out.append(it)
    return out, len(tiles)


def check_wikidata(records: list[dict], grid: dict) -> dict:
    c = {"matched": 0, "websites": 0, "phones": 0}
    ok = lambda kind, o: kind in o["kinds"]  # noqa: E731
    for p in records:
        o = best_match(p, grid, ok)
        if o is None:
            continue
        c["matched"] += 1
        add_source(p, SRC_WIKIDATA)
        if not p.get("website") and o["website"]:
            p["website"] = o["website"]
            c["websites"] += 1
        if not p.get("phone") and o["phone"]:
            p["phone"] = o["phone"]
            c["phones"] += 1
    return c


# ── Addresses: US Census Bureau batch geocoder ───────────────────────────────

CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
CENSUS_BATCH = 2500             # the service takes 10,000 rows; smaller batches in parallel finish sooner
CENSUS_THREADS = 4
LAST_PART = re.compile(r"^(?:([A-Za-z][A-Za-z .]*?)\.?\s*)?(\d{5})(?:-\d{4})?$|^([A-Za-z][A-Za-z .]*?)\.?$")


def split_address(addr: str) -> dict | None:
    """'166 Canning Drive Northeast, Colville, WA 99114' -> street / city / state / zip (None when unusable)."""
    parts = [x.strip() for x in re.split(r"[,\n]", addr or "") if x.strip()]
    parts = [x for x in parts if x.upper() not in ("USA", "US", "UNITED STATES", "UNITED STATES OF AMERICA")]
    if len(parts) < 2:
        return None
    street, state, zipc, rest = parts[0], "", "", parts[1:]
    m = LAST_PART.match(rest[-1])
    if m:
        st = (m.group(1) or m.group(3) or "").strip()
        code = st.upper() if st.upper() in ABBR else STATES.get(st.lower(), "")
        if m.group(2) and (code or not st):
            state, zipc, rest = code, m.group(2), rest[:-1]
        elif code:
            state, rest = code, rest[:-1]
    if rest and not state and len(rest) >= 2:          # "..., Colville, WA, 99114"
        code = rest[-1].upper() if rest[-1].upper() in ABBR else STATES.get(rest[-1].lower(), "")
        if code:
            state, rest = code, rest[:-1]
    city = rest[-1] if rest else ""
    if not re.match(r"^\d+[A-Za-z]?(-\d+)?\s+\S", street) or not (city or zipc):
        return None                                    # the geocoder needs a house number and a city or ZIP
    return {"street": street, "city": city, "state": state, "zip": zipc}


def address_state(p: dict) -> str:
    a = split_address(p.get("address", ""))
    if a and a["state"]:
        return a["state"]
    m = re.search(r"\b([A-Z]{2})\s*(\d{5}(-\d{4})?)?\s*$", p.get("address", ""))
    return m.group(1) if m and m.group(1) in ABBR else ""


def _census_batch(rows: list[list[str]]) -> dict[str, tuple[float, float, str, str]]:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"benchmark\"\r\n\r\nPublic_AR_Current\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"addressFile\"; filename=\"addresses.csv\"\r\n"
            f"Content-Type: text/csv\r\n\r\n").encode() + buf.getvalue().encode("utf-8") + f"\r\n--{boundary}--\r\n".encode()
    for attempt in range(3):
        try:
            raw = fetch(CENSUS_URL, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=900)
            break
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise
            time.sleep(20)
    out = {}
    for r in csv.reader(io.StringIO(raw.decode("utf-8", errors="replace"))):
        if len(r) >= 6 and r[2] == "Match":
            try:
                lon, lat = (float(x) for x in r[5].split(","))
            except ValueError:
                continue
            st = r[4].split(",")[2].strip() if r[4].count(",") >= 3 else ""
            out[r[0]] = (lat, lon, r[3], st)
    return out


def geocode(places: list[dict]) -> dict[int, tuple[float, float, str, str]]:
    rows, by_key = [], {}
    for i, p in enumerate(places):
        a = split_address(p.get("address", ""))
        if not a or (a["state"] and a["state"] not in CENSUS_STATES):
            continue
        key = str(i)
        rows.append([key, a["street"], a["city"], a["state"], a["zip"]])
        by_key[key] = i
    batches = [rows[k:k + CENSUS_BATCH] for k in range(0, len(rows), CENSUS_BATCH)]
    found: dict[int, tuple] = {}

    def run(batch):
        try:
            return _census_batch(batch)
        except Exception as exc:  # noqa: BLE001
            log(f"  Census batch of {len(batch)}: FAILED ({exc})")
            return {}

    with ThreadPoolExecutor(CENSUS_THREADS) as pool:
        for res in pool.map(run, batches):
            for key, hit in res.items():
                found[by_key[key]] = hit
    return found


def check_census(places: list[dict]) -> tuple[dict, dict[int, str]]:
    for p in places:
        for k in ("address_check", "address_point"):
            tags_of(p).pop(k, None)
    hits = geocode(places)
    c = {"sent": sum(1 for p in places if split_address(p.get("address", ""))), "matched": len(hits), "confirmed": 0, "far": 0}
    states = {}
    for i, (lat, lon, mtype, st) in hits.items():
        p = places[i]
        states[i] = st
        d = bp.haversine_miles(p["lat"], p["lon"], lat, lon)
        if d <= FAR_MI:
            add_source(p, SRC_CENSUS)
            c["confirmed"] += 1
        elif mtype == "Exact":                          # a fuzzy (Non_Exact) match is not enough to call the pin wrong
            tags_of(p).update(address_check="far", address_point=f"{lat:.6f},{lon:.6f}")
            c["far"] += 1
    return c, states


# ── Phones ───────────────────────────────────────────────────────────────────

NANPA_URL = "https://reports.nanpa.com/public/npa_report.csv"


def load_npa() -> dict[str, dict] | None:
    try:
        text = fetch(NANPA_URL, timeout=60).decode("utf-8-sig", errors="replace")
    except Exception as exc:  # noqa: BLE001
        log(f"  NANPA area codes: FAILED ({exc}); state check skipped")
        return None
    lines = text.splitlines()
    start = next(i for i, ln in enumerate(lines) if ln.startswith("NPA_ID"))
    npa = {}
    for r in csv.DictReader(lines[start:]):
        code = (r.get("NPA_ID") or "").strip()
        if len(code) == 3 and code.isdigit():
            npa[code] = {"in_service": (r.get("IN_SERVICE") or "").strip().upper() == "Y",
                         "geo": (r.get("USE") or "").strip().upper() == "G",
                         "state": (r.get("LOCATION") or "").strip().upper() if (r.get("COUNTRY") or "").strip().upper() == "US" else ""}
    if sum(v["in_service"] for v in npa.values()) < 300:   # not the table we expect: don't judge numbers by it
        log(f"  NANPA area codes: only {len(npa)} rows; state check skipped")
        return None
    return npa


def phone_digits(raw: str) -> str:
    s = re.split(r"(?i)\s*(?:ext\.?|extension|x|#)\s*\d+\s*$", str(raw or "").split(";")[0].strip())[0]
    digits = re.sub(r"\D", "", s)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


def phone_problem(digits: str, npa: dict | None) -> str:
    if len(digits) != 10:
        return "length"
    a, x, line = digits[:3], digits[3:6], digits[6:]
    if a[0] in "01" or x[0] in "01":
        return "starts 0/1"
    if a[1:] == "11" or x[1:] == "11":
        return "N11"
    if x == "555" and line.startswith("01"):
        return "555-01xx"
    if len(set(digits)) == 1:                         # 222-222-2222 (000-0000 and 111-1111 fail the 0/1 rule)
        return "repeated"
    if npa is not None and not (npa.get(a) or {}).get("in_service"):
        return "area code not in service"
    return ""


def check_phones(places: list[dict], npa: dict | None, census_states: dict[int, str]) -> dict:
    c = {"phones": 0, "invalid": 0, "state": 0}
    for i, p in enumerate(places):
        tags_of(p).pop("phone_check", None)
        tags_of(p).pop("phone_removed", None)
        if not p.get("phone"):
            continue
        c["phones"] += 1
        digits = phone_digits(p["phone"])
        if phone_problem(digits, npa):
            p["tags"]["phone_check"] = "invalid"
            p["tags"]["phone_removed"] = p["phone"]
            p["phone"] = ""
            c["invalid"] += 1
            continue
        p["phone"] = f"+1 {digits[:3]}-{digits[3:6]}-{digits[6:]}"
        info = (npa or {}).get(digits[:3])
        state = address_state(p) or census_states.get(i, "")
        if info and info["geo"] and info["state"] and state and info["state"] != state:
            p["tags"]["phone_check"] = "area_code_state"
            c["state"] += 1
    return c


# ── Websites ─────────────────────────────────────────────────────────────────

WEB_TIMEOUT = 10
WEB_THREADS = 32
WEB_BYTES = 64 * 1024
CLOSED_TEXT = re.compile(r"\b(permanently closed|closed permanently|(?:has|have) (?:now )?(?:permanently )?closed"
                         r"(?! for the (?:season|winter|summer|day|night|weekend|holidays?|year)| until| early| on | at |"
                         r" for (?:renovation|maintenance|construction|repairs)))\b", re.I)
# A sentence about part of the place ("the moorage dock is permanently closed", "the east face...") is not the place.
CLOSED_PART = re.compile(r"\b(dock|docks|pool|spa|restaurant|bar|lounge|cafe|kitchen|grill|trail|trails|road|roads|face|"
                         r"ramp|launch|lane|lanes|section|area|areas|loop|campground|campsites?|site|sites|bridge|beach|"
                         r"building|wing|store|shop|office|gym|fitness|parking|lot|gate|entrance|pier|float|floats|"
                         r"playground|museum|center|centre|facility|tower|route|highway|street)\b", re.I)
WEB_CLOSED_KINDS = ("hotel", "motel", "resort", "marina", "campground")   # park / ramp pages list partial closures


def closed_phrase(text: str) -> str:
    for m in CLOSED_TEXT.finditer(text):
        start = max(text.rfind(".", 0, m.start()), text.rfind("!", 0, m.start()), m.start() - 160) + 1
        if not CLOSED_PART.search(text[start:m.start()]):
            return text[start:m.end()].strip()
    return ""


_UNVERIFIED = ssl.create_default_context()
_UNVERIFIED.check_hostname = False
_UNVERIFIED.verify_mode = ssl.CERT_NONE


def _page_text(raw: bytes) -> str:
    html = raw.decode("utf-8", errors="ignore")
    html = re.sub(r"(?is)<(script|style|noscript)\b.*?(</\1>|$)", " ", html)
    return re.sub(r"\s+", " ", re.sub(r"(?s)<[^>]+>", " ", html))


def probe(url: str) -> tuple[str, str]:
    """('dead' | 'closed' | 'ok' | 'retry', detail). 'retry' = a connection failure worth a second try."""
    def get(ctx=None):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*;q=0.8",
                                                   "Accept-Language": "en-US,en;q=0.8"})
        with urllib.request.urlopen(req, timeout=WEB_TIMEOUT, context=ctx) as resp:
            ctype = resp.headers.get("Content-Type", "")
            return resp.read(WEB_BYTES) if ("html" in ctype or "text" in ctype or not ctype) else b""
    try:
        try:
            body = get()
        except urllib.error.URLError as exc:
            if isinstance(getattr(exc, "reason", None), ssl.SSLError):   # bad certificate: the site still exists
                body = get(_UNVERIFIED)
            else:
                raise
    except urllib.error.HTTPError as exc:
        return ("dead", f"HTTP {exc.code}") if exc.code in (404, 410) else ("ok", f"HTTP {exc.code}")
    except http.client.RemoteDisconnected as exc:       # servers that hang up on bots: not evidence
        return "ok", f"error {exc}"
    except urllib.error.URLError as exc:
        r = exc.reason
        if isinstance(r, socket.gaierror):
            return "retry", "DNS"
        if isinstance(r, http.client.RemoteDisconnected):
            return "ok", f"error {r}"
        if isinstance(r, (ConnectionRefusedError, ConnectionResetError)) or "refused" in str(r).lower() or "reset" in str(r).lower():
            return "retry", "connection"
        return "ok", f"error {r}"
    except (ConnectionRefusedError, ConnectionResetError) as exc:
        return "retry", f"connection {exc}"
    except Exception as exc:  # noqa: BLE001 - timeouts, odd servers: not evidence the place is gone
        return "ok", f"error {exc}"
    phrase = closed_phrase(_page_text(body)) if body else ""
    return ("closed", phrase[-120:]) if phrase else ("ok", "")


def norm_url(u: str) -> str:
    u = (u or "").strip().split(";")[0].strip()
    if u and not re.match(r"(?i)^https?://", u):
        u = "http://" + u
    return u


def check_websites(places: list[dict]) -> tuple[dict, list]:
    for p in places:
        tags_of(p).pop("website_check", None)
    urls = sorted({norm_url(p["website"]) for p in places if p.get("website")} - {""})
    results: dict[str, tuple[str, str]] = {}
    with ThreadPoolExecutor(WEB_THREADS) as pool:
        for u, res in zip(urls, pool.map(probe, urls)):
            results[u] = res
    for threads in (8, 4):                             # two more tries, gently (DNS hiccups under load)
        again = [u for u, (v, _) in results.items() if v == "retry"]
        if not again:
            break
        time.sleep(5)
        with ThreadPoolExecutor(threads) as pool:
            for u, res in zip(again, pool.map(probe, again)):
                if res[0] != "retry" or threads != 4:
                    results[u] = res
                else:
                    results[u] = ("dead", f"{res[1]} three times")
    c = {"urls": len(urls), "dead": 0, "closed": 0}
    examples = []
    for p in places:
        v, detail = results.get(norm_url(p.get("website", "")), ("ok", ""))
        if v == "closed" and p["kind"] not in WEB_CLOSED_KINDS:
            continue
        if v in ("dead", "closed"):
            p["tags"]["website_check"] = v
            c[v] += 1
            examples.append((v, detail, p))
    return c, examples


# ── Quality ──────────────────────────────────────────────────────────────────

def update_quality(places: list[dict]) -> int:
    n = 0
    for p in places:
        groups = {SOURCE_GROUP.get(s, "agency") for s in sources_of(p)}
        if len(groups) >= 2 and p.get("quality") != "verified":
            p["quality"] = "verified"
            n += 1
    return n


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--districts", default="")
    for name in ("ridb", "wikidata", "census", "phones", "websites"):
        ap.add_argument(f"--no-{name}", action="store_true", help=f"skip the {name} check")
    ap.add_argument("--examples", type=int, default=0, help="print this many flagged examples per check and district")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    timing: dict[str, float] = {}

    def timed(key, fn, *a):
        t0 = time.time()
        try:
            return fn(*a)
        finally:
            timing[key] = timing.get(key, 0.0) + time.time() - t0

    ridb_grid = npa = None
    if not args.no_ridb:
        try:
            rows = timed("ridb", load_ridb)
            ridb_grid = make_grid(rows)
            log(f"Recreation.gov: {len(rows):,} ramp / marina / campground facilities")
        except Exception as exc:  # noqa: BLE001
            log(f"Recreation.gov: FAILED ({exc}); check skipped")
    if not args.no_phones:
        npa = timed("phones", load_npa)
        if npa:
            log(f"NANPA: {len(npa):,} area codes")

    man = json.loads((DATA / "manifest.json").read_text("utf-8"))
    wanted = {x.strip() for x in args.districts.split(",") if x.strip()}
    todo = [(did, entry) for did, entry in sorted((man.get("places") or {}).items(), key=lambda kv: int(kv[0]))
            if not wanted or did in wanted]
    # Wikidata is slow on the server side (~20 min for every district) but light here: fetch it in the background
    # while the other checks run; each district waits only for its own tiles.
    wd_pool = ThreadPoolExecutor(1) if not args.no_wikidata else None
    wd_future = {did: wd_pool.submit(wikidata_items, bo.aid_cells(int(did))) for did, _ in todo} if wd_pool else {}
    for did, entry in todo:
        t_district = time.time()
        path = DATA / entry["file"]
        places = json.loads(path.read_text("utf-8"))
        cells = bo.aid_cells(int(did))
        parts = []
        ex: dict[str, list] = {}
        if ridb_grid is not None:
            c = timed("ridb", check_ridb, places, ridb_grid)
            parts.append(f"Recreation.gov {c['matched']} matched ({c['phones']} phones, {c['renamed']} renamed)")
        if not args.no_wikidata and cells:
            try:
                items, ntiles = timed("wikidata (waiting)", wd_future[did].result)
                grid = make_grid(items)
                c = timed("wikidata", check_wikidata, places, grid)
                dam_note = ""
                dam_entry = (man.get("dams") or {}).get(did)
                if dam_entry and (DATA / dam_entry["file"]).exists():
                    dams = json.loads((DATA / dam_entry["file"]).read_text("utf-8"))
                    dc = check_wikidata(dams, grid)
                    bp.write_district(DATA / dam_entry["file"], dams)
                    dam_note = f", dams {dc['matched']} matched"
                parts.append(f"Wikidata {len(items):,} items in {ntiles} tiles, {c['matched']} matched "
                             f"({c['websites']} websites, {c['phones']} phones){dam_note}")
            except Exception as exc:  # noqa: BLE001
                parts.append(f"Wikidata FAILED ({exc})")
        census_states: dict[int, str] = {}
        if not args.no_census:
            c, census_states = timed("census", check_census, places)
            ex["census"] = [p for p in places if p.get("tags", {}).get("address_check") == "far"]
            parts.append(f"Census {c['sent']:,} addresses, {c['matched']:,} matched, {c['confirmed']:,} confirmed, {c['far']} far")
        if not args.no_phones:
            c = timed("phones", check_phones, places, npa, census_states)
            ex["phones"] = [p for p in places if p.get("tags", {}).get("phone_check")]
            parts.append(f"phones {c['phones']:,}, {c['invalid']} invalid removed, {c['state']} other-state area code")
        if not args.no_websites:
            c, wex = timed("websites", check_websites, places)
            ex["websites"] = wex
            parts.append(f"websites {c['urls']:,} checked, {c['dead']} dead, {c['closed']} closed")
        upgraded = update_quality(places)
        places.sort(key=lambda r: (r["kind"], r["name"]))
        bp.write_district(path, places)
        log(f"D{int(did):02d}: " + "; ".join(parts) + f"; {upgraded} now verified ({time.time() - t_district:.0f}s)")
        for key, rows in ex.items():
            for row in rows[:args.examples]:
                if key == "websites":
                    v, detail, p = row
                    log(f"    [{key}] {v} ({detail}): {p['name']} | {p['kind']} | {p.get('website')}")
                else:
                    t = row.get("tags", {})
                    log(f"    [{key}] {row['name']} | {row['kind']} | {row.get('address')} | pin {row['lat']},{row['lon']} | "
                        f"{row.get('phone') or t.get('phone_removed', '')} | {t.get('address_point') or t.get('phone_check')}")
    if wd_pool:
        wd_pool.shutdown()
    bp.update_manifest(DATA)
    log("Time: " + ", ".join(f"{k} {v:.0f}s" for k, v in timing.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
