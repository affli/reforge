// True COBOL parser: fixed/free format, divisions/sections/paragraphs,
// SELECT ASSIGN, data levels (PIC/OCCURS/REDEFINES/VALUE), COPY
// nested (+REPLACING), PERFORM/THRU, CALL (literal + dynamically resolved),
// GO TO (including inside IF), READ/WRITE/REWRITE/OPEN, EXEC SQL blocks.
// Anything unrecognized produces a warning — no
// dependency is never invented.

function tkWords(s){ return s.replace(/,+$/,'').trim().split(/\s+/).filter(Boolean); }

function cobDetectFixed(raw){
  const lines = raw.split(/\r?\n/);
  let seq = 0, ind = 0, col8 = 0, nonEmpty = 0;
  for (const l of lines){
    if (!l.trim()) continue;
    nonEmpty++;
    if (/^[0-9]{3,6}(\s|$)/.test(l)) seq++;
    if (l.length > 7 && /^[0-9 ]{6}[*\-\/Dd]/.test(l.slice(0,7))) ind++;
    const first = l.search(/\S/);
    if (first >= 7) col8++;
  }
  if (!nonEmpty) return false;
  return (seq / nonEmpty >= 0.5) || (ind / nonEmpty >= 0.5) || (col8 / nonEmpty >= 0.6);
}

