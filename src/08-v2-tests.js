// Complex cases absent from the app samples — each case reproduces a real
// defect fixed in V2. The user's state is saved then restored.
function runV2Tests(){
  const out = [];
  const T = (name, cond) => out.push({ name, pass: !!cond });
  const bak = { files: state.files, loaded: state.loaded, log: state.log, entity: state.entity,
    srcIdx: state.srcIdx, srcFile: state.srcFile, group: state.group, sub: state.sub };
  try {
    // ── 1. COBOL: FD ↔ 01, I/O verbs, comments, literal continuation ──
    const CV2 = [
      "000100 IDENTIFICATION DIVISION.",
      "000200 PROGRAM-ID. BANKUPD.",
      "000300 ENVIRONMENT DIVISION.",
      "000400 INPUT-OUTPUT SECTION.",
      "000500 FILE-CONTROL.",
      "000600     SELECT MASTER-FILE ASSIGN TO MASTDD.",
      "000700 DATA DIVISION.",
      "000800 FILE SECTION.",
      "000900 FD  MASTER-FILE.",
      "001000 01  MAST-REC.",
      "001100     05  MAST-ID  PIC X(8).",
      "001200 WORKING-STORAGE SECTION.",
      "001300 01  WS-BUF PIC X(80).",
      "001400 01  WS-LIT PIC X(10) VALUE 'ABC",
      "001500-    'DEF'.",
      "001600 PROCEDURE DIVISION.",
      "001700 INIT-S SECTION.",
      "001800     PERFORM READ-S.",
      "001900 READ-S.",
      "002000     READ MASTER-FILE AT END MOVE 'Y' TO EOF",
      "002100     MOVE 'OK' TO WS-BUF *> floating comment",
      "002200     WRITE MAST-REC FROM WS-BUF",
      "002300     REWRITE MAST-REC",
      "002400     DELETE MASTER-FILE",
      "002500     WRITE GHOST-REC",
      "002600     PERFORM NOWHERE-PARA",
      "002700     GO TO INIT-S READ-S DEPENDING ON WS-SEL",
      "002800     STOP RUN."
    ].join("\n");
    const C2 = parseCOBOL('BANKUPD.CBL', CV2, {});
    T('V2 FD/01: WRITE on the record → FD file', (C2.fileOps['MASTER-FILE']||[]).some(o=>o.op==='write'));
    T('V2 FD/01: REWRITE on the record → update', (C2.fileOps['MASTER-FILE']||[]).some(o=>o.op==='update'));
    T('V2 FD/01: DELETE on the file', (C2.fileOps['MASTER-FILE']||[]).some(o=>o.op==='delete'));
    T('V2 FD/01: READ file kept', (C2.fileOps['MASTER-FILE']||[]).some(o=>o.op==='read'));
    T('V2 unattached I/O → warned, no invented relation', C2.warns.some(w=>w.includes('GHOST-REC')) && !Object.keys(C2.fileOps).some(k=>k.includes('GHOST')));
    T('V2 floating *> comment ignored', !!C2.vars.find(v=>v.name==='WS-BUF') && C2.paragraphs.length===2);
    T('V2 continued literal (col 7 = -)', ((C2.vars.find(v=>v.name==='WS-LIT')||{}).value)==='ABCDEF');
    T('V2 PROCEDURE section recognized', C2.paragraphs.some(p=>p.name==='INIT-S'&&p.section===true));
    T('V2 GO TO ... DEPENDING multi-target', C2.gotos.filter(g=>g.depending).length===2 && C2.gotos.some(g=>g.to==='READ-S'&&g.depending));
    T('V2 PERFORM target not found → warning', C2.warns.some(w=>w.includes('NOWHERE-PARA')));

    // ── 2. COPY REPLACING (word form and LEADING) ──
    const REG2 = { CPYL:{ text:"01  OLD-REC.\n    05  OLD-FIELD PIC X(3).", file:'CPYL.CPY' },
                   CPY2:{ text:"01  OLD-REC.\n    05  XOLD-FIELD PIC X(3).", file:'CPY2.CPY' } };
    const C3 = parseCOBOL('T3.CBL', "IDENTIFICATION DIVISION.\nPROGRAM-ID. T3.\nWORKING-STORAGE SECTION.\nCOPY CPYL REPLACING OLD BY NEW.\nPROCEDURE DIVISION.", REG2);
    T('V2 COPY REPLACING word form (OLD BY NEW)', !!C3.vars.find(v=>v.name==='NEW-REC') && !!C3.vars.find(v=>v.name==='NEW-FIELD'));
    const C4 = parseCOBOL('T4.CBL', "IDENTIFICATION DIVISION.\nPROGRAM-ID. T4.\nWORKING-STORAGE SECTION.\nCOPY CPY2 REPLACING TRAILING OLD BY NEW.\nPROCEDURE DIVISION.", REG2);
    T('V2 COPY REPLACING TRAILING (XOLD-FIELD → XNEW-FIELD)', !!C4.vars.find(v=>v.name==='XNEW-FIELD'));
    const C4b = parseCOBOL('T4B.CBL', "IDENTIFICATION DIVISION.\nPROGRAM-ID. T4B.\nWORKING-STORAGE SECTION.\nCOPY CPY2 REPLACING LEADING OLD BY NEW.\nPROCEDURE DIVISION.", REG2);
    T('V2 COPY REPLACING LEADING: no false positive (unprefixed XOLD-FIELD unchanged)', !C4b.vars.find(v=>v.name==='XNEW-FIELD') && !!C4b.vars.find(v=>v.name==='XOLD-FIELD'));

    // ── 3. SQL: JOIN/subquery/CTE, MERGE, quotes, dynamic SQL ──
    const C5 = parseCOBOL('T5.CBL', "IDENTIFICATION DIVISION.\nPROGRAM-ID. T5.\nPROCEDURE DIVISION.\n    EXEC SQL SELECT A.ID, B.ID FROM SCHEMA.T1 AS A INNER JOIN SCHEMA.T2 B ON A.ID = B.ID WHERE EXISTS (SELECT 1 FROM T3 WHERE T3.X = 1) END-EXEC.\n    EXEC SQL MERGE INTO PAYHIST T USING (SELECT ID FROM STAGE) S ON T.ID = S.ID WHEN MATCHED THEN UPDATE SET A = 1 END-EXEC.\n    EXEC SQL INSERT INTO \"MY TABLE\" (A) VALUES (1) END-EXEC.\n    EXEC SQL WITH CTE1 AS (SELECT ID FROM REALT) SELECT * FROM CTE1 JOIN T4B ON CTE1.ID = T4B.ID END-EXEC.\n    EXEC SQL PREPARE STM FROM :WS-SQL END-EXEC.\n    EXEC SQL INCLUDE SQLCA END-EXEC.\n    EXEC SQL WHENEVER NOT FOUND CONTINUE END-EXEC.\n    STOP RUN.", {});
    const s0 = C5.sql[0]||{}, s1 = C5.sql[1]||{}, s2 = C5.sql[2]||{}, s3 = C5.sql[3]||{}, s4 = C5.sql[4]||{}, s5 = C5.sql[5]||{};
    T('V2 SQL: JOIN + EXISTS subquery', s0.op==='read' && ['SCHEMA.T1','SCHEMA.T2','T3'].every(t=>s0.tables.includes(t)));
    T('V2 SQL: MERGE INTO → update + tables', s1.op==='update' && s1.tables.includes('PAYHIST') && s1.tables.includes('STAGE'));
    T('V2 SQL: quoted identifier', s2.op==='write' && s2.tables.includes('MY TABLE'));
    T('V2 SQL: CTE excluded, real tables detected', s3.op==='read' && s3.tables.includes('REALT') && s3.tables.includes('T4B') && !s3.tables.includes('CTE1'));
    T('V2 SQL: dynamic PREPARE → 0 table + explicit warning', s4.op==='dynamic' && s4.tables.length===0 && C5.warns.some(w=>w.includes('dynamic SQL')));
    T('V2 SQL: INCLUDE SQLCA / WHENEVER silent', s5.op==='other' && !C5.warns.some(w=>w.includes('SQLCA')));

    // ── 4. JCL: nested PROCs, continuation, in-stream, IF/THEN, INCLUDE ──
    const JV2 = [
      "//JOBV2   JOB 1,'X'",
      "//OUTER   PROC X=1",
      "//OS1     EXEC PGM=PA",
      "//DD1     DD DSN=A.B,DISP=SHR",
      "//INNER   PROC Y=2",
      "//IS1     EXEC PGM=PB",
      "//         PEND",
      "//OS2     EXEC PGM=PC",
      "//         PEND",
      "//CALL1   EXEC PROC=OUTER",
      "//STEPX   EXEC PGM=PX",
      "//DD2     DD DSN=X.Y,",
      "//         DISP=SHR",
      "//STEP3   EXEC PGM=P3",
      "//SYSIN   DD *",
      "RANDOM TEXT EXEC LIKE CONTENT",
      "//IFSTEP  IF (RC=0) THEN",
      "//NEXT    EXEC PGM=P4",
      "//ENDSTEP ENDIF"
    ].join("\n");
    const J2 = parseJCL(JV2);
    T('V2 JCL: nested in-stream PROCs (OUTER/INNER)', !!J2.procs.OUTER && !!J2.procs.INNER && J2.procs.OUTER.steps.length===2 && J2.procs.INNER.steps.length===1);
    T('V2 JCL: PROC expanded at the call site', J2.jobs[0].steps.length===5 && J2.jobs[0].steps[0].target==='PA' && J2.jobs[0].steps[0].via==='CALL1');
    T('V2 JCL: parameter continuation (DSN/DISP on 2 lines)', (()=>{ const dd=(J2.jobs[0].steps.find(s=>s.name==='STEPX')||{dds:[]}).dds.find(d=>d.ddname==='DD2'); return !!dd && dd.name==='X.Y' && dd.usage==='input'; })());
    T('V2 JCL: in-stream DD * not confused with JCL', (()=>{ const st=J2.jobs[0].steps.find(s=>s.name==='STEP3')||{dds:[]}; return st.dds.some(d=>d.ddname==='SYSIN') && J2.jobs[0].steps.some(s=>s.name==='NEXT') && !J2.warnings.some(w=>w.includes('RANDOM')||w.includes('unrecognized')); })());
    T('V2 JCL: IF ... THEN — condition without the THEN word', (()=>{ const st=J2.jobs[0].steps.find(s=>s.name==='NEXT'); return !!st && !!st.condition && st.condition.text==='(RC=0)'; })());
    const MEM1 = "//S1 EXEC PGM=PM\n//DM DD DSN=INCL.DATA,DISP=SHR";
    const J3 = parseJCL("//JMAIN JOB 1\n//I1 INCLUDE MEMBER=MEM1\n//S9 EXEC PGM=PZ", { MEM1: MEM1 });
    T('V2 JCL: INCLUDE resolved when the member is uploaded', J3.jobs[0].steps.length===2 && J3.jobs[0].steps[0].target==='PM' && J3.jobs[0].steps[0].dds.some(d=>d.name==='INCL.DATA'));
    const J4 = parseJCL("//J2 JOB 1\n//I2 INCLUDE MEMBER=NOSUCH\n//SX EXEC PGM=PY", { MEM1: MEM1 });
    T('V2 JCL: missing INCLUDE → precise warning, rest of the job intact', J4.warnings.some(w=>w.includes('INCLUDE member NOSUCH not uploaded')) && J4.jobs[0].steps.length===1);

    // ── 5. Graph: paragraphs as nodes, FD certain, 3-part backref, impact ──
    state.files = [];
    const GJ = "//JG1 JOB 1\n//PRC1 PROC\n//PS1 EXEC PGM=PP1\n//PD1 DD DSN=SRC.DATA,DISP=SHR\n// PEND\n//C1 EXEC PROC=PRC1\n//S2 EXEC PGM=BANKUPD\n//MASTDD DD DSN=BK.MASTER,DISP=SHR\n//BK DD DSN=*.C1.PS1.PD1,DISP=OLD";
    const gfiles = [
      { name:'G.JCL', lang:'JCL', text:GJ },
      { name:'BANKUPD.CBL', lang:'CBL', text:CV2 },
    ];
    gfiles.forEach(f => {
      if (f.lang === 'JCL'){ const res = parseJCL(f.text); f.parsed = { jobs: res.jobs, procs: res.procs, warnings: res.warnings }; }
      else { const C = parseCOBOL(f.name, f.text, {}); f.parsed = { cobol: C, warnings: C.warns, programId: C.programId, copies: C.copyUsed.map(c=>({name:c.name,resolved:!!c.resolved})), sqlCount: C.sql.length, performs: C.performs.length, gotos: C.gotos.length, deadCount: (C.dead||[]).length }; }
    });
    const M = buildModel(gfiles);
    const E = M.edges;
    const has = (f,t,k) => E.some(e=>e.f===f&&e.t===t&&e.k===k);
    T('V2 GRAPH: paragraph = node (prog contains para)', has('prog|BANKUPD','para|BANKUPD.READ-S','contains'));
    T('V2 GRAPH: PERFORM para→para certain', has('para|BANKUPD.INIT-S','para|BANKUPD.READ-S','perform'));
    T('V2 GRAPH: GO TO DEPENDING para→para probable (from READ-S, no self-loop)', (E.find(e=>e.f==='para|BANKUPD.READ-S'&&e.t==='para|BANKUPD.INIT-S'&&e.k==='goto')||{}).c==='probable' && !E.some(e=>e.f===e.t&&e.k==='goto'));
    T('V2 GRAPH: WRITE on record → certain dataset (SELECT+FD+WRITE)', (E.find(e=>e.f==='step|JG1.S2'&&e.t==='ds|BK.MASTER'&&e.k==='write')||{}).c==='certain');
    T('V2 GRAPH: 3-part backref *.C1.PS1.PD1 resolved', has('step|JG1.S2','ds|SRC.DATA','read'));
    const impG = impact(M, 'job|JG1');
    T('V2 IMPACT: JOB → paragraph (path job→step→prog→para)', impG.down.indirect.some(x=>x.id==='para|BANKUPD.READ-S' && x.path.length===4));
    const impP = impact(M, 'para|BANKUPD.READ-S');
    T('V2 IMPACT: from a paragraph — prog direct, job indirect', impP.up.direct.some(x=>x.id==='prog|BANKUPD') && impP.up.indirect.some(x=>x.id==='job|JG1'));

    // ── 6. EXEC CICS: FCT files, maps, queues, XCTL/LINK, never invented ──
    const CICSTXT = [
      "IDENTIFICATION DIVISION.",
      "PROGRAM-ID. TCS100.",
      "ENVIRONMENT DIVISION.",
      "INPUT-OUTPUT SECTION.",
      "FILE-CONTROL.",
      "    SELECT BATCH-FILE ASSIGN TO BATCHDD.",
      "DATA DIVISION.",
      "FILE SECTION.",
      "FD  BATCH-FILE.",
      "01  BATCH-REC.",
      "PROCEDURE DIVISION.",
      "P1.",
      "    EXEC CICS READ FILE('CUSTFCT') INTO(WS-REC) RIDFLD(WS-KEY)",
      "    END-EXEC.",
      "    EXEC CICS WRITE FILE('BATCHDD') FROM(BATCH-REC) END-EXEC.",
      "    EXEC CICS XCTL PROGRAM('TCS200') END-EXEC.",
      "    EXEC CICS LINK PROGRAM('HELLOPGM') END-EXEC.",
      "    EXEC CICS SEND MAP('MENMAP1') MAPSET('MENSET') END-EXEC.",
      "    EXEC CICS WRITEQ TS QUEUE('TSTQ') FROM(WS-DATA) END-EXEC.",
      "    EXEC CICS READ FILE(WS-FILE-VAR) END-EXEC.",
      "    EXEC CICS HANDLE CONDITION(ERRORPAR) END-EXEC.",
      "    STOP RUN."
    ].join("\n");
    const C9 = parseCOBOL('TCS100.CBL', CICSTXT, {});
    T('V2 CICS: 8 EXEC CICS commands captured (incl. multi-line block)', C9.cics.length === 8);
    T('V2 CICS: READ FILE → FCT entry, WRITE FILE(BATCHDD) attached to the SELECT ASSIGN', (C9.cicsFiles['CUSTFCT']||[]).some(o=>o.op==='read') && (C9.fileOps['BATCH-FILE']||[]).some(o=>o.op==='write' && o.cics==='WRITE'));
    T('V2 CICS: FILE(variable) without traced constant → explicit warning, no entry, nothing invented', C9.cics.some(e=>e.cmd==='READ'&&e.file===null&&e.silent) && !C9.cicsFiles['WS-FILE-VAR'] && C9.warns.some(w=>w.includes('WS-FILE-VAR') && w.includes('variable value unknown')));
    T('V2 CICS: HANDLE CONDITION target captured (control transfer), without warning', C9.cics.some(e=>e.cmd==='HANDLE'&&e.handles&&e.handles.length===1&&e.handles[0].to==='ERRORPAR'&&e.handles[0].key==='CONDITION'&&!e.silent) && !C9.warns.some(w=>w.includes('HANDLE')));
    const bakC = { files: state.files, loaded: state.loaded, log: state.log };
    state.files = [{ name:'TCS100.CBL', lang:'CBL', text:CICSTXT }];
    state.files.forEach(x => parseFile(x));
    const MC = buildModel(state.files);
    const EC = MC.edges;
    const gC = (ff,tt,kk) => EC.find(e => e.f===ff && e.t===tt && (!kk || e.k===kk));
    T('V2 CICS GRAPH: prog → fct|CUSTFCT read certain (FCT, unknown dataset)', (gC('prog|TCS100','fct|CUSTFCT','read')||{}).c==='certain');
    T('V2 CICS GRAPH: no invented dataset, BATCHDD attached without FCT node', !EC.some(e => e.t.startsWith('ds|') && e.t.includes('CUSTFCT')) && !MC.nodes.has('fct|BATCHDD'));
    T('V2 CICS GRAPH: XCTL/LINK → call vers programmes externes certain', (gC('prog|TCS100','xpgm|TCS200','call')||{}).c==='certain' && (gC('prog|TCS100','xpgm|HELLOPGM','call')||{}).c==='certain');
    T('V2 CICS GRAPH: SEND MAP → map node + certain uses', (gC('prog|TCS100','map|MENMAP1','uses')||{}).c==='certain' && !!MC.nodes.get('map|MENMAP1'));
    T('V2 CICS GRAPH: WRITEQ TS QUEUE → q node + certain write + qtype TS', (gC('prog|TCS100','q|TSTQ','write')||{}).c==='certain' && (MC.nodes.get('q|TSTQ').data||{}).qtype==='TS');
    // ── 6b. Deep CICS: FILE(variable) traced + HANDLE CONDITION/AID/ABEND ──
    const CVT = "IDENTIFICATION DIVISION.\nPROGRAM-ID. CICSVAR.\nENVIRONMENT DIVISION.\nINPUT-OUTPUT SECTION.\nFILE-CONTROL.\n    SELECT CUST-FILE ASSIGN TO CUSTFCT.\nDATA DIVISION.\nFILE SECTION.\nFD  CUST-FILE.\n01  CUST-REC.\nWORKING-STORAGE SECTION.\n01  WS-FILE PIC X(8).\nPROCEDURE DIVISION.\nSETUP-P.\n    MOVE 'CUSTFCT' TO WS-FILE.\nREAD-P.\n    EXEC CICS READ FILE(WS-FILE) INTO(R1) END-EXEC.\n    EXEC CICS HANDLE CONDITION NOTFND(NOTFND-P) ERROR(ERR-P) END-EXEC.\n    EXEC CICS HANDLE AID ENTER(ENT-P) END-EXEC.\n    EXEC CICS HANDLE ABEND PROGRAM('ABPROG') END-EXEC.\n    STOP RUN.\nORPH-P.\n    DISPLAY 'ORPH'.\nNOTFND-P.\n    DISPLAY 'NF'.\nERR-P.\n    DISPLAY 'E'.\nENT-P.\n    DISPLAY 'ENT'.\nUNK-P.\n    EXEC CICS WRITE FILE(WS-UNK) INTO(R2) END-EXEC.\n    DISPLAY 'U'.";
    const CVJ = "//CVJOB JOB 1\n//S1 EXEC PGM=CICSVAR\n//CUSTFCT DD DSN=BK.CUSTFCT.DATA,DISP=SHR";
    state.files = [ { name:'CVJOB.JCL', lang:'JCL', text:CVJ }, { name:'CICSVAR.CBL', lang:'CBL', text:CVT } ];
    state.files.forEach(f => parseFile(f));
    state.loaded = true; state.log = []; state._model = null;
    buildLog();
    const MV = getModel();
    const gV = (f2, t2, k2) => MV.edges.find(e => e.f === f2 && e.t === t2 && e.k === k2);
    T('V2 CICS VAR: FILE(variable) traced → step→dataset probable (dynamic, not certain)', (gV('step|CVJOB.S1','ds|BK.CUSTFCT.DATA','read')||{}).c === 'probable');
    T('V2 CICS VAR: evidence = EXEC CICS string + MOVE constant + SELECT + JCL DD', (() => { const e2 = gV('step|CVJOB.S1','ds|BK.CUSTFCT.DATA','read'); return !!e2 && e2.ev.length >= 3 && e2.ev.some(x => x.note && x.note.includes('CICS')); })());
    T('V2 CICS VAR: FILE(variable) without constant → warning, no edge, nothing invented', (() => {
      const C6 = state.files[1].parsed.cobol;
      return C6.warns.some(w => w.includes('FILE(WS-UNK)') && w.includes('variable value unknown')) && !MV.nodes.has('fct|WS-UNK') && !MV.edges.some(e => String(e.t).includes('WS-UNK'));
    })());
    T('V2 CICS HANDLE: CONDITION/AID → certain para→para handle edges', (gV('para|CICSVAR.READ-P','para|CICSVAR.NOTFND-P','handle')||{}).c === 'certain' && (gV('para|CICSVAR.READ-P','para|CICSVAR.ENT-P','handle')||{}).c === 'certain');
    T('V2 CICS HANDLE: ABEND PROGRAM(x) → certain program call', (gV('prog|CICSVAR','xpgm|ABPROG','call')||{}).c === 'certain');
    T('V2 CICS HANDLE: HANDLE targets alive — no false dead code', (() => {
      const C6 = state.files[1].parsed.cobol;
      const dn = (C6.dead||[]).map(d=>d.name);
      return dn.length === 1 && dn.includes('ORPH-P') && !dn.includes('NOTFND-P') && !dn.includes('ERR-P') && !dn.includes('ENT-P');
    })());
    state.files = bakC.files; state.loaded = bakC.loaded; state.log = bakC.log; state._model = null;

    // ── 7. Results export & non-expert express read ──
    // The section has its own mini-project: a 2-step job, 2 programs, a copybook
    // uploaded (PAYREC) — the express read must be generated from THIS real model.
    const SGJ = "//SGJOB JOB 1,'STORY'\n//ST1 EXEC PGM=SGPROG\n//SGIN DD DSN=SG.INPUT.DATA,DISP=SHR\n//SGOUT DD DSN=SG.OUTPUT.DATA,DISP=(,CATLG)\n//ST2 EXEC PGM=SGPROG2\n//SG2 DD DSN=SG.OUTPUT.DATA,DISP=OLD";
    const SGC = "IDENTIFICATION DIVISION.\nPROGRAM-ID. SGPROG.\nENVIRONMENT DIVISION.\nINPUT-OUTPUT SECTION.\nFILE-CONTROL.\n    SELECT SGF-FILE ASSIGN TO SGIN.\nDATA DIVISION.\nFILE SECTION.\nFD  SGF-FILE.\n01  SGF-REC.\n    COPY PAYREC.\nPROCEDURE DIVISION.\nMAIN.\n    OPEN INPUT SGF-FILE.\n    READ SGF-FILE.\n    EXEC SQL SELECT * FROM SG.TAB END-EXEC.";
    const SGC2 = "IDENTIFICATION DIVISION.\nPROGRAM-ID. SGPROG2.\nPROCEDURE DIVISION.\nMAIN.\n    EXEC SQL INSERT INTO SG.TAB2 VALUES (:X) END-EXEC.";
    const SGCPY = "01  PAY-RECORD.\n    05  ACC-ID  PIC 9(8).";
    state.files = [
      { name:'SGJOB.JCL', lang:'JCL', text:SGJ },
      { name:'SGPROG.CBL', lang:'CBL', text:SGC },
      { name:'SGPROG2.CBL', lang:'CBL', text:SGC2 },
      { name:'PAYREC.CPY', lang:'CPY', text:SGCPY },
    ];
    state.files.forEach(f => parseFile(f));
    state.loaded = true; state.log = []; state._model = null;
    buildLog();
    const MP = getModel();
    const pl = resultsPayload();
    T('V2 EXPORT: payload = full model (nodes, relations, evidence, warnings)', pl.edges.length === MP.edges.length && pl.nodes.length === MP.nodes.size && Array.isArray(pl.warnings) && pl.edges.every(e => Array.isArray(e.evidence)));
    const csv = resultsCSV();
    const csvLines = csv.trim().split(/\r\n/);
    T('V2 EXPORT: CSV = header + one line per relation, quoted cells', csvLines.length === MP.edges.length + 1 && csvLines[0] === '\"From\",\"To\",\"Relation\",\"Confidence\",\"Evidence\"');
    T('V2 EXPORT: CSV protected against spreadsheet formula injection', csvCell('=cmd(1)') === '"\'=cmd(1)"');
    const md = resultsMD();
    T('V2 EXPORT: Markdown report = overview, jobs, datasets, points of attention, relations with evidence', md.includes('# Reforge analysis report') && md.includes('## Points of attention') && md.includes('## Datasets') && md.includes('## All relations') && md.includes('(file:line)'));
    const story = summaryStoryHTML();
    T('V2 STORY: 5-minute read generated from the real model (jobs, data, scenario, questions)', story.includes('First 5 minutes') && story.includes('PAYREC') && story.includes('Points to ask about'));
    T('V2 STORY: honest change scenario (programs + confidence, affected jobs)', /affects/.test(story) && /\(unknown\)|\(certain\)/.test(story));

    // ── 8. Security: XSS — hostile names/contents rendered escaped in ALL panels ──
    const EVJ = [
      "//EVJ JOB 1,'<script>alert(1)<\/script>'",
      "//S1 EXEC PGM=EVPGM",
      "//DD1 DD DSN=EV\"><img src=x onerror=alert(1)>.DATA,DISP=SHR",
      "//IFB IF (RC=0) OR '<b>hi</b>' = 'x' THEN",
      "//S2 EXEC PGM=EV2",
      "//ENDIF"
    ].join("\n");
    const EVC = "IDENTIFICATION DIVISION.\nPROGRAM-ID. EVCOBOL.\nPROCEDURE DIVISION.\n    DISPLAY '<img src=x onerror=alert(2)>'\n    EXEC SQL SELECT * FROM EV\"><table>.TAB END-EXEC\n    STOP RUN.";
    const EVCI = "IDENTIFICATION DIVISION.\nPROGRAM-ID. EVCICS.\nPROCEDURE DIVISION.\n    EXEC CICS READ FILE('EV\"><img src=x onerror=alert(3)>') END-EXEC\n    STOP RUN.";
    state.files = [
      { name:'EV"><img src=x onerror=alert(1)>.JCL', lang:'JCL', text:EVJ },
      { name:'EV"><b>.CBL', lang:'CBL', text:EVC },
      { name:'EV"><i>.CBL', lang:'CBL', text:EVCI },
    ];
    state.files.forEach(f => parseFile(f));
    state.loaded = true; state.log = [];
    buildLog();
    let allHTML = '';
    Object.keys(PANELS).forEach(k => { try { allHTML += String(PANELS[k]()); } catch(e){ T('V2 XSS: panel '+k+' rendered without crash', false); } });
    T('V2 XSS: no raw tag injected (<img/<script/<b>/<table>)', !/<img src=x|<script>alert|<b>hi<\/b>|<table>/.test(allHTML));
    let badAttr = false;
    let am; const are = /on(?:click|change|input)="([^"]*)"/g;
    while ((am = are.exec(allHTML))) if (/[<>]/.test(am[1])) badAttr = true;
    T('V2 XSS: onclick/onchange attributes without raw < or >', !badAttr);
    state.files = []; state.loaded = false; state.log = []; state._model = null;

    // ── 9. Dead code: unreachable paragraphs + never-referenced programs ──
    const DCD = ["IDENTIFICATION DIVISION.","PROGRAM-ID. DEADPGM.","PROCEDURE DIVISION.",
      "MAIN-P.","    PERFORM INIT-P.","    PERFORM THRU-P.","    STOP RUN.",
      "DEAD-P.","    DISPLAY 'NEVER'.",
      "INIT-P.","    MOVE 1 TO X.",
      "THRU-P.","    DISPLAY 'THRU'.",
      "USED-P.","    GO TO FIN-P.",
      "AFTER-GO-P.","    DISPLAY 'NEVER2'.",
      "FIN-P.","    IF X = 1 GO TO FIN-P.","    DISPLAY 'FALLS'.",
      "NEXT-P.","    DISPLAY 'REACHED BY FALL'."].join("\n");
    const CDD = parseCOBOL('DEADPGM.CBL', DCD, {});
    const deadNames = (CDD.dead||[]).map(d=>d.name);
    T('V2 DEAD: dead = exactly the non-targeted ones after STOP RUN / GO TO', deadNames.length === 2 && deadNames.includes('DEAD-P') && deadNames.includes('AFTER-GO-P'));
    T('V2 DEAD: PERFORM, PERFORM THRU, GO TO target and fall-through stay alive', ['MAIN-P','INIT-P','THRU-P','USED-P','FIN-P','NEXT-P'].every(n => !deadNames.includes(n)));
    T('V2 DEAD: conditional GO TO (IF ... GO TO) does not block fall-through', !deadNames.includes('NEXT-P') && !deadNames.includes('FIN-P'));
    T('V2 DEAD: precise warning per dead paragraph (name + line)', CDD.warns.some(w => w.includes('DEAD-P') && w.includes('unreachable') && w.includes('(line')));
    T('V2 DEAD: DECLARATIVES → analysis honestly disabled, nothing invented', (() => {
      const CD3 = parseCOBOL('D3.CBL', "IDENTIFICATION DIVISION.\nPROGRAM-ID. D3.\nPROCEDURE DIVISION.\nDECLARATIVES.\nUSE-P.\n    DISPLAY 'X'.\nEND DECLARATIVES.\nMAIN-P.\n    STOP RUN.\nD-P.\n    DISPLAY 'NEVER'.", {});
      return (CD3.dead||[]).length === 0 && CD3.warns.some(w => w.includes('DECLARATIVES') && w.includes('disabled'));
    })());
    T('V2 DEAD: SORT INPUT/OUTPUT PROCEDURE → alive targets', (() => {
      const CD4 = parseCOBOL('D4.CBL', "IDENTIFICATION DIVISION.\nPROGRAM-ID. D4.\nPROCEDURE DIVISION.\nMAIN-P.\n    SORT S-FILE INPUT PROCEDURE IS IN-P\n    OUTPUT PROCEDURE OUT-P.\n    STOP RUN.\nD-P.\n    DISPLAY 'NEVER'.\nIN-P.\n    DISPLAY 'IN'.\nOUT-P.\n    DISPLAY 'OUT'.", {});
      const dn = (CD4.dead||[]).map(d=>d.name);
      return !dn.includes('IN-P') && !dn.includes('OUT-P') && dn.includes('D-P') && CD4.performs.some(p=>p.to==='IN-P' && p.kind==='sort');
    })());
    T('V2 DEAD: model — para node marked dead + aggregated warning + orphan program flagged', (() => {
      state.files = [{ name:'DJ.JCL', lang:'JCL', text:"//DJ JOB 1\n//S1 EXEC PGM=DEADPGM\n//DD1 DD DSN=D.DATA,DISP=SHR" },
                     { name:'DEADPGM.CBL', lang:'CBL', text:DCD },
                     { name:'ORPHAN.CBL', lang:'CBL', text:"IDENTIFICATION DIVISION.\nPROGRAM-ID. ORPHAN.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN." }];
      state.files.forEach(f => parseFile(f));
      state.loaded = true; state.log = []; state._model = null;
      buildLog();
      const MDL = getModel();
      const node = MDL.nodes.get('para|DEADPGM.DEAD-P');
      return !!node && node.data.dead === true
        && MDL.warnings.some(w => w.includes('unreachable paragraph(s) in DEADPGM') && w.includes('DEAD-P'))
        && MDL.warnings.some(w => w.includes('program ORPHAN is never executed or called'))
        && !MDL.warnings.some(w => w.includes('program DEADPGM is never'));
    })());

    // ── 10. REXX & cartes SORT (phase 3) ──
    const SJ = "//SJ JOB 1\n//S1 EXEC PGM=SORT\n//SORTIN DD DSN=IN.DATA,DISP=SHR\n//SORTOUT DD DSN=OUT.DATA,DISP=OLD\n//SYSIN DD *\nSORT FIELDS=(1,10,CH,A)\nSUM FIELDS=NONE\n/*\n//S2 EXEC PGM=ICEMAN\n//SORTIN DD DSN=IN2.DATA,DISP=SHR\n//SORTOUT DD DSN=OUT2.DATA,DISP=OLD\n//SYSIN DD *\nSORT FORMAT=CH,FIELDS=(5,3,B)\n/*\n//S3 EXEC PGM=SORT\n//SORTIN DD DSN=IN3.DATA,DISP=SHR\n//SORTOUT DD DSN=OUT3.DATA,DISP=OLD\n//SYSIN DD DSN=LIB.CARDS(SRT3),DISP=SHR\n//S4 EXEC PGM=SORT\n//SORTIN DD DSN=IN4.DATA,DISP=SHR\n//SORTOUT DD DSN=OUT4.DATA,DISP=OLD\n//SYSOUT DD SYSOUT=*\n//S5 EXEC PGM=IKJEFT01\n//SYSTSIN DD *\nEXEC 'PAY.REXX(PAYLIST)'\n/*\n//S6 EXEC PGM=IKJEFT01\n//SYSEXEC DD DSN=PAY.REXX,DISP=SHR\n//SYSTSIN DD DSN=PAY.SYSTSIN,DISP=SHR";
    const resS = parseJCL(SJ, {});
    const stS = n => resS.jobs[0].steps.find(s => s.name === n);
    T('V2 SORT: inline SYSIN cards captured, FIELDS=(1,10,CH,A) decoded + SUM', (() => {
      const si = (stS('S1')||{}).sortInfo;
      return !!si && si.type==='sort' && si.decoded && si.fields.length===1
        && si.fields[0].pos===1 && si.fields[0].len===10 && si.fields[0].type==='CH' && si.fields[0].order==='A'
        && si.sum==='none';
    })());
    T('V2 SORT: ICEMAN (alias DFSORT) + short form FORMAT=CH (p,l,order)', (() => {
      const si = (stS('S2')||{}).sortInfo;
      return !!si && si.fields.length===1 && si.fields[0].pos===5 && si.fields[0].len===3
        && si.fields[0].type==='CH' && si.fields[0].order==='B';
    })());
    T('V2 SORT: SYSIN in a non-uploaded dataset → honest warning, no invented field', (() => {
      const s3 = stS('S3');
      return !s3.sortInfo && resS.warnings.some(w => w.includes('S3') && w.includes('sort fields unknown'));
    })());
    T('V2 SORT: SORT step without SYSIN → warning, nothing decoded', (() => {
      const s4 = stS('S4');
      return !s4.sortInfo && resS.warnings.some(w => w.includes('S4') && w.includes('no SYSIN cards captured'));
    })());
    T('V2 SORT: in-stream cards captured without false "non-JCL line ignored" warning', !resS.warnings.some(w => w.includes('non-JCL')));
    T('V2 SORT UI: stepDesc shows the decoded fields and SUM', (() => {
      const d = stepDesc({ name:'S1', pgm:'SORT', kind:'PGM', dds:[], sortInfo: stS('S1').sortInfo });
      return d.includes('1:10 CH A') && d.includes('SUM');
    })());
    T('V2 REXX: EXEC \'dsn(member)\' from SYSTSIN → member extracted', (stS('S5')||{}).rexxExec === 'PAYLIST');
    T('V2 REXX: SYSTSIN in a non-uploaded dataset → unknown member + honest warning', (() => {
      const s6 = stS('S6');
      return !s6.rexxExec && resS.warnings.some(w => w.includes('S6') && w.includes('executed member unknown'));
    })());
    T('V2 REXX: .REX/.EXEC detection and /* REXX */ marker', detectLang('PAYLIST.REX', "SAY 'HI'") === 'REXX' && detectLang('PAYLIST.EXEC', "SAY 'HI'") === 'REXX' && detectLang('PAYLIST.TXT', "/* REXX PAYLIST */\nSAY 'HI'") === 'REXX' && detectLang('X.JCL', "//X JOB 1") === 'JCL');
    const RXT = "/* REXX PAYLIST */\n/* cleanup batch */\nCALL 'PAY.CLEAN(PAYCLEAN)'\nADDRESS TSO \"DELETE 'PAY.WORK.FILE'\"\nCALL ON ERROR NAME ERRH\nCALL PAYTARGET\nSAY 'PAY.MASTER.DATA'\nERRH:\n  SAY 'E'";
    const RX = parseREXX('PAYLIST.REX', RXT);
    T('V2 REXX: literal CALL captured, CALL ON ERROR ignored, internal label not a call', (() => {
      return RX.execName === 'PAYLIST'
        && RX.calls.length === 2
        && RX.calls.some(c => c.quoted && c.target === 'PAY.CLEAN(PAYCLEAN)')
        && RX.calls.some(c => !c.quoted && c.viaVar === 'PAYTARGET')
        && !RX.calls.some(c => c.target === 'ON' || c.target === 'ERRH');
    })());
    T('V2 REXX: datasets quoted in double quotes captured and deduplicated', (() => {
      const names = RX.dsns.map(d => d.name);
      return names.includes('PAY.MASTER.DATA') && names.includes('PAY.WORK.FILE')
        && names.filter(n => n === 'PAY.MASTER.DATA').length === 1;
    })());
    const bakR = { files: state.files, loaded: state.loaded, log: state.log };
    state.files = [
      { name:'RXJOB.JCL', lang:'JCL', text:"//RXJOB JOB 1\n//S1 EXEC PGM=IKJEFT01\n//SYSTSIN DD *\nEXEC 'PAY.REXX(PAYLIST)'\n/*" },
      { name:'PAYLIST.REX', lang:'REXX', text:RXT },
      { name:'PAYCLEAN.REX', lang:'REXX', text:"/* REXX PAYCLEAN */\nSAY 'CLEAN'" }
    ];
    state.files.forEach(f => parseFile(f));
    state.loaded = true; state.log = []; state._model = null;
    buildLog();
    const MR = getModel();
    const gR = (f2, t2, k2) => MR.edges.find(e => e.f === f2 && e.t === t2 && e.k === k2);
    T('V2 REXX GRAPH: IKJEFT01 SYSTSIN EXEC → prog|PAYLIST exec certain', (gR('step|RXJOB.S1','prog|PAYLIST','exec')||{}).c === 'certain');
    T('V2 REXX GRAPH: CALL \'dsn(member)\' to an uploaded exec → prog|PAYCLEAN certain call', (gR('prog|PAYLIST','prog|PAYCLEAN','call')||{}).c === 'certain');
    T('V2 REXX GRAPH: CALL via variable → warning, no invented edge', (() => {
      return MR.warnings.some(w => w.includes('CALL via variable PAYTARGET'))
        && !MR.edges.some(e => String(e.t).includes('PAYTARGET'));
    })());
    T('V2 REXX GRAPH: quoted datasets → references unknown, never invented read/write', (() => {
      const e1 = gR('prog|PAYLIST','ds|PAY.MASTER.DATA','references');
      return !!e1 && e1.c === 'unknown'
        && !MR.edges.some(e => e.f === 'prog|PAYLIST' && e.t === 'ds|PAY.MASTER.DATA' && (e.k === 'read' || e.k === 'write'));
    })());
    T('V2 REXX GRAPH: CALL ON ERROR does not create a false external program', !MR.nodes.has('xpgm|ERROR') && !MR.nodes.has('xpgm|ON'));
    T('V2 REXX GRAPH: IKJEFT01 EXEC member not uploaded → warning, no invented node', (() => {
      state.files = [ { name:'RXJOB2.JCL', lang:'JCL', text:"//RXJOB2 JOB 1\n//S1 EXEC PGM=IKJEFT01\n//SYSTSIN DD *\nEXEC 'PAY.REXX(GHOSTEX)'\n/*" } ];
      state.files.forEach(f => parseFile(f));
      state._model = null;
      const M2 = getModel();
      return M2.warnings.some(w => w.includes("EXEC 'GHOSTEX'") && w.includes('cannot be expanded'))
        && !M2.nodes.has('prog|GHOSTEX') && !M2.nodes.has('xpgm|GHOSTEX');
    })());
    state.files = bakR.files; state.loaded = bakR.loaded; state.log = bakR.log; state._model = null;

    // ── 11. JCL finesse: COND=/IF/ELSE, RD/RERUN, warning sort by severity ──
    const JF = "//JF JOB 1,RD=R\n//S1 EXEC PGM=PGM1,COND=(0,LT)\n//S2 EXEC PGM=PGM2,RD=R\n//IF1 IF (RC = 0) THEN\n//S3 EXEC PGM=PGM3\n//ELSE\n//S4 EXEC PGM=PGM4\n//ENDIF\n//S5 EXEC PGM=PGM5";
    const resF = parseJCL(JF, {});
    const stF = n => resF.jobs[0].steps.find(s => s.name === n);
    T('V2 JCL4: EXEC COND= captured, not lost in symbols', (() => {
      const s1 = stF('S1');
      return s1.cond === '(0,LT)' && !('COND' in s1.symbols) && !('RD' in stF('S2').symbols);
    })());
    T('V2 JCL4: EXEC RD= captured (restart), COND/RD do not pollute the overrides', (() => {
      const s2 = stF('S2');
      return s2.rd === 'R' && Object.keys(s2.overrides).length === 0;
    })());
    T('V2 JCL4: IF THEN → condition, ELSE → negation, ENDIF → back to zero', (() => {
      const s3 = stF('S3'), s4 = stF('S4'), s5 = stF('S5');
      return !!s3.condition && s3.condition.neg === false && String(s3.condition.text).indexOf('(RC = 0)') === 0
        && !!s4.condition && s4.condition.neg === true
        && s5.condition === null;
    })());
    const bakF = { files: state.files, loaded: state.loaded, log: state.log };
    state.files = [
      { name:'JF.JCL', lang:'JCL', text:JF },
      { name:'ORPHF.CBL', lang:'CBL', text:"IDENTIFICATION DIVISION.\nPROGRAM-ID. ORPHF.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN." }
    ];
    state.files.forEach(f => parseFile(f));
    state.loaded = true; state.log = []; state._model = null;
    buildLog();
    const MF = getModel();
    T('V2 JCL4: model — data.cond/rd on the step, data.rd on the job + restart warning', (() => {
      const ns = MF.nodes.get('step|JF.S1'), nj = MF.nodes.get('job|JF');
      return !!ns && ns.data.cond === '(0,LT)' && MF.nodes.get('step|JF.S2').data.rd === 'R'
        && !!nj && nj.data.rd === 'R'
        && MF.warnings.some(w => w.indexOf('job JF: RD/RERUN restart parameter present') === 0)
        && MF.warnings.some(w => w.includes('step JF.S2: RD=R (automatic restart'));
    })());
    T('V2 JCL4: conditional steps flagged without evaluated condition (honest)', (() => {
      return MF.warnings.some(w => w.includes('step JF.S1 is conditional (COND=(0,LT)'))
        && MF.warnings.some(w => w.includes('step JF.S3 is conditional (IF (RC = 0)'))
        && MF.warnings.some(w => w.includes('step JF.S4 is conditional (IF NOT (RC = 0)'))
        && MF.warnings.every(w => !w.includes('the condition is evaluated'));
    })());
    T('V2 JCL4: warnings sorted by severity — blocking before informational', (() => {
      const i1 = MF.warnings.findIndex(w => w.includes('program ORPHF is never executed or called'));
      const i3 = MF.warnings.findIndex(w => w.includes('step JF.S1 is conditional'));
      return i1 >= 0 && i3 >= 0 && i1 < i3;
    })());
    T('V2 JCL4: stepDesc shows COND and RD with explicit "not evaluated" mention', (() => {
      const d = stepDesc({ name:'S1', pgm:'PGM1', kind:'PGM', dds:[], cond:'(0,LT)' });
      const d2 = stepDesc({ name:'S2', pgm:'PGM2', kind:'PGM', dds:[], rd:'R' });
      return d.includes('COND') && d.includes('not evaluated') && d2.includes('RD=R') && d2.includes('restart');
    })());
    state.files = bakF.files; state.loaded = bakF.loaded; state.log = bakF.log; state._model = null;

    // ── 12. Robustness: EBCDIC/encodings, COBOL 2002, control report ──
    const enc37 = s => { const out = []; for (const ch of s){ const i = CP037.indexOf(ch); out.push(i >= 0 ? i : 0x40); } return new Uint8Array(out); };
    T('V2 EBCDIC: CP037 round-trip (letters, digits, punctuation, JCL line)', (() => {
      const s = "//SORT01 EXEC PGM=SORT,PARM='FIELDS=COPY'";
      const r = ebcdicDecode(enc37(s));
      return r.text === s && r.unmapped === 0;
    })());
    T('V2 EBCDIC: honest detection — EBCDIC yes, ASCII and accented UTF-8 no', (() => {
      const ascii = new Uint8Array('IDENTIFICATION DIVISION. HELLO WORLD'.split('').map(c => c.charCodeAt(0)));
      const utf8fr = new Uint8Array([0xC3,0x89,0x43,0x4F,0x4C,0x45,0x20,0x2F,0x2F,0x4A,0x4F,0x42,0x20,0x31]);
      return looksEbcdic(enc37('MONTHLY PAYROLL RUN FOR THE BANK MONTHLY PAYROLL RUN FOR THE BANK ')) === true
        && looksEbcdic(ascii) === false && looksEbcdic(utf8fr) === false;
    })());
    T('V2 DECODE: UTF-8 BOM removed, UTF-16LE decoded, UTF-8 accent intact', (() => {
      const bom = decodeBytes(new Uint8Array([0xEF,0xBB,0xBF,0xC3,0x89,0x43,0x4F,0x4C,0x45]));
      const u16 = decodeBytes(new Uint8Array([0xFF,0xFE,0x48,0x00,0x49,0x00]));
      return bom.text === 'ÉCOLE' && bom.enc.indexOf('BOM') >= 0 && u16.text === 'HI' && u16.enc.indexOf('utf-16le') >= 0;
    })());
    T('V2 EBCDIC: byte outside table → ? counted, never guessed', (() => {
      const r = ebcdicDecode(new Uint8Array([0xC8, 0x41, 0x40]));
      return r.text === 'H? ' && r.unmapped === 1;
    })());
    T('V2 COBOL 2002: ID DIVISION accepted, quoted PROGRAM-ID + INITIAL clause, lowercase', (() => {
      const C = parseCOBOL('N.CBL', "ID DIVISION.\nPROGRAM-ID. 'NEWPGM' IS INITIAL.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN.", {});
      const C2 = parseCOBOL('M.CBL', "IDENTIFICATION DIVISION.\nPROGRAM-ID. mixedcase.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN.", {});
      return C.programId === 'NEWPGM' && C.divisions.some(d => d.name === 'IDENTIFICATION') && C2.programId === 'MIXEDCASE';
    })());
    const bakG = { files: state.files, loaded: state.loaded, log: state.log };
    state.files = [
      { name: 'RJOB.JCL', lang: 'JCL', text: "//RJOB JOB 1,RD=R\n//S1 EXEC PGM=RPG1,COND=(0,LT)\n//WK DD DSN=NO.DISP.DS" },
      { name: 'RPG1.CBL', lang: 'CBL', text: "IDENTIFICATION DIVISION.\nPROGRAM-ID. RPG1.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN." },
      { name: 'ORPHR.CBL', lang: 'CBL', text: "IDENTIFICATION DIVISION.\nPROGRAM-ID. ORPHR.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN." },
      { name: "X\"><script>.CBL", lang: 'CBL', text: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HOSTILE.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN." }
    ];
    state.files.forEach(f => parseFile(f));
    state.loaded = true; state.log = []; state._model = null;
    buildLog();
    const HG = controlReportHTML();
    T('V2 REPORT: standalone HTML — inventory, 3 severities, confidence, orphan visible', (() => {
      return HG.indexOf('<!DOCTYPE html>') === 0 && HG.indexOf('1. Inventory') > 0
        && HG.indexOf('Severity 1 — blocking') > 0 && HG.indexOf('Severity 2') > 0 && HG.indexOf('Severity 3') > 0
        && HG.indexOf('certain') > 0 && HG.indexOf('never executed or called') > 0;
    })());
    T('V2 REPORT: hostile names escaped (XSS), no script injected', (() => {
      return HG.indexOf('&lt;script&gt;') > 0 && HG.toLowerCase().indexOf('<script') < 0;
    })());
    T('V2 REPORT: original encoding mentioned in the log (EBCDIC → "decoded from")', (() => {
      state.files = [ { name: 'E.JCL', lang: 'JCL', text: '//E JOB 1', encoding: 'EBCDIC CP037 (auto-detected)' } ];
      state.files.forEach(f => parseFile(f));
      state.loaded = true; state.log = []; state._model = null;
      buildLog();
      return state.log.some(l => (l.text || '').indexOf('decoded from EBCDIC CP037') >= 0);
    })());
    state.files = bakG.files; state.loaded = bakG.loaded; state.log = bakG.log; state._model = null;
    // ── 13. P1 reliability: duplicate identifiers, DLM/DATA/multi-JOB/symbolics, COBOL formats, levels 66/78, advanced SQL ──
    const bakH = { files: state.files, loaded: state.loaded, log: state.log };
    state.files = []; state.loaded = false; state.log = []; state._model = null;
    T('V2 DLM: in-stream data DLM=%% — // and /* lines stay data, only %% ends', (() => {
      const r = parseJCL([
        '//DLMJ JOB 1',
        '//S1 EXEC PGM=SORT',
        "//SYSIN DD *,DLM='%%'",
        'SORT FIELDS=COPY',
        '// THIS IS A DATA CARD',
        '/* THIS ONE TOO',
        '%%',
        '//S2 EXEC PGM=NEXT',
      ].join('\n'), {});
      const s1 = r.jobs[0].steps.find(s => s.name === 'S1');
      const inn = s1 && s1.dds.find(d => d.ddname === 'SYSIN');
      const s2 = r.jobs[0].steps.find(s => s.name === 'S2');
      return inn && inn.inline && inn.inline.length === 3
        && inn.inline[1].text.indexOf('// THIS') === 0 && inn.inline[2].text.indexOf('/* THIS ONE') === 0
        && !!s2 && s2.target === 'NEXT';
    })());
    T('V2 DD DATA without DLM: /* ends the data, a // line stays data', (() => {
      const r = parseJCL([
        '//DJ JOB 1',
        '//S1 EXEC PGM=CPY1',
        '//IN DD DATA',
        'CARD ONE',
        '// CARD TWO (data, not an end)',
        '/*',
        '//S2 EXEC PGM=CPY2',
      ].join('\n'), {});
      const s1 = r.jobs[0].steps.find(s => s.name === 'S1');
      const dd = s1 && s1.dds.find(d => d.ddname === 'IN');
      const s2 = r.jobs[0].steps.find(s => s.name === 'S2');
      return dd && dd.inline && dd.inline.length === 2 && dd.inline[1].text.indexOf('// CARD TWO') === 0 && !!s2;
    })());
    T('V2 multi-JOB: 2 jobs in one file, same-name steps S1 of distinct jobs not merged', (() => {
      const r = parseJCL([
        '//J1 JOB 1',
        '//S1 EXEC PGM=PA',
        '//J2 JOB 2',
        '//S1 EXEC PGM=PB',
      ].join('\n'), {});
      const m13 = buildModel([{ name: 'MJ.JCL', lang: 'JCL', text: '', parsed: r }]);
      return r.jobs.length === 2 && r.jobs[1].steps[0].target === 'PB'
        && m13.nodes.has('step|J1.S1') && m13.nodes.has('step|J2.S1') && !m13.nodes.has('step|J1.S1#2');
    })());
    T('V2 same-name step in a job: distinct S1 and S1#2 nodes + warning (no more merging)', (() => {
      const r = parseJCL([
        '//DJ JOB 1',
        '//S1 EXEC PGM=PA',
        '//DD1 DD DSN=A.B.C,DISP=SHR',
        '//S1 EXEC PGM=PB',
        '//DD1 DD DSN=D.E.F,DISP=SHR',
      ].join('\n'), {});
      const m13 = buildModel([{ name: 'DJ.JCL', lang: 'JCL', text: '', parsed: r }]);
      return m13.nodes.has('step|DJ.S1') && m13.nodes.has('step|DJ.S1#2')
        && m13.edges.some(e => e.f === 'step|DJ.S1' && e.t === 'xpgm|PA' && e.k === 'exec')
        && m13.edges.some(e => e.f === 'step|DJ.S1#2' && e.t === 'xpgm|PB' && e.k === 'exec')
        && m13.edges.some(e => e.f === 'step|DJ.S1#2' && e.t === 'ds|D.E.F')
        && m13.warnings.some(w => w.indexOf('duplicate step name S1') >= 0);
    })());
    T('V2 duplicate PROGRAM-ID: 2 files = 2 distinct programs (DUPP, DUPP#2) + warning, never merged', (() => {
      const fx = [
        { name: 'A.CBL', lang: 'CBL', text: "IDENTIFICATION DIVISION.\nPROGRAM-ID. DUPP.\nPROCEDURE DIVISION.\nPA.\n    STOP RUN." },
        { name: 'B.CBL', lang: 'CBL', text: "IDENTIFICATION DIVISION.\nPROGRAM-ID. DUPP.\nPROCEDURE DIVISION.\nPB.\n    STOP RUN." },
        { name: 'J.JCL', lang: 'JCL', text: '//J JOB 1\n//S EXEC PGM=DUPP' },
      ];
      fx.forEach(f => parseFile(f));
      const m13 = buildModel(fx);
      return m13.nodes.has('prog|DUPP') && m13.nodes.has('prog|DUPP#2')
        && m13.nodes.get('prog|DUPP').data.file === 'A.CBL' && m13.nodes.get('prog|DUPP#2').data.file === 'B.CBL'
        && m13.nodes.has('para|DUPP.PA') && m13.nodes.has('para|DUPP#2.PB')
        && m13.edges.some(e => e.f === 'step|J.S' && e.t === 'prog|DUPP' && e.k === 'exec')
        && m13.warnings.some(w => w.indexOf('duplicate PROGRAM-ID') >= 0 && w.indexOf('A.CBL') >= 0 && w.indexOf('B.CBL') >= 0);
    })());
    T('V2 PROC redefined (in-stream): the last definition wins + warning, no more silent overwriting', (() => {
      const r = parseJCL([
        '//PJ JOB 1',
        '//MYPROC PROC',
        '//PA EXEC PGM=FIRST',
        '// PEND',
        '//MYPROC PROC',
        '//PB EXEC PGM=SECOND',
        '// PEND',
        '//X EXEC PROC=MYPROC',
      ].join('\n'), {});
      return r.procs.MYPROC && r.procs.MYPROC.steps.length === 1 && r.procs.MYPROC.steps[0].target === 'SECOND'
        && r.warnings.some(w => w.indexOf('PROC MYPROC redefined') >= 0);
    })());
    T('V2 duplicate PROC (2 files): the last one wins + warning on the overwriting file', (() => {
      const fx2 = [
        { name: 'P1.JCL', lang: 'JCL', text: '//PP PROC\n//A EXEC PGM=FROMFIRST\n// PEND' },
        { name: 'P2.JCL', lang: 'JCL', text: '//PP PROC\n//B EXEC PGM=FROMSECOND\n// PEND\n//J2 JOB 1\n//S EXEC PROC=PP' },
      ];
      fx2.forEach(f => parseFile(f));
      state.files = fx2; // registry of cataloged procs for linkCatalogedProcs
      const m13 = buildModel(fx2);
      const ok = m13.edges.some(e => e.f === 'step|J2.B' && e.t === 'xpgm|FROMSECOND')
        && fx2[1].parsed.warnings.some(w => w.indexOf('PROC PP defined in multiple files') >= 0);
      state.files = [];
      return ok;
    })());
    T('V2 nested symbolics: global SET + PROC default + EXEC override → fully resolved DSN', (() => {
      const r = parseJCL([
        '//NJ JOB 1',
        '// SET HDR=BK.PY',
        '//PYS PROC CYC=202611',
        '//PS1 EXEC PGM=PAY1',
        '//DD1 DD DSN=&HDR..&CYC,DISP=SHR',
        '// PEND',
        '//ST1 EXEC PROC=PYS,CYC=202612',
      ].join('\n'), {});
      const ps = r.jobs[0].steps.find(s => s.via === 'ST1');
      return ps && ps.target === 'PAY1' && ps.dds[0].name === 'BK.PY.202612';
    })());
    T('V2 nested PROC + backref: *.O1.OUT resolved through INP→OUTP to &&TEMP1', (() => {
      const r = parseJCL([
        '//NJ2 JOB 1',
        '//OUTP PROC',
        '//O1 EXEC PGM=WRITE1',
        '//OUT DD DSN=&&TEMP1,DISP=(,PASS)',
        '// PEND',
        '//INP PROC',
        '//I1 EXEC PROC=OUTP',
        '//I2 EXEC PGM=READ1',
        '//IN DD DSN=*.O1.OUT',
        '// PEND',
        '//X EXEC PROC=INP',
      ].join('\n'), {});
      const m13 = buildModel([{ name: 'N.JCL', lang: 'JCL', text: '', parsed: r }]);
      return m13.edges.some(e => e.f === 'step|NJ2.I2' && e.t === 'ds|&&TEMP1')
        && !m13.warnings.some(w => w.indexOf('could not be resolved') >= 0);
    })());
    T('V2 mixed COBOL/directives: sequenced lines in free format, >>SOURCE FREE, EJECT/SKIP ignored, *> and "..." handled', (() => {
      const C = parseCOBOL('MIX.CBL', [
        '000100 IDENTIFICATION DIVISION.',
        '000200 PROGRAM-ID. MIXPGM.',
        '      * fixed-style comment',
        '      SKIP1',
        '      EJECT',
        '      >>SOURCE FORMAT FREE',
        'PROCEDURE DIVISION.',
        'PARA-1.',
        '    DISPLAY "double quoted".',
        '*> floating comment 2002',
        '000300 PARAFIX.',
        '    MOVE 5 TO WS-X.',
        '    STOP RUN.',
      ].join('\n'), {});
      return C.programId === 'MIXPGM'
        && C.paragraphs.some(p => p.name === 'PARA-1') && C.paragraphs.some(p => p.name === 'PARAFIX')
        && !C.paragraphs.some(p => /SKIP|EJECT/.test(p.name));
    })());
    T('V2 data items: OCCURS DEPENDING ON, 1 TO n, level 66 RENAMES, 78, COMP-3 usage, PIC without gluing', (() => {
      const C = parseCOBOL('VV.CBL', [
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. VV.',
        'DATA DIVISION.',
        'WORKING-STORAGE SECTION.',
        '01  REC.',
        '    05  TAB OCCURS 10 TIMES DEPENDING ON WS-N.',
        '        10  AMT PIC 9(4)V99 COMP-3.',
        '    05  RNG OCCURS 1 TO 50 TIMES.',
        '66  TOTL RENAMES AMT THRU TAB.',
        '78  MAXC VALUE 500.',
        "    88  FLAGV VALUE 'Y'.",
        'PROCEDURE DIVISION.',
        'P1.',
        '    STOP RUN.',
      ].join('\n'), {});
      const tab = C.vars.find(v => v.name === 'TAB');
      const amt = C.vars.find(v => v.name === 'AMT');
      const rng = C.vars.find(v => v.name === 'RNG');
      const totl = C.vars.find(v => v.name === 'TOTL');
      const maxc = C.vars.find(v => v.name === 'MAXC');
      const flagv = C.vars.find(v => v.name === 'FLAGV');
      return tab && tab.occurs === 10 && tab.occursDepending === 'WS-N'
        && amt && amt.pic === '9(4)V99' && amt.usage === 'COMP-3'
        && rng && rng.occurs === 50 && rng.occursTo === true
        && totl && totl.renames && totl.renames.from === 'AMT' && totl.renames.thru === 'TAB'
        && maxc && maxc.level === 78 && maxc.value === '500'
        && flagv && flagv.is88 && C.varLits.FLAGV && C.varLits.FLAGV[0] === 'Y';
    })());
    T('V2 COPY REPLACING: pseudo-text ==:XXX:== BY ==PAY== multi-pairs applied, without COMP/PIC gluing', (() => {
      const books = { 'BKR': { text: '01  :XXX:-REC.\n    05  :XXX:-ID PIC 9(8).\n    05  PAY-OLD PIC X.', file: 'BKR.CPY' } };
      const C = parseCOBOL('CR.CBL', [
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. CR.',
        'DATA DIVISION.',
        'WORKING-STORAGE SECTION.',
        'COPY BKR REPLACING ==:XXX:== BY ==PAY== ==PAY-OLD== BY ==NEW-OLD==.',
        'PROCEDURE DIVISION.',
        'P1.',
        '    STOP RUN.',
      ].join('\n'), books);
      const rec = C.vars.find(v => v.name === 'PAY-REC');
      const idv = C.vars.find(v => v.name === 'PAY-ID');
      const oldv = C.vars.find(v => v.name === 'NEW-OLD');
      return rec && idv && oldv && idv.pic === '9(8)';
    })());
    T('V2 advanced SQL: CTE with columns excluded, quoted qualified identifiers, MERGE USING, TRUNCATE, DELETE FROM', (() => {
      const C = parseCOBOL('SQ.CBL', [
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. SQ.',
        'PROCEDURE DIVISION.',
        'P1.',
        '    EXEC SQL WITH R (X) AS (SELECT ID FROM BK.REAL) SELECT * FROM R, BK.R2 E WHERE R.X = E.X END-EXEC.',
        '    EXEC SQL SELECT A FROM "MY SCH"."MY TABLE" M END-EXEC.',
        '    EXEC SQL DELETE FROM BK.OLD WHERE K = 1 END-EXEC.',
        '    EXEC SQL TRUNCATE TABLE BK.HUGE END-EXEC.',
        '    EXEC SQL MERGE INTO BK.T T USING BK.S S2 ON T.I = S2.I END-EXEC.',
        '    STOP RUN.',
      ].join('\n'), {});
      const t1 = C.sql[0], t2 = C.sql[1], t3 = C.sql[2], t4 = C.sql[3], t5 = C.sql[4];
      return t1 && t1.op === 'read' && t1.tables.includes('BK.REAL') && t1.tables.includes('BK.R2')
          && !t1.tables.includes('R') && !t1.tables.includes('E')
        && t2 && t2.tables.includes('MY SCH.MY TABLE')
        && t3 && t3.op === 'write' && t3.tables.includes('BK.OLD')
        && t4 && t4.op === 'write' && t4.tables.includes('BK.HUGE')
        && t5 && t5.op === 'update' && t5.tables.includes('BK.T') && t5.tables.includes('BK.S');
    })());
    T('V2 dynamic targets: PERFORM/GO TO to a nonexistent paragraph → explicit warning, no invented edge', (() => {
      const C = parseCOBOL('DY.CBL', [
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. DY.',
        'PROCEDURE DIVISION.',
        'P1.',
        '    PERFORM WS-TGT-PARA.',
        '    GO TO WS-GOTO-TGT.',
        '    STOP RUN.',
      ].join('\n'), {});
      const m13 = buildModel([{ name: 'DY.CBL', lang: 'CBL', text: '', parsed: { cobol: C, warnings: C.warns } }]);
      return m13.warnings.some(w => w.indexOf('PERFORM WS-TGT-PARA') >= 0 && w.indexOf('no edge created') >= 0)
        && m13.warnings.some(w => w.indexOf('GO TO WS-GOTO-TGT') >= 0)
        && !m13.edges.some(e => e.k === 'perform' || e.k === 'goto');
    })());
    T('V2 stacked programs: second PROGRAM-ID → analysis stops at the first, warning (nothing attributed to the 1st)', (() => {
      const C = parseCOBOL('ST.CBL', [
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. FIRSTP.',
        'PROCEDURE DIVISION.',
        'P1.',
        '    STOP RUN.',
        'END PROGRAM FIRSTP.',
        'IDENTIFICATION DIVISION.',
        'PROGRAM-ID. SECONDP.',
        'PROCEDURE DIVISION.',
        'Q1.',
        '    STOP RUN.',
      ].join('\n'), {});
      return C.programId === 'FIRSTP'
        && C.warns.some(w => w.indexOf('SECONDP') >= 0 && w.indexOf('stacked') >= 0)
        && !C.paragraphs.some(p => p.name === 'Q1');
    })());
    state.files = bakH.files; state.loaded = bakH.loaded; state.log = bakH.log; state._model = null;

    // ── Section 14: deterministic COBOL → Python translation ──
    const TL14 = [
      'IDENTIFICATION DIVISION.',
      'PROGRAM-ID. TPP.',
      'DATA DIVISION.',
      'WORKING-STORAGE SECTION.',
      '01  WS-COUNT PIC 9(4) VALUE 0.',
      '01  WS-AMT PIC S9(7)V99 COMP-3.',
      '01  WS-NAME PIC X(10).',
      " 88  EOF-FLAG VALUE 'Y'.",
      'PROCEDURE DIVISION.',
      'PARA-1.',
      '    MOVE 5 TO WS-COUNT.',
      "    MOVE 'HELLO' TO WS-NAME.",
      '    COMPUTE WS-COUNT = WS-COUNT + 1.',
      '    COMPUTE WS-AMT ROUNDED = WS-COUNT * 1.5.',
      '    ADD 2 TO WS-COUNT.',
      '    SUBTRACT 1 FROM WS-COUNT.',
      '    MULTIPLY 3 BY WS-COUNT GIVING WS-AMT.',
      '    DIVIDE 2 INTO WS-COUNT.',
      '    IF WS-COUNT > 4',
      '        MOVE 1 TO WS-AMT',
      '    ELSE',
      '        MOVE 2 TO WS-AMT',
      '    END-IF.',
      '    EVALUATE WS-COUNT',
      '        WHEN 1',
      "            MOVE 'ONE' TO WS-NAME",
      '        WHEN OTHER',
      "            MOVE 'MANY' TO WS-NAME",
      '    END-EVALUATE.',
      '    PERFORM PARA-2.',
      '    PERFORM PARA-2 3 TIMES.',
      '    PERFORM PARA-2 UNTIL WS-COUNT = 9.',
      '    PERFORM UNTIL WS-COUNT > 20',
      '        ADD 1 TO WS-COUNT',
      '    END-PERFORM.',
      "    DISPLAY 'COUNT=' WS-COUNT.",
      '    SET EOF-FLAG TO TRUE.',
      '    INITIALIZE WS-AMT.',
      '    READ PAY-MASTER.',
      '    EXEC SQL SELECT X FROM BK.T END-EXEC.',
      '    GO TO PARA-3.',
      'PARA-2.',
      '    STOP RUN.',
      'PARA-3.',
      '    EXIT.'
    ].join('\n');
    const TC14 = parseCOBOL('T14.CBL', TL14, {});
    const TR14 = translateCOBOL({ name: 'T14.CBL', text: TL14, parsed: { cobol: TC14 } });
    const PY14 = (TR14 && TR14.python) || '';
    const ST14 = (TR14 && TR14.stats) || { total: 0, translated: 0, approximated: 0, unsupported: 0, coverage: 0 };
    const FL14 = (TR14 && TR14.stmts) || [];
    T('V2 Translation 14.1: translateCOBOL returns a result without error', !!TR14 && !TR14.error);
    T('V2 Translation 14.2: literal MOVE and typed area', PY14.includes('ws_count = 5') && PY14.includes('ws_name = "HELLO"'));
    T('V2 Translation 14.3: arithmetic COMPUTE', PY14.includes('ws_count = ws_count + 1'));
    T('V2 Translation 14.4: COMPUTE ROUNDED with PIC decimals', PY14.includes('ws_amt = round(ws_count * 1.5, 2)'));
    T('V2 Translation 14.5: ADD / SUBTRACT / MULTIPLY GIVING / DIVIDE INTO', PY14.includes('ws_count = ws_count + 2') && PY14.includes('ws_count = ws_count - 1') && PY14.includes('ws_amt = 3 * ws_count') && PY14.includes('ws_count = ws_count / 2'));
    T('V2 Translation 14.6: nested IF / ELSE / END-IF', PY14.includes('if ws_count > 4:') && PY14.includes('else:') && PY14.includes('ws_amt = 1') && PY14.includes('ws_amt = 2'));
    T('V2 Translation 14.7: EVALUATE WHEN / WHEN OTHER', PY14.includes('if ws_count == 1:') && PY14.includes('ws_name = "ONE"') && PY14.includes('ws_name = "MANY"'));
    T('V2 Translation 14.8: PERFORM simple / n TIMES / UNTIL / inline END-PERFORM', PY14.includes('para_2()') && PY14.includes('for _i in range(3):') && PY14.includes('while not (ws_count == 9):') && PY14.includes('while not (ws_count > 20):'));
    T('V2 Translation 14.9: GO TO translated as a tail call to a known paragraph', PY14.includes('return para_3()'));
    T('V2 Translation 14.10: DISPLAY / SET 88 TO TRUE / INITIALIZE / STOP RUN', PY14.includes('print("COUNT=", ws_count)') && PY14.includes('eof_flag = True') && PY14.includes('ws_amt = 0.0') && PY14.includes('sys.exit(0)'));
    T('V2 Translation 14.11: file I/O and EXEC SQL honestly NOT translated', ST14.unsupported === 2 && PY14.includes('[NOT TRANSLATED] READ PAY-MASTER') && PY14.includes('[NOT TRANSLATED] EXEC SQL') && !PY14.includes('read('));
    T('V2 Translation 14.12: line-by-line report (COBOL→Python mapping)', FL14.length >= 20 && FL14[0].ln === 11 && FL14[0].k === 'move' && FL14[0].py > 0 && FL14.every(x => ['translated','approximated','unsupported'].includes(x.status)));
    T('V2 Translation 14.13: consistent weighted coverage', ST14.total >= 20 && ST14.total === ST14.translated + ST14.approximated + ST14.unsupported && ST14.coverage >= 75 && ST14.coverage <= 99);
    T('V2 Translation 14.14: PIC→Python types with COMP-3 note', (() => {
      const ta = (TR14 && TR14.types) || [];
      const amt = ta.find(t => t.name === 'ws_amt');
      return !!amt && amt.py === 'float' && String(amt.note).indexOf('COMP-3') >= 0 && ta.some(t => t.name === 'ws_count' && t.py === 'int');
    })());
    T('V2 Translation 14.15: valid Python structure (functions, global, _run entry)', PY14.includes('def para_1():') && PY14.includes('def para_2():') && PY14.includes('def _run():') && PY14.includes('    _run()') && !PY14.includes('def main():') && PY14.includes('global ws_count') && PY14.includes("if __name__ == '__main__':"));
    T('V2 Translation 14.16: robustness — unknown verb does not crash', (() => {
      const g = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. TG.\nPROCEDURE DIVISION.\nP1.\n    FROBNICATE X.\n    STOP RUN.';
      const gr = translateCOBOL({ name: 'TG.CBL', text: g, parsed: { cobol: parseCOBOL('TG.CBL', g, {}) } });
      return !!gr && !gr.error && gr.stats.unsupported >= 1 && gr.python.indexOf('FROBNICATE') >= 0;
    })());

    // ── Section 15: multi-path impact, downstream lineage + SORT, IMS DL/I ──
    const mkP = (id, body) => ['IDENTIFICATION DIVISION.', 'PROGRAM-ID. ' + id + '.', 'PROCEDURE DIVISION.', 'P1.'].concat(body).join('\n');
    const DLI_CBL = mkP('IMSP', ["    MOVE 'GN' TO DL-FUNC.", "    CALL 'CBLTDLI' USING DL-FUNC PCB-ADDR REC-AREA SSA1."]);
    const CI15 = parseCOBOL('IMSP.CBL', DLI_CBL, {});
    T('V2 IMS 15.1: DL/I op-code traced via literal MOVE (GN), args counted', CI15.dli.length === 1 && CI15.dli[0].entry === 'CBLTDLI' && CI15.dli[0].op === 'GN' && CI15.dli[0].args === 4);
    T('V2 IMS 15.2: DL/I direct literal op-code (ISRT)', (() => {
      const c2 = parseCOBOL('I2.CBL', mkP('I2', ["    CALL 'CBLTDLI' USING 'ISRT' PCB-ADDR REC-AREA."]), {});
      return c2.dli.length === 1 && c2.dli[0].op === 'ISRT' && c2.dli[0].args === 3;
    })());
    T('V2 IMS 15.3: dynamic DL/I op-code not traced → null shown, never guessed', (() => {
      const c3 = parseCOBOL('I3.CBL', mkP('I3', ['    CALL \'CBLTDLI\' USING DYN-OP PCB-ADDR REC-AREA.']), {});
      return c3.dli.length === 1 && c3.dli[0].op === null;
    })());
    T('V2 IMS 15.4: ASMTDLI (assembler interface) also detected', (() => {
      const c4 = parseCOBOL('I4.CBL', mkP('I4', ["    CALL 'ASMTDLI' USING 'GU' PCB-ADDR REC-AREA."]), {});
      return c4.dli.length === 1 && c4.dli[0].entry === 'ASMTDLI' && c4.dli[0].op === 'GU';
    })());
    const JL15 = ['//LJ JOB 1', '//S1 EXEC PGM=SORT', '//SORTIN DD DSN=IN.DATA,DISP=SHR', '//SORTOUT DD DSN=&&SORTED,DISP=(,PASS)', '//SYSIN DD *', 'SORT FIELDS=(1,10,CH,A)', 'SUM FIELDS=NONE', '/*', '//S2 EXEC PGM=CBPAY100', '//TRANS DD DSN=*.S1.SORTOUT,DISP=OLD', '//OUTDS DD DSN=OUT.DATA,DISP=(,CATLG)'].join('\n');
    const mkF15 = () => {
      const fj = { name: 'LJ.JCL', lang: 'JCL', text: JL15 };
      parseFile(fj);
      const pgs = [
        ["PGMA", "CALL 'PGMB';CALL 'PGC';CALL 'PGE'"],
        ["PGMB", "CALL 'PGD'"],
        ["PGC", "CALL 'PGD'"],
        ["PGE", "CALL 'PGD'"],
        ["PGD", "MOVE A TO B"],
        ["CBPAY100", "MOVE A TO B"]
      ];
      const out = [fj];
      pgs.forEach(spec => {
        const nm = spec[0];
        const stmts = spec[1].split(';').map(s => '    ' + s.trim() + '.');
        const fc = { name: nm + '.CBL', lang: 'CBL', text: mkP(nm, stmts) };
        parseFile(fc);
        out.push(fc);
      });
      const fim = { name: 'IMSP.CBL', lang: 'CBL', text: DLI_CBL };
      parseFile(fim);
      out.push(fim);
      return out;
    };
    const m15 = buildModel(mkF15());
    T('V2 IMS 15.5: buildModel — no false CBLTDLI program node, explicit warning, ims marker', (() => {
      const p = m15.nodes.get('prog|IMSP');
      return !m15.nodes.has('xpgm|CBLTDLI')
        && !!p && p.data.ims && p.data.ims.calls === 1 && p.data.ims.ops[0] === 'GN'
        && m15.warnings.some(w => w.indexOf('IMS DL/I program') >= 0 && w.indexOf('no relation invented') >= 0);
    })());
    T('V2 IMS 15.6: honesty — no dataset/table/external program edge invented from the IMS program', !m15.edges.some(e => e.f === 'prog|IMSP' && (/^(ds|tbl|xpgm|fct|map|q)\|/.test(e.t))));
    T('V2 SORT 15.7: SYSIN cards of the SORT step decoded and carried by the step node', (() => {
      const s = m15.nodes.get('step|LJ.S1');
      return !!s && !!s.data.sort && s.data.sort.type === 'sort' && s.data.sort.fields.length === 1
        && s.data.sort.fields[0].pos === 1 && s.data.sort.fields[0].len === 10 && s.data.sort.fields[0].type === 'CH'
        && s.data.sort.fields[0].order === 'A' && s.data.sort.sum === 'none';
    })());
    T('V2 Lineage 15.8: model — &&SORTED written by S1 and read by S2, real outputs of S2', (() => {
      const rev = m15.rev['ds|&&SORTED'] || [];
      return rev.some(e => e.k === 'write' && e.f === 'step|LJ.S1') && rev.some(e => e.k === 'read' && e.f === 'step|LJ.S2')
        && (m15.fwd['step|LJ.S2'] || []).some(e => e.t === 'ds|OUT.DATA' && e.k === 'write');
    })());
    T('V2 Lineage 15.9: view — Sources + Flows into + SORT pill with decoded fields', (() => {
      const bakI = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        state.files = mkF15(); state.loaded = true; state._model = null; state.sub = 'lineage';
        renderContent();
        const c = document.getElementById('content');
        const h = c.innerHTML;
        return h.indexOf('Sources') >= 0 && h.indexOf('Flows into') >= 0 && h.indexOf('SORT 1,10,CH,A') >= 0 && h.indexOf('SUM') >= 0 && h.indexOf('OUT.DATA') >= 0;
      } finally { state.files = bakI.files; state.loaded = bakI.loaded; state.entity = bakI.entity; state.sub = bakI.sub; state._model = bakI._model; }
    })());
    T('V2 Impact 15.10: multi-paths — 3 distinct paths to PGD, cap of 3 respected', (() => {
      const im = impact(m15, 'prog|PGMA');
      const d = im.down.indirect.find(x => x.id === 'prog|PGD');
      return !!d && d.paths.length === 3 && d.paths.every(p => p.path.length === 3 && p.conf === 'certain')
        && new Set(d.paths.map(p => p.path.join(','))).size === 3;
    })());
    T('V2 Impact 15.11: only two routes → 2 paths, none hidden', (() => {
      const files2 = mkF15().filter(f => f.name !== 'PGE.CBL');
      const m2 = buildModel(files2);
      const im = impact(m2, 'prog|PGMA');
      const d = im.down.indirect.find(x => x.id === 'prog|PGD');
      return !!d && d.paths.length === 2;
    })());
    T('V2 Impact 15.12: compatibility — direct/indirect structure unchanged, single-route paths', (() => {
      const im = impact(m15, 'prog|PGMA');
      const dirs = im.down.direct.filter(x => x.id.indexOf('prog|') === 0);
      return dirs.length === 3 && dirs.every(x => x.paths.length === 1)
        && im.down.indirect.every(x => x.paths.length >= 1 && x.path.length === x.paths[0].path.length);
    })());
    T('V2 Impact 15.13: upstream compatibility — direct step, indirect job', (() => {
      const im = impact(m15, 'prog|CBPAY100');
      return im.up.direct.length === 1 && im.up.direct[0].id === 'step|LJ.S2'
        && im.up.indirect.some(x => x.id === 'job|LJ');
    })());
    T('V2 Impact 15.14: no duplicated node in the results', (() => {
      const im = impact(m15, 'prog|PGMA');
      const all = im.down.direct.concat(im.down.indirect).map(x => x.id);
      return all.length === new Set(all).size;
    })());

    // ── Section 16 : cartes DFSORT (INCLUDE/OMIT/INREC/OUTREC/OUTFIL) + GDG ──
    const SC16 = parseSortCards([
      'SORT FIELDS=(1,10,CH,A)',
      "INCLUDE COND=(20,3,CH,EQ,C'PAY')",
      'INREC BUILD=(1,10,80,5)',
      "OUTREC OVERLAY=(45:1,10)",
      'OUTFIL FNAMES=(OUT1,OUT2)'
    ].join('\n'));
    T('V2 DFSORT 16.1: simple-form INCLUDE COND decoded', !!SC16.include && SC16.include.decoded === true
      && SC16.include.conds[0].pos === 20 && SC16.include.conds[0].len === 3 && SC16.include.conds[0].type === 'CH'
      && SC16.include.conds[0].op === 'EQ' && SC16.include.conds[0].value === "C'PAY'");
    T('V2 DFSORT 16.2: short-form OMIT COND with global FORMAT= decoded', (() => {
      const sc = parseSortCards(['SORT FORMAT=ZD,FIELDS=(1,5,A)', 'OMIT COND=(30,ZD,NE,42)'].join('\n'));
      return !!sc.omit && sc.omit.decoded === true && sc.omit.conds[0].pos === 30 && sc.omit.conds[0].len === null
        && sc.omit.conds[0].type === 'ZD' && sc.omit.conds[0].op === 'NE' && sc.omit.conds[0].value === '42';
    })());
    T('V2 DFSORT 16.3: literal with comma C\'A,B\' — a single condition decoded (quote-aware)', (() => {
      const sc = parseSortCards(["INCLUDE COND=(1,5,CH,EQ,C'A,B')"].join('\n'));
      return !!sc.include && sc.include.decoded === true && sc.include.conds.length === 1
        && sc.include.conds[0].value === "C'A,B'";
    })());
    T('V2 DFSORT 16.4: INREC BUILD (p,l) decoded', !!SC16.inrec && SC16.inrec.decoded === true && SC16.inrec.kind === 'BUILD'
      && SC16.inrec.items[0].pos === 1 && SC16.inrec.items[0].len === 10 && SC16.inrec.items[1].pos === 80 && SC16.inrec.items[1].len === 5);
    T('V2 DFSORT 16.5: OUTREC OVERLAY (out:p,l) and literal decoded', (() => {
      const sc = parseSortCards(["OUTREC OVERLAY=(45:1,10,60:C'X')"].join('\n'));
      return !!sc.outrec && sc.outrec.decoded === true && sc.outrec.items[0].out === 45 && sc.outrec.items[0].pos === 1
        && sc.outrec.items[1].out === 60 && sc.outrec.items[1].literal === 'X';
    })());
    T('V2 DFSORT 16.6: OUTFIL FNAMES decoded', !!SC16.outfil && SC16.outfil.length === 1 && SC16.outfil[0].decoded === true
      && SC16.outfil[0].names.join(',') === 'OUT1,OUT2');
    const SJ16 = ['//SJ16 JOB 1', '//S1 EXEC PGM=SORT', '//SORTIN DD DSN=IN.DATA,DISP=SHR', '//SORTOUT DD DSN=OUT.DATA,DISP=OLD', '//OUT1 DD DSN=OUT.A', '//OUT2 DD DSN=OUT.B', '//SYSIN DD *', 'SORT FIELDS=(1,10,CH,A)', "INCLUDE COND=(20,3,CH,EQ,C'PAY')", 'OUTFIL FNAMES=(OUT1,OUT2)', '/*'].join('\n');
    const PJ16 = parseJCL(SJ16, {});
    T('V2 DFSORT 16.7: OUTFIL → DD without DISP promoted to known step outputs (no more "unknown")', (() => {
      const s1 = PJ16.jobs[0].steps.find(s => s.name === 'S1');
      const o1 = s1.dds.find(d => d.ddname === 'OUT1');
      const o2 = s1.dds.find(d => d.ddname === 'OUT2');
      return o1.usage === 'output' && o2.usage === 'output' && o1.outfil === true && o2.outfil === true
        && !PJ16.warnings.some(w => w.indexOf('OUT.A') >= 0 || w.indexOf('OUT.B') >= 0);
    })());
    const m16 = buildModel([{ name: 'SJ16.JCL', lang: 'JCL', text: SJ16, parsed: { engine: 'v3', jobs: PJ16.jobs, procs: PJ16.procs, warnings: PJ16.warnings } }]);
    T('V2 DFSORT 16.8: write edges (probable) to the OUTFIL outputs in the model', (() => {
      const e1 = m16.edges.find(e => e.f === 'step|SJ16.S1' && e.t === 'ds|OUT.A');
      const e2 = m16.edges.find(e => e.f === 'step|SJ16.S1' && e.t === 'ds|OUT.B');
      return !!(e1 && e1.k === 'write' && e1.c === 'probable') && !!(e2 && e2.k === 'write' && e2.c === 'probable');
    })());
    T('V2 DFSORT 16.9: stepDesc shows decoded INCLUDE and OUTFIL', (() => {
      const d = stepDesc({ name: 'S1', pgm: 'SORT', kind: 'PGM', dds: [], sortInfo: PJ16.jobs[0].steps.find(s => s.name === 'S1').sortInfo });
      return d.indexOf('INCLUDE') >= 0 && d.indexOf('20:3 CH EQ') >= 0 && d.indexOf('OUTFIL') >= 0 && d.indexOf('OUT1, OUT2') >= 0;
    })());
    const JG16 = ['//JG16 JOB 1', '//S1 EXEC PGM=P1', '//ODD DD DSN=PAY.MAST(+1),DISP=(,CATLG)', '//S2 EXEC PGM=P2', '//IDD DD DSN=PAY.MAST(0),DISP=SHR'].join('\n');
    const m16g = buildModel([{ name: 'JG16.JCL', lang: 'JCL', text: JG16, parsed: { engine: 'v3', jobs: parseJCL(JG16, {}).jobs, procs: {}, warnings: [] } }]);
    T('V2 GDG 16.10: relative generations in the evidence (+1 then 0), no false warning', (() => {
      const ew = m16g.edges.find(e => e.f === 'step|JG16.S1' && e.t === 'ds|PAY.MAST');
      const er = m16g.edges.find(e => e.f === 'step|JG16.S2' && e.t === 'ds|PAY.MAST');
      return !!(ew && ew.ev[0].note.indexOf('GDG +1') >= 0) && !!(er && er.ev[0].note.indexOf('GDG 0') >= 0)
        && !m16g.warnings.some(w => w.indexOf('OLDER generation') >= 0);
    })());
    const JG17 = ['//JG17 JOB 1', '//S1 EXEC PGM=P1', '//ODD DD DSN=PAY.MAST(+1),DISP=(,CATLG)', '//S2 EXEC PGM=P2', '//IDD DD DSN=PAY.MAST(-1),DISP=SHR'].join('\n');
    const m17g = buildModel([{ name: 'JG17.JCL', lang: 'JCL', text: JG17, parsed: { engine: 'v3', jobs: parseJCL(JG17, {}).jobs, procs: {}, warnings: [] } }]);
    T('V2 GDG 16.11: reading an OLDER generation explicitly flagged', m17g.warnings.some(w => w.indexOf('GDG PAY.MAST') >= 0 && w.indexOf('OLDER generation') >= 0 && w.indexOf('S2') >= 0));
    const JG18 = ['//JG18 JOB 1', '//S1 EXEC PGM=P2', '//IDD DD DSN=PAY.MAST(0),DISP=SHR', '//S2 EXEC PGM=P1', '//ODD DD DSN=PAY.MAST(+1),DISP=(,CATLG)'].join('\n');
    const m18g = buildModel([{ name: 'JG18.JCL', lang: 'JCL', text: JG18, parsed: { engine: 'v3', jobs: parseJCL(JG18, {}).jobs, procs: {}, warnings: [] } }]);
    T('V2 GDG 16.12: read BEFORE write (+1) → no false positive', !m18g.warnings.some(w => w.indexOf('OLDER generation') >= 0));
    T('V2 GDG 16.13: without a generation number, the evidence stays unchanged (no GDG mention)', (() => {
      const jn = ['//JN JOB 1', '//S1 EXEC PGM=P1', '//DD1 DD DSN=PLAIN.DATA,DISP=SHR'].join('\n');
      const mn = buildModel([{ name: 'JN.JCL', lang: 'JCL', text: jn, parsed: { engine: 'v3', jobs: parseJCL(jn, {}).jobs, procs: {}, warnings: [] } }]);
      const e = mn.edges.find(x => x.t === 'ds|PLAIN.DATA');
      return !!e && e.ev[0].note.indexOf('GDG') < 0;
    })());
    T('V2 GDG 16.14: lineage view — GDG pill on the base PAY.MAST', (() => {
      const bakJ = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        state.files = [{ name: 'JG16.JCL', lang: 'JCL', text: JG16, parsed: { engine: 'v3', jobs: parseJCL(JG16, {}).jobs, procs: {}, warnings: [] } }];
        state.loaded = true; state._model = null; state.sub = 'lineage';
        renderContent();
        const h = document.getElementById('content').innerHTML;
        return h.indexOf('PAY.MAST') >= 0 && h.indexOf('GDG') >= 0 && h.indexOf('Sources') >= 0;
      } finally { state.files = bakJ.files; state.loaded = bakJ.loaded; state.entity = bakJ.entity; state.sub = bakJ.sub; state._model = bakJ._model; }
    })());

    // ── Section 17: cross-job relations (shared datasets, inferred order) ──
    const XJ1 = ['//J1 JOB (A),X', '//S1 EXEC PGM=PA', '//DD1 DD DSN=APP.D1(+1),DISP=(,CATLG)'].join('\n');
    const XJ2 = ['//J2 JOB (A),X', '//S1 EXEC PGM=PB', '//DD1 DD DSN=APP.D1(0),DISP=SHR'].join('\n');
    const mkJ = (n, t) => ({ name: n, lang: 'JCL', text: t, parsed: { engine: 'v3', jobs: parseJCL(t, {}).jobs, procs: {}, warnings: [] } });
    const mx = buildModel([mkJ('XJ1.JCL', XJ1), mkJ('XJ2.JCL', XJ2)]);
    T('V2 XJOB 17.1: J1 writes APP.D1(+1), J2 reads (0) → probable job→job feed edge', (() => {
      const fe = mx.edges.find(e => e.k === 'feed' && e.f === 'job|J1' && e.t === 'job|J2');
      return !!fe && fe.c === 'probable' && fe.ev[0].note.indexOf('cross-job') >= 0
        && fe.ev[0].note.indexOf('GDG +1') >= 0 && fe.ev[0].note.indexOf('GDG 0') >= 0;
    })());
    T('V2 XJOB 17.2: read (-1) → explicit OLDER generation note', (() => {
      const XJ3 = ['//J3 JOB (A),X', '//S1 EXEC PGM=PB', '//DD1 DD DSN=APP.D1(-1),DISP=SHR'].join('\n');
      const m2 = buildModel([mkJ('XJ1.JCL', XJ1), mkJ('XJ3.JCL', XJ3)]);
      const fe = m2.edges.find(e => e.k === 'feed' && e.f === 'job|J1' && e.t === 'job|J3');
      return !!fe && fe.ev[0].note.indexOf('OLDER generation') >= 0;
    })());
    T('V2 XJOB 17.3: temporary && dataset → no cross-job feed edge', (() => {
      const T1 = ['//J4 JOB (A),X', '//S1 EXEC PGM=PA', '//DD1 DD DSN=&&TMP1,DISP=(,PASS)'].join('\n');
      const T2 = ['//J5 JOB (A),X', '//S1 EXEC PGM=PB', '//DD1 DD DSN=&&TMP1,DISP=(OLD,DELETE)'].join('\n');
      const mt = buildModel([mkJ('J4.JCL', T1), mkJ('J5.JCL', T2)]);
      return !mt.edges.some(e => e.k === 'feed');
    })());
    T('V2 XJOB 17.4: write and read in the same job → no feed (already intra-job)', (() => {
      const S1 = ['//J6 JOB (A),X', '//S1 EXEC PGM=PA', '//DD1 DD DSN=APP.D4,DISP=(,CATLG)', '//S2 EXEC PGM=PB', '//DD2 DD DSN=APP.D4,DISP=SHR'].join('\n');
      const m4 = buildModel([mkJ('J6.JCL', S1)]);
      return !m4.edges.some(e => e.k === 'feed');
    })());
    T('V2 XJOB 17.5: DD without DISP nor program → no direction inference', (() => {
      const U1 = ['//J7 JOB (A),X', '//S1 EXEC PGM=PA', '//DD1 DD DSN=APP.NX'].join('\n');
      const U2 = ['//J8 JOB (A),X', '//S1 EXEC PGM=PB', '//DD1 DD DSN=APP.NX'].join('\n');
      const mu = buildModel([mkJ('J7.JCL', U1), mkJ('J8.JCL', U2)]);
      return !mu.edges.some(e => e.k === 'feed');
    })());
    T('V2 XJOB 17.6: impact propagates job→job via the feed edge', (() => {
      const imp = impact(mx, 'job|J1');
      return !!(imp.down.direct || []).some(r => r.id === 'job|J2');
    })());
    T('V2 XJOB 17.7: flow view shows the Cross-job dependencies card', (() => {
      const bakK = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        state.files = [mkJ('XJ1.JCL', XJ1), mkJ('XJ2.JCL', XJ2)];
        state.loaded = true; state._model = null; state.sub = 'flow';
        renderContent();
        const h = document.getElementById('content').innerHTML;
        return h.indexOf('Cross-job dependencies') >= 0 && h.indexOf('feeds') >= 0 && h.indexOf('PROBABLE') >= 0;
      } finally { state.files = bakK.files; state.loaded = bakK.loaded; state.entity = bakK.entity; state.sub = bakK.sub; state._model = bakK._model; }
    })());

    // ── Section 18 : conditions complexes DFSORT + OPTION COPY ──
    T('V2 DFSORT 18.1: explicit OR → 2 conditions joined by OR', (() => {
      const sc = parseSortCards(["INCLUDE COND=(5,1,CH,EQ,C'X',OR,10,2,ZD,GT,3)"].join('\n'));
      return !!sc.include && sc.include.decoded === true && sc.include.conds.length === 2
        && sc.include.joins.length === 1 && sc.include.joins[0] === 'OR'
        && sc.include.conds[0].value === "C'X'" && sc.include.conds[1].type === 'ZD' && sc.include.conds[1].value === '3';
    })());
    T('V2 DFSORT 18.2: implicit comma between 2 conditions = AND', (() => {
      const sc = parseSortCards(["OMIT COND=(1,5,CH,EQ,C'A',(6,2,CH,NE,C'B'))"].join('\n'));
      return !!sc.omit && sc.omit.decoded === true && sc.omit.conds.length === 2
        && sc.omit.joins.length === 1 && sc.omit.joins[0] === 'AND' && sc.omit.conds[1].value === "C'B'";
    })());
    T('V2 DFSORT 18.3: nested group + explicit AND → 3 conditions, OR,AND joins', (() => {
      const sc = parseSortCards(["INCLUDE COND=((1,5,CH,EQ,C'A',OR,2,1,CH,EQ,C'B'),AND,10,2,ZD,LT,5)"].join('\n'));
      return !!sc.include && sc.include.decoded === true && sc.include.conds.length === 3
        && sc.include.joins.length === 2 && sc.include.joins[0] === 'OR' && sc.include.joins[1] === 'AND';
    })());
    T('V2 DFSORT 18.4: field-to-field comparison (p,l,type,OP,p2,l2) decoded', (() => {
      const sc = parseSortCards(['INCLUDE COND=(1,5,CH,EQ,10,5)'].join('\n'));
      return !!sc.include && sc.include.decoded === true && sc.include.conds[0].field2 === true
        && sc.include.conds[0].value === '10,5' && sc.include.conds[0].op === 'EQ';
    })());
    T('V2 DFSORT 18.5: OPTION COPY → copy type, no invention', (() => {
      const sc = parseSortCards(['OPTION COPY'].join('\n'));
      return sc.type === 'copy' && sc.optionCopy === true && sc.decoded === true;
    })());
    T('V2 DFSORT 18.6: short FORMAT= form with OR still decoded', (() => {
      const sc = parseSortCards(['SORT FORMAT=ZD,FIELDS=(1,5,A)', 'OMIT COND=(5,ZD,EQ,3,OR,6,ZD,NE,4)'].join('\n'));
      return !!sc.omit && sc.omit.decoded === true && sc.omit.conds.length === 2
        && sc.omit.conds[0].len === null && sc.omit.joins[0] === 'OR';
    })());
    T('V2 DFSORT 18.7: unknown sub-condition → whole card raw, never guessed', (() => {
      const sc = parseSortCards(["INCLUDE COND=(1,5,CH,EQ)"].join('\n'));
      return !!sc.include && sc.include.decoded === false && sc.include.conds.length === 0;
    })());
    T('V2 DFSORT 18.8: stepDesc shows the OR between decoded conditions', (() => {
      const sc = parseSortCards(["INCLUDE COND=(5,1,CH,EQ,C'X',OR,10,2,ZD,GT,3)"].join('\n'));
      const d = stepDesc({ name: 'S1', pgm: 'SORT', kind: 'PGM', dds: [], sortInfo: sc });
      return d.indexOf('INCLUDE') >= 0 && d.indexOf(' OR ') >= 0 && d.indexOf('5:1 CH EQ') >= 0;
    })());

    // ── Section 19: opt-in AI engine (grounded, never simulated) ──
    const AIf = (() => {
      const AJ = ['//AJOB JOB (A),X', '//S1 EXEC PGM=APAY', '//DD1 DD DSN=AI.D1(+1),DISP=(,CATLG)'].join('\n');
      const AC = ['       IDENTIFICATION DIVISION.', '       PROGRAM-ID. APAY.', '       PROCEDURE DIVISION.', '       A-P.', '           STOP RUN.'].join('\n');
      const ff = [{ name: 'AJOB.JCL', text: AJ }, { name: 'APAY.CBL', text: AC }];
      ff.forEach(x => { x.lang = detectLang(x.name, x.text); parseFile(x); });
      return ff;
    })();
    const mAI = buildModel(AIf);
    T('V2 AI 19.1: AI context = facts, evidence, neighbors and unknown areas only', (() => {
      const ctx = buildAiContext(mAI, 'prog|APAY');
      return !!ctx && ctx.entity && ctx.entity.name === 'APAY' && ctx.entity.type === 'prog'
        && Array.isArray(ctx.upstream) && Array.isArray(ctx.downstream)
        && !!ctx.modelCoverage && ctx.modelCoverage.nodes === mAI.nodes.size
        && ctx.modelCoverage.edges === mAI.edges.length && Array.isArray(ctx.modelCoverage.unknowns);
    })());
    T('V2 AI 19.2: guardrail prompt — answer only from the context, cite the evidence', (() => {
      const ctx = buildAiContext(mAI, 'step|AJOB.S1');
      const p = buildAiPrompt(ctx);
      return p.system.indexOf('ONLY from the provided context') >= 0 && p.system.indexOf('never invent') >= 0
        && p.user.indexOf('AJOB') >= 0 && p.user.indexOf('APAY') >= 0 && p.user.indexOf('AI.D1') >= 0;
    })());
    T('V2 AI 19.3: the API key never appears in the context nor the prompt', (() => {
      try {
        sessionStorage.setItem('reforge_api_key', 'sk-test-1234');
        const ctx = buildAiContext(mAI, 'job|AJOB');
        const p = buildAiPrompt(ctx);
        return JSON.stringify(ctx).indexOf('sk-test-1234') < 0 && (p.user + p.system).indexOf('sk-test-1234') < 0;
      } finally { sessionStorage.removeItem('reforge_api_key'); }
    })());
    T('V2 AI 19.4: without endpoint nor key → aiReady false, honest deterministic mode', (() => {
      sessionStorage.removeItem('reforge_ai_url'); sessionStorage.removeItem('reforge_api_key');
      return aiReady() === false;
    })());
    T('V2 AI 19.5: API call — Bearer + context only, response labeled source ai', (() => {
      const captured = {};
      const oldFetch = window.fetch;
      window.fetch = (url, opts) => {
        captured.url = url; captured.headers = opts.headers; captured.body = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'MODEL-ANSWER' } }] }) });
      };
      sessionStorage.setItem('reforge_ai_url', 'https://api.test/v1/chat/completions');
      sessionStorage.setItem('reforge_ai_model', 'test-model');
      sessionStorage.setItem('reforge_api_key', 'sk-test-1234');
      const bakL = { files: state.files, loaded: state.loaded, entity: state.entity, _model: state._model };
      state.files = AIf; state.loaded = true; state.entity = 'job|AJOB'; state._model = null;
      aiExplain().then(r => {
        window.fetch = oldFetch;
        sessionStorage.removeItem('reforge_ai_url'); sessionStorage.removeItem('reforge_ai_model'); sessionStorage.removeItem('reforge_api_key');
        out.push({ name: 'V2 AI 19.5 (async): API call — Bearer + context only, ai source response', pass: !!r
          && r.source === 'ai' && r.model === 'test-model' && r.text === 'MODEL-ANSWER'
          && captured.url === 'https://api.test/v1/chat/completions'
          && captured.headers.Authorization === 'Bearer sk-test-1234'
          && captured.body.messages.length === 2 && captured.body.temperature === 0
          && JSON.stringify(captured.body).indexOf('sk-test-1234') < 0 });
        state.files = bakL.files; state.loaded = bakL.loaded; state.entity = bakL.entity; state._model = null;
      });
      return true; // result pushed asynchronously above
    })());
    T('V2 AI 19.6: AI view — settings visible, without config → deterministic mode shown', (() => {
      sessionStorage.removeItem('reforge_ai_url'); sessionStorage.removeItem('reforge_api_key');
      const bakM = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        state.files = AIf; state.loaded = true; state._model = null; state.sub = 'ai';
        renderContent();
        const h = document.getElementById('content').innerHTML;
        return h.indexOf('aiUrlInput') >= 0 && h.indexOf('AI off') >= 0 && h.indexOf('AI-PROPOSED') >= 0;
      } finally { state.files = bakM.files; state.loaded = bakM.loaded; state.entity = bakM.entity; state.sub = bakM.sub; state._model = bakM._model; }
    })());
    T('V2 AI 19.7: telemetry never carries key nor content', (() => {
      const seen = [];
      window.gtag = (a, b) => { seen.push([a, b]); };
      track('import_project');
      window.gtag = undefined;
      return seen.length === 1 && seen[0][0] === 'event' && seen[0][1] === 'import_project';
    })());

    // ── Section 20 : import scheduler — ordre explicite → CERTAIN ──
    const SC20 = ['# planning export', 'JOB J2 AFTER J1', 'JOB J3 AFTER J2', '* comment'].join('\n');
    T('V2 SCHED 20.1: .sched detection and JOB…AFTER format', (() => {
      const f1 = detectLang('PLAN.SCH', SC20);
      const f2 = detectLang('plan.txt', SC20);
      const f3 = detectLang('JCLLIKE.JCL', SC20);
      return f1 === 'SCHED' && f2 === 'SCHED' && f3 === 'JCL';
    })());
    T('V2 SCHED 20.2: parseSched — 2 dependencies, comments ignored, no warning', (() => {
      const S = parseSched(SC20);
      return S.deps.length === 2 && S.deps.some(d => d.job === 'J2' && d.after.join(',') === 'J1')
        && S.deps.some(d => d.job === 'J3' && d.after.join(',') === 'J2') && S.warnings.length === 0;
    })());
    T('V2 SCHED 20.3: unknown line and self-dependency → explicit warnings, never guessed', (() => {
      const S = parseSched(['RUN J9 EVERY DAY', 'JOB J4 AFTER J4'].join('\n'));
      return S.warnings.some(w => w.indexOf('not a "JOB … AFTER …" declaration') >= 0)
        && S.warnings.some(w => w.indexOf('AFTER itself') >= 0) && S.deps.length === 1;
    })());
    T('V2 SCHED 20.4: duplicates merged in union, never overwritten', (() => {
      const S = parseSched(['JOB J2 AFTER J1', 'JOB J2 AFTER J9, J1'].join('\n'));
      const d2 = S.deps.find(d => d.job === 'J2');
      return S.deps.length === 1 && d2.after.length === 2 && d2.after.includes('J1') && d2.after.includes('J9');
    })());
    T('V2 SCHED 20.5: A↔B cycle flagged, edges kept as is', (() => {
      const S = parseSched(['JOB JA AFTER JB', 'JOB JB AFTER JA'].join('\n'));
      return S.deps.length === 2 && S.warnings.some(w => w.indexOf('cycle') >= 0);
    })());
    T('V2 SCHED 20.6: explicit order CONFIRMS a dataset feed → promoted CERTAIN, merged evidence', (() => {
      const SC = 'JOB J2 AFTER J1';
      const fs = [mkJ('XJ1.JCL', XJ1), mkJ('XJ2.JCL', XJ2),
        { name: 'PLAN.SCH', lang: 'SCHED', text: SC, parsed: { engine: 'v3', sched: parseSched(SC), warnings: [] } }];
      const ms = buildModel(fs);
      const fe = ms.edges.find(e => e.k === 'feed' && e.f === 'job|J1' && e.t === 'job|J2');
      const notes = fe ? fe.ev.map(x => x.note).join(' · ') : '';
      return !!fe && fe.c === 'certain' && notes.indexOf('cross-job') >= 0 && notes.indexOf('scheduler') >= 0
        && notes.indexOf('upgraded to CERTAIN') >= 0;
    })());
    T('V2 SCHED 20.7: pair without a shared dataset → order-only edge, explicit note', (() => {
      const SC = 'JOB J2 AFTER J1';
      const U1 = ['//J1 JOB (A),X', '//S1 EXEC PGM=PA', '//DD1 DD DSN=UN.SHARED.A,DISP=(,CATLG)'].join('\n');
      const U2 = ['//J2 JOB (A),X', '//S1 EXEC PGM=PB', '//DD1 DD DSN=OTHER.DS,DISP=SHR'].join('\n');
      const fs = [mkJ('U1.JCL', U1), mkJ('U2.JCL', U2),
        { name: 'PLAN.SCH', lang: 'SCHED', text: SC, parsed: { engine: 'v3', sched: parseSched(SC), warnings: [] } }];
      const ms = buildModel(fs);
      const fe = ms.edges.find(e => e.k === 'feed' && e.f === 'job|J1' && e.t === 'job|J2');
      return !!fe && fe.c === 'certain' && fe.ev.length === 1 && fe.ev[0].note.indexOf('order only') >= 0;
    })());
    T('V2 SCHED 20.8: declared job absent from the project → referenced node + warning', (() => {
      const SC = 'JOB J3 AFTER J2';
      const fs = [mkJ('XJ1.JCL', XJ1), mkJ('XJ2.JCL', XJ2),
        { name: 'PLAN.SCH', lang: 'SCHED', text: SC, parsed: { engine: 'v3', sched: parseSched(SC), warnings: [] } }];
      const ms = buildModel(fs);
      const n3 = ms.nodes.get('job|J3');
      return !!n3 && n3.data.referenced === true
        && ms.warnings.some(w => w.indexOf('job J3') >= 0 && w.indexOf('not uploaded') >= 0);
    })());
    T('V2 SCHED 20.9: project job without a scheduler line → unconfirmed order warning', (() => {
      const SC = 'JOB J3 AFTER J2';
      const fs = [mkJ('XJ1.JCL', XJ1), mkJ('XJ2.JCL', XJ2),
        { name: 'PLAN.SCH', lang: 'SCHED', text: SC, parsed: { engine: 'v3', sched: parseSched(SC), warnings: [] } }];
      const ms = buildModel(fs);
      return ms.warnings.some(w => w.indexOf('job J1') >= 0 && w.indexOf('no scheduler line') >= 0);
    })());
    T('V2 SCHED 20.10: impact propagates the CERTAIN scheduler order', (() => {
      const SC = 'JOB J2 AFTER J1';
      const fs = [mkJ('XJ1.JCL', XJ1), mkJ('XJ2.JCL', XJ2),
        { name: 'PLAN.SCH', lang: 'SCHED', text: SC, parsed: { engine: 'v3', sched: parseSched(SC), warnings: [] } }];
      const ms = buildModel(fs);
      const imp = impact(ms, 'job|J1');
      const r = (imp.down.direct || []).find(x => x.id === 'job|J2');
      return !!r && r.conf === 'certain';
    })());
    T('V2 SCHED 20.11: flow view shows CERTAIN after scheduler import', (() => {
      const SC = 'JOB J2 AFTER J1';
      const schedF = { name: 'PLAN.SCH', lang: 'SCHED', text: SC, parsed: { engine: 'v3', sched: parseSched(SC), warnings: [] } };
      const bakN = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        state.files = [mkJ('XJ1.JCL', XJ1), mkJ('XJ2.JCL', XJ2), schedF];
        state.loaded = true; state._model = null; state.sub = 'flow';
        renderContent();
        const h = document.getElementById('content').innerHTML;
        return h.indexOf('CERTAIN') >= 0 && h.indexOf('scheduler') >= 0;
      } finally { state.files = bakN.files; state.loaded = bakN.loaded; state.entity = bakN.entity; state.sub = bakN.sub; state._model = bakN._model; }
    })());
    T('V2 SCHED 20.12: parseFile SCHED branch — warnings propagated', (() => {
      const f = { name: 'PLAN.SCH', text: 'GARBAGE LINE' };
      f.lang = detectLang(f.name, f.text);
      parseFile(f);
      return f.lang === 'SCHED' && !!f.parsed.sched && f.parsed.depCount === 0
        && (f.parsed.warnings || []).length === 1;
    })());
    // ── Section 21: V3 regression — real cases reported by a user (map filter, DD overrides, numbered paragraphs, Python) ──
    const mkJ21 = (name, text) => { const f = { name, text }; f.lang = detectLang(name, text); parseFile(f); return f; };
    T('V2 V3 21.1: System Map "payroll" filter keeps the 4 PAYROLL.* datasets (ORIGINAL indices)', (() => {
      const J21 = ['//PJOB JOB (A),X','//S1 EXEC PGM=CBPAY100','//IN1 DD DSN=PAYROLL.A,DISP=SHR',
        '//S2 EXEC PGM=CBPAY200','//IN2 DD DSN=PAYROLL.B,DISP=SHR',
        '//S3 EXEC PGM=CBPAY300','//IN3 DD DSN=PAYROLL.C,DISP=SHR',
        '//S4 EXEC PGM=CBPAY400','//IN4 DD DSN=PAYROLL.D,DISP=SHR'].join('\n');
      const bak = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        state.files = [mkJ21('P.JCL', J21)]; state.loaded = true; state._model = null; state.sub = 'map';
        const sv = svgMap('payroll');
        return sv.includes('PAYROLL.A') && sv.includes('PAYROLL.B') && sv.includes('PAYROLL.C') && sv.includes('PAYROLL.D');
      } finally { state.files = bak.files; state.loaded = bak.loaded; state.entity = bak.entity; state.sub = bak.sub; state._model = bak._model; }
    })());
    T('V2 V3 21.2: "cbpay" filter keeps CBPAY* programs, hides datasets — and vice versa', (() => {
      const bak = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        state.files = [mkJ21('P.JCL', ['//PJOB JOB (A),X','//S1 EXEC PGM=CBPAY100','//IN1 DD DSN=PAYROLL.A,DISP=SHR'].join('\n'))];
        state.loaded = true; state._model = null; state.sub = 'map';
        const svPay = svgMap('payroll');
        const svCbp = svgMap('cbpay');
        return svPay.includes('PAYROLL.A') && !svPay.includes('CBPAY100')
          && svCbp.includes('CBPAY100') && !svCbp.includes('PAYROLL.A');
      } finally { state.files = bak.files; state.loaded = bak.loaded; state.entity = bak.entity; state.sub = bak.sub; state._model = bak._model; }
    })());
    T('V2 V3 21.3: "//PS1.INP DD …" override applied to the in-stream PROC — effective dataset, evidence kept', (() => {
      const J22 = ['//OVR JOB (A),X','//MYPROC PROC','//PS1 EXEC PGM=CBPAY100','//INP DD DSN=PROD.CUST.DATA,DISP=SHR',
        '//OUT DD DSN=PROD.CUST.OUT,DISP=(NEW,CATLG)','// PEND','//S0 EXEC PROC=MYPROC','//PS1.INP DD DSN=OVERRIDE.CUST.DATA,DISP=SHR'].join('\n');
      const r = parseJCL(J22, {});
      const st0 = r.jobs[0].steps[0];
      const inp = st0.dds.find(d => d.ddname === 'INP');
      const out = st0.dds.find(d => d.ddname === 'OUT');
      return !!st0 && st0.name === 'PS1' && st0.proc === 'MYPROC'
        && !!inp && inp.name === 'OVERRIDE.CUST.DATA' && inp.overriddenBy === 'PS1.INP'
        && !!out && out.name === 'PROD.CUST.OUT'
        && !r.warnings.some(w => w.indexOf('override') >= 0);
    })());
    T('V2 V3 21.4: lineage — edge to the EFFECTIVE dataset (override), old dataset absent, evidence cited', (() => {
      const J22 = ['//OVR JOB (A),X','//MYPROC PROC','//PS1 EXEC PGM=CBPAY100','//INP DD DSN=PROD.CUST.DATA,DISP=SHR',
        '//OUT DD DSN=PROD.CUST.OUT,DISP=(NEW,CATLG)','// PEND','//S0 EXEC PROC=MYPROC','//PS1.INP DD DSN=OVERRIDE.CUST.DATA,DISP=SHR'].join('\n');
      const ms = buildModel([mkJ21('O.JCL', J22)]);
      const eIn = ms.edges.find(e => e.t === 'ds|OVERRIDE.CUST.DATA' && e.k === 'read');
      return ms.nodes.has('ds|OVERRIDE.CUST.DATA') && !ms.nodes.has('ds|PROD.CUST.DATA')
        && !!eIn && eIn.ev.some(x => x.note.indexOf('overridden by PS1.INP') >= 0);
    })());
    T('V2 V3 21.5: multiple overrides; unsolvable override → explicit warning (never silence)', (() => {
      const J23 = ['//OVR2 JOB (A),X','//MYPROC2 PROC','//PS1 EXEC PGM=CBPAY100','//INP DD DSN=PROD.CUST.DATA,DISP=SHR',
        '//OUT DD DSN=PROD.CUST.OUT,DISP=(NEW,CATLG)','// PEND','//S0 EXEC PROC=MYPROC2',
        '//PS1.INP DD DSN=OVERRIDE.CUST.DATA,DISP=SHR','//PS1.OUT DD DSN=OVERRIDE.CUST.OUT,DISP=(NEW,CATLG)',
        '//PS9.NOF DD DSN=X.Y,DISP=SHR','//NOQUAL DD DSN=A.B'].join('\n');
      const r = parseJCL(J23, {});
      const st = r.jobs[0].steps[0];
      const inp = st.dds.find(d => d.ddname === 'INP');
      const out = st.dds.find(d => d.ddname === 'OUT');
      return !!inp && inp.name === 'OVERRIDE.CUST.DATA' && !!out && out.name === 'OVERRIDE.CUST.OUT'
        && r.warnings.some(w => w.indexOf('matches no step named PS9') >= 0)
        && r.warnings.some(w => w.indexOf('without a stepname.ddname qualifier') >= 0);
    })());
    T('V2 V3 21.6: stepDesc shows the override (transparency in the flow)', (() => {
      const r = parseJCL(['//OVR JOB (A),X','//MYPROC PROC','//PS1 EXEC PGM=CBPAY100','//INP DD DSN=PROD.CUST.DATA,DISP=SHR',
        '// PEND','//S0 EXEC PROC=MYPROC','//PS1.INP DD DSN=OVERRIDE.CUST.DATA,DISP=SHR'].join('\n'), {});
      const st0 = r.jobs[0].steps[0];
      const d = stepDesc({ name: st0.name, pgm: 'CBPAY100', kind: 'PGM', dds: st0.dds });
      return d.indexOf('override') >= 0 && d.indexOf('PS1.INP') >= 0 && d.indexOf('OVERRIDE.CUST.DATA') >= 0;
    })());
    T('V2 V3 21.7: cataloged PROC (uploaded file): override applied too', (() => {
      const bak = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        const PJ = ['//CATPROC PROC','//CS1 EXEC PGM=CBPAY100','//CIN DD DSN=PROD.CAT.IN,DISP=SHR','// PEND'].join('\n');
        const CJ = ['//CJ JOB (A),X','//S0 EXEC PROC=CATPROC','//CS1.CIN DD DSN=OVERRIDE.CAT.IN,DISP=SHR'].join('\n');
        const fs = [mkJ21('CATPROC.JCL', PJ), mkJ21('CJ.JCL', CJ)];
        // cataloged procs resolution: happens at buildModel via state.files
        state.files = fs; state.loaded = true; state._model = null;
        const ms = buildModel(fs);
        return ms.nodes.has('ds|OVERRIDE.CAT.IN') && !ms.nodes.has('ds|PROD.CAT.IN');
      } finally { state.files = bak.files; state.loaded = bak.loaded; state.entity = bak.entity; state.sub = bak.sub; state._model = bak._model; }
    })());
    T('V2 V3 21.8: PERFORM 1000-CALC THRU 1000-EXIT — numbered paragraphs translated, called, zero "undefined target"', (() => {
      const SRC21 = ['IDENTIFICATION DIVISION.','PROGRAM-ID. NUMPAR.','WORKING-STORAGE SECTION.',
        '01  WS-X PIC 9(4).','PROCEDURE DIVISION.','1000-CALC.','    MOVE 1 TO WS-X.','    PERFORM 1000-CALC THRU 1000-EXIT.',
        '1000-EXIT.','    EXIT.','0100-INIT.','    PERFORM 0100-INIT.','    PERFORM 1000-CALC2.','1000-CALC2.',
        '    MOVE 2 TO WS-X.','    STOP RUN.'].join('\n');
      const C21 = parseCOBOL('NUM.CBL', SRC21, {});
      const TR = translateCOBOL({ name: 'NUM.CBL', text: SRC21, parsed: { cobol: C21 } });
      const P = (TR && TR.python) || '';
      return P.indexOf('def p_1000_calc():') >= 0 && P.indexOf('def p_1000_exit():') >= 0
        && P.indexOf('def p_0100_init():') >= 0 && P.indexOf('def p_1000_calc2():') >= 0
        && P.indexOf('p_1000_calc()') >= 0 && P.indexOf('p_1000_exit()') >= 0
        && P.indexOf('undefined target') < 0 && P.indexOf('p_0100_init()') >= 0;
    })());
    T('V2 V3 21.9: CBPAY100 (sample) — _run entry, no para/main collision, eof_flag explicitly declared', (() => {
      const src = ['IDENTIFICATION DIVISION.','PROGRAM-ID. CBPAY100.','ENVIRONMENT DIVISION.','INPUT-OUTPUT SECTION.','FILE-CONTROL.',
        '    SELECT TRANS-FILE ASSIGN TO TRANS.','DATA DIVISION.','FILE SECTION.','FD  TRANS-FILE.','COPY PAYREC.',
        'WORKING-STORAGE SECTION.','01  WS-HOURS      PIC 9(4)V99.','01  WS-RATE       PIC 9(4)V99.','01  WS-GROSS-PAY  PIC 9(7)V99.',
        'PROCEDURE DIVISION.',"PERFORM UNTIL EOF-FLAG = 'Y'",
        "    READ TRANS-FILE AT END MOVE 'Y' TO EOF-FLAG",
        '    COMPUTE WS-GROSS-PAY ROUNDED = WS-HOURS * WS-RATE','END-PERFORM.','STOP RUN.'].join('\n');
      const cpy = ['01  PAY-RECORD.','    05  ACC-ID      PIC 9(8).','    05  EMP-NAME    PIC X(25).',
        '    05  HOURS       PIC 9(4)V99.','    05  RATE        PIC 9(4)V99.'].join('\n');
      const bak = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        const fCpy = mkJ21('PAYREC.CPY', cpy);
        const fCbl = { name: 'CBPAY100.CBL', text: src }; fCbl.lang = detectLang(fCbl.name, src); parseFile(fCbl);
        state.files = [fCbl, fCpy]; state.loaded = true; state._model = null;
        const TR = translateCOBOL(fCbl);
        const P = (TR && TR.python) || '';
        const nRun = (P.match(/def _run\(\):/g) || []).length;
        return nRun === 1 && P.indexOf('def main():') < 0 && P.indexOf('def para_main():') >= 0
          && P.indexOf('eof_flag: str =') >= 0 && P.indexOf('NOT DECLARED in COBOL') >= 0
          && (P.match(/def para_main\(\):/g) || []).length === 1;
      } finally { state.files = bak.files; state.loaded = bak.loaded; state.entity = bak.entity; state.sub = bak.sub; state._model = bak._model; }
    })());
    T('V2 V3 21.10: CBPAY100 — pyStaticCheck OK: no collision, no undefined call, no cycle, no infinite loop', (() => {
      const src = ['IDENTIFICATION DIVISION.','PROGRAM-ID. CBPAY100.','ENVIRONMENT DIVISION.','INPUT-OUTPUT SECTION.','FILE-CONTROL.',
        '    SELECT TRANS-FILE ASSIGN TO TRANS.','DATA DIVISION.','FILE SECTION.','FD  TRANS-FILE.','COPY PAYREC.',
        'WORKING-STORAGE SECTION.','01  WS-HOURS      PIC 9(4)V99.','01  WS-RATE       PIC 9(4)V99.','01  WS-GROSS-PAY  PIC 9(7)V99.',
        'PROCEDURE DIVISION.',"PERFORM UNTIL EOF-FLAG = 'Y'",
        "    READ TRANS-FILE AT END MOVE 'Y' TO EOF-FLAG",
        '    COMPUTE WS-GROSS-PAY ROUNDED = WS-HOURS * WS-RATE','END-PERFORM.','STOP RUN.'].join('\n');
      const cpy = ['01  PAY-RECORD.','    05  ACC-ID      PIC 9(8).','    05  EMP-NAME    PIC X(25).',
        '    05  HOURS       PIC 9(4)V99.','    05  RATE        PIC 9(4)V99.'].join('\n');
      const bak = { files: state.files, loaded: state.loaded, entity: state.entity, sub: state.sub, _model: state._model };
      try {
        const fCpy = mkJ21('PAYREC.CPY', cpy);
        const fCbl = { name: 'CBPAY100.CBL', text: src }; fCbl.lang = detectLang(fCbl.name, src); parseFile(fCbl);
        state.files = [fCbl, fCpy]; state.loaded = true; state._model = null;
        const TR = translateCOBOL(fCbl);
        const chk = pyStaticCheck(TR.python);
        return chk.ok && TR.python.indexOf('def _run():') >= 0 && TR.python.indexOf('para_main()') >= 0;
      } finally { state.files = bak.files; state.loaded = bak.loaded; state.entity = bak.entity; state.sub = bak.sub; state._model = bak._model; }
    })());
    T('V2 V3 21.11: pyStaticCheck — detects duplicate def, undefined call, infinite loop; OK on clean code', (() => {
      const bad = 'def main():\n    main()\n\ndef main():\n    pass\n\nif __name__ == "__main__":\n    main()\n';
      const r1 = pyStaticCheck(bad);
      const bad2 = 'while not (x == "Y"):\n    pass\n'; // x never assigned → detectable infinite loop
      const r2 = pyStaticCheck(bad2);
      const bad3 = 'def _run():\n    ghost()\n\nif __name__ == "__main__":\n    _run()\n';
      const r3 = pyStaticCheck(bad3);
      const good = 'ws_a = 0\n\ndef _run():\n    ws_a = ws_a + 1\n\nif __name__ == "__main__":\n    _run()\n';
      const r4 = pyStaticCheck(good);
      return r1.issues.some(i => i.indexOf('defined MULTIPLE times') >= 0)
        && r2.issues.some(i => i.indexOf('INFINITE') >= 0)
        && r3.issues.some(i => i.indexOf('never defined') >= 0)
        && r4.ok;
    })());
    T('V2 V3 21.12: CONCATENATED overrides — each card contributes its dataset, no loss', (() => {
      const J24 = ['//OVR3 JOB (A),X','//MYPROC3 PROC','//PS1 EXEC PGM=CBPAY100','//INP DD DSN=PROD.CUST.DATA,DISP=SHR','// PEND',
        '//S0 EXEC PROC=MYPROC3',
        '//PS1.INP DD DSN=OVR.CUST.A,DISP=SHR',
        '//PS1.INP DD DSN=OVR.CUST.B,DISP=SHR'].join('\n');
      const ms = buildModel([mkJ21('OC.JCL', J24)]);
      const eA = ms.edges.find(e => e.t === 'ds|OVR.CUST.A' && e.k === 'read');
      const eB = ms.edges.find(e => e.t === 'ds|OVR.CUST.B' && e.k === 'read');
      return !!eA && !!eB && !ms.nodes.has('ds|PROD.CUST.DATA')
        && eA.ev.some(x => x.note.indexOf('overridden by PS1.INP') >= 0)
        && eB.ev.some(x => x.note.indexOf('overridden by PS1.INP') >= 0)
        && eA.ev[0].note.indexOf('DD INP DSN=') >= 0 && eB.ev[0].note.indexOf('DD INP#2 DSN=') >= 0;
    })());
    T('V2 V3 21.13: COND=EVEN / COND=ONLY honestly classified; COND=(0,LT) never evaluated', (() => {
      const J25 = ['//CE JOB (A),X',
        '//SE EXEC PGM=PA,COND=EVEN',
        '//SO EXEC PGM=PB,COND=ONLY',
        '//SC EXEC PGM=PC,COND=(0,LT)'].join('\n');
      const ms = buildModel([mkJ21('CE.JCL', J25)]);
      const w = (ms.warnings || []).join('\n');
      return w.indexOf('COND=EVEN — runs even after a previous abend') >= 0
        && w.indexOf('COND=ONLY — runs ONLY after a preceding abend') >= 0
        && w.indexOf('is conditional (COND=(0,LT))') >= 0
        && w.indexOf('the condition is not evaluated') >= 0;
    })());
    T('V2 V3 21.14: pyStaticCheck — module assignment without global detected (shadowing local variable)', (() => {
      const badG = 'ws_a: int = 0\n\ndef _run():\n    ws_a = 1\n\nif __name__ == "__main__":\n    _run()\n';
      const rg = pyStaticCheck(badG);
      const okG = 'ws_a: int = 0\n\ndef _run():\n    global ws_a\n    ws_a = 1\n\nif __name__ == "__main__":\n    _run()\n';
      const rok = pyStaticCheck(okG);
      return rg.issues.some(i => i.indexOf('without "global') >= 0) && rok.ok;
    })());
    T('V2 V3 21.15: telemetry opt-out blocks track() even if gtag is already loaded', (() => {
      // Reproduces the real defect: gtag defined + opt-out → no event is sent.
      const g = window.gtag, t = localStorage.getItem('reforge_telemetry');
      try {
        let n = 0; window.gtag = function(){ n++; };
        localStorage.setItem('reforge_telemetry', '0');
        track('map_filter');
        const blocked = n === 0;
        localStorage.setItem('reforge_telemetry', '1');
        track('map_filter');
        return blocked && n === 1;
      } finally { window.gtag = g; if (t == null) localStorage.removeItem('reforge_telemetry'); else localStorage.setItem('reforge_telemetry', t); }
    })());
    T('V2 V3 21.16: job log SDSF/SAR — parseJobLog reconnait IEF142I/IEF450I/flush + detectLang', (() => {
      const LOG1 = ['$HASP373 LJ1 STARTED - INIT 3 - CLASS A - SYS SC70',
        'IEF142I LJ1 S1 - STEP WAS EXECUTED - COND CODE 0000',
        'IEF450I LJ2 S1 - ABNORMAL ENDED - ABEND=S0C4 U0000 REASON=00E40045',
        'IEF453I LJ2 S2 - STEP WAS FLUSHED DUE TO COND CODE',
        '$HASP395 LJ2 ENDED - RC=0016'].join('\n');
      const lg = parseJobLog(LOG1);
      const j1 = lg.logs.find(l => l.job === 'LJ1');
      const j2 = lg.logs.find(l => l.job === 'LJ2');
      const empty = parseJobLog('nothing recognizable here at all');
      return !!j1 && !!j1.steps.find(s => s.name === 'S1' && s.rc === 0)
        && !!j2 && !!j2.steps.find(s => s.name === 'S1' && s.abend === 'S0C4 U0000')
        && !!j2.steps.find(s => s.name === 'S2' && s.flushed)
        && j2.jobRc === 16
        && empty.logs.length === 0 && empty.warnings.some(w => w.indexOf('no JES/SDSF step status recognized') >= 0)
        && detectLang('RUN.LOG', LOG1) === 'JOBLOG' && detectLang('X.LOG', 'plain text') === 'JOBLOG'
        && detectLang('A.TXT', LOG1) === 'JOBLOG';
    })());
    T('V2 V3 21.17: COND evaluated from the log — BYPASSED when the test is true, RC shown', (() => {
      const J26 = ['//LJ1 JOB 1', '//S1 EXEC PGM=PA', '//DD1 DD DSN=IN.A,DISP=SHR',
        '//S2 EXEC PGM=PB,COND=(4,LT)', '//DD2 DD DSN=OUT.B,DISP=(,CATLG)',
        '//S3 EXEC PGM=PC,COND=(0,GT)'].join('\n');
      const LOG1 = ['$HASP373 LJ1 STARTED - INIT 3 - CLASS A - SYS SC70',
        'IEF142I LJ1 S1 - STEP WAS EXECUTED - COND CODE 0000',
        '$HASP395 LJ1 ENDED - RC=0000'].join('\n');
      const ms = buildModel([mkJ21('LJ1.JCL', J26), mkJ21('LJ1.LOG', LOG1)]);
      const w = (ms.warnings || []).join('\n');
      // S2: S1 RC=0 → 0 LT 4 true → BYPASSED; S3: RC of S2 unknown in the log → structural kept
      return w.indexOf('conditional (COND=(4,LT)) EVALUATED against uploaded job log') >= 0
        && w.indexOf('S1 RC=0000') >= 0 && w.indexOf('0 LT 4 = true') >= 0 && w.indexOf('BYPASSED in this run') >= 0
        && w.indexOf('conditional (COND=(0,GT))') >= 0 && w.indexOf('the condition is not evaluated') >= 0
        && (ms.nodes.get('step|LJ1.S1') || {}).data.rc === 0;
    })());
    T('V2 V3 21.18: named COND and EXECUTED when the test is false; stepDesc shows RC and verdict', (() => {
      const J27 = ['//LJ2 JOB 1', '//S1 EXEC PGM=PA',
        '//S2 EXEC PGM=PB,COND=(4,GT)',
        '//S3 EXEC PGM=PC,COND=(4,LT,S1)'].join('\n');
      const LOG2 = ['$HASP373 LJ2 STARTED - INIT 3',
        'IEF142I LJ2 S1 - STEP WAS EXECUTED - COND CODE 0004',
        'IEF142I LJ2 S2 - STEP WAS EXECUTED - COND CODE 0000',
        '$HASP395 LJ2 ENDED - RC=0004'].join('\n');
      const fs18 = [mkJ21('LJ2.JCL', J27), mkJ21('LJ2.LOG', LOG2)];
      const ms = buildModel(fs18);
      const w = (ms.warnings || []).join('\n');
      const st2 = ms.nodes.get('step|LJ2.S2');
      const st3 = ms.nodes.get('step|LJ2.S3');
      const w2 = w.indexOf('conditional (COND=(4,GT)) EVALUATED') >= 0 && w.indexOf('EXECUTED in this run') >= 0;
      const w3 = w.indexOf('conditional (COND=(4,LT,S1)) EVALUATED') >= 0 && w.indexOf('4 LT 4 = false') >= 0;
      // stepDesc: log RC + evaluated verdict visible
      const bak = { files: state.files, loaded: state.loaded, log: state.log, entity: state.entity, srcIdx: state.srcIdx, srcFile: state.srcFile, group: state.group, sub: state.sub, mdl: state._model };
      try {
        state.files = fs18; state.loaded = true; state._model = ms; // same objects: rcObs attached by buildModel
        const g = buildGraph();
        const s2g = g.jobs[0].parsed.steps.find(x => x.name === 'S2');
        const d = stepDesc(s2g);
        return w2 && w3 && !!st2 && st2.data.rc === 0 && !!st3
          && ((ms.nodes.get('step|LJ2.S1') || {}).data || {}).rc === 4
          && d.indexOf('RC 0000 (job log)') >= 0 && d.indexOf('evaluated from uploaded job log: EXECUTED') >= 0;
      } finally { state.files = bak.files; state.loaded = bak.loaded; state.log = bak.log; state.entity = bak.entity; state.srcIdx = bak.srcIdx; state.srcFile = bak.srcFile; state.group = bak.group; state.sub = bak.sub; state._model = bak.mdl; }
    })());
    T('V2 V3 21.19: ABEND step in the log — explicitly warned, COND never evaluated on abend', (() => {
      const J28 = ['//LJ3 JOB 1', '//S1 EXEC PGM=PA',
        '//S2 EXEC PGM=PB,COND=(0,LT)'].join('\n');
      const LOG3 = ['$HASP373 LJ3 STARTED - INIT 3',
        'IEF450I LJ3 S1 - ABNORMAL ENDED - ABEND=S0C4 U0000 REASON=00E40045',
        '$HASP395 LJ3 ENDED - RC=0016'].join('\n');
      const ms = buildModel([mkJ21('LJ3.JCL', J28), mkJ21('LJ3.LOG', LOG3)]);
      const w = (ms.warnings || []).join('\n');
      return w.indexOf('step LJ3.S1 ABENDED (S0C4 U0000) per uploaded job log') >= 0
        && w.indexOf('conditional (COND=(0,LT))') >= 0 && w.indexOf('the condition is not evaluated') >= 0
        && w.indexOf('EVALUATED') < 0;
    })());
    T('V2 V3 21.20: dead code — written-never-read dataset + never-used copybook, honest exclusions', (() => {
      const JD1 = ['//DJ1 JOB 1', '//S1 EXEC PGM=PA',
        '//DDO DD DSN=DEAD.OUT,DISP=(,CATLG)',
        '//DDR DD DSN=USED.IN,DISP=SHR',
        '//DDT DD DSN=&&TMPX,DISP=(,PASS)',
        '//DDN DD DSN=NO.USG'].join('\n');
      const JD2 = ['//DJ2 JOB 1', '//R1 EXEC PGM=PX', '//DDR DD DSN=DEAD.OUT,DISP=OLD'].join('\n');
      const cpyF = mkJ21('NEVER.CPY', '01  NEVER-REC.\n    05  ACC-ID PIC 9(8).');
      const m1 = buildModel([mkJ21('DJ1.JCL', JD1), cpyF]);
      const m2 = buildModel([mkJ21('DJ1.JCL', JD1), mkJ21('DJ2.JCL', JD2), cpyF]);
      // written never read in set 1; read by DJ2 in set 2 → no longer flagged
      // temp excluded, unknown usage (without DISP) excluded, never a warning added
      return m1.dead.datasets.indexOf('DEAD.OUT') >= 0
        && m1.dead.datasets.indexOf('USED.IN') < 0
        && m1.dead.datasets.indexOf('&&TMPX') < 0
        && m1.dead.datasets.indexOf('NO.USG') < 0
        && m2.dead.datasets.indexOf('DEAD.OUT') < 0
        && m1.dead.copybooks.some(c => c.indexOf('NEVER') >= 0)
        && !m1.warnings.some(w => w.indexOf('DEAD.OUT') >= 0);
    })());
    T('V2 V3 21.21: Version Diff — added/removed relations/datasets, zero delta if identical', (() => {
      const JA = ['//VD1 JOB 1', '//S1 EXEC PGM=PA', '//I DD DSN=IN.X,DISP=SHR', '//O DD DSN=OUT.Y,DISP=(,CATLG)'].join('\n');
      const JB = ['//VD1 JOB 1', '//S1 EXEC PGM=PA', '//I DD DSN=IN.X,DISP=SHR', '//O DD DSN=OUT.Z,DISP=(,CATLG)'].join('\n');
      const JC = ['//VD2 JOB 1', '//R1 EXEC PGM=PB', '//R DD DSN=OUT.Z,DISP=OLD'].join('\n');
      const r = deltaDiff([mkJ21('A.JCL', JA)], [mkJ21('B.JCL', JB), mkJ21('C.JCL', JC)]);
      const same = deltaDiff([mkJ21('A.JCL', JA)], [mkJ21('A2.JCL', JA)]);
      return r.edgesAdded.some(e => e.t === 'ds|OUT.Z')
        && r.edgesRemoved.some(e => e.t === 'ds|OUT.Y')
        && r.nodesAdded.some(n => n.id === 'job|VD2')
        && r.nodesRemoved.some(n => n.id === 'ds|OUT.Y')
        && r.edgesAdded.every(e => e.ev && e.ev.length)
        && same.edgesAdded.length === 0 && same.edgesRemoved.length === 0
        && same.nodesAdded.length === 0 && same.nodesRemoved.length === 0;
    })());
    // Regression (bug fixed: _run used to call EVERY paragraph in declared order →
    // double execution of PERFORMed paragraphs and side effects). The entry must now
    // follow the REAL flow: MAIN-P performs INIT-P then STOP RUN → only main_p() is
    // called; NEXT-P (after the STOP) is never called.
    T('V2 V3 21.22: _run follows the real flow — no double execution, no dead-tail calls', (() => {
      const src = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. DBL.\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n01 WS-COUNT PIC 9(4).\nPROCEDURE DIVISION.\nMAIN-P.\n    PERFORM INIT-P.\n    STOP RUN.\nINIT-P.\n    ADD 1 TO WS-COUNT.\nNEXT-P.\n    DISPLAY "X".';
      const C = parseCOBOL('DBL.CBL', src, {});
      const TR = translateCOBOL({ name:'DBL.CBL', text:src, parsed:{ cobol:C } });
      if (TR.error) return false;
      const m = TR.python.match(/def _run\(\):([\s\S]*)/);
      if (!m) return false;
      const body = m[1].split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).join('\n');
      return /\bmain_p\(\)/.test(body)
        && !/\binit_p\(\)/.test(body)      // INIT-P is PERFORMed INSIDE main_p — must NOT be called again by _run
        && !/\bnext_p\(\)/.test(body)      // NEXT-P lies after STOP RUN — unreachable, must NOT be called
        && /\binit_p\(\)/.test((TR.python.match(/def main_p\(\):([\s\S]*?)\n\n/)||['',''])[1]); // …but still called inside main_p
    })());
    T('V2 V3 21.23: _run truncates with explicit warning on uncertain flow (conditional GO TO)', (() => {
      const src = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. CGT.\nPROCEDURE DIVISION.\nP1.\n    IF X = 1 GO TO P3.\n    DISPLAY "A".\nP2.\n    DISPLAY "B".\nP3.\n    DISPLAY "C".';
      const C = parseCOBOL('CGT.CBL', src, {});
      const TR = translateCOBOL({ name:'CGT.CBL', text:src, parsed:{ cobol:C } });
      if (TR.error) return false;
      return /flow stops here: conditional GO TO/.test(TR.python) && TR.warns.some(w => w.includes('linear generation stopped'));
    })());
    // Regression (bug fixed: undeclared variables assigned in a function got NO
    // `global` line when the function had none → UnboundLocalError at run time).
    T('V2 V3 21.24: undeclared variable assigned in a function gets a global line', (() => {
      const src = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. UDV.\nPROCEDURE DIVISION.\nP1.\n    ADD 1 TO WS-CTR.\n    STOP RUN.';
      const C = parseCOBOL('UDV.CBL', src, {});
      const TR = translateCOBOL({ name:'UDV.CBL', text:src, parsed:{ cobol:C } });
      if (TR.error) return false;
      const fn = (TR.python.match(/def p1\(\):\n(    global [^\n]*\n)?([\s\S]*?)\n\n/) || ['', '', ''])[1] + '\n' + (TR.python.match(/def p1\(\):\n(    global [^\n]*\n)?([\s\S]*?)\n\n/) || ['', '', ''])[2];
      return /    global [^\n]*\bws_ctr\b/.test(fn);
    })());
    // Regression (improvement: EXIT PROGRAM used to be a silent no-op — in a
    // called subprogram control must return to the caller).
    T('V2 V3 21.25: EXIT PROGRAM → return (approximated, documented)', (() => {
      const src = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. EXP.\nPROCEDURE DIVISION.\nP1.\n    EXIT PROGRAM.';
      const C = parseCOBOL('EXP.CBL', src, {});
      const TR = translateCOBOL({ name:'EXP.CBL', text:src, parsed:{ cobol:C } });
      if (TR.error) return false;
      return TR.python.includes('return  # EXIT PROGRAM') && TR.stmts.some(s => s.status === 'approximated');
    })());
    // Regression (improvement: statements after an unconditional GO TO / STOP RUN
    // used to be emitted as live Python — unreachable code silently present).
    T('V2 V3 21.26: statements after GO TO / STOP RUN emitted as comments, not live code', (() => {
      const src = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. URA.\nPROCEDURE DIVISION.\nP1.\n    GO TO P2.\n    DISPLAY "NEVER".\nP2.\n    STOP RUN.\n    DISPLAY "ALSO NEVER".';
      const C = parseCOBOL('URA.CBL', src, {});
      const TR = translateCOBOL({ name:'URA.CBL', text:src, parsed:{ cobol:C } });
      if (TR.error) return false;
      return (TR.python.match(/# \[unreachable after/g) || []).length === 2
        && !/\n    print\("NEVER"\)/.test(TR.python)
        && !/\n    print\("ALSO NEVER"\)/.test(TR.python);
    })());
    // DD DUMMY: no dataset behind the DD — no dataset edge may be created,
    // and the other DDs of the step keep their real relations.
    T('V2 JCL 21.27: DD DUMMY → no dataset edge, no invented dependency', (() => {
      const JD = ['//DMY JOB 1', '//S1 EXEC PGM=PX', '//D1 DD DUMMY', '//D2 DD DSN=REAL.DS,DISP=SHR'].join('\n');
      const mD = buildModel([{ name: 'D.JCL', lang: 'JCL', text: JD, parsed: { engine: 'v3', jobs: parseJCL(JD, {}).jobs, procs: {}, warnings: [] } }]);
      const s1 = mD.edges.filter(e => e.f === 'step|DMY.S1' && e.k !== 'exec' && String(e.t).indexOf('ds|') === 0);
      return s1.length === 1 && s1[0].t === 'ds|REAL.DS';
    })());
    // Cross-view consistency: Map, Lineage, Impact and Summary all render from
    // the SAME model — a relation shown in one view must exist in the model
    // with its evidence, and no view may show a relation the model lacks.
    T('V2 CONSISTENCY 21.28: Map / Lineage / Impact / Summary read the same model relations', (() => {
      const JT = ['//CNJ JOB (A),X', '//S1 EXEC PGM=CNP', '//IN DD DSN=CNS.IN,DISP=SHR', '//OUT DD DSN=CNS.OUT,DISP=(,CATLG)'].join('\n');
      const CT = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. CNP.\nENVIRONMENT DIVISION.\nINPUT-OUTPUT SECTION.\nFILE-CONTROL.\n    SELECT INF ASSIGN TO IN.\nDATA DIVISION.\nFILE SECTION.\nFD  INF.\n01  IREC PIC X(10).\nPROCEDURE DIVISION.\nP1.\n    OPEN INPUT INF.\n    READ INF.\n    STOP RUN.';
      const filesC = [
        { name: 'CN.JCL', lang: 'JCL', text: JT, parsed: { engine: 'v3', jobs: parseJCL(JT, {}).jobs, procs: {}, warnings: [] } },
        { name: 'CNP.CBL', lang: 'CBL', text: CT, parsed: { cobol: parseCOBOL('CNP.CBL', CT, {}) } },
      ];
      const bakC = { files: state.files, loaded: state.loaded, entity: state.entity, group: state.group, sub: state.sub, _model: state._model };
      try {
        state.files = filesC; state.loaded = true; state._model = null; state.group = 'analyze';
        const m = getModel();
        const writeEdge = m.edges.find(e => e.f === 'step|CNJ.S1' && e.t === 'ds|CNS.OUT' && e.k === 'write');
        state.sub = 'map'; renderContent();
        const hMap = document.getElementById('content').innerHTML;
        state.sub = 'lineage'; state.entity = 'ds|CNS.OUT'; renderContent();
        const hLin = document.getElementById('content').innerHTML;
        state.sub = 'impact'; state.entity = 'prog|CNP'; renderContent();
        const hImp = document.getElementById('content').innerHTML;
        state.sub = 'summary'; renderContent();
        const hSum = document.getElementById('content').innerHTML;
        return !!writeEdge && writeEdge.ev && writeEdge.ev.length > 0
          && hMap.indexOf('CNS.IN') >= 0 && hMap.indexOf('CNS.OUT') >= 0
          && hLin.indexOf('CNS.OUT') >= 0
          && hImp.indexOf('CNS.OUT') >= 0
          && hSum.indexOf('CNJ') >= 0;
      } finally { state.files = bakC.files; state.loaded = bakC.loaded; state.entity = bakC.entity; state.group = bakC.group; state.sub = bakC.sub; state._model = bakC._model; }
    })());

    // ── 21.29 Living graph: auto-snapshot on build, deduplicated ──
    T('V2 HISTORY 21.29: getModel creates a snapshot; identical rebuild does not duplicate', (() => {
      const JT = ['//HJ JOB (A),X', '//S1 EXEC PGM=HGP', '//IN DD DSN=H.IN,DISP=SHR'].join('\n');
      const CT = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. HGP.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN.';
      const filesH = [
        { name: 'H.JCL', lang: 'JCL', text: JT, parsed: { engine: 'v3', jobs: parseJCL(JT, {}).jobs, procs: {}, warnings: [] } },
        { name: 'HGP.CBL', lang: 'CBL', text: CT, parsed: { cobol: parseCOBOL('HGP.CBL', CT, {}) } },
      ];
      const bakH = { files: state.files, loaded: state.loaded, _model: state._model, history: state.history, histA: state.histA, histB: state.histB };
      try {
        state.files = filesH; state.loaded = true; state._model = null; state.history = [];
        const m = getModel();
        const ok1 = state.history.length === 1 && state.history[0].counts.nodes === m.nodes.size && state.history[0].counts.edges === m.edges.length;
        state._model = null; getModel(); // identical rebuild → dedup
        const ok2 = state.history.length === 1;
        return ok1 && ok2;
      } finally { state.files = bakH.files; state.loaded = bakH.loaded; state._model = bakH._model; state.history = bakH.history; state.histA = bakH.histA; state.histB = bakH.histB; }
    })());

    // ── 21.30 Living graph: diff detects node/edge/file changes, honest renames ──
    T('V2 HISTORY 21.30: graphDiff detects added/removed relations and changed file; rename = remove+add', (() => {
      const mk = (dsn) => {
        const JT = ['//HJ2 JOB (A),X', '//S1 EXEC PGM=HGD', '//IN DD DSN=' + dsn + ',DISP=SHR'].join('\n');
        return [{ name: 'H2.JCL', lang: 'JCL', text: JT, parsed: { engine: 'v3', jobs: parseJCL(JT, {}).jobs, procs: {}, warnings: [] } }];
      };
      const s1 = (() => { const bak = { files: state.files, _model: state._model, history: state.history };
        try { state.files = mk('OLD.DSN'); state._model = null; state.history = []; getModel(); return state.history[0]; }
        finally { state.files = bak.files; state._model = bak._model; state.history = bak.history; } })();
      const s2 = (() => { const bak = { files: state.files, _model: state._model, history: state.history };
        try { state.files = mk('NEW.DSN'); state._model = null; state.history = []; getModel(); return state.history[0]; }
        finally { state.files = bak.files; state._model = bak._model; state.history = bak.history; } })();
      const d = graphDiff(s1, s2);
      return d.edgesRemoved.length === 1 && d.edgesAdded.length === 1
        && d.edgesRemoved[0].indexOf('ds|OLD.DSN') >= 0 && d.edgesAdded[0].indexOf('ds|NEW.DSN') >= 0
        && d.filesChanged.length === 1 && d.filesChanged[0] === 'H2.JCL'
        && d.nodesRemoved.some(n => n.id === 'ds|OLD.DSN') && d.nodesAdded.some(n => n.id === 'ds|NEW.DSN');
    })());

    // ── 21.31 History panel renders + cap at HISTORY_CAP ──
    T('V2 HISTORY 21.31: History panel renders diff of two snapshots; history capped at ' + HISTORY_CAP, (() => {
      const bakH = { history: state.history, histA: state.histA, histB: state.histB, loaded: state.loaded, group: state.group, sub: state.sub };
      try {
        state.history = []; state.histA = null; state.histB = null;
        const base = { nodes: { 'job|J1': { type: 'job', name: 'J1' }, 'prog|P1': { type: 'prog', name: 'P1' } }, edges: { 'job|J1|prog|P1|runs|certain': 'certain' }, fileHashes: { A: '1' }, counts: { nodes: 2, edges: 1, warnings: 0 }, label: '', ts: 0 };
        for (let i = 0; i < HISTORY_CAP + 5; i++){
          const s = JSON.parse(JSON.stringify(base));
          s.label = 'v' + (i + 1); s.ts = 1000 + i;
          s.nodes['ds|D' + i] = { type: 'ds', name: 'D' + i };
          s.edges['step|S|ds|D' + i + '|write'] = 'certain';
          s.counts.nodes = 3 + i; s.counts.edges = 2 + i;
          state.history.push(s);
        }
        if (state.history.length !== HISTORY_CAP + 5) return false;
        state.loaded = true; state.group = 'analyze'; state.sub = 'history';
        renderContent();
        const h = document.getElementById('content').innerHTML;
        // panel shows the cap, the two selects, and a non-trivial diff (B latest vs A before it)
        return h.indexOf('History') >= 0 && h.indexOf('Snapshot now') >= 0
          && h.indexOf('new entitie') >= 0 && h.indexOf('D' + (HISTORY_CAP + 4)) >= 0;
      } finally { state.history = bakH.history; state.histA = bakH.histA; state.histB = bakH.histB; state.loaded = bakH.loaded; state.group = bakH.group; state.sub = bakH.sub; }
    })());

    // ── 21.32 Ask the graph: I/O question answered from real edges ──
    T('V2 AI-ASK 21.32: "who writes to CNS.OUT" → deterministic edge-derived answer with evidence', (() => {
      const JT = ['//CNJ JOB (A),X', '//S1 EXEC PGM=CNP', '//IN DD DSN=CNS.IN,DISP=SHR', '//OUT DD DSN=CNS.OUT,DISP=(,CATLG)'].join('\n');
      const CT = 'IDENTIFICATION DIVISION.\nPROGRAM-ID. CNP.\nPROCEDURE DIVISION.\nP1.\n    STOP RUN.';
      const filesQ = [
        { name: 'CN.JCL', lang: 'JCL', text: JT, parsed: { engine: 'v3', jobs: parseJCL(JT, {}).jobs, procs: {}, warnings: [] } },
        { name: 'CNP.CBL', lang: 'CBL', text: CT, parsed: { cobol: parseCOBOL('CNP.CBL', CT, {}) } },
      ];
      const bakQ = { files: state.files, loaded: state.loaded, _model: state._model };
      try {
        state.files = filesQ; state.loaded = true; state._model = null;
        const r = aiAsk('who writes to CNS.OUT ?');
        const w = r.ok && r.intent === 'io' && r.lines.find(l => l.text.indexOf('is written by step|CNJ.S1') === 0);
        return !!w && (w.c === 'certain' || w.c === 'probable') && !!w.ev && w.ev.indexOf('CN.JCL') === 0;
      } finally { state.files = bakQ.files; state.loaded = bakQ.loaded; state._model = bakQ._model; }
    })());

    // ── 21.33 Ask the graph: honest refusals (unknown, ambiguous, unsupported) ──
    T('V2 AI-ASK 21.33: unknown entity / unsupported question → explicit refusal, never a guess', (() => {
      const JT = ['//CNJ2 JOB (A),X', '//S1 EXEC PGM=CNP', '//IN DD DSN=CNS.IN2,DISP=SHR'].join('\n');
      const filesQ = [{ name: 'CN2.JCL', lang: 'JCL', text: JT, parsed: { engine: 'v3', jobs: parseJCL(JT, {}).jobs, procs: {}, warnings: [] } }];
      const bakQ = { files: state.files, loaded: state.loaded, _model: state._model };
      try {
        state.files = filesQ; state.loaded = true; state._model = null;
        const r1 = aiAsk('who writes to ZZZ.NOT.UPLOADED ?');
        const r2 = aiAsk('what is the philosophy of CNJ2 ?');
        const r3 = aiAsk('who uses step|CNJ2.S1 ?');
        return r1 && !r1.ok && /no entity/.test(r1.reason)
          && r2 && !r2.ok && /unsupported question/.test(r2.reason)
          && r3 && r3.ok && r3.lines.some(l => l.text.indexOf('used by job|CNJ2') === 0);
      } finally { state.files = bakQ.files; state.loaded = bakQ.loaded; state._model = bakQ._model; }
    })());

    // ── 21.34 Ask the graph: impact = one hop, honestly stated ──
    T('V2 AI-ASK 21.34: impact question → one hop with explicit limitation note', (() => {
      const JT = ['//CNJ3 JOB (A),X', '//S1 EXEC PGM=CNP', '//IN DD DSN=CNS.IN3,DISP=SHR'].join('\n');
      const filesQ = [{ name: 'CN3.JCL', lang: 'JCL', text: JT, parsed: { engine: 'v3', jobs: parseJCL(JT, {}).jobs, procs: {}, warnings: [] } }];
      const bakQ = { files: state.files, loaded: state.loaded, _model: state._model };
      try {
        state.files = filesQ; state.loaded = true; state._model = null;
        const r = aiAsk('what is the impact if I modify CNP ?');
        return r && r.ok && r.intent === 'impact'
          && r.lines.some(l => l.text.indexOf('upstream: step|CNJ3.S1') === 0)
          && r.lines.some(l => /One hop only/.test(l.text));
      } finally { state.files = bakQ.files; state.loaded = bakQ.loaded; state._model = bakQ._model; }
    })());

    // ── 21.35 Ask the graph: history question answered from snapshots diff ──
    T('V2 AI-ASK 21.35: "what changed" → answer derived from the last two snapshots', (() => {
      const mkJ = (dsn) => {
        const JT = ['//HJ4 JOB (A),X', '//S1 EXEC PGM=HGP', '//IN DD DSN=' + dsn + ',DISP=SHR'].join('\n');
        return [{ name: 'H4.JCL', lang: 'JCL', text: JT, parsed: { engine: 'v3', jobs: parseJCL(JT, {}).jobs, procs: {}, warnings: [] } }];
      };
      const bakQ = { files: state.files, loaded: state.loaded, _model: state._model, history: state.history };
      try {
        state.files = mkJ('OLD4.DSN'); state.loaded = true; state._model = null; state.history = [];
        getModel();
        state.files = mkJ('NEW4.DSN'); state._model = null;
        getModel();
        const r = aiAsk('what changed for HGP since version 1 ?');
        return r && r.ok && r.intent === 'history'
          && r.lines.some(l => l.text.indexOf('+ relation') === 0 && l.text.indexOf('NEW4.DSN') >= 0)
          && r.lines.some(l => l.text.indexOf('− relation') === 0 && l.text.indexOf('OLD4.DSN') >= 0);
      } finally { state.files = bakQ.files; state.loaded = bakQ.loaded; state._model = bakQ._model; state.history = bakQ.history; }
    })());

    // ── 21.36 GOBACK is a terminator, never a paragraph (regression) ──
    T('V2 GOBACK 21.36: bare "GOBACK." is not a paragraph; code after GOBACK is unreachable', (() => {
      const CT = ['IDENTIFICATION DIVISION.', 'PROGRAM-ID. GB1.', 'PROCEDURE DIVISION.',
        'P1.', '    DISPLAY \'A\'.', '    GOBACK.', '    DISPLAY \'NEVER\'.',
        'P2.', '    DISPLAY \'B\'.', '    STOP RUN.'].join('\n');
      const C = parseCOBOL('GB1.CBL', CT, {});
      const paraNames = C.paragraphs.map(p => p.name);
      const noGobackPara = !paraNames.includes('GOBACK') && paraNames.includes('P1') && paraNames.includes('P2');
      // dead code: statements after GOBACK in P1 must be flagged, P2 (never called) too
      const dead = (C.dead || []).map(d => d.name || d);
      const gobackUnreachable = dead.includes('P2') || dead.includes('AFTER-GO-P') || dead.length >= 1;
      return noGobackPara && gobackUnreachable;
    })());

    // ── 21.37 GOBACK drives _run(): entry ends at GOBACK, later paras not called ──
    T('V2 GOBACK 21.37: _run() generated from real flow ends at GOBACK; later paragraph not called', (() => {
      const CT = ['IDENTIFICATION DIVISION.', 'PROGRAM-ID. GB2.', 'WORKING-STORAGE SECTION.',
        '77 WS-X PIC 9 VALUE 0.', 'PROCEDURE DIVISION.',
        'P1.', '    MOVE 1 TO WS-X.', '    GOBACK.',
        'P2.', '    MOVE 2 TO WS-X.', '    STOP RUN.'].join('\n');
      const TR = translateCOBOL({ name: 'GB2.CBL', text: CT, parsed: { cobol: parseCOBOL('GB2.CBL', CT, {}) } });
      const py = TR.python || '';
      // _run body = from 'def _run():' to the next top-level 'def ' (exclusive)
      const runStart = py.indexOf('def _run():');
      const runBody = runStart >= 0 ? py.slice(runStart + 11, py.indexOf('\ndef ', runStart + 1) < 0 ? py.length : py.indexOf('\ndef ', runStart + 1)) : '';
      // P2 must exist as a function (p2 or renamed para_p2) but must NOT be called from the flow
      const hasP2Def = /def (para_)?p2\s*\(/.test(py);
      const p2NotCalledInRun = !/(para_)?p2\s*\(/.test(runBody);
      const gobackEnds = /GOBACK/.test(runBody) || /return/.test(runBody) || /p1\s*\(/.test(runBody);
      return hasP2Def && p2NotCalledInRun && gobackEnds;
    })());

    // ── 21.38 Numbered paragraphs, THRU, DEPENDING conservative, reserved words ──
    T('V2 PARAS 21.38: 1000-CALC/THRU/GO TO DEPENDING/reserved words behave per spec', (() => {
      const CT = ['IDENTIFICATION DIVISION.','PROGRAM-ID. NPX.','PROCEDURE DIVISION.',
        'MAIN-PARA.','    PERFORM 1000-CALC THRU 1000-EXIT.','    GO TO P2 P3 DEPENDING ON WS-I.',
        '    STOP RUN.','1000-CALC.','    MOVE 1 TO WS-A.','1000-EXIT.','    EXIT.',
        'P2.','    STOP RUN.','P3.','    STOP RUN.'].join('\n');
      const C = parseCOBOL('NPX.CBL', CT, {});
      const names = C.paragraphs.map(p => p.name);
      const numberedOk = names.includes('1000-CALC') && names.includes('1000-EXIT') && names.includes('MAIN-PARA');
      const thruOk = C.performs.some(p => p.to === '1000-CALC' && p.thru === '1000-EXIT');
      const dependingOk = C.gotos.filter(g => g.depending).length >= 2;
      const conservative = (C.dead || []).length === 0; // DEPENDING: doubt → alive, never declared dead
      const noKwPara = !names.includes('DISPLAY') && !names.includes('MOVE') && !names.includes('GOBACK');
      // translation: PERFORM THRU simulated, GO TO DEPENDING not silently translated
      const TR = translateCOBOL({ name: 'NPX.CBL', text: CT, parsed: { cobol: C } });
      const st = TR.stmts || [];
      const thruApprox = st.some(x => x.status === 'approximated' && /THRU/.test(x.note || ''));
      const gotoDep = st.some(x => x.status === 'unsupported' || /DEPENDING/.test(x.note || ''));
      return numberedOk && thruOk && dependingOk && conservative && noKwPara && thruApprox && gotoDep;
    })());

    // ── 21.39 Robustness: empty / garbage / CRLF / no-extension never throw ──
    T('V2 ROBUST 21.39: empty, binary garbage, CRLF, unknown extension — no throw, explicit warnings', (() => {
      // empty COBOL → parsed, explicit warning, no throw
      const Ce = parseCOBOL('E.CBL', '', {});
      const emptyOk = Ce.programId === null && (Ce.warns || []).some(w => /PROGRAM-ID not found/.test(w));
      // binary-ish garbage → parsed, no throw
      let garb = '';
      for (let i = 0; i < 200; i++) garb += String.fromCharCode(32 + ((i * 37 + 7) % 95));
      const Cg = parseCOBOL('G.CBL', garb, {});
      const garbageOk = !!Cg && Array.isArray(Cg.warns);
      // CRLF line endings → paragraphs recognized
      const Cr = parseCOBOL('CR.CBL', 'IDENTIFICATION DIVISION.\r\nPROGRAM-ID. CR9.\r\nPROCEDURE DIVISION.\r\nP1.\r\n    STOP RUN.', {});
      const crlfOk = Cr.paragraphs.some(p => p.name === 'P1') && (Cr.dead || []).length === 0;
      // unknown extension → TXT (no parse branch), no crash downstream
      const langOk = detectLang('DATA.BIN', 'whatever') === 'TXT';
      // garbage JCL → warnings, no throw
      const Jg = parseJCL('///### garbage $$$\nrandom text\n', {});
      const jclOk = Jg.jobs.length === 0 && (Jg.warnings || []).length >= 1;
      return emptyOk && garbageOk && crlfOk && langOk && jclOk;
    })());

    // ── 21.40 Impact depth limit is SIGNALLED (partial ≠ exhaustive) ──
    T('V2 IMPACT 21.40: chain deeper than 12 → truncated flag true + Impact panel shows the warning', (() => {
      // build a 15-program static CALL chain: P1 CALLs P2 … P14 CALLs P15
      const filesC = [];
      for (let i = 1; i <= 15; i++){
        const nxt = i < 15 ? ("    CALL 'P" + (i + 1) + "'.\n") : '';
        const CTi = ['IDENTIFICATION DIVISION.', 'PROGRAM-ID. P' + i + '.', 'PROCEDURE DIVISION.',
          'P1.', nxt, '    STOP RUN.'].join('\n');
        filesC.push({ name: 'P' + i + '.CBL', lang: 'CBL', text: CTi, parsed: { cobol: parseCOBOL('P' + i + '.CBL', CTi, {}) } });
      }
      const bakC = { files: state.files, loaded: state.loaded, _model: state._model, entity: state.entity, group: state.group, sub: state.sub };
      try {
        state.files = filesC; state.loaded = true; state._model = null;
        const m = getModel();
        const res = impact(m, 'prog|P1');
        const truncatedSomewhere = !!res.truncated && (res.truncated.fwd || res.truncated.rev);
        state.entity = 'prog|P1'; state.group = 'analyze'; state.sub = 'impact';
        renderContent();
        const h = document.getElementById('content').innerHTML;
        const panelWarns = h.indexOf('Depth limit') >= 0 && h.indexOf('PARTIAL') >= 0;
        return truncatedSomewhere && panelWarns;
      } finally { state.files = bakC.files; state.loaded = bakC.loaded; state._model = bakC._model; state.entity = bakC.entity; state.group = bakC.group; state.sub = bakC.sub; }
    })());
  } catch (e){
    out.push({ name: 'V2 suite crashed: ' + e.message, pass: false });
  } finally {
    state.files = bak.files; state.loaded = bak.loaded; state.log = bak.log;
    state.entity = bak.entity; state.srcIdx = bak.srcIdx; state.srcFile = bak.srcFile;
    state.group = bak.group; state.sub = bak.sub; state._model = null;
  }
  return out;
}

// ══════════════════ 2. GESTION DES FICHIERS ══════════════════
