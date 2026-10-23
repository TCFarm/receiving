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
  fix_in_finale:  "Already in Finale: the buyer gets a note to correct Finale; the best-by list is fixed now.",
  fix_saved:      "Count saved.",
  fix_saved_noBb: "Count saved. The best-by list was not changed (the rest of this case could not be read) — tell the buyer.",
  fix_saved_finale:"Count fixed on the best-by list. The buyer will correct Finale.",
  fix_rm_q:       "Remove this scan?\n\n{name}\n{units} units · best-by {bb}\n\nOnly if the SAME case was scanned twice.",
  fix_rm_finale:  "Removed from the best-by list. The buyer will take {n} off in Finale.",
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
      const r = await patchIntent(v, {State:"cancelled"}, "held");
      /* ⛔ ONLY after the cancel LANDED (the same rule as the Yes button): the new intent never coexists with a live copy of the old one */
      if(r.ok){ I.create(replacement(v, {TempConfirmed:true}), {}); n++; P.state.msg[v.iid] = t("pb_done_temp"); }
    }catch(e){ try{ console.error("rx auto-temp", e); }catch(_){} }
    finally{ BUSY.delete(v.iid); }
  }
  if(n){ RX.refresh(); RX.call("drawer", "refresh", true); }
  return n;
};
RX.on("intents", () => { P.autoRetire(); P.autoTemp(); });
/* ⭐ 2026-10-22 (PM-3069): a staged case taken off the cart list ("Not put away") must take its best-by row with it, or the date is
   counted twice when the case is scanned again (live: Rosemary Garlic Fries BB 4486 kept, rescanned as 4492 → 18u recorded vs 12).
   The SAME guard as "Scanned twice": never while another live part of the case uses that row, nor while the PO-wide read is down.
   Call it with the scan as it was BEFORE the cancel. -> {ok, kept?, why?} */
P.vOf = (iid) => findV(iid);
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
function partners(v){
  const id = String((v.fields || {}).BbItemId || ""), root = rootOf(v), out = [];
  let rowIds = []; try{ const r = rows.find(r => r.rx && ((r.rx.iids || []).indexOf(v.iid) >= 0 || r.rx.iid === v.iid)); if(r) rowIds = (r.rx.iids && r.rx.iids.length) ? r.rx.iids : [r.rx.iid]; }catch(_){}
  for(const x of (I.allPo ? I.allPo() : I.allToday())){
    if(x.iid === v.iid) continue; const f = x.fields || {};
    if(f.Kind === "fix" || f.State === "cancelled") continue;
    const rec = I.byId(x.iid); if(rec && rec.cancelled) continue;
    if((id && String(f.BbItemId || "") === id) || rootOf(x) === root || x.iid === root || rowIds.indexOf(x.iid) >= 0) out.push(x);
  }
  return out;
}
/* ⛔ also "shared" while the PO-wide read has failed or never loaded: an unseen part on another day must not lose its best-by */
function bbShared(v){ if(!String((v.fields || {}).BbItemId || "")) return false; if(I.state && (I.state.poErr || !I.state.poLoaded)) return true; return partners(v).length > 0; }
/* FinState values from which a scan can still be withdrawn: not acted on, or stopped by the poster. posting / uncertain / posted are
   (or may be) in Finale already — those get a fix row, never a cancel (review 2026-10-22 (1)) */
