#!/bin/bash
# Swap which site variant is live at the repo root.
# Usage: ./switch-site.sh gamekey     (or)     ./switch-site.sh anticheat
#
# Both full site variants live permanently in site-<name>/ folders.
# This script clears everything at the root EXCEPT .git, the site-*
# folders, and this script itself, then copies the chosen variant's
# files into the root. Cloudflare (or GitHub Pages) always serves
# whatever is currently sitting at the root, so after this runs +
# you commit + push, the swap goes live.
set -euo pipefail
shopt -s dotglob nullglob

TARGET="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

if [ -z "$TARGET" ] || [ ! -d "site-$TARGET" ]; then
  echo "Usage: $0 <site-name>"
  echo "Available site variants:"
  for d in site-*/; do
    [ -d "$d" ] && echo "  - ${d%/}" | sed 's/site-//'
  done
  exit 1
fi

VARIANT_DIR="site-$TARGET"

echo "Switching live site to: $TARGET"

# Remove everything at root except .git, all site-* folders, and this script.
for item in *; do
  case "$item" in
    .git|site-*|switch-site.sh|switch-site.ps1) continue ;;
  esac
  rm -rf -- "$item"
done

# Copy the chosen variant's contents into the root (dotglob is on, so
# hidden folders like .github and .well-known are included).
cp -r "$VARIANT_DIR"/* .

echo "Done. Root now serves the '$TARGET' site."
echo "Review with: git status"
echo "Then commit + push to deploy:"
echo "  git add -A && git commit -m \"switch: $TARGET\" && git push"
