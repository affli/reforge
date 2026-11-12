// Two DISTINCT engines (Priority 2):
//  • DETERMINISTIC ENGINE (this one): each recognized statement is translated by
//    fixed rules — never by guesswork. Each statement carries a status
//    (translated / approximated / unsupported), its original COBOL line and its
//    Python line, visible in the translation report.
//  • AI ENGINE (optional, later): any AI proposal should be VALIDATED
//    by this engine (structure + statuses) and labeled "AI-proposed" — never
//    mixed with the deterministic translation. No simulated AI output.
// Doctrine: what is not translated is displayed as such (comment
// [NOT TRANSLATED] + unsupported status). No Python code is invented.

const PY_CONF = { move: .95, compute: .9, arith: .9, if: .9, evaluate: .85, perform: .85, goto: .7, display: .95, initialize: .9, stop: .95, call: .9, set88: .85, nop: 1, sql: 0, cics: 0, io: 0, unknown: 0 };

function pyIdent(name){
  let s = String(name || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!s || /^[0-9]/.test(s)) s = 'p_' + s;
  return s;
}
function pyQuote(s){ return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

// PIC → Python type. Documented mapping, acknowledged approximation:
//  X/A → str, 9 → int, V → float (decimals serve ROUNDED),
//  S → signed (native in Python), COMP/COMP-3/BINARY → storage noted.
function pyPicType(v){
  const p = String(v.pic || '').toUpperCase();
  const digitsOf = (seg) => { let n = 0, mm; const re = /9(?:\((\d+)\))?/g; while ((mm = re.exec(seg))) n += mm[1] ? parseInt(mm[1], 10) : 1; return n; };
  if (!p) return null;
  if (/^[AX]/.test(p)){
    const d = digitsOf(p.replace(/[AX]/g, '9')) || 1;
    return { kind: 'str', len: d, decs: 0,
      note: 'PIC ' + p + ' → str' + (d > 1 ? ' (longueur ' + d + ' non contrainte en Python)' : '') + (v.usage ? ' [' + v.usage + ']' : '') };
  }
  const signed = /^S/.test(p);
  const body = p.replace(/^S/, '');
  const parts = body.split('V');
  const decs = digitsOf(parts[1] || '');
  const kind = decs > 0 ? 'float' : 'int';
  return { kind, decs, signed,
    note: 'PIC ' + p + ' → ' + kind + (decs > 0 ? ' (' + decs + ' decimals — float approximation, to validate for amounts)' : '') + (signed ? ' (signed)' : '') + (v.usage ? ' [' + v.usage + ']' : '') };
}

// ── tokenizer dedicated to the translation (literals preserved) ──
function trToks(t){
  const s = String(t).trim();
  const out = [];
  let i = 0;
  while (i < s.length){
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'" || ch === '"'){
      let j = i + 1;
      while (j < s.length && s[j] !== ch) j++;
      out.push({ t: 'lit', v: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if ('(),+-*/=<>:'.includes(ch)){ out.push({ t: 'op', v: ch }); i++; continue; }
    let m = s.slice(i).match(/^[A-Za-z][A-Za-z0-9\-]*/);
    if (m){ out.push({ t: 'w', v: m[0] }); i += m[0].length; continue; }
    // numerically prefixed identifier (numbered paragraphs: 1000-CALC, 0100-INIT)
    // → ONE word — otherwise "1000" becomes an unknown PERFORM target (real bug)
    m = s.slice(i).match(/^\d+[A-Za-z\-][A-Za-z0-9\-]*/);
    if (m){ out.push({ t: 'w', v: m[0] }); i += m[0].length; continue; }
    m = s.slice(i).match(/^\d+(?:\.\d+)?/);
    if (m){ out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    i++;
  }
  return out;
}
function trNormalize(toks){
  // merge of END+IF → END-IF, GO+TO → GOTO pairs (compound words)
  const out = [];
  for (let k = 0; k < toks.length; k++){
    const a = toks[k], b = toks[k + 1];
    if (a && b && a.t === 'w' && b.t === 'w'){
      const A = a.v.toUpperCase(), B = b.v.toUpperCase();
      if ((A === 'END' && ['IF', 'EVALUATE', 'PERFORM', 'SEARCH', 'PROGRAM'].includes(B)) || (A === 'GO' && B === 'TO')){
        out.push({ t: 'w', v: A === 'GO' ? 'GOTO' : A + '-' + B });
        k++;
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

const TR_VERBS = new Set(['MOVE','COMPUTE','ADD','SUBTRACT','MULTIPLY','DIVIDE','IF','EVALUATE','PERFORM','GOTO','DISPLAY','INITIALIZE','STOP','CALL','READ','WRITE','REWRITE','DELETE','OPEN','CLOSE','EXIT','CONTINUE','SET','ACCEPT','EXEC','STRING','UNSTRING','SEARCH','SORT','MERGE','RETURN','ALTER','GOBACK','NEXT']);
const TR_BLOCKS = new Set(['ELSE','END-IF','WHEN','END-EVALUATE','END-PERFORM','OTHER']);
const TR_KWS = new Set(['TO','FROM','BY','INTO','GIVING','UNTIL','THRU','THROUGH','TIMES','VARYING','ROUNDED','ON','SIZE','ERROR','REMAINDER','SENTENCE','WITH','TEST','BEFORE','AFTER','UPON','ALSO','RUN','TRUE','FALSE','OTHER','ELSE','END-IF','END-EVALUATE','END-PERFORM','DEPENDING']);

const PY_FIG = { SPACE: '" "', SPACES: '" "', ZERO: '0', ZEROS: '0', ZEROES: '0', NULL: 'None', LOWVALUE: '"\\x00"', LOWVALUES: '"\\x00"', HIGHVALUE: '"\\xff"', HIGHVALUES: '"\\xff"', QUOTE: '"\\x27"' };
function trVal(tok){
  if (!tok) return 'None';
  if (tok.t === 'lit') return pyQuote(tok.v);
  if (tok.t === 'num') return tok.v;
  if (tok.t === 'op') return tok.v;
  const U = tok.v.toUpperCase();
  if (PY_FIG[U] !== undefined) return PY_FIG[U];
  return pyIdent(tok.v);
}
const trIsWord = (tok, u) => !!tok && tok.t === 'w' && tok.v.toUpperCase() === u;

function trCond(toks, i, endStops){
  // reads a condition (symbolic comparisons and keywords included) up to a verb
  const parts = [];
  while (i < toks.length){
    const t = toks[i];
    if (t.t === 'w'){
      const U = t.v.toUpperCase();
      if (U === 'NOT'){ parts.push(' not '); i++; continue; }
      if (U === 'AND'){ parts.push(' and '); i++; continue; }
      if (U === 'OR'){ parts.push(' or '); i++; continue; }
      if (U === 'GREATER'){ i++; if (trIsWord(toks[i], 'THAN')) i++; if (trIsWord(toks[i], 'OR') && trIsWord(toks[i+1], 'EQUAL')){ parts.push(' >= '); i += 2; if (trIsWord(toks[i], 'TO')) i++; } else parts.push(' > '); continue; }
      if (U === 'LESS'){ i++; if (trIsWord(toks[i], 'THAN')) i++; if (trIsWord(toks[i], 'OR') && trIsWord(toks[i+1], 'EQUAL')){ parts.push(' <= '); i += 2; if (trIsWord(toks[i], 'TO')) i++; } else parts.push(' < '); continue; }
      if (U === 'EQUAL'){ parts.push(' == '); i++; if (trIsWord(toks[i], 'TO')) i++; continue; }
      if (U === 'UNEQUAL'){ parts.push(' != '); i++; continue; }
      if (endStops.has(U) || TR_VERBS.has(U)) break;
      parts.push(pyIdent(t.v)); i++; continue;
    }
    if (t.t === 'op'){
      if (t.v === '=') parts.push(' == ');
      else if (t.v === '>' && toks[i+1] && toks[i+1].t === 'op' && toks[i+1].v === '='){ parts.push(' >= '); i++; }
      else if (t.v === '<' && toks[i+1] && toks[i+1].t === 'op' && toks[i+1].v === '='){ parts.push(' <= '); i++; }
      else parts.push(' ' + t.v + ' ');
      i++;
      continue;
    }
    parts.push(trVal(t)); i++;
  }
  return { py: parts.join('').replace(/\s+/g, ' ').trim(), i };
}

function trIdents(toks, i){
  const ids = [];
  while (i < toks.length){
    const t = toks[i];
    if (t.t === ',' ){ i++; continue; }
    if (t.t === 'w' && !TR_VERBS.has(t.v.toUpperCase()) && !TR_KWS.has(t.v.toUpperCase()) && !TR_BLOCKS.has(t.v.toUpperCase())){ ids.push(t.v); i++; continue; }
    break;
  }
  return { ids, i };
}

function trStmts(toks, i, stops){
  const stmts = [];
  while (i < toks.length){
    const t = toks[i];
    if (t.t === ','){ i++; continue; }
    if (t.t === 'w' && stops.has(t.v.toUpperCase())) break;
    if (t.t === 'w' && TR_BLOCKS.has(t.v.toUpperCase()) && !stops.has(t.v.toUpperCase())) break;
    const r = trStmt(toks, i, stops);
    if (!r) break;
    stmts.push(r.stmt);
    i = r.i;
  }
  return { stmts, i };
}

function trStmt(toks, i, stops){
  const t = toks[i];
  if (!t || t.t !== 'w') return null;
  const U = t.v.toUpperCase();
  const stopAll = (extra) => { const s = new Set(stops); (extra || []).forEach(x => s.add(x)); return s; };
  switch (U){
    case 'MOVE': {
      i++;
      const srcs = [];
      while (i < toks.length && !trIsWord(toks[i], 'TO')){
        if (toks[i].t === ','){ i++; continue; }
        if (toks[i].t === 'w' && (TR_VERBS.has(toks[i].v.toUpperCase()) || stops.has(toks[i].v.toUpperCase()))) break;
        srcs.push(toks[i]); i++;
      }
      if (!srcs.length || !trIsWord(toks[i], 'TO')) return { stmt: { k: 'unknown', verb: 'MOVE' }, i: toks.length };
      i++;
      const d = trIdents(toks, i); i = d.i;
      return { stmt: { k: 'move', src: srcs[srcs.length - 1], srcsN: srcs.length, dsts: d.ids }, i };
    }
    case 'COMPUTE': {
      i++;
      const dstTok = toks[i] || null; i++;
      let rounded = false;
      if (trIsWord(toks[i], 'ROUNDED')){ rounded = true; i++; }
      if (toks[i] && toks[i].t === 'op' && toks[i].v === '=') i++;
      const expr = [];
      while (i < toks.length && !(toks[i].t === 'w' && (TR_VERBS.has(toks[i].v.toUpperCase()) || stops.has(toks[i].v.toUpperCase()) || TR_BLOCKS.has(toks[i].v.toUpperCase())))){
        expr.push(toks[i]); i++;
      }
      return { stmt: { k: 'compute', dst: dstTok ? dstTok.v : null, rounded, expr }, i };
    }
    case 'ADD': case 'SUBTRACT': case 'MULTIPLY': case 'DIVIDE': {
      const op = U;
      i++;
      const operands = [];
      while (i < toks.length){
        const w = toks[i];
        const W = w.t === 'w' ? w.v.toUpperCase() : null;
        if (W === 'TO' || W === 'FROM' || W === 'BY' || W === 'INTO' || W === 'GIVING') break;
        if (w.t === ','){ i++; continue; }
        if (w.t === 'w' && TR_VERBS.has(W)) break;
        operands.push(w); i++;
      }
      let kind = null;
      if (trIsWord(toks[i], 'TO')) kind = 'to';
      else if (trIsWord(toks[i], 'FROM')) kind = 'from';
      else if (trIsWord(toks[i], 'BY')) kind = 'by';
      else if (trIsWord(toks[i], 'INTO')) kind = 'into';
      if (kind) i++;
      const tg = trIdents(toks, i); i = tg.i;
      let giving = null, rounded = false;
      if (trIsWord(toks[i], 'GIVING')){ i++; const g = trIdents(toks, i); giving = g.ids; i = g.i; }
      if (trIsWord(toks[i], 'ROUNDED')){ rounded = true; i++; }
      let onSize = false;
      if (trIsWord(toks[i], 'ON') || trIsWord(toks[i], 'SIZE')){ onSize = true; i = toks.length; }
      return { stmt: { k: op, operands, kind, targets: tg.ids, giving, rounded, onSize }, i };
    }
    case 'IF': {
      i++;
      const condStops = stopAll(['ELSE', 'END-IF']);
      const c = trCond(toks, i, condStops);
      i = c.i;
      const then = trStmts(toks, i, stopAll(['ELSE', 'END-IF'])); i = then.i;
      let orelse = null;
      if (trIsWord(toks[i], 'ELSE')){
        i++;
        const el = trStmts(toks, i, stopAll(['END-IF']));
        orelse = el.stmts; i = el.i;
      }
      if (trIsWord(toks[i], 'END-IF')) i++;
      return { stmt: { k: 'if', cond: c.py, then: then.stmts, orelse }, i };
    }
    case 'EVALUATE': {
      i++;
      const subj = [];
      while (i < toks.length && !trIsWord(toks[i], 'WHEN')){
        if (toks[i].t === 'w' && TR_VERBS.has(toks[i].v.toUpperCase())) break;
        subj.push(toks[i]); i++;
      }
      const whens = []; let other = null, alsoSeen = false;
      while (trIsWord(toks[i], 'WHEN')){
        i++;
        if (trIsWord(toks[i], 'OTHER')){
          i++;
          const b = trStmts(toks, i, stopAll(['WHEN', 'END-EVALUATE']));
          other = b.stmts; i = b.i;
          break;
        }
        const val = [];
        while (i < toks.length){
          const w = toks[i];
          if (w.t === 'w' && (TR_VERBS.has(w.v.toUpperCase()) || stops.has(w.v.toUpperCase()))) break;
          if (w.t === 'w' && ['WHEN', 'END-EVALUATE', 'ALSO'].includes(w.v.toUpperCase())) break;
          val.push(w); i++;
        }
        if (trIsWord(toks[i], 'ALSO')){ alsoSeen = true; i++; }
        const b = trStmts(toks, i, stopAll(['WHEN', 'END-EVALUATE']));
        whens.push({ val, body: b.stmts });
        i = b.i;
      }
      if (trIsWord(toks[i], 'END-EVALUATE')) i++;
      return { stmt: { k: 'EVALUATE', subject: subj, whens, other, alsoSeen }, i };
    }
    case 'PERFORM': {
      i++;
      const nt = toks[i];
      if (nt && nt.t === 'num' && trIsWord(toks[i+1], 'TIMES')){
        const n = nt.v; i += 2;
        const b = trStmts(toks, i, stopAll(['END-PERFORM'])); i = b.i;
        if (trIsWord(toks[i], 'END-PERFORM')) i++;
        return { stmt: { k: 'PERFORM-INLINE', times: n, body: b.stmts }, i };
      }
      if (nt && (nt.t === 'num' || (nt.t === 'w' && !TR_VERBS.has(nt.v.toUpperCase()) && !TR_KWS.has(nt.v.toUpperCase())))){
        const target = nt.v; i++;
        let thru = null;
        if (trIsWord(toks[i], 'THRU') || trIsWord(toks[i], 'THROUGH')){ i++; thru = toks[i] ? toks[i].v : null; i++; }
        if (toks[i] && toks[i].t === 'num' && trIsWord(toks[i+1], 'TIMES')){ const n = toks[i].v; i += 2; return { stmt: { k: 'PERFORM', target, thru, times: n }, i }; }
        if (trIsWord(toks[i], 'UNTIL')){
          i++;
          const c = trCond(toks, i, stopAll([])); i = c.i;
          return { stmt: { k: 'PERFORM', target, thru, until: c.py }, i };
        }
        if (trIsWord(toks[i], 'VARYING')){
          i++;
          const v = toks[i] ? toks[i].v : null; i++;
          let from = '1', by = '1', until = 'True';
          if (trIsWord(toks[i], 'FROM')){ i++; from = trVal(toks[i]); i++; }
          if (trIsWord(toks[i], 'BY')){ i++; by = trVal(toks[i]); i++; }
          if (trIsWord(toks[i], 'UNTIL')){ i++; const c = trCond(toks, i, stopAll([])); until = c.py; i = c.i; }
          return { stmt: { k: 'PERFORM', target, thru, varying: { v, from, by, until } }, i };
        }
        if (trIsWord(toks[i], 'TIMES')){ i++; const n = toks[i] ? toks[i].v : null; i++; return { stmt: { k: 'PERFORM', target, thru, times: n }, i }; }
        return { stmt: { k: 'PERFORM', target, thru }, i };
      }
      let times = null, until = null, varying = null;
      if (trIsWord(toks[i], 'UNTIL')){ i++; const c = trCond(toks, i, stopAll(['END-PERFORM'])); until = c.py; i = c.i; }
      else if (trIsWord(toks[i], 'VARYING')){
        i++;
        const v = toks[i] ? toks[i].v : null; i++;
        let from = '1', by = '1', u2 = 'True';
        if (trIsWord(toks[i], 'FROM')){ i++; from = trVal(toks[i]); i++; }
        if (trIsWord(toks[i], 'BY')){ i++; by = trVal(toks[i]); i++; }
        if (trIsWord(toks[i], 'UNTIL')){ i++; const c = trCond(toks, i, stopAll(['END-PERFORM'])); u2 = c.py; i = c.i; }
        varying = { v, from, by, until: u2 };
      }
      const b = trStmts(toks, i, stopAll(['END-PERFORM'])); i = b.i;
      if (trIsWord(toks[i], 'END-PERFORM')) i++;
      return { stmt: { k: 'PERFORM-INLINE', times, until, varying, body: b.stmts }, i };
    }
    case 'GOTO': {
      i++;
      const tgt = toks[i] ? toks[i].v : null; i++;
      // GO TO ... DEPENDING ON (multi-target dynamic branch): not covered
      return { stmt: { k: 'GOTO', target: tgt }, i: toks.length };
    }
    case 'DISPLAY': {
      i++;
      const items = [];
      while (i < toks.length){
        const w = toks[i];
        if (w.t === ','){ i++; continue; }
        if (w.t === 'w' && (TR_VERBS.has(w.v.toUpperCase()) || stops.has(w.v.toUpperCase()))) break;
        if (trIsWord(w, 'UPON')){ break; }
        items.push(w); i++;
      }
      return { stmt: { k: 'DISPLAY', items }, i };
    }
    case 'INITIALIZE': {
      i++;
      const d = trIdents(toks, i); i = d.i;
      return { stmt: { k: 'INITIALIZE', targets: d.ids }, i };
    }
    case 'STOP': { i++; if (trIsWord(toks[i], 'RUN')) i++; return { stmt: { k: 'STOP' }, i: toks.length }; }
    case 'GOBACK': { return { stmt: { k: 'STOP', via: 'GOBACK' }, i: toks.length }; }
    case 'EXIT': {
      i++;
      const isExitProg = trIsWord(toks[i], 'PROGRAM'); if (isExitProg) i++;
      return { stmt: { k: 'NOP', note: isExitProg ? 'EXIT PROGRAM' : 'EXIT', exitProg: isExitProg }, i };
    }
    case 'CONTINUE': { return { stmt: { k: 'NOP' }, i: i + 1 }; }
    case 'SET': {
      i++;
      const d = trIdents(toks, i); i = d.i;
      if (trIsWord(toks[i], 'TO')) i++;
      if (trIsWord(toks[i], 'TRUE')){ i++; return { stmt: { k: 'SET88', targets: d.ids }, i: toks.length }; }
      return { stmt: { k: 'SET', targets: d.ids }, i: toks.length };
    }
    case 'CALL': {
      i++;
      const tok = toks[i] || null; i++;
      return { stmt: { k: 'CALL', lit: tok && tok.t === 'lit' ? tok.v : null, viaVar: tok && tok.t === 'w' ? tok.v : null }, i: toks.length };
    }
    case 'READ': case 'WRITE': case 'REWRITE': case 'OPEN': case 'CLOSE': case 'DELETE': {
      i++;
      let txt = U;
      while (i < toks.length && !(toks[i].t === 'w' && (TR_VERBS.has(toks[i].v.toUpperCase()) || stops.has(toks[i].v.toUpperCase()) || TR_BLOCKS.has(toks[i].v.toUpperCase())))){
        txt += ' ' + (toks[i].t === 'lit' ? "'" + toks[i].v + "'" : toks[i].v);
        i++;
      }
      return { stmt: { k: 'IO', verb: U, text: txt }, i };
    }
    default:
      return { stmt: { k: 'unknown', verb: U }, i: i + 1 };
  }
}

// leaves (with PIC) of a data group — for honest INITIALIZE
function trGroupLeaves(varList, name){
  const idx = varList.findIndex(v => String(v.name).toUpperCase() === String(name).toUpperCase());
  if (idx < 0) return [];
  const lvl = varList[idx].level;
  const out = [];
  for (let k = idx + 1; k < varList.length && varList[k].level > lvl; k++){
    if (varList[k].pic && !varList[k].is88) out.push(varList[k]);
  }
  return out;
}

function trEmitStmt(out, st, ind, ctx){
  const py = (s) => { out.lines.push(ind + s); return out.lines.length; };
  const rec = (status, note, k) => {
    out.flat.push({ para: ctx.curPara, ln: st.ln, k: k || st.k.toLowerCase(), status,
      conf: Math.round(100 * (PY_CONF[(k || st.k).toLowerCase()] !== undefined ? PY_CONF[(k || st.k).toLowerCase()] : (PY_CONF[st.k.toLowerCase()] || 0))) / 100,
      py: out.lines.length, note: note || null });
  };
  switch (st.k){
    case 'move': {
      const src = trVal(st.src);
      const multi = st.srcsN > 1;
      st.dsts.forEach(d => py(pyIdent(d) + ' = ' + src));
      rec(multi ? 'approximated' : 'translated', multi ? 'MOVE multi-sources: only the last source is sent (COBOL semantics)' : null);
      break;
    }
    case 'compute': {
      const expr = st.expr.map(trVal).join(' ').replace(/\*\s+\*/g, '**').replace(/\s+/g, ' ').trim();
      const tv = st.dst ? ctx.types.get(st.dst.toUpperCase()) : null;
      const decs = tv && tv._pyt && tv._pyt.decs ? tv._pyt.decs : null;
      let status = 'translated', note = null;
      if (st.rounded && !decs){ status = 'approximated'; note = 'ROUNDED without known decimals → Python default round()'; }
      py(pyIdent(st.dst) + ' = ' + (st.rounded ? 'round(' + expr + (decs ? ', ' + decs : '') + ')' : expr));
      rec(status, note);
      break;
    }
    case 'ADD': case 'SUBTRACT': case 'MULTIPLY': case 'DIVIDE': {
      const ops = st.operands.map(trVal).join(' + ');
      const one = st.operands.length === 1 ? trVal(st.operands[0]) : ops;
      let status = 'translated', note = null;
      if (st.onSize){ status = 'approximated'; note = 'ON SIZE ERROR not covered (overflow not checked)'; }
      const rnd = (e) => st.rounded ? 'round(' + e + ')' : e;
      if (st.k === 'ADD'){
        if (st.giving) st.giving.forEach(g => py(pyIdent(g) + ' = ' + rnd(one)));
        else st.targets.forEach(t => py(pyIdent(t) + ' = ' + pyIdent(t) + ' + ' + one));
      } else if (st.k === 'SUBTRACT'){
        if (st.giving) st.giving.forEach(g => py(pyIdent(g) + ' = ' + rnd(pyIdent(st.targets[0] || '0') + ' - ' + one)));
        else st.targets.forEach(t => py(pyIdent(t) + ' = ' + pyIdent(t) + ' - ' + one));
      } else if (st.k === 'MULTIPLY'){
        if (st.giving) st.giving.forEach(g => py(pyIdent(g) + ' = ' + rnd(one + ' * ' + pyIdent(st.targets[0] || '1'))));
        else st.targets.forEach(t => py(pyIdent(t) + ' = ' + pyIdent(t) + ' * ' + one));
      } else {
        const t0 = pyIdent(st.targets[0] || '1');
        if (st.giving) st.giving.forEach(g => py(pyIdent(g) + ' = ' + rnd(st.kind === 'by' ? one + ' / ' + t0 : t0 + ' / ' + one)));
        else st.targets.forEach(t => py(pyIdent(t) + ' = ' + pyIdent(t) + ' / ' + one));
        if (st.rounded) note = (note || '') + 'ROUNDED applied';
      }
      rec(status, note);
      break;
    }
    case 'if': {
      py('if ' + st.cond + ':');
      const before = out.lines.length;
      (st.then || []).forEach(s2 => trEmitStmt(out, s2, ind + '    ', ctx));
      if (out.lines.length === before) py('    pass');
      if (st.orelse && st.orelse.length){
        py('else:');
        const b2 = out.lines.length;
        st.orelse.forEach(s2 => trEmitStmt(out, s2, ind + '    ', ctx));
        if (out.lines.length === b2) py('    pass');
      }
      rec('translated', null, 'if');
      break;
    }
    case 'EVALUATE': {
      const subj = st.subject.map(trVal).join(' ').trim();
      const isTrue = /^(TRUE|VRAI)$/i.test(subj);
      st.whens.forEach((w, ix) => {
        let cond;
        const hasCmp = w.val.some(t => (t.t === 'op' && '=<>'.includes(t.v)) || (t.t === 'w' && ['NOT','GREATER','LESS','EQUAL','UNEQUAL','AND','OR'].includes(t.v.toUpperCase())));
        const thr = w.val.findIndex(t => t.t === 'w' && ['THRU','THROUGH'].includes(t.v.toUpperCase()));
        if (thr > 0){
          const lo = trVal(w.val[thr - 1]), hi = trVal(w.val[thr + 1] || w.val[thr - 1]);
          cond = '(' + lo + ' <= ' + (isTrue ? subj : subj) + ' <= ' + hi + ')';
        } else if (isTrue || hasCmp){
          cond = trCond(w.val, 0, new Set()).py;
        } else {
          cond = subj + ' == ' + trVal(w.val[0]);
        }
        py((ix === 0 ? 'if ' : 'elif ') + cond + ':');
        const b2 = out.lines.length;
        (w.body || []).forEach(s2 => trEmitStmt(out, s2, ind + '    ', ctx));
        if (out.lines.length === b2) py('    pass');
      });
      if (st.other && st.other.length){
        py('else:');
        const b2 = out.lines.length;
        st.other.forEach(s2 => trEmitStmt(out, s2, ind + '    ', ctx));
        if (out.lines.length === b2) py('    pass');
      }
      rec(st.alsoSeen ? 'approximated' : 'translated', st.alsoSeen ? 'EVALUATE multi-subjects (ALSO): only the first subject is compared' : null, 'evaluate');
      break;
    }
    case 'PERFORM': {
      const tgtU = String(st.target || '').toUpperCase();
      const fname = (ctx.fnMap && ctx.fnMap.get(tgtU)) || pyIdent(st.target);
      let status = 'translated', note = null;
      if (!ctx.paraSet.has(tgtU)){
        py('# PERFORM ' + st.target + ': undefined target (dynamic?) — not translated, no invented edge');
        rec('unsupported', 'unknown target (dynamic or nonexistent)', 'perform');
        break;
      }
      if (st.thru){
        const a = ctx.paraOrder.indexOf(tgtU), b = ctx.paraOrder.indexOf(String(st.thru).toUpperCase());
        if (a >= 0 && b >= a){
          ctx.paraOrder.slice(a, b + 1).forEach(n => py(((ctx.fnMap && ctx.fnMap.get(n)) || pyIdent(n)) + '()'));
          status = 'approximated'; note = 'PERFORM THRU: intermediate paragraphs are called in order (simulated COBOL fall-through)';
        } else {
          py('# PERFORM ' + st.target + ' THRU ' + st.thru + ': unknown bound — not translated');
          rec('unsupported', 'unknown THRU bound', 'perform');
          break;
        }
      } else if (st.times){
        py('for _i in range(' + st.times + '):');
        py('    ' + fname + '()');
      } else if (st.until){
        py('while not (' + st.until + '):');
        py('    ' + fname + '()');
        status = 'approximated'; note = 'PERFORM UNTIL: test BEFORE each iteration (TEST AFTER not distinguished)';
      } else if (st.varying){
        py(pyIdent(st.varying.v) + ' = ' + st.varying.from);
        py('while not (' + st.varying.until + '):');
        py('    ' + fname + '()');
        py('    ' + pyIdent(st.varying.v) + ' += ' + st.varying.by);
        status = 'approximated'; note = 'PERFORM VARYING: increment after the body, condition in Python (COBOL scope not simulated)';
      } else {
        py(fname + '()');
      }
      rec(status, note, 'perform');
      break;
    }
    case 'PERFORM-INLINE': {
      let status = 'approximated', note = 'inline PERFORM: body translated, loop semantics approximated';
      if (st.times){ py('for _i in range(' + st.times + '):'); }
      else if (st.until){ py('while not (' + st.until + '):'); }
      else if (st.varying){ py(pyIdent(st.varying.v) + ' = ' + st.varying.from); py('while not (' + st.varying.until + '):'); }
      else { py('for _i in range(1):'); }
      const b2 = out.lines.length;
      (st.body || []).forEach(s2 => trEmitStmt(out, s2, ind + '    ', ctx));
      if (st.varying) py('    ' + pyIdent(st.varying.v) + ' += ' + st.varying.by);
      if (out.lines.length === b2) py('    pass');
      // body entirely [NOT TRANSLATED] (or pass): the loop condition can
      // never change → INFINITE loop at run time — flagged, never hidden
      if (st.until){
        const em = out.lines.slice(b2).map(l => l.trim());
        if (em.every(l => l.startsWith('#') || l === 'pass'))
          py('    # ⚠ loop body entirely [NOT TRANSLATED]: the condition never changes — INFINITE loop at run time, check the real READ');
      }
      rec(status, note, 'perform');
      break;
    }
    case 'GOTO': {
      const tgtU = String(st.target || '').toUpperCase();
      if (ctx.paraSet.has(tgtU)){
        py('return ' + ((ctx.fnMap && ctx.fnMap.get(tgtU)) || pyIdent(st.target)) + '()  # GO TO: tail call — the target will return control to the PERFORMer');
        rec('approximated', 'GO TO translated as a tail call (return f()): control returns to the CALLER of this paragraph — COBOL would fall through past the target paragraph. Exact only when the GO TO is the paragraph exit; verify any other case', 'goto');
      } else {
        py('raise RuntimeError("GO TO ' + tgtU + ': unknown target (dynamic) — not translated")');
        rec('unsupported', 'unknown target (dynamic)', 'goto');
      }
      break;
    }
    case 'DISPLAY': {
      py('print(' + (st.items || []).map(trVal).join(', ') + ')');
      rec('translated', null, 'display');
      break;
    }
    case 'INITIALIZE': {
      let status = 'translated', note = null;
      (st.targets || []).forEach(t => {
        const tv = ctx.types.get(String(t).toUpperCase());
        if (tv && tv.pic && tv._pyt){
          py(pyIdent(t) + ' = ' + (tv._pyt.kind === 'str' ? '""' : tv._pyt.kind === 'float' ? '0.0' : '0'));
        } else {
          const leaves = trGroupLeaves(ctx.varList, t);
          if (leaves.length){
            leaves.forEach(lf => py(pyIdent(lf.name) + ' = ' + (lf._pyt && lf._pyt.kind === 'str' ? '""' : lf._pyt && lf._pyt.kind === 'float' ? '0.0' : '0')));
            status = 'approximated'; note = 'group INITIALIZE: each typed leaf is reset to zero/blank';
          } else {
            py(pyIdent(t) + ' = None  # INITIALIZE: unknown type');
            status = 'approximated'; note = 'INITIALIZE on an area with unknown type';
          }
        }
      });
      rec(status, note, 'initialize');
      break;
    }
    case 'STOP': {
      py('sys.exit(0)  # ' + (st.via || 'STOP RUN'));
      rec('translated', null, 'stop');
      break;
    }
    case 'CALL': {
      if (st.lit !== null){
        py(pyIdent(st.lit) + '()  # CALL external program: assumes a Python function of the same name');
        rec('approximated', 'external program not merged here — to be linked to the multi-file project', 'call');
      } else {
        py('# CALL via ' + st.viaVar + ' (dynamic): unknown target — not translated');
        rec('unsupported', 'dynamic target', 'call');
      }
      break;
    }
    case 'SET88': {
      (st.targets || []).forEach(t => py(pyIdent(t) + ' = True'));
      rec('translated', 'SET ... TO TRUE: level 88 represented by a boolean', 'set88');
      break;
    }
    case 'SET': {
      py('# SET not covered by the deterministic translator — to handle manually');
      rec('unsupported', 'unsupported SET form', 'unknown');
      break;
    }
    case 'IO': {
      py('# [NOT TRANSLATED] ' + st.text + ' — file I/O: data agreements not invented');
      rec('unsupported', 'file I/O not covered (deterministic)', 'io');
      break;
    }
    case 'SQL': {
      py('# [NOT TRANSLATED] EXEC SQL (line ' + st.ln + '): database access not translated — to replace (dbapi…): ' + String(st.text || '').slice(0, 90));
      rec('unsupported', 'EXEC SQL not covered', 'sql');
      break;
    }
    case 'CICS': {
      py('# [NOT TRANSLATED] EXEC CICS (line ' + st.ln + '): CICS call not translated — to replace (target API): ' + String(st.text || '').slice(0, 90));
      rec('unsupported', 'EXEC CICS not covered', 'cics');
      break;
    }
    case 'NOP': {
      if (st.exitProg){
        // COBOL EXIT PROGRAM: in a CALLED subprogram it returns to the caller;
        // in a main program it is a no-op (execution continues). Python `return`
        // matches the subprogram case — the main-program case is a documented
        // approximation, flagged.
        py('return  # EXIT PROGRAM: returns to the caller (subprogram). In a MAIN program COBOL would continue — verify.');
        rec('approximated', 'EXIT PROGRAM → return (exact for a called subprogram; no-op continuation in a main program not distinguished)', 'nop');
      } else {
        rec('translated', st.note || null, 'nop');
      }
      break;
    }
    default: {
      py('# [NOT TRANSLATED] ' + (st.verb || st.k || 'statement') + ': construction not recognized by the deterministic translator');
      rec('unsupported', 'verb ' + (st.verb || '?') + ' not recognized', 'unknown');
    }
  }
}

function translateCOBOL(f){
  // Returns { python, stmts, stats, types, paras } — or { error } on failure.
  try {
    const C = f.parsed.cobol;
    if (!C) return { error: 'no COBOL parse result' };
    const varList = [];
    const types = new Map();
    (C.vars || []).forEach(v => {
      if (!v.name || v.name === 'FILLER' || v.level === 66) return;
      v._pyt = v.is88 ? { kind: 'bool', decs: 0, note: 'niveau 88 (condition) → bool' } : pyPicType(v);
      types.set(String(v.name).toUpperCase(), v);
      varList.push(v);
    });
    const ctx0 = { file: f.name, warns: [], copyUsed: [] };
    const li = cobLogicalItems(f.text, ctx0.warns);
    const sents = expandCopies(cobSentences(li.items), cobRegistry(), ctx0, []);

    const paras = [];
    let cur = null, inProc = false;
    const newPara = (name, ln) => { cur = { name, ln, stmts: [] }; paras.push(cur); };
    for (const s of sents){
      if (s.t === 'sql' || s.t === 'cics'){
        if (!inProc) continue;
        if (!cur) newPara('MAIN', s.ln);
        cur.stmts.push({ k: s.t.toUpperCase(), ln: s.ln, text: s.text });
        continue;
      }
      if (s.t !== 'sentence') continue;
      const U = s.text.toUpperCase().replace(/\.\s*$/, '').trim();
      if (/(IDENTIFICATION|ID|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION/.test(U)){ if (/PROCEDURE/.test(U)) inProc = true; continue; }
      if (/^(FILE|WORKING-STORAGE|LINKAGE|LOCAL-STORAGE|SCREEN|REPORT|COMMUNICATION|INPUT-OUTPUT|FILE-CONTROL)\b/.test(U)) continue;
      if (!inProc) continue;
      const w = tkWords(U);
      if (w.length === 1 && IDENT.test(w[0]) && !PARAGRAPH_KW.test(w[0])){ newPara(w[0], s.ln); continue; }
      if (w.length === 2 && w[1] === 'SECTION' && IDENT.test(w[0]) && !PARAGRAPH_KW.test(w[0])){ newPara(w[0], s.ln); continue; }
      if (!cur) newPara('MAIN', s.ln);
      try {
        const toks = trNormalize(trToks(s.text));
        const r = trStmts(toks, 0, new Set());
        r.stmts.forEach(x => { x.ln = s.ln; cur.stmts.push(x); });
      } catch (e) {
        cur.stmts.push({ k: 'unknown', verb: '?', ln: s.ln, err: e.message });
      }
    }

    // ── fnMap: Python identifier of each paragraph, collisions detected ──
    // A MAIN or PRINT paragraph must NEVER overwrite an existing function nor
    // be overwritten by the entry (_run): para_ prefix only on collision
    // (Python reserved word, same-name global variable, another same-name paragraph after
    // normalization). Deterministic: suffixes _2, _3… in order of appearance.
    const fnMap = new Map();
    const fnUsed = new Set(['_run']);
    const varIdents = new Set(varList.map(v => pyIdent(v.name)));
    const PY_RESERVED_FN = new Set(['main','print','input','range','len','round','int','float','str','abs','min','max','sum','list','dict','set','tuple','sorted','open','type','next','exit','sys']);
    paras.forEach(p => {
      let id = pyIdent(p.name);
      if (fnUsed.has(id) || varIdents.has(id) || PY_RESERVED_FN.has(id)){
        let cand = 'para_' + id, k = 2;
        while (fnUsed.has(cand)) cand = 'para_' + id + '_' + (k++);
        id = cand;
        ctx0.warns.push('paragraph function ' + p.name + ' renamed to ' + id + ' (Python identifier collision) — all calls follow');
      }
      fnUsed.add(id);
      fnMap.set(String(p.name).toUpperCase(), id);
    });

    const paraOrder = paras.map(p => String(p.name).toUpperCase());
    const paraSet = new Set(paraOrder);
    const ctx = { types, varList, paraOrder, paraSet, curPara: null, fnMap };
    const out = { lines: [], flat: [] };
    const push = (s) => out.lines.push(s);

    push('#!/usr/bin/env python3');
    push('# ─────────────────────────────────────────────────────────────────');
    push('# DETERMINISTIC COBOL → Python automatic translation (Reforge)');
    push('# Source : ' + (C.programId || '?') + ' (' + f.name + ')');
    push('# REVIEW BEFORE USE: every approximation is commented;');
    push('# untranslated statements are marked [NOT TRANSLATED].');
    push('# ─────────────────────────────────────────────────────────────────');
    push('from __future__ import annotations');
    push('import sys');
    push('');
    push('# ── Data areas (PIC → Python type mapping, documented approximation) ──');
    const globalNames = [];
    varList.forEach(v => {
      const pt = v._pyt;
      if (!pt || v.is88 === false && !v.pic){ push('# (group) ' + v.name + ': structure not declared in Python — see child areas'); return; }
      const t = v.is88 ? 'bool' : pt.kind;
      const decl = v.is88 ? 'False' : pt.kind === 'str' ? '""' : pt.kind === 'float' ? '0.0' : '0';
      push(pyIdent(v.name) + ': ' + t + ' = ' + decl + '  # ' + (pt.note || v.name));
      globalNames.push(pyIdent(v.name));
    });
    push('');
    paras.forEach(p => {
      ctx.curPara = p.name;
      push('def ' + fnMap.get(String(p.name).toUpperCase()) + '():');
      if (globalNames.length) push('    global ' + globalNames.join(', '));
      const before = out.lines.length;
      let unreach = false;
      p.stmts.forEach(st => {
        if (unreach){
          // COBOL: nothing after an unconditional GO TO or STOP RUN/GOBACK in the
          // same paragraph can ever run — emitted as a comment, never as live code
          push('    # [unreachable after ' + (st.k === 'GOTO' ? 'GO TO' : 'STOP RUN/GOBACK') + '] ' + (st.k || 'statement') + ' — present in COBOL, not emitted as live Python');
          out.flat.push({ para: ctx.curPara, ln: st.ln, k: 'unreachable', status: 'unsupported', conf: 1, py: out.lines.length, note: 'unreachable after unconditional transfer (GO TO / STOP RUN)' });
          return;
        }
        trEmitStmt(out, st, '    ', ctx);
        if (st.k === 'GOTO' || st.k === 'STOP') unreach = true;
      });
      if (out.lines.length === before) push('    pass');
      push('');
    });
    ctx.curPara = null;
    // _run entry — generated from the REAL control flow, not declared order.
    // (never "main": a COBOL MAIN paragraph must neither be overwritten nor
    // call itself — real bug reported by a user). Simulation: start at the
    // first paragraph; fall through to the next paragraph unless the last
    // top-level statement is an unconditional transfer (STOP RUN/GOBACK ends
    // the program, lone GO TO jumps). A GO TO nested in an IF/EVALUATE/inline
    // PERFORM makes the fall-through uncertain → linear generation stops there
    // with an explicit warning. Paragraphs never reached are NOT called
    // (dead-code candidates — questions, not facts).
    const paraU = paras.map(p => String(p.name).toUpperCase());
    const idxOf = n => paraU.indexOf(String(n || '').toUpperCase());
    const hasNestedGoto = p => p.stmts.some(s => s.k !== 'GOTO' && JSON.stringify(s).includes('"k":"GOTO"'));
    const runSeq = [];
    let runTrunc = null;
    if (C._decl || C._alter){
      runSeq.push(0);
      runTrunc = (C._decl ? 'DECLARATIVES present (implicit targets)' : 'ALTER present (GO TO patched at run time)') + ' — only the first paragraph is called';
    } else if (paras.length){
      const seen = new Set();
      let cur = 0;
      while (cur >= 0 && cur < paras.length && !runTrunc){
        if (seen.has(cur)){ runTrunc = 'backward jump (GO TO loop)'; break; }
        seen.add(cur);
        runSeq.push(cur);
        if (hasNestedGoto(paras[cur])){ runTrunc = 'conditional GO TO (inside IF/EVALUATE/inline PERFORM) — fall-through uncertain'; break; }
        const last = paras[cur].stmts[paras[cur].stmts.length - 1];
        if (last && last.k === 'STOP') break;                    // STOP RUN / GOBACK: program ends
        if (last && last.k === 'GOTO'){
          const t = idxOf(last.target);
          if (t < 0){ runTrunc = 'GO TO ' + (last.target || '?') + ': target not found'; break; }
          cur = t; continue;                                     // unconditional jump
        }
        cur++;                                                   // fall-through
      }
    }
    push('def _run():');
    push('    # Entry point generated from the REAL COBOL control flow (not declared order):');
    push('    # first paragraph, fall-through between paragraphs, GO TO jumps,');
    push('    # STOP RUN/GOBACK ends. Paragraphs not on this path are NOT called');
    push('    # (dead-code candidates — questions, not facts).');
    runSeq.forEach(i => push('    ' + fnMap.get(paraU[i]) + '()'));
    if (!runSeq.length) push('    pass');
    if (runTrunc){
      push('    # ⚠ flow stops here: ' + runTrunc + ' — the rest of the control flow is NOT generated; verify manually.');
      ctx0.warns.push('entry point _run(): linear generation stopped (' + runTrunc + ') — remaining flow not generated, verify manually');
    }
    push('');
    push("if __name__ == '__main__':");
    push('    _run()');

    // ── "undeclared variables" pass: an identifier used but never declared
    // in COBOL (e.g. EOF-FLAG fed by an untranslated READ) would raise a NameError
    // when running the .py. It is declared BEFORE the functions with an explicit
    // comment — visible assumption, never silent. Type guessed from the
    // first usage (string literal → str, numeric literal → float, else str).
    const PY_KW = new Set(['from','__future__','import','annotations','__name__','__main__','sys','exit','def','return','global','pass','if','elif','else','while','for','in','not','and','or','is','True','False','None','range','print','input','len','round','int','float','str','abs','min','max','_i','_run','raise','RuntimeError']);
    const pyKnown = new Set(PY_KW);
    globalNames.forEach(n => pyKnown.add(n));
    fnMap.forEach(v => pyKnown.add(v));
    const pyUndecl = [], pyFirstUse = new Map(), pySeenU = new Set();
    out.lines.forEach(L => {
      const s = String(L).replace(/"(?:[^"\\]|\\.)*"/g, '""');
      const ci = s.indexOf('#');
      const code = ci >= 0 ? s.slice(0, ci) : s;
      const re = /[A-Za-z_][A-Za-z0-9_]*/g; let mm;
      while ((mm = re.exec(code))){
        const id = mm[0];
        if (!pyKnown.has(id) && !pySeenU.has(id)){ pySeenU.add(id); pyUndecl.push(id); pyFirstUse.set(id, L); }
      }
    });
    if (pyUndecl.length){
      const di = out.lines.findIndex(l => l.startsWith('def '));
      const decls = ['', '# ── Variables used but NOT DECLARED in COBOL — explicit assumption, TO VERIFY ──'];
      pyUndecl.forEach(id => {
        const use = String(pyFirstUse.get(id) || '');
        const isStr = use.includes('"');
        const isNum = !isStr && /\d/.test(use.replace(/#.*/, ''));
        const kind = isStr || !isNum ? 'str' : 'float';
        const init = kind === 'str' ? '""' : '0.0';
        decls.push(id + ': ' + kind + ' = ' + init + '  # ⚠ NOT DECLARED in COBOL (initialized by an untranslated I/O?) — assumed ' + kind + ', TO VERIFY');
        ctx0.warns.push('variable ' + id + ' used but not declared in COBOL — declared in Python as ' + kind + ' (assumption commented in the .py, to verify)');
      });
      out.lines.splice(Math.max(di, 0), 0, ...decls);
      // function bodies that assign an undeclared variable must declare it
      // global — otherwise Python makes it function-local → UnboundLocalError
      // at run time (real bug: only functions that ALREADY had a global line
      // were patched). Per-function pass: extend the existing global line or
      // insert one, with ONLY the undeclared ids actually assigned there.
      const reAssign = id => new RegExp('(^|[^\\w.])' + id + '(\\s*=(?!=)|\\s*\\+=|\\s*-=|\\s*\\*=|\\s*/=)');
      for (let ix = 0; ix < out.lines.length; ix++){
        if (!/^def \w+\(\):/.test(out.lines[ix])) continue;
        const body = [];
        for (let j = ix + 1; j < out.lines.length; j++){
          if (/^(def |if __name__)/.test(out.lines[j])) break;
          body.push(out.lines[j]);
        }
        const need = pyUndecl.filter(id => body.some(b => {
          const ci = b.indexOf('#');
          const code = ci >= 0 ? b.slice(0, ci) : b;
          return reAssign(id).test(code);
        }));
        if (!need.length) continue;
        if (body.length && body[0].startsWith('    global ')){
          const parts = body[0].slice('    global '.length).split(',').map(s => s.trim()).filter(Boolean);
          need.forEach(id => { if (!parts.includes(id)) parts.push(id); });
          out.lines[ix + 1] = '    global ' + parts.join(', ');
        } else {
          out.lines.splice(ix + 1, 0, '    global ' + need.join(', '));
        }
      }
    }

    const flat = out.flat;
    let nT = 0, nA = 0, nU = 0;
    flat.forEach(x => { if (x.status === 'translated') nT++; else if (x.status === 'approximated') nA++; else nU++; });
    const total = flat.length;
    const coverage = total ? Math.round(10 * (100 * (nT + 0.6 * nA) / total)) / 10 : 0;
    return {
      programId: C.programId, file: f.name, python: out.lines.join('\n'),
      stmts: flat,
      stats: { total, translated: nT, approximated: nA, unsupported: nU, coverage },
      types: varList.filter(v => v._pyt).map(v => ({ name: pyIdent(v.name), pic: v.pic || (v.is88 ? '88' : '(groupe)'), py: v.is88 ? 'bool' : v._pyt.kind, note: v._pyt.note || '' })),
      paras: paras.map(p => p.name),
      warns: ctx0.warns
    };
  } catch (e) {
    return { error: 'translation failed: ' + e.message };
  }
}

// ── Structural check of the generated Python (run-time safety) ──
// The browser cannot run CPython: this pass catches exactly
// the runtime bugs reported by users — duplicate "def" (the entry
// overwrites itself and self-calls), call to a never-defined function (NameError),
// loop variable never assigned (infinite while). Result shown in the
// translation report. Nothing is invented: an issue not detected by this
// pass (business semantics) remains for human review.
function pyStaticCheck(pyText){
  const issues = [];
  const lines = String(pyText).split('\n');
  // 1. unique definitions — a duplicate "def" overwrites the first one (possible recursion)
  const defs = [];
  lines.forEach((L, i) => { const m = L.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)/); if (m) defs.push({ name: m[1], from: i }); });
  defs.forEach((d, i) => { if (defs.slice(0, i).some(x => x.name === d.name)) issues.push('def ' + d.name + '(): defined MULTIPLE times — the 2nd definition overwrites the 1st, calls make a possible recursion'); });
  const defNames = new Set(defs.map(d => d.name));
  // 2. calls to never-defined functions (NameError) + call graph
  const SAFE_CALL = new Set(['if','while','for','not','def','print','range','round','int','float','str','len','abs','min','max','input','exit','raise','RuntimeError','open','sorted','map','filter','list','dict','set','tuple','zip']);
  defs.forEach((d, i) => {
    let to = (i + 1 < defs.length) ? defs[i + 1].from : lines.length;
    // the body stops at the "if __name__" block: the entry invocation is not an internal call (otherwise false cycle)
    const gi = lines.findIndex((l, ix) => ix > d.from && /^if __name__/.test(l));
    if (gi >= 0) to = Math.min(to, gi);
    d.to = to;
    const calls = new Set();
    lines.slice(d.from + 1, to).forEach(L => {
      const s = L.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*/, '');
      const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g; let m;
      while ((m = re.exec(s))) calls.add(m[1]);
    });
    d.calls = [...calls].filter(c => !SAFE_CALL.has(c));
    d.calls.forEach(c => { if (!defNames.has(c)) issues.push('call to ' + c + '() in ' + d.name + ': function never defined (NameError at run time)'); });
  });
  // 3. call cycle from the entry (unintentional recursion, e.g. main → main)
  if (!defNames.has('_run')) issues.push("no entry function \"def _run():\" found");
  else {
    const stack = [], onPath = new Set(), seen = new Set();
    const visit = (n) => {
      if (onPath.has(n)){ issues.push('call cycle: ' + stack.concat(n).join(' → ') + ' — unintentional recursion (does the entry call itself?)'); return; }
      if (seen.has(n)) return;
      seen.add(n); onPath.add(n); stack.push(n);
      const d = defs.find(x => x.name === n);
      (d && d.calls || []).forEach(visit);
      stack.pop(); onPath.delete(n);
    };
    visit('_run');
  }
  // 4. the entry is indeed invoked by the __main__ block
  const tail = lines.slice(-5).join('\n');
  if (defNames.has('_run') && !tail.includes('_run()')) issues.push("the _run() entry is never called (missing __main__ block)");
  // 5. while loops whose condition can never change (var never assigned)
  const assigned = new Set();
  lines.forEach(L => {
    const s = L.replace(/#.*/, '');
    const m = s.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]*)?=(?!=)/);
    if (m) assigned.add(m[1]);
    const m2 = s.match(/^\s*global\s+(.+)$/);
    if (m2) m2[1].split(',').forEach(x => assigned.add(x.trim()));
  });
  lines.forEach(L => {
    const s = L.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const m = s.match(/^\s*while\s+not\s*\((.*)\)\s*:/) || s.match(/^\s*while\s+(.*):/);
    if (!m) return;
    const cond = m[1];
    const re = /[A-Za-z_][A-Za-z0-9_]*/g; let mm; const vars = [];
    while ((mm = re.exec(cond))) if (!['not','and','or','True','False','None','in','is'].includes(mm[0])) vars.push(mm[0]);
    if (!vars.length) return;
    const never = vars.filter(v => !assigned.has(v));
    if (never.length) issues.push('loop "while ' + cond.trim() + '": ' + never.join(', ') + ' is never assigned in the generated code — the condition cannot change, INFINITE loop at run time');
  });
  // 6. module variable assigned WITHOUT "global" inside the function →
  // local variable shadowing the global: the module state does not change (classic pitfall)
  const modVars = new Set();
  lines.forEach(L => { const m = L.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s*=/); if (m) modVars.add(m[1]); });
  if (modVars.size){
    defs.forEach(d => {
      const gline = lines.slice(d.from, d.to).find(l => l.trim().startsWith('global ')) || '';
      const gnames = new Set(gline.replace(/^\s*global\s+/, '').split(',').map(x => x.trim()).filter(Boolean));
      lines.slice(d.from, d.to).forEach(L => {
        const s = L.replace(/#.*/, '');
        const m = s.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]*)?=(?!=)/);
        if (m && modVars.has(m[1]) && !gnames.has(m[1]))
          issues.push('in ' + d.name + ': ' + m[1] + ' is assigned without "global ' + m[1] + '" — local variable shadowing the global, the module state does not change');
      });
    });
  }
  return { ok: issues.length === 0, issues };
}

function downloadPython(i){
  const f = state.files[i];
  if (!f || !f.parsed.cobol) return;
  const T = translateCOBOL(f);
  if (!T || T.error) return;
  const blob = new Blob([T.python], { type: 'text/x-python' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (T.programId || base(f.name)) + '.py';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  track('export_python');
}

function levelEntry(C, w, ln, sec, fd){
  // 01  NAME  PIC 9(4)V99 [OCCURS n] [REDEFINES X] [VALUE lit].
  const lvl = w[0];
  const name = (w[1]||'').toUpperCase();
  const rest = w.slice(2).join(' ');
  const picm = rest.match(/\bPIC(?:TURE)?\s+(?:IS\s+)?([A-Z0-9SVX\.\(\)\+\-,\$*\-\/]+(?:\s+[A-Z0-9SVX\.\(\)\+\-,\$*\-\/]+)*)/i);
  let pic = null;
  if (picm){
    // the PIC stops at the first clause keyword (COMP-3, VALUE…) — otherwise
    // "PIC 9(4) COMP-3" would give a wrong PIC "9(4)COMP-3"
    const CLAUSE_KW = /^(COMP-?[1-5]?|COMPUTATIONAL-?[1-5]?|BINARY|PACKED-DECIMAL|DISPLAY-?[1-2]?|DISPLAY|USAGE|IS|OCCURS|REDEFINES|RENAMES|VALUE|VALUES|SYNC|SYNCHRONIZED|JUST|JUSTIFIED|BLANK|WHEN|ZERO|ZEROS|ZEROES|GLOBAL|EXTERNAL|POINTER|INDEX|INDEXED|SIGN|TRAILING|LEADING|SEPARATE|DEPENDING|TIMES)$/i;
    const toks = picm[1].split(/\s+/).filter(Boolean);
    const keep = [];
    for (const tk of toks){ if (CLAUSE_KW.test(tk)) break; keep.push(tk); }
    pic = keep.join('') || picm[1].replace(/\s+/g,'');
  }
  const occm = rest.match(/\bOCCURS\s+(\d+)\s*(?:TIMES)?/i);
  const occRange = rest.match(/\bOCCURS\s+\d+\s+TO\s+(\d+)\s*(?:TIMES)?/i);
  const occDep = rest.match(/\bDEPENDING\s+ON\s+([A-Z0-9\-]+)/i);
  const redm = rest.match(/\bREDEFINES\s+([A-Z0-9\-]+)/i);
  const valm = rest.match(/\bVALUE\s+(?:IS\s+)?['"]?([^'"\s.]+)/i);
  const usm = rest.match(/\b(?:USAGE\s+(?:IS\s+)?)?(COMP-3|COMP-1|COMP-2|COMP-4|COMP-5|COMPUTATIONAL-3|BINARY|PACKED-DECIMAL|DISPLAY(?:-1|-2)?)\b/i);
  const usage = usm ? usm[1].toUpperCase().replace('COMPUTATIONAL','COMP') : null;
  const renm = lvl === '66' ? rest.match(/\bRENAMES\s+([A-Z0-9\-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z0-9\-]+))?/i) : null;
  const v = { level: parseInt(lvl,10), name: name || 'FILLER', pic, occurs: occRange?parseInt(occRange[1],10):(occm?parseInt(occm[1],10):null),
    occursDepending: occDep?occDep[1].toUpperCase():null, occursTo: !!occRange,
    redefines: redm?redm[1].toUpperCase():null, renames: renm?{ from: renm[1].toUpperCase(), thru: renm[2]?renm[2].toUpperCase():null }:null,
    usage, value: valm?valm[1]:null, fd: fd || null, sec, ln, is88: lvl === '88' };
  C.vars.push(v);
  if (lvl === '88' && valm) (C.varLits[name] = C.varLits[name] || []).push(valm[1].toUpperCase());
  if (occRange && !occDep) C.warns.push(`line ${ln}: OCCURS m TO n without DEPENDING ON — bounds kept, exact size unknown`);
  if (!pic && lvl !== '88' && !redm && name && name !== 'FILLER' && !/\bPIC\b|\bOCCURS\b/i.test(rest) && !w.slice(1).some(x=>/^(COMP|BINARY|PACKED|USAGE|SYNC|JUST|JUSTIFIED|BLANK|GLOBAL|EXTERNAL)$/i.test(x)))
    ; // group without PIC: legitimate (01 RECORD. / 05 SUB-GROUP.)
}

function procSentence(C, t, s, para, opAdd){
  const ln = s.ln;
  // The final period of the sentence is removed: GO TO CAP-PARA. must yield
  // the target "CAP-PARA" (valid IDENT) and not "CAP-PARA."
  const U = t.toUpperCase().replace(/\.\s*$/, '');
  // Literals neutralized for verb detection: a verb written
  // INSIDE a string (MOVE 'READ X' TO Y) must never create a relation.
  const UQ = U.replace(/'[^']*'/g, "''");
  // I/O: scanned across the WHOLE sentence — multi-verb sentences are
  // courantes en COBOL (READ X AT END MOVE 'Y' TO EOF ... END-PERFORM.)
  let m;
  const rre = /\bREAD\s+([A-Z0-9\-]+)/g;
  while ((m = rre.exec(UQ))) opAdd(m[1], 'read', ln);
  const wre = /\bWRITE\s+([A-Z0-9\-]+)/g;
  while ((m = wre.exec(UQ))) opAdd(m[1], 'write', ln);
  const rwre = /\bREWRITE\s+([A-Z0-9\-]+)/g;
  while ((m = rwre.exec(UQ))) opAdd(m[1], 'update', ln);
  const dre = /\bDELETE\s+([A-Z0-9\-]+)/g;
  while ((m = dre.exec(UQ))) opAdd(m[1], 'delete', ln);
  const ore = /\bOPEN\s+(INPUT|OUTPUT|I-O|EXTEND)\s+([A-Z0-9\-]+)/g;
  while ((m = ore.exec(UQ))) opAdd(m[2], m[1] === 'INPUT' ? 'read' : m[1] === 'OUTPUT' ? 'write' : 'update', ln);
  // MOVE 'lit' TO var → possible value for a dynamic CALL (first value seen)
  const mre = /MOVE\s+'([^']*)'\s+TO\s+([A-Z0-9\-]+)/gi;
  while ((m = mre.exec(t))){
    const nm = m[2].toUpperCase();
    if (C.varLits[nm] === undefined) C.varLits[nm] = [m[1].toUpperCase()];
  }
  // PERFORM: all occurrences in the sentence — a sentence without a period
  // can chain READ ... PERFORM X ... GO TO Y (real code). Inline forms
  // (PERFORM UNTIL / WITH TEST / VARYING / n TIMES) → no invented edge.
  const PKW = /^(UNTIL|VARYING|WITH|TEST|TIMES)$/;
  const pre = /(?:^|[^A-Z0-9\-])(?:PERFORM|PERFORMS)\s+([A-Z0-9\-]+)(?:\s+(?:THRU|THROUGH)\s+([A-Z0-9\-]+))?/g;
  while ((m = pre.exec(UQ))){
    const to = m[1];
    if (PKW.test(to) || /^[0-9]+$/.test(to)) continue;
    C.performs.push({ from: para, to, thru: m[2] || null, ln });
  }
  // GO TO / GOTO: all occurrences. GO TO A B C DEPENDING ON X →
  // one edge per target (dynamic branch, 'probable' confidence).
  // GO TO in the middle of a sentence (IF ... GO TO X) → embedded.
  const ggre = /(?:^|[^A-Z0-9\-])(?:GO\s+TO|GOTO)\s+/g;
  while ((m = ggre.exec(UQ))){
    const rest = UQ.slice(m.index + m[0].length).trim().split(/\s+/);
    const w2 = rest[0];
    if (!w2 || !IDENT.test(w2) || /^DEPENDING$/i.test(w2)) continue;
    const embedded = m.index > 0;
    const di = rest.findIndex(x => /^DEPENDING/i.test(x));
    if (di > 0){
      rest.slice(0, di).filter(x => IDENT.test(x))
        .forEach(t2 => C.gotos.push({ from: para, to: t2, ln, depending: true, embedded, src: rest.slice(0, di).join(' ') }));
    } else {
      C.gotos.push({ from: para, to: w2, ln, embedded });
    }
  }
  // CALL: direct literal ('PGM') → certain; variable (CALL WS-PGM) →
  // dynamic resolution via varLits in resolveCalls
  const cre = /(?:^|[^A-Z0-9\-])CALL\s+'([^']+)'/g;
  while ((m = cre.exec(U))) C.calls.push({ target: m[1].toUpperCase(), viaVar: null, resolved: true, ln });
  const cvre = /(?:^|[^A-Z0-9\-])CALL\s+([A-Z0-9\-]+)/g;
  while ((m = cvre.exec(UQ))) C.calls.push({ target: null, viaVar: m[1].toUpperCase(), resolved: false, ln });
  // IMS DL/I: CALL 'CBLTDLI'/'ASMTDLI' USING op pcb record ssa… — honest
  // detection: the op-code is traced if it comes from a literal or a literal MOVE
  // (varLits); SSA/segment names are built at run time
  // → never invented, no edge to an unknown dataset.
  const dlre = /CALL\s+'(CBLTDLI|ASMTDLI)'\s+USING\s+([^.;]+)/;
  const dm = dlre.exec(U);
  if (dm){
    const args = dm[2].trim().split(/[\s,]+/).filter(Boolean);
    const a0 = args[0] || '';
    const litm = a0.match(/^'([^']*)'$/);
    const op = litm ? litm[1].trim().toUpperCase() : ((((C.varLits[a0] || [])[0]) || '').trim().toUpperCase() || null);
    C.dli.push({ entry: dm[1], op, args: args.length, ln, opVar: litm ? null : a0 });
  }
}

