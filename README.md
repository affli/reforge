# Reforge — multi-module sources

Landing page (`index.html`, edited directly) + analyzer app split into modules, assembled by a pure-concatenation build.

## Structure

- `index.html` — landing page (GitHub Pages entry point). **Not built**: edit directly.
- `reforge.html` — the analyzer app, build output. **Never edit** (regenerated).
- Reference copy of the last validated build: kept in the Vibe canvas `reforge-redesign` (not in the repo).
- `src/` — the only place to edit the app:
  - `frontmatter.txt` (canvas header), `head.html` (HTML/CSS + `<script>` open), `tail.html` (close tags)
  - `01-nav-state.js` … `16-wiring.js` — JS modules, **order matters** (top-level `const` is not hoisted)

## Build

```bash
bash build.sh            # reforge.html (analyzer)
bash build.sh --canvas   # + CANVAS.md (frontmatter + app, for the Vibe canvas)
```

## Rules

1. Edit `src/` for the app, `index.html` for the landing. Never edit `orig/` or `reforge.html`.
2. After each change: rebuild, then run tests (`reforge.html?selftest` in a browser, or the `new Function` harness). Expected green: 23 self-tests + 229 V2 tests.
3. Do not reorder modules.
4. The build is a byte-exact concatenation (verified against `orig/original.html`).

## GitHub Pages

Served from the `develop` branch, repo root: `index.html` = landing, `reforge.html` = analyzer. Tests: `https://affli.github.io/reforge/reforge.html?selftest`.
