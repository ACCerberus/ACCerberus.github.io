#!/usr/bin/env python3
"""Stamp a LightKeeper web version everywhere it appears, so browsers and the CDN fetch the new build.

  python tools/set_version.py 2.0.7

Updates lightkeeper/version.json, the page title / brand / data-version, every ES-module import
(`from './x.js?v=…'`) so no module can be served from an older cache, the CSS links, the service
worker cache name, the API version constant and the version shown on the landing and about pages.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "lightkeeper"
SEMVER = re.compile(r"\d+\.\d+\.\d+")
# import specifiers of local modules: './x.js', '../x.js', './web/x.js' with or without an old ?v=
IMPORT_RE = re.compile(r"""((?:from\s+|import\s*\(\s*)['"])(\.{1,2}/[\w./-]+?\.js)(?:\?v=[\w.]+)?(['"])""")


def sub_file(path: Path, pairs: list[tuple[re.Pattern[str] | str, str]]) -> None:
    text = path.read_text("utf-8")
    new = text
    for pattern, repl in pairs:
        new = re.sub(pattern, repl, new) if isinstance(pattern, re.Pattern) else new.replace(pattern, repl)
    if new != text:
        path.write_text(new, "utf-8", newline="\n")
        print(f"  {path.relative_to(ROOT)}")


def main() -> int:
    if len(sys.argv) != 2 or not SEMVER.fullmatch(sys.argv[1]):
        print(__doc__)
        return 2
    v = sys.argv[1]
    (APP / "version.json").write_text('{"version":"%s"}\n' % v, "utf-8", newline="\n")
    for js in sorted((APP / "js").rglob("*.js")):
        sub_file(js, [(IMPORT_RE, rf"\g<1>\g<2>?v={v}\g<3>")])
    sub_file(APP / "js" / "api.js", [(re.compile(r"export const VERSION = '[\d.]+';"), f"export const VERSION = '{v}';")])
    sub_file(APP / "index.html", [
        (re.compile(r"<title>LightKeeper [\d.]+</title>"), f"<title>LightKeeper {v}</title>"),
        (re.compile(r'data-version="[\d.]+"'), f'data-version="{v}"'),
        (re.compile(r">v[\d.]+ web</span>"), f">v{v} web</span>"),
        (re.compile(r'\.(css|js)\?v=[\d.]+\\?"'), rf'.\g<1>?v={v}"'),
    ])
    sub_file(APP / "sw.js", [(re.compile(r"const VERSION = 'lk-[\d.]+';"), f"const VERSION = 'lk-{v}';")])
    for page in (ROOT / "index.html", APP / "about.html"):
        sub_file(page, [(re.compile(r"LightKeeper v[\d.]+ "), f"LightKeeper v{v} "),
                        (re.compile(r"LightKeeper [\d.]+ · by"), f"LightKeeper {v} · by")])
    print(f"version set to {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
