/* receiving/gs1.js — the GS1 label parser for the scan page, a FAITHFUL PORT of ../gs1_case_label.py.
   OWNER: Procurement & Merchandising (hosted in ProductPipeline).  Classic script: no modules, no build.

   ⛔ TWO COPIES, ONE BEHAVIOUR. This file and `../gs1_case_label.py` are pinned to the SAME vector file,
   `gs1_vectors.json` (`../test_gs1_vectors.py` runs it in Python, `test_gs1_parity.py` runs it through
   this file in Chromium). Change one, change the other, run both, same turn.

   ═══ FOR WP4a — HOW TO SWAP IT IN ═══
   index.html lines 358–494 (from the comment line "---------- GS1 parsing (ported from gs1_case_label.py) ----------"
   through the closing brace of `parseElementString`, just before the comment line "---------- auth: authorization code + PKCE")
   are REPLACED by this file. Delete those lines and add `<script src="gs1.js"></script>` BEFORE the inline
   <script>. ⛔ Do not leave both: a top-level `const` declared twice across classic scripts is a SyntaxError
   that kills the whole page.

   GLOBALS THIS FILE DEFINES (all of them are defined by the inline block it replaces, same names, same
   signatures, except that the date functions and parseElementString take an OPTIONAL last argument `today`
   — an ISO "YYYY-MM-DD" string or a Date — which the page never passes and the vectors pin):
     const   FIXED, VAR, GS, eom, iso3
     function checkDigit(body)
              gtin14ToConsumer(g)
              parseGs1Date(v[, today])           parseGs1DateShape(v[, today])
              normalize(ais[, today])
              looksLikeElementString(s)
              parseElementString(scan[, today])
   NEW globals (nothing in index.html uses them yet):
     const   VAR_MAX (alias of VAR), DATE_AIS
     window.GS1_SPLIT_AUTOFILL      default false (config flag `gs1_split_autofill`; the page may overwrite it)
     function gs1SplitNeedsConfirm(ais)   true when a date came from the lot-swallow split and must be CONFIRMED
     function gs1SplitAutofills(ais)      true when the split date may be applied with no confirm
   NOT defined here: `isRealDate` (stays inline at index.html ~1605; this file uses a private copy).

   THE PAGE DECIDES what a split means. The parser only reports it: `ais._split = {from, k, ambiguous, ks}`
   (`ks` = every candidate cut). Default (flag false) ⇒ PREFILL the date and ask for one Enter. An AMBIGUOUS
   split (`ambiguous:true`) is NEVER applied: `ais` carries the whole lot and no date from the tail — the page
   asks for the date. `ais._stop = {offset, reason}` (reason: unknown_ai | overlong | truncated) means the
   parse stopped early and kept what it had; the page asks for whatever is missing. Both keys start with `_`,
   so a loop over real AIs can skip them. */

/* ---------- GS1 parsing (ported from gs1_case_label.py; vectors: gs1_vectors.json) ---------- */
const FIXED={"00":18,"01":14,"02":14,"11":6,"12":6,"13":6,"15":6,"16":6,"17":6,"20":2};
/* ⛔ MEASUREMENT AIs SIT BETWEEN THE GTIN AND THE DATE ON EVERY VARIABLE-WEIGHT
   CASE (cheese, deli, meat), and an AI we do not know ABORTS the parse — so the
   best-by that follows it is silently thrown away. Measured 2026-08-18: a
   Rumiano case read
       (01)10811355127062 (3202)000450 (15)261120 (10)0702643
   and we captured the GTIN, hit 3202, stopped, and made someone type the date
   that was right there. AI 31nn–36nn are all 4 chars + 6 digits. */
for(const p of ["31","32","33","34","35","36"])
  for(let i=0;i<100;i++) FIXED[p+String(i).padStart(2,"0")]=6;
