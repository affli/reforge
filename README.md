# Reforge — multi-module sources

Single-file offline app (JCL/COBOL analyzer), split into modules + pure-concatenation build.

## Structure

- `orig/original.html` — reference copy of the validated version. **Never edit.**
- `src/` — the only place to edit:
  - `frontmatter.txt` (canvas header), `head.html` (HTML/CSS + `<script>` open), `tail.html` (close tags)
  - `01-nav-state.js` … `16-wiring.js` — JS modules, **order matters** (top-level `const` is not hoisted)
- `index.html` — build output at repo root (**never edit**): the single-file app served by GitHub Pages

## Build

```bash
bash build.sh            # index.html (repo root, GitHub Pages entry point)
bash build.sh --canvas   # + CANVAS.md (frontmatter + app, for the Vibe canvas)
```

## Rules

1. Edit only `src/`, never `orig/` or `index.html`.
2. After each change: rebuild, then run tests (`index.html?selftest` in a browser, or the `new Function` harness). Expected green: 23 self-tests + 229 V2 tests.
3. Do not reorder modules.
4. The deliverable stays a single file: the build is a byte-exact concatenation (verified against `orig/original.html`).

## GitHub Pages

Served from the `develop` branch, repo root. Tests: `https://affli.github.io/reforge/?selftest`.
