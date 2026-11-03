#!/usr/bin/env python3
"""Build each district's places (boat ramps, marinas, hotels / motels / resorts / campgrounds, parks with a ramp,
named dams) from Geofabrik's OpenStreetMap state files instead of the overloaded public Overpass servers.

  python tools/build_places_osm.py                       # all districts (downloads every state needed, one at a time)
  python tools/build_places_osm.py --districts 13        # one district
  python tools/build_places_osm.py --districts 13 --pbf-dir D:/osm   # reuse files already downloaded there

Which states a district needs comes from Geofabrik's region outlines (index-v1.json): every region whose outline
holds (or lies next to) one of the district's aids. Each state file is read once with pyosmium, keeping only
objects with the tags the app uses, then deleted unless --pbf-dir was given. Places within RADIUS_KM of the
district's aids are turned into records with the same rules as the app and the old crawl (tools/build_pois.py:
names, addresses, phones, no hostels, closed places dropped, duplicates merged, parks kept only next to a ramp)
and written to lightkeeper/data/DISTRICT_<id>_<Name>_Places.json and _Dams.json; the manifest lists them.

Needs: pip install osmium (pyosmium 4). Data (c) OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import osmium

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pois as bp  # noqa: E402  (record rules shared with the Overpass crawl)

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
INDEX_URL = "https://download.geofabrik.de/index-v1.json"
UA = "LightKeeper places build (cerberusac.dev/lightkeeper)"
RADIUS_KM = 40                 # places this close to an aid cell (same reach as the old crawl)
CELL_DEG = 0.25                # aid cells used for the distance test
NEAR_DEG = 0.3                 # a region also counts when an aid is this close to its outline
REGION_PREFIXES = ("us/",)
EXTRA_REGIONS = ("american-oceania",)   # Guam, American Samoa, Northern Marianas (D14)

# Every tag the record rules look at (tools/build_pois.py _is_*_element); pyosmium keeps only these objects.
TAGS = (
    ("leisure", "slipway"), ("leisure", "marina"), ("amenity", "boat_ramp"), ("waterway", "slipway"),
    ("waterway", "boat_ramp"), ("sport", "boat_launching"), ("boat", "yes"),
    ("tourism", "hotel"), ("tourism", "motel"), ("tourism", "resort"), ("building", "hotel"), ("building", "motel"),
    ("leisure", "park"), ("leisure", "nature_reserve"), ("tourism", "camp_site"), ("tourism", "caravan_site"),
    ("boundary", "national_park"), ("boundary", "protected_area"), ("waterway", "dam"),
)


def fetch(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)


# ── Which regions a district needs ────────────────────────────────────────────

def _in_ring(lat: float, lon: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _in_multipolygon(lat: float, lon: float, polys: list) -> bool:
    return any(_in_ring(lat, lon, poly[0]) and not any(_in_ring(lat, lon, hole) for hole in poly[1:]) for poly in polys)


def load_regions(index_path: Path) -> list[dict]:
    regions = []
    for f in json.loads(index_path.read_text("utf-8"))["features"]:
        p = f["properties"]
        if not (p["id"].startswith(REGION_PREFIXES) or p["id"] in EXTRA_REGIONS) or "pbf" not in p.get("urls", {}):
            continue
        polys = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]]
        xs = [pt[0] for poly in polys for pt in poly[0]]
        ys = [pt[1] for poly in polys for pt in poly[0]]
        regions.append({"id": p["id"], "url": p["urls"]["pbf"], "polys": polys, "bbox": (min(xs), min(ys), max(xs), max(ys))})
    return regions


def aid_cells(district_id: int) -> set[tuple[int, int]]:
    return {(math.floor(lat / CELL_DEG), math.floor(lon / CELL_DEG)) for lat, lon in bp.load_aid_points(DATA, district_id)}


def regions_for(cells: set[tuple[int, int]], regions: list[dict]) -> list[dict]:
    """Regions whose outline holds a cell centre, or a point NEAR_DEG away from one."""
    found = []
    offsets = ((0, 0), (NEAR_DEG, 0), (-NEAR_DEG, 0), (0, NEAR_DEG), (0, -NEAR_DEG))
    for r in regions:
        w, s, e, n = r["bbox"]
        for cy, cx in cells:
            lat, lon = (cy + 0.5) * CELL_DEG, (cx + 0.5) * CELL_DEG
            if not (s - NEAR_DEG <= lat <= n + NEAR_DEG and w - NEAR_DEG <= lon <= e + NEAR_DEG):
                continue
            if any(_in_multipolygon(lat + dy, lon + dx, r["polys"]) for dy, dx in offsets):
                found.append(r)
                break
    return found


# ── Reading a state file ──────────────────────────────────────────────────────

def _centre(nodes) -> tuple[float, float] | None:
    lats, lons = [], []
    for n in nodes:
        loc = n.location
        if loc.valid():
            lats.append(loc.lat)
            lons.append(loc.lon)
    return (sum(lats) / len(lats), sum(lons) / len(lons)) if lats else None


def read_pbf(path: Path) -> list[dict]:
    """Objects with a relevant tag, as Overpass-style elements ({type, id, tags, lat/lon or center})."""
    out: list[dict] = []
    fp = osmium.FileProcessor(str(path)).with_areas().with_filter(osmium.filter.TagFilter(*TAGS))
    for obj in fp:
        tags = {t.k: t.v for t in obj.tags}
        if obj.is_node():
            if obj.location.valid():
                out.append({"type": "node", "id": obj.id, "tags": tags, "lat": obj.location.lat, "lon": obj.location.lon})
        elif obj.is_way():
            c = _centre(obj.nodes)
            if c:
                out.append({"type": "way", "id": obj.id, "tags": tags, "center": {"lat": c[0], "lon": c[1]}})
        elif obj.is_area() and not obj.from_way():           # multipolygon relations (closed ways came as ways)
            for ring in obj.outer_rings():
                c = _centre(ring)
                if c:
                    out.append({"type": "relation", "id": obj.orig_id(), "tags": tags, "center": {"lat": c[0], "lon": c[1]}})
                break
    return out


# ── Building a district ───────────────────────────────────────────────────────

def near_aids(el: dict, cells: set[tuple[int, int]]) -> bool:
    c = el if "lat" in el else el["center"]
    lat, lon = c["lat"], c["lon"]
    reach = math.ceil(RADIUS_KM / (111 * CELL_DEG)) + 1
    cy, cx = math.floor(lat / CELL_DEG), math.floor(lon / CELL_DEG)
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            if (cy + dy, cx + dx) in cells:
                clat, clon = (cy + dy + 0.5) * CELL_DEG, (cx + dx + 0.5) * CELL_DEG
                if bp.haversine_miles(lat, lon, clat, clon) * 1.609 <= RADIUS_KM + CELL_DEG * 111 * 0.71:
                    return True
    return False


def build_district(elements: list[dict]) -> tuple[list[dict], list[dict]]:
    tags_of = lambda e: e.get("tags") or {}   # noqa: E731
    parks = bp.dedup([r for r in (bp.park_record(e) for e in elements if bp._is_park_element(tags_of(e))) if r])
    ramps = bp.dedup([r for r in (bp.ramp_record(e, parks) for e in elements if bp._is_ramp_element(tags_of(e))) if r])
    lodging = bp.dedup([r for r in (bp.lodging_record(e) for e in elements if bp._is_lodging_element(tags_of(e))) if r])
    dams = {}
    for rec in (bp.dam_record(e) for e in elements if bp._is_dam_element(tags_of(e))):
        if rec:
            dams.setdefault(rec["id"], rec)
    parks = bp.link_parks(ramps, parks)
    places = sorted(ramps + lodging + parks, key=lambda r: (r["kind"], r["name"]))
    return places, sorted(dams.values(), key=lambda r: r["name"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--districts", default="", help="comma-separated district ids (default: all)")
    ap.add_argument("--pbf-dir", type=Path, default=None, help="keep / reuse downloaded state files here")
    ap.add_argument("--index", type=Path, default=None, help="Geofabrik index-v1.json (downloaded when omitted)")
    args = ap.parse_args()

    districts = json.loads((DATA / "districts.json").read_text("utf-8"))
    wanted = [int(x) for x in args.districts.split(",") if x.strip()]
    if wanted:
        districts = [d for d in districts if d["id"] in wanted]
    work = Path(tempfile.mkdtemp(prefix="lk-osm-"))
    pbf_dir = args.pbf_dir or work
    pbf_dir.mkdir(parents=True, exist_ok=True)
    index = args.index or (pbf_dir / "index-v1.json")
    if not index.exists():
        fetch(INDEX_URL, index)
    regions = load_regions(index)

    cells = {d["id"]: aid_cells(d["id"]) for d in districts}
    need = {d["id"]: regions_for(cells[d["id"]], regions) for d in districts}
    for d in districts:
        print(f"D{d['id']:02d} {d['name']}: {', '.join(r['id'] for r in need[d['id']]) or 'no regions'}", flush=True)

    started = time.time()
    per_district: dict[int, list[dict]] = {d["id"]: [] for d in districts}
    failed_regions: list[str] = []
    for region in sorted({r["id"]: r for rs in need.values() for r in rs}.values(), key=lambda r: r["id"]):
        t0 = time.time()
        path = pbf_dir / (region["id"].replace("/", "_") + ".osm.pbf")
        try:
            if not path.exists():
                fetch(region["url"], path)
            elements = read_pbf(path)
        except Exception as exc:  # noqa: BLE001 - one bad region fails only the districts that need it
            print(f"  {region['id']}: FAILED ({exc})", flush=True)
            failed_regions.append(region["id"])
            continue
        finally:
            if args.pbf_dir is None and path.exists():
                path.unlink()
        for did, rs in need.items():
            if any(r["id"] == region["id"] for r in rs):
                per_district[did].extend(e for e in elements if near_aids(e, cells[did]))
        print(f"  {region['id']}: {len(elements):,} tagged objects ({time.time() - t0:.0f}s)", flush=True)

    failed: list[int] = []
    for d in districts:
        did = d["id"]
        if any(r["id"] in failed_regions for r in need[did]):
            print(f"D{did:02d}: a state file failed, keeping the previous files", flush=True)
            failed.append(did)
            continue
        unique = {(e["type"], e["id"]): e for e in per_district[did]}   # states overlap at their borders
        places, dams = build_district(list(unique.values()))
        kinds: dict[str, int] = {}
        for r in places:
            kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
        bp.write_district(DATA / bp.places_filename(d), places)
        bp.write_district(DATA / bp.dams_filename(d), dams)
        print(f"D{did:02d}: {len(places):,} places {kinds}, {len(dams):,} named dams", flush=True)
    bp.update_manifest(DATA)
    print(f"Done in {(time.time() - started) / 60:.1f} min; failed districts: {failed or 'none'}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
