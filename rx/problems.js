/* receiving/rx/problems.js — WHAT IS WRONG WITH A SCAN, AND THE ONE BUTTON THAT FIXES IT (2026-10-22). Also: FIX A SCAN from any day
   or tablet (a wrong count, or the same case scanned twice). OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).
   Plan: Procurement & Merchandising/plans/2026-10-22-receiving-crew-walls-PLAN.md.

   Why (the crew, 2026-10-22): "We can't figure out how to resolve the problems or what the problem is that is holding it up" ·
   "Mozzarella somehow got received as 2 cs … can't edit in the receiving app". The chips said "Held for the buyer · temperature not
   confirmed" or "Staged → Freezer floor" and offered nothing; a scan from yesterday could not be touched at all.

   ═══ THE MAP (ONE place — the PO drawer, the row drawer and the history table all read P.of) ═══
     staged (not put away)      "On a cart … not in Finale until it is on a shelf"   → [Put away now]          opens Put away staged
     staged, line already full  "Finale already has all of this line … same case scanned again" → [Same case — remove this record]
                                 (+ [It's a second case — put it away]); "full" = PO.confirmed (pack + posted), never another staged scan
     held TEMP_UNCONFIRMED      "<item> is filed as <class>; <bin> is a <x> shelf"  → [Yes, it belongs in <bin>]
                                 = cancel the held intent (If-Match) THEN a fresh intent with TempConfirmed=true (same case, units, bin,
                                   best-by, BB row). ⭐ The poster checks the new one from scratch (over-receipt, Finale-app overlap); a
                                   held intent is never re-evaluated and one older than 14 h would be STALE, so a release cannot work.
     held OVER_UNCONFIRMED      "Finale already has all we ordered — this scan would be extra" → [Counted twice — remove it]
                                 (+ [KeHE really sent more] → a fix row for the buyer, who adds the line in Finale)
     refused (any but NOT_STAFF) / denied "… It did not go into Finale"    → [Remove it — I'll scan it again]
     refused NOT_STAFF          the poster flagged its OWN edit (PM-2983) — WITH THE BUYER, nothing for the crew, not counted
     held (any other reason)    the reason in words                          → [Tell the buyer]                a Kind=fix row
     damaged / waiting / posted  not a problem (the chip already says it)
   "Remove" = cancel the intent (never one already in Finale) AND delete its BB Receipts row — ⛔ unless another live intent shares that
   BB row (a split case: deleting it would erase the case's best-by).

   ═══ FIX A SCAN ═══ (PO drawer → a line → a scan → Fix)
     Count is wrong      BB row: PATCH units (page `bbFixItem`) · intent: not acted on ⇒ PATCH Units (If-Match); acted on ⇒ a fix row.
     Count is HIGHER on a scan in Finale (posted) ⇒ ⭐ RECEIVE THE REST (2026-10-23): the PO facts + a confirm card → ONE new intent for
                         the difference (OverConfirmed only past shipped-else-ordered), the scan's buyer count-up notes withdrawn.
     Scanned twice       intent: not in Finale ⇒ cancel; in Finale ⇒ a fix row "take N off in Finale" · BB row: delete (shared-row guard).
   ⛔ The tablet NEVER un-receives in Finale (Tier C stays with the buyer). ⛔ The best-by ledger is never written here: the BB Receipts
      item is corrected in place / deleted and ProductPipeline's drain (the ONE writer of receipts.csv) folds it in — a correction
      supersedes the row it names and keeps the original timestamp (receiving_drain._apply_revisions / _remove_deleted; a 404 sends
      !CORRECTION / !DELETION, which the drain applies the same way).
   ⛔ Every intent write is If-Match on the etag this tablet read; a 412 is re-read and the action is REFUSED if the poster (or another
      tablet) moved the intent since — the crew sees "It changed — the list is refreshed", never a silent second write.

   API (RX.problems): of(v) → {kind, owner, text, act?, label?, act2?, label2?}|null   forRow(row) → same (worst portion)
                      crewOpen(v) → bool   html(v, ctx) → the words + button(s)   fixHtml(v) → the Fix panel */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const P = RX.problems = {};
const I = RX.intents, t = RX.t, esc = RX.esc;

const COPY_ADD = {
  pb_staged:      "On a cart ({area}) since {age} — not in Finale until it is on a shelf.",
  pb_putaway:     "Put away now",
  pb_staged_dup:  "Finale already has all of this line ({n} of {m}) — this cart record ({area}, {age} ago) looks like the same case scanned again.",
  pb_dup_rm:      "Same case — remove this record",
  pb_dup_keep:    "It's a second case — put it away",
  fix_pending:    "Sent to the buyer: the count is {n} — the line shows the old count until the buyer corrects Finale.",
  fix_already_sent:"Already sent to the buyer: the count is {n}. Nothing else to do — the buyer corrects Finale.",
  pb_temp_ok:     "{cls} item on a {cls} shelf ({bin}) — sending it to Finale, nothing to answer.",
  pb_dup_auto:    "Same case as one already put away — nothing to do, this record clears itself.",
  pb_auto_dup:    "Counted as a duplicate automatically: the same item and best-by was put away later and Finale has the whole line.",
  pb_temp:        "{name} is filed as {cls}, but {bin} is a {bcls} shelf. Finale is waiting for a yes.",
  pb_temp_yes:    "Yes, it belongs in {bin}",
  pb_over:        "Finale already has all {n} we ordered — this scan would be extra.",
  pb_over_rm:     "Counted twice — remove it",
  pb_over_more:   "KeHE really sent more",
  pb_refused:     "{why}. It did not go into Finale.",
  pb_rm_rescan:   "Remove it — I'll scan it again",
  pb_denied:      "This tablet was not allowed to send it to Finale.",
  pb_buyer:       "With the buyer — flagged by mistake (being fixed). Nothing for you to do.",
  pb_held:        "Held: {why}.",
  pb_tell:        "Tell the buyer",
  pb_told:        "Sent to the buyer ✓",
  pb_busy:        "Working…",
  pb_changed:     "It changed on another tablet or in Finale — the list is refreshed. Look again.",
  pb_offline:     "Not saved — no signal or the sign-in expired. Try again.",
  pb_still_sending:"This tablet is still sending that scan — try again in a minute.",
  pb_done_temp:   "Sent again with your yes. It goes into Finale in a few minutes.",
  pb_done_rm:     "Removed.",
  pb_done_rm_bb:  "Removed. The best-by stays — another part of the same case uses it.",
  pb_done_more:   "The buyer will add the extra to the PO in Finale.",
  pb_bb_failed:   "The scan is fixed, but the best-by list did not update ({why}). Tap again.",
  pb_holding:     "What's holding this truck",
  pb_sum_staged:  "{n} on a cart",
  pb_sum_crew:    "{n} need you",
  pb_sum_buyer:   "{n} with the buyer",
  pb_none:        "Nothing is holding this truck.",
  fix_btn:        "Fix",
  fix_h:          "Fix this scan",
  fix_units:      "Units on this scan",
  fix_save:       "Save count",
  fix_twice:      "Scanned twice — remove this scan",
  fix_cancel:     "Cancel",
  fix_bad_n:      "Type a whole number of units (1 or more).",
  fix_same:       "That is the count it already has.",
  fix_in_finale:  "Already in Finale. A higher count receives the rest of the PO here; a lower count goes to the buyer.",
  fix_po:         "PO {po}: ordered {ordered}{cases} · KeHE shipped {shipped} · Finale has received {have}{coming}.",
  fix_po_cases:   " ({c} cases of {cq})",
  fix_po_coming:  " · {n} more scanned, going into Finale now",
  fix_po_unk:     "not known yet",
  recv_h:         "Receive {d} more into Finale?",
  recv_body:      "This case: {base} → {n}. The {d} will be dated {bb} on {loc}. Finale will then have {after} of {cap} {basis} for this PO line.",
  recv_over_h:    "That is {over} more than {basis_long}.",
  recv_over_body: "This case: {base} → {n}. Finale would then have {after} for this PO line. Only if you really have {n} in this case.",
  recv_case:      "This case: {old} on this scan + {more} received later = {total}.",
  recv_case_has:  "This case already has {total} ({old} on this scan + {more} received later). If it is still wrong, tell the buyer.",
  recv_cart:      "{n} of this item is still on a cart ({area}, {age} ago). If that is the case you mean, put it away instead.",
  recv_cart_go:   "Put it away",
  recv_retype:    "That is a lot more than one case. Type {n} again to confirm:",
  recv_retype_bad:"The numbers don't match — type {n} to confirm, or Back.",
  recv_who:       "Signed in as {who}.",
  recv_not_live:  "This tablet is not sending to Finale right now — tell the buyer. Nothing was saved.",
  fix_units_case: "Units in this case (1 case = {cq})",
  recv_yes:       "Receive {d} more",
  recv_yes_over:  "Yes — we got {over} extra",
  recv_back:      "Back",
  recv_done:      "Receiving {d} more — it goes into Finale in a few minutes.",
  recv_withdrawn: " The earlier note to the buyer was withdrawn.",
  recv_left:      " Tell the buyer to ignore the earlier note (it could not be withdrawn).",
  recv_noread:    "The PO could not be read — try again in a minute. Nothing was saved.",
  recv_bb_failed: "The best-by list did not update ({why}) — tell the buyer. Do NOT receive it again.",
  recv_changed:   "The numbers changed on another tablet or in Finale. Nothing was saved — check them, then Save count again.",
  fix_saved:      "Count saved.",
  fix_saved_noBb: "Count saved. The best-by list was not changed (the rest of this case could not be read) — tell the buyer.",
  fix_saved_finale:"Count fixed on the best-by list. The buyer will correct Finale.",
  fix_rm_q:       "Remove this scan?\n\n{name}\n{units} units · best-by {bb}\n\nOnly if the SAME case was scanned twice.",
  fix_rm_finale:  "Removed from the best-by list. The buyer will take {n} off in Finale.",
  /* PM-3108: a part of a case removed — the case's best-by row keeps the date and now counts only the parts still there */
  pb_done_rm_lower:"Removed. The best-by stays — another part of the same case uses it — and now counts {n} units.",
  pb_done_rm_noread:"Removed. The best-by list was not changed (the rest of this case could not be read) — tell the buyer.",
  fix_rm_finale_lower:"Taken off this case's best-by count ({n} left). The buyer will take {d} off in Finale.",
  /* PM-3109: "Scanned twice" on a scan whose rest was received later through Fix */
  fix_twice_rest: "This case also has {more} received later through Fix ({when}{fin}). Remove that one first — Fix on the {more}-unit scan → Scanned twice — then this one if it is still wrong. Nothing was changed.",
  fix_twice_rest_fin:" — already in Finale",
  fix_lower_sending:"The count {n} is going to the buyer (the note is still sending). The best-by list was not changed yet — tell the buyer.",
  fix_rm_finale_sending:"The buyer will take {n} off in Finale (the note is still sending). The best-by list was not changed yet — tell the buyer.",
  fix_rm_finale_noread:"The buyer will take {n} off in Finale. The best-by list was not changed (the rest of this case could not be read) — tell the buyer.",
  /* PM-3110: a LOWER count on a scan in Finale asks first, with units AND cases */
  fix_lower_h:    "Take {d} off in Finale?",
  fix_lower_body: "Finale has {old}{oldc} from this scan. You typed {n}{nc}. The buyer takes {d} off in Finale, and the best-by list is set to {n}.",
  fix_lower_c:    " ({c} of {cq})",
  fix_lower_cases:" = {c} case(s) of {cq}",
  fix_lower_units:" unit(s)",
  fix_lower_hint: "Counting CASES? {n} cases = {u} units. This box takes units.",
  fix_lower_yes:  "Yes — the count is {n}",
  fix_lower_case: "This case has {total} ({old} on this scan + {more} received later). To lower it, first remove the later {more} (Fix on that scan → Scanned twice), then fix this one — or tell the buyer. Nothing was saved.",
  fix_lower_done: "Sent to the buyer: the count is {n}. The best-by list now says {n} for this case.",
  fix_lower_done_noBb:"Sent to the buyer: the count is {n}. The best-by list was not changed (the rest of this case could not be read) — tell the buyer.",
  fix_lower_bbfail:"Sent to the buyer: the count is {n}.",
  /* PM-3111: the SKU is on more than one open PO — say which one Finale will fill */
  recv_po_multi:  "This item is on {k} open POs. Finale fills the oldest PO that has room first, so these go on PO {po}.",
  recv_po_multi_over:"This item is on {k} open POs. A confirmed extra goes on the OLDEST one: PO {po}.",
};
for(const k of Object.keys(COPY_ADD)) if(!(k in RX.COPY)) RX.COPY[k] = COPY_ADD[k];

