// Nodes 'type|name' (job, step, prog, cpy, ds, tbl, xpgm); edges {f,t,k,c,ev}
// with kinds exec/contains/read/write/update/unknown/uses/call/sql-*, conf
// certain/probable/unknown and evidence [{file,ln,note}]. Typed IDs → no
// collision between a dataset and a program with the same name.

// A job name is disambiguated (name[file]) only if it exists in MULTIPLE
// uploaded files — otherwise the raw name is kept. The result is
// precomputed once: all loops (JCL, COBOL, backrefs) get
// exactly the same identifier for a given job.

const CONF_RANK = { certain: 3, probable: 2, unknown: 1 };
// ── Warning severity: 1 = blocks understanding (missing member/program),
// 2 = uncertainty (unknown value, dead code), 3 = informational (restart, condition) ──
function warnSeverity(w){
  const u = String(w).toUpperCase();
  if (u.includes('CANNOT BE EXPANDED') || u.includes('NOT UPLOADED') || u.includes('NOT FOUND') || u.includes('NEVER EXECUTED OR CALLED')) return 1;
  if (u.includes('UNKNOWN') || u.includes('UNCLEAR') || u.includes('UNREACHABLE') || u.includes('COULD NOT BE RESOLVED') || u.includes('VARIABLE VALUE') || u.includes('DUPLICATE') || u.includes('AMBIGU')) return 2;
  return 3;
}

