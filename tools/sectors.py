"""Which USCG sector an aid is in, from the official sector areas (lightkeeper/data/uscg_sectors.json,
built by tools/build_sectors.py). Shared by tools/build_aids.py; the desktop app has the same code in sectors.py."""

from __future__ import annotations

import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "lightkeeper" / "data"
NEAR_DEG = 0.05      # an aid just outside every area (a pier light on the shoreline) takes a sector this close


def _in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class Sectors:
    def __init__(self, path: Path = DATA / "uscg_sectors.json") -> None:
        self.items = []
        if not path.exists():
            return
        for s in json.loads(path.read_text("utf-8"))["sectors"]:
            polys = []
            for poly in s["polys"]:
                xs = [p[0] for p in poly[0]]
                ys = [p[1] for p in poly[0]]
                polys.append((min(xs), min(ys), max(xs), max(ys), poly))
            self.items.append((s["code"], polys))

    def _hit(self, lon: float, lat: float) -> str:
        for code, polys in self.items:
            for w, s, e, n, poly in polys:
                if w <= lon <= e and s <= lat <= n and _in_ring(lon, lat, poly[0]) and not any(_in_ring(lon, lat, h) for h in poly[1:]):
                    return code
        return ""

    def code_at(self, lat: float, lon: float) -> str:
        """The sector code (Light List GROUP_JURISDICTION style) at a point, or "" outside every area."""
        if not self.items:
            return ""
        for dlon in (0.0, 360.0, -360.0):            # areas that cross the date line may use lon > 180 or < -180
            code = self._hit(lon + dlon, lat)
            if code:
                return code
        for dy, dx in ((NEAR_DEG, 0), (-NEAR_DEG, 0), (0, NEAR_DEG), (0, -NEAR_DEG)):
            code = self._hit(lon + dx, lat + dy)
            if code:
                return code
        return ""
