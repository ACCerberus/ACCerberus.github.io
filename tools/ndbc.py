"""NOAA National Data Buoy Center: the latest reading of every reporting buoy and coastal station, one small file.

    https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt   (~100 KB, refreshed by NOAA every few minutes)

Used to fill gaps on aid cards: water temperature where USGS / NOAA tide stations have none (Great Lakes, open
coast) and air temperature / wind where the National Weather Service has no recent station report.
The website gets the same data from lightkeeper/data/ndbc-latest.json, published hourly by its GitHub job
(tools/build_ndbc.py there uses parse() from a copy of this file).
"""

from __future__ import annotations

import calendar
import logging
import threading
import time
import urllib.request

log = logging.getLogger("lightkeeper")

LATEST_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt"
CACHE_SEC = 15 * 60
TIMEOUT = 12
MAX_AGE_HOURS = 6            # older readings are ignored
_COLS = ("id", "lat", "lon", "yyyy", "mm", "dd", "hh", "mi", "wdir", "wspd", "gst", "wvht", "dpd", "apd", "mwd",
         "pres", "ptdy", "atmp", "wtmp", "dewp", "vis", "tide")
_COMPASS = ("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW")
_state: dict = {"at": 0.0, "items": []}
_lock = threading.Lock()


def _num(v: str) -> float | None:
    try:
        return None if v in ("MM", "") else float(v)
    except ValueError:
        return None


def parse(text: str) -> list[dict]:
    """latest_obs.txt -> [{id, lat, lon, time, water_c, air_c, wind_kt, gust_kt, wind_deg}] (missing values None)."""
    out = []
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < len(_COLS):
            continue
        row = dict(zip(_COLS, parts))
        lat, lon = _num(row["lat"]), _num(row["lon"])
        if lat is None or lon is None:
            continue
        wspd, gst = _num(row["wspd"]), _num(row["gst"])
        out.append({
            "id": row["id"], "lat": lat, "lon": lon,
            "time": f"{row['yyyy']}-{row['mm']}-{row['dd']}T{row['hh']}:{row['mi']}:00Z",
            "water_c": _num(row["wtmp"]), "air_c": _num(row["atmp"]),
            "wind_kt": round(wspd * 1.94384, 1) if wspd is not None else None,
            "gust_kt": round(gst * 1.94384, 1) if gst is not None else None,
            "wind_deg": _num(row["wdir"]),
        })
    return out


def stations(user_agent: str = "LightKeeper") -> list[dict]:
    """All current readings, cached 15 minutes; [] when NOAA can't be reached."""
    with _lock:
        if _state["items"] and time.time() - _state["at"] < CACHE_SEC:
            return _state["items"]
    try:
        req = urllib.request.Request(LATEST_URL, headers={"User-Agent": user_agent})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            items = parse(resp.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 - optional source
        log.warning("NDBC latest observations unavailable: %s", e)
        with _lock:
            return _state["items"]
    with _lock:
        _state.update(at=time.time(), items=items)
    return items


def _fresh(s: dict) -> bool:
    try:
        when = calendar.timegm(time.strptime(s["time"], "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        return False
    return time.time() - when <= MAX_AGE_HOURS * 3600


def nearest(lat: float, lon: float, field: str, max_mi: float, distance) -> dict | None:
    """The closest fresh station that has ``field`` (water_c / air_c / wind_kt), within max_mi, with distance_mi."""
    best, best_mi = None, max_mi
    for s in stations():
        if s.get(field) is None or not _fresh(s):
            continue
        mi = distance(lat, lon, s["lat"], s["lon"])
        if mi <= best_mi:
            best, best_mi = s, mi
    return {**best, "distance_mi": round(best_mi, 1)} if best else None


def compass(deg: float | None) -> str | None:
    return None if deg is None else _COMPASS[int((deg + 11.25) // 22.5) % 16]
