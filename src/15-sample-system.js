
const SAMPLE_FILES = [
  { name:'PAYRUN0.JCL', lang:'JCL', lines:17, sample:true,
    text:`//PAYRUN0  JOB  (ACCT),'MONTHLY PAYROLL',CLASS=A,MSGCLASS=X
//*--------------------------------------------------------------
//* MONTHLY PAYROLL RUN — sample extract
//*--------------------------------------------------------------
//STEP010  EXEC PGM=SORT
//SORTIN   DD DSN=PAYROLL.TRANS,DISP=SHR
//SORTOUT  DD DSN=&&SORTED,DISP=(,PASS)
//SYSOUT   DD SYSOUT=*
//PAYPROC  PROC CYCLE=202610
//STEP020  EXEC PGM=CBPAY100
//TRANS    DD DSN=*.STEP010.SORTOUT,DISP=OLD
//MASTER   DD DSN=&CYCLE..CUST.MSTR,DISP=SHR
//PAYMAST  DD DSN=PAYROLL.MASTER(+1),DISP=(,CATLG)
//         PEND
//S020     EXEC PAYPROC
//STEP030  EXEC PGM=CBPAY200
//PAYMAST  DD DSN=PAYROLL.MASTER,DISP=OLD
//SYSOUT   DD SYSOUT=*`,
    parsed:{ steps:[
      {name:'STEP010', pgm:'SORT',    desc:'Sort PAYROLL.TRANS by account number'},
      {name:'STEP020', pgm:'CBPAY100', desc:'Compute gross pay · reads BANK.CUST.MSTR'},
      {name:'STEP030', pgm:'CBPAY200', desc:'Net pay & payments · EXEC SQL update'}],
      dsns:['PAYROLL.TRANS','BANK.CUST.MSTR','PAYROLL.MASTER'] } },
  { name:'CBPAY100.CBL', lang:'CBL', lines:24, sample:true,
    text:`IDENTIFICATION DIVISION.
PROGRAM-ID. CBPAY100.
ENVIRONMENT DIVISION.
INPUT-OUTPUT SECTION.
FILE-CONTROL.
    SELECT TRANS-FILE ASSIGN TO TRANS.
DATA DIVISION.
FILE SECTION.
FD  TRANS-FILE.
COPY PAYREC.
WORKING-STORAGE SECTION.
01  WS-HOURS      PIC 9(4)V99.
01  WS-RATE       PIC 9(4)V99.
01  WS-GROSS-PAY  PIC 9(7)V99.
PROCEDURE DIVISION.
PERFORM UNTIL EOF-FLAG = 'Y'
    READ TRANS-FILE AT END MOVE 'Y' TO EOF-FLAG
    COMPUTE WS-GROSS-PAY ROUNDED = WS-HOURS * WS-RATE
END-PERFORM.
STOP RUN.`,
    parsed:{ programId:'CBPAY100', copies:['PAYREC'], sqlCount:0, performs:1, gotos:0 } },
  { name:'CBPAY200.CBL', lang:'CBL', lines:19, sample:true,
    text:`IDENTIFICATION DIVISION.
PROGRAM-ID. CBPAY200.
ENVIRONMENT DIVISION.
INPUT-OUTPUT SECTION.
FILE-CONTROL.
    SELECT PAYMAST-FILE ASSIGN TO PAYMAST.
DATA DIVISION.
FILE SECTION.
FD  PAYMAST-FILE.
01  PAYMAST-REC.
WORKING-STORAGE SECTION.
COPY PAYREC.
PROCEDURE DIVISION.
MAIN-PARA.
    OPEN INPUT PAYMAST-FILE.
    EXEC SQL DECLARE C1 CURSOR FOR
        SELECT ACC_ID, BALANCE FROM PAYROLL.ACCOUNTS
        WHERE STATUS = 'A'
    END-EXEC.
    IF WS-GROSS-PAY > 5000.00
        GO TO CAP-PARA.
    EXEC SQL UPDATE PAYROLL.PAYHIST
        SET PAID = :WS-PAID-FLAG END-EXEC.
CAP-PARA.
    READ PAYMAST-FILE.
    STOP RUN.`,
    parsed:{ programId:'CBPAY200', copies:['PAYREC'], sqlCount:2, performs:0, gotos:1 } },
  { name:'PAYREC.CPY', lang:'CPY', lines:6, sample:true,
    text:`01  PAY-RECORD.
    05  ACC-ID      PIC 9(8).
    05  EMP-NAME    PIC X(25).
    05  HOURS       PIC 9(4)V99.
    05  RATE        PIC 9(4)V99.`,
    parsed:{} },
];

function loadSample(){
  state.files = JSON.parse(JSON.stringify(SAMPLE_FILES));
  state.files.forEach(f => { f.lines = f.text.split('\n').length; parseFile(f); });
  state.loaded = true;
  state.entity = null; state.srcFile = null; state.pySel = null;
  state.group = 'explore'; state.sub = 'map';
  document.getElementById('statusText').textContent = 'Sample system loaded';
  buildLog();
  saveSession(); track('load_sample');
  renderLeft(); renderNav(); renderContent();
}

// ── Telemetry (Google Analytics): ON by default, persistent opt-out ──
// Loaded at boot; disable from Debug (localStorage 'reforge_telemetry' = '0').
// Only usage events are sent (view names, buttons) — never source code,
// file names or analysis data. Events go to Google and may be associated
// with browser/device identifiers; no anonymity guarantee is claimed.
function telemetryOn(){ try { return localStorage.getItem('reforge_telemetry') !== '0'; } catch(e){ return true; } }
let gtagLoaded = false;
function loadGtag(){
  if (!telemetryOn() || gtagLoaded || typeof window.gtag === 'function') return;
  try {
    const s = document.createElement('script');
    s.id = 'gtag-js'; s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=G-TMZLXLY7BC';
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function(){ window.dataLayer.push(arguments); };
    window.gtag('js', new Date()); window.gtag('config', 'G-TMZLXLY7BC');
    gtagLoaded = true;
  } catch(e){}
}
function toggleTelemetry(){
  const on = !telemetryOn();
  try { localStorage.setItem('reforge_telemetry', on ? '1' : '0'); } catch(e){}
  if (on) loadGtag();
  renderContent();
}
loadGtag();

// ══════════════════ 10. WIRING ══════════════════
