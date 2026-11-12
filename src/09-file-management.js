function cobRegistry(){
  // copybook registry: base name → {text, file}
  const reg = {};
  state.files.forEach(x => { if (x.lang === 'CPY') reg[base(x.name)] = { text: x.text, file: x.name }; });
  return reg;
}

function jclMembers(excludeName){
  // available INCLUDE members = JCL files of the project, indexed by member name (without extension)
  const members = {};
  state.files.forEach(x => { if (x.lang === 'JCL' && x.name !== excludeName) members[base(x.name)] = x.text; });
  return members;
}

function parseFile(f){
  f.parsed = {};
  const t = f.text;
  if (f.lang === 'JCL'){
    const res = parseJCL(t, jclMembers(f.name));
    // no JOB nor PROC → pseudo-job named after the file ; PROC-only file → no pseudo-job
    if (!res.jobs.length && !Object.keys(res.procs).length)
      res.jobs.push({ name: base(f.name), steps: [], procsUsed: [], params: {} });
    res.jobs.forEach(jb => { jb.srcFile = f.name; });
    f.parsed = { engine: 'v3', jobs: res.jobs, procs: res.procs, warnings: res.warnings };
  } else if (f.lang === 'CBL' || f.lang === 'CPY'){
    const C = parseCOBOL(f.name, t, cobRegistry());
    f.parsed = { engine: 'v3', cobol: C, warnings: C.warns,
      programId: f.lang === 'CBL' ? C.programId : null,
      copies: C.copyUsed.map(c => ({ name: c.name, resolved: !!c.resolved })),
      sqlCount: C.sql.length, cicsCount: C.cics.length, performs: C.performs.length, gotos: C.gotos.length, deadCount: (C.dead||[]).length };
  } else if (f.lang === 'REXX'){
    const R = parseREXX(f.name, t);
    f.parsed = { engine: 'v3', rexx: R, warnings: R.warns,
      programId: R.execName, calls: R.calls.length, dsns: R.dsns.length };
  } else if (f.lang === 'SCHED'){
    const S = parseSched(t);
    f.parsed = { engine: 'v3', sched: S, warnings: S.warnings,
      depCount: S.deps.reduce((n, d) => n + d.after.length, 0) };
  } else if (f.lang === 'JOBLOG'){
    const LG = parseJobLog(t);
    f.parsed = { engine: 'v3', joblog: LG, warnings: LG.warnings,
      jobs: LG.logs.map(l => l.job), stepCount: LG.logs.reduce((a, l) => a + l.steps.length, 0) };
  }
  state._model = null; // the graph must be rebuilt
}

function buildGraph(){
  const g = { jobs:[], programs:[], copybooks:[], datasets:[], edges:[] };
  const seen = new Set();
  const addEdge = (from,to) => {
    from = String(from).toUpperCase(); to = String(to).toUpperCase();
    const k = from+'→'+to;
    if (from !== to && !seen.has(k)){ seen.add(k); g.edges.push({from,to}); }
  };
  if (state.files.length) linkCatalogedProcs();
  state.files.forEach(f=>{
    if (f.lang === 'JCL'){
      // engine v2: one file can contain several jobs — one entry per job
      // (PROC-only files do not become pseudo-jobs)
      const jobs = f.parsed.jobs || [];
      jobs.forEach(jb=>{
        const steps = (jb.steps||[]).map(s => ({
          name: s.name, pgm: s.target, kind: s.kind,
          proc: s.proc || null, via: s.via || null, condition: s.condition || null,
          sortInfo: s.sortInfo || null, rexxExec: s.rexxExec || null,
          cond: s.cond || null, rd: s.rd || null,
          rcObs: s.rcObs != null ? s.rcObs : null, abendObs: s.abendObs || null,
          flushedObs: !!s.flushedObs, condEval: s.condEval || null,
          dds: s.dds || []
        }));
        const dsns = [...new Set((jb.steps||[]).flatMap(s => (s.dds||[]))
          .filter(d => d.name && !d.temp && !d.backref).map(d => String(d.name).toUpperCase()))];
        g.jobs.push({ name: (jb.name || base(f.name)), file: f.name, lines: f.lines,
          parsed: { steps, dsns, warnings: (f.parsed && f.parsed.warnings) || [] } });
      });
    }
    else if (f.lang === 'CBL' || f.lang === 'REXX') g.programs.push(f);
    else if (f.lang === 'CPY') g.copybooks.push(f);
  });
  g.jobs.forEach(j=>{
    const jid = base(j.name);
    j.parsed.steps.forEach(s => { if (s.pgm) addEdge(jid, s.pgm); });
    j.parsed.dsns.forEach(d => { if(!g.datasets.includes(d)) g.datasets.push(d); addEdge(jid, d); });
  });
  g.programs.forEach(p=>{
    const pid = p.parsed.programId;
    (p.parsed.copies||[]).forEach(cu=>{
      const c = cu.name;
      g.copybooks.forEach(cb=>{
        const cbn = base(cb.name);
        if (cu.resolved && (cbn === c || c.indexOf(cbn) === 0)) addEdge(pid, cbn);
      });
    });
  });
  return g;
}

