#!/usr/bin/env python3
"""USCG aid discrepancies and temporary changes -> lightkeeper/data/aton-notices-D<id>.json, so an aid card can say
"Extinguished (reported Oct 30)" even when no Broadcast Notice went out.

  python tools/aton_notices.py

Source: the Coast Guard's public "Aids to Navigation Notices" map layer (USCG GIS, keyless): federal and private aid
discrepancies and temporary changes, the same records the weekly Local Notice to Mariners prints. Each record is
matched to a Light List aid by district + Light List number, and checked by position (within MATCH_MI). Runs with the
hourly notices job. Not for navigation.

Output per district: {"fetched_at", "items": {"<objectid>": [{"kind", "status", "since", "bnm", "name"}]}, "unmatched": n}
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
BASE = "https://services9.arcgis.com/Fr5UUTVwNRJlXAkf/arcgis/rest/services/Aids_to_Navigation_Notices_-_Public/FeatureServer"
LAYERS = {0: "discrepancy", 1: "discrepancy", 3: "temporary change"}   # federal, private discrepancies; temporary changes
UA = "LightKeeper data build (cerberusac.dev/lightkeeper)"
DISTRICTS = (1, 5, 7, 8, 9, 11, 13, 14, 17)
MATCH_MI = 0.5
STATUS_WORDS = {   # the layer's short codes, in plain words
    "EXT": "Extinguished", "EXTINGUISHED": "Extinguished", "STRUCT DEST": "Structure destroyed", "DESTROYED": "Destroyed",
    "MISSING": "Missing", "OFF STA": "Off station", "OFF STATION": "Off station", "SUBMERGED": "Submerged",
    "DAYMK MISS": "Daymark missing", "DAYMARK MISSING": "Daymark missing", "DAYMK DMGD": "Daymark damaged",
    "DMGD": "Damaged", "DAMAGED": "Damaged", "LT IMPR CHAR": "Light showing improper characteristic",
    "IMPR CHAR": "Improper characteristic", "SIG INOP": "Sound signal inoperative", "SOUND INOP": "Sound signal inoperative",
    "RACON INOP": "Racon inoperative", "DIM": "Light dim", "LT DIM": "Light dim", "LEANING": "Leaning", "TEMP": "Temporary",
    "DISCONTINUED": "Discontinued", "RELOCATED": "Relocated", "ESTABLISHED": "Temporarily established", "CHANGED": "Changed",
}


def fetch(layer: int) -> list[dict]:
    feats, offset = [], 0
    while True:
        q = {"where": "1=1", "outFields": "*", "f": "json", "resultOffset": offset, "resultRecordCount": 2000, "returnGeometry": "false"}
        req = urllib.request.Request(f"{BASE}/{layer}/query?{urllib.parse.urlencode(q)}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as resp:
            d = json.loads(resp.read())
        if "error" in d:
            raise RuntimeError(d["error"])
        page = [f["attributes"] for f in d.get("features") or []]
        feats.extend(page)
        if not d.get("exceededTransferLimit") or not page:
            return feats
        offset += len(page)
        time.sleep(0.3)


def dms(text: str) -> float | None:
    """'091-56-04.167W' -> -91.934."""
    m = re.match(r"\s*(\d+)-(\d+)-([\d.]+)\s*([NSEW])", str(text or ""))
    if not m:
        return None
    v = int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3)) / 3600
    return -v if m.group(4) in "SW" else v


PARTS = {   # pieces of combined codes like "STRUCT DEST/TRUB"
    "LT EXT": "light extinguished", "EXT": "extinguished", "STRUCT DEST": "structure destroyed", "STRUCT DMGD": "structure damaged",
    "STRUCT MISSING": "structure missing", "TRUB": "temporarily replaced by an unlighted buoy",
    "TRLB": "temporarily replaced by a lighted buoy", "HAZ NAV": "hazard to navigation", "LT IMCH": "light showing improper characteristic",
    "IMCH": "improper characteristic", "DAYMK MISSING": "daymark missing", "DAYMK MISS": "daymark missing", "DAYMK DMGD": "daymark damaged",
    "DAYMK IMCH": "daymark improper", "DBD DEST": "dayboard destroyed", "DBD MISSING": "dayboard missing", "DBD DMGD": "dayboard damaged",
    "OFF STA": "off station", "OFF STATION": "off station", "MISSING": "missing", "SUBMERGED": "submerged", "LEANING": "leaning",
    "DMGD": "damaged", "DIM": "light dim", "LT DIM": "light dim", "SIG INOP": "sound signal inoperative", "SND INOP": "sound signal inoperative",
    "RACON INOP": "racon inoperative", "AIS INOP": "AIS inoperative", "STRUCTURE DESTROYED": "structure destroyed",
    "DAYMARK DAMAGED": "daymark damaged", "DAYMARK MISSING": "daymark missing", "WATCHING PROPERLY": "",
    "REDUCED INT": "light at reduced intensity", "TRSAIS": "temporarily replaced by a synthetic AIS aid", "BUOY DMGD": "buoy damaged",
    "SINKING": "sinking", "BUOY MISSING": "buoy missing", "RRLB": "replaced by a lighted buoy", "RRUB": "replaced by an unlighted buoy",
}


def plain(status: str) -> str:
    s = (status or "").strip().upper()
    if not s or "UNREPORTED" in s:
        return ""
    if s in STATUS_WORDS:
        return STATUS_WORDS[s]
    parts = [PARTS.get(p.strip(), p.strip().lower()) for p in s.split("/")]
    text = ", ".join(p for p in parts if p)
    return text[:1].upper() + text[1:]


def llnr_key(v) -> str:
    try:
        f = float(str(v).strip())
        return str(int(f)) if f == int(f) else str(f)
    except ValueError:
        return str(v or "").strip().upper()


def miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 7917.6 * math.asin(math.sqrt(a))


def load_aids(did: int) -> dict[str, list[dict]]:
    t = json.loads((DATA / f"aids-D{did}.json").read_text("utf-8"))
    f = t["fields"]
    ix = {k: f.index(k) for k in ("objectid", "lightlistnumber", "latitude", "longitude", "aidname")}
    by_llnr: dict[str, list[dict]] = {}
    for r in t["rows"]:
        by_llnr.setdefault(llnr_key(r[ix["lightlistnumber"]]), []).append(
            {"id": r[ix["objectid"]], "lat": r[ix["latitude"]], "lon": r[ix["longitude"]], "name": r[ix["aidname"]]})
    return by_llnr


def main() -> int:
    records = []
    for layer, kind in LAYERS.items():
        try:
            rows = fetch(layer)
        except Exception as exc:  # noqa: BLE001
            print(f"layer {layer}: FAILED ({exc}); keeping the previous files")
            return 1
        for r in rows:
            r["_kind"] = kind
        records.extend(rows)
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    for did in DISTRICTS:
        aids = load_aids(did)
        items: dict[str, list[dict]] = {}
        unmatched = 0
        for r in (r for r in records if int(r.get("ATU") or 0) == did):
            status = plain(r.get("DISCREP_STATUS") or r.get("TC_STATUS") or "")
            if not status:
                continue
            lat, lon = dms(r.get("ASSIGNED_LATITUDE")), dms(r.get("ASSIGNED_LONGITUDE"))
            cands = aids.get(llnr_key(r.get("LLNR")), [])
            if lat is not None and lon is not None:
                cands = [a for a in cands if miles(lat, lon, a["lat"], a["lon"]) <= MATCH_MI]
            if len(cands) != 1:
                unmatched += 1
                continue
            since = datetime.fromtimestamp((r.get("DATE_CREATED") or 0) / 1000, timezone.utc).strftime("%Y-%m-%d") if r.get("DATE_CREATED") else ""
            items.setdefault(str(cands[0]["id"]), []).append(
                {"kind": r["_kind"], "status": status, "since": since, "bnm": r.get("BNM_NUM") or "", "name": r.get("NAME") or ""})
        out = {"fetched_at": now, "source": BASE, "items": items, "unmatched": unmatched}
        (DATA / f"aton-notices-D{did}.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), "utf-8")
        print(f"D{did:02d}: {sum(len(v) for v in items.values())} notices on {len(items)} aids, {unmatched} not matched to an aid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