function cobLogicalItems(text, warns){
  const lines = text.split(/\r?\n/);
  // detected ONCE for the whole file: in free format, an entry
  // indented "    05  X PIC 9." must not be confused with a
  // fixed sequence area — otherwise the data level would be swallowed.
  const fixed0 = cobDetectFixed(text);
  let fixed = fixed0; // >>SOURCE FORMAT can change the format mid-file (real mixed case)
  const items = [];
  let inSql = false, sqlBuf = [], sqlStart = 0;
  let inCics = false, cicsBuf = [], cicsStart = 0;
  let litOpen = false; // literal still open at end of line ('-' continuation)
  for (let i = 0; i < lines.length; i++){
    const orig = lines[i];
    let l = orig;
    // COBOL 2002 directives: >>SOURCE FORMAT IS FREE/FIXED switches the format,
    // other >> (DEFINE, IF…) have no analysis effect — ignored
    const otrim = orig.trim();
    if (otrim.startsWith('>>')){
      const fm = otrim.match(/^>>\s*SOURCE\b.*?\b(FREE|FIXED)\b/i);
      if (fm) fixed = fm[1].toUpperCase() === 'FIXED';
      continue;
    }
    let ind = '';
    if (fixed){
      // fixed format: sequence area (col 1-6) + indicator (col 7), truncation at 72
      ind = l.length > 6 ? l[6] : ' ';
      if (ind === '*' || ind === '/') continue; // comment line
      if (ind === '-') l = '       ' + l.slice(7); // continuation: area A ignored
      else l = l.slice(7);
      if (l.length > 72) l = l.slice(0, 72);
      if (orig.length > 72 && warns) warns.push(`line ${i+1}: statement beyond column 72 truncated (fixed format)`);
    } else {
      // "mixed" free-format file: an isolated sequenced line (6 digits + space) stays fixed
      if (/^[0-9]{6}\s+\S/.test(l)) l = l.slice(7);
      if (l.length > 80){
        if (warns) warns.push(`line ${i+1}: very long line — free format assumed, not truncated`);
      }
    }
    // listing/compiler directives: EJECT, SKIP1-3, TITLE, CBL/*CBL — not code
    const ltrim = l.trim();
    if (/^(EJECT|SKIP[123])(\.|\s*$)/i.test(ltrim) || /^(TITLE|CBL)\b/i.test(ltrim)) continue;
    // free format: * or / at start of line (column 1) = comment/page-eject
    if (!fixed && /^\s*[*/]/.test(l)) continue;
    // floating comment *> (COBOL 2002+) — removed outside literals
    // (single OR double quote: both forms exist in 2002)
    {
      let q = false;
      for (let ci = 0; ci < l.length - 1; ci++){
        const ch = l[ci];
        if (ch === "'" || ch === '"') q = !q;
        else if (!q && ch === '*' && l[ci+1] === '>'){ l = l.slice(0, ci).trim(); break; }
      }
    }
    if (!l.trim()) continue;
    if (inSql){
      sqlBuf.push(l);
      if (/\bEND-EXEC\b/i.test(l)){
        items.push({ t: 'sql', text: sqlBuf.join(' '), ln: sqlStart });
        inSql = false; sqlBuf = [];
      }
      continue;
    }
    if (/^\s*EXEC\s+SQL\b/i.test(l)){
      if (/\bEND-EXEC\b/i.test(l)){
        items.push({ t: 'sql', text: l, ln: i+1 });
      } else {
        inSql = true; sqlBuf = [l]; sqlStart = i+1;
      }
      continue;
    }
    // EXEC CICS ... END-EXEC: dedicated block, same mechanics as SQL
    if (inCics){
      cicsBuf.push(l);
      if (/\bEND-EXEC\b/i.test(l)){
        items.push({ t: 'cics', text: cicsBuf.join(' '), ln: cicsStart });
        inCics = false; cicsBuf = [];
      }
      continue;
    }
    if (/^\s*EXEC\s+CICS\b/i.test(l)){
      if (/\bEND-EXEC\b/i.test(l)){
        items.push({ t: 'cics', text: l, ln: i+1 });
      } else {
        inCics = true; cicsBuf = [l]; cicsStart = i+1;
      }
      continue;
    }
    // literal continuation (col 7 '-'): the string resumes at the quote
    // WITHOUT inserted space — otherwise 'ABC' continued by 'DEF' would be corrupted
    if (fixed && ind === '-' && litOpen && items.length && items[items.length-1].t === 'line'){
      const last = items[items.length-1];
      const cm = l.trim().match(/^'(.*)$/);
      if (cm) last.text = last.text.replace(/\s+$/,'') + cm[1];
      else last.text += ' ' + l.trim();
    } else {
      items.push({ t: 'line', text: l, ln: i+1 });
    }
    {
      const lc = items.length && items[items.length-1].t === 'line' ? items[items.length-1].text : '';
      litOpen = (lc.match(/'/g) || []).length % 2 === 1;
    }
  }
  if (inSql && warns) warns.push(`line ${sqlStart}: EXEC SQL block without END-EXEC`);
  if (inCics && warns) warns.push(`line ${cicsStart}: EXEC CICS block without END-EXEC`);
  return { items, fixedHint: lines.some(l => /^[0-9]{3,6}(\s|$)/.test(l)) };
}

function cobSentences(items){
  const out = [];
  let buf = [], start = null;
  const endsWithPeriod = s => /\.\s*$/.test(s);
  for (const it of items){
    if (it.t === 'sql'){ out.push({ t:'sql', text: it.text, ln: it.ln }); continue; }
    if (it.t === 'cics'){ out.push({ t:'cics', text: it.text, ln: it.ln }); continue; }
    if (start === null) start = it.ln;
    // continuation: a line not ending with a half-known verb/keyword is joined to the next one
    buf.push(it.text.trim());
    const joined = buf.join(' ');
    if (endsWithPeriod(joined)){
      out.push({ t:'sentence', text: joined, ln: start });
      buf = []; start = null;
    }
  }
  if (buf.length){
    const joined = buf.join(' ');
    if (/\.\s*$/.test(joined)) out.push({ t:'sentence', text: joined, ln: start });
    else out.push({ t:'sentence', text: joined + '.', ln: start, incomplete: true });
  }
  return out;
}

function parseReplacing(s){
  // COPY X REPLACING ==A== BY ==B==  |  A BY B  |  LEADING/TRAILING ==A== BY ==B==
  // Pseudo-text (==...==) : correspondance TEXTOUELLE, y compris multi-mots et
  // non-word characters (:PREFIX:, -REC...). Simple word: delimited by \b.
  const pairs = [];
  const re = /(LEADING|TRAILING)?\s*(?:==([^=]+)==|\b([A-Z0-9][A-Z0-9\-]*)\b)\s+BY\s+(?:==([^=]+)==|\b([A-Z0-9][A-Z0-9\-]*)\b)/gi;
  let m;
  while ((m = re.exec(s))){
    const from = (m[2] !== undefined ? m[2] : (m[3] || '')).toUpperCase().trim();
    const to = (m[4] !== undefined ? m[4] : (m[5] || '')).toUpperCase().trim();
    if (from) pairs.push({ from, to, mode: (m[1] || '').toUpperCase(), pt: m[2] !== undefined });
  }
  return pairs;
}
function applyReplacing(t, pairs){
  for (const p of pairs){
    const a = p.from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    try {
      // replacement by function: the replacement text ($, &…) is inserted as is
      if (p.mode === 'LEADING') t = t.replace(new RegExp(p.pt ? a : '\\b' + a, 'gi'), () => p.to);
      else if (p.mode === 'TRAILING') t = t.replace(new RegExp(p.pt ? a : a + '\\b', 'gi'), () => p.to);
      else t = t.replace(new RegExp(p.pt ? a : '\\b' + a + '\\b', 'gi'), () => p.to);
    } catch(e){ /* invalid pattern → original text kept */ }
  }
  return t;
}

function expandCopies(sents, registry, ctx, stack){
  const out = [];
  for (const sn of sents){
    if (sn.t !== 'sentence'){ out.push(sn); continue; }
    const cm = sn.text.match(/^COPY\s+([A-Z0-9\-]+)\s*(.*?)\.\s*$/i);
    if (!cm){ out.push(sn); continue; }
    const bname = cm[1].toUpperCase();
    const book = registry[bname] || registry[bname.replace(/^-/,'')];
    if (!book){
      ctx.warns.push(`line ${sn.ln}: COPY ${bname} not uploaded — layout unknown`);
      ctx.copyUsed.push({ name: bname, resolved: false, ln: sn.ln, file: ctx.file });
      out.push(sn); // keep the COPY sentence for trace
      continue;
    }
    if (stack.includes(bname)){
      ctx.warns.push(`line ${sn.ln}: COPY ${bname} circular reference — skipped`);
      continue;
    }
    if (stack.length >= 10){
      ctx.warns.push(`line ${sn.ln}: COPY nesting deeper than 10 — stopped`);
      continue;
    }
    ctx.copyUsed.push({ name: bname, resolved: true, ln: sn.ln, file: ctx.file });
    let btext = book.text;
    const pairs = parseReplacing(cm[2]);
    if (pairs.length) btext = applyReplacing(btext, pairs);
    const sub = expandCopies(cobSentences(cobLogicalItems(btext, ctx.warns).items).filter(s=>s.t==='sentence'), registry, ctx, stack.concat(bname));
    out.push({ t:'sentence', text: sn.text, ln: sn.ln, copy: bname });
    sub.forEach(s => { if (s.t==='sentence' && s.copy !== undefined) out.push(s); else out.push(s); });
  }
  return out;
}

const SQLKW = new Set(['SELECT','INSERT','UPDATE','DELETE','FROM','WHERE','SET','INTO','VALUES','JOIN','INNER','LEFT','RIGHT','OUTER','ON','AND','OR','NOT','IN','BETWEEN','LIKE','ORDER','GROUP','BY','AS','DISTINCT','UNION','ALL','CURSOR','FOR','FETCH','DECLARE','OPEN','CLOSE','WITH','HAVING','EXISTS','CASE','WHEN','THEN','END','TABLE','CREATE','DROP','ALTER','INDEX','VIEW','COUNT','SUM','AVG','MIN','MAX','CURRENT','TIMESTAMP','DATE','SCHEMA','COMMIT','ROLLBACK','WHENEVER','NOT','FOUND','SQLSTATE','SQLCODE','WITH','HOLD','SQLEXCEPTION','SQLWARNING','DESCRIPTOR','MERGE','TRUNCATE','ONLY','ROW','ROWS']);

function sqlTables(st){
  // st = text of an EXEC SQL block (without the prefix) → referenced tables
  // False positives excluded: aliases (only the first name kept), CTE (with
  // column list or recursive), subqueries "(SELECT…", host
  // variables, table functions. Quoted identifiers supported, qualified included.
  const text = st.replace(/^\s*EXEC\s+SQL/i,'').replace(/\bEND-EXEC\b\.?\s*$/i,'');
  const upper = text.toUpperCase();
  const tabs = new Set();
  // noms de CTE (WITH X AS (…) / WITH X (A,B) AS (…) / WITH RECURSIVE R AS (…)) :
  // these are not tables — excluded from the results
  const ctes = new Set();
  const cteRe = /(?:\bWITH\b(?:\s+RECURSIVE)?|,)\s*([A-Z0-9\-]+)\s*(?:\([^)]*\))?\s*AS\s*\(/g;
  let cm2;
  while ((cm2 = cteRe.exec(upper))) ctes.add(cm2[1]);
  // an identifier: quoted "MY TABLE" or plain; a name: 1 to 4 identifiers separated by dots
  const qid = (s) => {
    if (s.startsWith('"')){ const e = s.indexOf('"', 1); return e < 1 ? null : { id: s.slice(1, e), rest: s.slice(e + 1) }; }
    const mm = s.match(/^([A-Z0-9\-@#$_]+)/); return mm ? { id: mm[1], rest: s.slice(mm[1].length) } : null;
  };
  const parseName = (s) => {
    let name = '', rest = s.trim();
    for (let i = 0; i < 4; i++){
      const p = qid(rest);
      if (!p) break;
      name = name ? name + '.' + p.id : p.id;
      rest = p.rest.trim();
      if (rest.charAt(0) === '.'){ rest = rest.slice(1).trim(); continue; }
      break;
    }
    return { name, rest };
  };
  const pushList = (s) => {
    s.split(',').forEach(x => {
      const t = x.trim();
      if (!t) return;
      const { name } = parseName(t);
      if (!name) return; // "(SELECT…" (subquery), ":host-var"…
      const last = name.split('.').pop();
      // rejected by the LAST segment: SCHEMA.T1 is a table, but a lone FROM
      // (TABLE(X), DESCRIPTOR…) or a CTE name never are
      if (SQLKW.has(last) || ctes.has(last) || ctes.has(name)) return;
      if (name.startsWith(':') || name.startsWith('&')) return;
      tabs.add(name);
    });
  };
  // FROM t1, t2 alias / JOIN t / INTO t / UPDATE t / USING t (MERGE) / TABLE t (TRUNCATE, CREATE)
  const re = /\b(FROM|INTO|UPDATE|JOIN|TABLE|USING)\b/g;
  let m;
  while ((m = re.exec(upper))){
    const after = upper.slice(m.index + m[0].length).trim();
    // stop at the next SQL keyword
    let seg = after;
    const kwRe = /\b(SELECT|FROM|WHERE|SET|ON|USING|JOIN|INNER|LEFT|RIGHT|OUTER|VALUES|FOR|WITH|AS|END-EXEC)\b/;
    const km = seg.match(kwRe);
    if (km) seg = seg.slice(0, km.index);
    pushList(seg);
  }
  return [...tabs];
}

function sqlParse(C, s){
  const raw = s.text.replace(/^\s*EXEC\s+SQL/i,'').replace(/\bEND-EXEC\b\.?\s*$/i,'');
  const U = raw.toUpperCase();
  const first = tkWords(U)[0];
  // statements without data access: no edge, no noise
  if (['INCLUDE','WHENEVER','COMMIT','ROLLBACK','CONNECT','SET','FETCH','OPEN','CLOSE'].includes(first)){
    C.sql.push({ op: 'other', tables: [], ln: s.ln, text: raw.trim().slice(0, 200) });
    return;
  }
  if (first === 'PREPARE' || first === 'EXECUTE'){
    // dynamic SQL: the query text is unknown → 0 tables, no false positive
    C.sql.push({ op: 'dynamic', tables: [], ln: s.ln, text: raw.trim().slice(0, 200) });
    C.warns.push(`line ${s.ln}: dynamic SQL (${first}) — statement text unknown, tables NOT extracted (no false positive)`);
    return;
  }
  let op = null;
  if (first === 'DECLARE'){
    const cm = U.match(/\bCURSOR\s+FOR\s+(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/);
    if (!cm){
      // DECLARE X TABLE / host variable declarations: not a data access
      C.sql.push({ op: 'other', tables: [], ln: s.ln, text: raw.trim().slice(0, 200) });
      return;
    }
    op = cm[1];
  } else if (['SELECT','INSERT','UPDATE','DELETE','MERGE','TRUNCATE'].includes(first)) op = first;
  // operation normalization: SELECT→read, INSERT/DELETE/TRUNCATE→write, UPDATE/MERGE→update
  if (op === 'SELECT') op = 'read';
  else if (op === 'INSERT' || op === 'DELETE' || op === 'TRUNCATE') op = 'write';
  else if (op === 'UPDATE' || op === 'MERGE') op = 'update';
  if (op === null && /\bSELECT\b/.test(U)) op = 'read';
  const tabs = sqlTables(s.text);
  C.sql.push({ op: op || 'unknown', tables: tabs, ln: s.ln, text: raw.trim().slice(0, 200) });
  if (!op)
    C.warns.push(`line ${s.ln}: EXEC SQL statement type not recognized (${first || '?'}) — tables still extracted, no typed edge created`);
}

// ═══ EXEC CICS: files (FCT), maps, queues, XCTL/LINK — never invented ═══
// Each command is recorded with its literal reference. FILE(WS-VAR)
// (value unknown at parse time) and commands without data access (RETURN,
// HANDLE, ASSIGN...) stay silent: no edge, no false positive.
function cicsParse(C, s, para){
  const raw = s.text.replace(/^\s*EXEC\s+CICS/i,'').replace(/\bEND-EXEC\b\.?\s*$/i,'').trim();
  const U = raw.toUpperCase();
  const w = tkWords(U);
  const cmd = w[0];
  const e = { cmd, op: null, file: null, fileVar: null, fileViaVar: false, queue: null, qtype: null, map: null, program: null, handles: null,
    para: para || null, ln: s.ln, silent: false, text: raw.slice(0, 200) };
  const lit = re => { const m2 = U.match(re); return m2 ? m2[1] : null; };
  if (['READ','WRITE','REWRITE','UPDATE','DELETE'].includes(cmd)){
    e.op = cmd === 'READ' ? 'read' : cmd === 'WRITE' ? 'write' : (cmd === 'REWRITE' || cmd === 'UPDATE') ? 'update' : 'delete';
    e.file = lit(/\b(?:FILE|DATASET)\s*\(\s*'([^']*)'\s*\)/);
    if (e.file) C.cicsFiles[e.file] = [...(C.cicsFiles[e.file]||[]), { op: e.op, ln: s.ln, cics: cmd, cicsFile: e.file }];
    else {
      // FILE(variable): value traced from MOVE 'X' TO var / level 88s in resolveOps;
      // if no constant seen → no edge, explicit warning, nothing invented.
      const vm = U.match(/\b(?:FILE|DATASET)\s*\(\s*([A-Z0-9\-]+)\s*\)/);
      e.fileVar = vm ? vm[1] : null;
      e.silent = true;
    }
  } else if (cmd === 'READQ' || cmd === 'WRITEQ' || cmd === 'DELETEQ'){
    e.op = cmd === 'READQ' ? 'read' : cmd === 'WRITEQ' ? 'write' : 'delete';
    e.qtype = (w[1] === 'TS' || w[1] === 'TD') ? w[1] : null;
    e.queue = lit(/\bQUEUE\s*\(\s*'([^']*)'\s*\)/);
    if (!e.queue) e.silent = true;
  } else if (cmd === 'SEND' || cmd === 'RECEIVE'){
    e.map = lit(/\bMAP\s*\(\s*'([^']*)'\s*\)/);
    if (!e.map) e.silent = true; // SEND TEXT / RECEIVE without MAP: not a named resource
  } else if (['XCTL','LINK','CALL','TRANSFER'].includes(cmd)){
    e.program = lit(/\bPROGRAM\s*\(\s*'([^']*)'\s*\)/);
    if (!e.program) e.silent = true; // PROGRAM(variable): unknown target → no edge
  } else if (cmd === 'HANDLE'){
    // HANDLE CONDITION err(PARA) ... / HANDLE AID ENTER(PARA) ... / HANDLE ABEND PROGRAM('X')
    e.handles = [];
    const hre = /([A-Z][A-Z0-9\-]*)\s*\(\s*([A-Z0-9\-]+)\s*\)/g;
    let hm;
    while ((hm = hre.exec(U))) e.handles.push({ key: hm[1], to: hm[2] });
    e.program = lit(/\bPROGRAM\s*\(\s*'([^']*)'\s*\)/);   // HANDLE ABEND PROGRAM('X')
    e.silent = !(e.handles.length || e.program);
  } else {
    e.silent = true; // RETURN/IGNORE/ASSIGN/GETMAIN...: no data access, no noise
  }
  C.cics.push(e);
}

const IDENT = /^[A-Z0-9][A-Z0-9\-]*$/;
// keywords that CANNOT be paragraph names (shared engine + translator)
const PARAGRAPH_KW = /^(SECTION|DIVISION|END|DECLARATIVES|EXIT|STOP|GO|GOBACK|PERFORM|MOVE|IF|ELSE|CALL|READ|WRITE|OPEN|CLOSE|DISPLAY|COMPUTE|ADD|SUBTRACT|MULTIPLY|DIVIDE|SET|INITIALIZE|ACCEPT|EVALUATE|END-EVALUATE|WHEN|END-IF|UNTIL|VARYING|CONTINUE|RETURN)$/;

// ══════════════════ 1c. COBOL → PYTHON TRANSLATION (deterministic) ══════════════════