function typeOf(label, g){
  if (g.jobs.some(j=>base(j.name)===label)) return 'JCL JOB';
  if (g.programs.some(p=>p.parsed.programId===label)) return 'COBOL';
  if (g.copybooks.some(c=>base(c.name)===label)) return 'COPYBOOK';
  if (g.datasets.includes(label)) return 'DATASET';
  return 'UNKNOWN';
}

// Human-readable description of a step, computed from its real DDs (engine v2)
function stepDesc(s){
  if (!s.pgm) return 'EXEC — no PGM/PROC resolved (see Debug log)';
  const parts = [ s.kind === 'PROC' ? `EXEC PROC=${esc(s.pgm)}` : `EXEC PGM=${esc(s.pgm)}` ];
  const ins   = (s.dds||[]).filter(d => d.usage === 'input'  && d.name && !d.temp).map(d => esc(d.name));
  const outs  = (s.dds||[]).filter(d => d.usage === 'output' && d.name && !d.temp)
                 .map(d => esc(d.name) + (d.gdg != null ? ` (GDG ${d.gdg > 0 ? '+' : ''}${d.gdg})` : ''));
  const temps = (s.dds||[]).filter(d => d.temp).map(d => esc(d.name));
  if (ins.length)   parts.push(`reads ${ins.join(', ')}`);
  if (outs.length)  parts.push(`writes ${outs.join(', ')}`);
  if (temps.length) parts.push(`temp ${temps.join(', ')}`);
  if (s.proc) parts.push(`<span style="color:var(--purple)">from PROC ${esc(s.proc)}${s.via ? ' (via ' + esc(s.via) + ')' : ''}</span>`);
  const ovs = (s.dds||[]).filter(d => d.overriddenBy).map(d => esc(d.overriddenBy) + (d.name ? ' → ' + esc(d.name) : ' (DD DUMMY)'));
  if (ovs.length) parts.push(`<span style="color:var(--yellow)">override ${ovs.join(', ')}</span>`);
  if (s.condition){
    const c = s.condition, txt = c && c.text ? c.text : String(c);
    parts.push(`<span style="color:var(--yellow)">if ${c && c.neg ? 'NOT ' : ''}${esc(c && c.neg ? '(' + txt + ')' : txt)}</span>`);
  }
  if (s.sortInfo){
    const si = s.sortInfo;
    const f = si.type === 'copy' ? 'FIELDS=COPY'
      : (si.fields.length ? 'FIELDS=' + si.fields.map(x => `${x.pos}:${x.len} ${x.type} ${x.order}`).join(', ')
       : 'fields not decoded');
    parts.push(`<span style="color:var(--blue)">SORT ${esc(f)}${si.sum ? ' · SUM ' + esc(si.sum) : ''}</span>`);
    const ioc = si.include || si.omit;
    if (ioc) parts.push(`<span style="color:var(--blue)">${si.include ? 'INCLUDE' : 'OMIT'} ${ioc.decoded ? esc(ioc.conds.map((c, i) => (i ? ' ' + ((ioc.joins && ioc.joins[i-1]) || 'AND') + ' ' : '') + c.pos + (c.len != null ? ':' + c.len : '') + ' ' + c.type + ' ' + c.op + ' ' + (c.field2 ? '(' + c.value + ')' : c.value)).join('')) : 'COND=' + esc(ioc.raw) + ' (not decoded)'}</span>`);
    const rc = si.inrec || si.outrec;
    if (rc) parts.push(`<span style="color:var(--blue)">${si.inrec ? 'INREC' : 'OUTREC'} ${rc.kind} ${rc.decoded ? esc(rc.items.map(x => x.literal != null ? x.out + ':C&quot;' + x.literal + '&quot;' : (x.out != null ? x.out + ':' : '') + x.pos + ',' + x.len).join(', ')) : esc(rc.raw) + ' (not decoded)'}</span>`);
    const ofl = (si.outfil || []).flatMap(x => x.names || []);
    if (ofl.length) parts.push(`<span style="color:var(--blue)">OUTFIL → ${esc(ofl.join(', '))}</span>`);
  }
  if (s.rexxExec) parts.push(`<span style="color:var(--purple)">SYSTSIN EXEC '${esc(s.rexxExec)}' (REXX/CLIST)</span>`);
  if (s.cond){
    const cd = String(s.cond).replace(/\s/g, '');
    if (/EVEN\)?$/.test(cd)) parts.push(`<span style="color:var(--yellow)">COND ${esc(String(s.cond))} (runs even after a previous abend)</span>`);
    else if (/ONLY\)?$/.test(cd)) parts.push(`<span style="color:var(--yellow)">COND ${esc(String(s.cond))} (exceptional path — runs only after an abend)</span>`);
    else if (s.condEval) parts.push(`<span style="color:var(--yellow)">COND ${esc(String(s.cond))} evaluated from uploaded job log: ${s.condEval.skip ? 'BYPASSED' : 'EXECUTED'} (${esc(s.condEval.note)})</span>`);
    else parts.push(`<span style="color:var(--yellow)">COND ${esc(String(s.cond))} (not evaluated)</span>`);
  }
  // RC / ABEND / flush actually observed in an uploaded job log
  if (s.rcObs != null) parts.push(`<span style="color:var(--green)">RC ${String(s.rcObs).padStart(4, '0')} (job log)</span>`);
  if (s.abendObs) parts.push(`<span style="color:var(--red)">ABEND ${esc(s.abendObs)} (job log)</span>`);
  if (s.flushedObs) parts.push(`<span style="color:var(--yellow)">bypassed/flushed per job log</span>`);
  if (s.rd) parts.push(`<span style="color:var(--yellow)">RD=${esc(String(s.rd))} (restart)</span>`);
  return parts.join(' · ');
}