const CLS = {R:"Refrigerated", F:"Frozen", D:"Dry"};
/* a shelf's temperature is its FIRST LETTER — R refrigerated, F frozen, D dry (Jack, 2026-10-23: "if it starts with an R, then it is a
   Refrig location"); the pack's bin table only when the name has no such letter */
const binCls = (bin) => { const l = String(bin || "").slice(0, 1).toUpperCase(); if(CLS[l]) return CLS[l]; const bi = RX.pack.binInfo(bin); return bi ? (CLS[bi.temp] || bi.temp || "") : ""; };
/* the item's class from the receiving catalog (the poster's own source since 2026-10-21) agrees with the shelf */
const tempAgrees = (v) => { const f = (v && v.fields) || {}; const si = RX.pack.skuInfo(f.Sku); const ic = si && si.cls; const bc = binCls(f.Location);
  return !!(ic && bc && ic === bc); };
const code = (fin) => String((fin && fin.FinReason) || "").split(":")[0].trim().toUpperCase();
const sentence = (fin) => { const r = String((fin && fin.FinReason) || ""); const i = r.indexOf(":"); return (i >= 0 ? r.slice(i + 1) : r).trim(); };
const nameOf = (sku) => { const i = RX.pack.skuInfo(sku); if(i && i.name) return i.name;
  try{ const p = CATALOG_BY_SKU[sku]; if(p && p.name) return p.name; }catch(_){} return sku || "this item"; };
