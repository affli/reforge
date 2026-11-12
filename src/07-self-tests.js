function runSelfTests(){
  const out = [];
  const T = (name, cond) => out.push({ name, pass: !!cond });
  try {
    const PAYREC = ['01  PAY-RECORD.','    05  ACC-ID      PIC 9(8).','    COPY INNER.'].join('\n');
    const INNER  = '05  INNER-FLD PIC X(4).';
    const reg = { PAYREC:{text:PAYREC,file:'PAYREC.CPY'}, INNER:{text:INNER,file:'INNER.CPY'} };
    const F1 = ['000100 IDENTIFICATION DIVISION.','000200 PROGRAM-ID. CBPAY100.','000300 ENVIRONMENT DIVISION.','000400 INPUT-OUTPUT SECTION.','000500 FILE-CONTROL.','000600     SELECT TRANS-FILE ASSIGN TO TRANS.','000700 DATA DIVISION.','000800 FILE SECTION.','000900 FD  TRANS-FILE.','001000 01  TRANS-RECORD.','001100     COPY PAYREC.','001200 WORKING-STORAGE SECTION.','001300 01  WS-HOURS      PIC 9(4)V99.','001400 01  WS-PGM        PIC X(8).','001700 PROCEDURE DIVISION.','001800 MAIN-PARA.','001900     PERFORM INIT-PARA.','002000     MOVE \'SUBPGM\' TO WS-PGM.','002100     CALL WS-PGM.','002200     CALL \'CBPAY200\'.','002300     GO TO END-PARA.','002400 INIT-PARA.','002500     OPEN INPUT TRANS-FILE.','002600     READ TRANS-FILE.','002900 END-PARA.','003000     EXEC SQL','003100         SELECT ACC_ID FROM PAYROLL.ACCOUNTS A, PAYROLL.HIST','003200     END-EXEC','003400     EXEC SQL INSERT INTO PAYHIST VALUES (:X) END-EXEC'].join('\n');
    const C1 = parseCOBOL('CBPAY100.CBL', F1, reg);
    T('COBOL: fixed format detected', C1.fixed === true);
    T('COBOL: PROGRAM-ID', C1.programId === 'CBPAY100');
    T('COBOL: SELECT ASSIGN', C1.selects.length === 1 && C1.selects[0].dd === 'TRANS');
    T('COBOL: PIC clause', (C1.vars.find(v=>v.name==='WS-HOURS')||{}).pic === '9(4)V99');
    T('COBOL: COPY spliced into vars', !!C1.vars.find(v=>v.name==='ACC-ID'));
    T('COBOL: nested COPY resolved', !!C1.vars.find(v=>v.name==='INNER-FLD'));
    T('COBOL: PERFORM target', ((C1.performs.find(p=>p.to==='INIT-PARA')||{}).from) === 'MAIN-PARA');
    T('COBOL: dynamic CALL resolved from MOVE', (C1.calls.find(c=>c.viaVar==='WS-PGM')||{}).target === 'SUBPGM');
    T('COBOL: I/O verb on file', (C1.fileOps['TRANS-FILE']||[]).some(o=>o.op==='read'));
    const reads = C1.sql.filter(x=>x.op==='read').flatMap(x=>x.tables);
    T('SQL: FROM tables + alias list', reads.includes('PAYROLL.ACCOUNTS') && reads.includes('PAYROLL.HIST'));
    T('SQL: INSERT INTO table', C1.sql.filter(x=>x.op==='write').flatMap(x=>x.tables).includes('PAYHIST'));
    const F2 = ['IDENTIFICATION DIVISION.','PROGRAM-ID. FREEPGM.','WORKING-STORAGE SECTION.','COPY PAYREC REPLACING ==PAY-== BY ==FR-==.','COPY MISSING1.','PROCEDURE DIVISION.'].join('\n');
    const C2 = parseCOBOL('F2.CBL', F2, reg);
    T('COBOL: REPLACING applied', !!C2.vars.find(v=>v.name==='FR-RECORD'));
    T('COBOL: missing copybook warned, not invented', C2.warns.some(w=>w.includes('MISSING1')));
    const JCLT = ['//PAYRUN0  JOB  (ACCT),\'PAY\',CLASS=A','//STEP010  EXEC PGM=SORT','//SORTIN   DD DSN=PAYROLL.TRANS,DISP=SHR','//SORTOUT  DD DSN=&&SORTED,DISP=(,PASS)','//STEP020  EXEC PGM=CBPAY100','//TRANS    DD DSN=*.STEP010.SORTOUT,DISP=OLD','//OUTDS    DD DSN=PAYROLL.MASTER(+1),DISP=(,CATLG)','//STEP030  EXEC PGM=CBPAY200','//PAYMAST  DD DSN=PAYROLL.MASTER,DISP=OLD','//NODISP   DD DSN=NODISP.DATA'].join('\n');
    const mfiles = [
      { name:'PAYRUN0.JCL', lang:'JCL', text:JCLT },
      { name:'CBPAY100.CBL', lang:'CBL', text:F1 },
      { name:'PAYREC.CPY', lang:'CPY', text:PAYREC },
    ];
    mfiles.forEach(f => {
      if (f.lang === 'JCL'){
        const res = parseJCL(f.text);
        if (!res.jobs.length && !Object.keys(res.procs).length) res.jobs.push({ name: base(f.name), steps: [], procsUsed: [], params: {} });
        f.parsed = { jobs: res.jobs, procs: res.procs, warnings: res.warnings };
      } else {
        const C = parseCOBOL(f.name, f.text, reg);
        f.parsed = { cobol: C, warnings: C.warns, programId: C.programId,
          copies: C.copyUsed.map(c=>({name:c.name, resolved:!!c.resolved})),
          sqlCount: C.sql.length, performs: C.performs.length, gotos: C.gotos.length };
      }
    });
    const M = buildModel(mfiles);
    const E = M.edges;
    const has = (f,t,k) => E.some(e => e.f===f && e.t===t && e.k===k);
    T('GRAPH: exec step→prog', has('step|PAYRUN0.STEP020','prog|CBPAY100','exec'));
    T('GRAPH: SELECT+READ → certain read (backref)', (E.find(e=>e.f==='step|PAYRUN0.STEP020'&&e.t==='ds|&&SORTED'&&e.k==='read')||{}).c === 'certain');
    T('GRAPH: DISP-only → probable input', (E.find(e=>e.f==='step|PAYRUN0.STEP010'&&e.t==='ds|PAYROLL.TRANS'&&e.k==='read')||{}).c === 'probable');
    T('GRAPH: no DISP → unknown, flagged not guessed', has('step|PAYRUN0.STEP030','ds|NODISP.DATA','unknown'));
    T('GRAPH: program uses copybook', has('prog|CBPAY100','cpy|PAYREC','uses'));
    T('GRAPH: SQL table edge', has('prog|CBPAY100','tbl|PAYROLL.ACCOUNTS','sql-read'));
    const imp = impact(M, 'cpy|PAYREC');
    T('IMPACT: copybook → program direct', imp.up.direct.length === 1 && imp.up.direct[0].id === 'prog|CBPAY100');
    const jobHit = imp.up.indirect.find(x => x.id === 'job|PAYRUN0');
    T('IMPACT: copybook → job indirect via full path', !!jobHit && jobHit.path.length === 4);
    const imp2 = impact(M, 'prog|CBPAY100');
    T('IMPACT: program upstream direct = executing step', imp2.up.direct.some(x => x.id === 'step|PAYRUN0.STEP020'));
    T('GRAPH: no duplicate edges (conf dedup + evidence merge)', !E.some((e,i)=>E.slice(i+1).some(x=>x.f===e.f&&x.t===e.t&&x.k===e.k)));
  } catch (err){
    out.push({ name: 'self-test crashed: ' + err.message, pass: false });
  }
  return out;
}

// ══════════════════ SELF-TESTS V2 (independent suite: FD/01, continuations, SQL, JCL, XSS) ══════════════════
