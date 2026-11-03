#!/usr/bin/env python3
"""Monthly spot-check: a measured accuracy for the places data, from places checked by hand.

  python tools/spotcheck.py new   > body.md    # 20 random places per district as a GitHub issue checklist
  python tools/spotcheck.py score              # read the newest closed "spot-check" issue -> stats.json "spot_check"

How it works: on the 1st of each month the "LightKeeper spot-check" job opens an issue labelled spot-check with the
checklist. Open each Google Maps link and tick the box when the place is right (it exists, is that kind of place, is
open, and the pin, name and phone are correct). Leave it unticked when anything is wrong, and close the issue when done.
The daily health job then scores the newest closed issue: ticked / listed, with a 95% margin, e.g. "94% ± 2%".
"""

from __future__ import annotations

import json
import math
import os
import random
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
PER_DISTRICT = 20
REPO = os.environ.get("GITHUB_REPOSITORY", "ACCerberus/ACCerberus.github.io")
LINE = re.compile(r"^\s*- \[( |x|X)\] ", re.M)


def new() -> int:
    man = json.loads((DATA / "manifest.json").read_text("utf-8"))
    names = {str(d["id"]): d["name"] for d in json.loads((DATA / "districts.json").read_text("utf-8"))}
    month = datetime.now(timezone.utc).strftime("%Y-%m")
    rng = random.Random(month)                       # the same month always draws the same sample
    out = [f"Monthly spot-check for {month}. For each place, open the Google Maps link and **tick the box if everything is "
           "right**: the place exists and is open, it's the right kind (ramp, hotel...), and the pin, name and phone match. "
           "Leave it unticked if anything is wrong (add a comment saying what). Close the issue when you're done; the Data "
           "health page then shows the measured accuracy.\n"]
    for did, entry in sorted((man.get("places") or {}).items(), key=lambda kv: int(kv[0])):
        places = json.loads((DATA / entry["file"]).read_text("utf-8"))
        pick = rng.sample(places, min(PER_DISTRICT, len(places)))
        out.append(f"\n### D{did} {names.get(did, '')}\n")
        for p in pick:
            q = f"{p['name']} {p['lat']:.5f},{p['lon']:.5f}"
            gm = f"https://www.google.com/maps/search/?api=1&query={urllib.request.quote(q)}"
            extra = " · ".join(x for x in (p.get("address"), p.get("phone")) if x)
            out.append(f"- [ ] **{p['name']}** ({p['kind']}){' · ' + extra if extra else ''} · [Google Maps]({gm})")
    print("\n".join(out))
    return 0


def score() -> int:
    token = os.environ.get("GITHUB_TOKEN", "")
    url = f"https://api.github.com/repos/{REPO}/issues?labels=spot-check&state=closed&per_page=5&sort=created&direction=desc"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(req, timeout=60) as resp:
        issues = json.loads(resp.read())
    if not issues:
        print("No closed spot-check yet.")
        return 0
    issue = issues[0]
    marks = LINE.findall(issue.get("body") or "")
    n, ok = len(marks), sum(1 for m in marks if m.lower() == "x")
    if not n:
        print("The newest spot-check has no checklist.")
        return 0
    p = ok / n
    margin = 1.96 * math.sqrt(p * (1 - p) / n) if 0 < p < 1 else 1.96 * math.sqrt(0.25 / n) / 2
    result = {"title": issue["title"], "url": issue["html_url"], "closed_at": issue.get("closed_at"), "checked": n, "correct": ok,
              "accuracy_pct": round(100 * p, 1), "margin_pct": round(100 * margin, 1)}
    path = DATA / "stats.json"
    stats = json.loads(path.read_text("utf-8")) if path.exists() else {}
    stats["spot_check"] = result
    path.write_text(json.dumps(stats, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8", newline="\n")
    print(f"Spot-check {issue['title']}: {ok}/{n} correct = {result['accuracy_pct']}% ± {result['margin_pct']}%")
    return 0


if __name__ == "__main__":
    sys.exit({"new": new, "score": score}.get((sys.argv[1:] or [""])[0], lambda: print(__doc__) or 2)())
