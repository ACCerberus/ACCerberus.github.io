#!/usr/bin/env python3
"""Publish the latest NOAA buoy / coastal station readings for the web app: lightkeeper/data/ndbc-latest.json.

NOAA's file has no CORS header, so the browser can't read it directly. Runs hourly with the BNM job.
Only stations reporting water temperature, air temperature or wind in the last 6 hours are kept.
"""

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ndbc  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "lightkeeper" / "data" / "ndbc-latest.json"


def main() -> int:
    req = urllib.request.Request(ndbc.LATEST_URL, headers={"User-Agent": "LightKeeper (github.com/ACCerberus/ACCerberus.github.io)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            items = ndbc.parse(resp.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001 - keep the last file
        print(f"NDBC unavailable, keeping the previous file: {exc}")
        return 0
    keep = [{k: v for k, v in s.items() if v is not None} for s in items
            if ndbc._fresh(s) and any(s.get(f) is not None for f in ("water_c", "air_c", "wind_kt"))]
    OUT.write_text(json.dumps({"items": keep}, separators=(",", ":")), "utf-8")
    print(f"{len(keep)} stations -> {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