// ── COND/IF evaluation against real RCs of an uploaded job log ──────────────
// JCL rule: the step is BYPASSED if AT LEAST one test (code,OP[,step]) is
// TRUE for the RC of a previous step (of the named step if given). Without log
// uploaded, or if a concerned RC is missing → never evaluated.
function condTest(rc, code, op){
  if (op === 'GT') return rc > code;
  if (op === 'GE') return rc >= code;
  if (op === 'LT') return rc < code;
  if (op === 'LE') return rc <= code;
  if (op === 'EQ') return rc === code;
  if (op === 'NE') return rc !== code;
  return null;
}
// condStr : '(0,LT)' | '(0,LT,STEP01)' | '((0,LT),(8,LE))'. prevSteps : steps
// earlier steps with known RC (guaranteed by the caller). Returns {skip, note} or null.
function condEval(condStr, prevSteps){
  const s = String(condStr || '').replace(/\s+/g, '');
  if (!/^\(.*\)$/.test(s)) return null;
  const body = s.slice(1, -1);
  const subs = [];
  if (body.indexOf('(') >= 0){
    let d = 0, cur = '';
    for (const ch of body){
      if (ch === '('){ d++; if (d === 1) continue; }
      if (ch === ')'){ d--; if (d === 0){ subs.push(cur); cur = ''; continue; } }
      if (d >= 1) cur += ch;
      else if (d === 0 && ch !== '(' && ch !== ')') { /* separator outside sub-test */ }
    }
    if (cur.trim()) subs.push(cur.trim());
    if (!subs.length) return null;
  } else subs.push(body);
  const notes = [];
  let skip = false;
  for (const sub of subs){
    const mt = /^(\d+),(GT|GE|LT|LE|EQ|NE)(?:,([A-Z0-9@#$.\-]+))?$/.exec(sub);
    if (!mt) return null; // unsupported form (EVEN/ONLY handled earlier)
    const code = parseInt(mt[1], 10), op = mt[2], named = mt[3] || null;
    const targets = named ? prevSteps.filter(p => p.name === named) : prevSteps;
    if (!targets.length) return null; // named step absent from known RCs
    let anyTrue = false;
    for (const p of targets){
      const r = condTest(p.rc, code, op);
      if (r === null) return null;
      notes.push(p.name + ' RC=' + String(p.rc).padStart(4, '0') + ' → ' + p.rc + ' ' + op + ' ' + code + ' = ' + (r ? 'true' : 'false'));
      if (r) anyTrue = true;
    }
    if (anyTrue) skip = true;
  }
  return { skip, note: notes.join(' ; ') };
}

function buildModel(files){
  linkCatalogedProcs();
  const nodes = new Map();
  const edges = [];
  const fwd = {}, rev = {};
  const addNode = (type, name, data) => {
    const id = type + '|' + name;
    if (!nodes.has(id)) nodes.set(id, { id, type, name, data: data || {} });
    return nodes.get(id);
  };
  const eIdx = new Map();
  const addEdge = (f, t, k, c, ev) => {
    // O(1) deduplication: same (from,to,kind) → merge evidence, strongest confidence wins
    const key = f + '\u0001' + t + '\u0001' + k;
    const ex = eIdx.get(key);
    if (ex){
      if ((CONF_RANK[c] || 0) > (CONF_RANK[ex.c] || 0)) ex.c = c;
      (ev || []).forEach(x => { if (!ex.ev.some(y => y.note === x.note)) ex.ev.push(x); });
      return ex;
    }
    const e = { f, t, k, c: c || 'certain', ev: ev || [] };
    edges.push(e);
    eIdx.set(key, e);
    (fwd[f] = fwd[f] || []).push(e);
    (rev[t] = rev[t] || []).push(e);
    return e;
  };
  const m = { nodes, edges, fwd, rev, warnings: [], internal: {}, unknownCalls: [] };
  // ── P1 pre-pass: duplicate identifiers — never merge two programs
  // or two distinct steps, and always flag it ──
  // 1) identical PROGRAM-ID in several files: each file keeps its
  //    own node (NAME, NAME#2…), EXEC/CALL point to the 1st definition + warning.
  const progKeyOf = new Map(); // file.name → prog node name (disambiguated)
  const progDups = [];
  {
    const byPid = new Map();
    files.forEach(f => { if (f.lang === 'CBL' && f.parsed.cobol && f.parsed.cobol.programId){
      const pid = f.parsed.cobol.programId;
      const arr = byPid.get(pid) || []; arr.push(f.name); byPid.set(pid, arr);
      progKeyOf.set(f.name, arr.length > 1 ? pid + '#' + arr.length : pid);
    }});
    byPid.forEach((arr, pid) => { if (arr.length > 1) progDups.push({ pid, arr }); });
  }
  progDups.forEach(d => m.warnings.push('duplicate PROGRAM-ID: program ' + d.pid + ' is defined in ' + d.arr.length +
    ' files (' + d.arr.join(', ') + ') — two distinct programs, nodes disambiguated (' + d.pid + ', ' + d.pid + '#2…); ' +
    'EXEC/CALL edges point to the first definition, the step may run either version'));
  // 2) same-name steps within one job: disambiguated nodes (S1, S1#2…), warning
  files.forEach(f => { if (f.lang !== 'JCL') return; (f.parsed.jobs || []).forEach(jb => {
    const seen = new Map();
    (jb.steps || []).forEach(st => {
      const n = seen.get(st.name) || 0;
      st._sname = n ? st.name + '#' + (n + 1) : st.name;
      seen.set(st.name, n + 1);
    });
  }); });
  // pre-pass: effective name of each job, stable for all loops
  const nameFiles = new Map();
  files.forEach(f => { if (f.lang === 'JCL') (f.parsed.jobs || []).forEach(jb => {
    const nm = jb.name || base(f.name);
    if (!nameFiles.has(nm)) nameFiles.set(nm, new Set());
    nameFiles.get(nm).add(f.name);
  }); });
  const jnameOf = (jb, f) => {
    const nm = jb.name || base(f.name);
    const fs = nameFiles.get(nm);
    return (fs && fs.size > 1) ? nm + '[' + f.name + ']' : nm;
  };

  // ── JCL ── (structure moteur JCL v2 : step.target/kind/line,
  //            dd.ddname/name/usage input|output|unknown/temp/backref/gdg/line)
  const OP_MAP = { input:'read', output:'write', unknown:'unknown' };
  const resolveDD = (jb, d) => {
    // effective dataset of a DD — follows a backref *.STEP.DD (1 hop) or *.PROCSTEP.STEP.DD (3 parts)
    if (!d.name) return null;
    if (!d.backref) return { name: d.name, temp: !!d.temp, gdg: d.gdg, via: null };
    const parts = String(d.name).split('.');
    if (parts.length >= 4){
      // *.PROCSTEP.STEP.DD — the calling step was expanded: copies identified by 'via'
      const inner = (jb.steps || []).find(s => s.via === parts[1] && s.name === parts[2]);
      const src = inner && (inner.dds || []).find(x => (x.ddname || '').toUpperCase() === String(parts[3] || '').toUpperCase());
      if (src && src.name && !src.backref) return { name: src.name, temp: !!src.temp, gdg: src.gdg, via: d.name };
      return null;
    }
    const srcStep = parts[1], srcDD = parts[2];
    const st = (jb.steps || []).find(s => s.name === srcStep);
    const src = st && (st.dds || []).find(x => (x.ddname || '').toUpperCase() === String(srcDD || '').toUpperCase());
    if (src && src.name && !src.backref) return { name: src.name, temp: !!src.temp, gdg: src.gdg, via: d.name };
    return null;
  };
  // Uploaded execution job logs: real RCs per step — the ONLY
  // legitimate source to evaluate COND/IF. No invented RC: without log, nothing changes.
  const jobLogs = new Map(); // 'JOB' -> Map stepname -> {rc, abend, flushed}
  files.forEach(f => {
    if (f.lang === 'JOBLOG' && f.parsed && f.parsed.joblog)
      (f.parsed.joblog.logs || []).forEach(l => {
        if (!jobLogs.has(l.job)) jobLogs.set(l.job, new Map());
        const mm = jobLogs.get(l.job);
        l.steps.forEach(s => mm.set(s.name, s));
      });
  });
  files.forEach(f => {
    if (f.lang !== 'JCL') return;
    (f.parsed.jobs || []).forEach(jb => {
      const jname = jnameOf(jb, f);
      addNode('job', jname, { file: f.name, rd: (jb.params && typeof jb.params.RD === 'string') ? jb.params.RD.toUpperCase() : null, rerun: (jb.params && typeof jb.params.RERUN === 'string') ? jb.params.RERUN.toUpperCase() : null });
      if (jb.params && (jb.params.RD || jb.params.RERUN))
        m.warnings.push('job ' + jname + ': RD/RERUN restart parameter present (' + (jb.params.RD ? 'RD=' + jb.params.RD : 'RERUN=' + jb.params.RERUN) + ') — execution may be resumed or repeated; relations shown are structural, not run counts');
      (jb.steps || []).forEach((st, sti) => {
        const sname = st._sname || st.name; // same-name steps → S1, S1#2 (pre-pass above)
        const sid = 'step|' + jname + '.' + sname;
        addNode('step', jname + '.' + sname, { job: jname, pgm: st.target, kind: st.kind,
          condition: st.condition || null, cond: st.cond || null, rd: st.rd || null,
          sort: st.sortInfo || null });
        if (sname !== st.name) m.warnings.push('duplicate step name ' + st.name + ' in job ' + jname + ' — two distinct steps, nodes disambiguated (' + st.name + ', ' + sname + '); backrefs by step name resolve to the first occurrence');
        // Job log uploaded for THIS job: real RC/ABEND/flush of the step — shown,
        // never turned into an invented relation.
        const ljob = jobLogs.get(jname) || null;
        const rcInfo = ljob ? (ljob.get(st.name) || null) : null;
        if (rcInfo){
          const stN = nodes.get(sid);
          if (stN && stN.data){ stN.data.rc = rcInfo.rc; stN.data.abend = rcInfo.abend || null; stN.data.flushed = !!rcInfo.flushed; }
          st.rcObs = rcInfo.rc != null ? rcInfo.rc : null;
          st.abendObs = rcInfo.abend || null;
          st.flushedObs = !!rcInfo.flushed;
          if (rcInfo.abend) m.warnings.push('step ' + jname + '.' + sname + ' ABENDED (' + rcInfo.abend + ') per uploaded job log — real run: downstream steps may have been flushed, relations shown are structural');
          if (rcInfo.flushed) m.warnings.push('step ' + jname + '.' + sname + ' WAS FLUSHED (not executed) per uploaded job log — its relations did NOT execute in this run');
        }
        if (st.cond || st.condition){
          // COND=EVEN / COND=ONLY: fixed JCL semantics, classifiable without
          // knowing the return codes — never an invented evaluation.
          const cd = String(st.cond || '');
          if (/EVEN\)?$/.test(cd.replace(/\s/g, '')))
            m.warnings.push('step ' + jname + '.' + sname + ' has COND=EVEN — runs even after a previous abend: relations shown are reliable');
          else if (/ONLY\)?$/.test(cd.replace(/\s/g, '')))
            m.warnings.push('step ' + jname + '.' + sname + ' has COND=ONLY — runs ONLY after a preceding abend: exceptional path, relations assume it runs');
          else {
            // COND=(code,OP[,step]) / IF (RC op n): evaluable ONLY if the
            // uploaded job log gives the real RC of each concerned earlier step
            // (no abend nor flush) — otherwise the structural warning remains.
            const prior = (jb.steps || []).slice(0, sti);
            const priorKnown = ljob && prior.length > 0 && prior.every(ps => { const p = ljob.get(ps.name); return p && p.rc != null && !p.abend && !p.flushed; });
            let verdict = null;
            if (priorKnown){
              if (st.cond){
                verdict = condEval(st.cond, prior.map(ps => ({ name: ps._sname || ps.name, rc: ljob.get(ps.name).rc })));
              } else if (st.condition && /^\(\s*RC\s*(=|<>|<|>|<=|>=)\s*\d+\s*\)$/.test(st.condition.text || '')){
                // IF (RC op n): RC = highest return code of the already executed steps
                const mt = /^\(\s*RC\s*(=|<>|<|>|<=|>=)\s*(\d+)\s*\)$/.exec(st.condition.text);
                const maxRc = Math.max.apply(null, prior.map(ps => ljob.get(ps.name).rc));
                const op = { '=': 'EQ', '<>': 'NE', '<': 'LT', '>': 'GT', '<=': 'LE', '>=': 'GE' }[mt[1]];
                const r = condTest(maxRc, parseInt(mt[2], 10), op);
                const true_ = st.condition.neg ? !r : r; // valeur de l expression IF
                verdict = { skip: !true_, note: 'max previous RC=' + String(maxRc).padStart(4, '0') + ' ' + st.condition.text + (st.condition.neg ? ' (NOT)' : '') + ' = ' + (true_ ? 'true' : 'false') };
              }
            }
            if (verdict){
              st.condEval = verdict; // shown in stepDesc
              m.warnings.push('step ' + jname + '.' + sname + ' conditional (' + (st.cond ? 'COND=' + st.cond : 'IF ' + (st.condition.neg ? 'NOT ' : '') + st.condition.text) + ') EVALUATED against uploaded job log (' + verdict.note + '): ' + (verdict.skip ? 'BYPASSED in this run — its relations did NOT execute in this run (one observed run, not a guarantee)' : 'EXECUTED in this run — relations confirmed by this run'));
            } else {
              m.warnings.push('step ' + jname + '.' + sname + ' is conditional (' + (st.cond ? 'COND=' + st.cond : 'IF ' + (st.condition.neg ? 'NOT ' : '') + st.condition.text) + ') — relations assume execution happens; the condition is not evaluated');
            }
          }
        }
        if (st.rd) m.warnings.push('step ' + jname + '.' + sname + ': RD=' + st.rd + ' (automatic restart on ABEND) — the step may run twice; relations unchanged');
        addEdge('job|' + jname, sid, 'contains', 'certain', [{ file: f.name, ln: st.line, note: 'EXEC ' + (st.target || '?') }]);
        // EXEC PGM → prog (uploaded) or xpgm (external); unresolved PROC → warning, never an invented edge
        if (st.kind === 'PGM' && st.target){
          const isCbl = files.some(x => x.lang === 'CBL' && x.parsed.cobol && x.parsed.cobol.programId === st.target);
          const pid = (isCbl ? 'prog|' : 'xpgm|') + st.target;
          addNode(isCbl ? 'prog' : 'xpgm', st.target, { file: isCbl ? files.find(x => x.lang==='CBL' && x.parsed.cobol && x.parsed.cobol.programId===st.target).name : null });
          addEdge(sid, pid, 'exec', 'certain', [{ file: f.name, ln: st.line, note: 'EXEC PGM=' + st.target }]);
          // IKJEFT01 + SYSTSIN cards: EXEC 'member' → uploaded REXX (certain), otherwise honest warning
          if ((st.target === 'IKJEFT01' || st.target === 'IKJEFT01B') && st.rexxExec){
            const mem = st.rexxExec;
            const rx = files.find(x => x.lang === 'REXX' && x.parsed.rexx && x.parsed.rexx.execName === mem);
            const cb = files.find(x => x.lang === 'CBL' && x.parsed.cobol && x.parsed.cobol.programId === mem);
            if (rx) addEdge(sid, 'prog|' + mem, 'exec', 'certain', [{ file: f.name, ln: st.line, note: "IKJEFT01 SYSTSIN EXEC '" + mem + "'" }]);
            else if (cb) addEdge(sid, 'prog|' + mem, 'exec', 'certain', [{ file: f.name, ln: st.line, note: "IKJEFT01 SYSTSIN EXEC '" + mem + "' (COBOL)" }]);
            else m.warnings.push("EXEC '" + mem + "' (REXX/CLIST) in " + jname + "." + (st._sname || st.name) + " not uploaded — cannot be expanded");
          }
        } else if (st.kind === 'PROC'){
          if (st.resolved === false) m.warnings.push('PROC ' + st.target + ' in ' + jname + '.' + (st._sname || st.name) + ' not uploaded — cannot be expanded');
          else if (st.target) addEdge(sid, 'xpgm|' + st.target, 'exec', 'unknown', [{ file: f.name, ln: st.line, note: 'EXEC PROC=' + st.target }]);
        }
        (st.dds || []).forEach(d => {
          if (!d.name || d.backref) return; // backrefs resolved below; SYSOUT/DUMMY without DSN ignored
          const op = OP_MAP[d.usage] || 'unknown';
          const dsNode = addNode('ds', d.name, { temp: !!d.temp || String(d.name).startsWith('&&'), gdg: d.gdg != null ? d.gdg : null });
          addEdge(sid, dsNode.id, op, op === 'unknown' ? 'unknown' : 'probable',
            [{ file: f.name, ln: d.line, note: 'DD ' + d.ddname + ' DSN=' + d.name + (d.gdg != null ? ' (GDG ' + (d.gdg > 0 ? '+' : '') + d.gdg + ')' : '') + (d.overriddenBy ? ' — overridden by ' + d.overriddenBy : '') + (d.disp ? ' DISP=' + d.disp + ' — direction from DISP only, not confirmed by program I/O' : ' (no DISP)') }]);
          if (op === 'unknown') m.warnings.push('dataset ' + d.name + ': usage unclear (no DISP, no matching program) — flagged, not guessed');
        });
      });
      // intra-job GDG: after a write (+1), a read (0) consumes the
      // generation JUST CREATED in this job; a read (−1) or older
      // reads an EARLIER generation — flagged explicitly, never hidden
      // by the shared node of the GDG base.
      const gdgW = new Map();
      (jb.steps || []).forEach(st2 => {
        (st2.dds || []).forEach(d => {
          if (d.gdg == null || !d.name) return;
          if (d.usage === 'output' && d.gdg >= 0) gdgW.set(d.name, { gen: d.gdg, step: st2._sname || st2.name });
          else if (d.usage === 'input' && gdgW.has(d.name) && d.gdg < gdgW.get(d.name).gen - 1){
            m.warnings.push('GDG ' + d.name + ': step ' + (st2._sname || st2.name) + ' reads generation (' + (d.gdg > 0 ? '+' : '') + d.gdg + ') but step ' + gdgW.get(d.name).step + ' wrote (+' + gdgW.get(d.name).gen + ') earlier in this job — an OLDER generation, not the one created here');
          }
        });
      });
    });
  });

  // ── Cross-job: datasets shared between jobs — job→job "feed" edges.
  // The real execution order is NOT known offline (no scheduler):
  // the write→read direction is inferred from DD usages only, never invented,
  // and each edge is marked "probable". Unknown usage → no inference.
  // A temporary (&&) dataset never leaves its job.
  const dsJobs = new Map();
  files.forEach(f => {
    if (f.lang !== 'JCL') return;
    (f.parsed.jobs || []).forEach(jb => {
      const jn = jnameOf(jb, f);
      (jb.steps || []).forEach(st => (st.dds || []).forEach(d => {
        if (!d.name || d.backref) return;
        if (d.usage !== 'input' && d.usage !== 'output') return; // unknown direction → honest: nothing
        if (d.temp || String(d.name).startsWith('&&')) return;
        const e2 = dsJobs.get(d.name) || { w: [], r: [] };
        (d.usage === 'output' ? e2.w : e2.r).push({ job: jn, file: f.name, ln: d.line, step: st._sname || st.name, gen: d.gdg, ddname: d.ddname });
        dsJobs.set(d.name, e2);
      }));
    });
  });
  const seenPair = new Set();
  dsJobs.forEach((e2, dsn) => {
    e2.w.forEach(W => e2.r.forEach(R2 => {
      if (W.job === R2.job) return; // intra-job already handled (GDG warnings)
      const pk = W.job + '\u0001' + R2.job + '\u0001' + dsn;
      if (seenPair.has(pk)) return;
      seenPair.add(pk);
      const g = n => n != null ? ' (GDG ' + (n > 0 ? '+' : '') + n + ')' : '';
      let note = 'cross-job: ' + W.job + ' step ' + W.step + ' writes ' + dsn + g(W.gen) + ' (DD ' + W.ddname + '), ' + R2.job + ' step ' + R2.step + ' reads it' + g(R2.gen) + ' (DD ' + R2.ddname + ') — run order inferred from I/O direction only, scheduler not analyzed';
      if (W.gen != null && R2.gen != null && R2.gen < W.gen)
        note += ' — reader targets an OLDER generation than the one written here';
      addEdge('job|' + W.job, 'job|' + R2.job, 'feed', 'probable', [{ file: W.file, ln: W.ln, note }]);
    }));
  });

  // ── Scheduler: EXPLICIT execution orders (import) → CERTAIN ──
  // "JOB B AFTER A" declares that B runs after A: the order becomes certain.
  // A pair already inferred by shared dataset (probable feed) is promoted CERTAIN
  // with merged evidence; a pair without a shared dataset gets the
  // order-only edge (explicit "order only" note). Declared but absent jobs,
  // absent predecessors, cycles, jobs without a scheduler line → warnings.
  const schedFiles = files.filter(f => f.lang === 'SCHED' && f.parsed.sched);
  if (schedFiles.length){
    const jobsKnown = new Set([...nodes.values()].filter(n => n.type === 'job').map(n => n.name));
    const ensureJob = n => {
      if (!jobsKnown.has(n)){ addNode('job', n, { referenced: true, sched: true }); jobsKnown.add(n); }
      return 'job|' + n;
    };
    schedFiles.forEach(f => {
      (f.parsed.sched.deps || []).forEach(d => {
        if (!jobsKnown.has(d.job))
          m.warnings.push('scheduler: job ' + d.job + ' declared in ' + f.name + ' but not uploaded — order edges kept, endpoint unknown');
        (d.after || []).forEach(a => {
          if (!jobsKnown.has(a) && !schedFiles.some(sf => (sf.parsed.sched.deps || []).some(x => x.job === a)))
            m.warnings.push('scheduler: predecessor ' + a + ' (before ' + d.job + ') declared in ' + f.name + ' but not uploaded — order edge kept, source unknown');
          const ex = eIdx.get('job|' + a + '\u0001' + 'job|' + d.job + '\u0001' + 'feed');
          const note = ex
            ? 'scheduler: ' + d.job + ' runs AFTER ' + a + ' (explicit import ' + f.name + ') — order CONFIRMED, dataset-inferred feed upgraded to CERTAIN'
            : 'scheduler: ' + d.job + ' runs AFTER ' + a + ' (explicit import ' + f.name + ') — order confirmed by scheduler, no shared dataset detected (order only)';
          addEdge(ensureJob(a), ensureJob(d.job), 'feed', 'certain', [{ file: f.name, note }]);
        });
      });
    });
    // project job without a scheduler line → its cross-job order stays inferred (PROBABLE)
    jobsKnown.forEach(j => {
      const mentioned = schedFiles.some(f => (f.parsed.sched.deps || []).some(d => d.job === j || d.after.includes(j)));
      if (!mentioned) m.warnings.push('job ' + j + ': no scheduler line found — cross-job order stays dataset-inferred (PROBABLE) or unknown');
    });
  }

  // ── REXX ──
  files.forEach(f => {
    if (f.lang !== 'REXX' || !f.parsed.rexx) return;
    const R = f.parsed.rexx;
    const rid = addNode('prog', R.execName, { file: f.name, rexx: true }).id;
    R.calls.forEach(c => {
      if (c.quoted){
        const mem = (c.target.match(/\(([A-Z0-9\-@#$.]+)\)\s*$/)||[])[1] || null;
        const dsn = c.target.replace(/\([A-Z0-9\-@#$.]+\)\s*$/, '');
        const tgt = mem || (dsn.includes('.') ? null : dsn.toUpperCase());
        if (tgt){
          const rx2 = files.find(x => x.lang === 'REXX' && x !== f && x.parsed.rexx && x.parsed.rexx.execName === tgt);
          const cb2 = files.find(x => x.lang === 'CBL' && x.parsed.cobol && x.parsed.cobol.programId === tgt);
          const isUp = !!(rx2 || cb2);
          addNode(isUp ? 'prog' : 'xpgm', tgt, { file: rx2 ? rx2.name : (cb2 ? cb2.name : null) });
          addEdge(rid, (isUp ? 'prog|' : 'xpgm|') + tgt, 'call', 'certain', [{ file: f.name, ln: c.ln, note: "REXX CALL '" + c.target + "'" }]);
        } else {
          // CALL 'dsn.without.member' → quoted dataset, exact target unknown: references edge, no invention
          const did = addNode('ds', dsn, { referenced: true }).id;
          addEdge(rid, did, 'references', 'unknown', [{ file: f.name, ln: c.ln, note: "REXX CALL '" + c.target + "' — member unknown" }]);
        }
      } else if (c.viaVar){
        m.warnings.push('REXX ' + R.execName + ': CALL via variable ' + c.viaVar + ' (line ' + c.ln + ') — target unknown, no edge invented');
      }
    });
    R.dsns.forEach(d => {
      const did = addNode('ds', d.name, { referenced: true }).id;
      addEdge(rid, did, 'references', 'unknown', [{ file: f.name, ln: d.ln, note: "REXX dataset reference '" + d.name + "' — access type (read/write) unknown" }]);
    });
  });

  // ── COBOL ──
  files.forEach(f => {
    if (f.lang !== 'CBL' && f.lang !== 'CPY') return;
    const C = f.parsed.cobol;
    if (!C) return;
    if (f.lang === 'CBL' && C.programId){
      // duplicate PROGRAM-ID: each file keeps its own node (DUPPGM, DUPPGM#2)
      const progName = progKeyOf.get(f.name) || C.programId;
      const pid = 'prog|' + progName;
      addNode('prog', progName, { file: f.name });
      // copybooks
      C.copyUsed.forEach(cu => {
        const cnode = addNode('cpy', cu.name, { file: cu.file || null });
        const resolved = cu.resolved;
        addEdge(pid, cnode.id, 'uses', resolved ? 'certain' : 'unknown', [{ file: f.name, ln: cu.ln, note: 'COPY ' + cu.name + (resolved ? '' : ' (not uploaded)') }]);
      });
      // CALLs
      C.calls.forEach(c => {
        if (!c.target) return;
        // IMS DL/I: system entry, not an application program to link —
        // handled below (honest detection, no invented edge).
        if (c.target === 'CBLTDLI' || c.target === 'ASMTDLI') return;
        const isCbl = files.some(x => x.lang === 'CBL' && x.parsed.cobol && x.parsed.cobol.programId === c.target);
        const tid = (isCbl ? 'prog|' : 'xpgm|') + c.target;
        addNode(isCbl ? 'prog' : 'xpgm', c.target, { file: isCbl ? files.find(x => x.lang==='CBL' && x.parsed.cobol && x.parsed.cobol.programId===c.target).name : null });
        const conf = c.resolved === true ? 'certain' : c.resolved === 'var' ? 'probable' : 'unknown';
        addEdge(pid, tid, 'call', conf, [{ file: f.name, ln: c.ln, note: 'CALL ' + (c.viaVar ? c.viaVar + ' (dynamic)' : c.target) }]);
        if (conf === 'unknown') m.unknownCalls.push(c);
      });
      // IMS DL/I (CALL CBLTDLI/ASMTDLI): detected and shown, never linked —
      // PCB/segments unknown offline, no invented edge, warning.
      if ((C.dli || []).length){
        const pnode = m.nodes.get(pid);
        if (pnode){
          pnode.data.ims = { calls: C.dli.length, ops: C.dli.map(d => d.op || 'UNKNOWN') };
          const withOp = C.dli.filter(d => d.op).map(d => d.op).join(', ');
          m.warnings.push('prog ' + progName + ': IMS DL/I program — ' + C.dli.length + ' CALL ' + C.dli[0].entry + (withOp ? ', op-codes: ' + withOp : ', op-codes unknown (dynamic)') + '. PCB/segment names are built at runtime, unknown offline — no relation invented');
        }
      }
      // DDNAME ↔ SELECT: certain link if an I/O verb exists (backrefs resolved)
      C.selects.forEach(sl => {
        C.fileOps[sl.file] && C.fileOps[sl.file].forEach(op => {
          // find the steps referencing this DDNAME (in the jobs)
          files.forEach(jf => {
            if (jf.lang !== 'JCL') return;
            (jf.parsed.jobs || []).forEach(jb => {
              (jb.steps || []).forEach(st => {
                if (String(st.target || '').toUpperCase() !== C.programId) return; // the step must run THIS program (DDNAMEs are local to a step)
                (st.dds || []).forEach(d => {
                  if ((d.ddname || '').toUpperCase() !== sl.dd) return;
                  const r = resolveDD(jb, d);
                  if (!r) return;
                  const dsNode = addNode('ds', r.name, { temp: r.temp, gdg: r.gdg });
                  const ev = [
                    { file: jf.name, ln: d.line, note: 'JCL: DD ' + d.ddname + ' DSN=' + (r.via ? r.via + ' → ' + r.name : r.name) + (r.gdg != null ? ' (GDG ' + (r.gdg > 0 ? '+' : '') + r.gdg + ')' : '') },
                    { file: f.name, ln: sl.ln, note: 'COBOL: SELECT ' + sl.file + ' ASSIGN TO ' + sl.dd },
                    { file: f.name, ln: op.ln, note: op.cics ? 'COBOL: EXEC CICS ' + op.cics + ' FILE(' + (op.cicsFile || sl.file) + ')' : 'COBOL: ' + op.op.toUpperCase() + ' ' + sl.file }
                  ];
                  addEdge('step|' + jnameOf(jb, jf) + '.' + (st._sname || st.name), dsNode.id, op.op, op.viaVar ? 'probable' : 'certain', ev);
                });
              });
            });
          });
        });
      });
      // SQL → tables (recognized operation only; unknown type already flagged by the parser)
      C.sql.forEach(x => {
        if (!['read','write','update'].includes(x.op)) return;
        x.tables.forEach(tb => {
          const tn = addNode('tbl', tb, {});
          addEdge(pid, tn.id, 'sql-' + x.op, 'certain', [{ file: f.name, ln: x.ln, note: 'EXEC SQL ' + x.op.toUpperCase() + ' — ' + tb }]);
        });
      });
      // EXEC CICS: linked programs (XCTL/LINK), maps, queues, FCT files
      // not attached. The reference is certain (it is written in the
      // code); what is unknown (dataset behind an FCT) stays unknown.
      C.cics.forEach(e => {
        if (e.program){
          const tgt = files.find(x => x.lang === 'CBL' && x.parsed.cobol && x.parsed.cobol.programId === e.program);
          const tid = (tgt ? 'prog|' : 'xpgm|') + e.program;
          addNode(tgt ? 'prog' : 'xpgm', e.program, { file: tgt ? tgt.name : null });
          addEdge(pid, tid, 'call', 'certain', [{ file: f.name, ln: e.ln, note: 'EXEC CICS ' + e.cmd + ' PROGRAM(' + e.program + ')' }]);
        }
        if (e.map){
          const mnode = addNode('map', e.map, {});
          addEdge(pid, mnode.id, 'uses', 'certain', [{ file: f.name, ln: e.ln, note: 'EXEC CICS ' + e.cmd + ' MAP(' + e.map + ')' }]);
        }
        if (e.queue){
          const qnode = addNode('q', e.queue, { qtype: e.qtype });
          addEdge(pid, qnode.id, e.op, 'certain', [{ file: f.name, ln: e.ln, note: 'EXEC CICS ' + e.cmd + (e.qtype ? ' ' + e.qtype : '') + ' QUEUE(' + e.queue + ')' }]);
        }
        if (e.op && e.file && !(C.cicsToFile && C.cicsToFile[e.file])){
          const fnode = addNode('fct', e.file, {});
          addEdge(pid, fnode.id, e.op, e.fileViaVar ? 'probable' : 'certain', [{ file: f.name, ln: e.ln, note: 'EXEC CICS ' + e.cmd + ' FILE(' + e.file + ')' + (e.fileViaVar ? ' (via variable, value traced)' : '') + ' — FCT entry, dataset unknown' }]);
        }
      });
      // internal flow for the flow panel
      const inn = { paragraphs: C.paragraphs, dead: C.dead || [], edges: [] };
      C.performs.forEach(p => inn.edges.push({ from: p.from, to: p.to, k: 'perform', ln: p.ln }));
      C.gotos.forEach(g => inn.edges.push({ from: g.from, to: g.to, k: 'goto', ln: g.ln }));
      C.cics.forEach(x => (x.handles || []).forEach(h => inn.edges.push({ from: x.para, to: h.to, k: 'handle', ln: x.ln })));
      m.internal[progName] = inn;
      // paragraphs/sections = graph nodes (navigable impact: job → step → prog → para)
      const paraIds = new Set(C.paragraphs.map(p=>p.name));
      C.paragraphs.forEach(p => {
        const pnode = addNode('para', progName + '.' + p.name, { program: progName, ln: p.ln, section: !!p.section, dead: (C.dead || []).some(d => d.name === p.name) });
        addEdge(pid, pnode.id, 'contains', 'certain', [{ file: f.name, ln: p.ln, note: p.section ? 'section header' : 'paragraph' }]);
      });
      const pEdge = (from, to, k, conf, note, ln2) => {
        if (!from || !paraIds.has(from) || !paraIds.has(to) || from === to) return;
        addEdge('para|' + progName + '.' + from, 'para|' + progName + '.' + to, k, conf, [{ file: f.name, ln: ln2, note }]);
      };
      // PERFORM/GO TO targets not defined (dynamic via variable, inline form):
      // never an invented edge, but explicitly flagged (limits card convention)
      C.performs.forEach(pr => {
        if (pr.to && pr.kind !== 'sort' && !paraIds.has(pr.to))
          m.warnings.push('PERFORM ' + pr.to + ' in ' + progName + ' (line ' + pr.ln + '): target unknown (not a defined paragraph — dynamic or inline form), no edge created');
      });
      C.gotos.forEach(g => {
        if (g.to && !paraIds.has(g.to))
          m.warnings.push('GO TO ' + g.to + ' in ' + progName + ' (line ' + g.ln + '): target unknown (not a defined paragraph — dynamic GO TO?), no edge created');
      });
      C.performs.forEach(pr => {
        pEdge(pr.from, pr.to, 'perform', 'certain', 'PERFORM ' + pr.to + (pr.thru ? ' THRU ' + pr.thru : ''), pr.ln);
        if (pr.thru) pEdge(pr.from, pr.thru, 'perform', 'certain', 'PERFORM ' + pr.to + ' THRU ' + pr.thru, pr.ln);
      });
      C.gotos.forEach(g => {
        pEdge(g.from, g.to, 'goto', g.depending ? 'probable' : 'certain', g.depending ? 'GO TO (DEPENDING ON — branch)' : 'GO TO', g.ln);
      });
      // EXEC CICS HANDLE CONDITION/AID err(PARA): explicit control transfer → certain edge
      C.cics.forEach(x => (x.handles || []).forEach(h => pEdge(x.para, h.to, 'handle', 'certain', 'EXEC CICS ' + x.cmd + ' ' + h.key + '(' + h.to + ')', x.ln)));
      if ((C.dead || []).length){
        m.warnings.push('dead code: ' + C.dead.length + ' unreachable paragraph(s) in ' + progName + ' (' +
          C.dead.slice(0, 6).map(d => d.name).join(', ') + (C.dead.length > 6 ? ', …' : '') +
          ') — never targeted by PERFORM/GO TO, no fall-through path');
      }
    }
    if (f.lang === 'CPY'){
      addNode('cpy', base(f.name), { file: f.name });
    }
  });

  // backrefs: *.STEP.DD → real dataset of the source step (JCL-only usage, no COBOL evidence → probable)
  files.forEach(f => {
    if (f.lang !== 'JCL') return;
    (f.parsed.jobs || []).forEach(jb => {
      const jname = jnameOf(jb, f);
      (jb.steps || []).forEach(st => {
        const sid = 'step|' + jname + '.' + (st._sname || st.name);
        (st.dds || []).forEach(d => {
          if (!d.backref) return;
          const r = resolveDD(jb, d);
          const op = OP_MAP[d.usage] || 'unknown';
          if (r){
            const dsNode = addNode('ds', r.name, { temp: r.temp, gdg: r.gdg });
            addEdge(sid, dsNode.id, op, op === 'unknown' ? 'unknown' : 'probable', [
              { file: f.name, ln: d.line, note: 'DD ' + d.ddname + ' DSN=' + d.name },
              { file: f.name, ln: d.line, note: 'resolves to ' + r.name }
            ]);
          } else {
            m.warnings.push('backref ' + d.name + ' in ' + jname + '.' + st.name + ' could not be resolved (source step/DD not found)');
          }
        });
      });
    });
  });

  // loaded programs never executed nor called in the analyzed set —
  // honest: may be called by NON-uploaded code (CICS START, scheduler…)
  [...nodes.values()].forEach(n => {
    if (n.type !== 'prog') return;
    const called = (rev[n.id] || []).some(e => e.k === 'exec' || e.k === 'call');
    if (!called) m.warnings.push('program ' + n.name + ' is never executed or called in the analyzed set — possibly dead, or called by code not uploaded (scheduler, CICS START, other jobs)');
  });

  // ── Additional dead code: datasets written never read, copybooks never COPYed ──
  // HONEST: "never read in the analyzed set" ≠ useless — other non-uploaded
  // jobs may consume it. No conclusion on unknown-usage datasets
  // (without DISP) nor on temporaries (uncertain intra-job scope)
  // nor on DB2 tables (read by applications outside the set). Signal
  // separate (m.dead), not a blocking warning.
  m.dead = { datasets: [], copybooks: [] };
  [...nodes.values()].forEach(n => {
    if (n.type === 'ds' && !n.data.temp){
      const inc = rev[n.id] || [];
      const hasUnknown = inc.some(e => e.k === 'unknown');
      const writeLike = inc.some(e => e.k === 'write' || e.k === 'update');
      const readLike = inc.some(e => e.k === 'read' || e.k === 'update');
      if (writeLike && !readLike && !hasUnknown) m.dead.datasets.push(n.name);
    } else if (n.type === 'cpy'){
      const used = (rev[n.id] || []).some(e => e.k === 'uses');
      if (!used) m.dead.copybooks.push(n.name);
    }
  });

  // phase 4: stable sort by severity — blocking warnings appear first
  m.warnings.sort((a, b) => warnSeverity(a) - warnSeverity(b));
  return m;
}

function impact(model, id){
  // BFS upstream/downstream, depth ≤ 12, shortest path per node,
  // confidence = the weakest along the path.
  // MULTI-PATHS: when several distinct shortest paths lead to the
  // same node, ALL are kept (up to 3 per node, anti-explosion
  // cap) — an impact is never reduced to one arbitrary route.
  const up = { direct: [], indirect: [] };
  const down = { direct: [], indirect: [] };
  const adj = model.fwd, radj = model.rev;
  // Depth-limit transparency (spec 4.3): when the BFS is stopped at the limit,
  // the caller MUST know the impact may be partial — never presented as exhaustive.
  const truncated = { fwd: false, rev: false };
  const walk = (graph, bucket, dir) => {
    const seen = new Map();
    const q = [{ id, depth: 0, path: [id], edge: null, conf: 'certain' }];
    while (q.length){
      const cur = q.shift();
      if (cur.depth >= 12){ truncated[dir] = true; continue; }
      const list = (dir === 'fwd' ? (adj[cur.id]||[]) : (radj[cur.id]||[]));
      for (const e of list){
        const next = dir === 'fwd' ? e.t : e.f;
        if (next === id) continue;
        const conf = e.c === 'certain' ? cur.conf : (cur.conf === 'certain' ? e.c : (cur.conf === 'probable' && e.c === 'certain' ? 'probable' : 'unknown'));
        const path = cur.path.concat([next]);
        const ex = seen.get(next);
        if (!ex){
          const rec = { id: next, depth: cur.depth + 1, path, edge: e, conf, paths: [{ path, conf, edge: e }] };
          seen.set(next, rec);
          (cur.depth + 1 === 1 ? bucket.direct : bucket.indirect).push(rec);
          q.push({ id: next, depth: cur.depth + 1, path, edge: e, conf });
        } else if (path.length === ex.path.length && ex.paths.length < 3
                   && !ex.paths.some(p => p.path.join('\u0001') === path.join('\u0001'))){
          // alternative path of the same length (BFS guarantees shortest
          // first): recorded, never hidden.
          ex.paths.push({ path, conf, edge: e });
        }
      }
    }
  };
  walk(adj, down, 'fwd');
  walk(radj, up, 'rev');
  return { up, down, depthLimit: 12,
    truncated: (truncated.fwd || truncated.rev) ? { fwd: truncated.fwd, rev: truncated.rev } : null };
}

function getModel(){
  if (!state._model){
    // re-parse of COBOL whose missing copybook arrived later
    let changed = true, guard = 0;
    while (changed && guard < 5){
      changed = false; guard++;
      const reg = cobRegistry();
      state.files.forEach(f => {
        // INCLUDE JCL: re-parse if a missing member arrived since
        if (f.lang === 'JCL' && (f.parsed.warnings||[]).some(w => {
          const mm = /INCLUDE member ([A-Z0-9@$.]+) not uploaded/.exec(w);
          return mm && jclMembers(f.name)[mm[1]] !== undefined;
        })){
          parseFile(f);
          changed = true;
        }
        if (f.lang !== 'CBL' || !f.parsed.cobol) return;
        if ((f.parsed.cobol.copyUsed||[]).some(c => !c.resolved && reg[c.name])){
          parseFile(f);
          changed = true;
        }
      });
    }
    state._model = buildModel(state.files);
    // ── Living graph: auto-snapshot after each (re)build. Deduplicated:
    // a rebuild that changes nothing does not create a new version. ──
    autoSnapshot();
  }
  return state._model;
}

// ══════════════════ LIVING GRAPH: versioned snapshots + diff over time ══════════════════
