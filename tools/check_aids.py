#!/usr/bin/env python3
"""Weekly checks on the Light List after tools/build_aids.py -> lightkeeper/data/aid-checks-D<id>.json.

  python tools/check_aids.py --prev DIR      # DIR holds last week's aids-D*.json (the job copies them before the build)
  python tools/check_aids.py                 # chart comparison only

1. NOAA chart comparison: every lit aid is compared with the nearest light on NOAA's electronic navigational charts
   (ENC Direct, harbor and coastal scale; keyless). Flags: charted more than POS_FLAG_M away, a different color, or a
   different flash period. Two separate sources (USCG Light List, NOAA charts) agreeing is a strong check; a flag
   means one of them is out of date, and the card says so.
2. Week-to-week changes: aids that moved more than POS_FLAG_M, changed characteristic, appeared or disappeared since
   last week. Changes are kept on the card for KEEP_DAYS. If a district loses more than MAX_LOSS of its aids at
   once, the script exits 2 and the job stops before publishing (a broken download, not a real change).

Output per district: {"built_at", "chart": {objectid: [text, ...]}, "changes": {objectid: {"date", "text"}},
                      "removed": [{"name", "llnr", "date"}], "summary": {...}}
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
UA = "LightKeeper data build (cerberusac.dev/lightkeeper)"
ENC = "https://encdirect.noaa.gov/arcgis/rest/services/encdirect"
ENC_LAYERS = (("enc_harbour", 11), ("enc_coastal", 10))   # Light_point layers; harbor scale is the most precise
DISTRICTS = (1, 5, 7, 8, 9, 11, 13, 14, 17)
MATCH_M = 250          # nearest charted light within this distance is "the same light"
POS_FLAG_M = 50
SAME_SPOT_M = 30
MULTI_LIGHT = re.compile(r"Lights|\(\d+\)|Barrier|Range|Pier|Dock|Bridge|Mooring|Passing", re.I)   # several lights or a moving reference
PERIOD_TOL_S = 0.6
KEEP_DAYS = 28
MAX_LOSS = 0.05
ENC_COLOUR = {"1": "W", "3": "R", "4": "G", "6": "Y", "11": "O", "5": "Bu"}   # S-57 COLOUR codes
COLOR_WORD = {"W": "white", "R": "red", "G": "green", "Y": "yellow", "O": "orange", "Bu": "blue"}


def get_json(url: str, params: dict, tries: int = 3) -> dict:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as resp:
                d = json.loads(resp.read())
            if "error" in d:
                raise RuntimeError(d["error"].get("message"))
            return d
        except Exception:  # noqa: BLE001
            if attempt == tries - 1:
                raise
            time.sleep(10 * (attempt + 1))
    return {}


def enc_lights(bounds: list[list[float]]) -> list[dict]:
    """Charted lights inside a district's bounds, from every scale that answers."""
    out: list[dict] = []
    for service, layer in ENC_LAYERS:
        url = f"{ENC}/{service}/MapServer/{layer}/query"
        try:
            for w, s, e, n in bounds:
                offset = 0
                while True:
                    d = get_json(url, {"where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
                                       "inSR": 4326, "outSR": 4326, "outFields": "COLOUR,LITCHR,SIGPER,SIGGRP", "f": "json",
                                       "resultOffset": offset, "resultRecordCount": 1000})
                    feats = d.get("features") or []
                    for f in feats:
                        g, a = f.get("geometry") or {}, f["attributes"]
                        if "x" in g:
                            out.append({"lat": g["y"], "lon": g["x"], "colors": {ENC_COLOUR.get(c.strip(), "?") for c in str(a.get("COLOUR") or "").split(",")},
                                        "period": a.get("SIGPER")})
                    if not d.get("exceededTransferLimit") or not feats:
                        break
                    offset += len(feats)
        except Exception as exc:  # noqa: BLE001 - a chart scale that's down is skipped this week
            print(f"  {service}: unavailable ({exc})", flush=True)
    return out


def meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742000 * math.asin(math.sqrt(a))


CHAR_COLOR = re.compile(r"\b(Bu|R|G|Y|W)\b")
CHAR_PERIOD = re.compile(r"(\d+(?:\.\d+)?)\s*s\b")


def load(path: Path) -> dict[str, dict]:
    t = json.loads(path.read_text("utf-8"))
    f = t["fields"]
    return {str(r[f.index("objectid")]): {k: r[f.index(k)] for k in ("aidname", "lightlistnumber", "latitude", "longitude", "characteristics")}
            for r in t["rows"]}


