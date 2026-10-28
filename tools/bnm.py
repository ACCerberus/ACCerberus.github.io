"""USCG Broadcast Notices to Mariners (BNM) for aids to navigation, from the official GovDelivery RSS feeds.

    GET /api/bnm?district=13   -> {ok, district, fetched_at, items: [...]}   (any of the nine districts)

Each item: {id, number, originator, category, area, aton, text, published, dtg, cancel_at, cancels, cancels_dtg,
            llnrs, discrepancy, aid_hint, link, active}
    id           "SEC SCR BNM 0158-26" (originator + number: the BNM's own reference)
    category     SAFETY, CANCELLATION, UPDATE or SCHEDULED
    dtg          when it was broadcast, as a message date-time group (262212Z OCT 26, UTC)
    discrepancy  the tracker type found in the text (Extinguished, Missing, Off station, ...) or ""
    cancels      for a cancellation: the BNM it cancels ("SEC SCR BNM 0156-26")
    active       a SAFETY notice not yet cancelled (no cancellation seen and its CANCEL AT time not passed)

The same parser runs in the website's hourly GitHub job (tools/build_bnm.py there) to publish bnm-D13.json.
"""

from __future__ import annotations

import html
import logging
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

try:
    from flask import Blueprint, jsonify, request
except ImportError:  # the website's build job imports only the parser
    Blueprint = None  # type: ignore[assignment]

log = logging.getLogger("lightkeeper")

FEED_URL = "https://public.govdelivery.com/topics/{topic}/feed.rss"
# District -> GovDelivery topics of the offices that broadcast its BNMs (district office first, then its sectors).
# Found by reading each USDHSCG topic feed's title ("CG D08 Sector Mobile - Maritime Safety Information").
_T = lambda *n: tuple(f"USDHSCG_{x}" for x in n)  # noqa: E731
FEEDS = {
    1: _T(376, 377, 378, 379, 380, 381),          # Northeast: Boston, Long Island Sound, New York, N. New England, SE New England
    5: _T(250, 246, 247, 248, 249),               # East: Maryland-NCR, Virginia, Delaware Bay, North Carolina
    7: _T(422, 423, 424, 425, 426, 427, 428),     # Southeast: Charleston, Jacksonville, Miami, San Juan, Key West, St. Petersburg
    8: _T(414, 415, 416, 417, 418, 419, 420, 421),  # Heartland: UMR, LMR, Ohio Valley, Mobile, New Orleans, Houston, Corpus
    9: _T(430, 431, 432, 433, 523),               # Great Lakes: Eastern GL, Detroit, Northern GL, Lake Michigan
    11: _T(435, 436, 437, 438, 439),              # Southwest: San Diego, LA/Long Beach, San Francisco, Humboldt Bay
    13: _T(393, 394, 395, 396),                   # Northwest: Columbia River, North Bend, Puget Sound
    14: _T(440, 441, 442),                        # Oceania: Honolulu, Guam
    17: _T(443, 444, 445),                        # Arctic: Southeast Alaska, Western Alaska & Arctic
}
CACHE_SEC = 600
TIMEOUT = 15
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
TITLE_RE = re.compile(r"^(?P<cat>[A-Z]+)/(?:(?P<area>.*?)/)?(?:(?P<topic>[A-Z]+)/)?(?P<orig>[A-Z][A-Z0-9 .\-]*?)\s+BNM\s+(?P<num>\d{1,4}-\d{2})\s*$")   # orig: SEC SCR, CGD-NE, CCGD13
LLNR_RE = re.compile(r"\(?\bLLNR\s*[:\-#]?\s*(\d+(?:\.\d+)?)\)?", re.I)      # (LLNR 15080), (LLNR-15115)
CANCEL_AT_RE = re.compile(r"CANCEL AT\s*//\s*(\d{6}Z\s+[A-Z]{3}\s+\d{2})\s*//", re.I)
CANCELS_RE = re.compile(r"CANCEL\s+([A-Z][A-Z .]*?\s+BNM\s+\d{1,4}-\d{2})(?:\s+DTG\s+(\d{6}Z\s+[A-Z]{3}\s+\d{2}))?", re.I)
# Words in the message -> tracker discrepancy type (first match wins).
DISCREPANCY_WORDS = (
    ("EXTINGUISHED", "Extinguished"), ("IMPROPERLY CHARACTERIZED", "Improper characteristic"), ("IMCH", "Improper characteristic"),
    ("IMPROPER CHARACTERISTIC", "Improper characteristic"), ("OFF STATION", "Off station"), ("OFF-STATION", "Off station"),
    ("MISSING", "Missing"), ("OVERGROWN", "Overgrown"), ("OBSCURED", "Overgrown"), ("VANDALIZED", "Vandalized"),
    ("DESTROYED", "Damaged"), ("DAMAGED", "Damaged"), ("LEANING", "Damaged"), ("SINKING", "Damaged"), ("SUNK", "Damaged"),
    ("DECOMMISSIONED", "Decommissioned"), ("DISCONTINUED", "Discontinued"), ("RELOCATED", "Relocated"),
    ("INOPERATIVE", "Inoperative"), ("NOT OPERATING", "Inoperative"), ("MALFUNCTION", "Inoperative"),
    ("REDUCED INTENSITY", "Reduced intensity"),
)


