/* Focused behavioural test of the 2026-08-26 receiving-page fixes, run under jsc.
   Replicates the exact code shapes from index.html — no DOM needed. */
let P=0,F=0;
function chk(label, got, want){
  const ok = JSON.stringify(got)===JSON.stringify(want);
  print((ok?"  PASS  ":"  FAIL  ")+label+"   got="+JSON.stringify(got)+" want="+JSON.stringify(want));
  ok?P++:F++;
}
const FIELD={sku:"sku",upc:"upc",gtin14:"gtin14",best_by:"best_by",lot:"lot",
             units:"units",source:"source",operator:"operator",po_ref:"po_ref",device:"device"};
const REQUIRED=["sku","upc","gtin14","best_by","lot","units","source","operator","po_ref","device"];

/* ── FIX A: an empty best_by must be OMITTED, not sent as "" ─────────────── */
function buildFields(row){
  const v={ upc:row.upc, sku:"S1", gtin14:"", best_by:row.best || "",
            lot:"", units:1, source:"keyed_bare", operator:"o", po_ref:"", device:"d" };
  const fields={ Title:"AUDIT S1 "+(row.best||"(no date yet)") };
  for(const k of REQUIRED) fields[FIELD[k]] = v[k];
  if(!row.best) delete fields[FIELD.best_by];        // THE FIX
  return fields;
}
const noDate = buildFields({upc:"019962720017", best:""});
chk("no-date row OMITS best_by (SharePoint 400 cause)", "best_by" in noDate, false);
chk("no-date row still carries sku/units",
    [noDate.sku, noDate.units], ["S1", 1]);
chk("no-date Title says so rather than trailing blank",
    noDate.Title, "AUDIT S1 (no date yet)");
const withDate = buildFields({upc:"019962720017", best:"2027-06-04"});
chk("dated row DOES send best_by", withDate.best_by, "2027-06-04");

/* ── FIX B: the unsaved counter must not drift negative ──────────────────── */
let queue=0; const rows=[];
function saveSim(r, succeed){
  if(succeed){ r.saved="saved"; queue--; }
  else { r.saved="FAILED"; queue--; }           // save() decrements on BOTH paths
}
function retrySim(){                            // WITH the fix
  const stuck = rows.filter(r=>r.saved==="FAILED");
  for(const r of stuck){ r.saved="queued"; r.err=""; queue++; }
  for(const r of stuck) saveSim(r, false);
}
for(let i=0;i<6;i++){ const r={saved:"queued"}; rows.push(r); queue++; }
for(const r of rows) saveSim(r,false);
chk("after 6 failures queue is 0", queue, 0);
for(let c=0;c<5;c++) retrySim();
chk("after 5 retry cycles queue is STILL 0 (was -5 before the fix)", queue, 0);

function retryBuggy(){                          // WITHOUT the fix, for contrast
  const stuck = rows.filter(r=>r.saved==="FAILED");
  for(const r of stuck){ r.saved="queued"; r.err=""; }
  for(const r of stuck) saveSim(r, false);
}
let q2=0; const rows2=[];
for(let i=0;i<6;i++){ const r={saved:"queued"}; rows2.push(r); q2++; }
(function(){ const R=rows2; for(const r of R){ r.saved="FAILED"; q2--; } })();
(function(){ for(let c=0;c<5;c++){ const stuck=rows2.filter(r=>r.saved==="FAILED");
  for(const r of stuck){ r.saved="queued"; } for(const r of stuck){ r.saved="FAILED"; q2--; } } })();
chk("the OLD code would have shown a negative count", q2 < 0, true);

/* ── FIX D: discard offered ONLY when every unsaved row is exhausted ─────── */
function canOfferDiscard(states){
  const unsaved = states.filter(s=>s!=="saved").length;
  const dead    = states.filter(s=>s==="FAILED").length;
  return unsaved>0 && dead===unsaved;
}
chk("all-failed -> offer discard", canOfferDiscard(["FAILED","FAILED"]), true);
chk("one still in flight -> do NOT offer", canOfferDiscard(["FAILED","queued"]), false);
chk("nothing unsaved -> no prompt at all", canOfferDiscard(["saved","saved"]), false);



/* ═══════════════════════════════════════════════════════════════════════════
   AUDIT FIXES, 2026-08-26 (second pass). Each block is a defect that was LIVE.
   ═══════════════════════════════════════════════════════════════════════════ */
print("\n-- audit fixes --");

/* #1 `unresolved` leaked across cases -> a permanent alias + a best-by on the
   WRONG product. Cleared on every resolved scan, plus a 4-minute expiry. */
const UNRESOLVED_MS = 4*60*1000;
let unresolved = null;
function unknownScan(code, now){
  if(unresolved && (now - (unresolved.t||0)) > UNRESOLVED_MS) unresolved = null;
  if(unresolved){ if(!unresolved.codes.includes(code)) unresolved.codes.push(code); }
  else unresolved = {raw:code, codes:[code], t:now};
}
function resolvedScan(){ if(unresolved) unresolved = null; }
unknownScan("CASE_A", 0);
resolvedScan();                                  // an ordinary scan happens
unknownScan("CASE_B", 1000);
chk("a resolved scan ENDS the unresolved case", unresolved.codes, ["CASE_B"]);
unresolved = null;
unknownScan("CASE_A", 0);
unknownScan("CASE_B", 5*60*1000);                // 5 min later, no scan between
chk("a stale collection expires (4 min)", unresolved.codes, ["CASE_B"]);
unresolved = null;
unknownScan("CASE_A", 0);
unknownScan("CASE_A2", 30*1000);                 // same box, 30 s later
chk("two codes off the SAME box still pair", unresolved.codes, ["CASE_A","CASE_A2"]);

