
const PANELS = {
  map: () => state.loaded ? `
    <div class="toolbar">
      <input placeholder="Filter entities…" oninput="track('map_filter');document.getElementById('mapHolder').innerHTML=svgMap(this.value)">
      <div class="legend"><span><i style="background:var(--cyan)"></i>Jobs</span><span><i style="background:var(--accent)"></i>Programs</span><span><i style="background:var(--yellow)"></i>Copybooks</span><span><i style="background:var(--green)"></i>Datasets</span><span><i style="background:var(--red)"></i>DB2 tables</span></div>
    </div>
    <div class="svgwrap" id="mapHolder">${svgMap()}</div>`
    : emptyState('🗺','No system loaded','Drop your JCL and/or COBOL files — the system map will appear here once analysis is complete.'),

  flow: () => {
    if (!state.loaded) return emptyState('🔀','No flow computed','Dependencies between jobs, steps and COBOL paragraphs (PERFORM / CALL / GOTO) will appear here.');
    const g = buildGraph();
    const m = getModel();
    const jobCards = g.jobs.map(j=>`
      <div class="card" style="max-width:620px;margin-bottom:14px">
        <h3>${base(j.name)} — job flow</h3>
        ${j.parsed.steps.length ? j.parsed.steps.map(s=>`
          <div class="step-body"><div class="step-head">//${esc(s.name)}</div>
          <div class="step-sub">${stepDesc(s)}${s.kind === 'PGM' && s.pgm ? (g.programs.some(p=>p.parsed.programId===s.pgm) ? ' · <span style="color:var(--green)">✓ detected program</span>' : ' · <span style="color:var(--yellow)">external program</span>') : ''}</div></div>`).join('')
        : '<p class="note">No EXEC step found in this job.</p>'}
        ${j.parsed.dsns.length ? `<p class="note">DD datasets: ${j.parsed.dsns.map(esc).join(' · ')}</p>` : ''}
      </div>`).join('');
    const progCards = Object.entries(m.internal).map(([pname,inn])=>`
      <div class="card" style="max-width:620px;margin-bottom:14px">
        <h3>${esc(pname)} — program flow</h3>
        ${inn.paragraphs.length ? `<p class="note">Paragraphs: ${inn.paragraphs.map(p=>{ const d = (inn.dead||[]).some(x=>x.name===p.name); return `<span class="pill pill-io"${d?' style="text-decoration:line-through;opacity:.55" title="unreachable — dead code"':''}>${esc(p.name)}${d?' ☠':''}</span>`; }).join(' ')}</p>` : '<p class="note">No paragraph detected.</p>'}
        ${(inn.dead||[]).length ? `<p class="note" style="color:var(--yellow)">☠ Unreachable (${(inn.dead||[]).length}): ${(inn.dead||[]).map(d=>esc(d.name)+' (L'+d.ln+')').join(' · ')} — no PERFORM/GO TO target, no fall-through path. Verify before deleting.</p>` : ''}
        ${inn.edges.length ? inn.edges.map(e=>`<div class="step-sub"><span class="mono" style="color:var(--accent)">${esc(e.from||'—')}</span> <span style="color:var(--purple)">—${e.k==='goto'?'GO TO':e.k==='handle'?'HANDLE':'PERFORM'}→</span> <span class="mono">${esc(e.to)}</span> <span class="note">(L${e.ln})</span></div>`).join('') : '<p class="note">No PERFORM / GO TO between paragraphs detected in this program.</p>'}
      </div>`).join('');
    const feeds = m.edges.filter(e => e.k === 'feed');
    const feedCard = feeds.length ? `<div class="card" style="max-width:620px;margin-bottom:14px">
      <h3>Cross-job dependencies (shared datasets)</h3>
      ${feeds.map(e => `<div class="step-sub"><span class="mono" style="color:var(--accent)">${esc(nodeLabel(e.f))}</span> <span style="color:var(--purple)">—feeds→</span> <span class="mono">${esc(nodeLabel(e.t))}</span> ${e.c === 'certain' ? '<span class="pill" style="color:var(--green);border:1px solid var(--green)">CERTAIN</span>' : '<span class="pill" style="color:var(--yellow);border:1px solid var(--yellow)">PROBABLE</span>'}
      <div class="note">${esc(e.ev.map(x => x.note).join(' · '))}</div></div>`).join('')}
      <p class="note">Order inferred from DD I/O direction (write→read) → PROBABLE. An imported scheduler export (JOB … AFTER …) confirms the order → CERTAIN. Execution order across jobs is otherwise NOT known offline.</p></div>` : '';
    if (!jobCards && !progCards) return emptyState('🔀','No job or program found','Job steps are detected from //STEP EXEC PGM= statements.');
    return feedCard + jobCards + progCards;
  },

  programs: () => {
    if (!state.loaded) return emptyState('🖥','No program loaded','JCL jobs and COBOL programs will appear here, regardless of their source language.');
    const m = getModel();
    const rows = [];
    [...m.nodes.values()].filter(n=>n.type==='prog').forEach(n=>{
      const f = state.files.find(x=>x.lang==='CBL' && x.parsed.cobol && x.parsed.cobol.programId===n.name);
      const rf = n.data && n.data.rexx ? state.files.find(x=>x.lang==='REXX' && x.parsed.rexx && x.parsed.rexx.execName===n.name) : null;
      const callers = (m.rev[n.id]||[]).filter(e=>e.k==='exec'||e.k==='call').map(e=>nodeLabel(e.f)).join(', ');
      const lonely = !(m.rev[n.id]||[]).some(e=>e.k==='exec'||e.k==='call');
      rows.push({name:n.name, lang: rf ? 'REXX' : 'COBOL', ext:false, lonely, lines:(rf||f)?(rf||f).lines:'—', by:callers||'—'});
    });
    [...m.nodes.values()].filter(n=>n.type==='xpgm').forEach(n=>{
      const callers = (m.rev[n.id]||[]).map(e=>nodeLabel(e.f)).join(', ');
      rows.push({name:n.name, lang:'—', ext:true, lines:'—', by:callers||'—'});
    });
    [...m.nodes.values()].filter(n=>n.type==='job').forEach(n=>{
      rows.push({name:n.name, lang:'JCL', ext:false, lines:'—', by:'—'});
    });
    if (!rows.length) return emptyState('🖥','No program detected','Drop JCL or COBOL files to populate this view.');
    return `<div class="card"><table class="tbl">
      <tr><th>Program / Job</th><th>Language</th><th>Lines</th><th>Called by</th></tr>
      ${rows.map(r=>`<tr><td>${esc(r.name)}${r.ext?' <span class="pill" style="color:var(--yellow);border:1px solid var(--yellow)">EXTERNAL</span>':''}${r.lonely?' <span class="pill" style="color:var(--yellow);border:1px solid var(--yellow)">NEVER CALLED?</span>':''}</td><td><span class="pill pill-io">${r.lang}</span></td><td>${r.lines}</td><td>${esc(r.by)}</td></tr>`).join('')}
    </table><p class="note">EXTERNAL = referenced by EXEC/CALL but not uploaded. NEVER CALLED? = no detected caller within the analyzed set (could be scheduled elsewhere). “Called by” lists detected callers (JCL steps, CALL/XCTL from other programs) with evidence.</p></div>`;
  },

  data: () => {
    if (!state.loaded) return emptyState('🗂','No data detected','JCL datasets, COBOL SELECT/FD files and data structures will appear here.');
    const m = getModel();
    const dsNodes = [...m.nodes.values()].filter(n=>n.type==='ds');
    if (!dsNodes.length) return emptyState('🗂','No dataset detected','Datasets are detected from JCL DD DSN= statements.');
    return `<div class="card"><table class="tbl">
      <tr><th>Dataset</th><th>Usage</th><th>Accessed by (step)</th><th>Confidence</th><th>Evidence</th></tr>
      ${dsNodes.map(d=>{
        const eds = m.rev[d.id]||[];
        return `<tr><td>${esc(d.name)}${d.data.temp?' <span class="pill" style="color:var(--purple);border:1px solid var(--purple)">TEMP</span>':''}${d.data.gdg!=null?' <span class="pill" style="color:var(--purple);border:1px solid var(--purple)">GDG</span>':''}</td>
        <td>${[...new Set(eds.map(e=>e.k))].filter(k=>['read','write','update','delete','unknown'].includes(k)).map(opBadge).join(' ')||'<span class="pill pill-io">—</span>'}</td>
        <td>${eds.map(e=>esc(nodeLabel(e.f))).join('<br>')||'—'}</td>
        <td>${[...new Set(eds.map(e=>e.c))].map(confBadge).join(' ')}</td>
        <td class="note">${eds.map(e=>esc((e.ev[0]?e.ev[0].file+' L'+e.ev[0].ln:'')+(e.ev.length>1?' +'+(e.ev.length-1)+' more':''))).join('<br>')}</td></tr>`;
      }).join('')}
    </table><p class="note">READ/WRITE is <b>certain</b> when a COBOL SELECT/ASSIGN matches the JCL DDNAME and an I/O verb (OPEN/READ/WRITE/REWRITE) is found, <b>probable</b> from DISP only, <b>unclear</b> when neither is available.</p></div>`;
  },

  impact: () => {
    if (!state.loaded) return emptyState('💥','Impact Analysis','Run analysis then select any entity to see its dependencies.');
    const m = getModel();
    const nodes = [...m.nodes.values()].filter(n=>n.type!=='step');
    if (!nodes.length) return emptyState('💥','Nothing to analyze yet','Drop files first.');
    if (!state.entity || !m.nodes.has(state.entity)) state.entity = nodes[0].id;
    const res = impact(m, state.entity);
    const GRP = { job:'Jobs', step:'Steps', prog:'Programs', para:'Paragraphs', cpy:'Copybooks', ds:'Datasets', tbl:'DB2 tables', xpgm:'External programs', fct:'CICS files (FCT)', map:'CICS maps', q:'CICS queues' };
    const itemHTML = it => {
      const n = m.nodes.get(it.id);
      return `<div class="entity-row" style="margin-bottom:8px">
        <b>${esc(it.id.split('|')[1])}</b> <span class="pill pill-io">${n?n.type:'?'}</span> ${confBadge(it.conf)}
        <span class="note">(${it.depth===1?'direct':'indirect, depth '+it.depth})</span>
        <div class="note">path: ${it.path.map(p=>esc(p.split('|')[1])).join(' ← ')}</div>
        ${(it.paths && it.paths.length > 1) ? it.paths.slice(1).map((p,pi)=>`<div class="note" style="color:var(--yellow)">alt path ${pi+2}/${it.paths.length}: ${p.path.map(pp=>esc(pp.split('|')[1])).join(' ← ')} ${confBadge(p.conf)}</div>`).join('') : ''}
        ${it.edge ? `<div class="note">because it ${esc(EDGE_VERB[it.edge.k]||it.edge.k)} — evidence: ${esc(it.edge.ev[0]?it.edge.ev[0].file+' L'+it.edge.ev[0].ln:'n/a')}</div>` : ''}
      </div>`;
    };
    const byType = arr => {
      let h = '';
      for (const [t,label] of Object.entries(GRP)){
        const its = arr.filter(x=>m.nodes.get(x.id) && m.nodes.get(x.id).type===t);
        if (its.length) h += `<p class="note" style="margin-top:8px"><b>${label} (${its.length})</b></p>` + its.map(itemHTML).join('');
      }
      return h;
    };
    let opts = '';
    nodes.forEach((n,i)=>{ opts += `<option value="${i}"${state.entity===n.id?' selected':''}>${esc(n.type.toUpperCase()+' — '+n.name)}</option>`; });
    const selName = state.entity.split('|')[1];
    return `
    <div class="toolbar"><select class="key-input" style="width:auto" onchange="state.entity=impNodeId(this.value);renderContent()">${opts}</select></div>
    <div class="card" style="max-width:760px;margin-bottom:14px"><h3>Impacted by a change of <span class="mono" style="color:var(--accent)">${esc(selName)}</span></h3>
      ${res.truncated ? `<p class="note" style="color:var(--yellow)">⚠ Depth limit (${res.depthLimit}) reached${res.truncated.rev ? ' upstream' : ''}${res.truncated.fwd ? (res.truncated.rev ? ' and downstream' : ' downstream') : ''} — the walk was stopped there. This impact list may be PARTIAL; entities beyond the limit are not shown.</p>` : ''}
      ${byType(res.up.direct) || '<p class="note">No direct dependent detected.</p>'}
      ${res.up.indirect.length ? `<h3 style="margin-top:12px">Indirect (transitive)</h3>${byType(res.up.indirect)}` : ''}
    </div>
    <div class="card" style="max-width:760px"><h3>What <span class="mono" style="color:var(--accent)">${esc(selName)}</span> depends on</h3>
      ${byType(res.down.direct) || '<p class="note">No detected dependency.</p>'}
      ${res.down.indirect.length ? `<h3 style="margin-top:12px">Indirect</h3>${byType(res.down.indirect)}` : ''}
    </div>`;
  },

  lineage: () => {
    if (!state.loaded) return emptyState('🔀','No data lineage computed','Run analysis to trace data flows across your system.');
    const m = getModel();
    const dsNodes = [...m.nodes.values()].filter(n=>n.type==='ds'||n.type==='tbl');
    if (!dsNodes.length) return emptyState('🔀','No dataset detected','Lineage is built from JCL DD statements, COBOL SELECT/ASSIGN + I/O verbs, and EXEC SQL tables.');
    const html = dsNodes.map(d=>{
      const eds = m.rev[d.id]||[];
      if (!eds.length) return '';
      // downstream derived, honest: each step that READS this dataset (real
      // read/update edge, not write) and the datasets it writes — a single hop,
      // no invention, evidence of the real edges.
      const consumers = eds.filter(e => ['read','update'].includes(e.k));
      const downOut = [];
      const seenOut = new Set();
      consumers.forEach(ce => {
        (m.fwd[ce.f]||[]).forEach(oe => {
          const on = m.nodes.get(oe.t);
          if (oe.t !== d.id && on && on.type === 'ds' && !seenOut.has(ce.f + '\u0001' + oe.t)){
            seenOut.add(ce.f + '\u0001' + oe.t);
            downOut.push({ via: ce.f, e: oe });
          }
        });
      });
      const row = e => {
        const prog = (m.rev[e.f]||[]).filter(x=>x.k==='exec').map(x=>nodeLabel(x.t))[0];
        const op = ['read','write','update','delete','unknown'].includes(e.k) ? e.k : e.k.replace('sql-','');
        const sn = m.nodes.get(e.f);
        const srt = sn && sn.type === 'step' && sn.data.sort && sn.data.sort.fields && sn.data.sort.fields.length
          ? `<span class="pill" style="color:var(--purple);border:1px solid var(--purple)" title="SORT SYSIN cards decoded — transformation shown, not guessed">SORT ${esc(sn.data.sort.fields.map(fl=>fl.pos+','+fl.len+','+fl.type+','+fl.order).join(' '))}${sn.data.sort.sum ? ' · SUM ' + esc(String(sn.data.sort.sum)) : ''}</span>` : '';
        return `<div style="margin-bottom:10px">
          <span class="entity-row">${esc(nodeLabel(e.f))}</span>${prog?` <span class="note">runs ${esc(prog)}</span>`:''}
          ${opBadge(op)} ${confBadge(e.c)} ${srt}
          ${evHTML(e.ev)}</div>`;
      };
        return `<div class="card" style="max-width:680px;margin-bottom:14px">
        <h3>${esc(d.name)} ${d.type==='tbl'?'<span class="pill" style="color:var(--red);border:1px solid var(--red)">DB2</span>':''}${d.data.temp?' <span class="pill" style="color:var(--purple);border:1px solid var(--purple)">TEMP</span>':''}${d.data.gdg!=null?' <span class="pill" style="color:var(--purple);border:1px solid var(--purple)" title="GDG base — generations are relative (+1/0/−1), absolute generation unknown offline">GDG</span>':''}</h3>
        <p class="note" style="margin-bottom:2px"><b>Sources (${eds.length})</b></p>
        ${eds.map(row).join('')}
        ${downOut.length ? `<p class="note" style="margin-bottom:2px;margin-top:10px"><b>Flows into (${downOut.length})</b> — via the steps that read ${esc(d.name)}</p>` + downOut.map(x=>`<div style="margin-bottom:10px"><span class="entity-row">${esc(nodeLabel(x.e.t))}</span> ${opBadge(['read','write','update','delete','unknown'].includes(x.e.k)?x.e.k:x.e.k.replace('sql-',''))} ${confBadge(x.e.c)} <span class="note">via ${esc(nodeLabel(x.via))}</span></div>`).join('') : ''}
      </div>`;
    }).join('');
    return html || emptyState('🔀','No dataset detected','Lineage is built from JCL DD statements, COBOL SELECT/ASSIGN + I/O verbs, and EXEC SQL tables.');
  },

  db2: () => {
    if (!state.loaded) return emptyState('🗄','No DB2 / SQL detected','Upload COBOL with EXEC SQL … END-EXEC statements.');
    const m = getModel();
    const tblNodes = [...m.nodes.values()].filter(n=>n.type==='tbl');
    if (!tblNodes.length) return emptyState('🗄','No DB2 / SQL detected','No EXEC SQL block with table references found in the uploaded COBOL files.');
    const tablesCard = `<div class="card" style="max-width:760px;margin-bottom:14px"><table class="tbl">
      <tr><th>DB2 table</th><th>Operations</th><th>Programs</th><th>Evidence</th></tr>
      ${tblNodes.map(t=>{
        const eds = m.rev[t.id]||[];
        const progs = [...new Set(eds.map(e=>nodeLabel(e.f)))];
        return `<tr><td>${esc(t.name)}</td><td>${[...new Set(eds.map(e=>e.k.replace('sql-','').toUpperCase()))].map(o=>`<span class="pill pill-io">${o}</span>`).join(' ')}</td><td>${esc(progs.join(', '))}</td><td class="note">${eds.map(e=>esc((e.ev[0]?e.ev[0].file+' L'+e.ev[0].ln:''))).join('<br>')}</td></tr>`;
      }).join('')}
    </table></div>`;
    const progCards = state.files.filter(f=>f.lang==='CBL' && f.parsed.cobol && f.parsed.cobol.sql.length).map(f=>{
      const C = f.parsed.cobol;
      return `<div class="card" style="max-width:760px;margin-bottom:14px">
        <h3>SQL in ${esc(C.programId || f.name)}</h3>
        ${C.sql.map(x=>`<div class="step-sub" style="margin-bottom:6px"><span class="pill pill-io">${x.op.toUpperCase()}</span> <span class="mono">${esc(x.tables.join(', ')||'—')}</span> <span class="note">(L${x.ln})</span></div>`).join('')}
      </div>`;
    }).join('');
    return tablesCard + progCards;
  },

  summary: () => {
    if (!state.loaded) return emptyState('📋','Summary not available','Run analysis to generate a system overview.');
    const m = getModel();
    const byT = t=>[...m.nodes.values()].filter(n=>n.type===t);
    const unknownDs = m.edges.filter(e=>e.k==='unknown').length;
    const dynCalls = m.unknownCalls.length;
    const ext = byT('xpgm').length;
    const missingCpy = m.warnings.filter(w=>w.includes('not uploaded')).length;
    const parseWarns = state.files.reduce((a,f)=>a+(f.parsed.warnings||[]).length,0);
    const jobNames = byT('job').map(n=>n.name).join(', ') || 'none';
    const progNames = byT('prog').map(n=>n.name).join(', ') || 'none';
    return `${summaryStoryHTML()}
    <div class="grid2" style="max-width:760px">
      <div class="card"><h3>System overview</h3>
        <p class="note" style="font-size:13px;line-height:1.6;color:var(--text2)">
        This system contains <b class="mono" style="color:var(--text)">${byT('job').length}</b> job(s) (${esc(jobNames)}),
        <b class="mono" style="color:var(--text)">${byT('prog').length}</b> COBOL program(s) (${esc(progNames)}),
        ${byT('cpy').length} copybook(s), ${byT('ds').length} dataset(s) and ${byT('tbl').length} DB2 table(s),
        linked by <b class="mono" style="color:var(--text)">${m.edges.length}</b> detected relation(s).
        Every relation carries its evidence (file + line) and a confidence level: certain, probable or unclear.
        Nothing is displayed that was not actually detected.</p></div>
      <div class="card"><h3>Health signals</h3>
        <div class="log">
          ${!parseWarns && !m.warnings.length ? '<span class="ok">✓ No parse warnings</span><br>' : ''}
          ${byT('cpy').length && !missingCpy ? '<span class="ok">✓ All copybooks resolved</span><br>' : ''}
          ${missingCpy ? `<span class="warn">⚠ ${missingCpy} copybook reference(s) not uploaded</span><br>` : ''}
          ${dynCalls ? `<span class="warn">⚠ ${dynCalls} dynamic CALL(s) with unresolvable target</span><br>` : ''}
          ${unknownDs ? `<span class="warn">⚠ ${unknownDs} dataset usage(s) unclear (no DISP, no matching program)</span><br>` : ''}
          ${ext ? `<span class="warn">⚠ ${ext} external program(s) not uploaded</span><br>` : ''}
          ${(m.dead && m.dead.datasets.length) ? `<span class="warn">⚠ ${m.dead.datasets.length} dataset(s) written but never read in the analyzed set (maybe consumed by jobs not uploaded)</span><br>` : ''}
          ${(m.dead && m.dead.copybooks.length) ? `<span class="warn">⚠ ${m.dead.copybooks.length} copybook(s) never COPYed by an uploaded program</span><br>` : ''}
          ${byT('tbl').length ? `<span class="warn">⚠ DB2 dependencies detected (${byT('tbl').length} table(s))</span><br>` : ''}
        </div></div>
    </div>
    <div class="card" style="max-width:760px"><h3>📤 Export results</h3>
      <p class="note" style="font-size:13px;line-height:1.6;color:var(--text2)">Get the analysis out — no lock-in. JSON (machine), CSV (spreadsheet), Markdown (readable report). Generated locally; nothing is sent anywhere. The project export button in the left panel exports the source files.</p>
      <button class="analyze-btn" style="width:auto" onclick="downloadResults('json')">📄 Results JSON</button>
      <button class="analyze-btn" style="width:auto;margin-left:8px" onclick="downloadResults('csv')">📊 Relations CSV</button>
      <button class="analyze-btn" style="width:auto;margin-left:8px" onclick="downloadResults('md')">📝 Markdown report</button>
      <button class="analyze-btn" style="width:auto;margin-left:8px" onclick="downloadControlReport()">📋 Control report (HTML)</button>
    </div>`;
  },

  history: () => {
    const intro = `<div class="card" style="max-width:900px"><h3>🕰 History — the living graph</h3>
      <p class="note" style="font-size:13px;line-height:1.6;color:var(--text2)">Each analysis build is recorded as a versioned snapshot (entities, relations, per-file content hashes). Select two snapshots to see what a change touched over time. Snapshots are derived from loaded content only — nothing is inferred. Limits: rename detection is not attempted (a renamed dataset = one removal + one addition); the last ${HISTORY_CAP} snapshots are kept; snapshots live in the local session, export the project to keep the files.</p></div>`;
    if (!state.history.length)
      return `${intro}<div class="card" style="max-width:680px"><p class="note">No snapshot yet — they are created automatically each time the analysis is (re)built after a file change.</p></div>`;
    const H = state.history;
    if (state.histA == null) state.histA = Math.max(0, H.length - 2);
    if (state.histB == null) state.histB = H.length - 1;
    const fmt = s => new Date(s.ts).toLocaleString();
    const sel = (key, idx) => `<select onchange="state.${key}=+this.value;renderContent()" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px">` +
      H.map((s,i)=>`<option value="${i}" ${i===idx?'selected':''}>${esc(s.label)} — ${fmt(s)} (${s.counts.nodes}n/${s.counts.edges}e)</option>`).join('') + '</select>';
    const a = H[state.histA] || H[0], b = H[state.histB] || H[H.length-1];
    let body = `<div class="card" style="max-width:900px"><h3>Snapshots (${H.length}, oldest dropped beyond ${HISTORY_CAP})</h3>
      <table class="tbl"><tr><th>Version</th><th>When</th><th>Entities</th><th>Relations</th><th>Warnings</th></tr>
      ${H.map((s,i)=>`<tr><td class="mono">${esc(s.label)}${i===H.length-1?' <span class="note">(latest)</span>':''}</td><td>${fmt(s)}</td><td>${s.counts.nodes}</td><td>${s.counts.edges}</td><td>${s.counts.warnings}</td></tr>`).join('')}</table></div>
      <div class="card" style="max-width:900px"><h3>Δ Compare</h3>
      <p>A: ${sel('histA', state.histA)} &nbsp; B: ${sel('histB', state.histB)}</p>`;
    if (a && b && a !== b){
      const d = graphDiff(a, b);
      const chips = (arr, color) => arr.length ? arr.map(x => `<span class="mono pill" style="border:1px solid ${color};color:${color}">${esc(typeof x === 'string' ? x.split('|').slice(1).join(' · ') : x.name + ' (' + x.type + ')')}</span>`).join(' ') : '<span class="note">none</span>';
      body += `<p class="note">${d.nodesAdded.length} new entitie(s) · ${d.nodesRemoved.length} removed · ${d.edgesAdded.length} new relation(s) · ${d.edgesRemoved.length} removed · ${d.edgesChanged.length} confidence change(s)</p>
        <p><b style="color:var(--green)">+ Entities:</b> ${chips(d.nodesAdded, 'var(--green)')}</p>
        <p><b style="color:var(--red)">− Entities:</b> ${chips(d.nodesRemoved, 'var(--red)')}</p>
        <p><b style="color:var(--green)">+ Relations:</b> ${chips(d.edgesAdded, 'var(--green)')}</p>
        <p><b style="color:var(--red)">− Relations:</b> ${chips(d.edgesRemoved, 'var(--red)')}</p>
        ${d.edgesChanged.length ? `<p><b>⚠ Confidence changed:</b> ${d.edgesChanged.map(c => `<span class="mono">${esc(c.k.split('|').slice(1).join(' · '))}</span> ${esc(c.from)}→${esc(c.to)}`).join(' · ')}</p>` : ''}
        <p><b>Files changed:</b> ${d.filesChanged.length ? d.filesChanged.map(f => `<span class="mono pill" style="border:1px solid var(--yellow);color:var(--yellow)">${esc(f)}</span>`).join(' ') : '<span class="note">none</span>'}
        ${d.filesAdded.length ? ` · added: ${d.filesAdded.map(f=>`<span class="mono">${esc(f)}</span>`).join(', ')}` : ''}${d.filesRemoved.length ? ` · removed: ${d.filesRemoved.map(f=>`<span class="mono">${esc(f)}</span>`).join(', ')}` : ''}</p>`;
    } else body += '<p class="note">Select two different snapshots to compute the diff.</p>';
    body += `</div><div style="margin-top:10px"><button class="analyze-btn" style="width:auto" onclick="takeSnapshot();renderContent()">📌 Snapshot now</button>
      <button class="analyze-btn" style="width:auto;background:var(--bg3)" onclick="clearHistory();renderContent()">🗑 Clear history</button></div>`;
    return intro + body;
  },

  delta: () => {
    const d = state.delta;
    const dl = id => { const p = String(id).split('|'); return p.length > 1 ? p[1] : id; };
    const sideCard = (k, title) => `
      <div class="card" style="max-width:380px;align-self:flex-start">
        <h3>${title}</h3>
        <input type="file" multiple style="display:none" id="deltaFile${k}" onchange="deltaFiles('${k}', this.files)">
        <button class="analyze-btn" style="width:auto" onclick="document.getElementById('deltaFile${k}').click()">📁 Select / drop files</button>
        ${d && d[k] ? `
          <p class="note" style="color:var(--green)">✓ ${d[k].length} file(s): ${d[k].map(f => esc(f.name)).join(', ')}</p>
          <button class="analyze-btn" style="width:auto;margin-top:6px" onclick="deltaClear('${k}')">✕ Clear</button>` : '<p class="note">No files yet.</p>'}
      </div>`;
    const edgeRow = (tag, color, e) => `
      <div class="log"><span style="color:${color};font-weight:bold">${tag}</span> <span class="mono">${esc(dl(e.f))}</span> —${esc(e.k)}→ <span class="mono">${esc(dl(e.t))}</span> ${confBadge(e.c)}${e.ev && e.ev[0] ? ` <span class="note">(${esc(e.ev[0].file || '?')}:${e.ev[0].ln || '?'} ${esc(e.ev[0].note || '')})</span>` : ''}</div>`;
    const intro = `
      <div class="card" style="max-width:900px"><h3>🔀 Version Diff — impact between two versions</h3>
        <p class="note" style="font-size:13px;line-height:1.6;color:var(--text2)">Compare two versions of the same system: dependency relations that appear, disappear or persist — the reviewer view for a change review. The comparison is <b>model-level</b> (nodes + relations, each with its file/line evidence) — not a text diff. Rename detection is not attempted: a renamed dataset appears as one removal plus one addition. Nothing is invented: every relation keeps the evidence from the side where it appears.</p></div>`;
    if (!d || (!d.a && !d.b))
      return `${intro}
        <div style="display:flex;gap:14px;flex-wrap:wrap">${sideCard('a','A — reference version')}${sideCard('b','B — new version')}</div>
        ${state.files.length ? '<div style="margin-top:12px"><button class="analyze-btn" style="width:auto" onclick="deltaUseLoaded()">⤵ Use the loaded analysis files as version A</button></div>' : ''}`;
    if (!d.res)
      return `${intro}
        <div style="display:flex;gap:14px;flex-wrap:wrap">${sideCard('a','A — reference version')}${sideCard('b','B — new version')}</div>
        <p class="note">Select files for both versions to compute the diff.</p>`;
    const r = d.res;
    const nodeList = (arr) => arr.length ? arr.map(n => `<span class="mono pill" style="border:1px solid var(--text3)">${esc(n.name)} <span class="note">(${esc(n.type)})</span></span>`).join(' ') : '<span class="note">none</span>';
    return `${intro}
      <div style="display:flex;gap:14px;flex-wrap:wrap">${sideCard('a','A — reference version')}${sideCard('b','B — new version')}</div>
      ${state.files.length ? '<div style="margin-top:12px"><button class="analyze-btn" style="width:auto" onclick="deltaUseLoaded()">⤵ Use the loaded analysis files as version A</button></div>' : ''}
      <div class="card" style="max-width:900px"><h3>Δ Impact diff — B vs A</h3>
        <p class="note">${r.edgesAdded.length} new relation(s) · ${r.edgesRemoved.length} removed relation(s) · ${r.nodesAdded.length} new entitie(s) · ${r.nodesRemoved.length} removed entitie(s). Warnings: ${r.warnCounts.a} in A, ${r.warnCounts.b} in B (see Summary per analysis). Two identical versions give a zero diff — if a file changed but no relation changed, it does not appear here.</p>
        <h3 style="color:var(--green)">+ New relations in B (${r.edgesAdded.length})</h3>
        ${r.edgesAdded.length ? r.edgesAdded.map(e => edgeRow('+', 'var(--green)', e)).join('') : '<p class="note">No new relation.</p>'}
        <h3 style="color:var(--red)">− Relations gone in B (${r.edgesRemoved.length})</h3>
        ${r.edgesRemoved.length ? r.edgesRemoved.map(e => edgeRow('−', 'var(--red)', e)).join('') : '<p class="note">No removed relation.</p>'}
        <h3>New entities (${r.nodesAdded.length})</h3><p>${nodeList(r.nodesAdded)}</p>
        <h3>Removed entities (${r.nodesRemoved.length})</h3><p>${nodeList(r.nodesRemoved)}</p>
      </div>`;
  },

  python: () => {
    if (!state.loaded) return emptyState('⚡','COBOL → Python Translation','Drop your COBOL files: the deterministic translator runs offline, entirely in your browser.');
    const progs = state.files.filter(f=>f.lang==='CBL' && f.parsed.cobol);
    if (!progs.length) return emptyState('⚡','No COBOL program found','Drop COBOL files to enable translation.');
    return progs.map(f=>{
      const T = translateCOBOL(f);
      if (!T || T.error) return `<div class="card" style="max-width:760px;margin-bottom:14px">
        <h3>⚡ ${esc(f.name)}</h3>
        <p class="note" style="color:var(--red)">Translation error — nothing invented: ${esc((T && T.error) || 'unknown')}</p>
      </div>`;
      const s = T.stats;
      const pct = Math.max(0, Math.min(100, s.coverage));
      const bar = `<div style="background:#2a2f3a;border-radius:6px;height:8px;max-width:460px;margin:8px 0"><div style="width:${pct}%;height:8px;border-radius:6px;background:linear-gradient(90deg,#4ade80,#fbbf24)"></div></div>`;
      const chips = `<span style="color:#4ade80">✅ translated ${s.translated}</span> · <span style="color:var(--yellow)">🟡 approximated ${s.approximated}</span> · <span style="color:var(--red)">⛔ not translated ${s.unsupported}</span>`;
      const mapRows = T.stmts.slice(0, 250).map(x=>`<tr><td class="mono">${x.ln}</td><td class="mono">${x.py||'—'}</td><td>${esc(x.k)}</td><td>${x.status==='translated'?'✅':x.status==='approximated'?'🟡':'⛔'} ${esc(x.note||'')}</td></tr>`).join('');
      const typeRows = T.types.map(t=>`<tr><td class="mono">${esc(t.name)}</td><td class="mono">${esc(t.pic)}</td><td class="mono">${esc(t.py)}</td><td>${esc(t.note||'')}</td></tr>`).join('');
      const fi = state.files.indexOf(f);
      const chk = pyStaticCheck(T.python);
      const chkHtml = chk.ok
        ? `<p class="note" style="color:#4ade80">✅ <b>Python check</b>: executable structure — unique definitions, resolved calls, <b>_run()</b> entry without recursion, assigned loop conditions. (Structural check: the browser does not run CPython — business semantics remain for review.)</p>`
        : `<p class="note" style="color:var(--red)">⛔ <b>Python check</b> — fix before running the .py:<br>${chk.issues.map(x => '• ' + esc(x)).join('<br>')}</p>`;
      return `<div class="card" style="max-width:760px;margin-bottom:14px">
        <h3>⚡ ${esc(T.programId || f.name)} — weighted coverage ${pct}%</h3>
        ${bar}
        ${chkHtml}
        <p class="note">${chips}<br>Weighted coverage = (translated×1 + approximated×0.6) / total. ${s.total} statement(s), ${T.paras.length} paragraph(s). Every approximation is commented in the code; untranslated statements are marked <b>[NOT TRANSLATED]</b> — nothing is invented.</p>
        ${(T.warns && T.warns.length) ? `<p class="note" style="color:var(--yellow)">⚠ ${T.warns.map(esc).join('<br>⚠ ')}</p>` : ''}
        <details><summary>📋 Translation report — line mapping COBOL → Python (status, notes)</summary>
          <div style="overflow:auto;max-height:320px"><table style="width:100%;border-collapse:collapse;font-size:12px">
          <tr style="text-align:left;color:var(--text2)"><th>COBOL ln</th><th>Python ln</th><th>verb</th><th>status</th></tr>${mapRows}</table></div>
        </details>
        <details><summary>🔤 Types — PIC → Python mapping (${T.types.length})</summary>
          <div style="overflow:auto;max-height:260px"><table style="width:100%;border-collapse:collapse;font-size:12px">
          <tr style="text-align:left;color:var(--text2)"><th>name</th><th>PIC</th><th>Python</th><th>note</th></tr>${typeRows}</table></div>
        </details>
        <div class="codeblock">${esc(T.python)}</div>
        <button class="analyze-btn" style="width:auto" onclick="downloadPython(${fi})">⬇ Download .py</button>
      </div>`;
    }).join('');
  },

  ai: () => {
    if (!state.loaded) return emptyState('✦','AI System Explanation','Run analysis first.');
    const m = getModel();
    const byT = t=>[...m.nodes.values()].filter(n=>n.type===t).length;
    return `<div class="card" style="max-width:700px">
      <h3>✦ AI System Explanation — two clearly separated engines</h3>
      <p class="note" style="font-size:13px;line-height:1.7;color:var(--text2)">
      <b style="color:#4ade80">1. Deterministic engine — LIVE.</b> The COBOL → Python translator (⚡ view) is rule-based:
      every statement gets a status (translated / approximated / unsupported), its source line and its Python line.
      It never guesses: unknown statements are marked <b>[NOT TRANSLATED]</b>.</p>
      <p class="note" style="font-size:13px;line-height:1.7;color:var(--text2)">
      <b style="color:var(--yellow)">2. AI engine — OPT-IN, grounded, never simulated.</b> When you configure an endpoint + key, the AI receives
      <b>only the deterministic extract</b> of the selected entity: facts, evidence lines (file + line + note), direct upstream/downstream with confidence,
      and the explicit unknowns list. The prompt forbids inventing anything outside this context and requires citing evidence. Every AI answer is
      labeled <b>« AI-PROPOSED »</b> and never merged with deterministic output. Without configuration, no call is made and no AI text is shown — honest offline mode.<br>
      Facts available for grounding: ${byT('job')} job(s), ${byT('prog')} program(s), ${byT('cpy')} copybook(s), ${byT('ds')} dataset(s), ${byT('tbl')} DB2 table(s), ${m.edges.length} relation(s).</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:12px">
        <input class="key-input" id="aiUrlInput" type="text" placeholder="https://api…/v1/chat/completions" style="min-width:280px" value="${esc(aiCfg().url)}" autocomplete="off">
        <input class="key-input" id="aiModelInput" type="text" placeholder="model name" style="min-width:140px" value="${esc(aiCfg().model)}" autocomplete="off">
        <button class="key-btn" onclick="aiSaveCfg()">Save endpoint</button>
        <button class="key-btn" onclick="aiRun()">✦ Explain selection (AI)</button>
      </div>
      <p class="note">OpenAI-compatible <span class="mono">chat/completions</span> endpoint. Key and URL stay in your browser (sessionStorage); the only data sent is the built context of the selected entity — never your full files, never the key in prompts or telemetry. ${aiReady() ? '<span style="color:var(--green)">✓ AI configured</span>' : '<span style="color:var(--yellow)">AI off — deterministic mode</span>'}</p>
      <div style="margin-top:10px">${keyStatusHTML()}</div>
      <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
        <h3>🤖 Ask the graph — offline, deterministic, no LLM</h3>
        <p class="note" style="font-size:13px;line-height:1.6;color:var(--text2)">Questions are matched against the analysis graph — entity names literally, every answer line derived from one real edge with its confidence and file:line evidence. Unknown or ambiguous entity, or unsupported question → explicit refusal, never a guess. Supported: who reads/writes a dataset · who calls/uses an entity · impact of modifying an entity · lineage · what changed between versions.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input class="key-input" id="aiQInput" type="text" placeholder="e.g. who writes to APP.OUT.FILE01 ?" style="min-width:320px" onkeydown="if(event.key==='Enter')aiAskRun()" autocomplete="off">
          <button class="key-btn" onclick="aiAskRun()">Ask</button>
        </div>
        <div id="aiQOut" style="margin-top:8px"></div>
      </div>
      <div id="aiOut"></div>
    </div>`;
  },

  source: () => {
    if (!state.loaded) return emptyState('📄','No source loaded','Select a file from the list to view its syntax-highlighted content.');
    if (state.srcIdx==null || !state.files[state.srcIdx]) state.srcIdx = 0;
    const f = state.files[state.srcIdx];
    return `
    <div class="toolbar">${state.files.map((x,i)=>`<span class="subtab ${i===state.srcIdx?'active':''}" onclick="state.srcIdx=${i};renderContent()">${esc(x.name)}</span>`).join('')}</div>
    <div class="codeblock">${hl(firstLines(f.text, 300))}</div>`;
  },

  copybooks: () => {
    if (!state.loaded) return emptyState('📋','No copybooks detected','Upload .CPY files alongside your COBOL programs.');
    const m = getModel();
    const cpyNodes = [...m.nodes.values()].filter(n=>n.type==='cpy');
    const unresolved = m.warnings.filter(w=>w.includes('not uploaded'));
    if (!cpyNodes.length && !unresolved.length) return emptyState('📋','No copybooks detected','Upload .CPY files alongside your COBOL programs.');
    let html = '';
    if (cpyNodes.length){
      html += `<div class="card" style="max-width:680px;margin-bottom:14px"><table class="tbl">
        <tr><th>Copybook</th><th>Used by</th><th>Evidence</th></tr>
        ${cpyNodes.map(c=>{
          const eds = m.rev[c.id]||[];
          return `<tr><td>${esc(c.name)}</td><td>${eds.map(e=>esc(nodeLabel(e.f))).join('<br>')||'—'}</td><td class="note">${eds.map(e=>esc(e.ev[0]?e.ev[0].file+' L'+e.ev[0].ln:'')).join('<br>')}</td></tr>`;
        }).join('')}
      </table></div>`;
    }
    if (unresolved.length){
      html += `<div class="card" style="max-width:680px"><h3>⚠ Unresolved copy references</h3>
      <div class="log">${unresolved.map(u=>`<span class="warn">[missing] ${esc(u)}</span>`).join('<br>')}</div>
      <p class="note">Upload the matching .CPY files to resolve these layouts and compute recompile impact. The affected programs are flagged, not silently ignored.</p></div>`;
    }
    return html;
  },

  debug: () => {
    const testArea = state._testResults ? `<div class="card" style="max-width:760px;margin-bottom:14px">
      <h3>Engine self-tests: ${state._testResults.filter(t=>t.pass).length}/${state._testResults.length} passed</h3>
      <div class="log">${state._testResults.map(t=>`<span class="${t.pass?'ok':'warn'}">${t.pass?'✓':'✗'} ${esc(t.name)}</span>`).join('<br>')}</div>
    </div>` : '';
    const v2Area = state._v2Results ? `<div class="card" style="max-width:760px;margin-bottom:14px">
      <h3>V2 suite (FD/01, SQL, JCL, CICS, dead code, REXX/SORT, JCL finesse, encodings, duplicates, translation, impact/lineage/IMS/SORT-GDG/XJOB/AI/SCHED/V3-REGRESSION, XSS): ${state._v2Results.filter(t=>t.pass).length}/${state._v2Results.length} passed</h3>
      <div class="log">${state._v2Results.map(t=>`<span class="${t.pass?'ok':'warn'}">${t.pass?'✓':'✗'} ${esc(t.name)}</span>`).join('<br>')}</div>
    </div>` : '';
    const logArea = state.loaded ? `<div class="card log" style="max-width:760px">
      ${state.log.map(l=>`<div><span class="${l.cls}">${esc(l.text)}</span></div>`).join('')}
    </div>` : emptyState('🔬','No analysis run yet','The parsing log (JCL + COBOL v3) and the engine self-tests will appear here.');
    return `
    <div class="toolbar">
      <button class="analyze-btn" style="width:auto" onclick="state._testResults=runSelfTests();renderContent()">⚙ Engine self-tests</button>
      <button class="analyze-btn" style="width:auto" onclick="state._v2Results=runV2Tests();renderContent()">⚙ V2 suite (FD/01, SQL, JCL, CICS, dead code, REXX/SORT, JCL finesse, encodings, duplicates, translation, impact/lineage/IMS/SORT-GDG/XJOB/AI/SCHED/V3-REGRESSION, XSS)</button>
      <button class="analyze-btn" style="width:auto" onclick="toggleTelemetry()">${telemetryOn() ? '📡 Telemetry ON (click to disable)' : '📡 Telemetry disabled'}</button>
    </div>
    ${testArea}
    ${v2Area}
    ${logArea}
    <div class="card" style="max-width:760px;margin-top:14px"><h3>Known limits (documented, not hidden)</h3><p class="note" style="line-height:1.8">
      • Dynamic SQL (PREPARE/EXECUTE): statement text unknown → no table extracted, explicit warning.<br>
      • Identifiers in double (never silently merged): same PROGRAM-ID in several COBOL files → distinct nodes (X, X#2), EXEC/CALL edges point to the first definition + warning; duplicate step names in a job → distinct nodes (S1, S1#2), backrefs by step name resolve to the first + warning; duplicate PROC (same file or across files) → later definition wins + warning.<br>
      • In-stream data (DD \*/DD DATA): DD \* ends at // or /\*; DD DATA ends at /\* only (// lines are data); DLM='xx' coded → only the delimiter ends the data, // and /\* are data.<br>
      • COBOL formats: fixed/free detected per file, >>SOURCE FORMAT switch supported mid-file, isolated numbered lines in free files handled; compiler directives (EJECT, SKIP1-3, TITLE, CBL/\*CBL, >>) ignored; stacked/nested programs (second PROGRAM-ID): analysis stops at the first program + warning — nothing attributed to the wrong program.<br>
      • Data items: levels 01-49, 66 (RENAMES), 77, 78, 88 captured; OCCURS n / m TO n / DEPENDING ON captured; USAGE (COMP-3, BINARY…) recorded. m TO n without DEPENDING ON: bounds kept, size flagged unknown.<br>
      • SQL: CTE (with column lists, recursive) excluded from tables; aliases never captured; qualified quoted identifiers ("SCH"."MY TABLE") supported; MERGE USING, TRUNCATE TABLE, DELETE FROM supported.<br>
      • Cataloged PROCs / INCLUDE members: resolved only if uploaded in the project.<br>
      • PROC DD overrides (« //STEPNAME.DDNAME DD … » placed after an EXEC PROC): applied to the matching DD inside the PROC (in-stream and cataloged) — the EFFECTIVE dataset is the one shown in lineage, the override is named in the edge evidence and in the step description, and DD DUMMY overrides remove the dataset. Nested overrides (OUTER.STEP.DD) are re-applied when the inner PROC expands. Concatenated override cards: EACH card contributes its own dataset (order preserved, member names suffixed #2, #3… — nothing dropped); when the PROC itself concatenates the same DD, the override applies to the first member only and the others are unchanged (flagged). An override that matches no step, no DD, or lacks the stepname.ddname qualifier produces an explicit warning — never a silent drop.<br>
      • Literal continuation: resumed at the apostrophe; column 16-71 spaces of the first line are not re-padded.<br>
      • EXEC CICS: FILE/DATASET (FCT), MAP, QUEUE (TSQ/TDQ), XCTL/LINK handled. FILE(variable) resolved only when the constant is traced in the code (MOVE 'X' TO var / level-88) → probable; unknown value → no edge. HANDLE CONDITION/AID paragraph targets and HANDLE ABEND PROGRAM handled. IGNORE CONDITION not analyzed. IMS DL/I (CALL 'CBLTDLI'/'ASMTDLI'): calls detected and displayed, op-code traced when it comes from a literal or a traced MOVE, PCB/SSA segment names are built at runtime — unknown offline, explicit warning, no relation invented.<br>
      • REXX: exec detected (.REX/.EXEC or /* REXX */), CALL 'literal' → program edge, datasets quoted → "references" edge with unknown access type (never claimed read/write). CALL via variable → warning, no invented edge. IKJEFT01: EXEC 'member' of SYSTSIN expanded only if the exec is uploaded. ADDRESS/host commands not analyzed.<br>
      • SORT (DFSORT): SYSIN inline cards decoded — FIELDS=(p,l,type,order) or COPY (SORT FIELDS=COPY or OPTION COPY), FORMAT=, SUM, INCLUDE/OMIT COND (simple forms, short form with FORMAT=, field-to-field compare, AND/OR joins, quoted literals with commas — recursive decode; any unknown sub-condition keeps the whole card raw, flagged not decoded), INREC/OUTREC BUILD/OVERLAY/FIELDS (simple items only), OUTFIL FNAMES/OUTDD (named DDs become known outputs of the step). Other OPTION parameters, RECORD, MODS, IFTHEN/FINDREP not decoded. SYSIN from a dataset not uploaded → sort fields unknown (warning). ICEGENER not analyzed.<br>
      • GDG: relative generations (+1/0/−1) kept in DD evidence ('GDG +1' etc.); the base shares one node — after a same-job write (+1), a read (0) flows from the newly created generation, while an older read (−1 or less) is flagged by an explicit warning. The absolute generation number is unknown offline (catalog) — never guessed.<br>
      • Cross-job: job→job « feed » edges are inferred ONLY from shared non-temporary datasets (write→read direction from DD usage). Real execution order across jobs is unknown offline (scheduler not analyzed): every feed edge is PROBABLE, and a reader of an older GDG generation is flagged explicitly. Unknown-usage DDs produce no inference. <b>Scheduler import</b>: drop a scheduler export (.sch/.sched, one declaration per line: <span class="mono">JOB B AFTER A,C</span>, # or * = comment) — declared orders are CERTAIN (evidence merged into dataset-inferred feeds), pairs without shared dataset get an order-only edge, declared-but-not-uploaded jobs and cycles are flagged, jobs without a scheduler line keep their PROBABLE/unknown status explicitly. Other scheduler formats (TWS current plan, Control-M XML, CA-7) are not parsed.<br>
      • AI engine (opt-in): no call without your endpoint + key (stored locally in sessionStorage). The model receives only the deterministic context of the selected entity (facts, evidence, confidence, unknowns) — never your full files; the key never appears in prompts or telemetry. All AI output is labeled « AI-PROPOSED » and is a proposal, not ground truth. Unconfigured → honest offline deterministic mode.<br>
      • JCL IF/ELSE and EXEC COND=: captured and displayed with their condition. <b>Upload an execution job log</b> (SDSF/SAR export: extension .log/.sdsf/.sar, or content with IEF142I/IEF450I/$HASP patterns) and real return codes are attached to each step — COND=(code,OP[,step]) and IF (RC op n) are then <b>evaluated against that run</b> (bypassed/executed, with the RC used), an abend or a flushed step is flagged explicitly. Without a log, the condition is NEVER evaluated (return codes unknown offline) — conditional steps are flagged, not skipped or simulated. Exception: COND=EVEN (runs even after a previous abend — relations reliable) and COND=ONLY (runs only after a preceding abend — exceptional path) have fixed JCL semantics and are classified explicitly. RD/RERUN (restart): captured and flagged as informational; a restarted step may run twice, so run counts are never claimed.<br>
      • Version Diff (Analyze → Version Diff): model-level comparison between two versions — relations added/removed, entities added/removed, each with its evidence. NOT a text diff: a file whose content changed without changing any relation does not appear. No rename detection (renamed = removed + added). Identical versions give a zero diff.<br>
      • Warnings are sorted by severity: blocking (member/program missing, never called) first, then uncertainties (unknown value, dead code), then informational (restart, conditions). Stable within each level.<br>
      • Encodings: UTF-8 (with or without BOM), UTF-16 (BOM) and EBCDIC CP037 (printable subset) auto-detected at upload; unmapped EBCDIC bytes appear as ? (counted in the log). Other code pages (CP1140 accented, DBCS) are not converted — flagged, never guessed.<br>
      • Control report (HTML export): standalone audit document built from the live model — inventory, findings by severity, relation confidence, coverage and limits. Nothing filtered, everything escaped.<br>
      • PERFORM/GOTO to an undefined target: flagged as warning, no edge created.<br>
      • Dead code: paragraphs declared unreachable only when certain (no PERFORM/GO TO target, no fall-through path). DECLARATIVES/USE and ALTER disable the analysis (implicit/dynamic targets). Programs never called are flagged as questions, not facts (code not uploaded may call them).<br>
      • COBOL → Python translation (deterministic engine, ⚡ view): every statement carries a status — translated / approximated / unsupported — with its COBOL line and its Python line in the report. Approximations documented in code comments: GO TO → tail call (return f()), PERFORM UNTIL tests before each iteration (TEST AFTER not distinguished), PERFORM THRU calls paragraphs in order, float approximation for PIC V (round() used for ROUNDED with known decimals — validate monetary amounts), the entry point _run() is generated from the REAL control flow (first paragraph, fall-through between paragraphs, GO TO jumps, STOP RUN/GOBACK ends — paragraphs not on that path are NOT called: dead-code candidates; uncertain flow — conditional GO TO, DECLARATIVES, ALTER, backward jump — truncates the generated entry with an explicit warning) — paragraph functions are collision-checked (a paragraph MAIN never collides with the entry or a variable; renamed para_* when needed), variables used but not declared in COBOL are declared in Python with an explicit ⚠ comment (assumption visible, to verify), and pyStaticCheck flags structural execution hazards before you run the .py (duplicate defs, undefined call, never-assigned loop condition → infinite loop). File I/O and EXEC SQL/CICS are NOT translated: emitted as [NOT TRANSLATED] comments, nothing invented. GO TO/PERFORM to a dynamic target → not translated. Weighted coverage = (translated×1 + approximated×0.6)/total.<br>
      • Lineage: per dataset, upstream sources (real in-edges with evidence) and a derived downstream section (each step that READS it, and the datasets that step writes — one hop, nothing invented). SORT steps show their decoded inline SYSIN cards (fields, SUM) as a transformation pill; SYSIN cards from a non-uploaded dataset stay unknown.<br>
      • Impact: shortest path per impacted node, and when several distinct shortest paths exist they are ALL displayed (up to 3 per node — none hidden); confidence = weakest link along each path.<br>
      • AI: not connected, never simulated — a future optional engine would be validated by the deterministic engine and labeled « AI-proposed » (see AI view).<br>
      • Telemetry (Google Analytics): ON by default — usage events only (view names, buttons used): never source code, never file names, never analysis results. The events are sent to Google and may be associated with your browser or device identifiers (this is standard Analytics behavior, not a guarantee of anonymity). Disable anytime via the Debug button; choice persisted locally.</p></div>`;
  },
};

function renderContent(){
  const c = document.getElementById('content');
  c.innerHTML = PANELS[state.sub] ? PANELS[state.sub]() : emptyState('…','Coming soon','');
}

// ══════════════════ 7. NAVIGATION ══════════════════