function resolveOps(C){
  // record 01 ↔ FD file: association by CONTEXT (the current FD at the moment
  // of the declaration), not by homonym. WRITE/REWRITE operate on the NAME OF
  // RECORD, READ/OPEN/DELETE on the FILE name — both must resolve
  // the same SELECT/FD file. Any unattached I/O is flagged, never guessed.
  const recToFile = {};
  C.selects.forEach(sl => { recToFile[sl.file] = sl.file; });
  for (const v of C.vars){
    if (v.fd) recToFile[v.name] = v.fd;
  }
  C.fileOps = C.fileOps || {};
  const merged = {};
  for (const [rec, ops] of Object.entries(C.fileOps)){
    const file = recToFile[rec] || null;
    if (!file){
      C.warns.push(`line ${ops[0].ln}: I/O on "${rec}" not attached to any SELECT/FD — relation NOT created (nothing invented)`);
      continue;
    }
    merged[file] = merged[file] || [];
    ops.forEach(o => { if (!merged[file].some(x => x.op === o.op)) merged[file].push(o); });
  }
  // EXEC CICS FILE('X'): X may be the COBOL name of the file, its DDNAME
  // (SELECT ASSIGN) or a record — otherwise FCT entry: unknown dataset, the
  // reference stays an 'fct' node in the model, no invented relation.
  // FILE(variable): the value is traced from MOVE 'X' TO var /
  // level 88s (like resolveCalls for dynamic CALLs). Resolved →
  // 'probable' (dynamic value); no constant seen → no edge + warn.
  C.cics.forEach(x => {
    if (x.fileVar && !x.file){
      const lits = C.varLits[x.fileVar];
      if (lits && lits.length){
        x.file = lits[0];
        x.fileViaVar = true;
        C.cicsFiles[x.file] = [...(C.cicsFiles[x.file] || []), { op: x.op, ln: x.ln, cics: x.cmd, cicsFile: x.file, viaVar: x.fileVar }];
      } else {
        C.warns.push(`line ${x.ln}: EXEC CICS ${x.cmd} FILE(${x.fileVar}) — variable value unknown → no edge created (nothing invented)`);
      }
    }
  });
  const cicsToFile = Object.assign({}, recToFile);
  C.selects.forEach(sl => { cicsToFile[sl.dd] = sl.file; });
  for (const [cf, ops] of Object.entries(C.cicsFiles || {})){
    const file = cicsToFile[cf] || null;
    if (!file) continue;
    merged[file] = merged[file] || [];
    ops.forEach(o => { if (!merged[file].some(x => x.op === o.op)) merged[file].push(o); });
  }
  C.fileOps = merged;
  C.recToFile = recToFile;
  C.cicsToFile = cicsToFile;
}

