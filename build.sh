#!/usr/bin/env bash
# Reforge build: assemble the distributable single-file app from src/ modules.
# Usage: bash build.sh            -> index.html (repo root, served by GitHub Pages)
#        bash build.sh --canvas   -> also CANVAS.md (frontmatter + app)
# Pure concatenation: no transformation, no minification.
set -euo pipefail
cd "$(dirname "$0")"

# head (opens <script>) + 16 JS modules in order + tail (no trailing newline)
{
  cat src/head.html
  for m in src/[0-9][0-9]-*.js; do cat "$m"; done
  printf '%s' "$(cat src/tail.html)"
} > index.html

# awk-trim possible trailing newline so index.html == orig byte-for-byte
awk 'NR>1{print prev} {prev=$0} END{printf "%s", prev}' index.html > index.html.tmp && mv index.html.tmp index.html

if [[ "${1:-}" == "--canvas" ]]; then
  { cat src/frontmatter.txt; printf '\n'; cat index.html; } > CANVAS.md
  echo "Built: CANVAS.md"
fi

echo "Built: index.html ($(wc -c < index.html) bytes)"
