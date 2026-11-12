# Reforge — multi-module sources

Single-file offline app (JCL/COBOL analyzer), split into modules + pure-concatenation build.

## Structure

- `orig/original.html` — reference copy of the validated version. **Never edit.**
- `src/` — the only place to edit:
  - `frontmatter.txt` (canvas header), `head.html` (HTML/CSS + `<script>` open), `tail.html` (close tags)
  - `01-nav-state.js` … `16-wiring.js` — JS modules, **order matters** (top-level `const` is not hoisted)
- `dist/` — build output, **never edit**: `reforge.html`, `index.html` (GitHub Pages entry point), optional `CANVAS.md`

## Build

```bash
bash build.sh            # dist/reforge.html + dist/index.html
bash build.sh --canvas   # + dist/CANVAS.md (frontmatter + app, for the Vibe canvas)
```

## Rules

1. Edit only `src/`, never `orig/` or `dist/`.
2. After each change: rebuild, then run tests (`dist/index.html?selftest` in a browser, or the `new Function` harness). Expected green: 23 self-tests + 229 V2 tests.
3. Do not reorder modules.
4. The deliverable stays a single file: the build is a byte-exact concatenation (verified against `orig/original.html`).

## GitHub Pages

Push `dist/index.html` (or the whole `dist/`) to the repo root / `gh-pages` branch. The app is fully offline: no server needed. Tests: open `https://<user>.github.io/<repo>/index.html?selftest`.
