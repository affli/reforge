#!/usr/bin/env bash
# Reforge build: assemble the analyzer single-file app from src/ modules.
# Usage: bash build.sh            -> reforge.html (the analyzer, linked from the landing)
#        bash build.sh --canvas   -> also CANVAS.md (frontmatter + app)
# index.html (landing page) is NOT built: edit it directly.
# Pure concatenation: no transformation, no minification.
set -euo pipefail
cd "$(dirname "$0")"

# head (opens <script>) + 16 JS modules in order + tail (no trailing newline)
{
  cat src/head.html
  for m in src/[0-9][0-9]-*.js; do cat "$m"; done
  printf '%s' "$(cat src/tail.html)"
} > reforge.html

# awk-trim possible trailing newline so reforge.html == validated version byte-for-byte
awk 'NR>1{print prev} {prev=$0} END{printf "%s", prev}' reforge.html > reforge.html.tmp && mv reforge.html.tmp reforge.html

if [[ "${1:-}" == "--canvas" ]]; then
  { cat src/frontmatter.txt; printf '\n'; cat reforge.html; } > CANVAS.md
  echo "Built: CANVAS.md"
fi

echo "Built: reforge.html ($(wc -c < reforge.html) bytes)"