def chart_flags(aids: dict[str, dict], lights: list[dict]) -> dict[str, list[str]]:
    grid: dict[tuple[int, int], list[dict]] = {}
    for L in lights:
        grid.setdefault((int(L["lat"] * 200), int(L["lon"] * 200)), []).append(L)      # ~550 m cells
    flags: dict[str, list[str]] = {}
    for oid, a in aids.items():
        char = a["characteristics"] or ""
        if not char:
            continue
        cy, cx = int(a["latitude"] * 200), int(a["longitude"] * 200)
        near = sorted(((meters(a["latitude"], a["longitude"], L["lat"], L["lon"]), L)
                       for dy in (-1, 0, 1) for dx in (-1, 0, 1) for L in grid.get((cy + dy, cx + dx), ())), key=lambda t: t[0])
        near = [(d, L) for d, L in near if d <= MATCH_M]
        if not near:
            continue
        m = CHAR_COLOR.search(char)
        p = CHAR_PERIOD.search(char)
        color = m.group(1) if m and m.group(1) in COLOR_WORD else None
        period = float(p.group(1)) if p else None

        def same_light(L: dict) -> bool:
            ok_color = color is None or color in L["colors"]
            ok_period = period is None or not L.get("period") or abs(period - float(L["period"])) <= PERIOD_TOL_S
            return ok_color and ok_period

        out = []
        d, L = near[0]
        if same_light(L):
            matching = [x for dd, x in near if same_light(x)]
            single = not MULTI_LIGHT.search(a["aidname"] or "")
            if d > POS_FLAG_M and single and len(matching) == 1:
                out.append(f"NOAA chart shows this light {round(d)} m from the Light List position")
        elif d <= SAME_SPOT_M and not any(same_light(x) for dd, x in near if dd <= MATCH_M) and "?" not in L["colors"]:
            # A different light charted right on this spot, and no matching light anywhere near: one source is out of date.
            if color and color not in L["colors"]:
                charted = "/".join(sorted(COLOR_WORD.get(c, c) for c in L["colors"]))
                out.append(f"NOAA chart shows a {charted} light here, the Light List says {COLOR_WORD[color]}")
            if period and L.get("period") and abs(period - float(L["period"])) > PERIOD_TOL_S:
                out.append(f"NOAA chart shows a {float(L['period']):g} s period here, the Light List says {period:g} s")
        if out:
            flags[oid] = out
    return flags


def changes(prev: dict[str, dict], cur: dict[str, dict], today: str) -> tuple[dict, list, int]:
    """Changed aids by objectid; removed aids (by name); count of new aids."""
    by_llnr_prev = {(v["lightlistnumber"], v["aidname"]): v for v in prev.values()}
    out, added = {}, 0
    for oid, a in cur.items():
        p = prev.get(oid) or by_llnr_prev.get((a["lightlistnumber"], a["aidname"]))
        if not p:
            added += 1
            out[oid] = {"date": today, "text": "New in the Light List this week"}
            continue
        notes = []
        d = meters(p["latitude"], p["longitude"], a["latitude"], a["longitude"])
        if d > POS_FLAG_M:
            notes.append(f"moved {round(d)} m")
        if (p["characteristics"] or "") != (a["characteristics"] or ""):
            notes.append(f"light changed from \"{p['characteristics'] or 'unlit'}\" to \"{a['characteristics'] or 'unlit'}\"")
        if notes:
            out[oid] = {"date": today, "text": "Light List change this week: " + "; ".join(notes)}
    cur_keys = {(v["lightlistnumber"], v["aidname"]) for v in cur.values()}
    removed = [{"name": v["aidname"], "llnr": v["lightlistnumber"], "date": today} for oid, v in prev.items()
               if oid not in cur and (v["lightlistnumber"], v["aidname"]) not in cur_keys]
    return out, removed, added


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--prev", type=Path, default=None, help="folder with last week's aids-D*.json")
    ap.add_argument("--districts", default="")
    ap.add_argument("--no-chart", action="store_true")
    args = ap.parse_args()
    wanted = {int(x) for x in args.districts.split(",") if x.strip()} or set(DISTRICTS)
    districts = {d["id"]: d for d in json.loads((DATA / "districts.json").read_text("utf-8"))}
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    stop = []
    for did in sorted(wanted):
        cur = load(DATA / f"aids-D{did}.json")
        path = DATA / f"aid-checks-D{did}.json"
        old = json.loads(path.read_text("utf-8")) if path.exists() else {}
        result = {"built_at": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"), "chart": old.get("chart", {}),
                  "changes": {}, "removed": [], "summary": {}}
        if not args.no_chart:
            lights = enc_lights(districts[did]["bounds"])
            if lights:
                result["chart"] = chart_flags(cur, lights)
            result["summary"]["charted_lights"] = len(lights)
        cutoff = (now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
        kept = {k: v for k, v in (old.get("changes") or {}).items() if v["date"] >= cutoff and k in cur}
        removed_old = [r for r in old.get("removed") or [] if r["date"] >= cutoff]
        if args.prev and (args.prev / f"aids-D{did}.json").exists():
            prev = load(args.prev / f"aids-D{did}.json")
            new, removed, added = changes(prev, cur, today)
            if prev and len(removed) > MAX_LOSS * len(prev):
                stop.append(f"D{did}: {len(removed)} of {len(prev)} aids disappeared at once")
            kept.update(new)
            removed_old = removed + removed_old
            result["summary"].update({"changed": len(new) - added, "added": added, "removed": len(removed)})
        result["changes"], result["removed"] = kept, removed_old[:500]
        result["summary"]["chart_flags"] = len(result["chart"])
        path.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), "utf-8")
        print(f"D{did:02d}: {result['summary']}", flush=True)
    if stop:
        print("STOP: " + "; ".join(stop) + " - check the NAVCEN download before publishing.")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
