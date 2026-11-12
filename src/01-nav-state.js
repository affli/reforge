    <section class="content" id="content"></section>
  </main>
</div>

<script>
// ═══════════════════════════════════════════════════════════
//  WORKING PROTOTYPE: real drop + detection + parsing
//  (embedded mini-analyzer to demonstrate the UX)
// ═══════════════════════════════════════════════════════════

// ── Navigation: 4 groups instead of 13 flat tabs ──
const NAV = [
  { id:'explore',   icon:'🗺', label:'Explore',   subs:[ {id:'map',label:'System Map'}, {id:'flow',label:'Flow'}, {id:'programs',label:'Programs'}, {id:'data',label:'Data'} ] },
  { id:'analyze',   icon:'🔬', label:'Analyze',  subs:[ {id:'impact',label:'Impact'}, {id:'lineage',label:'Data Lineage'}, {id:'db2',label:'DB2 / SQL'}, {id:'summary',label:'Summary'}, {id:'delta',label:'Version Diff'}, {id:'history',label:'History'} ] },
  { id:'modernize', icon:'⚡', label:'Modernize', subs:[ {id:'python',label:'COBOL → Python',hot:true}, {id:'ai',label:'AI Explain',hot:true} ] },
  { id:'tech',      icon:'🛠', label:'Tech',      subs:[ {id:'source',label:'Source'}, {id:'copybooks',label:'Copybooks'}, {id:'debug',label:'Debug'} ] },
];

const state = { files:[], loaded:false, log:[], group:'explore', sub:'map', entity:null, srcFile:null, pySel:null, srcIdx:null, _model:null, _testResults:null, delta:null, history:[], histA:null, histB:null };

// ══════════════════ 1. DETECTION & PARSING (real) ══════════════════
