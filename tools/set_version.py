#!/usr/bin/env python3
"""Stamp a LightKeeper web version everywhere it appears, so browsers and the CDN fetch the new build.

  python tools/set_version.py 2.0.7          # a new version
  python tools/set_version.py 2.0.7 2        # same version, rebuilt: cache token "2.0.7-2"

Updates lightkeeper/version.json (the cache token browsers compare), every ES-module import
(`from './x.js?v=<token>'`) so no module can come from an older cache, the CSS links, the service
worker cache name, the API version constant and the version shown on the landing and about pages.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "lightkeeper"
SEMVER = re.compile(r"\d+\.\d+\.\d+[a-z]?")   # 2.0.9 or a lettered fix build like 2.0.9c
# Local module specifiers: './x.js', '../x.js', './web/x.js', with or without an old ?v= token.
IMPORT_RE = re.compile(r"""((?:from\s+|import\s*\(\s*)['"])(\.{1,2}/[\w./-]+?\.js)(?:\?v=[\w.-]+)?(['"])""")


def sub_file(path: Path, pairs: list[tuple[re.Pattern[str], str]]) -> None:
    text = path.read_text("utf-8")
    new = text
    for pattern, repl in pairs:
        new = pattern.sub(repl, new)
    if new != text:
        path.write_text(new, "utf-8", newline="\n")
        print(f"  {path.relative_to(ROOT)}")


def main() -> int:
    args = sys.argv[1:]
    if len(args) not in (1, 2) or not SEMVER.fullmatch(args[0]) or (len(args) == 2 and not args[1].isdigit()):
        print(__doc__)
        return 2
    v = args[0]
    # The token changes on every deploy that must reach browsers, even when the shown version does not.
    token = f"{v}-{args[1]}" if len(args) == 2 else v
    (APP / "version.json").write_text('{"version":"%s"}\n' % token, "utf-8", newline="\n")
    for js in sorted((APP / "js").rglob("*.js")):
        sub_file(js, [(IMPORT_RE, rf"\g<1>\g<2>?v={token}\g<3>")])
    sub_file(APP / "js" / "api.js", [(re.compile(r"export const VERSION = '[\d.]+[a-z]?';"), f"export const VERSION = '{v}';")])
    sub_file(APP / "index.html", [
        (re.compile(r"<title>LightKeeper [\d.]+[a-z]?</title>"), f"<title>LightKeeper {v}</title>"),
        (re.compile(r'data-version="[\d.]+[a-z]?"'), f'data-version="{v}"'),
        (re.compile(r">v[\d.]+[a-z]? web</span>"), f">v{v} web</span>"),
        (re.compile(r'\.(css|js)\?v=[\w.-]+"'), rf'.\g<1>?v={token}"'),
    ])
    sub_file(APP / "sw.js", [(re.compile(r"const VERSION = 'lk-[\w.-]+';"), f"const VERSION = 'lk-{token}';")])
    for page in (ROOT / "index.html", APP / "about.html", APP / "updates.html"):
        sub_file(page, [(re.compile(r"LightKeeper v[\d.]+[a-z]? "), f"LightKeeper v{v} "),
                        (re.compile(r"LightKeeper [\d.]+[a-z]? · by"), f"LightKeeper {v} · by")])
    print(f"version set to {v} (cache token {token})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