/* #2 row.n collided after the Discard splice -> corrections PATCHed the wrong
   SharePoint item. Now a monotonic sequence. */
let rowSeq=0; const nextRowN=()=>++rowSeq;
const R=[]; const add=()=>{const r={n:nextRowN(),saved:"queued"};R.unshift(r);return r;};
const r1=add(), r2=add(), r3=add(), r4=add();
r1.saved="saved"; r4.saved="saved"; r2.saved="FAILED"; r3.saved="FAILED";
for(const r of R.filter(x=>x.saved==="FAILED")){ R.splice(R.indexOf(r),1); }
add(); add();
chk("no duplicate n after discard + new scans",
    R.map(r=>r.n).length === new Set(R.map(r=>r.n)).size, true);
chk("the saved row is still uniquely findable",
    R.filter(r=>r.n===r4.n).length, 1);

/* #3/#4 prompt lifecycle: a prompt holding a control must not auto-dismiss, and
   a stale timer must not wipe a later prompt. */
function shouldAutoDismiss(hasActionsArg, bodyHasControl){
  return !(hasActionsArg || bodyHasControl);
}
chk("button in BODY keeps the prompt up", shouldAutoDismiss(false, true), false);
chk("4th-arg actions keeps it up",        shouldAutoDismiss(true,  false), false);
chk("a plain message still auto-dismisses", shouldAutoDismiss(false, false), true);
/* ⛔ Model the REAL hazard: an orphaned timer from prompt #1 firing while
   prompt #2 is on screen. `cleared` counts clearTimeout calls; `fired` counts
   dismissals that actually happened. */
let handle=0, cleared=0, fired=0, live=new Set();
function armPrompt(persistent){
  if(handle){ cleared++; live.delete(handle); }          // clearTimeout(promptTimer)
  handle = 0;
  if(!persistent){ handle = ++handleSeq; live.add(handle); }
}
let handleSeq=0;
function tick(){ for(const h of [...live]){ fired++; live.delete(h); } }
armPrompt(false);          // a transient "Location set" prompt arms a timer
armPrompt(true);           // then a PERSISTENT date prompt opens
tick();                    // 2.8 s later the old timer would have fired
chk("the earlier timer was cancelled", cleared, 1);
chk("⛔ no stale timer wiped the persistent prompt", fired, 0);
armPrompt(false); tick();
chk("a transient prompt still dismisses itself", fired, 1);

/* #5 dropDead honours the pressed mode instead of inverting */
function wantMode(dataMode, pendingMode, isAudit){
  return dataMode || pendingMode || (isAudit ? "receive" : "audit");
}
chk("tapping 'receive' in RECEIVE yields receive", wantMode("receive", null, false), "receive");
chk("tapping 'audit' yields audit",                wantMode("audit",   null, false), "audit");

/* #6 calendar validation + permanent-error classification */
function isRealDate(iso){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso||""));
  if(!m) return false; const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));
  return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3];}
chk("Feb 31 rejected",  isRealDate("2029-02-31"), false);
chk("real date accepted", isRealDate("2027-06-04"), true);
chk("garbage rejected",  isRealDate("261340"), false);
const perm = st => st>=400 && st<500 && st!==429 && st!==408;
chk("400 is permanent -> stop retrying", perm(400), true);
chk("429 is NOT permanent",              perm(429), false);
chk("408 is NOT permanent",              perm(408), false);
chk("503 is NOT permanent",              perm(503), false);

/* #7 a re-save must not start on an in-flight row */
const canResave = (state, inflight) =>
  (state==="FAILED"||state==="UNSAVEABLE") && !inflight;
chk("in-flight row is NOT re-saved", canResave("queued", true), false);
chk("queued-but-not-in-flight is NOT re-saved (wrong state)", canResave("queued", false), false);
chk("FAILED row IS re-saved",        canResave("FAILED", false), true);
chk("UNSAVEABLE row IS re-saved once corrected", canResave("UNSAVEABLE", false), true);

/* #10 the date-cell field promises MMDDYY and must swap like askDate */
function cellParse(raw){
  const sw = /^\d{6}$/.test(raw) ? raw.slice(4,6)+raw.slice(0,4) : raw;
  const m = sw.match(/^(\d{2})(\d{2})(\d{2})$/);
  if(m){ const yy=+m[1]; return `${yy<70?2000+yy:1900+yy}-${m[2]}-${m[3]}`; }
  return /^\d{4}-\d{2}-\d{2}$/.test(sw) ? sw : null;
}
chk("'120126' MMDDYY -> 2026-12-01", cellParse("120126"), "2026-12-01");
chk("'033129' MMDDYY -> 2029-03-31", cellParse("033129"), "2029-03-31");
chk("ISO still accepted",            cellParse("2027-06-04"), "2027-06-04");

/* #15 the no-date flag is resettable, and matches the real object shape */
let noDateSkus = {"SOAP1":1};
function clearNoDate(sku){ if(!sku||!noDateSkus[sku]) return false;
  delete noDateSkus[sku]; return true; }
chk("entering a date clears the flag", clearNoDate("SOAP1"), true);
chk("…and it is gone", !!noDateSkus["SOAP1"], false);
chk("clearing an unflagged sku is a no-op", clearNoDate("OTHER"), false);

print("\n"+P+" passed, "+F+" failed");
