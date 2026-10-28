#!/usr/bin/env python3
"""Publish USCG Broadcast Notices to Mariners (aids to navigation) for the web app: lightkeeper/data/bnm-D<id>.json.

    python tools/build_bnm.py              # every district with feeds (Northwest only for now)

Runs hourly in .github/workflows/lightkeeper-bnm.yml. The parser is tools/bnm.py, the same file the desktop app uses.
A file is rewritten only when its notices changed, so quiet hours make no commit.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bnm  # noqa: E402

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
USER_AGENT = "LightKeeper (BNM build; github.com/ACCerberus/ACCerberus.github.io)"


def main() -> int:
    failed = []
    for district in bnm.FEEDS:
        path = DATA / f"bnm-D{district}.json"
        try:
            items = bnm.fetch_district(district, USER_AGENT, strict=True)
        except Exception as exc:  # noqa: BLE001 - keep the last published file
            print(f"D{district}: feeds failed, keeping the previous file ({exc})")
            failed.append(district)
            continue
        old = json.loads(path.read_text("utf-8")) if path.exists() else {}
        if old.get("items") == items:
            print(f"D{district}: {len(items)} notices, unchanged")
            continue
        payload = {"district": district, "fetched_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "items": items}
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), "utf-8")
        print(f"D{district}: {len(items)} notices ({sum(i['active'] for i in items)} active) -> {path.name}")
    return 1 if failed and len(failed) == len(bnm.FEEDS) else 0


if __name__ == "__main__":
    sys.exit(main())