// ══════════════════ 2. GESTION DES FICHIERS ══════════════════

// ── Honest byte decoding: UTF-8 (+BOM), UTF-16, EBCDIC CP037 (subset) ──
// z/OS files often come down in EBCDIC: without decoding, analysis is
// impossible (mojibake). Documented CP037 subset: letters/digits/punctuation
// COBOL-JCL; any byte outside the table → '?' (counted, never guessed).
const CP037 = (() => {
  const T = new Array(256).fill(null);
  T[0x00] = '\u0000'; T[0x0D] = '\r'; T[0x05] = '\t'; T[0x25] = '\n';
  T[0x40] = ' ';
  for (let i = 0; i < 10; i++) T[0xF0 + i] = String(i);
  const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', LO = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < 9; i++) T[0x81 + i] = LO[i];
  for (let i = 0; i < 9; i++) T[0x91 + i] = LO[9 + i];
  for (let i = 0; i < 8; i++) T[0xA2 + i] = LO[18 + i];
  for (let i = 0; i < 9; i++) T[0xC1 + i] = UP[i];
  for (let i = 0; i < 9; i++) T[0xD1 + i] = UP[9 + i];
  for (let i = 0; i < 8; i++) T[0xE2 + i] = UP[18 + i];
  const P = { 0x4A:'¢', 0x4B:'.', 0x4C:'<', 0x4D:'(', 0x4E:'+', 0x4F:'|', 0x50:'&',
    0x5A:'!', 0x5B:'$', 0x5C:'*', 0x5D:')', 0x5E:';', 0x5F:'¬', 0x60:'-', 0x61:'/',
    0x6B:',', 0x6C:'%', 0x6D:'_', 0x6E:'>', 0x6F:'?', 0x7A:':', 0x7B:'#', 0x7C:'@',
    0x7D:"'", 0x7E:'=', 0x7F:'"', 0xAD:'[', 0xBD:']', 0xC0:'{', 0xD0:'}' };
  for (const k of Object.keys(P)) T[+k] = P[k];
  return T;
})();
function ebcdicDecode(b){
  let out = '', unmapped = 0;
  for (let i = 0; i < b.length; i++){
    const ch = CP037[b[i]];
    if (ch === null){ unmapped++; out += '?'; } else out += ch;
  }
  return { text: out, unmapped };
}
// Transparent heuristic: an EBCDIC file is dominated by bytes ≥ 0x81
// (letters/digits) and poor in printable ASCII bytes. A UTF-8/Latin-1 file
// is the reverse (accent included) — never converted by mistake. Documented ambiguity:
// EBCDIC punctuation (0x4A-0x7F) overlaps ASCII letters; the overall
// density decides, never an isolated byte.
function looksEbcdic(b){
  if (!b.length) return false;
  let high = 0, printable = 0, n = 0;
  for (let i = 0; i < b.length && n < 8192; i++, n++){
    const c = b[i];
    if (c >= 0x81) high++;
    else if ((c >= 0x20 && c <= 0x7E) || c === 0x09 || c === 0x0A || c === 0x0D) printable++;
  }
  return high > n * 0.3 && printable < n * 0.5;
}
function utf8Decode(b){
  let out = '';
  for (let i = 0; i < b.length; ){
    const c = b[i];
    if (c < 0x80){ out += String.fromCharCode(c); i++; continue; }
    if (c >= 0xC2 && c < 0xE0 && (b[i+1] & 0xC0) === 0x80){ out += String.fromCharCode(((c & 0x1F) << 6) | (b[i+1] & 0x3F)); i += 2; continue; }
    if (c >= 0xE0 && c < 0xF0 && (b[i+1] & 0xC0) === 0x80 && (b[i+2] & 0xC0) === 0x80){ out += String.fromCharCode(((c & 0x0F) << 12) | ((b[i+1] & 0x3F) << 6) | (b[i+2] & 0x3F)); i += 3; continue; }
    if (c >= 0xF0 && c < 0xF8 && (b[i+1] & 0xC0) === 0x80 && (b[i+2] & 0xC0) === 0x80 && (b[i+3] & 0xC0) === 0x80){ out += String.fromCodePoint(((c & 0x07) << 18) | ((b[i+1] & 0x3F) << 12) | ((b[i+2] & 0x3F) << 6) | (b[i+3] & 0x3F)); i += 4; continue; }
    out += '\uFFFD'; i++;
  }
  return out;
}
function utf16Decode(b, bigEndian){
  let out = '';
  for (let i = 2; i + 1 < b.length; i += 2)
    out += String.fromCharCode(bigEndian ? (b[i] << 8) | b[i+1] : (b[i+1] << 8) | b[i]);
  return out;
}
function decodeBytes(b){
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF)
    return { text: utf8Decode(b.subarray(3)), enc: 'utf-8 (BOM removed)' };
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE)
    return { text: utf16Decode(b, false), enc: 'utf-16le (BOM)' };
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF)
    return { text: utf16Decode(b, true), enc: 'utf-16be (BOM)' };
  if (looksEbcdic(b)){
    const r = ebcdicDecode(b);
    return { text: r.text, enc: 'EBCDIC CP037 (auto-detected' + (r.unmapped ? ', ' + r.unmapped + ' unmapped byte(s) shown as ?' : '') + ')' };
  }
  return { text: utf8Decode(b), enc: 'utf-8' };
}
async function readTextSmart(f){
  try {
    const buf = await f.arrayBuffer();
    return decodeBytes(new Uint8Array(buf));
  } catch(e){
    try { return { text: await f.text(), enc: 'utf-8 (fallback: arrayBuffer unavailable)' }; }
    catch(e2){ return { text: '', enc: 'unreadable' }; }
  }
}

