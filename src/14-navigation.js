
function renderNav(){
  const g = NAV.find(n=>n.id===state.group);
  document.getElementById('groups').innerHTML = NAV.map(n =>
    `<div class="group ${n.id===state.group?'active':''}" onclick="switchGroup('${n.id}')"><span class="g-icon">${n.icon}</span>${n.label}</div>`
  ).join('');
  document.getElementById('subtabs').innerHTML = g.subs.map(s =>
    `<div class="subtab ${s.id===state.sub?'active':''} ${s.hot?'hot':''}" onclick="switchSub('${s.id}')">${s.label}</div>`
  ).join('');
}
function switchGroup(id){
  state.group = id;
  state.sub = NAV.find(n=>n.id===id).subs[0].id;
  renderNav(); renderContent();
}
function switchSub(id){ state.sub = id; track('view_' + id); renderNav(); renderContent(); } // static view name only — no project content projected into telemetry

// ══════════════════ 8. PANNEAU GAUCHE ══════════════════

function fIcon(lang){ return lang==='JCL' ? '📄' : lang==='CPY' ? '📋' : lang==='CBL' ? '🖥' : lang==='REXX' ? '🦖' : '❓'; }

function renderLeft(){
  document.getElementById('fileList').innerHTML = state.files.map((f,i)=>`
    <div class="file">
      <span class="ficon">${fIcon(f.lang)}</span>
      <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="lang lang-${f.lang.toLowerCase()}">${f.lang}</span>
      <button class="rm" title="Remove this file" onclick="removeFile(${i})">×</button>
    </div>`).join('');
  document.getElementById('clearAll').style.display = state.files.length ? 'block' : 'none';
  document.getElementById('exportBtn').style.display = state.files.length ? 'block' : 'none';
  const g = buildGraph();
  document.getElementById('stats').innerHTML = state.files.length ?
    `<div class="stat"><b>${state.files.length}</b><span>Files</span></div>
     <div class="stat"><b>${g.jobs.length}</b><span>JCL jobs</span></div>
     <div class="stat"><b>${g.programs.length}</b><span>Programs</span></div>
     <div class="stat"><b>${g.datasets.length}</b><span>Datasets</span></div>` : '';
  document.getElementById('analyzeBtn').disabled = !state.files.length;
}

// ══════════════════ 9. SAMPLE SYSTEM ══════════════════