const ageText = (iso) => { const ms = RX.now() - Date.parse(iso); if(isNaN(ms) || ms < 60000) return "1 min";
  if(ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + " min"; if(ms < 86400000) return Math.floor(ms / 3600000) + " h";
  return Math.floor(ms / 86400000) + " d"; };
const sameLoc = (v) => String((v.fields || {}).Location || "");
const fmtN = (x) => String(Math.round((+x || 0) * 100) / 100);
/* a fix row (Kind=fix) this tablet or any tablet already sent for this intent */
/* the buyer requests (Kind=fix rows) already sent for this scan, any tablet: [{FixUnits, FixNote, ScanAt}] */
function fixRowsFor(iid){
  const out = [];
  for(const x of (I.allPo ? I.allPo() : I.allToday())){ const f = x.fields || {}; if(f.Kind === "fix" && f.SplitOf === iid && f.State !== "cancelled") out.push(f); }
  return out;
}
P.fixRowsFor = fixRowsFor;
function fixSentFor(iid){
  for(const x of (I.allPo ? I.allPo() : I.allToday())){ const f = x.fields || {}; if(f.Kind === "fix" && f.SplitOf === iid) return true; }
  return false;
}
const BUSY = new Set();          // iids with an action in flight (one tap at a time per scan)
P.state = {msg: {}, fixing: null, fixErr: ""};

P.of = function(v){
  if(!v) return null;
  const f = v.fields || {}, fin = v.fin || {}, fs = fin.FinState || "";
  if(f.Kind === "fix" || f.State === "cancelled") return null;
  const rec = I.byId(v.iid);
  if(rec && rec.cancelled) return null;
  if(rec && rec.denied) return {kind:"denied", owner:"crew", text:t("pb_denied"), act:"pb-remove", label:t("pb_rm_rescan")};
  if(f.State === "staged" && !fs){
    if(P.isDup(v)) return {kind:"dup", owner:"none", text:t("pb_dup_auto")};
    /* ⭐ a case still "on a cart" whose PO line Finale ALREADY has in full was received AGAIN by a later scan (10-22: 16 frozen cases
       re-scanned with Put away here while their 10-20 cart records stayed staged). Putting it away would only hit the poster's
       over-receipt hold: removing the duplicate is the likely answer; Put away stays for a genuine second case. */
    const cf = RX.po && RX.po.confirmed ? RX.po.confirmed(f.Po, f.Sku) : null;
    if(cf && cf.ordered > 0 && cf.units >= cf.ordered)
      return {kind:"staged_dup", owner:"crew", text:t("pb_staged_dup", {n:fmtN(cf.units), m:fmtN(cf.ordered), area: f.StagedArea || "a cart", age: ageText(f.ScanAt)}),
              act:"pb-remove", label:t("pb_dup_rm"), act2:"pb-putaway", label2:t("pb_dup_keep")};
    return {kind:"staged", owner:"crew", text:t("pb_staged", {area: f.StagedArea || "staging", age: ageText(f.ScanAt)}), act:"pb-putaway", label:t("pb_putaway")};
  }
  if(fs === "held"){
    const c = code(fin);
    if(fixSentFor(v.iid)) return {kind:"told", owner:"buyer", text:t("pb_told")};
    if(c === "TEMP_UNCONFIRMED"){
      const bin = sameLoc(v), si = RX.pack.skuInfo(f.Sku);
      const bcls = binCls(bin) || "different";
      const cls = (si && si.cls) || (CLS[String(f.Sku || "").slice(0, 1).toUpperCase()] || "another class");
      /* ⭐ 2026-10-23 (Jack: "all locations that start with R are refrig"): a hold made under the poster's OLD rule (the item judged by
         its SKU's first letter — Elmhurst cashew milk DDair… read as Dry) whose item and shelf now AGREE is stale: it is confirmed
         automatically (P.autoTemp), never shown as a question that contradicts itself */
      if(tempAgrees(v)) return {kind:"temp_ok", owner:"none", text:t("pb_temp_ok", {cls, bin: bin || "that shelf"})};
      return {kind:"temp", owner:"crew", text:t("pb_temp", {name:nameOf(f.Sku), cls, bin: bin || "that shelf", bcls}),
              act:"pb-temp-yes", label:t("pb_temp_yes", {bin: bin || "that shelf"})};
    }
    if(c === "OVER_UNCONFIRMED"){
      const m = /expected (\d+(?:\.\d+)?)/.exec(String(fin.FinReason || ""));
      return {kind:"over", owner:"crew", text:t("pb_over", {n: m ? m[1].replace(/\.0+$/, "") : "the units"}),
              act:"pb-remove", label:t("pb_over_rm"), act2:"pb-tell", label2:t("pb_over_more")};
    }
    return {kind:"held", owner:"crew", text:t("pb_held", {why: sentence(fin) || c.toLowerCase().replace(/_/g, " ") || "see the buyer"}),
            act:"pb-tell", label:t("pb_tell")};
  }
  if(fs === "refused"){
    if(code(fin) === "NOT_STAFF") return {kind:"buyer", owner:"buyer", text:t("pb_buyer")};
    const why = code(fin) === "BAD_SHAPE" ? "This scan had no count or no shelf" : (sentence(fin) || "Finale refused it");
    return {kind:"refused", owner:"crew", text:t("pb_refused", {why}), act:"pb-remove", label:t("pb_rm_rescan")};
  }
  return null;
};
/* ⭐ 2026-10-23 (Jack: "If they scan a staged case twice but only put it away once, then we should count that as a duplicate
   automatically"). A cart record is retired with NO tap only when it is certainly the same case: still staged and never acted on, the
   PO line is already full in Finale, and the SAME item with the SAME best-by on the same PO was scanned LATER and is POSTED (the put-away
   of the case that was on the cart). ⛔ A different best-by, nothing posted later, or a line not yet full still asks a person.
   ⛔ Never while the PO-wide read is down or not loaded (an unseen part must not be decided on). ⛔ The cancel is an If-Match PATCH, so
   two tablets cannot both act and a record the poster moved is left alone. Its best-by row is then removed with the Remove guard;
   the cohort engine ALSO caps every SKU at the PO quantity across scan days (`_shared/inventory_cohorts._cap_to_finale`), so a row
   that could not be removed is still counted once while the PO is in its window. -> the posted twin, or null */
/* ⭐ 2026-10-23 PM (Jack: "how do we get the tablets to always show the correct info needed?"): ONE rule decides which cart records
   are finished duplicates, and every surface uses it — the staged list (rx/staging.js ST.records), the PO counts
   (rx/receive-po.js scannedUnits / lineStatus), this problems map, and the auto-retire below. So a duplicate stops being shown as
   work the moment any tablet DRAWS the screen; the retire write only tidies the record afterwards.
   Per (PO, SKU, best-by), only when the PO line is FULL in Finale and the PO-wide read is loaded: the live cart records, oldest first,
   are paired one-to-one with POSTED scans made after each of them (⛔ never a split part of the same case); the first `gone` pairs
   (cart records already cancelled) are used up, the rest are duplicates. -> Set of intent ids */
const sameCase = (x) => String(((x.fields || {}).SplitOf) || x.iid);
let DUP_MEMO = null;                     // one computation per synchronous render pass (every line of a PO asks); cleared next microtask
P.dupIids = function(){
  if(DUP_MEMO) return DUP_MEMO;
  const out = dupCompute(); DUP_MEMO = out; Promise.resolve().then(() => { DUP_MEMO = null; });
  return out;
};
function dupCompute(){
  const out = new Set();
  if(I.state && (I.state.poErr || !I.state.poLoaded)) return out;
  const groups = new Map();
  for(const x of (I.allPo ? I.allPo() : I.allToday())){
    const g = x.fields || {}; if(g.Kind === "fix" || !g.Po || !g.Sku || !g.BestBy) continue;
    const key = String(g.Po) + "|" + g.Sku + "|" + g.BestBy;
    let G = groups.get(key); if(!G) groups.set(key, G = {po: String(g.Po), sku: g.Sku, live: [], posted: [], gone: 0});
    const xr = I.byId(x.iid);
    if(g.State === "cancelled" || (xr && xr.cancelled)){ if(g.Workflow === "staged") G.gone++; continue; }
    const fs = (x.fin || {}).FinState || "";
    if(g.State === "staged" && !fs){ if(g.PageMode === "live") G.live.push(x); continue; }
    if(fs === "posted") G.posted.push(x);
  }
  for(const G of groups.values()){
    if(!G.live.length || !G.posted.length) continue;
    /* "full" = Finale has what KeHE SHIPPED (else what we ordered) — the poster's own limit. Against ORDERED a real extra case KeHE
       shipped and billed would be hidden and retired (review 2026-10-23 PM (3)). */
    const cf = RX.po && RX.po.confirmed ? RX.po.confirmed(G.po, G.sku) : null;
    const cp = RX.po && RX.po.capOf ? RX.po.capOf(G.po, G.sku) : null;
    const lim = cp ? cp.cap : (cf ? cf.ordered : 0);
    if(!(cf && lim > 0 && cf.units >= lim)) continue;
    const roots = new Set(G.live.map(sameCase));
    const posts = G.posted.filter(x => !roots.has(sameCase(x))).map(x => Date.parse((x.fields || {}).ScanAt)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    const live = G.live.slice().sort((a, b) => (Date.parse((a.fields || {}).ScanAt) - Date.parse((b.fields || {}).ScanAt)) || (a.iid < b.iid ? -1 : a.iid > b.iid ? 1 : 0));
    let gone = G.gone;
    for(const s of live){
      const at = Date.parse((s.fields || {}).ScanAt); if(isNaN(at)) continue;
      const i = posts.findIndex(t0 => t0 > at); if(i < 0) continue;
      posts.splice(i, 1);
      if(gone > 0){ gone--; continue; }
      out.add(s.iid);
    }
  }
  return out;
}
P.isDup = (v) => !!(v && P.dupIids().has(v.iid));
/* the auto-retire's own gates on top of the rule: a record this tablet still has a write in flight for is left alone */
P.autoTwin = function(v){
  if(!v) return false;
  const f = v.fields || {};
  if(f.Kind !== "intent" || f.State !== "staged" || f.PageMode !== "live" || (v.fin || {}).FinState) return false;
  const rec = I.byId(v.iid); if(rec && (rec.cancelled || rec.inflight || (rec.patches || []).length || !rec.sent)) return false;
  return P.isDup(v);
};
const AUTO_TRIED = new Set();
P.autoRetire = async function(){
  let n = 0;
  for(const v of (I.allPo ? I.allPo() : I.allToday())){
    if(AUTO_TRIED.has(v.iid) || BUSY.has(v.iid) || !P.autoTwin(v)) continue;
    AUTO_TRIED.add(v.iid); BUSY.add(v.iid);
    try{
      const r = await patchIntent(v, {State:"cancelled"}, "");
      if(r.ok){
        n++; P.state.msg[v.iid] = t("pb_auto_dup");
        /* review 2026-10-23 (3): also take its best-by row (the same guard as Remove — never one another live part uses, never
           while the PO-wide read is down), so the date is counted once even after the PO leaves the engine's PO-lines window */
        const b = await P.dropBb(v);
        if(!b.ok) P.tellBbLeft(v, b.why || "the best-by delete failed");
      }
    }catch(e){ try{ console.error("rx auto-dup", e); }catch(_){} }
    finally{ BUSY.delete(v.iid); }
  }
  if(n){ RX.refresh(); RX.call("drawer", "refresh", true); }
  return n;
};
const TEMP_TRIED = new Set();
P.autoTemp = async function(){
  let n = 0;
  for(const v of (I.allPo ? I.allPo() : I.allToday())){
    const fin = v.fin || {}, f = v.fields || {};
    if(TEMP_TRIED.has(v.iid) || BUSY.has(v.iid) || f.Kind === "fix" || f.State === "cancelled" || fin.FinState !== "held" || code(fin) !== "TEMP_UNCONFIRMED" || !tempAgrees(v)) continue;
    if(fixSentFor(v.iid)) continue;
    TEMP_TRIED.add(v.iid); BUSY.add(v.iid);
    try{
      /* ⛔ the SAME two writes as the Yes button (tempYes): replacement saved first, created only after the cancel LANDED (PM-3112) */
      const r = await tempYes(v);
      if(r.ok){ n++; P.state.msg[v.iid] = t("pb_done_temp"); }
    }catch(e){ try{ console.error("rx auto-temp", e); }catch(_){} }
    finally{ BUSY.delete(v.iid); }
  }
  if(n){ RX.refresh(); RX.call("drawer", "refresh", true); }
  return n;
};
RX.on("intents", () => { P.finishTempYes(); P.autoRetire(); P.autoTemp(); });
/* ⭐ 2026-10-22 (PM-3069): a staged case taken off the cart list ("Not put away") must take its best-by row with it, or the date is
   counted twice when the case is scanned again (live: Rosemary Garlic Fries BB 4486 kept, rescanned as 4492 → 18u recorded vs 12).
   The SAME guard as "Scanned twice": never while another live part of the case uses that row, nor while the PO-wide read is down.
   Call it with the scan as it was BEFORE the cancel. -> {ok, kept?, why?} */
P.vOf = (iid) => findV(iid);
/* ⭐ 2026-10-23: rx/short.js cancels a short record another tablet wrote through the SAME If-Match write (never a second copy) */
P.patchIntent = (v, cols, expectFin) => patchIntent(v, cols, expectFin);
P.whyText = (why) => whyText(why);
P.dropBb = async function(v){
  if(!v || !String((v.fields || {}).BbItemId || "")) return {ok:true, skipped:true};
  if(bbShared(v)) return {ok:true, kept:true};
  return bb(v, {del:true});
};
/* ⛔ review 2026-10-22 (2): a CANCELLED scan has no Fix button, so the crew cannot finish a failed removal — the buyer is told instead
   (a fix row), with the row id. `why` says why the row was not removed here. */
P.tellBbLeft = function(v, why){
  const id = String((v && v.fields || {}).BbItemId || ""); if(!id) return;
  tellBuyer(v, `crew took this staged case off the list; its best-by row ${id} was not removed (${String(why || "").slice(0, 80)}) — delete it if the case was scanned again, so the date is not counted twice`, 0);
};
P.crewOpen = (v) => { const p = P.of(v); return !!p && p.owner === "crew"; };
P.forRow = function(row){
  let best = null;
  for(const rec of I.forRow(row)){
    const v = {iid:rec.iid, fields:rec.fields, fin:rec.fin || {}, itemId:rec.itemId, etag:rec.etag, local:true};
    const p = P.of(v); if(p && (!best || (p.owner === "crew" && best.owner !== "crew"))) best = Object.assign({iid:rec.iid}, p);
  }
  return best;
};
/* the words + the button(s), for any surface. ctx tags the buttons so the click finds the scan again. */
P.html = function(v, opts){
  const p = P.of(v); if(!p) return "";
  const msg = P.state.msg[v.iid];
  const busy = BUSY.has(v.iid);
  const b = (act, label, primary) => `<button type="button" class="rx-btn${primary ? " primary" : ""}" data-act="${act}" data-iid="${esc(v.iid)}"${busy ? " disabled" : ""}>${esc(busy ? t("pb_busy") : label)}</button>`;
  let h = `<div class="rx-pb rx-pb-${esc(p.kind)}" data-pb="${esc(p.kind)}"><span class="rx-pb-t">${esc(p.text)}</span>`;
  if(p.act) h += " " + b(p.act, p.label, true);
  if(p.act2) h += " " + b(p.act2, p.label2, false);
  if(msg) h += `<div class="hint rx-pb-msg" role="status">${esc(msg)}</div>`;
  return h + `</div>`;
};

/* ───────────────────────── finding the scan a button names ───────────────────────── */
function findV(iid){
  for(const x of (I.allPo ? I.allPo() : I.allToday())) if(x.iid === iid) return x;
  const rec = I.byId(iid); if(rec) return {iid, fields:rec.fields, fin:rec.fin || {}, itemId:rec.itemId, etag:rec.etag, local:true};
  return null;
}
function say(iid, m){ P.state.msg[iid] = m; RX.refresh(); RX.call("drawer", "refresh", true); }

/* ───────────────────────── the one remote write: If-Match PATCH of page-owned columns ───────────────────────── */
/* -> {ok:true} | {ok:false, why:'changed'|'gone'|'offline'|'sending'|'denied'}. `expectFin` = the FinState the action was decided
   on ('' = not acted on): if the server now says anything else, nothing is written. */
async function patchIntent(v, cols, expectFin){
  const rec = I.byId(v.iid);
  if(rec && (rec.inflight || (rec.patches || []).length || !rec.sent)) return {ok:false, why:"sending"};
  let L; try{ L = await I.resolveList(); }catch(e){ return {ok:false, why: e && e.status === 403 ? "denied" : "offline"}; }
  const itemId = (rec && rec.itemId) || v.itemId; let etag = (rec && rec.etag) || v.etag;
  if(!itemId) return {ok:false, why:"sending"};
  if(!etag){                                             // ⛔ never a PATCH without If-Match: read the current etag (and state) first
    let cur = null; try{ cur = await graph(`/sites/${L.siteId}/lists/${L.listId}/items/${itemId}?$expand=fields`); }catch(e){ return {ok:false, why: e && e.status === 404 ? "gone" : "offline"}; }
    const cf = (cur && cur.fields) || {};
    if(String(cf.FinState || "") !== String(expectFin || "") || cf.State !== (v.fields || {}).State){ I.poll(); return {ok:false, why:"changed"}; }
    etag = (cur && (cur["@odata.etag"] || cur.eTag)) || null; if(!etag) return {ok:false, why:"offline"};
  }
  for(let attempt = 0; attempt < 2; attempt++){
    try{
      const j = await graph(`/sites/${L.siteId}/lists/${L.listId}/items/${itemId}/fields`,
        {method:"PATCH", headers: {"If-Match": etag}, body: JSON.stringify(cols)});
      mirror(v, cols, (j && (j["@odata.etag"] || j.eTag)) || null);
      return {ok:true};
    }catch(e){
      if(e && e.status === 412){
        let cur = null; try{ cur = await graph(`/sites/${L.siteId}/lists/${L.listId}/items/${itemId}?$expand=fields`); }catch(_){ return {ok:false, why:"offline"}; }
        const cf = (cur && cur.fields) || {};
        if(String(cf.FinState || "") !== String(expectFin || "") || cf.State !== (v.fields || {}).State){ I.poll(); return {ok:false, why:"changed"}; }
        etag = (cur && (cur["@odata.etag"] || cur.eTag)) || null; continue;
      }
      if(e && e.status === 404) return {ok:false, why:"gone"};
      if(e && e.status === 403) return {ok:false, why:"denied"};
      return {ok:false, why:"offline"};
    }
  }
  I.poll(); return {ok:false, why:"changed"};
}
function mirror(v, cols, etag){
  Object.assign(v.fields, cols); if(etag) v.etag = etag;
  const m = RX.state.poAll && RX.state.poAll.get(v.iid); if(m){ Object.assign(m.fields, cols); if(etag) m.etag = etag; }
  const t0 = RX.state.todayAll && RX.state.todayAll.get(v.iid); if(t0){ Object.assign(t0.fields, cols); if(etag) t0.etag = etag; }
  const rec = I.byId(v.iid);
  if(rec){ Object.assign(rec.fields, cols); if(etag) rec.etag = etag; if(cols.State === "cancelled") rec.cancelled = true; try{ I._save(); }catch(_){} }
}
const whyText = (why) => why === "changed" || why === "gone" ? t("pb_changed") : (why === "sending" ? t("pb_still_sending") : t("pb_offline"));

/* the BB Receipts row of this scan may be deleted only if NO other live intent (not a fix row, not cancelled) uses it */
/* the other LIVE parts of the same physical case: same BB row, OR the same split root (SplitOf || own id — a posted part often has no
   BbItemId: the evidence patch is dropped once the poster acted), OR on the same history row of this tablet (review 2026-10-22 (3)) */
const rootOf = (x) => String(((x.fields || {}).SplitOf) || x.iid);
/* ⭐ PM-3109 review (4): a "receive the rest" record names the scan it completes in FixBin "rest-of:<iid>" (FixBin is read by nobody on
   an intent: the poster ignores it, the portal shows it only on fix rows) — the BB row alone cannot link them when the posted scan has
   no BbItemId. -> the scan's iid | "" */
const restLink = (x) => { const m = /^rest-of:(.+)$/.exec(String(((x && x.fields) || {}).FixBin || "")); return m ? m[1] : ""; };
function partners(v){
  const id = String((v.fields || {}).BbItemId || ""), root = rootOf(v), out = [];
  let rowIds = []; try{ const r = rows.find(r => r.rx && ((r.rx.iids || []).indexOf(v.iid) >= 0 || r.rx.iid === v.iid)); if(r) rowIds = (r.rx.iids && r.rx.iids.length) ? r.rx.iids : [r.rx.iid]; }catch(_){}
  for(const x of (I.allPo ? I.allPo() : I.allToday())){
    if(x.iid === v.iid) continue; const f = x.fields || {};
    if(f.Kind === "fix" || f.State === "cancelled" || (x.fin || {}).FinState === "reversed") continue;   // PM-3117: a reversed part is not stock
    const rec = I.byId(x.iid); if(rec && rec.cancelled) continue;
    if((id && String(f.BbItemId || "") === id) || rootOf(x) === root || x.iid === root || rowIds.indexOf(x.iid) >= 0
       || restLink(x) === v.iid || restLink(v) === x.iid) out.push(x);
  }
  return out;
}
/* ⛔ also "shared" while the PO-wide read has failed or never loaded: an unseen part on another day must not lose its best-by */
function bbShared(v){ if(!String((v.fields || {}).BbItemId || "")) return false; if(I.state && (I.state.poErr || !I.state.poLoaded)) return true; return partners(v).length > 0; }
/* FinState values from which a scan can still be withdrawn: not acted on, or stopped by the poster. posting / uncertain / posted are
   (or may be) in Finale already — those get a fix row, never a cancel (review 2026-10-22 (1)) */
const WITHDRAWABLE = new Set(["", "held", "refused", "reversed"]);   // PM-3117: a reversed scan is out of Finale already — remove it, never "take N off"
const IN_FINALE = new Set(["posted", "posting", "uncertain"]);
async function bb(v, op){
  const f = v.fields || {}; const id = String(f.BbItemId || "");
  if(!id) return {ok:true, skipped:true};
  if(typeof bbFixItem !== "function") return {ok:false, why:"the page is too old — reload it"};
  try{ const r = await bbFixItem(Object.assign({id, sku:f.Sku, upc:f.Upc || "", po:f.Po || ""}, op)); return r === "retry" ? {ok:false, why:"no signal"} : {ok:true}; }
  catch(e){ return {ok:false, why:(e && e.message) || "error"}; }
}
function tellBuyer(v, note, units){
  const f = v.fields || {};
  return I.create({Kind:"fix", Sku:f.Sku || "", Upc:f.Upc || "", Po:f.Po || "", SplitOf:v.iid,
            FixUnits: units != null ? units : null, FixBin: f.Location || "", FixNote: String(note || "").slice(0, 250), Units:0}, {});
}
/* the fresh intent that replaces a held one: same case, same units/bin/best-by/BB row; the crew's yes rides on it */
function replacement(v, extra){
  const f = v.fields || {}, g = {};
  for(const k of RX.INTENT_FIELDS){ if(f[k] !== undefined && f[k] !== null && f[k] !== "") g[k] = f[k]; }
  for(const k of ["IntentId", "ScanDay", "ReadyAt", "CancelTooLate", "SplitOf", "RawScans", "PhotoUrls", "FixUnits", "FixBin", "FixNote", "Device", "PageMode"]) delete g[k];
  let me = ""; try{ me = account; }catch(_){}
  return Object.assign(g, {Kind:"intent", State:"ready", ReadyAt:RX.iso(), PlacedBy: me || f.PlacedBy || ""}, extra || {});
}

/* ───────────────────────── the actions ───────────────────────── */
async function run(iid, fn){
  if(BUSY.has(iid)) return; BUSY.add(iid); P.state.msg[iid] = ""; RX.refresh(); RX.call("drawer", "refresh", true);
  try{ await fn(); }catch(e){ say(iid, t("pb_offline")); try{ console.error("rx problems", e); }catch(_){} }
  finally{ BUSY.delete(iid); RX.refresh(); RX.call("drawer", "refresh", true); }
}
RX.registerAct("pb-putaway", () => { try{ RX.drawer.close(); }catch(_){} if(RX.setFlow("staged")){ try{ RX.staging.refresh(); }catch(_){} } });
/* ⭐ PM-3112 (2026-10-23): "Yes, it belongs in <bin>" is TWO writes — cancel the held intent, then create its replacement. On 10-23 the
   cashew milk's second cancel landed (14:16:57Z) and its replacement never reached the list; the only failure that fits the server
   evidence is the page stopping between the two (a reload, the tab closed, the tablet asleep — the PATCH lands, its answer is never
   processed, so the create never runs). So the replacement is written to THIS tablet's storage BEFORE the cancel, with its IntentId
   fixed in advance, and the cancel PATCH carries `FixBin = "replaced-by:<that id>"` (a column no reader uses on an intent). After any
   reload, P.finishTempYes() finishes it: the original cancelled BY THIS ANSWER (its FixBin names the id) and no intent with that id
   anywhere ⇒ create it, with the SAME id (never a second one). ⛔ An original cancelled by anything else (Remove, another tablet) is
   never resurrected; one still held means the cancel never landed — the question is simply still on screen. */
const REPL_KEY = "rx_temp_repl_v1";
const replAll = () => { let s = null; try{ s = RX.store.get(REPL_KEY, null); }catch(_){} return (s && typeof s === "object") ? s : {}; };
const replPut = (m) => { try{ RX.store.set(REPL_KEY, m); }catch(_){} };
const replDel = (oid) => { const m = replAll(); if(m[oid]){ delete m[oid]; replPut(m); } };
async function tempYes(v){
  /* ⛔ a retry REUSES the saved replacement (the same IntentId): a first tap whose cancel landed with its answer lost is then still
     recognised by its FixBin (adversarial review 2026-10-23 (1): a fresh id on the retry orphaned the first one for good) */
  const prev = replAll()[v.iid];
  const g = (prev && prev.g && prev.g.IntentId) ? prev.g : replacement(v, {TempConfirmed:true, IntentId:RX.newId()});
  const m = replAll(); m[v.iid] = {g, at:RX.now()}; replPut(m);              // ⛔ BEFORE the cancel
  const r = await patchIntent(v, {State:"cancelled", FixBin:"replaced-by:" + g.IntentId}, "held");
  /* offline (outcome unknown) and changed (412: maybe OUR earlier cancel) are decided by P.finishTempYes from the list itself; only a
     write that certainly never landed drops the saved copy */
  if(!r.ok){ if(r.why === "sending" || r.why === "denied" || r.why === "gone") replDel(v.iid); return r; }
  /* ⛔ ONLY after the cancel LANDED: the new intent can never coexist with a live copy of the old one */
  if(!I.byId(g.IntentId)) I.create(g, {});
  return r;
}
const replSeen = (id) => (I.allPo ? I.allPo() : I.allToday()).find(x => x.iid === id) || null;
/* the LIST's copy of an intent — never this tablet's outbox copy, which still says "held" after a cancel whose answer was lost */
const serverCopy = (iid) => (RX.state.poAll && RX.state.poAll.get(iid)) || (RX.state.todayAll && RX.state.todayAll.get(iid)) || null;
const goneHere = (iid) => { try{ const st = I._store && I._store(); return !!(st && st.gone && st.gone[iid]); }catch(_){ return false; } };
P.finishTempYes = function(){
  const m = replAll(), ids = Object.keys(m); if(!ids.length || !poRead()) return 0;
  let n = 0, dirty = false;
  for(const oid of ids){
    if(BUSY.has(oid)) continue;                                              // the tap is still in flight on this page
    const e = m[oid], g = e && e.g;
    if(!g || !g.IntentId){ delete m[oid]; dirty = true; continue; }
    const twin = replSeen(g.IntentId), rec = I.byId(g.IntentId);
    if(twin || rec){ if((twin && !twin.local) || (rec && (rec.sent || rec.denied))){ delete m[oid]; dirty = true; } continue; }   // on the list (or refused) ⇒ done; in the outbox ⇒ wait
    /* ⛔ it existed here and was removed or pruned (review (5): a refused replacement the crew removed must not come back) */
    if(goneHere(g.IntentId)){ delete m[oid]; dirty = true; continue; }
    const o = serverCopy(oid), of = (o && o.fields) || {};
    if(!o){ if(RX.now() - (+e.at || 0) > 3 * 86400000){ delete m[oid]; dirty = true; } continue; }
    if(of.State === "cancelled" && String(of.FixBin || "") === "replaced-by:" + g.IntentId){ I.create(g, {}); n++; continue; }
    /* still live: the cancel never landed — but a tap on ANOTHER tab of this tablet may be mid-flight (BUSY is per tab), so a fresh
       copy is given 2 minutes before it is dropped */
    if(of.State !== "cancelled" && RX.now() - (+e.at || 0) < 120000) continue;
    delete m[oid]; dirty = true;                                             // never landed, or cancelled by something else: never resurrected
  }
  if(dirty) replPut(m);
  if(n){ RX.refresh(); RX.call("drawer", "refresh", true); }
  return n;
};
RX.registerAct("pb-temp-yes", ({el}) => { const iid = el.dataset.iid; return run(iid, async () => {
  const v = findV(iid); const p = P.of(v); if(!p || p.kind !== "temp"){ say(iid, t("pb_changed")); return; }
  const r = await tempYes(v);
  if(!r.ok){ say(iid, whyText(r.why)); return; }
  say(iid, t("pb_done_temp"));
}); });
/* ⭐ PM-3108 (2026-10-23): a scan that leaves a case — Remove, Counted twice, Scanned twice — takes its units off the case's best-by row.
   The row is the WHOLE case; a "receive the rest" record (and a split part) shares it. Before, removing the rest kept the row at the
   raised total (BB 12 while Finale had 6). Decided BEFORE the write, from the other live parts of the case (a part already flagged
   "scanned twice" to the buyer is not counted): none ⇒ the row is deleted (as before); some ⇒ the row is set to their units;
   ⛔ the PO-wide read down ⇒ the row is left alone and the crew is told (an unseen part must not lose its date or its count). */
/* ⭐ The case's parts, counted from a given view: `m` = a FRESH map read from the list at write time (PM-3169), or null = this page's
   usual view (allPo). A part's units are its shelf Units, or — when the crew has an OPEN count note on it ("the count is n", e.g. a
   lower count confirmed on the card) — that n (review 2026-10-23 PM (4): a lowered part must not be summed back at its old Units). */
const viewOf = (m) => m ? [...m.values()] : (I.allPo ? I.allPo() : I.allToday());
const notesOf = (m, iid) => viewOf(m).filter(x => ((x.fields || {}).Kind) === "fix" && (x.fields || {}).SplitOf === iid && (x.fields || {}).State !== "cancelled")
  .map(x => x.fields || {}).sort((p, q) => String(p.ScanAt || "").localeCompare(String(q.ScanAt || "")));
const flaggedIn = (m, x) => notesOf(m, x.iid).some(r => !(+r.FixUnits > 0) && /scanned twice/i.test(String(r.FixNote || "")));
const flaggedTwice = (x) => flaggedIn(null, x);
const countOf = (m, x) => { const ns = notesOf(m, x.iid).filter(r => +r.FixUnits > 0); return ns.length ? +ns[ns.length - 1].FixUnits : (+((x.fields || {}).Units) || 0); };
function partsIn(m, v){
  if(!m) return partners(v);
  const id = String((v.fields || {}).BbItemId || ""), root = rootOf(v), out = [];
  let rowIds = []; try{ const r = rows.find(r => r.rx && ((r.rx.iids || []).indexOf(v.iid) >= 0 || r.rx.iid === v.iid)); if(r) rowIds = (r.rx.iids && r.rx.iids.length) ? r.rx.iids : [r.rx.iid]; }catch(_){}
  for(const x of m.values()){
    if(x.iid === v.iid) continue; const f = x.fields || {};
    if(f.Kind === "fix" || f.Kind === "short" || f.State === "cancelled" || (x.fin || {}).FinState === "reversed") continue;
    if((id && String(f.BbItemId || "") === id) || rootOf(x) === root || x.iid === root || rowIds.indexOf(x.iid) >= 0
       || restLink(x) === v.iid || restLink(v) === x.iid) out.push(x);
  }
  return out;
}
function bbPlan(v, m){
  if(!String((v.fields || {}).BbItemId || "")) return {op:"none"};
  if(!poRead()) return {op:"keep"};
  const rest = partsIn(m, v).filter(x => (((x.fields || {}).Kind) || "intent") === "intent" && !flaggedIn(m, x));
  if(!rest.length) return {op:"del"};
  const n = rest.reduce((s0, x) => s0 + countOf(m, x), 0);                 // the shelf's units (a partly-posted part is still all there)
  return n > 0 ? {op:"units", n} : {op:"keep"};
}
/* ⭐ PM-3169 (2026-10-23): two tablets taking two parts off ONE case at the same moment each computed the row from what THEY saw, so the
   later write could carry a total that still counted the other's part. Every best-by write for a case is now:
     1. read the row's etag;  2. re-read the open POs' intents from the LIST into a FRESH map (this tablet's own records overlay it only
        where they are not on the list yet or still have a change queued); 3. compute from that map;  4. PATCH / DELETE the row with
        If-Match = that etag — the row changed since step 1 ⇒ 412 ⇒ start again (at most 3 rounds, then the crew is told).
   The etag is read BEFORE the list, and each tablet's own removal is on the list before it reads the etag (an intent cancel lands
   first; a buyer note is waited for), so a total computed from a stale list can never land on top of a newer one.
   The old unconditional path (`bb`, which keeps a failed correction on this tablet's row and retries it) is used for a row this tablet
   holds a correction for, a row already drained (404), a page whose list mapping is not ready, and — on a row this tablet scanned — any
   failure other than "it changed" (review (6): the correction must not be lost). -> {ok, kept?, lowered?, why?} */
async function freshMap(){
  const pos = ((RX.pack.data && RX.pack.data.pos) || []).map(p => String(p.order_id || "")).filter(x => /^[\w-]{1,40}$/.test(x));
  const m = new Map();
  for(const po of pos){
    const items = await I.query(`fields/Po eq '${po}'`);
    for(const it of items){ if(it.iid) m.set(it.iid, {iid:it.iid, itemId:it.id, etag:it.etag, fields:it.fields, fin:it.fin}); }
  }
  /* this tablet's records: one not on the list yet (unsent) counts as it stands here; one with a change still queued (a cancel, an edit)
     carries that change (review (2): the outbox copy must never HIDE another tablet's cancel, so a sent record with nothing queued
     takes the LIST's word) */
  try{ const st = I._store(); for(const k of Object.keys(st.recs || {})){ const r = st.recs[k]; if(!r || !r.fields || r.denied) continue;
    const onList = m.get(r.iid);
    if(!onList){ if(!r.sent) m.set(r.iid, {iid:r.iid, fields:Object.assign({}, r.fields, r.cancelled ? {State:"cancelled"} : {}), fin:r.fin || {}}); continue; }
    if((r.patches || []).length || r.cancelled) onList.fields = Object.assign({}, onList.fields, r.fields, r.cancelled ? {State:"cancelled"} : {});
  } }catch(_){}
  /* the page's own view is brought up to date in ONE step (review (7): never interleaved with a poll's swap) */
  try{ for(const [iid, x] of m){ if(x.itemId) RX.state.poAll.set(iid, {itemId:x.itemId, etag:x.etag, fields:x.fields, fin:x.fin}); } }catch(_){}
  return m;
}
async function bbApply(v, planFn){
  const id = String((v.fields || {}).BbItemId || ""); if(!id) return {ok:true};
  let row = null, sid = null, lid = null, fld = null;
  try{ row = rows.find(r => String(r.id) === id && !r.deleted) || null; }catch(_){}
  try{ sid = siteId; lid = listId; fld = FIELD.units; }catch(_){}
  const heldHere = () => !!(row && row.fix && Object.keys(row.fix).length);
  const legacy = async (plan) => {
    if(!plan){ let m = null; try{ m = await freshMap(); }catch(_){} plan = planFn(m); }
    if(plan.op === "none") return {ok:true}; if(plan.op === "keep") return {ok:true, kept:true};
    const b = await bb(v, plan.op === "del" ? {del:true} : {units:plan.n});
    return b.ok ? {ok:true, lowered: plan.op === "units" ? plan.n : null} : {ok:false, why:b.why};
  };
  if(!/^\d+$/.test(id) || typeof graph !== "function" || !sid || !lid || !fld || heldHere()) return legacy();
  const path = `/sites/${sid}/lists/${lid}/items/${id}`;
  for(let round = 0; round < 3; round++){
    if(heldHere()) return legacy();                                           // review (9): the crew edited the cell meanwhile
    let cur = null;
    try{ cur = await graph(path); }catch(e){ if(e && e.status === 404) return legacy(); return row ? legacy() : {ok:false, why: e && e.auth ? "sign in again" : "no signal"}; }
    const etag = cur && (cur["@odata.etag"] || cur.eTag); if(!etag) return row ? legacy() : {ok:false, why:"no signal"};
    let m = null; try{ m = await freshMap(); }catch(e){ return {ok:false, why:"no signal"}; }
    const plan = planFn(m);
    if(plan.op === "none") return {ok:true};
    if(plan.op === "keep") return {ok:true, kept:true};
    try{
      if(plan.op === "del") await graph(path, {method:"DELETE", headers:{"If-Match":etag}});
      else await graph(path + "/fields", {method:"PATCH", headers:{"If-Match":etag}, body:JSON.stringify({[fld]:plan.n})});
    }catch(e){
      if(e && e.status === 412) continue;                                   // another tablet wrote the row: read it all again
      if(e && e.status === 404) return legacy(plan);
      return row ? legacy(plan) : {ok:false, why: e && e.auth ? "sign in again" : "no signal"};
    }
    if(row){                                                                // review (5): the screen follows, as deleteRow does
      try{
        if(plan.op === "del"){ row.deleted = true; const i = rows.indexOf(row); if(i >= 0) rows.splice(i, 1); queue = rows.filter(r => r.saved !== "saved").length; }
        else row.units = plan.n;
        persistPending(); try{ renderPending(); }catch(_){} render();
      }catch(_){}
    }
    return {ok:true, lowered: plan.op === "units" ? plan.n : null};
  }
  return {ok:false, why:"it kept changing on another tablet — look again"};
}
/* review (3): a buyer note must be ON THE LIST before this tablet reads the row's etag — else another tablet's fresh read cannot see this
   removal and could write a total that still counts the part. -> true once sent */
async function noteSent(rec){
  if(!rec) return false; if(rec.sent) return true;
  try{ await I.flush(); }catch(_){}
  const r = I.byId(rec.iid); return !!(r && r.sent);
}
const rmMsg = (b) => !b.ok ? t("pb_bb_failed", {why:b.why}) : (b.kept ? t("pb_done_rm_noread") : (b.lowered != null ? t("pb_done_rm_lower", {n:fmtN(b.lowered)}) : t("pb_done_rm")));
async function removeScan(v, expectFin){
  if(!WITHDRAWABLE.has(String(expectFin || ""))) return {ok:false, msg:t("pb_changed")};
  const r = await patchIntent(v, {State:"cancelled"}, expectFin);
  if(!r.ok) return {ok:false, msg:whyText(r.why)};
  return {ok:true, msg:rmMsg(await bbApply(v, (m) => bbPlan(v, m)))};          // PM-3169: computed from the list at write time
}
RX.registerAct("pb-remove", ({el}) => { const iid = el.dataset.iid; return run(iid, async () => {
  const v = findV(iid); const p = P.of(v); if(!p || !p.act){ say(iid, t("pb_changed")); return; }
  const rec = I.byId(iid);
  if(p.kind === "denied" && rec && !rec.sent){ I.cancel(iid); say(iid, rmMsg(await bbApply(v, (m) => bbPlan(v, m)))); return; }
  const out = await removeScan(v, (v.fin || {}).FinState || "");
  say(iid, out.msg);
}); });
RX.registerAct("pb-tell", ({el}) => { const iid = el.dataset.iid; return run(iid, async () => {
  const v = findV(iid); const p = P.of(v); if(!p){ say(iid, t("pb_changed")); return; }
  tellBuyer(v, p.kind === "over" ? "crew: KeHE really sent more than the PO — add the extra to the PO in Finale" : "crew: " + p.text);
  say(iid, p.kind === "over" ? t("pb_done_more") : t("pb_told"));
}); });

/* ───────────────────────── FIX A SCAN ───────────────────────── */
/* ⭐ 2026-10-23 (Jack: "did we order 12 of these? Only 6 were received, and so then we can't receive the other 6? That isn't the right
   sequence … give them the appropriate information"): the PO facts the crew needs to get a count right — ordered, KeHE shipped, what
   Finale has, what is on its way. Read from the SAME helpers the poster's limit mirrors (RX.po.capOf / putCheck). -> text | "" */
const poRead = () => !(I.state && (I.state.poErr || !I.state.poLoaded));
function poFacts(f){
  if(!f.Po || !RX.po || !RX.po.capOf || !RX.po.putCheck || !poRead()) return "";
  const cp = RX.po.capOf(f.Po, f.Sku), pc = RX.po.putCheck(f.Po, f.Sku, 0), cf = RX.po.confirmed ? RX.po.confirmed(f.Po, f.Sku) : null;
  if(!cp || !pc || !cf) return "";
  const cq = +f.CaseQty || 0, ord = +cf.ordered || 0;
  const cases = (cq > 0 && ord > 0 && ord % cq === 0) ? t("fix_po_cases", {c:String(ord / cq), cq:fmtN(cq)}) : "";
  const coming = pc.have - (+cf.units || 0);
  return t("fix_po", {po:String(f.Po), ordered:fmtN(ord), cases, shipped: cp.known ? fmtN(cp.cap) : t("fix_po_unk"), have:fmtN(cf.units),
                      coming: coming > 0 ? t("fix_po_coming", {n:fmtN(coming)}) : ""});
}
/* the other live records of the SAME case (split parts, or units received later through Fix — they share the BB row): the case total
   is what a Fix on a posted scan talks about, so "receive the rest" can never be done twice on one case (misuse review 2026-10-23 (1)) */
/* the units a record stands for: on a POSTED one, what Finale really got (FinUnitsPosted — the poster may hold part of it, code review
   2026-10-23 (4)); otherwise its Units */
const unitsIn = (x) => { const fin = (x && x.fin) || {}, f = (x && x.fields) || {};
  return (fin.FinState === "posted" && fin.FinUnitsPosted != null && fin.FinUnitsPosted !== "") ? (+fin.FinUnitsPosted || 0) : (+f.Units || 0); };
function caseNow(v){
  const parts = partners(v).filter(x => ((x.fields || {}).Kind || "intent") === "intent");
  const old = unitsIn(v), more = parts.reduce((s0, x) => s0 + unitsIn(x), 0);
  return {old, more, total: old + more, parts};
}
/* cart records (staged, not acted on, not a finished duplicate) of the same item on the same PO: usually the case the crew is missing
   (misuse review 2026-10-23 (2)) */
function onCart(f){
  const dups = P.dupIids(), out = [];
  for(const x of (I.allPo ? I.allPo() : I.allToday())){
    const g = x.fields || {};
    if(g.Kind === "fix" || g.State !== "staged" || (x.fin || {}).FinState || g.Sku !== f.Sku || String(g.Po || "") !== String(f.Po || "")) continue;
    const rec = I.byId(x.iid); if((rec && rec.cancelled) || dups.has(x.iid)) continue;
    out.push(x);
  }
  return out;
}
const whoAmI = () => { try{ return account || ""; }catch(_){ return ""; } };
/* ⭐ PM-3111 (2026-10-23): WHICH PO the poster will put `d` more units on. The scan's own `Po` is only advisory: lib/receiving_post.py
   walks the open POs OLDEST first (receive date) and an unconfirmed receipt goes on the first PO with room — partly, with the rest
   HELD, when that room is smaller than the receipt — while an OverConfirmed one goes whole on the oldest PO carrying the item. The pack
   carries every open PO with its eta, so the tablet mirrors that order (the same sort as RX.po.matchFor):
     the first PO with room > 0 has room for all `d` ⇒ that PO, not extra;  otherwise ⇒ the OLDEST PO carrying the item, extra.
   With one open PO this is exactly the old rule (room ≥ d ⇔ putCheck not over). -> {po, pc, k} | null (a PO could not be read) */
const etaSort = (a, b) => String(a.po.eta || "9999").localeCompare(String(b.po.eta || "9999")) || String(a.po.order_id).localeCompare(String(b.po.order_id));
function posterPick(f, d){
  const own = String(f.Po || "");
  const ids = (RX.pack.poLinesBySku ? RX.pack.poLinesBySku(f.Sku) : []).slice().sort(etaSort).map(c => String(c.po.order_id));
  if(ids.length <= 1){ const pc = RX.po.putCheck(own, f.Sku, d); return pc ? {po:own, pc, k:Math.max(1, ids.length)} : null; }
  let first = null;
  for(const id of ids){
    const p0 = RX.po.putCheck(id, f.Sku, 0); if(!p0) return null;
    if(p0.cap - p0.have > 0){ first = {id, room:p0.cap - p0.have}; break; }
  }
  const id = (first && first.room >= d) ? first.id : ids[0];
  const pc = RX.po.putCheck(id, f.Sku, d); if(!pc) return null;
  return {po:id, pc: (id === ids[0] && !(first && first.room >= d)) ? Object.assign({}, pc, {over:true}) : pc, k:ids.length};
}
/* the confirm card for "receive the rest": numbers from putCheck at the moment Save was pressed */
function recvHtml(v, a){
  const f = Object.assign({}, v.fields || {}, {Po: a.po || (v.fields || {}).Po}), pc = a.pc, after = pc.n, over = Math.max(0, pc.n - pc.cap);
  const basis = pc.basis === "shipped" ? "shipped" : "ordered";
  const basisLong = pc.basis === "shipped" ? `KeHE shipped (${fmtN(pc.cap)})` : `we ordered (${fmtN(pc.cap)})`;
  const h = pc.over ? t("recv_over_h", {over:fmtN(over), basis_long:basisLong}) : t("recv_h", {d:fmtN(a.d)});
  const body = pc.over ? t("recv_over_body", {base:fmtN(a.base), n:fmtN(a.n), after:fmtN(after)})
                       : t("recv_body", {base:fmtN(a.base), n:fmtN(a.n), d:fmtN(a.d), bb: f.BestBy || "no best-by", loc: f.Location || "the same shelf",
                                         after:fmtN(after), cap:fmtN(pc.cap), basis});
  const yes = pc.over ? t("recv_yes_over", {over:fmtN(over)}) : t("recv_yes", {d:fmtN(a.d)});
  const cart = onCart(v.fields || {}), err = P.state.fixErr, me = whoAmI();
  /* PM-3111: more than one open PO carries the item — name the one Finale will fill (the facts above are THAT PO's) */
  const multi = (a.k || 1) > 1 ? `<div class="hint rx-recv-po" data-po="${esc(String(a.po || ""))}">${esc(t(pc.over ? "recv_po_multi_over" : "recv_po_multi", {k:String(a.k), po:String(a.po || "")}))}</div>` : "";
  const cartUnits = cart.reduce((s0, x) => s0 + (+((x.fields || {}).Units) || 0), 0);
  const c0 = cart[0] && (cart[0].fields || {});
  const cartNote = cart.length ? `<div class="rx-note rx-red" role="status">${esc(t("recv_cart", {n:fmtN(cartUnits), area: (c0 && c0.StagedArea) || "a cart", age: ageText(c0 && c0.ScanAt)}))}</div>` : "";
  const retype = a.big ? `<label class="hint" for="rxRecvN">${esc(t("recv_retype", {n:fmtN(a.n)}))}</label>
    <input id="rxRecvN" class="num" type="text" inputmode="numeric" maxlength="6" autocomplete="off" value="" aria-label="${esc(t("recv_retype", {n:fmtN(a.n)}))}">` : "";
  const recvBtn = `<button type="button" class="rx-btn${cart.length ? "" : " primary"}" data-act="fix-recv" data-iid="${esc(v.iid)}">${esc(yes)}</button>`;
  const cartBtn = cart.length ? `<button type="button" class="rx-btn primary" data-act="pb-putaway" data-iid="${esc(v.iid)}">${esc(t("recv_cart_go"))}</button>` : "";
  return `<div class="rx-fix rx-recv${pc.over ? " rx-recv-over" : ""}" data-iid="${esc(v.iid)}" data-recv="${pc.over ? "over" : "ok"}"><strong>${esc(h)}</strong>
    <div class="hint">${esc(nameOf(f.Sku))} · ${esc([RX.brandOf(f.Sku), f.Sku].filter(Boolean).join(" · "))}${f.BestBy ? " · bb " + esc(f.BestBy) : ""}${f.Location ? " · " + esc(f.Location) : ""}</div>
    <div class="hint rx-fix-po">${esc(poFacts(f))}</div>
    ${multi}
    ${cartNote}
    <div class="hint">${esc(body)}</div>
    ${retype}
    ${cartBtn} ${recvBtn}
    <button type="button" class="rx-btn" data-act="fix-recv-back" data-iid="${esc(v.iid)}">${esc(t("recv_back"))}</button>
    ${me ? `<div class="hint">${esc(t("recv_who", {who:me}))}</div>` : ""}
    ${err ? `<div class="rx-note rx-red" role="alert">${esc(err)}</div>` : ""}</div>`;
}
P.fixHtml = function(v){
  const f = v.fields || {}; const err = P.state.fixErr;
  const a = P.state.recvAsk; if(a && a.iid === v.iid) return recvHtml(v, a);
  const la = P.state.lowerAsk; if(la && la.iid === v.iid) return lowerHtml(v, la);
  const facts = poFacts(f);
  return `<div class="rx-fix" data-iid="${esc(v.iid)}"><strong>${esc(t("fix_h"))}</strong>
    <div class="hint">${esc(nameOf(f.Sku))} · ${esc([RX.brandOf(f.Sku), f.Sku].filter(Boolean).join(" · "))} · ${esc(String(f.Units ?? "?"))}u${f.BestBy ? " · bb " + esc(f.BestBy) : ""}${(v.fin || {}).FinState === "posted" ? " · " + esc(t("fix_in_finale")) : ""}</div>
    ${facts ? `<div class="hint rx-fix-po">${esc(facts)}</div>` : ""}
    ${(() => { if((v.fin || {}).FinState !== "posted") return ""; const c = caseNow(v); if(!c.more) return "";
      return `<div class="hint rx-fix-case">${esc(t("recv_case", {old:fmtN(c.old), more:fmtN(c.more), total:fmtN(c.total)}))}</div>`; })()}
    ${(() => { const fr = fixRowsFor(v.iid).filter(x => x.FixUnits != null && +x.FixUnits > 0); if(!fr.length) return "";
      const last = fr[fr.length - 1]; return `<div class="hint rx-pb-msg" role="status"><strong>${esc(t("fix_pending", {n:String(+last.FixUnits)}))}</strong></div>`; })()}
    <label class="hint" for="rxFixN">${esc((v.fin || {}).FinState === "posted" && +f.CaseQty > 0 ? t("fix_units_case", {cq:fmtN(f.CaseQty)}) : t("fix_units"))}</label>
    <input id="rxFixN" class="num" type="text" inputmode="numeric" maxlength="5" autocomplete="off" value="${esc(P.state.draft && P.state.draft.iid === v.iid ? P.state.draft.val : String(f.Units ?? ""))}" aria-label="${esc(t("fix_units"))}">
    <button type="button" class="rx-btn primary" data-act="fix-save" data-iid="${esc(v.iid)}">${esc(t("fix_save"))}</button>
    <button type="button" class="rx-btn" data-act="fix-twice" data-iid="${esc(v.iid)}">${esc(t("fix_twice"))}</button>
    <button type="button" class="rx-btn" data-act="fix-cancel" data-close="1">${esc(t("fix_cancel"))}</button>
    ${err ? `<div class="rx-note rx-red" role="alert">${esc(err)}</div>` : ""}</div>`;
};
RX.registerAct("fix-open", ({el}) => { P.state.fixing = el.dataset.iid; P.state.fixErr = ""; P.state.draft = null; P.state.recvAsk = null; P.state.lowerAsk = null; RX.call("drawer", "refresh", true);
  setTimeout(() => { const i = document.getElementById("rxFixN"); if(i){ try{ i.focus(); i.select(); }catch(_){} } }, 30); });
RX.registerAct("fix-cancel", () => { P.state.fixing = null; P.state.fixErr = ""; P.state.recvAsk = null; P.state.lowerAsk = null; RX.call("drawer", "refresh", true); });
/* ⭐ PM-3110 (2026-10-23, misuse review (4)): a LOWER count on a scan Finale has is un-receiving — the buyer's job — and the commonest way
   to get it wrong is typing CASES into a units box (2 meaning 2 cases of 6). So it is never sent on one tap: a card shows what Finale
   has and what was typed, BOTH in units and cases, and only [Yes — the count is n] sends the buyer the note. ⭐ The best-by row is set
   ONLY after that Yes (it used to be set at Save, with no confirm) — ruling (coordinator for Jack, 2026-10-23): the crew is confirming
   what is physically there, which is what the row records; the buyer's Finale correction is a separate matter. The case total moves by
   this scan's change (a split case's other parts keep theirs); ⛔ the PO-wide read down ⇒ the row is left and the crew is told. */
function lowerHtml(v, a){
  const f = v.fields || {}, cq = +f.CaseQty || 0, err = P.state.fixErr;
  const oldc = (cq > 0 && a.old % cq === 0) ? t("fix_lower_c", {c:fmtN(a.old / cq) + (a.old / cq === 1 ? " case" : " cases"), cq:fmtN(cq)}) : "";
  const nc = t("fix_lower_units") + (cq > 0 ? t("fix_lower_cases", {c:fmtN(a.n / cq), cq:fmtN(cq)}) : "");
  const hint = (cq > 1 && a.n < cq) ? `<div class="rx-note rx-red" role="status">${esc(t("fix_lower_hint", {n:fmtN(a.n), u:fmtN(a.n * cq)}))}</div>` : "";
  return `<div class="rx-fix rx-lower" data-iid="${esc(v.iid)}"><strong>${esc(t("fix_lower_h", {d:fmtN(a.old - a.n)}))}</strong>
    <div class="hint">${esc(nameOf(f.Sku))} · ${esc([RX.brandOf(f.Sku), f.Sku].filter(Boolean).join(" · "))}${f.BestBy ? " · bb " + esc(f.BestBy) : ""}${f.Location ? " · " + esc(f.Location) : ""}</div>
    <div class="hint">${esc(t("fix_lower_body", {old:fmtN(a.old), oldc, n:fmtN(a.n), nc, d:fmtN(a.old - a.n)}))}</div>
    ${hint}
    <button type="button" class="rx-btn primary" data-act="fix-lower" data-iid="${esc(v.iid)}">${esc(t("fix_lower_yes", {n:fmtN(a.n)}))}</button>
    <button type="button" class="rx-btn" data-act="fix-lower-back" data-iid="${esc(v.iid)}">${esc(t("recv_back"))}</button>
    ${err ? `<div class="rx-note rx-red" role="alert">${esc(err)}</div>` : ""}</div>`;
}
RX.registerAct("fix-lower-back", () => { P.state.lowerAsk = null; P.state.fixErr = ""; RX.call("drawer", "refresh", true); });
RX.registerAct("fix-lower", ({el}) => { const iid = el.dataset.iid;
  const a = P.state.lowerAsk; if(!a || a.iid !== iid) return;
  return run(iid, async () => {
    const v = findV(iid); const fs = ((v && v.fin) || {}).FinState || "";
    /* ⛔ re-checked at the tap: the scan moved (the poster, another tablet) ⇒ nothing is sent and the card closes */
    if(!v || fs !== a.fs || (v.fields || {}).State === "cancelled" || (fs === "posted" ? unitsIn(v) : (+(v.fields || {}).Units || 0)) !== a.old){
      P.state.lowerAsk = null; P.state.fixErr = t("pb_changed"); return; }
    P.state.lowerAsk = null; P.state.fixing = null; P.state.fixErr = "";
    if(fixRowsFor(iid).some(x => +x.FixUnits === a.n)){ say(iid, t("fix_already_sent", {n:String(a.n)})); return; }
    const note = tellBuyer(v, `crew: the count is ${a.n}, not ${a.old} — correct Finale by ${a.n - a.old}`, a.n);
    const f = v.fields || {};
    if(String(f.BbItemId || "")){
      if(!(await noteSent(note))){ say(iid, t("fix_lower_sending", {n:fmtN(a.n)})); return; }
      const b = await bbApply(v, (m) => {                   // PM-3169: the case total from the list at write time
        if(!poRead()) return {op:"keep"};
        const parts = partsIn(m, v).filter(x => (((x.fields || {}).Kind) || "intent") === "intent" && !flaggedIn(m, x));
        return {op:"units", n: parts.reduce((s0, x) => s0 + countOf(m, x), 0) + a.n};
      });
      if(b.kept){ say(iid, t("fix_lower_done_noBb", {n:fmtN(a.n)})); return; }
      if(!b.ok){ say(iid, t("fix_lower_bbfail", {n:fmtN(a.n)}) + " " + t("pb_bb_failed", {why:b.why})); return; }
    }
    say(iid, t("fix_lower_done", {n:fmtN(a.n)}));
  });
});
RX.registerAct("fix-recv-back", () => { P.state.recvAsk = null; P.state.fixErr = ""; RX.call("drawer", "refresh", true); });
/* ⭐ 2026-10-23: RECEIVE THE REST. A higher count on a scan Finale already has is the rest of the PO line, not a correction for the buyer:
   ONE new put-away intent for the difference (same PO, item, best-by, shelf, BB row), which the poster posts under its own rules (within
   the expected quantity posts; above it only with OverConfirmed, else it is held). ⛔ Re-checked at the tap: numbers that moved since the
   card was drawn are shown again and nothing is written. ⛔ Never the original case's damage / reject / short-dated / photo evidence (a
   second credit). Then the scan's open buyer count-up notes are withdrawn (If-Match) and the BB row is set to the case's new total. */
RX.registerAct("fix-recv", ({el}) => { const iid = el.dataset.iid;
  const a = P.state.recvAsk; if(!a || a.iid !== iid) return;
  const typed = ((document.getElementById("rxRecvN") || {}).value || "").trim();      // read BEFORE run() re-renders the card
  return run(iid, async () => {
    if(a.big && typed !== String(a.n)){ P.state.fixErr = t("recv_retype_bad", {n:fmtN(a.n)}); return; }
    const v = findV(iid);
    if(!v || ((v.fin || {}).FinState || "") !== "posted" || (v.fields || {}).State === "cancelled" || unitsIn(v) !== a.old){ P.state.recvAsk = null; P.state.fixErr = t("pb_changed"); return; }
    if(RX.mode() !== "live"){ P.state.recvAsk = null; P.state.fixErr = t("recv_not_live"); return; }
    if(!poRead()){ P.state.fixErr = t("recv_noread"); return; }
    const f = v.fields || {};
    const c = caseNow(v), pk = posterPick(f, a.d), pc = pk && pk.po === a.po ? pk.pc : null;
    /* ⛔ anything moved since the card was drawn (another tablet, the poster, Finale): NOTHING is written and the card closes — a new card
       in its place would put a different meaning under the same finger (misuse review 2026-10-23 (3)) */
    if(!pc || c.total !== a.base || pc.have !== a.pc.have || pc.cap !== a.pc.cap || pc.over !== a.pc.over){ P.state.recvAsk = null; P.state.fixErr = pk ? t("recv_changed") : t("recv_noread"); return; }
    const cq = +f.CaseQty || 0;
    I.create(replacement(v, {Po:String(a.po || f.Po), FixBin:"rest-of:" + v.iid, Units:a.d, Cases: cq > 0 ? Math.round(a.d / cq * 100) / 100 : null, QtyKind: (cq > 0 && a.d % cq === 0) ? "full" : "part",
                             ScanAt:RX.iso(), OverConfirmed: !!pc.over, TempConfirmed: !!f.TempConfirmed,
                             DamagedUnits:null, RejectedUnits:null, ShortDated:false, FefoOverride: !!f.FefoOverride,
                             /* ⛔ a NEW receipt by whoever is signed in, put straight on the shelf: never the original scanner, never cart fields
                                (a cancelled "staged" record would be counted as a gone cart record by dupCompute — code review 2026-10-23 (6)) */
                             Operator: whoAmI() || f.Operator || "", Workflow:"direct", StagedArea:"", RecommendedBin:"", RecReasons:""}), {});
    P.state.recvAsk = null; P.state.fixing = null; P.state.fixErr = "";
    /* withdraw the buyer notes that asked for a HIGHER count on this scan — the tablet has now received it */
    let gone = 0, left = 0;
    for(const x of (I.allPo ? I.allPo() : I.allToday())){
      const g = x.fields || {};
      /* only the notes THIS receipt answers: a note asking for more than n stays with the buyer (code review 2026-10-23 (7)) */
      if(g.Kind !== "fix" || g.SplitOf !== iid || g.State === "cancelled" || !(+g.FixUnits > a.old && +g.FixUnits <= a.n)) continue;
      const r = await patchIntent(x, {State:"cancelled"}, "");
      if(r.ok){ gone++; continue; }
      const rec = I.byId(x.iid);
      if(r.why === "sending" && rec && !rec.sent && I.cancel(x.iid) === "cancelled"){ gone++; continue; }
      left++;
    }
    let msg = t("recv_done", {d:fmtN(a.d)}) + (gone ? t("recv_withdrawn") : "") + (left ? t("recv_left") : "");
    if(f.BbItemId){
      const b = await bb(v, {units: a.n});                           // the BB row is the WHOLE case, and n is the whole case
      if(!b.ok) msg += " " + t("recv_bb_failed", {why:b.why});      // ⛔ never "tap again": a second tap would receive a second time
    }
    say(iid, msg);
  });
});
RX.registerAct("fix-save", ({el}) => { const iid = el.dataset.iid;
  const raw = ((document.getElementById("rxFixN") || {}).value || "").trim();      // read BEFORE run() re-renders the panel
  return run(iid, async () => {
  const v = findV(iid); if(!v){ P.state.fixErr = t("pb_changed"); return; }
  const f = v.fields || {}, fs = (v.fin || {}).FinState || "";
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if(!(n >= 1)){ P.state.fixErr = t("fix_bad_n"); return; }
  const old = fs === "posted" ? unitsIn(v) : (+f.Units || 0);        // a posted scan: what Finale really got (code review 2026-10-23 (4))
  if(n === old){ P.state.fixErr = t("fix_same"); return; }
  /* the intent itself is corrected when the poster can still post it: not acted on (incl. staged), or a NOT_ON_PO hold (re-evaluated by
     the poster, so a note alone would let it post the OLD count — review (6)). Anything in Finale or on its way: a note for the buyer. */
  const reeval = fs === "held" && /^NOT_ON_PO\b/.test(String((v.fin || {}).FinReason || ""));
  if(!fs || reeval){
    const cq = +f.CaseQty || 0;
    const r = await patchIntent(v, cq > 0 ? {Units:n, Cases: Math.round(n / cq * 100) / 100} : {Units:n}, fs);
    if(!r.ok){ P.state.fixErr = whyText(r.why); return; }
  }else if(fs === "posted" && n > old && f.Po && f.Kind !== "fix" && RX.mode() === "live" && RX.po && RX.po.putCheck && RX.po.capOf && RX.po.capOf(f.Po, f.Sku)){
    /* ⭐ 2026-10-23 RECEIVE THE REST: a higher count on a scan Finale has is the rest of the PO line — show the numbers and ask (fix-recv).
       ⛔ Nothing is written here. ⛔ The PO-wide read must be loaded: an unseen scan on another tablet would make "on the way" wrong. */
    if(!poRead()){ P.state.fixErr = t("recv_noread"); return; }
    /* n is the WHOLE case: units already received later on this case (an earlier "receive the rest", a split part) count, so doing it
       twice is refused rather than received twice (misuse review 2026-10-23 (1)) */
    const c = caseNow(v);
    if(n <= c.total){ P.state.fixErr = c.more ? t("recv_case_has", {old:fmtN(c.old), more:fmtN(c.more), total:fmtN(c.total)}) : t("fix_same"); return; }
    const d = n - c.total;
    const pk = posterPick(f, d), pc = pk && pk.pc;
    if(!pc){ P.state.fixErr = t("recv_noread"); return; }
    /* more than one case past what is expected (a typo, 99999, cases typed as units) must be typed twice — derived, never a fixed cap */
    const cq = +f.CaseQty || 0, over = Math.max(0, pc.n - pc.cap);
    P.state.recvAsk = {iid, n, old, base: c.total, d, pc, po: pk.po, k: pk.k, big: pc.over && over > (cq > 0 ? cq : Math.max(1, pc.cap))}; P.state.fixErr = ""; P.state.draft = null;
    return;
  }else if(IN_FINALE.has(fs) && n < old){
    /* ⭐ PM-3110: a LOWER count on a scan in Finale asks first (units AND cases) — nothing is written here, the BB row is left alone */
    /* ⛔ review (2): the box is "Units in this CASE"; with units received later onto it the case is old + more, and a note for this scan
       alone would leave the later units in Finale — so the later record is removed first (it has its own Fix) */
    if(fs === "posted" && laterRest(v).length){ const c = caseNow(v); P.state.fixErr = t("fix_lower_case", {old:fmtN(c.old), more:fmtN(c.total - c.old), total:fmtN(c.total)}); return; }   // a split part is not a rest: its own count may go down
    if(fixRowsFor(iid).some(x => +x.FixUnits === n)){ P.state.fixing = null; P.state.fixErr = ""; say(iid, t("fix_already_sent", {n:String(n)})); return; }
    P.state.lowerAsk = {iid, n, old, fs}; P.state.fixErr = ""; P.state.draft = null;
    return;
  }else{
    /* ⭐ 2026-10-23 (crew: "it does not save the new 12 count when I press save count"): on a scan already in Finale the tablet sends the
       buyer a request and Finale is corrected by the buyer — the line keeps showing the old count until then. A second Save with the
       same number must not send the request again (three identical requests were sent for the cashew milk). */
    if(fixRowsFor(iid).some(x => +x.FixUnits === n)){ P.state.fixing = null; P.state.fixErr = ""; say(iid, t("fix_already_sent", {n:String(n)})); return; }
    tellBuyer(v, `crew: the count is ${n}, not ${old}` + (IN_FINALE.has(fs) ? ` — correct Finale by ${n - old > 0 ? "+" : ""}${n - old}` : ""), n);
  }
  /* ⛔ review (2): the BB row is the WHOLE case. A part of a split case moves the case total by its own change, never to its own count */
  const parts = partners(v);
  const caseUnits = parts.length ? old + parts.reduce((a, x) => a + (+((x.fields || {}).Units) || 0), 0) : old;
  if(f.BbItemId && I.state && (I.state.poErr || !I.state.poLoaded)){ P.state.fixing = null; say(iid, t("fix_saved_noBb")); return; }
  const b = await bb(v, {units: caseUnits - old + n});
  if(!b.ok){ P.state.fixErr = t("pb_bb_failed", {why:b.why}); return; }
  P.state.fixing = null; P.state.fixErr = "";
  say(iid, (fs && !reeval) ? t("fix_saved_finale") : t("fix_saved"));
}); });
/* ⭐ PM-3109 (2026-10-23, misuse review (8)): the units received LATER onto this same case through Fix ("receive the rest" — same BB row,
   its own root, scanned after this one), not already flagged "scanned twice" to the buyer. "Scanned twice" on the original while such a
   record is live used to tell the buyer to take the ORIGINAL off while the +N still posted, and never mentioned it. */
const atMs = (x) => { const m = Date.parse(((x && x.fields) || {}).ScanAt); return isNaN(m) ? 0 : m; };
function laterRest(v){
  const id = String((v.fields || {}).BbItemId || "");
  return partners(v).filter(x => (((x.fields || {}).Kind) || "intent") === "intent" && !flaggedTwice(x)
    && (restLink(x) === v.iid                                   // marked (since 2026-10-23 PM)
        || (id && String((x.fields || {}).BbItemId || "") === id && rootOf(x) !== rootOf(v) && atMs(x) > atMs(v) && !restLink(x))));   // the two made before the mark
}
function restRefusal(v){
  const r = laterRest(v); if(!r.length) return "";
  const x = r[0], more = r.reduce((s0, y) => s0 + unitsIn(y), 0), fsx = (x.fin || {}).FinState || "";
  return t("fix_twice_rest", {more:fmtN(more), when: ageText((x.fields || {}).ScanAt) + " ago", fin: IN_FINALE.has(fsx) ? t("fix_twice_rest_fin") : ""});
}
RX.registerAct("fix-twice", ({el}) => { const iid = el.dataset.iid;
  const v0 = findV(iid); if(!v0) return;
  const f0 = v0.fields || {};
  const no0 = restRefusal(v0); if(no0){ P.state.fixErr = no0; RX.call("drawer", "refresh", true); return; }      // ⛔ before the dialog
  if(!window.confirm(t("fix_rm_q", {name:nameOf(f0.Sku), units:String(f0.Units ?? "?"), bb:f0.BestBy || "none"}))) return;
  return run(iid, async () => {
    const v = findV(iid); if(!v){ P.state.fixErr = t("pb_changed"); return; }
    const f = v.fields || {}, fs = (v.fin || {}).FinState || "";
    const no = restRefusal(v); if(no){ P.state.fixErr = no; return; }
    if(!WITHDRAWABLE.has(fs)){                               // in Finale, or on its way there: never cancelled from the tablet
      const note = tellBuyer(v, `crew: scanned twice — take ${+f.Units || 0} off in Finale`, 0);
      if(String(f.BbItemId || "") && !(await noteSent(note))){ P.state.fixing = null; P.state.fixErr = ""; say(iid, t("fix_rm_finale_sending", {n: +f.Units || 0})); return; }
      const b = await bbApply(v, (m) => bbPlan(v, m));          // PM-3108/3169: the case's other parts, read from the list at write time
      if(!b.ok){ P.state.fixErr = t("pb_bb_failed", {why:b.why}); return; }
      P.state.fixing = null; P.state.fixErr = "";
      say(iid, b.kept ? t("fix_rm_finale_noread", {n: +f.Units || 0}) : (b.lowered != null ? t("fix_rm_finale_lower", {n:fmtN(b.lowered), d:fmtN(+f.Units || 0)}) : t("fix_rm_finale", {n: +f.Units || 0}))); return;
    }
    const out = await removeScan(v, fs);
    if(!out.ok){ P.state.fixErr = out.msg; return; }
    P.state.fixing = null; P.state.fixErr = ""; say(iid, out.msg);
  });
});
/* a re-render (a poll, another scan's answer) must not reset what is being typed (review 7) */
document.addEventListener("input", (e) => { if(e.target && e.target.id === "rxFixN") P.state.draft = {iid: P.state.fixing, val: e.target.value}; });
document.addEventListener("keydown", (e) => { if(e.key === "Enter" && e.target && e.target.id === "rxFixN"){ e.preventDefault(); const b = document.querySelector('[data-act="fix-save"]'); if(b) b.click(); } });

/* the history table: the chip, then the problem's words and button under it */
{ const prev = RX.chip; RX.chip = function(r){ const c = prev.apply(this, arguments); if(!c) return c;      // no chip ⇒ the page's own tag (FAILED / fix not sent) stays
    const p = P.forRow(r); if(!p) return c; const v = findV(p.iid); return c + (v ? P.html(v) : ""); }; }
})();
