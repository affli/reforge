
function emptyState(icon, title, sub){
  return `<div class="empty"><div class="e-icon">${icon}</div><div class="e-title">${title}</div><div class="e-sub">${sub}</div>
  <div class="e-hint">💡 Tip: click <b>“Try with a sample system”</b> or drop your own files to see this panel in action.</div></div>`;
}

// ══════════════════ 4. SVG SYSTEM MAP (dynamique) ══════════════════

function svgMap(filter=''){
  const m = getModel();
  const all = [...m.nodes.values()];
  const cols = [
    {x:40,  w:160, type:'JOB',      c:'var(--cyan)',    items:all.filter(n=>n.type==='job').map(n=>({id:n.id, label:n.name}))},
    {x:230, w:160, type:'PROGRAM',  c:'var(--accent)',  items:all.filter(n=>n.type==='prog'||n.type==='xpgm').map(n=>({id:n.id, label:n.name + (n.type==='xpgm'?' *':'')}))},
    {x:420, w:160, type:'COPYBOOK', c:'var(--yellow)',  items:all.filter(n=>n.type==='cpy').map(n=>({id:n.id, label:n.name}))},
    {x:610, w:170, type:'DATASET',  c:'var(--green)',   items:all.filter(n=>n.type==='ds').map(n=>({id:n.id, label:n.name + (n.data.temp?' (temp)':'')}))},
    {x:810, w:170, type:'DB2 TABLE',c:'var(--red)',     items:all.filter(n=>n.type==='tbl').map(n=>({id:n.id, label:n.name}))},
    {x:1010, w:170, type:'CICS',    c:'var(--yellow)',  items:all.filter(n=>n.type==='fct'||n.type==='map'||n.type==='q')
      .map(n=>({id:n.id, label:n.name + (n.type==='fct'?' (FCT)':n.type==='q'?' (queue)':' (map)')}))},
  ];
  const nodes = []; const idx = {};
  cols.forEach(col=>col.items.forEach((it,i)=>{
    idx[it.id] = nodes.length;
    nodes.push({ label: it.label, type:col.type, c:col.c, x:col.x, y:18+i*70, w:col.w });
  }));
  const maxN = Math.max(1, ...cols.map(c=>c.items.length));
  const height = 18 + (maxN-1)*70 + 44 + 16;
  const width = 1010 + 170 + 40;
  const fl = (filter||'').toLowerCase();
  const idLabel = id => { const n = nodes[idx[id]]; return n ? n.label : ''; };
  // ORIGINAL indices (not those of the filtered array) — otherwise the CBPAY/PAYROLL filter
  // hid matching entities (real bug reported by a user)
  const vis = new Set(nodes.map((n,i)=>n.label.toLowerCase().includes(fl)?i:-1).filter(i=>i>=0));
  // top-level projection: step→X becomes job→X (steps are not drawn)
  const proj = new Set();
  for (const e of m.edges){
    let f = e.f, t = e.t;
    if (f.startsWith('step|')){
      if (t.startsWith('step|')) continue; // contains : interne
      f = 'job|' + f.split('|')[1].split('.')[0];
    }
    proj.add(f + '>' + t);
  }
  const edges = [...proj].map(k=>{ const [f,t] = k.split('>'); return {f,t}; })
    .filter(e=>idx[e.f]!=null && idx[e.t]!=null && vis.has(idx[e.f]) && vis.has(idx[e.t]))
    .map(e=>{
      const A = nodes[idx[e.f]], B = nodes[idx[e.t]];
      return `<path class="edge" marker-end="url(#arrow)" d="M ${A.x+A.w} ${A.y+22} C ${A.x+A.w+45} ${A.y+22}, ${B.x-45} ${B.y+22}, ${B.x} ${B.y+22}"/>`;
    }).join('');
  const nn = nodes.map((n,i)=>vis.has(i)?`
    <g class="node" transform="translate(${n.x},${n.y})">
      <rect width="${n.w}" height="44" fill="var(--bg3)" stroke="${n.c}"/>
      <text x="10" y="19">${esc(n.label.length>18?n.label.slice(0,17)+'…':n.label)}</text>
      <text class="ntype" x="10" y="34">${n.type}</text>
    </g>`:'').join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="display:block">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--border2)"/></marker></defs>
    ${edges}${nn}</svg><p class="note" style="margin-top:6px">* = external program (not uploaded). Jobs link to programs and datasets through their steps; every relation shown was detected — nothing inferred.</p>`;
}

// ══════════════════ 5. SYNTAX HIGHLIGHTING (lightweight) ══════════════════

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function hl(text){
  const re = /\b(IDENTIFICATION DIVISION|PROCEDURE DIVISION|WORKING-STORAGE|FILE SECTION|PROGRAM-ID|END-PERFORM|END-EXEC|END-IF|GO TO|STOP RUN|PERFORM|COMPUTE|ROUNDED|UNTIL|EXEC SQL|SELECT|ASSIGN|DISPLAY|MOVE|COPY|READ|OPEN|CLOSE|PIC|ADD|END|JOB|EXEC|PGM|DSN|DD)\b/g;
  return esc(text).replace(re, m=>`<span class="k">${m}</span>`);
}
function firstLines(text, n){
  const l = text.split('\n');
  return (l.length>n ? l.slice(0,n).join('\n') + `\n… (${l.length} lines total)` : l.join('\n'));
}

// ══════════════════ 5b. ANTHROPIC API KEY (stockage local) ══════════════════
