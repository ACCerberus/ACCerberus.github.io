#!/usr/bin/env python3
"""Write lightkeeper/data/stats.json: a small summary of how complete and how checked the published data is, for the
site's "Data health" page and the one-line stat on the home page (so visitors don't download ~20 MB of place files).

  python tools/build_stats.py

Run at the end of the weekly places job and the daily health check. Reads the manifest, the district place and dam
files and health.json (when present).
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
LODGING = ("hotel", "motel", "resort", "campground")
PHONE_KINDS = ("hotel", "motel", "resort", "marina")       # ramps and parks rarely list a phone: not counted against them


def pct(n: int, total: int) -> float | None:
    return round(100 * n / total, 1) if total else None


def summarize(places: list[dict]) -> dict:
    kinds: dict[str, int] = {}
    quality = {"verified": 0, "likely": 0, "unverified": 0}
    for p in places:
        kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
        quality[p.get("quality", "unverified")] = quality.get(p.get("quality", "unverified"), 0) + 1
    phone_pool = [p for p in places if p["kind"] in PHONE_KINDS]
    addr_pool = [p for p in places if p["kind"] in LODGING + ("marina",)]
    sources: dict[str, int] = {}
    for p in places:
        for s in p.get("sources") or [p.get("source", "OpenStreetMap")]:
            sources[s] = sources.get(s, 0) + 1
    return {
        "places": len(places), "kinds": kinds, "quality": quality,
        "verified_pct": pct(quality.get("verified", 0), len(places)),
        "checked_pct": pct(sum(1 for p in places if len(p.get("sources") or []) > 1), len(places)),
        "phone_pct": pct(sum(1 for p in phone_pool if p.get("phone")), len(phone_pool)),
        "address_pct": pct(sum(1 for p in addr_pool if p.get("address")), len(addr_pool)),
        "named_pct": pct(sum(1 for p in places if p.get("name_source") != "derived"), len(places)),
        "sources": sources,
    }


def main() -> int:
    man = json.loads((DATA / "manifest.json").read_text("utf-8"))
    districts = {str(d["id"]): d["name"] for d in json.loads((DATA / "districts.json").read_text("utf-8"))}
    out_districts = {}
    everything: list[dict] = []
    for did, name in districts.items():
        entry = (man.get("places") or {}).get(did) or {}
        places = json.loads((DATA / entry["file"]).read_text("utf-8")) if entry.get("file") and (DATA / entry["file"]).exists() else []
        dams = (man.get("dams") or {}).get(did, {}).get("count", 0)
        everything.extend(places)
        out_districts[did] = {"name": name, "aids": (man.get("counts") or {}).get(did, 0), "dams": dams, **summarize(places)}
    health_path = DATA / "health.json"
    health = json.loads(health_path.read_text("utf-8")) if health_path.exists() else None
    old_path = DATA / "stats.json"
    old = json.loads(old_path.read_text("utf-8")) if old_path.exists() else {}
    stats = {
        "spot_check": old.get("spot_check"),      # kept between runs; written by tools/spotcheck.py score
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "light_list_built_at": man.get("built_at"),
        "places_built_at": man.get("places_checked_at"),
        "aids": man.get("total", 0),
        "stations": man.get("stations", {}),
        "all": summarize(everything),
        "districts": out_districts,
        "health": None if not health else {
            "checked_at": health.get("checked_at"),
            "ok": sum(1 for s in health["sources"] if s["ok"]), "total": len(health["sources"]),
            "down": [s["name"] for s in health["sources"] if not s["ok"]],
            "sources": [{"name": s["name"], "ok": s["ok"], "must_have": s["must_have"]} for s in health["sources"]],
        },
    }
    (DATA / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8", newline="\n")
    a = stats["all"]
    print(f"stats.json: {stats['aids']:,} aids, {a['places']:,} places, {a['verified_pct']}% verified, "
          f"{a['checked_pct']}% checked against a second source, phones {a['phone_pct']}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
