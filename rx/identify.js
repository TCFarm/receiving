/* receiving/rx/identify.js — TO IDENTIFY + FINISH TRUCK (build wave B2, plan 2026-10-21 §4b; PM-2991). OWNER: Procurement & Merchandising
   (hosted in ProductPipeline/receiving).

   The unknown-code card leads with ONE primary action, "Open the case — scan one unit"; the secondary ones are "Find it by name" and
   "Sealed — can't open now". Sealed SAVES THE DATE (the date still outranks identification, Jack 2026-09-03) and records the carton
   unnamed, says to put it on the HOLD shelf, and lists it here. Every unnamed carton recorded on this tablet lands here.
   ⭐ The skip lives INSIDE this panel (plan §4b), with two presets per carton:
       New product (not set up)      → a SKIPPED record with the shared reason "different product - new item" (the same words the
                                       learn flow's "Not the same" writes: one reason vocabulary, C2); keep it on the HOLD shelf.
       We carry it — barcode changed → the Learn flow (open the case, three ticks) for that carton's code, WITHOUT replaying the scan:
                                       the carton is already recorded, and its date attaches when the code resolves.
     and, while an unknown card is open, "Skip this carton — not recorded" for the CURRENT carton, which asks why (Jack 2026-09-03:
     a skip is data). ⛔ The card itself no longer offers Skip.
   ⭐ FINISH TRUCK lists what is still to identify — one more tap, never a block.
   Storage: localStorage `toid_v1` = [{k, code, learn, best, units, at, state: open|new|learned|gone}] (last 14 days). Per tablet:
   the shared, durable record is the receipt row itself (sku !PENDING_ID with its codes), which the drain promotes once the code
   resolves. This list is the crew's to-do, not the ledger.
   API: window.RXIdentify = { add, open, list, count, render } */
(function(){
"use strict";
const KEY = "toid_v1", KEEP_DAYS = 14;
const e_ = (s) => (typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])));
const ls = { get(){ try{ const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v : []; }catch(_){ return []; } },
             set(v){ try{ localStorage.setItem(KEY, JSON.stringify(v)); }catch(_){} } };
let L = ls.get().filter(x => x && x.k && Date.now() - (x.at || 0) < KEEP_DAYS * 86400000);
let mode = null;                                   // null | "list" | "finish"
/* a carton whose history row was deleted on this tablet is not to identify any more (review LOW 6) */
const rowGone = (x) => { try{ return x.n != null && typeof rows !== "undefined" && rows.some(r => r.n === x.n && r.deleted); }catch(_){ return false; } };
const open_ = () => L.filter(x => x.state === "open" && !rowGone(x));
const save = () => { ls.set(L); render(); };
const curPending = () => { try{ return (typeof pending !== "undefined" && pending && String((pending.prod || {}).sku || "").startsWith("!")) ? pending : null; }catch(_){ return null; } };
/* review HIGH 2: "busy" is ANY carton in progress — a question (pending), an armed unit scan, an unresolved code, the name search, or
   anything in #promptArea. Opening the learn flow over any of them would drop that carton and its typed date. */
