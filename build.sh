#!/usr/bin/env bash
# Reforge build: assemble the distributable single-file app from src/ modules.
# Usage: bash build.sh            -> dist/reforge.html + dist/index.html
#        bash build.sh --canvas   -> also dist/CANVAS.md (frontmatter + app)
# Pure concatenation: no transformation, no minification.
set -euo pipefail
cd "$(dirname "$0")"

OUT=dist/reforge.html
mkdir -p dist

# head (opens <script>) + 16 JS modules in order + tail (no trailing newline)
{
  cat src/head.html
  for m in src/[0-9][0-9]-*.js; do cat "$m"; done
  printf '%s' "$(cat src/tail.html)"
} > "$OUT"

# GitHub Pages entry point (identical content)
cp "$OUT" dist/index.html

# awk-trim possible trailing newline so dist == original byte-for-byte
awk 'NR>1{print prev} {prev=$0} END{printf "%s", prev}' "$OUT" > "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
cp "$OUT" dist/index.html

if [[ "${1:-}" == "--canvas" ]]; then
  { cat src/frontmatter.txt; printf '\n'; cat "$OUT"; } > dist/CANVAS.md
  echo "Built: dist/CANVAS.md"
fi

echo "Built: $OUT ($(wc -c < "$OUT") bytes) + dist/index.html"