def to_dtg(dt: datetime) -> str:
    """Message date-time group in UTC: 262212Z OCT 26."""
    u = dt.astimezone(timezone.utc)
    return f"{u.day:02d}{u.hour:02d}{u.minute:02d}Z {MONTHS[u.month - 1]} {u:%y}"


def dtg_to_datetime(dtg: str, reference: datetime) -> datetime | None:
    """Parse '022202Z NOV 26' (two-digit year) to a UTC datetime."""
    m = re.match(r"(\d{2})(\d{2})(\d{2})Z\s+([A-Z]{3})\s+(\d{2})", dtg.strip().upper())
    if not m or m.group(4) not in MONTHS:
        return None
    day, hour, minute, mon, yy = int(m.group(1)), int(m.group(2)), int(m.group(3)), MONTHS.index(m.group(4)) + 1, int(m.group(5))
    try:
        return datetime(2000 + yy, mon, day, hour, minute, tzinfo=timezone.utc)
    except ValueError:
        return None


def plain_text(description: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", description or "", flags=re.I)
    text = re.sub(r"</p>\s*<p>", "\n", text, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    text = re.sub(r"\n\s*BT\s*$", "", text.strip())
    return re.sub(r"[ \t]+", " ", re.sub(r"\n{2,}", "\n", text)).strip()


def parse_item(title: str, description: str, pub: str, link: str) -> dict | None:
    m = TITLE_RE.match((title or "").strip().upper())
    if not m:
        return None                                       # site announcements, newsletters: not a BNM
    text = plain_text(description)
    upper = text.upper()
    published = parsedate_to_datetime(pub) if pub else None
    llnrs = list(dict.fromkeys(LLNR_RE.findall(text)))
    cancels = CANCELS_RE.search(upper) if m.group("cat") == "CANCELLATION" else None
    cancel_at = CANCEL_AT_RE.search(upper)
    discrepancy = next((label for word, label in DISCREPANCY_WORDS if word in upper), "")
    hint = ""
    hm = re.search(r"(?:^|[.\n]\s*|\d\.\s*)([A-Z0-9][A-Z0-9 '&.\-]+?)\s*\(LLNR", upper)
    if not hm:      # no LLNR given: "CHETCO RIVER BRAVO BAR WARNING SIGN IS EXTINGUISHED."
        hm = re.search(r"^(?:\d\.\s*)?([A-Z0-9][A-Z0-9 '&.\-]+?)\s+(?:IS|ARE|HAS BEEN|HAVE BEEN)\s", upper)
    if hm:
        hint = re.sub(r"^(?:[A-Z]\.\s+)?(?:(?:THE|A|AN)\s+)?", "", hm.group(1).strip()).title()
    if len(hint) > 48 or re.match(r"(?i)(cg|coast guard|the coast guard)", hint):
        hint = ""        # a whole sentence ("CG RCVD A REPORT THAT ..."), not an aid name
    orig = re.sub(r"\s+", " ", m.group("orig").strip())
    return {
        "id": f"{orig} BNM {m.group('num')}", "number": m.group("num"), "originator": orig, "category": m.group("cat"),
        "area": (m.group("area") or "").strip(), "aton": (m.group("topic") or "") == "ATON" or bool(llnrs),
        "text": text, "published": published.astimezone(timezone.utc).isoformat() if published else "",
        "dtg": to_dtg(published) if published else "", "cancel_at": cancel_at.group(1) if cancel_at else "",
        "cancels": re.sub(r"\s+", " ", cancels.group(1)) if cancels else "", "cancels_dtg": cancels.group(2) if cancels and cancels.group(2) else "",
        "llnrs": llnrs, "discrepancy": discrepancy if m.group("cat") != "CANCELLATION" else "", "aid_hint": hint, "link": link or "",
    }


def parse_feed(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    out = []
    for it in root.iter("item"):
        rec = parse_item(it.findtext("title") or "", it.findtext("description") or "", it.findtext("pubDate") or "", it.findtext("link") or "")
        if rec:
            out.append(rec)
    return out


def mark_active(items: list[dict], now: datetime | None = None) -> list[dict]:
    """A SAFETY notice is active until a cancellation names it or its CANCEL AT time passes."""
    now = now or datetime.now(timezone.utc)
    cancelled = {i["cancels"] for i in items if i["category"] == "CANCELLATION" and i["cancels"]}
    for i in items:
        expires = dtg_to_datetime(i["cancel_at"], now) if i["cancel_at"] else None
        i["active"] = i["category"] in ("SAFETY", "UPDATE") and i["id"] not in cancelled and (expires is None or expires > now)
    return items


def _read_feed(topic: str, user_agent: str, tries: int = 3) -> bytes:
    """One office's feed; the feed host sometimes answers 502 for a moment, so try a few times."""
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(FEED_URL.format(topic=topic), headers={"User-Agent": user_agent})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read()
        except Exception as e:  # noqa: BLE001 - retried below
            last = e
            time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"{topic}: {last}")


def fetch_district(district: int, user_agent: str = "LightKeeper", strict: bool = False) -> list[dict]:
    """All notices of a district's offices. strict=True raises if any office's feed failed (so a publish job
    never replaces a complete file with a partial one); otherwise one failed office still returns the others."""
    items: dict[str, dict] = {}
    errors = []
    for topic in FEEDS.get(district, ()):
        try:
            for rec in parse_feed(_read_feed(topic, user_agent)):
                items.setdefault(rec["id"] + rec["category"], rec)
        except Exception as e:  # noqa: BLE001 - one office's feed down
            errors.append(str(e))
            log.warning("BNM feed %s failed: %s", topic, e)
    if errors and (strict or not items):
        raise RuntimeError("; ".join(errors))
    return sorted(mark_active(list(items.values())), key=lambda i: i["published"], reverse=True)


# ── Desktop endpoint ─────────────────────────────────────────────────────────

if Blueprint is not None:
    bp = Blueprint("bnm", __name__)
    _cache: dict[int, tuple[float, list[dict]]] = {}
    _lock = threading.Lock()

    @bp.get("/api/bnm")
    def api_bnm():
        from config import cfg
        district = int(request.args.get("district", "13") or 13)
        if district not in FEEDS:
            return jsonify({"ok": False, "district": district, "items": [],
                            "error": f"No broadcast notice feeds known for district {district}"})
        with _lock:
            hit = _cache.get(district)
        if hit and time.time() - hit[0] < CACHE_SEC and request.args.get("refresh") != "1":
            items, fetched = hit[1], hit[0]
        else:
            try:
                items = fetch_district(district, cfg.user_agent)
                fetched = time.time()
                with _lock:
                    _cache[district] = (fetched, items)
            except Exception as e:  # noqa: BLE001 - offline: last good copy, or a clear error
                if hit:
                    items, fetched = hit[1], hit[0]
                else:
                    return jsonify({"ok": False, "district": district, "items": [], "error": f"Could not reach the BNM feed: {e}"})
        return jsonify({"ok": True, "district": district, "items": items,
                        "fetched_at": datetime.fromtimestamp(fetched, timezone.utc).isoformat()})