// ── Impact diff between two versions of a system ──────────────────────────
// Compares the dependency MODELS (nodes + edges with evidence), never the
// file text. HONEST: no rename detection (a renamed dataset
// appears as removal + addition); two identical sets → zero
// delta; the evidence shown comes from the side where the edge appears.
function deltaDiff(filesA, filesB){
  const mA = buildModel(filesA), mB = buildModel(filesB);
  const ek = e => e.f + '\u0001' + e.t + '\u0001' + e.k;
  const eMap = m => { const h = new Map(); m.edges.forEach(e => h.set(ek(e), e)); return h; };
  const eA = eMap(mA), eB = eMap(mB);
  const edgesAdded = [], edgesRemoved = [];
  eB.forEach((e, k) => { if (!eA.has(k)) edgesAdded.push(e); });
  eA.forEach((e, k) => { if (!eB.has(k)) edgesRemoved.push(e); });
  const nodesAdded = [], nodesRemoved = [];
  mB.nodes.forEach((n, id) => { if (!mA.nodes.has(id)) nodesAdded.push(n); });
  mA.nodes.forEach((n, id) => { if (!mB.nodes.has(id)) nodesRemoved.push(n); });
  return { nodesAdded, nodesRemoved, edgesAdded, edgesRemoved,
    warnCounts: { a: mA.warnings.length, b: mB.warnings.length } };
}

