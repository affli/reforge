# Reforge — multi-module sources

Landing page (`index.html`) + offline JCL/COBOL analyzer (`reforge.html`), the analyzer split into modules with a pure-concatenation build.

## Structure

- `index.html` — landing page (hand-maintained, **not** built). CTA links to `reforge.html`.
- `orig/original.html` — reference copy of the validated analyzer version. **Never edit.**
- `src/` — the only place to edit the analyzer:
  - `frontmatter.txt` (canvas header), `head.html` (HTML/CSS + `<script>` open), `tail.html` (close tags)
  - `01-nav-state.js` … `16-wiring.js` — JS modules, **order matters** (top-level `const` is not hoisted)
- `reforge.html` — build output at repo root (**never edit**): the single-file analyzer

## Build

```bash
bash build.sh            # reforge.html (repo root)
bash build.sh --canvas   # + CANVAS.md (frontmatter + app, for the Vibe canvas)
```

## Rules

1. Edit `src/` for the analyzer, `index.html` for the landing. Never edit `orig/` or `reforge.html`.
2. After each analyzer change: rebuild, then run tests (`reforge.html?selftest` in a browser, or the `new Function` harness). Expected green: 23 self-tests + 229 V2 tests.
3. Do not reorder modules.
4. The build is a byte-exact concatenation (verified against `orig/original.html`).

## GitHub Pages

Served from the `develop` branch, repo root. Landing: `https://affli.github.io/reforge/`. Analyzer: `https://affli.github.io/reforge/reforge.html`. Tests: `https://affli.github.io/reforge/reforge.html?selftest`.