/* 2026-10-18: the rest of the AIs seen on KeHE-supplier cases. */
Object.assign(FIXED,{"402":17,"422":3,"424":3,"426":3,"7001":13,"7003":10,"7006":6,"8005":6});
for(let i=0;i<8;i++) FIXED["41"+i]=13;                       // 410-417
/* VAR value = the MAXIMUM length. ⛔ A value longer than its maximum STOPS the parse (`overlong`). */
const VAR={"10":20,"21":20,"30":8,"37":8,"240":30,"241":30,
  "22":20,"250":30,"251":30,"253":30,"254":20,"400":30,"401":30,"403":30,"420":20,"421":12,"423":15,
  "425":15,"427":3,"7002":30,"7004":4,"7007":12,"90":30};
for(let n=91;n<=99;n++) VAR[String(n)]=90;                   // 91-99
const VAR_MAX=VAR;
const GS=String.fromCharCode(29);
const DATE_AIS=["17","15","16","12","11","13","7006"];
/* the window a SPLIT-recovered date must fall in: [today - back, today + fwd]  ('d' days, 'y' years) */
const _GS1_WINDOW={"17":["d",400,"y",7],"15":["d",400,"y",7],"16":["d",400,"y",7],"12":["d",400,"y",7],
  "11":["y",3,"d",31],"13":["y",3,"d",31],"7006":["y",3,"d",0]};
const _GS1_AIM=/^\][A-Za-z][0-9A-Za-z]/;
const _GS1_SEP=/<GS>|\{GS\}|\\x1d|\]C1/gi;
/* Python's str.strip() strips \x1c-\x1f and JS trim() does not — spell the cut out so both agree. */
const _GS1_STRIP=/^[ \t\r\n\v\f\x1c-\x1f\xa0]+|[ \t\r\n\v\f\x1c-\x1f\xa0]+$/g;

if(typeof window!=="undefined" && typeof window.GS1_SPLIT_AUTOFILL==="undefined") window.GS1_SPLIT_AUTOFILL=false;

function checkDigit(body){
  let t=0;
  for(let i=0;i<body.length;i++){ t += (+body[body.length-1-i]) * (i%2===0?3:1); }
  return String((10-(t%10))%10);
}
/* GTIN-14 → the CONSUMER barcode our catalog is keyed on.
   Returns a 12-digit UPC-A, or a 13-digit EAN-13 for imported goods.
   ⚠️ EAN-13 is not an edge case here: 5 live products use it (the NA wine
   range and imported produce). An earlier version returned null for them,
   which read as "not a real product" and blocked the scan entirely.
   ⛔ For UPC-A the check digit is RECOMPUTED over the 11-digit body — the
   GTIN's own check digit belongs to the 14-digit form and reusing it
   yields a plausible number that matches nothing. */
