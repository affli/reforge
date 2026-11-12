
const dz = document.getElementById('dz');
const fi = document.getElementById('fileInput');
dz.addEventListener('click', e => { if (e.target.tagName !== 'INPUT') fi.click(); });
fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });
['dragenter','dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.add('hover'); }));
['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dz.classList.remove('hover'); }));
dz.addEventListener('drop', e => { handleFiles(e.dataTransfer.files); });
document.getElementById('sampleBtn').onclick = loadSample;
document.getElementById('analyzeBtn').onclick = analyze;
document.getElementById('exportBtn').onclick = exportProject;
document.getElementById('themeBtn').onclick = () => {
  document.body.classList.toggle('light');
  const light = document.body.classList.contains('light');
  document.getElementById('themeBtn').textContent = light ? '🌙' : '☀';
  try { localStorage.setItem('reforge_theme', light ? 'light' : 'dark'); } catch(e){}
};

// Persisted theme
try {
  if (localStorage.getItem('reforge_theme') === 'light'){
    document.body.classList.add('light');
    document.getElementById('themeBtn').textContent = '🌙';
  }
} catch(e){}

renderLeft(); renderNav(); renderContent();

// ── Automatic self-tests via ?selftest (CI / quick check) ──
if (location.search.indexOf('selftest') >= 0){
  state._testResults = runSelfTests();
  state._v2Results = runV2Tests();
  state.group = 'tech'; state.sub = 'debug';
  renderNav(); renderContent();
}

// ── Session restore (IndexedDB) — "Welcome back" ──
(async () => {
  const saved = await loadSession();
  if (saved && saved.v === SESSION_VER && Array.isArray(saved.files) && saved.files.length){
    state.files = saved.files;
    state.log = saved.log || [];
    state.history = Array.isArray(saved.history) ? saved.history : [];
    state.loaded = !!saved.loaded;
    state.entity = null; state.srcFile = null; state.pySel = null;
    if (state.loaded){
      document.getElementById('statusText').textContent = `Welcome back — ${state.files.length} file(s) restored`;
      track('restore_session');
    } else {
      document.getElementById('statusText').textContent = `${state.files.length} file(s) restored — click Analyze`;
    }
    renderLeft(); renderNav(); renderContent();
  }
})();
</script>