const WITHDRAWABLE = new Set(["", "held", "refused"]);
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
  I.create({Kind:"fix", Sku:f.Sku || "", Upc:f.Upc || "", Po:f.Po || "", SplitOf:v.iid,
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
RX.registerAct("pb-temp-yes", ({el}) => { const iid = el.dataset.iid; return run(iid, async () => {
  const v = findV(iid); const p = P.of(v); if(!p || p.kind !== "temp"){ say(iid, t("pb_changed")); return; }
  const r = await patchIntent(v, {State:"cancelled"}, "held");
  if(!r.ok){ say(iid, whyText(r.why)); return; }
  /* ⛔ ONLY after the cancel LANDED: the new intent can never coexist with a live copy of the old one */
  I.create(replacement(v, {TempConfirmed:true}), {});
  say(iid, t("pb_done_temp"));
}); });
async function removeScan(v, expectFin){
  if(!WITHDRAWABLE.has(String(expectFin || ""))) return {ok:false, msg:t("pb_changed")};
  const r = await patchIntent(v, {State:"cancelled"}, expectFin);
  if(!r.ok) return {ok:false, msg:whyText(r.why)};
  if(bbShared(v)) return {ok:true, msg:t("pb_done_rm_bb")};
  const b = await bb(v, {del:true});
  return b.ok ? {ok:true, msg:t("pb_done_rm")} : {ok:true, msg:t("pb_bb_failed", {why:b.why})};
}
RX.registerAct("pb-remove", ({el}) => { const iid = el.dataset.iid; return run(iid, async () => {
  const v = findV(iid); const p = P.of(v); if(!p || !p.act){ say(iid, t("pb_changed")); return; }
  const rec = I.byId(iid);
  if(p.kind === "denied" && rec && !rec.sent){ I.cancel(iid); const b = bbShared(v) ? {ok:true} : await bb(v, {del:true}); say(iid, b.ok ? t("pb_done_rm") : t("pb_bb_failed", {why:b.why})); return; }
  const out = await removeScan(v, (v.fin || {}).FinState || "");
  say(iid, out.msg);
}); });
RX.registerAct("pb-tell", ({el}) => { const iid = el.dataset.iid; return run(iid, async () => {
  const v = findV(iid); const p = P.of(v); if(!p){ say(iid, t("pb_changed")); return; }
  tellBuyer(v, p.kind === "over" ? "crew: KeHE really sent more than the PO — add the extra to the PO in Finale" : "crew: " + p.text);
  say(iid, p.kind === "over" ? t("pb_done_more") : t("pb_told"));
}); });

/* ───────────────────────── FIX A SCAN ───────────────────────── */
P.fixHtml = function(v){
  const f = v.fields || {}; const err = P.state.fixErr;
  return `<div class="rx-fix" data-iid="${esc(v.iid)}"><strong>${esc(t("fix_h"))}</strong>
    <div class="hint">${esc(nameOf(f.Sku))} · ${esc(String(f.Units ?? "?"))}u${f.BestBy ? " · bb " + esc(f.BestBy) : ""}${(v.fin || {}).FinState === "posted" ? " · " + esc(t("fix_in_finale")) : ""}</div>
    ${(() => { const fr = fixRowsFor(v.iid).filter(x => x.FixUnits != null && +x.FixUnits > 0); if(!fr.length) return "";
      const last = fr[fr.length - 1]; return `<div class="hint rx-pb-msg" role="status"><strong>${esc(t("fix_pending", {n:String(+last.FixUnits)}))}</strong></div>`; })()}
    <label class="hint" for="rxFixN">${esc(t("fix_units"))}</label>
    <input id="rxFixN" class="num" type="text" inputmode="numeric" maxlength="5" autocomplete="off" value="${esc(P.state.draft && P.state.draft.iid === v.iid ? P.state.draft.val : String(f.Units ?? ""))}" aria-label="${esc(t("fix_units"))}">
    <button type="button" class="rx-btn primary" data-act="fix-save" data-iid="${esc(v.iid)}">${esc(t("fix_save"))}</button>
    <button type="button" class="rx-btn" data-act="fix-twice" data-iid="${esc(v.iid)}">${esc(t("fix_twice"))}</button>
    <button type="button" class="rx-btn" data-act="fix-cancel" data-close="1">${esc(t("fix_cancel"))}</button>
    ${err ? `<div class="rx-note rx-red" role="alert">${esc(err)}</div>` : ""}</div>`;
};
RX.registerAct("fix-open", ({el}) => { P.state.fixing = el.dataset.iid; P.state.fixErr = ""; P.state.draft = null; RX.call("drawer", "refresh", true);
  setTimeout(() => { const i = document.getElementById("rxFixN"); if(i){ try{ i.focus(); i.select(); }catch(_){} } }, 30); });
RX.registerAct("fix-cancel", () => { P.state.fixing = null; P.state.fixErr = ""; RX.call("drawer", "refresh", true); });
RX.registerAct("fix-save", ({el}) => { const iid = el.dataset.iid;
  const raw = ((document.getElementById("rxFixN") || {}).value || "").trim();      // read BEFORE run() re-renders the panel
  return run(iid, async () => {
  const v = findV(iid); if(!v){ P.state.fixErr = t("pb_changed"); return; }
  const f = v.fields || {}, fs = (v.fin || {}).FinState || "";
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if(!(n >= 1)){ P.state.fixErr = t("fix_bad_n"); return; }
  if(n === +f.Units){ P.state.fixErr = t("fix_same"); return; }
  const old = +f.Units || 0;
  /* the intent itself is corrected when the poster can still post it: not acted on (incl. staged), or a NOT_ON_PO hold (re-evaluated by
     the poster, so a note alone would let it post the OLD count — review (6)). Anything in Finale or on its way: a note for the buyer. */
  const reeval = fs === "held" && /^NOT_ON_PO\b/.test(String((v.fin || {}).FinReason || ""));
  if(!fs || reeval){
    const cq = +f.CaseQty || 0;
    const r = await patchIntent(v, cq > 0 ? {Units:n, Cases: Math.round(n / cq * 100) / 100} : {Units:n}, fs);
    if(!r.ok){ P.state.fixErr = whyText(r.why); return; }
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
RX.registerAct("fix-twice", ({el}) => { const iid = el.dataset.iid;
  const v0 = findV(iid); if(!v0) return;
  const f0 = v0.fields || {};
  if(!window.confirm(t("fix_rm_q", {name:nameOf(f0.Sku), units:String(f0.Units ?? "?"), bb:f0.BestBy || "none"}))) return;
  return run(iid, async () => {
    const v = findV(iid); if(!v){ P.state.fixErr = t("pb_changed"); return; }
    const f = v.fields || {}, fs = (v.fin || {}).FinState || "";
    if(!WITHDRAWABLE.has(fs)){                               // in Finale, or on its way there: never cancelled from the tablet
      tellBuyer(v, `crew: scanned twice — take ${+f.Units || 0} off in Finale`, 0);
      const shared = bbShared(v);
      const b = shared ? {ok:true} : await bb(v, {del:true});
      if(!b.ok){ P.state.fixErr = t("pb_bb_failed", {why:b.why}); return; }
      P.state.fixing = null; P.state.fixErr = "";
      say(iid, t("fix_rm_finale", {n: +f.Units || 0})); return;
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
