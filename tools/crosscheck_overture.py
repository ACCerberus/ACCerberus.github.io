#!/usr/bin/env python3
"""Check each district's hotels, motels, resorts, campgrounds and marinas against Overture Maps Places (a second, open
business database built from Meta, Microsoft and other sources; CDLA-Permissive-2.0) after the OpenStreetMap build.

  python tools/crosscheck_overture.py                  # all districts with a places file
  python tools/crosscheck_overture.py --districts 13

For every place of those kinds in DISTRICT_<id>_<Name>_Places.json:
  - found in Overture (close by, similar name)  -> sources gets "Overture", quality "verified", and a missing phone,
    website or address is filled from Overture;
  - Overture says permanently closed            -> dropped;
Overture places that OpenStreetMap lacks are added when Overture is confident (>= NEW_MIN_CONFIDENCE) they exist and
are open, near the district's aids, and not a hostel. Ramps and parks are checked against official lists separately.

Needs: pip install duckdb. Reads Overture's public files on AWS directly (no key); only the district's area is read.
"""

from __future__ import annotations

import argparse
import difflib
import json
import math
import re
import sys
import urllib.request
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pois as bp  # noqa: E402
import build_places_osm as bo  # noqa: E402

DATA = bp.Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
BUCKET = "overturemaps-us-west-2"
MATCH_MI = 0.12                 # same place: within ~200 m ...
NAME_MIN = 0.55                 # ... and names this similar (0-1); or within SAME_SPOT_MI whatever the name
SAME_SPOT_MI = 0.02
NEW_MIN_CONFIDENCE = 0.85
CHECKED = ("hotel", "motel", "resort", "campground", "marina")
ADD_KINDS = ("hotel", "motel", "resort", "marina")   # campgrounds are confirmed, never added (would crowd the Hotels layer)
# Overture taxonomy -> LightKeeper kind (bed and breakfasts, cabins and hostels are left out on purpose)
KIND = {"hotel": "hotel", "motel": "motel", "resort": "resort", "lodge": "hotel", "inn": "hotel",
        "campground": "campground", "rv_park": "campground", "marina": "marina"}
# Added (Overture-only) places must look like lodging or a marina by name: Overture files some clubs, offices and
# shops under lodging categories. Fraternal lodges (Elks, Eagles...) are never lodging.
LODGING_NAME = re.compile(r"\b(hotel|motel|inn|suites?|lodge|lodging|resort|motor|cabins?|cottages?|marina|harbou?r|moorage|"
                          r"yacht|boat|landing|holiday inn|best western|super 8|days inn|la quinta|hampton|hilton|marriott|"
                          r"comfort|quality|travelodge|red lion|econo|sleep inn|choice|wyndham|sandman|courtyard|residence|vacation rentals?)\b", re.I)
CLUB_NAME = re.compile(r"\b(elks?|bpoe|eagles|foe|moose|masonic|mason|odd fellows|ioof|legion|vfw|grange|fraternal|lions|"
                       r"rotary|kiwanis|church|ministr|furniture|realty|apartments?|storage|school|camp and retreat|boat ramp|launch|lodge (no\.?|#) ?\d+)\b", re.I)
NOT_MARINA = re.compile(r"restaurant|bar|cafe|food|grill|pizza|shop|store|salon|church|school|apartment|real_estate|bank|"
                        r"doctor|dentist|clinic|hospital|insurance|lawyer|office|hotel|motel|condo|residential", re.I)
STOP = re.compile(r"\b(the|hotel|motel|inn|suites?|resort|lodge|marina|and|&|by|at|of)\b")


def latest_release() -> str:
    url = f"https://{BUCKET}.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/"
    xml = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": bo.UA}), timeout=60).read().decode()
    return sorted(re.findall(r"<Prefix>release/([^<]+)/</Prefix>", xml))[-1]


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", STOP.sub(" ", re.sub(r"[^a-z0-9& ]+", " ", (name or "").lower()))).strip()


def similar(a: str, b: str) -> float:
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if na in nb or nb in na:
        return 1.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def query(con, release: str, cells: set[tuple[int, int]]) -> list[dict]:
    ys = [c[0] for c in cells]
    xs = [c[1] for c in cells]
    pad = 0.5
    s, n = min(ys) * bo.CELL_DEG - pad, (max(ys) + 1) * bo.CELL_DEG + pad
    w, e = min(xs) * bo.CELL_DEG - pad, (max(xs) + 1) * bo.CELL_DEG + pad
    cats = ",".join(f"'{c}'" for c in KIND)
    rows = con.execute(f"""
        SELECT id, names.primary, taxonomy.primary, confidence, phones, websites,
               addresses[1].freeform, addresses[1].locality, addresses[1].region, addresses[1].postcode, addresses[1].country,
               operating_status, (bbox.ymin + bbox.ymax) / 2, (bbox.xmin + bbox.xmax) / 2
        FROM read_parquet('s3://{BUCKET}/release/{release}/theme=places/type=place/*', hive_partitioning=1)
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n} AND (taxonomy.primary IN ({cats}) OR names.primary ILIKE '%marina%')
    """).fetchall()
    out = []
    for (oid, name, cat, conf, phones, webs, street, city, region, postcode, country, status, lat, lon) in rows:
        el = {"lat": lat, "lon": lon}
        if not name or (country and country != "US") or not bo.near_aids(el, cells):
            continue
        address = ", ".join(x for x in (street, city, " ".join(x for x in (region, postcode) if x)) if x)
        if cat not in KIND:                       # a "... Marina" Overture filed under another category
            if NOT_MARINA.search(cat or ""):
                continue
            cat = "marina"
        kind = KIND[cat] if KIND[cat] in ("marina", "campground") else bp.lodging_kind(name, {"tourism": "motel"} if cat == "motel" else {})
        out.append({"id": oid, "name": name, "kind": kind, "confidence": conf or 0, "status": status or "",
                    "phone": bp.clean_phone((phones or [""])[0]), "website": (webs or [""])[0] or "",
                    "address": address, "lat": lat, "lon": lon})
    return out


