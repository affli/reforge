# Reforge Legacy Analyzer

> **AI-powered mainframe modernization tool** — analyze JCL & COBOL, visualize system maps, trace data lineage, and translate to Python. 100% browser-based, no installation required.

![Reforge v2.0](https://img.shields.io/badge/Reforge-v2.0-blue?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzRmOGZmZiIgZD0iTTEyIDJMMiA3bDEwIDUgMTAtNXoiLz48L3N2Zz4=)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![No install](https://img.shields.io/badge/no%20install-100%25%20browser-success?style=flat-square)

---

## What is Reforge?

European banks, insurers, and utilities run millions of lines of COBOL and JCL written in the 80s and 90s. These systems process salaries, payments, and transactions — every day, without fail. The problem: nobody fully understands them anymore. The developers who wrote them are retired. Documentation doesn't exist. And every migration costs millions.

**Reforge** makes that invisible system visible — in seconds.

Upload your JCL and COBOL files, and Reforge instantly:
- Maps every job, step, program, and dataset and their relationships
- Detects DB2 SQL statements and traces data to/from tables
- Resolves VSAM file operations
- Parses copybooks and shows field hierarchies
- Runs impact analysis on any entity
- Translates COBOL to Python via AI

---

## Live Demo

**[reforge.affli.github.io](https://affli.github.io/reforge)** — free, no account required

---

## Features

### Core Analysis
| Feature | Description |
|---|---|
| **JCL Parser** | Jobs, steps, DD statements, PROCs, OPC/TWS format, EBCDIC, Latin-1 |
| **COBOL Parser** | All 4 DIVISIONS, SELECT/FD, Working-Storage levels, paragraphs, PERFORM/CALL/GOTO |
| **Auto-detection** | Language detection per file — JCL, COBOL, copybook, mixed uploads |
| **Formats** | `.JCL` `.CBL` `.CPY` `.P01` `.P04` `.TXT` `.BAT` + EBCDIC binary |

### V2 — Advanced Intelligence
| Tab | What it does |
|---|---|
| **System Map** | Interactive graph with zoom/pan — all nodes, all edges, all relationships |
| **Copybooks** | Parses `.CPY` files, resolves COPY statements, shows field hierarchy |
| **DB2 / SQL** | Extracts `EXEC SQL...END-EXEC` blocks, maps tables → programs |
| **Data Lineage** | Traces data flows: DB2 column → host variable → VSAM → program |
| **Impact** | Select any entity → see what depends on it (direct + indirect) |
| **✦ AI Explain** | Ask Claude questions about your system in plain English |
| **⚡ Python** | Translate COBOL programs to Python 3 (AI or offline skeleton) |

### Export
- **SVG** — System map as scalable vector graphic
- **JSON** — Full model (nodes + edges) for downstream tooling
- **CSV** — Nodes and edges as spreadsheet-ready tables

---

## How to Use

### 1. Upload your files
Drop any mix of JCL, COBOL, and copybook files onto the upload zone. No sorting required — Reforge auto-detects the language of each file, including binary EBCDIC.

### 2. Click Analyze
Reforge parses everything in the browser — no data leaves your machine.

### 3. Explore
- **System Map** — navigate your system visually. Use filters (Jobs / Steps / Programs / Data) to focus.
- **Copybooks** — see which programs use which copybooks, and all field definitions.
- **DB2** — see which tables are read and written by which programs.
- **Data Lineage** — click any entity to trace its data flows.
- **Impact** — select a copybook, table, or program → see what breaks if it changes.

### 4. Translate to Python (optional)
Go to **⚡ Python** tab → add your [Anthropic API key](https://console.anthropic.com) → select a COBOL file → click **Translate with AI**.

No API key? Use **Offline Skeleton** for a structural Python skeleton (dataclasses, functions per paragraph) generated locally.

### 5. Ask AI (optional)
Go to **✦ AI** tab → ask any question about your system:
- *"What does this system do?"*
- *"Which programs update DB2 tables?"*
- *"What would break if I change the CUSTOMER-REC copybook?"*

---

## Test Files

A complete test suite is included in `/test-files/`:

```
PAYJOB.JCL          — JCL job with 2 steps
PAYMENT.CBL         — COBOL with DB2 SQL + VSAM + 2 COPY statements
CUSTOMER.CBL        — COBOL with DB2 SQL + VSAM
PAYMENT-REC.CPY     — Copybook (7 fields)
CUSTOMER-REC.CPY    — Copybook with nested hierarchy
ERRORCODES.CPY      — Shared error codes copybook
```

Upload all 6 files together and click **Analyze** to see everything working.

---

## Deploy on GitHub Pages

1. Fork this repo
2. Rename `legacy-analyzer.html` → `index.html`
3. Go to **Settings → Pages → Branch: main** → Save
4. Your URL: `https://yourusername.github.io/reforge`

---

## Architecture

Single self-contained HTML file (~135KB). No dependencies, no build step, no server.

```
legacy-analyzer.html
├── Parsers
│   ├── parseJCL()          — JCL v3 parser (OPC, continuations, EBCDIC)
│   ├── parseCOBOL()        — COBOL parser (4 divisions, full hierarchy)
│   ├── parseCOBOLV2()      — Extended: + SQL + VSAM + parent enrichment
│   └── parseCopybook()     — Copybook field hierarchy parser
├── Model
│   ├── buildSystemModel()  — Core graph (nodes + edges)
│   └── buildSystemModelV2()— V2 graph (+ copybooks, DB2, VSAM nodes)
├── Analysis
│   ├── buildLineageV2()    — Data lineage graph
│   ├── computeImpact()     — BFS impact analysis
│   └── resolveCopybooks()  — Cross-file COPY resolution
├── AI
│   ├── translateCobolToPython()  — Claude API translation
│   ├── cobolToPythonFallback()   — Offline Python skeleton
│   └── aiExplain()               — System-level Q&A
└── UI
    ├── renderSystemMap()   — SVG graph with zoom/pan
    ├── renderCopybooksTab() — Copybook viewer
    ├── renderDB2Tab()      — DB2 table viewer
    ├── renderLineageTab()  — Data lineage viewer
    ├── renderImpactTab()   — Impact analysis UI
    └── renderAITab()       — AI explain interface
```

---

## Who is this for?

- **DSI / Architects** at banks, insurers, utilities running mainframe systems
- **Integration partners** (Capgemini, Accenture, CGI) delivering modernization projects
- **Developers** onboarding to legacy codebases

---

## Roadmap

- [ ] Oracle DB connector — link SQL SELECT to table schemas
- [ ] PL/I and REXX support
- [ ] PDF export
- [ ] Session save/restore (localStorage)
- [ ] On-premise deployment package

---

## Contact

Built by **Adrien** — [adrien@vyniad.be](mailto:adrien@vyniad.be)

> *"A consultant mainframe day costs €1,500. Reforge does it in 30 seconds."*

---

## License

MIT — free to use, fork, and build on.