function computeDelta(){
  const d = state.delta;
  if (!d || !d.a || !d.b || !d.a.length || !d.b.length){ if (d) d.res = null; return; }
  d.res = deltaDiff(d.a, d.b);
}

async function deltaFiles(side, fl){
  const arr = [...fl];
  if (!arr.length) return;
  if (!state.delta) state.delta = { a: null, b: null, res: null };
  const parsed = [];
  for (const f of arr){
    const rd = await readTextSmart(f);
    const t = rd.text;
    const nf = { name: f.name, lang: detectLang(f.name, t), text: t, lines: t.split('\n').length, sample: false, encoding: rd.enc };
    parseFile(nf);
    parsed.push(nf);
  }
  state.delta[side] = parsed;
  computeDelta();
  document.getElementById('statusText').textContent = 'Version diff ready';
  track('delta_files'); // telemetry: only the FACT of comparing — never names nor content
  renderContent();
}

// Version A = files already loaded in the analysis (cloned then re-parsed)
function deltaUseLoaded(){
  if (!state.files.length) return;
  if (!state.delta) state.delta = { a: null, b: null, res: null };
  state.delta.a = state.files.map(f => ({ name: f.name, lang: f.lang, text: f.text, lines: f.lines, sample: f.sample, encoding: f.encoding }));
  state.delta.a.forEach(f => parseFile(f));
  computeDelta();
  renderContent();
}

function deltaClear(side){
  if (!state.delta) return;
  state.delta[side] = null;
  computeDelta();
  renderContent();
}

async function handleFiles(fl){
  const arr = [...fl];
  if (!arr.length) return;
  for (const f of arr){
    const rd = await readTextSmart(f);
    let text = rd.text;
    if (isReforgeProject(f.name, text)){ await importProject(text); continue; }
    const lang = detectLang(f.name, text);
    const nf = { name:f.name, lang, text, lines:text.split('\n').length, sample:false, encoding: rd.enc };
    parseFile(nf);
    // replaces a same-named file
    const i = state.files.findIndex(x=>x.name===nf.name);
    if (i>=0) state.files[i] = nf; else state.files.push(nf);
  }
  renderLeft();
  saveSession();
  track('upload_files'); // telemetry: only the FACT of dropping files is counted — never names nor content
  if (state.loaded) renderContent();
}

