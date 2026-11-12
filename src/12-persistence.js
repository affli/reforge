// Files and analysis are stored in the browser (IndexedDB),
// never sent. In-memory fallback if storage is blocked (private mode).
// Export/import: portable .json file containing only the source texts
// (re-parsed at import — robust to engine evolutions).

const SESSION_VER = 3;
const _idbName = 'reforge-db', _idbStore = 'session';
let _idb = null, _memSession = null;

function idbOpen(){
  return new Promise((res, rej) => {
    if (_idb) return res(_idb);
    try {
      const req = indexedDB.open(_idbName, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(_idbStore); } catch(e){} };
      req.onsuccess = () => { _idb = req.result; res(_idb); };
      req.onerror = () => rej(req.error || new Error('IndexedDB unavailable'));
    } catch(e){ rej(e); }
  });
}

async function saveSession(){
  const data = { v: SESSION_VER, ts: Date.now(), files: state.files, log: state.log, loaded: state.loaded, history: state.history };
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(_idbStore, 'readwrite');
      tx.objectStore(_idbStore).put(data, 'current');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    // ask the browser not to evict the data under disk pressure
    if (navigator.storage && navigator.storage.persist) { try { navigator.storage.persist(); } catch(e){} }
  } catch(e){
    _memSession = data; // private mode / blocked storage → session memory (not persisted)
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String((e && e.message) || ''))))
      document.getElementById('statusText').textContent = '⚠ Local storage FULL — this session is kept in memory only and will NOT survive a reload. Export the project (.json) to keep it.';
  }
}

async function loadSession(){
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const rq = db.transaction(_idbStore, 'readonly').objectStore(_idbStore).get('current');
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  } catch(e){ return _memSession; }
}

async function clearSession(){
  _memSession = null;
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(_idbStore, 'readwrite');
      tx.objectStore(_idbStore).delete('current');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch(e){}
}

// ── Export of analysis RESULTS (≠ project export: here we output what
// the analysis FOUND — nodes, relations, evidence, points of attention).
// A critical tool must let the data leave fast: JSON (machine),
// CSV (spreadsheet), Markdown (readable report). 100% local, no upload. ──
function resultsPayload(){
  const m = getModel();
  const byT = t => [...m.nodes.values()].filter(n=>n.type===t);
  return {
    app: 'reforge', v: SESSION_VER, exported: new Date().toISOString(),
    overview: {
      jobs: byT('job').length, steps: byT('step').length, programs: byT('prog').length,
      copybooks: byT('cpy').length, datasets: byT('ds').length, db2_tables: byT('tbl').length,
      cics_files: byT('fct').length, cics_maps: byT('map').length, cics_queues: byT('q').length,
      relations: m.edges.length,
      certain: m.edges.filter(e=>e.c==='certain').length,
      probable: m.edges.filter(e=>e.c==='probable').length,
      unknown: m.edges.filter(e=>e.c==='unknown').length
    },
    nodes: [...m.nodes.values()].map(n => ({ id: n.id, type: n.type, name: n.name, data: n.data || {} })),
    edges: m.edges.map(e => ({ from: e.f, to: e.t, relation: e.k, confidence: e.c,
      evidence: (e.ev||[]).map(x => ({ file: x.file || null, line: x.ln || null, note: x.note || '' })) })),
    warnings: m.warnings || [],
    files: state.files.map(f => ({ name: f.name, lang: f.lang, lines: (f.text || '').split('\n').length, parsed: !!f.parsed }))
  };
}