def crosscheck(places: list[dict], overture: list[dict]) -> tuple[list[dict], dict]:
    grid: dict[tuple[int, int], list[dict]] = {}
    for o in overture:
        grid.setdefault((int(o["lat"] * 100), int(o["lon"] * 100)), []).append(o)   # ~0.7 mi cells
    used: set[str] = set()
    counts = {"checked": 0, "confirmed": 0, "closed": 0, "phones_added": 0, "added": 0}
    kept = []
    for p in places:
        if p["id"].startswith("overture:"):              # added by an earlier run: it is its own Overture record
            used.add(p["id"].split(":", 1)[1])
            kept.append(p)
            continue
        if p["kind"] not in CHECKED:
            kept.append(p)
            continue
        counts["checked"] += 1
        cy, cx = int(p["lat"] * 100), int(p["lon"] * 100)
        best, best_score = None, 0.0
        for o in (o for dy in (-1, 0, 1) for dx in (-1, 0, 1) for o in grid.get((cy + dy, cx + dx), ())):
            d = bp.haversine_miles(p["lat"], p["lon"], o["lat"], o["lon"])
            if d > MATCH_MI:
                continue
            score = similar(p["name"], o["name"]) if p.get("name_source") != "derived" else 0.6
            if d <= SAME_SPOT_MI and (p["kind"] == o["kind"] or score >= NAME_MIN):
                score = max(score, NAME_MIN)
            score -= d                                   # nearer wins a tie
            if score >= NAME_MIN - SAME_SPOT_MI and score > best_score:
                best, best_score = o, score
        if best is None:
            kept.append(p)
            continue
        used.add(best["id"])
        if best["status"] == "permanently_closed" or bp.is_hostel(best["name"], {}):
            counts["closed"] += 1
            continue
        counts["confirmed"] += 1
        p["sources"] = sorted(set((p.get("sources") or [p.get("source", "OpenStreetMap")]) + ["Overture"]))
        p["quality"] = "verified"
        if not p.get("phone") and best["phone"]:
            p["phone"] = best["phone"]
            counts["phones_added"] += 1
        if not p.get("website") and best["website"]:
            p["website"] = best["website"]
        if not p.get("address") and best["address"]:
            p["address"] = best["address"]
        if p.get("name_source") == "derived":
            p["name"], p["name_source"] = bp.tidy_name(best["name"]), "overture"
        kept.append(p)
    for o in overture:
        if o["id"] in used or o["confidence"] < NEW_MIN_CONFIDENCE or o["status"] not in ("", "open"):
            continue
        if o["kind"] not in ADD_KINDS or not LODGING_NAME.search(o["name"]) or CLUB_NAME.search(o["name"]):
            continue
        if bp.is_hostel(o["name"], {}) or any(w in o["name"].lower() for w in bp.CLOSED_NAME_WORDS):
            continue
        kept.append({"id": f"overture:{o['id']}", "kind": o["kind"], "name": bp.tidy_name(o["name"]), "name_source": "overture",
                     "lat": round(o["lat"], 6), "lon": round(o["lon"], 6), "address": o["address"], "phone": o["phone"],
                     "website": o["website"], "operator": "", "tags": {}, "quality": "likely",
                     "source": "Overture", "sources": ["Overture"]})
        counts["added"] += 1
    return bp.dedup_by_kind(kept) if counts["added"] else kept, counts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--districts", default="")
    ap.add_argument("--release", default="", help="Overture release, e.g. 2026-10-21.0 (default: newest)")
    args = ap.parse_args()
    release = args.release or latest_release()
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    man = json.loads((DATA / "manifest.json").read_text("utf-8"))
    wanted = {x.strip() for x in args.districts.split(",") if x.strip()}
    print(f"Overture release {release}", flush=True)
    for did, entry in sorted((man.get("places") or {}).items(), key=lambda kv: int(kv[0])):
        if wanted and did not in wanted:
            continue
        path = DATA / entry["file"]
        places = json.loads(path.read_text("utf-8"))
        cells = bo.aid_cells(int(did))
        if not cells:
            continue
        overture = query(con, release, cells)
        result, c = crosscheck(places, overture)
        result.sort(key=lambda r: (r["kind"], r["name"]))
        bp.write_district(path, result)
        print(f"D{int(did):02d}: {len(overture):,} Overture places nearby; {c['checked']:,} checked, {c['confirmed']:,} confirmed, "
              f"{c['closed']} closed dropped, {c['phones_added']} phones filled, {c['added']} added", flush=True)
    bp.update_manifest(DATA)
    return 0


if __name__ == "__main__":
    sys.exit(main())