function gtin14ToConsumer(g){
  const d=(g||"").replace(/\D/g,"");
  if(d.length!==14) return null;
  const body=d.slice(1);                 // drop the packaging indicator → GTIN-13
  if(body[0]==="0"){                     // a UPC-A lives inside as 0 + 11 + check
    const b=body.slice(1,-1);
    return b+checkDigit(b);
  }
  /* ⛔⛔ B14 (2026-09-23): RECOMPUTE THE EAN-13 CHECK TOO. This returned the
     13 digits after the indicator — whose last digit is the GTIN-14's check, not
     the EAN-13's. They agree only when the indicator is 0; a case code with
     indicator 1-8 produced a plausible EAN that matches nothing (34 catalog
     EANs affected). Same arithmetic as the UPC-A branch above. */
  const b13 = body.slice(0,-1);
  return b13 + checkDigit(b13);
}
const eom=(y,m)=>new Date(y,m,0).getDate();
const iso3=(y,m,d)=>`${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;

/* ---- "today" — pinned by the vectors, the real day for the page ---- */
function _gs1Today(t){
  if(t===undefined||t===null||t===""){ const n=new Date(); return {y:n.getFullYear(),m:n.getMonth()+1,d:n.getDate()}; }
  if(t instanceof Date) return {y:t.getFullYear(),m:t.getMonth()+1,d:t.getDate()};
  const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(t));
  if(!m) throw new Error("gs1: bad today "+t);
  return {y:+m[1],m:+m[2],d:+m[3]};
}
function _gs1IsRealDate(iso){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso||""));
  if(!m) return false;
  const d=new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
  return d.getUTCFullYear()===+m[1] && d.getUTCMonth()===+m[2]-1 && d.getUTCDate()===+m[3];
}
function _gs1AddDays(t,n){ const x=new Date(Date.UTC(t.y,t.m-1,t.d+n)); return iso3(x.getUTCFullYear(),x.getUTCMonth()+1,x.getUTCDate()); }
function _gs1AddYears(t,n){
  const y=t.y+n; let d=t.d;
  if(t.m===2 && d===29){ const leap=(y%4===0&&y%100!==0)||y%400===0; if(!leap) d=28; }   // Feb 29 → Feb 28
  return iso3(y,t.m,d);
}

/* ⛔⛔ B11 (2026-09-23): AN IMPOSSIBLE DATE MUST BE REFUSED WHERE IT IS ENTERED.
   The shape checks below pad digits and never test the day-of-month, so "290231"
   came back as 2029-02-31: accepted, shown on screen, and then quietly DROPPED
   at save (SharePoint refuses it) — the operator saw a date that was never
   recorded. ⭐ Anything that is not a real calendar day is now `null`, so every
   caller already treats it as "could not read that date" and asks again. */
function parseGs1Date(v,today){
  const d = parseGs1DateShape(v,today);
  return (d && _gs1IsRealDate(d)) ? d : null;
}
function parseGs1DateShape(v,today){
  const s=String(v||"").trim(); if(!s) return null;
  const T=_gs1Today(today);
  /* ⛔ ISO FIRST. A label date barcode reads "2029/03/31"; the M/D/Y branch
     below parses 2029 as a month, fails, and the whole scan was rejected as
     UNREADABLE — 4 times in one shift (2026-08-18). */
  const iso=s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if(iso){ const yy=+iso[1], mm=+iso[2], dd=+iso[3];
    if(mm>=1&&mm<=12) return iso3(yy,mm,dd||eom(yy,mm));
    return null; }
  const m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if(m){ let mm=+m[1],dd=+m[2],yy=+m[3]; if(yy<100) yy+=2000;
    if(mm<1||mm>12) return null; return iso3(yy,mm,dd||eom(yy,mm)); }
  const d=s.replace(/\D/g,""); if(d.length!==6) return null;
  let yy=2000+ +d.slice(0,2), mm=+d.slice(2,4), dd=+d.slice(4,6);
  if(mm<1||mm>12) return null;
  if(yy-T.y>50) yy-=100;
  return iso3(yy,mm,dd||eom(yy,mm));      // DD=00 means end of month
}
function normalize(a,today){
  const o={...a};
  /* ⛔⛔ B11 (2026-09-23): A DATE AI THAT WILL NOT PARSE IS DROPPED, NOT KEPT RAW.
     A failed parse used to leave the six raw digits in place, so a label reading
     (17)290231 handed `best` the string "290231": no date prompt, a nonsense
     "date" on screen, and SharePoint then refused it at save. ⭐ Without the AI
     the scan is simply undated, so the operator is asked — the honest outcome. */
  for(const ai of DATE_AIS) if(Object.prototype.hasOwnProperty.call(o,ai)){
    const p=parseGs1Date(o[ai],today);
    if(p) o[ai]=p; else delete o[ai];
  }
  return o;
}
/* ⛔⛔ A BARE PRODUCT BARCODE IS NOT AN ELEMENT STRING — DO NOT PARSE IT AS ONE.
   Found 2026-08-16 in Matt's 2026-08-14 test scans: all three `keyed_bare` rows
   saved a LOT equal to their own GTIN. A bare ITF-14 case barcode begins with the
   packaging indicator, and for US UPC-A goods that makes the first two digits
   "10" — which the element-string walker reads as AI (10) = LOT, then swallows
   the rest of the barcode as the lot value.

   ⛔ The observed damage was a junk `lot`. The LATENT damage is far worse: an
   ITF-14 beginning "17" parses as AI (17) = BEST BY. Verified —
   `17250630123457` yields `{"12":"3457","17":"2025-06-30"}`. The page would
   accept that FABRICATED date without prompting and stamp it `source='gs1'`,
   the source we trust most, straight into an append-only ledger.
   ⚠️ It also breaks the other way: a legitimate UPC-A beginning "01" is read as
   AI (01), yields a 10-digit GTIN, fails the check digit, and is REJECTED.

   The test cannot be "does it start with a known AI" — that is exactly what
   misfires. It is "was this ever an element string at all":
     * bracketed  "(01)..."                       → yes
     * an AIM symbology id "]C1" "]d2" "]Q3" …    → yes
     * a GS separator present (real or <GS> {GS} \x1d) → yes
   Otherwise, an all-digit string of length 12 / 13 / 14 is a bare UPC-A /
   EAN-13 / GTIN-14 and must bypass this parser completely.
   ⚠️ Other all-digit lengths still go through: a genuine GS1-128 carrying only
   fixed-length AIs (e.g. (01)+14 then (17)+6 = 22 digits) arrives with no
   brackets and no separator, and must still parse. */
function looksLikeElementString(s){
  _GS1_SEP.lastIndex=0;
  if(/[()]/.test(s) || s.includes(GS) || _GS1_SEP.test(s) || _GS1_AIM.test(s)) return true;
  _GS1_SEP.lastIndex=0;
  const digits = /^\d+$/.test(s);
  if(digits && (s.length===12 || s.length===13 || s.length===14)) return false;
  return true;
}

function _gs1MatchAi(s,i){
  for(const w of [2,3,4]){ const c=s.slice(i,i+w); if(FIXED[c]||VAR[c]) return c; }   // the AI table is prefix-free
  return null;
}
function _gs1InWindow(ai,iso,T){
  const w=_GS1_WINDOW[ai];
  const lo = w[0]==="d" ? _gs1AddDays(T,-w[1]) : _gs1AddYears(T,-w[1]);
  const hi = w[2]==="d" ? _gs1AddDays(T,w[3])  : _gs1AddYears(T,w[3]);
  return lo<=iso && iso<=hi;                 // ISO strings compare chronologically
}
/* STRICT parse of the tail of a swallowed variable value, or null.
   Must parse COMPLETELY, must not repeat an AI already parsed earlier in the string or inside the tail
   (⛔ §9.7: a lot like `A17251017` otherwise yields a fake best-by), must carry ≥1 date AI, and every date AI
   must be a REAL date inside its window. */
function _gs1ParseTail(t,banned,today){
  const T=_gs1Today(today);
  const out={}; let i=0;
  while(i<t.length){
    const ai=_gs1MatchAi(t,i);
    if(ai===null || banned.has(ai) || Object.prototype.hasOwnProperty.call(out,ai)) return null;
    i+=ai.length;
    let val;
    if(FIXED[ai]){
      const L=FIXED[ai]; val=t.slice(i,i+L);
      if(val.length!==L || !/^[0-9]+$/.test(val)) return null;
      i+=L;
    } else {
      val=t.slice(i);
      if(val.length<1 || val.length>VAR[ai]) return null;
      i=t.length;
    }
    out[ai]=val;
  }
  const dates=Object.keys(out).filter(a=>_GS1_WINDOW[a]);
  if(!dates.length) return null;
  for(const a of dates){
    const d=parseGs1Date(out[a],today);
    if(!d || !_gs1InWindow(a,d,T)) return null;
  }
  return out;
}
/* The lot-swallow split for variable value `v` that ran to END OF STRING (a keyboard scanner never sends GS).
   Returns null | {kind:"split",k,tail,ks} | {kind:"ambiguous",ks}.
   k = len(v)-8 when that is a candidate, else the single candidate, else ambiguous. */
function _gs1TrySplit(ai,v,parsed,today){
  const banned=new Set(Object.keys(parsed)); banned.add(ai);
  const hi=Math.min(VAR[ai], v.length-8);
  const cands={}; const ks=[];
  for(let k=1;k<=hi;k++){
    const tail=_gs1ParseTail(v.slice(k),banned,today);
    if(tail!==null){ cands[k]=tail; ks.push(k); }
  }
  if(!ks.length) return null;
  const pref=v.length-8;
  if(cands[pref]) return {kind:"split",k:pref,tail:cands[pref],ks};
  if(ks.length===1) return {kind:"split",k:ks[0],tail:cands[ks[0]],ks};
  return {kind:"ambiguous",ks};
}
function _gs1Walk(s,today){
  const out={}; let i=0, stop=null, split=null; const n=s.length;
  while(i<n){
    if(s[i]===GS){ i++; continue; }
    const ai=_gs1MatchAi(s,i);
    if(ai===null){ stop={offset:i,reason:"unknown_ai"}; break; }
    const start=i; i+=ai.length;
    if(FIXED[ai]){
      const L=FIXED[ai]; out[ai]=s.slice(i,i+L); i+=L;
      if(out[ai].length<L){ stop={offset:start,reason:"truncated"}; break; }
      continue;
    }
    let e=s.indexOf(GS,i); const atEnd=(e<0); if(atEnd) e=n;
    const val=s.slice(i,e);
    if(atEnd){
      const r=_gs1TrySplit(ai,val,out,today);
      if(r && r.kind==="split"){
        out[ai]=val.slice(0,r.k); Object.assign(out,r.tail);
        split={from:ai,k:r.k,ambiguous:false,ks:r.ks,ais:Object.keys(r.tail).sort()};
        i=n; break;
      }
      if(r) split={from:ai,k:null,ambiguous:true,ks:r.ks};
    }
    if(val.length>VAR[ai]){ stop={offset:start,reason:"overlong"}; break; }
    out[ai]=val; i=e;
  }
  return {out,stop,split};
}
function parseElementString(scan,today){
  let s=String(scan||"").replace(_GS1_STRIP,""); if(!s) return {};
  const am=_GS1_AIM.exec(s); if(am) s=s.slice(am[0].length);     // strip ONE leading AIM symbology id
  s=s.replace(_GS1_SEP,GS);                                       // later ]C1 \x1d <GS> {GS} = separator
  if(!looksLikeElementString(s)) return {};
  if(s.includes("(")){
    const out={}; let m; const re=/\((\d{2,4})\)\s*([^(]*)/g;
    while((m=re.exec(s))) out[m[1]]=m[2].trim();
    return normalize(out,today);
  }
  const w=_gs1Walk(s,today);
  const res=normalize(w.out,today);
  if(w.split) res._split=w.split;
  if(w.stop) res._stop=w.stop;
  return res;
}

/* ---------- the split policy hook (the PARSER only reports; the PAGE decides) ---------- */
function gs1SplitAutofills(ais){
  return !!(ais && ais._split && !ais._split.ambiguous && window.GS1_SPLIT_AUTOFILL===true);
}
/* -> {date, fromSplit}. (17) then (15) — but ⛔ (round-2 audit 2026-10-19) a date AI PRINTED on the label always beats one the
   lot-swallow split RECOVERED (a real (15) + a lot ending in "17YYMMDD"). Same rule as gs1_case_label.best_by_of. */
function gs1BestBy(ais){
  const sp=new Set(((ais&&ais._split)||{}).ais||[]);
  for(const a of ["17","15"]) if(ais && ais[a] && !sp.has(a)) return {date:ais[a], fromSplit:false};
  for(const a of ["17","15"]) if(ais && ais[a]) return {date:ais[a], fromSplit:true};
  return {date:"", fromSplit:false};
}
function gs1SplitNeedsConfirm(ais){
  return !!(ais && ais._split && !ais._split.ambiguous && window.GS1_SPLIT_AUTOFILL!==true);
}