function resolveCalls(C){
  C.calls.forEach(c => {
    if (!c.resolved && c.viaVar){
      const lits = C.varLits[c.viaVar];
      if (lits && lits.length){
        c.target = lits[0];
        c.resolved = 'var';
      }
    }
  });
}

function parseCOBOL(file, text, registry){
  const C = { file, programId: null, divisions: [], sections: [], paragraphs: [], vars: [], selects: [],
    fds: [], performs: [], gotos: [], calls: [], sql: [], cics: [], cicsFiles: {}, fileOps: {}, varLits: {}, dli: [], copyUsed: [], warns: [],
    flowLast: null, dead: [], _decl: false, _alter: false };
  const li = cobLogicalItems(text, C.warns);
  C.fixed = cobDetectFixed(text);
  const sents0 = cobSentences(li.items);
  const ctx = { file, warns: C.warns, copyUsed: C.copyUsed };
  const sents = expandCopies(sents0, registry, ctx, []);

  let div = null, sec = null, para = null, curFd = null;
  const opAdd = (rec, op, ln) => {
    (C.fileOps[rec] = C.fileOps[rec] || []).push({ op, ln });
  };
  let pendingId = null;

  for (const s of sents){
    if (s.t === 'sql'){
      if (div === 'PROCEDURE' || div === null) sqlParse(C, s);
      else C.warns.push(`line ${s.ln}: EXEC SQL outside PROCEDURE DIVISION — ignored`);
      continue;
    }
    if (s.t === 'cics'){
      if (div === 'PROCEDURE' || div === null) cicsParse(C, s, para);
      else C.warns.push(`line ${s.ln}: EXEC CICS outside PROCEDURE DIVISION — ignored`);
      continue;
    }
    const t = s.text;
    const w = tkWords(t.toUpperCase().replace(/\.$/,''));
    if (!w.length) continue;
    const v = w[0];

    // divisions
    if (/DIVISION\.$/.test(t.toUpperCase()) && ['IDENTIFICATION','ID','ENVIRONMENT','DATA','PROCEDURE'].includes(v)){
      div = v === 'ID' ? 'IDENTIFICATION' : v;
      C.divisions.push({ name: div, ln: s.ln });
      sec = null; para = null; curFd = null;
      continue;
    }
    // PROGRAM-ID (may be followed by the name on the next sentence if isolated period)
    // PROGRAM-ID — the period may directly follow the keyword ("PROGRAM-ID. X.")
    if (/^PROGRAM-ID\b/i.test(t)){
      const m = t.match(/PROGRAM-ID[.]?\s+'?([A-Z0-9\-]+)'?/i);
      if (m && !/^DIVISION/i.test(m[1])){
        if (C.programId && C.programId !== m[1].toUpperCase()){
          // stacked subprograms: the rest of the file belongs to the second
          // program — attributing it to the first would be a false result. We stop.
          C.warns.push(`line ${s.ln}: second PROGRAM-ID '${m[1].toUpperCase()}' in the same file — stacked/nested programs are NOT split into separate nodes; analysis stops here, only ${C.programId} is analyzed`);
          break;
        }
        C.programId = m[1].toUpperCase();
      }
      else if (!m) pendingId = true;
      continue;
    }
    if (pendingId && IDENT.test(v) && !C.programId){
      C.programId = v;
      pendingId = false;
      continue;
    }
    // sections (known names only)
    const SECTIONS = ['CONFIGURATION','INPUT-OUTPUT','FILE-CONTROL','FILE','WORKING-STORAGE','LINKAGE','LOCAL-STORAGE','COMMUNICATION','REPORT','SCREEN'];
    if (w[1] === 'SECTION' && SECTIONS.includes(v)){
      sec = v + '-SECTION';
      C.sections.push({ name: sec, div, ln: s.ln });
      para = null; curFd = null;
      continue;
    }
    // PROCEDURE DIVISION section (P100 SECTION.): node just like a paragraph
    if (div === 'PROCEDURE' && w[1] === 'SECTION' && IDENT.test(v) && !SECTIONS.includes(v)){
      C.paragraphs.push({ name: v, ln: s.ln, section: true });
      para = v;
      continue;
    }
    // SELECT ... ASSIGN TO DDNAME
    if (v === 'SELECT'){
      const m = t.match(/SELECT\s+(?:OPTIONAL\s+)?([A-Z0-9\-]+)\s+ASSIGN\s+TO\s+([A-Z0-9\-]+)/i);
      if (m) C.selects.push({ file: m[1].toUpperCase(), dd: m[2].toUpperCase(), ln: s.ln });
      else {
        const m2 = t.match(/SELECT\s+(?:OPTIONAL\s+)?([A-Z0-9\-]+)/i);
        if (m2){ C.selects.push({ file: m2[1].toUpperCase(), dd: m2[1].toUpperCase(), ln: s.ln });
          C.warns.push(`line ${s.ln}: SELECT without ASSIGN — DDNAME assumed = file name`); }
        else C.warns.push(`line ${s.ln}: malformed SELECT — ignored`);
      }
      continue;
    }
    // FD
    if (v === 'FD'){
      const m = t.match(/FD\s+([A-Z0-9\-]+)/i);
      if (m){ C.fds.push(m[1].toUpperCase()); curFd = m[1].toUpperCase(); }
      continue;
    }
    // level entry (DATA DIVISION, unknown division, or data section
    // encountered without explicit DIVISION — lenient but never invented)
    if (/^[0-9]{1,2}$/.test(v) && (div === 'DATA' || div === null ||
        ['FILE-SECTION','WORKING-STORAGE-SECTION','LINKAGE-SECTION','LOCAL-STORAGE-SECTION','COMMUNICATION-SECTION','REPORT-SECTION','SCREEN-SECTION'].includes(sec))){
      levelEntry(C, w, s.ln, sec, sec === 'FILE-SECTION' ? curFd : null);
      continue;
    }
    // DECLARATIVES (implicit USE handlers) — disables dead-code analysis
    if (div === 'PROCEDURE' && v === 'DECLARATIVES') C._decl = true;
    // paragraph: bare name followed by a period (PROCEDURE)
    if (div === 'PROCEDURE' && w.length === 1 && IDENT.test(v) && !PARAGRAPH_KW.test(v)){
      C.paragraphs.push({ name: v, ln: s.ln });
      para = v;
      continue;
    }
    if (div === 'PROCEDURE' || div === null){
      // Dead code: last statement of each paragraph + conditions that
      // disable the analysis when it cannot be certain
      // (DECLARATIVES/USE = implicit handlers, ALTER = GO TO patched at run time).
      const UQF = t.toUpperCase().replace(/\.\s*$/, '').replace(/'[^']*'/g, "''").trim();
      if (/^DECLARATIVES\b/.test(UQF)) C._decl = true;
      if (/\bALTER\b/.test(UQF)) C._alter = true;
      if (div === 'PROCEDURE'){
        C.flowLast = C.flowLast || {};
        // Effective paragraph exit = FIRST unconditional terminator. Statements
        // after GOBACK/STOP RUN/lone GO TO are unreachable and must NOT
        // overwrite it (otherwise fall-through analysis wrongly continues).
        const FL_TERM = /^(GO\s+TO|GOTO|STOP\s+RUN|GOBACK|EXIT\s+PROGRAM|EXIT\s+CICS)\b/;
        if (!(C.flowLast[para || ''] && FL_TERM.test(C.flowLast[para || '']))) C.flowLast[para || ''] = UQF;
        // SORT ... INPUT/OUTPUT PROCEDURE IS x: targets executed by SORT → alive
        if (/\bSORT\b/.test(UQF)){
          const spr = /(INPUT|OUTPUT)\s+PROCEDURE\s+(?:IS\s+)?([A-Z0-9\-]+)/g;
          let m2;
          while ((m2 = spr.exec(UQF))) C.performs.push({ from: para, to: m2[2], thru: null, ln: s.ln, kind: 'sort' });
        }
      }
      procSentence(C, t, s, para, opAdd);
    }
  }
  if (!C.programId) C.warns.push('PROGRAM-ID not found');
  // PERFORM / GO TO targets not found: flagged, no invented edge
  const knownParas = new Set(C.paragraphs.map(p=>p.name));
  C.performs.forEach(p => {
    if (p.to && !knownParas.has(p.to)) C.warns.push(`line ${p.ln}: PERFORM ${p.to} — paragraph/section not found → no edge created`);
    if (p.thru && !knownParas.has(p.thru)) C.warns.push(`line ${p.ln}: PERFORM ... THRU ${p.thru} — target not found`);
  });
  C.gotos.forEach(g => {
    if (g.to && !knownParas.has(g.to)) C.warns.push(`line ${g.ln}: GO TO ${g.to} — target not found → no edge created`);
  });
  // ── Dead code: unreachable paragraphs ──
  // A paragraph is ALIVE if (a) target of a PERFORM/GO TO/THRU from an
  // alive paragraph, or (b) reachable by fall-through from an alive paragraph
  // whose last statement is NOT an unconditional transfer (lone GO TO,
  // STOP RUN, GOBACK, EXIT PROGRAM/CICS at statement start). Any doubt
  // (GO TO inside an IF, GO TO DEPENDING, fall-through) makes it alive: we never
  // declare "dead" without certainty. Fixed point: backward GO TOs (jumps)
  // can make alive paragraphs already passed by fall-through.
  C.dead = [];
  if (C._decl || C._alter){
    C.warns.push((C._decl ? 'DECLARATIVES section present (USE handlers are implicit targets)'
      : 'ALTER statement present (GO TO patched at runtime)')
      + ' — paragraph dead-code analysis disabled for this program, nothing invented');
  } else if (C.paragraphs.length){
    const nameSet = new Set(C.paragraphs.map(p=>p.name));
    const targetsOf = {};
    const addT = (from, to) => { if (from && to && nameSet.has(to)) (targetsOf[from] = targetsOf[from] || []).push(to); };
    C.performs.forEach(p => { addT(p.from, p.to); if (p.thru) addT(p.from, p.thru); });
    C.gotos.forEach(g => addT(g.from, g.to));
    C.cics.forEach(x => (x.handles || []).forEach(h => addT(x.para, h.to)));
    const isTerm = u => !!u && /^(GO\s+TO|GOTO|STOP\s+RUN|GOBACK|EXIT\s+PROGRAM|EXIT\s+CICS)\b/.test(u);
    const RE = new Set(['']);   // '' = implicit entry block (statements before the 1st paragraph)
    let changed = true, guard = 0;
    while (changed && guard++ < C.paragraphs.length + 2){
      changed = false;
      let fall = !isTerm(C.flowLast ? C.flowLast[''] : null);
      for (const p of C.paragraphs){
        const r = fall || RE.has(p.name);
        if (r && !RE.has(p.name)){ RE.add(p.name); changed = true; }
        fall = r && !isTerm(C.flowLast ? C.flowLast[p.name] : null);
      }
      for (const src of RE){
        (targetsOf[src] || []).forEach(t => { if (!RE.has(t)){ RE.add(t); changed = true; } });
      }
    }
    C.paragraphs.forEach(p => {
      if (!RE.has(p.name)){
        C.dead.push({ name: p.name, ln: p.ln });
        C.warns.push(`paragraph ${p.name} (line ${p.ln}) appears unreachable — no PERFORM/GO TO target and no fall-through path (dead code)`);
      }
    });
  }
  resolveOps(C);
  resolveCalls(C);
  return C;
}

// ══════════════════ 1c. MODEL & GRAPH (typed, evidence, confidence) ══════════════════