function removeFile(i){
  state.files.splice(i,1);
  state._model = null;
  if (!state.files.length){ resetAll(); return; }
  if (state.srcFile && !state.files.some(f=>f.name===state.srcFile)) state.srcFile = state.files[0].name;
  renderLeft(); renderContent(); saveSession();
}

function clearAllFiles(){ resetAll(); }

function resetAll(){
  state.files = []; state.loaded = false; state.log = [];
  state.entity = null; state.srcFile = null; state.pySel = null;
  state.srcIdx = null; state._model = null;
  state.group = 'explore'; state.sub = 'map';
  document.getElementById('statusText').textContent = 'Ready';
  clearSession();
  renderLeft(); renderNav(); renderContent();
}

function analyze(){
  if (!state.files.length) return;
  buildLog();
  state.loaded = true;
  document.getElementById('statusText').textContent = 'Analysis complete';
  state.group = 'explore'; state.sub = 'map';
  saveSession(); track('analyze');
  renderLeft(); renderNav(); renderContent();
}

function buildLog(){
  const L = []; const add = (cls,text)=>L.push({cls,text});
  add('info', `[parse] ${state.files.length} file(s) received — COBOL engine v3 (structure, variables, I/O, SQL), JCL engine v2 (statements, PROC, backrefs)`);
  state.files.forEach(f=>{
    const why = f.lang==='JCL' ? 'JCL statements (engine v2)' : f.lang==='CBL' ? 'PROGRAM-ID found' : f.lang==='CPY' ? 'record layout' : f.lang==='REXX' ? 'REXX exec (/* REXX */ or .REX/.EXEC)' : 'unknown format';
    add('ok', `[ok] ${f.name} → ${f.lang} (${why})${f.encoding && f.encoding !== 'utf-8' ? ' — decoded from ' + f.encoding : ''}`);
    (f.parsed.warnings||[]).forEach(w=>add('warn', `[v3] ${f.name}: ${w}`));
    if (f.lang==='REXX' && f.parsed.rexx){
      const R = f.parsed.rexx;
      add('info', `[v3] ${R.execName || f.name}: REXX exec — ${R.calls.length} CALL(s), ${R.dsns.length} dataset reference(s)`);
    }
    if (f.lang==='JCL' && f.parsed.procs && Object.keys(f.parsed.procs).length)
      add('info', `[v3] ${f.name}: PROC definition(s) available: ${Object.keys(f.parsed.procs).join(', ')}`);
    if (f.lang==='JCL' && f.parsed.jobs) f.parsed.jobs.forEach(jb=>{
      if (jb.steps.length)
        add('info', `[v3] ${jb.name}: ${jb.steps.length} step(s) resolved${(jb.procsUsed||[]).length ? ' · PROCs: ' + [...new Set(jb.procsUsed)].join(', ') : ''}`);
    });
    if (f.lang==='CBL' && f.parsed.cobol){
      const C = f.parsed.cobol;
      add('info', `[v3] ${C.programId || f.name}: ${C.paragraphs.length} paragraph(s), ${C.vars.length} data item(s), ${C.selects.length} SELECT, ${C.calls.length} CALL, ${C.sql.length} SQL block(s), ${C.copyUsed.length} COPY reference(s)`);
    }
  });
  const m = getModel();
  const byT = t=>[...m.nodes.values()].filter(n=>n.type===t).length;
  m.warnings.forEach(w=>add('warn', `[graph] ${w}`));
  add('info', `[done] ${byT('job')} job(s) · ${byT('prog')} program(s) · ${byT('cpy')} copybook(s) · ${byT('ds')} dataset(s) · ${byT('tbl')} DB2 table(s) — ${m.edges.length} relation(s), each with evidence and a confidence level`);
  state.log = L;
}

// ══════════════════ 3. EMPTY STATE ══════════════════
