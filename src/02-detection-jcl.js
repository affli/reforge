
function base(n){ return n.replace(/\.[^.]+$/,'').toUpperCase(); }

function detectLang(name, text){
  const ext = (name.split('.').pop()||'').toUpperCase();
  const t = text.toUpperCase();
  if (ext === 'JCL') return 'JCL';
  if (ext === 'CPY' || ext === 'COPY') return 'CPY';
  if (ext === 'REX' || ext === 'EXEC') return 'REXX';
  if (/^\s*\/\*\s*REXX/i.test(text)) return 'REXX';
  // Job execution log (SDSF/SAR/ESF export): dedicated extension or JES patterns
  // standard (IEF142I COND CODE, IEF450I ABEND, $HASP373/$HASP395).
  if (['LOG','SDSF','SAR','JOBLOG','JESMSGLG'].includes(ext)) return 'JOBLOG';
  if (/IEF142I .+COND CODE|IEF450I .+ABNORMAL ENDED|\$HASP373 .+STARTED|\$HASP395 .+ENDED - RC=/i.test(text)) return 'JOBLOG';
  if (/\bIDENTIFICATION DIVISION\b/.test(t) || /\bPROGRAM-ID\b/.test(t)) return 'CBL';
  if (/^\s*\/\//m.test(t) && /\b(EXEC|PROC|JOB|DD)\b/.test(t)) return 'JCL';
  if (/\bPIC(TURE)?\s+[S9VX]/i.test(text) && !/\bPROCEDURE DIVISION\b/.test(t)) return 'CPY';
  if (/\b(DIVISION|SECTION)\b/.test(t)) return 'CBL';
  if (ext === 'CBL' || ext === 'COB' || ext === 'CB2') return 'CBL';
  // Scheduler export: dedicated extension or JOB <job> AFTER <predecessors> format
  if (ext === 'SCH' || ext === 'SCHED' || /^JOB\s+[A-Z0-9@#$.\-]+\s+AFTER\b/m.test(t)) return 'SCHED';
  return 'TXT';
}

// ── JCL ENGINE v2 ─────────────────────────────────────────────────────────
// Real tokenizer → statement parser → model builder. Handles:
// JOB/EXEC/DD/PROC/PEND/SET/IF-ELSE-ENDIF/INCLUDE/JCLLIB, in-stream PROC
// expansion, symbolic parameters (SET, PROC defaults, EXEC symbols),
// EXEC overrides (PROCSTEP.DD.PARAM), DISP input/output classification,
// GDG (±n), temp datasets (&&), in-stream data (DD *), continuations,
// columns 73-80. Never throws: anything unrecognized lands in warnings[].

const JCL_OPS = new Set([
  'JOB', 'EXEC', 'DD', 'PROC', 'PEND', 'SET', 'IF', 'ELSE', 'ENDIF',
  'OUTPUT', 'INCLUDE', 'JCLLIB', 'COMMAND', 'XMIT', 'CNTL', 'ENDCNTL', 'EXPORT',
]);
const EXEC_STD_PARAMS = new Set([
  'PGM', 'PROC', 'PARM', 'COND', 'RD', 'TIME', 'REGION', 'ADDRSPC', 'DYNAMNBR',
  'CLASS', 'MSGCLASS', 'MSGLEVEL', 'NOTIFY', 'USER', 'PASSWORD', 'TYPRUN', 'ACCT',
]);

function tokenizeStatements(text, warnings){
  const statements = [];
  const lines = text.split(/\r?\n/);
  let inStreamData = false, curInline = null, inDlm = null, inData = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].slice(0, 72).trimEnd();
    const ln = i + 1;
    if (!line.trim()) continue;
    if (inStreamData) {
      // JCL Reference rules (honest, tested):
      //  • DLM='xx' coded: ONLY the delimiter ends the data — lines
      //    starting with // or /* are DATA (that is the purpose of DLM).
      //  • DD DATA without DLM: /* ends the data, but // lines
      //    are DATA (DATA vs * difference).
      //  • DD * without DLM: // or /* end it (historical behavior).
      if (inDlm) {
        if (line.trim().toUpperCase() === inDlm) { inStreamData = false; curInline = null; inDlm = null; inData = false; continue; }
        if (curInline) curInline.push({ ln, text: line });
        continue;
      }
      if (line.startsWith('/*')) { inStreamData = false; curInline = null; inData = false; }
      else if (line.startsWith('//')) {
        if (inData) { if (curInline) curInline.push({ ln, text: line }); continue; } // DD DATA: // is data
        inStreamData = false; curInline = null; inData = false;
      }
      else { if (curInline) curInline.push({ ln, text: line }); continue; }
    }
    if (line.startsWith('/*')) continue;
    if (line.startsWith('//*')) continue;
    if (!line.startsWith('//')) { warnings.push(`L${ln}: non-JCL line ignored`); continue; }
    const rest = line.slice(2);
    if (rest.trim() === '') continue;
    const firstTok = rest.trim().split(/\s+/)[0];
    const looksLikeContinuation =
      firstTok.includes('=') ||
      firstTok.startsWith("'") ||
      (statements.length > 0 && statements[statements.length - 1].operands.trim().endsWith(','));
    if (looksLikeContinuation && !JCL_OPS.has(firstTok.toUpperCase())) {
      const prev = statements[statements.length - 1];
      if (prev && (prev.op === 'EXEC' || prev.op === 'DD' || prev.op === 'PROC' || prev.op === 'SET')) {
        prev.operands += ' ' + rest.trim();
        continue;
      }
      warnings.push(`L${ln}: orphan continuation ignored`);
      continue;
    }
    const t = rest.trim().match(/^(\S+)(?:\s+(.*))?$/);
    if (!t) continue;
    let name = null, op = null, operands = t[2] || '';
    if (JCL_OPS.has(t[1].toUpperCase())) {
      op = t[1].toUpperCase();
    } else {
      name = t[1];
      const t2 = operands.match(/^(\S+)\s*(.*)$/);
      if (t2 && JCL_OPS.has(t2[1].toUpperCase())) {
        op = t2[1].toUpperCase();
        operands = t2[2] || '';
      } else {
        const prev = statements[statements.length - 1];
        if (prev) { prev.operands += ' ' + rest.trim(); continue; }
        warnings.push(`L${ln}: unrecognized statement ignored ("${t[1]}")`);
        continue;
      }
    }
    const st = { name, op, operands: operands.trim(), line: ln };
    if (op === 'DD' && /^(\*|DATA\b)/.test(operands.trim())) {
      inStreamData = true; curInline = st.inline = [];
      inData = /^DATA\b/.test(operands.trim());
      const dm = operands.toUpperCase().match(/DLM\s*=\s*'([^']*)'/);
      inDlm = dm ? dm[1] : null;
    }
    statements.push(st);
  }
  return statements;
}

