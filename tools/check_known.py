#!/usr/bin/env python3
"""Fail the weekly places build when a place checked by hand (tools/known_places.json) has gone missing, or when a
hostel slipped into any district's places.

  python tools/check_known.py        # exit 1 and list what's wrong; the job then stops before publishing
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_pois as bp  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
LODGING = ("hotel", "motel", "resort", "campground")


def main() -> int:
    known = json.loads((Path(__file__).resolve().parent / "known_places.json").read_text("utf-8"))["places"]
    man = json.loads((DATA / "manifest.json").read_text("utf-8"))
    cache: dict[str, list[dict]] = {}

    def records(district: int, dams: bool) -> list[dict]:
        entry = (man.get("dams" if dams else "places") or {}).get(str(district)) or {}
        name = entry.get("file", "")
        if name and name not in cache:
            cache[name] = json.loads((DATA / name).read_text("utf-8"))
        return cache.get(name, [])

    problems = []
    for k in known:
        kinds = set(k["kind"])
        if "lodging" in kinds:
            kinds |= set(LODGING)
        pool = records(k["district"], "dam" in kinds) if kinds == {"dam"} else records(k["district"], False)
        pattern = re.compile(k["name"], re.I) if k["name"] else None
        hits = [r for r in pool if (r.get("kind") in kinds or kinds == {"dam"})
                and (pattern is None or pattern.search(r.get("name", "")))
                and bp.haversine_miles(r["lat"], r["lon"], k["lat"], k["lon"]) <= k["within_mi"]]
        print(f"{'ok  ' if hits else 'MISS'}  {k['label']}" + (f"  ({hits[0]['name']})" if hits else ""))
        if not hits:
            problems.append(k["label"])
    for did in (man.get("places") or {}):
        for r in records(int(did), False):
            if r.get("kind") in LODGING and bp.is_hostel(r.get("name", ""), {}):
                problems.append(f"hostel in D{did}: {r['name']}")
    if problems:
        print("\nKnown-places check failed: " + "; ".join(problems[:20]))
        return 1
    print("\nAll known places present, no hostels.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