// CSV cell: doubled quotes + protection against spreadsheet
// formula injection (a DSN "=cmd(...)" must never execute in Excel).
function csvCell(v){
  v = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g,'""') + '"';
}
function resultsCSV(){
  const rows = [['From','To','Relation','Confidence','Evidence']];
  getModel().edges.forEach(e => {
    const ev = (e.ev||[]).map(x => (x.file||'?') + (x.ln ? ':' + x.ln : '') + (x.note ? ' — ' + x.note : '')).join(' | ');
    rows.push([e.f, e.t, e.k, e.c, ev]);
  });
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function resultsMD(){
  const m = getModel();
  const byT = t => [...m.nodes.values()].filter(n=>n.type===t);
  const nm = id => { const n = m.nodes.get(id); return n ? n.name : id; };
  const evs = e => (e.ev||[]).map(x => (x.file||'?') + (x.ln ? ':' + x.ln : '') + (x.note ? ' — ' + x.note : '')).join(' ; ').replace(/\|/g,'/');
  const L = [];
  L.push('# Reforge analysis report');
  L.push('');
  L.push('_Generated ' + new Date().toISOString() + '. Every relation carries its evidence (file:line) and a confidence level: certain / probable / unknown. Nothing is invented._');
  L.push('');
  L.push('## Overview');
  L.push('- Jobs: ' + byT('job').length + ' · steps: ' + byT('step').length + ' · programs: ' + byT('prog').length + ' · copybooks: ' + byT('cpy').length);
  L.push('- Datasets: ' + byT('ds').length + ' · DB2 tables: ' + byT('tbl').length + ' · CICS files/maps/queues: ' + (byT('fct').length + byT('map').length + byT('q').length));
  L.push('- Relations: ' + m.edges.length + ' (certain: ' + m.edges.filter(e=>e.c==='certain').length + ', probable: ' + m.edges.filter(e=>e.c==='probable').length + ', unknown: ' + m.edges.filter(e=>e.c==='unknown').length + ')');
  L.push('');
  L.push('## Jobs & steps');
  byT('job').forEach(j => {
    L.push('### ' + j.name);
    m.edges.filter(e => e.f === j.id && e.k === 'contains').forEach(e => {
      const s = m.nodes.get(e.t); if (!s) return;
      const exec = m.edges.find(x => x.f === s.id && x.k === 'exec');
      const dss = m.edges.filter(x => x.f === s.id && ['read','write','update','delete','unknown'].includes(x.k));
      L.push('- **' + s.name + '** → ' + (exec ? nm(exec.t) : 'no program detected')
        + (dss.length ? ' ; data: ' + dss.map(x => x.k + ' ' + nm(x.t) + ' (' + x.c + ')').join(', ') : ''));
    });
  });
  L.push('');
  L.push('## Programs');
  byT('prog').forEach(p => {
    const uses = m.edges.filter(e => e.f === p.id && e.k === 'uses');
    const sql = m.edges.filter(e => e.f === p.id && String(e.k).startsWith('sql-'));
    const calls = m.edges.filter(e => e.f === p.id && e.k === 'call');
    const paras = m.edges.filter(e => e.f === p.id && e.k === 'contains' && e.t.startsWith('para|'));
    const dcount = paras.filter(e => { const pn = m.nodes.get(e.t); return pn && pn.data && pn.data.dead; }).length;
    L.push('- **' + p.name + '** : ' + paras.length + ' paragraph(s), ' + uses.length + ' copybook(s), ' + sql.length + ' SQL table access(es), ' + calls.length + ' call(s)' + (dcount ? ' — ⚠ ' + dcount + ' unreachable paragraph(s)' : ''));
  });
  L.push('');
  L.push('## Datasets');
  byT('ds').forEach(d => {
    const rel = m.edges.filter(e => e.t === d.id && ['read','write','update','delete','unknown'].includes(e.k));
    L.push('- **' + d.name + '**' + (d.data && d.data.temp ? ' (temporary)' : '') + ' : ' + (rel.map(x => x.k + ' by ' + nm(x.f) + ' (' + x.c + ')').join(', ') || 'no usage detected'));
  });
  L.push('');
  const fcts = byT('fct'), maps = byT('map'), qs = byT('q');
  if (fcts.length || maps.length || qs.length){
    L.push('## CICS resources');
    fcts.forEach(d => L.push('- CICS file **' + d.name + '** (FCT entry, dataset unknown) : ' + m.edges.filter(e=>e.t===d.id).map(x => x.k + ' by ' + nm(x.f)).join(', ')));
    maps.forEach(d => L.push('- CICS map **' + d.name + '** : used by ' + m.edges.filter(e=>e.t===d.id).map(x => nm(x.f)).join(', ')));
    qs.forEach(d => L.push('- CICS queue **' + d.name + '**: ' + m.edges.filter(e=>e.t===d.id).map(x => x.k + ' by ' + nm(x.f)).join(', ')));
    L.push('');
  }
  L.push('## Points of attention');
  if (!(m.warnings||[]).length) L.push('- None detected.');
  else (m.warnings||[]).forEach(w => L.push('- ' + w));
  L.push('');
  L.push('## All relations (' + m.edges.length + ')');
  L.push('| From | To | Relation | Confidence | Evidence |');
  L.push('|---|---|---|---|---|');
  m.edges.forEach(e => L.push('| ' + nm(e.f) + ' | ' + nm(e.t) + ' | ' + e.k + ' | ' + e.c + ' | ' + (evs(e) || '-') + ' |'));
  L.push('');
  return L.join('\n');
}

// Express read for non-specialists: generated from the detected relations
// only (no hardcoded sentences). This is the "5 minutes" card that a
// non-expert manager can read before asking his questions.
function summaryStoryHTML(){
  const m = getModel();
  const byT = t => [...m.nodes.values()].filter(n=>n.type===t);
  const nm = id => { const n = m.nodes.get(id); return n ? n.name : id; };
  const escList = a => a.length ? a.map(x => '<b class="mono">' + esc(nm(x)) + '</b>').join(', ') : '<i>none</i>';
  const jobLines = byT('job').slice(0, 4).map(j => {
    const steps = m.edges.filter(e => e.f === j.id && e.k === 'contains').map(e => m.nodes.get(e.t)).filter(Boolean);
    const chain = steps.map(s => {
      const exec = m.edges.find(x => x.f === s.id && x.k === 'exec');
      return esc(String(s.name).split('.').slice(1).join('.') || s.name) + ' → ' + (exec ? esc(nm(exec.t)) : '<i>no program</i>');
    }).join(' · ') || '<i>no step detected</i>';
    return '<li><span class="mono" style="color:var(--text)">' + esc(j.name) + '</span> : ' + chain + '</li>';
  }).join('');
  const dsLines = byT('ds').slice(0, 8).map(d => {
    const reads = m.edges.filter(e => e.t === d.id && e.k === 'read').map(e => e.f);
    const wr = m.edges.filter(e => e.t === d.id && ['write','update'].includes(e.k)).map(e => e.f + ' (' + e.c + ')');
    return '<li><span class="mono">' + esc(d.name) + (d.data && d.data.temp ? ' <i>(temp)</i>' : '') + '</span> — read: ' + (reads.length ? escList(reads) : '<i>nobody detected</i>') + ' · written: ' + (wr.length ? escList(wr) : '<i>nobody detected</i>') + '</li>';
  }).join('');
  const cpy = byT('cpy')[0];
  let scen = '<i>No copybook in this project.</i>';
  if (cpy){
    const imp = impact(m, cpy.id);
    const progs = imp.up.direct.filter(x => x.id.startsWith('prog|')).map(x => nm(x.id) + ' (' + x.conf + ')');
    const jobs = imp.up.indirect.filter(x => x.id.startsWith('job|')).map(x => nm(x.id));
    scen = 'changing <span class="mono">' + esc(cpy.name) + '</span> affects ' + escList(progs)
      + (jobs.length ? ' — and job(s) ' + escList(jobs) : '')
      + '. <b>Question for the developer:</b> "if this layout changes, which programs and jobs need regression tests, and which tests do you plan?"';
  }
  const warns = (m.warnings || []).slice(0, 6);
  const warnLines = warns.length ? warns.map(w => '<li>' + esc(w) + '</li>').join('') : '<li><span class="ok">✓ No warning detected — every relation is confirmed.</span></li>';
  return `<div class="card" style="max-width:760px"><h3>⏱ First 5 minutes — plain-language read</h3>
    <p class="note" style="font-size:13px;line-height:1.6;color:var(--text2)">What a non-specialist can see immediately — generated from the detected relations only, evidence and confidence included.</p>
    <p class="note" style="line-height:1.9"><b>1. The jobs:</b></p><ul class="note" style="line-height:1.8">${jobLines || '<li><i>none</i></li>'}</ul>
    <p class="note" style="line-height:1.9"><b>2. The data:</b></p><ul class="note" style="line-height:1.8">${dsLines || '<li><i>none</i></li>'}</ul>
    <p class="note" style="line-height:1.9"><b>3. Change scenario:</b> ${scen}</p>
    <p class="note" style="line-height:1.9"><b>4. Points to ask about:</b></p><ul class="note" style="line-height:1.8">${warnLines}</ul>
  </div>`;
}

function downloadResults(fmt){
  const specs = {
    json: { name: 'reforge-results.json', type: 'application/json', build: () => JSON.stringify(resultsPayload(), null, 2) },
    csv:  { name: 'reforge-relations.csv', type: 'text/csv', build: resultsCSV },
    md:   { name: 'reforge-report.md', type: 'text/markdown', build: resultsMD }
  };
  const spec = specs[fmt];
  if (!spec || !state.files.length) return;
  const blob = new Blob([spec.build()], { type: spec.type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = spec.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  track('export_results_' + fmt);
}

// ── Control report: standalone HTML document for audit — inventory,
// findings by severity, relation confidence, honest coverage ──
function controlReportHTML(){
  const m = getModel();
  const byT = t => [...m.nodes.values()].filter(n => n.type === t).length;
  const cnt = c => m.edges.filter(e => e.c === c).length;
  const wBy = s => m.warnings.filter(w => warnSeverity(w) === s);
  const w1 = wBy(1), w2 = wBy(2), w3 = wBy(3);
  const kinds = {};
  m.edges.forEach(e => { kinds[e.k] = (kinds[e.k] || 0) + 1; });
  const kindRows = Object.entries(kinds).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => '<tr><td>' + esc(k) + '</td><td>' + n + '</td></tr>').join('');
  const fileRows = state.files.map(f =>
    '<tr><td>' + esc(f.name) + '</td><td>' + esc(f.lang) + '</td><td>' + (f.lines || 0) + '</td><td>' +
    esc(f.encoding || 'utf-8') + '</td><td>' + esc((f.parsed && (f.parsed.programId || f.parsed.rexx && f.parsed.rexx.execName)) || '—') + '</td></tr>').join('');
  const warnRows = (arr, label, color) => !arr.length ? '' :
    '<h3 style="color:' + color + '">' + label + ' (' + arr.length + ')</h3><ul>' +
    arr.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reforge control report</title><style>' +
    'body{font-family:ui-monospace,Menlo,monospace;background:#0d1117;color:#c9d1d9;max-width:900px;margin:24px auto;padding:0 16px;line-height:1.6}' +
    'h1{font-size:20px}h3{font-size:14px;margin:18px 0 6px}table{border-collapse:collapse;width:100%;font-size:12px}' +
    'td,th{border:1px solid #30363d;padding:4px 8px;text-align:left}.note{color:#8b949e;font-size:12px}' +
    '</style></head><body>' +
    '<h1>Reforge — control report</h1>' +
    '<p class="note">Generated ' + esc(new Date().toISOString()) + ' · offline analysis · every relation carries evidence and a confidence level</p>' +
    '<h3>1. Inventory</h3><table><tr><th>Jobs</th><th>Steps</th><th>Programs</th><th>Copybooks</th><th>Datasets</th><th>DB2 tables</th><th>CICS files/maps/queues</th><th>Relations</th></tr>' +
    '<tr><td>' + byT('job') + '</td><td>' + byT('step') + '</td><td>' + byT('prog') + '</td><td>' + byT('cpy') + '</td><td>' + byT('ds') + '</td><td>' + byT('tbl') + '</td><td>' + byT('fct') + '/' + byT('map') + '/' + byT('q') + '</td><td>' + m.edges.length + '</td></tr></table>' +
    '<h3>Files analyzed</h3><table><tr><th>File</th><th>Lang</th><th>Lines</th><th>Encoding</th><th>Program / Exec</th></tr>' + fileRows + '</table>' +
    '<h3>2. Confidence of relations</h3><table><tr><th>Confidence</th><th>Count</th></tr>' +
    '<tr><td>certain (evidence chain complete)</td><td>' + cnt('certain') + '</td></tr>' +
    '<tr><td>probable (trace, not confirmed)</td><td>' + cnt('probable') + '</td></tr>' +
    '<tr><td>unknown (referenced, nature unresolved)</td><td>' + cnt('unknown') + '</td></tr></table>' +
    '<table style="margin-top:8px"><tr><th>Relation kind</th><th>Count</th></tr>' + kindRows + '</table>' +
    '<h3>3. Findings by severity</h3>' +
    '<p class="note">1 = blocking for understanding · 2 = uncertainty · 3 = informational. Full list, nothing filtered.</p>' +
    warnRows(w1, 'Severity 1 — blocking', '#f85149') +
    warnRows(w2, 'Severity 2 — uncertainty', '#d29922') +
    warnRows(w3, 'Severity 3 — informational', '#8b949e') +
    (!m.warnings.length ? '<p class="note">No warning raised on this set.</p>' : '') +
    ((m.dead && (m.dead.datasets.length || m.dead.copybooks.length)) ?
      '<h3>3b. Dead code candidates — questions, not facts</h3>' +
      '<p class="note">Written-but-never-read within the analyzed set: the reader may exist in jobs that were not uploaded. Never a deletion order without cross-checking the whole system.</p><ul>' +
      m.dead.datasets.map(d => '<li>dataset ' + esc(d) + ': written, never read in this set</li>').join('') +
      m.dead.copybooks.map(c => '<li>copybook ' + esc(c) + ': never COPYed by an uploaded program</li>').join('') +
      '</ul>' : '') +
    '<h3>4. Coverage and known limits (documented, not hidden)</h3>' +
    '<ul class="note"><li>COBOL: structure, variables, SELECT/FD I/O chains, SQL, EXEC CICS (FILE/DATASET/MAP/QUEUE/XCTL/LINK), dead code, copybooks.</li>' +
    '<li>JCL: statements, PROC expansion, symbolics, backrefs, IF/ELSE and COND captured; <b>evaluated only when an execution job log is uploaded</b> (real return codes, SDSF/SAR export), otherwise never evaluated — flagged, not simulated. RD/RERUN flagged, not simulated.</li>' +
    '<li>REXX: literal CALL and quoted datasets only (references, never claimed read/write); SORT/DFSORT inline cards decoded (subset); IKJEFT01 SYSTSIN members expanded only if uploaded.</li>' +
    '<li>Anything not uploaded (cataloged procs, datasets with sort cards, external programs) is flagged — never invented.</li>' +
    '<li>EBCDIC decoding covers the CP037 printable subset; unmapped bytes appear as ? (counted).</li></ul>' +
    '<h3>5. How to verify</h3>' +
    '<p class="note">In the app: Debug view → Engine self-tests and V2 suite (or URL ?selftest) — all must pass. Every relation in the map lists its evidence (file, line, note).</p>' +
    '</body></html>';
}
function downloadControlReport(){
  if (!state.files.length) return;
  const blob = new Blob([controlReportHTML()], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'reforge-control-report.html';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  track('export_control_report');
}

// ── Export / import de projet (.json) ──
function exportProject(){
  if (!state.files.length) return;
  const data = { app: 'reforge', v: SESSION_VER, exported: new Date().toISOString(),
    files: state.files.map(f => ({ name: f.name, lang: f.lang, text: f.text, sample: !!f.sample })) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'reforge-project.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  track('export_project');
}

function isReforgeProject(name, text){
  return /\.json$/i.test(name) && /"app"\s*:\s*"reforge"/.test((text || '').slice(0, 500));
}

async function importProject(text){
  let data;
  try { data = JSON.parse(text); } catch(e){ return false; }
  if (!data || data.app !== 'reforge' || !Array.isArray(data.files)) return false;
  state.files = [];
  for (const f of data.files){
    const t = f.text || '';
    const nf = { name: f.name, lang: detectLang(f.name, t), text: t, lines: t.split('\n').length, sample: !!f.sample };
    parseFile(nf);
    state.files.push(nf);
  }
  state.loaded = true;
  state.entity = null; state.srcFile = null; state.pySel = null;
  state.group = 'explore'; state.sub = 'map';
  document.getElementById('statusText').textContent = 'Project imported';
  buildLog();
  saveSession();
  renderLeft(); renderNav(); renderContent();
  track('import_project');
  return true;
}

// ── Lightweight telemetry (GA usage counters, never file names) ──
function track(name){
  // ⛔ Reversible telemetry: even if gtag.js is already loaded, the persistent
  // opt-out (localStorage 'reforge_telemetry' = '0') blocks EVERY event.
  try { if (telemetryOn() && typeof window.gtag === 'function') window.gtag('event', name); } catch(e){}
}

// ══════════════════ 6. PANNEAUX ══════════════════