const anyPending = () => {
  try{ if(typeof pending !== "undefined" && pending) return true; }catch(_){}
  try{ if(typeof unitScanFor !== "undefined" && unitScanFor) return true; }catch(_){}
  try{ if(typeof unresolved !== "undefined" && unresolved) return true; }catch(_){}
  const pa = document.getElementById("promptArea"); return !!(pa && pa.innerHTML.trim());
};
const refocus = () => { const sc = document.getElementById("scan"); if(sc) try{ sc.focus(); }catch(_){} };   /* review MEDIUM 4: the next scan must land */
function when(ms){ const d = new Date(ms); return d.toLocaleString([], {month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit"}); }

/* called by the page's commit_ for every UNNAMED carton (sku "!…"); `p` is the committed pending object, `row` the saved row */
function add(p, row){
  if(!p || !String((p.prod || {}).sku || "").startsWith("!") || p.known) return;      // a product being set up attaches by itself
  if(row && row.audit) return;                                                         // an audit sweep is not a truck (review LOW 8)
  const code = String((p.pendingCodes || "").split(" ")[0] || p.gtin || p.upc || "");
  if(!code) return;
  const k = String((row && (row.id || row.n)) || "") + "|" + code + "|" + Date.now();
  L.unshift({k, n: row && row.n != null ? row.n : null, code, learn: String(p.upc || "").replace(/\D/g, "") || code.replace(/\D/g, ""), best: p.best || "", units: row && row.units != null ? row.units : (p.qty != null ? p.qty : null),
             at: Date.now(), state: "open", sealed: !!p.sealed});
  save();
  if(window.RX && RX.toast) RX.toast("Recorded without a product — put the case on the HOLD shelf. It is in To identify.");
}

function chipHtml(){
  const n = open_().length;
  return `<button type="button" class="rx-btn" data-act="toid-open" id="toidChip">To identify <strong>(${n})</strong></button>
          <button type="button" class="rx-btn" data-act="toid-finish" id="toidFinish">Finish truck</button>`;
}
function render(){
  const a = document.getElementById("toIdArea");
  if(a) a.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0">${chipHtml()}</div>`;
  const inCard = document.getElementById("toidCard");
  if(inCard) inCard.innerHTML = `To identify <strong>(${open_().length})</strong> — skip is in here`;
  if(mode) panel();
}
function rowHtml(x){
  const busy = anyPending();
  const learnOk = window.RXLearn && RXLearn.validCheck && RXLearn.validCheck(x.learn);
  return `<div class="toid-row" data-toid="${e_(x.k)}" style="padding:10px 0;border-top:1px solid var(--line)">
      <div><span class="num"><strong>${e_(x.code)}</strong></span> · best-by ${e_(x.best || "—")} · ${x.units == null ? "? units" : e_(x.units) + " units"} · ${e_(when(x.at))}</div>
      <div style="margin-top:7px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="rx-btn" data-act="toid-new" data-k="${e_(x.k)}">New product (not set up)</button>
        <button type="button" class="rx-btn" data-act="toid-learn" data-k="${e_(x.k)}" ${busy || !learnOk ? "disabled" : ""}>We carry it — barcode changed</button>
      </div>
      ${!learnOk ? `<div class="hint">This code fails its check digit (a mis-read), so it cannot be learned — rescan the case.</div>`
        : busy ? `<div class="hint">Finish the case on screen first, then learn this one.</div>` : ""}
    </div>`;
}
function panel(){
  let o = document.getElementById("toidPanel");
  if(!mode){ if(o) o.remove(); return; }
  if(!o){ o = document.createElement("div"); o.id = "toidPanel"; o.className = "rx-overlay"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true");
    o.style.cssText = "position:fixed;inset:0;z-index:55;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:max(16px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 16px max(16px,env(safe-area-inset-left,0px));overflow:auto";
    document.body.appendChild(o); }
  const list = open_(), cur = curPending();
  const head = mode === "finish"
    ? (list.length ? `<strong>Before you finish this truck:</strong> ${list.length} case${list.length === 1 ? "" : "s"} still to identify. Name the ones you can; the rest stay on the HOLD shelf. Nothing here stops you finishing.`
                   : `<strong>Nothing left to identify.</strong> This truck is done on this tablet.`)
    : `Cases recorded without a product. Their date is saved; each waits on the HOLD shelf until it is named.`;
  o.innerHTML = `<div class="toid-sheet" style="position:relative;background:var(--card,#fff);color:var(--ink,#222);max-width:640px;width:100%;border-radius:8px;padding:14px 16px">
      <header style="display:flex;justify-content:space-between;align-items:center;gap:8px"><strong>${mode === "finish" ? "Finish truck" : "To identify"}</strong>
        <button type="button" class="rx-btn" data-act="toid-close" data-close="3">Close</button></header>
      <p style="margin:8px 0">${head}</p>
      ${cur ? `<div data-k="toid-current" style="padding:10px;border:1px solid var(--line);border-radius:6px;margin-bottom:8px">
          The case on screen (<span class="num">${e_(String((cur.pendingCodes || "").split(" ")[0] || cur.upc || ""))}</span>) is not recorded yet.
          <button type="button" class="rx-btn" data-act="toid-skip-current" style="margin-left:6px">Skip this carton — not recorded</button></div>` : ""}
      ${list.map(rowHtml).join("") || (mode === "finish" ? "" : `<div class="hint">Nothing to identify.</div>`)}
      ${mode === "finish" && window.RX && RX.short ? RX.short.finishHtml() : ""}
      ${mode === "finish" ? `<div style="margin-top:12px"><button type="button" class="primary rx-btn" data-act="toid-close" data-close="3">Finish — the rest stay on the HOLD shelf</button></div>` : ""}
    </div>`;
}
function set(k, state){ const x = L.find(y => y.k === k); if(x){ x.state = state; x.doneAt = Date.now(); save(); } return x; }

const ACTS = {
  "toid-open": () => { mode = "list"; panel(); },
  "toid-finish": () => { mode = "finish"; panel(); },
  "toid-close": () => { mode = null; panel(); refocus(); },
  "toid-new": (a) => {
    const x = L.find(y => y.k === a.el.getAttribute("data-k")); if(!x || x.state !== "open") return;
    try{ if(typeof reject === "function") reject("SKIPPED", `${x.code} :: different product - new item`, x.code); }catch(_){}
    set(x.k, "new");
    if(window.RX && RX.toast) RX.toast("Marked as a new product — keep it on the HOLD shelf; Purchasing sets it up.");
  },
  "toid-learn": (a) => {
    const x = L.find(y => y.k === a.el.getAttribute("data-k")); if(!x || x.state !== "open" || anyPending() || !window.RXLearn) return;
    if(!RXLearn.setCandidate({code: x.learn, raw: x.code})) return;
    mode = null; panel();
    RXLearn.start(null, {noReplay: true, onLearned: () => set(x.k, "learned"), onDifferent: () => set(x.k, "new")});
  },
  "toid-skip-current": () => {
    if(!curPending()) return;
    mode = null; panel();
    if(typeof askSkipReason === "function") askSkipReason();
  },
};
/* ⭐ a LITERAL list: the act-coverage gate reads it (Object.keys() is invisible to it) */
if(window.RX && RX.registerAct){
  for(const n of ["toid-open", "toid-finish", "toid-close", "toid-new", "toid-learn", "toid-skip-current"]) RX.registerAct(n, (a) => { ACTS[n](a); return "stop"; });
}
/* review HIGH 1: Escape closes THIS panel only. Without preventDefault the page's own Escape handler (closeTopPanel) then ran and
   cancelled the carton on screen with its typed date. Capture phase + stopImmediatePropagation, so nothing else sees this Escape. */
document.addEventListener("keydown", (e) => {
  if(e.key === "Escape" && mode){ e.preventDefault(); e.stopImmediatePropagation(); mode = null; panel(); refocus(); }
}, true);
setTimeout(render, 500);
window.RXIdentify = { add, open: (m) => { mode = m || "list"; panel(); }, close: () => { mode = null; panel(); }, list: () => L.slice(), count: () => open_().length, render, chipHtml };
})();