function parseParams(operands){
  const parts = [];
  let depth = 0, quote = false, cur = '';
  for (const ch of operands) {
    if (quote) { cur += ch; if (ch === "'") quote = false; continue; }
    if (ch === "'") { quote = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq > 0) out[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^'|'$/g, '');
    else out[p.toUpperCase()] = true;
  }
  return out;
}

function substitute(value, symbols){
  if (typeof value !== 'string') return value;
  const s = value.replace(/&([A-Z@$#][A-Z0-9@$#]*)/gi, (m, v) => {
    const up = v.toUpperCase();
    if (symbols[up] !== undefined && symbols[up] !== true) return symbols[up];
    return m;
  });
  return s.replace(/\.\./g, '.');
}

function classifyUsage(p){
  // no DISP → no invented usage: 'unknown' + downstream warning
  if (p.DISP === undefined || typeof p.DISP !== 'string') return 'unknown';
  const disp = p.DISP.toUpperCase();
  const first = disp.startsWith('(') ? disp.slice(1) : disp;
  const head = first.split(/[,(]/)[0].trim();
  if (head === '') return 'output';   // DISP=(,CATLG): omitted status = NEW
  if (head === 'NEW' || head === 'MOD') return 'output';
  if (head === 'SHR' || head === 'OLD') return 'input';
  return 'unknown';
}

function buildDD(st, p, symbols){
  const dd = { ddname: st.name, line: st.line };
  if (p.DSN !== undefined) {
    const dsn = substitute(p.DSN, symbols);
    if (dsn.startsWith('&&')) {
      dd.name = dsn.toUpperCase(); dd.temp = true; dd.usage = 'output';
    } else if (dsn.startsWith('*.')) {
      // back reference: DSN=*.STEP01.SORTOUT (temp passed from one step to another)
      dd.name = dsn.toUpperCase(); dd.backref = true; dd.usage = classifyUsage(p);
    } else {
      const g = dsn.match(/^(.*)\(([-+]?\d+)\)$/);
      if (g) { dd.name = g[1].toUpperCase(); dd.gdg = parseInt(g[2], 10); }
      else dd.name = dsn.toUpperCase();
      dd.usage = classifyUsage(p);
    }
  } else if (p.SYSOUT !== undefined) { dd.sysout = String(p.SYSOUT); dd.usage = 'output'; }
  else if (p.DUMMY !== undefined) { dd.dummy = true; }
  if (p.DISP !== undefined && typeof p.DISP === 'string') dd.disp = p.DISP.toUpperCase();
  if (p.SPACE !== undefined) dd.space = String(p.SPACE);
  return dd;
}

// ── DD overrides of a PROC: "//STEPNAME.DDNAME DD …" cards placed after the EXEC.
// Reliability: an unresolved override → explicit warning, NEVER silence;
// the effective dataset (after override) is the one shown in the lineage.
function applyProcDdOverrides(step, proc, copies, symbols, warn){
  const seen = new Set();
  for (const odd of (step.dds || [])){
    const raw = String(odd.ddname || '').toUpperCase();
    const parts = raw.split('.');
    if (parts.length < 2 || !parts[1]){
      warn(`DD ${odd.ddname} follows EXEC ${step.name} of PROC ${proc.name} without a stepname.ddname qualifier — not a valid override, ignored`);
      continue;
    }
    const psCopy = copies.find(c => (c.name || '').toUpperCase() === parts[0]);
    if (!psCopy){
      warn(`override ${raw} (after EXEC ${step.name}) matches no step named ${parts[0]} in PROC ${proc.name} — ignored`);
      continue;
    }
    if (parts.length >= 3){
      // nested override (OUTER.STEP.DD): re-emitted on the copy for the next
      // iteration (the PROC copy will be expanded in turn) — otherwise it is an error
      if (psCopy.kind === 'PROC'){
        const resid = JSON.parse(JSON.stringify(odd));
        resid.ddname = parts.slice(1).join('.');
        psCopy.dds.push(resid);
      } else {
        warn(`override ${raw}: ${parts[0]} is not a nested PROC in ${proc.name} — ignored`);
      }
      continue;
    }
    const targets = psCopy.dds.filter(d => (d.ddname || '').toUpperCase() === parts[1]);
    if (!targets.length){
      warn(`override ${raw} (after EXEC ${step.name}) matches no DD named ${parts[1]} in step ${parts[0]} of PROC ${proc.name} — ignored`);
      continue;
    }
    if (targets.length > 1)
      warn(`override ${raw}: the PROC step concatenates DD ${parts[1]} — the override applies to the FIRST member, the others are unchanged`);
    if (seen.has(raw)){
      // 2nd card (or more) for the same STEPNAME.DDNAME → CONCATENATION in real JCL:
      // each card adds a dataset to the DD (order kept). Each dataset is
      // materialized with its own suffixed ddname — no more silent loss.
      if (odd.dummy === true){ warn(`override ${raw}: DD DUMMY in concatenation — empty member, no dataset edge`); continue; }
      if (odd.name === undefined){ warn(`override ${raw}: concatenation card without DSN — nothing to apply`); continue; }
      const nname = substitute(odd.name, symbols);
      if (nname.includes('&')) psCopy.hasUnresolvedSymbols = true;
      let n = 2;
      while (psCopy.dds.some(d => d.ddname === parts[1] + '#' + n)) n++;
      psCopy.dds.push({ ddname: parts[1] + '#' + n, line: odd.line, name: nname, temp: odd.temp, gdg: odd.gdg,
        usage: odd.usage, disp: odd.disp, sysout: odd.sysout, space: odd.space, overriddenBy: raw, concatenated: true });
      continue;
    }
    seen.add(raw);
    const t = targets[0];
    const fields = ['name','temp','gdg','usage','sysout','dummy','disp','space','backref'];
    if (!fields.some(k => odd[k] !== undefined)){
      warn(`override ${raw}: card carries no DSN/DISP/SYSOUT/DUMMY/SPACE parameter — nothing to apply`);
      continue;
    }
    for (const k of fields){
      if (k === 'name' && odd.name !== undefined){
        t.name = substitute(odd.name, symbols);
        if (t.name.includes('&')) psCopy.hasUnresolvedSymbols = true;
      } else if (odd[k] !== undefined){
        t[k] = odd[k];
      }
    }
    // DD DUMMY as override: no more dataset I/O — the DSN is removed (no invented edge)
    if (odd.dummy === true){ delete t.name; delete t.backref; }
    t.overriddenBy = raw; // evidence: visible in stepDesc and the edge note
  }
}

function linkProcs(result){
  for (const job of result.jobs) {
    // Iterative expansion: a nested PROC may call another PROC —
    // loop to the fixed point (guard 10), chain followed to detect
    // recursion (a PROC calling itself: flagged, never expanded).
    let guard = 0, changed = true;
    while (changed && guard < 10){
      changed = false; guard++;
      const expanded = [];
      for (const step of job.steps) {
        if (step.kind !== 'PROC' || !step.target) { expanded.push(step); continue; }
        if (step.resolved === false) { expanded.push(step); continue; } // already flagged (not found)
        const proc = result.procs[step.target];
        if (!proc) {
          step.resolved = false;
          expanded.push(step);
          result.warnings.push(`${job.name}: PROC ${step.target} not found (external cataloged proc?)`);
          job.procsUsed.push(step.target);
          continue;
        }
        if ((step.chain || []).includes(step.target)){
          expanded.push(step);
          if (!result.warnings.some(w => w.includes(`recursive PROC ${step.target}`)))
            result.warnings.push(`${job.name}: recursive PROC call to ${step.target} — not expanded`);
          continue;
        }
        step.resolved = true;
        changed = true;
        job.procsUsed.push(proc.name);
        const symbols = { ...proc.defaults, ...step.symbols };
        const copies = [];
        for (const ps of proc.steps) {
          const copy = JSON.parse(JSON.stringify(ps));
          copy.proc = proc.name;
          copy.via = step.name;
          copy.chain = [...(step.chain || []), proc.name];
          for (const dd of copy.dds) {
            if (dd.name) {
              dd.name = substitute(dd.name, symbols);
              if (dd.name.includes('&')) copy.hasUnresolvedSymbols = true;
            }
          }
          for (const [ov, val] of Object.entries(step.overrides)) {
            const parts = ov.split('.');
            const ddname = parts.length >= 3 ? parts[1].toUpperCase() : parts[0].toUpperCase();
            const param = (parts.length >= 3 ? parts.slice(2) : parts.slice(1)).join('.').toUpperCase();
            const dd = copy.dds.find(d => (d.ddname || '').toUpperCase() === ddname);
            if (dd) dd['ov_' + param] = val;
          }
          copies.push(copy);
        }
        // overrides "//STEP.DD DD …" of the calling step: applied to the copies, with a warning if unresolved
        applyProcDdOverrides(step, proc, copies, symbols, msg => result.warnings.push(`${job.name}: ${msg}`));
        for (const c of copies) expanded.push(c);
      }
      job.steps = expanded;
    }
  }
}

// INCLUDE MEMBER=X: if the member is uploaded (JCL file of the project), its
// statements are spliced into the stream — otherwise precise warning, never guessed.
function resolveIncludes(stmts, members, stack, warns){
  const out = [];
  for (const st of stmts){
    if (st.op !== 'INCLUDE'){ out.push(st); continue; }
    const p = parseParams(st.operands);
    let member = null;
    if (typeof p.MEMBER === 'string' && p.MEMBER) member = p.MEMBER.trim().toUpperCase();
    else {
      const raw = st.operands.trim();
      const dn = raw.match(/\(([^()]+)\)\s*$/); // INCLUDE DSN=X.Y(NAME) or MEMBER=X.Y(NAME)
      member = dn ? dn[1].toUpperCase() : raw.split(/\s+/)[0].toUpperCase();
    }
    if (!member){ warns.push(`L${st.line}: INCLUDE without member name — ignored`); continue; }
    if (stack.includes(member)){ warns.push(`L${st.line}: INCLUDE ${member} circular — skipped`); continue; }
    if (stack.length >= 5){ warns.push(`L${st.line}: INCLUDE nesting deeper than 5 — stopped`); continue; }
    const text = members[member];
    if (text == null){
      warns.push(`L${st.line}: INCLUDE member ${member} not uploaded — statements not available`);
      out.push(st);
      continue;
    }
    out.push(...resolveIncludes(tokenizeStatements(text, warns), members, stack.concat(member), warns));
  }
  return out;
}

// ── SORT cards (DFSORT): honest analysis of SYSIN cards, no invention ──
function parseSortCards(text){
  const info = { type: null, fields: [], format: null, sum: null, decoded: false };
  const cards = (text || '').toUpperCase().split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('*'));
  const fmtCard = cards.find(c => /FORMAT\s*=/.test(c));
  if (fmtCard){ const fm = fmtCard.match(/FORMAT\s*=\s*([A-Z0-9]+)/); if (fm) info.format = fm[1]; }
  for (const card of cards){
    if (/^SORT\b/.test(card) && /FIELDS\s*=\s*COPY\b/.test(card)){ info.type = 'copy'; info.decoded = true; continue; }
    const m = (/^SORT\b/.test(card) && card.match(/FIELDS\s*=\s*\(([^)]*)\)/));
    if (m){
      info.type = 'sort';
      const fm = card.match(/FORMAT\s*=\s*([A-Z0-9]+)/);
      if (fm) info.format = fm[1];
      const toks = m[1].split(',').map(s => s.trim()).filter(Boolean);
      if (toks.length % 4 === 0 && toks.every((t, i) => (i % 4 === 2) ? /^(CH|ZD|PD|BI|FS|AC)$/.test(t) : (i % 4 === 3) ? /^[ABD]$/.test(t) : /^\d+$/.test(t))){
        for (let i = 0; i < toks.length; i += 4) info.fields.push({ pos: +toks[i], len: +toks[i+1], type: toks[i+2], order: toks[i+3] });
      } else if (info.format && toks.length % 3 === 0 && toks.every((t, i) => (i % 3 === 2) ? /^[ABD]$/.test(t) : /^\d+$/.test(t))){
        // short form: (p,l,order,...) with global FORMAT=
        for (let i = 0; i < toks.length; i += 3) info.fields.push({ pos: +toks[i], len: +toks[i+1], type: info.format, order: toks[i+2] });
      }
      if (info.fields.length) info.decoded = true;
      continue;
    }
    if (/^SUM\s+FIELDS\s*=\s*NONE\b/.test(card)){ info.sum = 'none'; continue; }
    const sm = card.match(/^SUM\s+FIELDS\s*=\s*(\([^)]*\)|[A-Z0-9,=]+)/);
    if (sm){ info.sum = sm[1]; continue; }
    // INCLUDE/OMIT COND: recursive decoding, literals respected (C'…', X'…',
    // commas included) and parentheses. Decoded forms: (p,l,type,OP,val),
    // short form (p,type,OP,val) with global FORMAT=, field-to-field comparison
    // (p,l,type,OP,p2,l2), joined by AND/OR (comma = AND). Any sub-condition
    // unknown → the whole card stays raw and marked undecoded — never guessed.
    const im = card.match(/^(INCLUDE|OMIT)\s+COND\s*=\s*(.+?)\s*$/);
    if (im){
      const blk = { raw: im[2], conds: [], joins: [], decoded: false };
      info[im[1] === 'INCLUDE' ? 'include' : 'omit'] = blk;
      const TYPE = /^(CH|ZD|PD|BI|FS|AC)$/, OPR = /^(EQ|NE|GT|GE|LT|LE)$/;
      const VAL = t => /^\d+$/.test(t) || /^C'[^']*'$/.test(t) || /^X'[0-9A-F]*'$/.test(t);
      const splitTop = (s) => { // split at level 0, respects '…' and (…)
        const out = []; let d = 0, q = false, cur = '';
        for (let i = 0; i < s.length; i++){
          const ch = s[i];
          if (q){ cur += ch; if (ch === "'") q = false; continue; }
          if (ch === "'"){ q = true; cur += ch; continue; }
          if (ch === '(') d++;
          else if (ch === ')') d--;
          if (ch === ',' && d === 0){ out.push(cur); cur = ''; continue; }
          cur += ch;
        }
        out.push(cur);
        return out.map(x => x.trim()).filter(Boolean);
      };
      const unwrap = (t) => { // remove enclosing parentheses (quote-aware)
        while (t.startsWith('(') && t.endsWith(')')){
          let d = 0, ok = true, q = false;
          for (let i = 0; i < t.length; i++){
            const ch = t[i];
            if (q){ if (ch === "'") q = false; continue; }
            if (ch === "'"){ q = true; continue; }
            if (ch === '(') d++;
            else if (ch === ')'){ d--; if (d === 0 && i < t.length - 1){ ok = false; break; } }
          }
          if (!ok) break;
          t = t.slice(1, -1).trim();
        }
        return t;
      };
      const parseCond = toks => {
        if (toks.length === 5 && /^\d+$/.test(toks[0]) && /^\d+$/.test(toks[1]) && TYPE.test(toks[2]) && OPR.test(toks[3]) && VAL(toks[4]))
          return { pos: +toks[0], len: +toks[1], type: toks[2], op: toks[3], value: toks[4] };
        if (toks.length === 4 && info.format && /^\d+$/.test(toks[0]) && TYPE.test(toks[1]) && OPR.test(toks[2]) && VAL(toks[3]))
          return { pos: +toks[0], len: null, type: toks[1], op: toks[2], value: toks[3] };
        if (toks.length === 6 && toks.every((t, i) => (i === 2 ? TYPE.test(t) : i === 3 ? OPR.test(t) : /^\d+$/.test(t))))
          return { pos: +toks[0], len: +toks[1], type: toks[2], op: toks[3], value: toks[4] + ',' + toks[5], field2: true };
        return null;
      };
      const walk = toks => {
        const conds = [], joins = [];
        let i = 0, expectCond = true;
        while (i < toks.length){
          const t = toks[i];
          if (/^(AND|OR)$/.test(t)){
            if (expectCond || !conds.length) return null;
            joins.push(t); expectCond = true; i++; continue;
          }
          if (!expectCond) joins.push('AND'); // implicit comma between 2 sub-conditions
          if (t.startsWith('(') && t.endsWith(')')){
            const sub = walk(splitTop(unwrap(t)));
            if (!sub) return null;
            conds.push(...sub.conds); joins.push(...sub.joins);
            expectCond = false; i++; continue;
          }
          let j = i; const rest = [];
          while (j < toks.length && !/^(AND|OR)$/.test(toks[j]) && !toks[j].startsWith('(')){ rest.push(toks[j]); j++; }
          if (j === i) return null;
          const c = parseCond(rest);
          if (!c) return null;
          conds.push(c); expectCond = false; i = j;
        }
        return expectCond ? null : { conds, joins };
      };
      const res = walk(splitTop(unwrap(blk.raw)));
      if (res && res.conds.length){ blk.conds = res.conds; blk.joins = res.joins; blk.decoded = true; }
      continue;
    }
    // INREC/OUTREC BUILD/OVERLAY/FIELDS: reassembly of (pos,len) pairs
    // and (out:pos,len) / (out:literal) — the rest stays raw, never invented.
    const ir = card.match(/^(INREC|OUTREC)\s+(BUILD|OVERLAY|FIELDS)\s*=\s*\(?(.+?)\)?\s*$/);
    if (ir){
      const blk = { kind: ir[2], raw: ir[3], items: [], decoded: false };
      const toks = ir[3].split(',').map(x => x.trim()).filter(Boolean);
      let ok = toks.length > 0;
      let i = 0;
      while (ok && i < toks.length){
        const t = toks[i];
        const m2 = t.match(/^(\d+):(\d+)$/);
        if (m2 && i + 1 < toks.length && /^\d+$/.test(toks[i+1])){ blk.items.push({ out: +m2[1], pos: +m2[2], len: +toks[i+1] }); i += 2; }
        else if (/^\d+$/.test(t) && i + 1 < toks.length && /^\d+$/.test(toks[i+1])){ blk.items.push({ out: null, pos: +t, len: +toks[i+1] }); i += 2; }
        else { const m3 = t.match(/^(\d+):C'(.*)'$/); if (m3){ blk.items.push({ out: +m3[1], literal: m3[2] }); i += 1; } else { ok = false; blk.items = []; } }
      }
      blk.decoded = ok && blk.items.length > 0;
      info[ir[1] === 'INREC' ? 'inrec' : 'outrec'] = blk;
      continue;
    }
    // OUTFIL FNAMES/OUTDD: additional outputs of the sort — named DDs
    // become known outputs of the step (real usage, no more "unknown").
    if (/^OUTFIL\b/.test(card)){
      const blk = { raw: card, names: [], decoded: false };
      const fn = card.match(/FNAMES?\s*=\s*\(([^)]+)\)/) || card.match(/FNAMES?\s*=\s*([A-Z0-9\-@#$.]+)/);
      const od = card.match(/OUTDD\s*=\s*\(([^)]+)\)/) || card.match(/OUTDD\s*=\s*([A-Z0-9\-@#$.]+)/);
      (fn ? fn[1].split(',') : []).forEach(x => { if (x.trim()) blk.names.push(x.trim()); });
      (od ? od[1].split(',') : []).forEach(x => { if (x.trim()) blk.names.push(x.trim()); });
      blk.decoded = blk.names.length > 0;
      (info.outfil = info.outfil || []).push(blk);
      continue;
    }
    // OPTION COPY: sort bypassed, pure copy — decoded. Other OPTION parameters
    // (EQUALS, DYNALLOC, etc.): recognized, not decoded (documented).
    if (/^OPTION\b/.test(card)){
      if (/\bCOPY\b/.test(card)){ info.type = 'copy'; info.decoded = true; info.optionCopy = true; }
      continue;
    }
    // RECORD/MODS/DEBUG/END: recognized, not decoded (documented)
    if (/^(RECORD|MODS|DEBUG|END)\b/.test(card)) continue;
  }
  return info;
}

// ── Scheduler: scheduling export (documented format, never guessed) ──
// Accepted format (one statement per line, case-insensitive):
//   JOB <JOBNAME> AFTER <JOB1>,<JOB2>,…      (# or * = comment)
// The scheduler IS the source of the execution order: a declared dependency
// makes the order CERTAIN. Unknown lines, invalid names, self-dependencies and
// cycles → explicit warnings — no inference, never hidden.
function parseSched(text){
  const S = { deps: [], warnings: [] };
  const seen = new Map();
  (text || '').split(/\r?\n/).forEach((raw, i) => {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('*')) return;
    const m = l.match(/^JOB\s+([A-Z0-9@#$.\-]{1,8})\s+AFTER\s+(.+)$/i);
    if (!m){ S.warnings.push('line ' + (i + 1) + ': not a "JOB … AFTER …" declaration — ignored, kept raw'); return; }
    const job = m[1].toUpperCase();
    const parts = m[2].split(',').map(x => x.trim().toUpperCase());
    const afters = parts.filter(x => /^[A-Z0-9@#$.\-]{1,8}$/.test(x));
    parts.filter(x => x && !/^[A-Z0-9@#$.\-]{1,8}$/.test(x))
      .forEach(x => S.warnings.push('line ' + (i + 1) + ': predecessor "' + x + '" is not a valid job name — ignored'));
    const rec = seen.get(job) || { job, after: [] };
    afters.forEach(a => {
      if (a === job){ S.warnings.push('job ' + job + ': declared AFTER itself — ignored (self-cycle)'); return; }
      if (!rec.after.includes(a)) rec.after.push(a);
    });
    seen.set(job, rec);
  });
  S.deps = [...seen.values()];
  S.deps.forEach(d => d.after.forEach(a => {
    const r = seen.get(a);
    if (r && r.after.includes(d.job)) S.warnings.push('cycle: ' + d.job + ' AFTER ' + a + ' and ' + a + ' AFTER ' + d.job + ' — order undefined, both edges kept as declared');
  }));
  return S;
}

// ── Job execution log (SDSF/SAR/ESF export): real RCs per step ────────────
// The ONLY legitimate source to evaluate COND/IF. Recognized formats (JESMSGLG
// standard) : IEF142I (COND CODE), IEF450I (ABEND), IEF453I (flush),
// $HASP373/$HASP395 (job name), and the simplified form "STEP RC=nnnn".
// Everything else is honestly ignored — never a guessed RC.
function parseJobLog(text){
  const LG = { logs: [], warnings: [] };
  const byJob = {};
  let cur = null; // last job seen ($HASP373) for the simplified form
  let recognized = 0;
  const ensure = (job) => {
    if (!job) return null;
    if (!byJob[job]){ byJob[job] = { job, steps: [], jobRc: null }; LG.logs.push(byJob[job]); }
    return byJob[job];
  };
  const setStep = (job, step, patch) => {
    const J = ensure(job); if (!J || !step) return;
    let s = J.steps.find(x => x.name === step);
    if (!s){ s = { name: step, rc: null, abend: null, flushed: false }; J.steps.push(s); }
    Object.assign(s, patch);
  };
  String(text || '').split(/\r?\n/).forEach(raw => {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = /(?:^|\s)IEF142I\s+(\S+)\s+(\S+).*COND CODE\s+(\d{1,8})/i.exec(line))){
      recognized++; setStep(m[1].toUpperCase(), m[2].toUpperCase(), { rc: parseInt(m[3], 10) });
    } else if ((m = /(?:^|\s)IEF450I\s+(\S+)\s+(\S+).*ABEND=([A-Z0-9]+)(?:\s+U(\d+))?/i.exec(line))){
      recognized++; setStep(m[1].toUpperCase(), m[2].toUpperCase(), { abend: (m[3] + (m[4] ? ' U' + m[4] : '')).toUpperCase() });
    } else if (/IEF453I/i.test(line) && /FLUSH/i.test(line) && (m = /(?:^|\s)IEF453I\s+(\S+)\s+(\S+)/i.exec(line))){
      recognized++; setStep(m[1].toUpperCase(), m[2].toUpperCase(), { flushed: true });
    } else if ((m = /\$HASP373\s+(\S+)\s+STARTED/i.exec(line))){
      recognized++; cur = m[1].toUpperCase(); ensure(cur);
    } else if ((m = /\$HASP395\s+(\S+)\s+ENDED\s*-\s*RC\s*=\s*(\d{1,8})/i.exec(line))){
      recognized++; cur = m[1].toUpperCase(); const J = ensure(cur); if (J) J.jobRc = parseInt(m[2], 10);
    } else if (cur && (m = /^\s*([A-Z][A-Z0-9@#$.\-]{0,7})\s+(?:-\s+)?RC\s*(?:=|:)?\s*(\d{1,8})\s*$/i.exec(line))){
      recognized++; setStep(cur, m[1].toUpperCase(), { rc: parseInt(m[2], 10) });
    }
  });
  if (!recognized) LG.warnings.push('job log uploaded but no JES/SDSF step status recognized — supported: IEF142I COND CODE, IEF450I ABEND, IEF453I flush, $HASP373/$HASP395, or STEP RC=nnnn (site-specific formats vary; nothing guessed)');
  return LG;
}

// ── REXX: minimal honest analysis — literal CALL, CALL via variable, quoted datasets ──
function parseREXX(fname, text){
  const R = { execName: null, calls: [], dsns: [], warns: [] };
  const nm = text.match(/\/\*\s*REXX\s+([A-Z0-9\-@#$.]+)/i);
  R.execName = (nm ? nm[1] : base(fname)).toUpperCase();
  const lines = text.split(/\r?\n/);
  // internal labels: LABEL: — so an internal jump is not mistaken for an external call
  const labels = new Set();
  lines.forEach(raw => { const lm = raw.match(/^\s*([A-Z][A-Z0-9\-@#$]*)\s*:\s*$/i); if (lm) labels.add(lm[1].toUpperCase()); });
  // code outside block comments /* */ (non-nested), '...' literals kept
  let inCmt = false;
  const codeAt = [];
  lines.forEach((raw, idx) => {
    let l = raw, out = '';
    while (l.length){
      if (inCmt){
        const e = l.indexOf('*/');
        if (e < 0){ l = ''; break; }
        l = l.slice(e + 2); inCmt = false;
      } else {
        const s = l.search(/\/\*|'/);
        if (s < 0){ out += l; break; }
        if (l[s] === "'"){
          out += l.slice(0, s);
          let j = s + 1;
          while (j < l.length){ if (l[j] === "'"){ if (l[j+1] === "'"){ j += 2; continue; } break; } j++; }
          out += l.slice(s, Math.min(j + 1, l.length)); l = l.slice(Math.min(j + 1, l.length));
        } else { out += l.slice(0, s); l = l.slice(s + 2); inCmt = true; }
      }
    }
    if (out.trim()) codeAt.push({ ln: idx + 1, code: out });
  });
  const SEG = '[A-Z0-9\\-#@]{1,8}';
  codeAt.forEach(({ ln, code }) => {
    const U = code.toUpperCase();
    let m;
    const callRe = /\bCALL\s+(?:'([^']*)'|([A-Z][A-Z0-9\-@#$.]*))/g;
    while ((m = callRe.exec(U))){
      if (m[1] !== undefined){ if (m[1].trim()) R.calls.push({ target: m[1].trim(), quoted: true, ln }); }
      else if (m[2] === 'ON' || m[2] === 'OFF') continue;         // CALL ON/OFF condition — not a call
      else if (labels.has(m[2])) continue;                         // internal label
      else R.calls.push({ viaVar: m[2], ln });                     // CALL via variable — unknown target
    }
    const dsnRe = new RegExp("'(" + SEG + "(?:\\." + SEG + ")+)(\\([A-Z0-9\\-#@$.]+\\))?'", 'g');
    while ((m = dsnRe.exec(U))) R.dsns.push({ name: m[1], member: m[2] ? m[2].slice(1, -1) : null, ln });
  });
  R.dsns = [...new Map(R.dsns.map(d => [d.name, d])).values()]; // deduplicated, first line number kept
  return R;
}

function parseJCL(text, members){
  const warnings = [];
  const stmts = resolveIncludes(tokenizeStatements(text, warnings), members || {}, [], warnings);
  const result = { jobs: [], procs: {}, warnings };
  let job = null;
  let procDef = null;
  let procStack = [];
  let condStack = [];
  let globalSymbols = {};
  for (const st of stmts) {
    switch (st.op) {
      case 'JOB':
        job = { name: st.name, line: st.line, params: parseParams(st.operands), steps: [], procsUsed: [] };
        result.jobs.push(job);
        procDef = null; procStack = []; condStack = [];
        break;
      case 'SET':
        Object.assign(globalSymbols, parseParams(st.operands));
        break;
      case 'PROC':
        if (st.name) {
          // nested in-stream PROCs: stack of definitions, PEND restores the parent
          procStack.push(procDef);
          procDef = { name: st.name.toUpperCase(), defaults: parseParams(st.operands), steps: [] };
          if (result.procs[procDef.name])
            warnings.push(`L${st.line}: PROC ${procDef.name} redefined (ambiguous definition) — the later definition wins for EXEC resolution, the earlier one is ignored`);
          result.procs[procDef.name] = procDef;
        } else if (job) {
          // PROC without name (JOB statement): symbolic defaults for this job
          Object.assign(globalSymbols, parseParams(st.operands));
        }
        break;
      case 'PEND':
        procDef = procStack.pop() || null;
        break;
      case 'EXEC': {
        const p = parseParams(st.operands);
        let kind = null, target = null;
        if (p.PGM !== undefined) { kind = 'PGM'; target = p.PGM; }
        else if (p.PROC !== undefined) { kind = 'PROC'; target = p.PROC; }
        else {
          const pos = Object.entries(p).find(([k, v]) => v === true && !EXEC_STD_PARAMS.has(k));
          if (pos) { kind = 'PROC'; target = pos[0]; }
          else warnings.push(`L${st.line}: EXEC without PGM or PROC`);
        }
        const step = {
          name: st.name, line: st.line, kind,
          condition: condStack.length ? { ...condStack[condStack.length - 1] } : null,
          dds: [], overrides: {}, symbols: {},
        };
        // phase 4: COND= (return test) and RD= (restart) — captured, never lost
        if (p.COND !== undefined && p.COND !== true) step.cond = String(p.COND).toUpperCase();
        if (p.RD !== undefined && p.RD !== true) step.rd = String(p.RD).toUpperCase();
        if (target) step.target = substitute(String(target), globalSymbols).toUpperCase();
        for (const [k, v] of Object.entries(p)) {
          if (k === 'PGM' || k === 'PROC') continue;
          if (k.includes('.')) step.overrides[k.toUpperCase()] = v;
          else if (!EXEC_STD_PARAMS.has(k)) step.symbols[k] = v;
        }
        if (procDef) procDef.steps.push(step);
        else if (job) job.steps.push(step);
        else warnings.push(`L${st.line}: EXEC outside of job ignored`);
        break;
      }
      case 'DD': {
        const owner = procDef ? procDef.steps : (job ? job.steps : []);
        const step = owner[owner.length - 1];
        if (!step) { warnings.push(`L${st.line}: DD outside of step ignored`); break; }
        const dd = buildDD(st, parseParams(st.operands), globalSymbols);
        if (st.inline && st.inline.length) dd.inline = st.inline; // in-stream cards captured (SORT, SYSTSIN…)
        step.dds.push(dd);
        break;
      }
      case 'IF':
        condStack.push({ text: st.operands.trim().replace(/\s+THEN\s*$/i,''), neg: false });
        break;
      case 'ELSE':
        if (condStack.length) condStack[condStack.length - 1].neg = true;
        break;
      case 'ENDIF':
        condStack.pop();
        break;
      case 'INCLUDE':
        // already handled by resolveIncludes: member spliced if uploaded, precise warning otherwise
        break;
      case 'JCLLIB':
        result.jcllib = st.operands.trim();
        break;
      case 'OUTPUT': case 'COMMAND': case 'XMIT': case 'CNTL': case 'ENDCNTL': case 'EXPORT':
        warnings.push(`L${st.line}: ${st.op} statement ignored (not needed for mapping)`);
        break;
      default:
        warnings.push(`L${st.line}: unknown operation ${st.op}`);
    }
  }
  // ── Post-pass phase 3 : cartes SORT (PGM=SORT/ICEMAN) + EXEC REXX/CLIST (IKJEFT01) ──
  const allSteps = [];
  result.jobs.forEach(jb => (jb.steps || []).forEach(s => allSteps.push(s)));
  Object.values(result.procs).forEach(p => (p.steps || []).forEach(s => allSteps.push(s)));
  allSteps.forEach(st => {
    if (st.kind !== 'PGM') return;
    const dds = st.dds || [];
    const target = String(st.target || '').toUpperCase();
    if (target === 'SORT' || target === 'ICEMAN' || target === 'DFSORT'){
      const sysin = dds.find(d => d.ddname === 'SYSIN');
      if (sysin && sysin.inline && sysin.inline.length){
        st.sortInfo = parseSortCards(sysin.inline.map(l => l.text).join('\n'));
        // OUTFIL FNAMES/OUTDD: these DDs are REAL outputs of the sort —
        // usage established even without DISP, never left "unknown".
        ((st.sortInfo.outfil || []).flatMap(x => x.names || [])).forEach(nm => {
          const dd = dds.find(d => d.ddname === nm);
          if (dd && dd.usage !== 'input'){
            if (dd.usage === 'unknown') dd.usage = 'output';
            dd.outfil = true;
          }
        });
        if (st.sortInfo.type === 'sort' && !st.sortInfo.decoded)
          warnings.push(`L${st.line}: SORT step ${st.name}: cards present but fields not decoded (unusual form) — shown as undecoded`);
      } else if (sysin && sysin.name){
        warnings.push(`L${st.line}: SORT step ${st.name}: SYSIN is a dataset (DSN=${sysin.name}) not uploaded — sort fields unknown`);
      } else {
        warnings.push(`L${st.line}: SORT step ${st.name}: no SYSIN cards captured — sort fields unknown`);
      }
    }
    if (target === 'IKJEFT01' || target === 'IKJEFT01B'){
      const sysin = dds.find(d => d.ddname === 'SYSTSIN');
      if (sysin && sysin.inline && sysin.inline.length){
        const txt = sysin.inline.map(l => l.text).join('\n');
        const m = txt.toUpperCase().match(/EXEC\s+'?([A-Z0-9\-@#$.]+(?:\([A-Z0-9\-@#$.]+\))?)/);
        if (m){
          let member = m[1];
          const dm = member.match(/^([A-Z0-9\-@#$.]+)\(([A-Z0-9\-@#$.]+)\)$/);
          if (dm) member = dm[2]; // EXEC 'dsn(member)' → membre
          st.rexxExec = member;
        } else {
          warnings.push(`L${st.line}: IKJEFT01 step ${st.name}: SYSTSIN present but no EXEC 'member' found — executed member unknown`);
        }
      } else if (sysin && sysin.name){
        warnings.push(`L${st.line}: IKJEFT01 step ${st.name}: SYSTSIN is a dataset (DSN=${sysin.name}) not uploaded — executed member unknown`);
      }
    }
  });
  linkProcs(result);
  return result;
}

// ── Global linking: "cataloged" PROCs and nested PROCs ──────────────
// The browser cannot reach your PROCLIB, but if you drop your
// PROC files next to your JCL, they are resolved as cataloged procs.
// Idempotent: called at each buildGraph, does nothing once everything is resolved.
function linkCatalogedProcs(){
  const registry = {};
  state.files.forEach(f=>{ if (f.lang === 'JCL' && f.parsed.procs) Object.keys(f.parsed.procs).forEach(pn=>{
    // same PROC name in several files: the last one wins (historical Object.assign) — flagged, never silent
    if (registry[pn] && !(f.parsed.warnings||[]).some(w => w.includes(`PROC ${pn} defined in multiple files`)))
      (f.parsed.warnings = f.parsed.warnings || []).push(`PROC ${pn} defined in multiple files (ambiguous definition) — the later file (${f.name}) wins for EXEC resolution`);
    registry[pn] = f.parsed.procs[pn];
  }); });
  let changed = true, guard = 0;
  while (changed && guard < 25){
    changed = false; guard++;
    state.files.forEach(f=>{
      if (f.lang !== 'JCL' || !f.parsed.jobs) return;
      f.parsed.jobs.forEach(jb=>{
        for (let i = 0; i < jb.steps.length; i++){
          const s = jb.steps[i];
          if (s.kind !== 'PROC' || !s.target || s.resolved) continue;
          if ((s.chain || []).includes(s.target)) continue; // recursion already flagged
          const proc = registry[s.target];
          if (!proc) continue;
          if ((s.chain || []).length >= 10 || jb.steps.length > 200) continue; // guard rail
          s.resolved = true;
          jb.procsUsed = jb.procsUsed || [];
          jb.procsUsed.push(proc.name);
          const symbols = { ...proc.defaults, ...s.symbols };
          const copies = [];
          for (const ps of proc.steps){
            const copy = JSON.parse(JSON.stringify(ps));
            copy.proc = proc.name;
            copy.via = s.name;
            copy.chain = [...(s.chain || []), proc.name];
            for (const dd of copy.dds){
              if (dd.name){
                dd.name = substitute(dd.name, symbols);
                if (dd.name.includes('&')) copy.hasUnresolvedSymbols = true;
              }
            }
            for (const [ov, val] of Object.entries(s.overrides || {})){
              const parts = ov.split('.');
              const ddname = parts.length >= 3 ? parts[1].toUpperCase() : parts[0].toUpperCase();
              const param = (parts.length >= 3 ? parts.slice(2) : parts.slice(1)).join('.').toUpperCase();
              const dd = copy.dds.find(d => (d.ddname || '').toUpperCase() === ddname);
              if (dd) dd['ov_' + param] = val;
            }
            copies.push(copy);
          }
          // overrides "//STEP.DD DD …" of the calling step: applied to the copies, with a warning if unresolved
          applyProcDdOverrides(s, proc, copies, symbols, msg => (f.parsed.warnings = f.parsed.warnings || []).push(`${f.name}: ${msg}`));
          jb.steps.splice(i, 1, ...copies);
          i += copies.length - 1;
          changed = true;
          // remove the obsolete "PROC … not found" warning
          if (f.parsed.warnings) f.parsed.warnings = f.parsed.warnings.filter(w => !w.includes(`PROC ${s.target} not found`));
        }
      });
    });
  }
  // flag the remaining recursive calls
  state.files.forEach(f=>{
    if (f.lang !== 'JCL' || !f.parsed.jobs || !f.parsed.warnings) return;
    f.parsed.jobs.forEach(jb=>jb.steps.forEach(s=>{
      if (s.kind === 'PROC' && s.target && (s.chain || []).includes(s.target)
          && !f.parsed.warnings.some(w => w.includes(`recursive PROC ${s.target}`)))
        f.parsed.warnings.push(`recursive PROC call to ${s.target} detected — not expanded`);
    }));
  });
}

// ══════════════════ 1b. COBOL ENGINE v3 ══════════════════
