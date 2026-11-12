// Every analysis build records a snapshot (nodes, relations, per-file content
// hashes). The History panel diffs any two snapshots — the reviewer sees what
// a change touched, with the same evidence rules as the rest of the tool.
// Honest limits: rename detection is NOT attempted (a renamed dataset shows as
// one removal + one addition); snapshots are content-derived, nothing invented.
const HISTORY_CAP = 20; // oldest snapshots dropped; export the project to keep more
function strHash(s){ let h = 5381; for (let i = 0; i < s.length; i++){ h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return String(h); }
function graphSnapshot(label){
  const m = getModel();
  const nodes = {};
  m.nodes.forEach(n => { nodes[n.id] = { type: n.type, name: n.name }; });
  const edges = {};
  m.edges.forEach(e => { edges[e.f + '|' + e.t + '|' + e.k] = e.c; });
  const fileHashes = {};
  state.files.forEach(f => { fileHashes[f.name] = strHash(f.text || ''); });
  return { label: label || '', ts: Date.now(),
    counts: { nodes: m.nodes.size, edges: m.edges.length, warnings: (m.warnings || []).length },
    nodes, edges, fileHashes };
}
function graphDiff(a, b){
  const nodesAdded = [], nodesRemoved = [], edgesAdded = [], edgesRemoved = [], edgesChanged = [];
  Object.keys(b.nodes).forEach(id => { if (!a.nodes[id]) nodesAdded.push({ id, name: b.nodes[id].name, type: b.nodes[id].type }); });
  Object.keys(a.nodes).forEach(id => { if (!b.nodes[id]) nodesRemoved.push({ id, name: a.nodes[id].name, type: a.nodes[id].type }); });
  Object.keys(b.edges).forEach(k => {
    if (!a.edges[k]) edgesAdded.push(k);
    else if (a.edges[k] !== b.edges[k]) edgesChanged.push({ k, from: a.edges[k], to: b.edges[k] });
  });
  Object.keys(a.edges).forEach(k => { if (!b.edges[k]) edgesRemoved.push(k); });
  const filesChanged = Object.keys(b.fileHashes).filter(f => f in a.fileHashes && a.fileHashes[f] !== b.fileHashes[f]);
  const filesAdded = Object.keys(b.fileHashes).filter(f => !(f in a.fileHashes));
  const filesRemoved = Object.keys(a.fileHashes).filter(f => !(f in b.fileHashes));
  return { nodesAdded, nodesRemoved, edgesAdded, edgesRemoved, edgesChanged, filesChanged, filesAdded, filesRemoved };
}
function autoSnapshot(){
  const snap = graphSnapshot();
  const last = state.history[state.history.length - 1];
  if (last && JSON.stringify(last.fileHashes) === JSON.stringify(snap.fileHashes)
           && last.counts.nodes === snap.counts.nodes && last.counts.edges === snap.counts.edges) return last;
  snap.label = 'v' + (state.history.length + 1);
  state.history.push(snap);
  if (state.history.length > HISTORY_CAP) state.history.shift();
  return snap;
}
function takeSnapshot(label){
  const snap = graphSnapshot(label || 'manual');
  snap.label = label || ('v' + (state.history.length + 1) + ' (manual)');
  state.history.push(snap);
  if (state.history.length > HISTORY_CAP) state.history.shift();
  return snap;
}
function clearHistory(){ state.history = []; state.histA = null; state.histB = null; }

// UI helpers (graph)
function nodeLabel(id){ const n = getModel().nodes.get(id); return n ? n.name : id; }
function confBadge(c){
  const map = { certain:['var(--green)','certain'], probable:['var(--yellow)','probable'], unknown:['var(--text3)','unclear'] };
  const x = map[c] || map.unknown;
  return `<span class="pill" style="color:${x[0]};border:1px solid ${x[0]}">${x[1]}</span>`;
}
function opBadge(op){
  const map = { read:['var(--cyan)','READ'], write:['var(--green)','WRITE'], update:['var(--purple)','UPDATE'], delete:['var(--red)','DELETE'], unknown:['var(--text3)','UNKNOWN'] };
  const x = map[op] || map.unknown;
  return `<span class="pill" style="color:${x[0]};border:1px solid ${x[0]}">${x[1]}</span>`;
}
function evHTML(ev){
  if (!ev || !ev.length) return '';
  return `<div class="note" style="margin-top:4px;color:var(--text3)">${ev.map(e=>esc(e.file + ' L' + (e.ln||'?') + ': ' + e.note)).join(' · ')}</div>`;
}
const EDGE_VERB = { exec:'executes', contains:'contains step', read:'reads', write:'writes', update:'updates', unknown:'usage unclear', uses:'uses copybook', call:'calls', 'sql-read':'SELECTs', 'sql-write':'INSERTs/DELETEs', 'sql-update':'UPDATEs', perform:'PERFORMs', goto:'branches to (GO TO)', delete:'deletes records in' };
function impNodeId(i){ const ns = [...getModel().nodes.values()].filter(n => n.type !== 'step'); return ns[+i] ? ns[+i].id : null; }

// ══════════════════ SELF-TESTS (built-in test suite) ══════════════════
