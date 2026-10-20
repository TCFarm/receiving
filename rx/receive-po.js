/* receiving/rx/receive-po.js — PO awareness: which PO a case belongs to, the line counters, the case-quantity
   prefill and everything extra on the quantity card. OWNER: Procurement & Merchandising (hosted in ProductPipeline).

   ═══ THE RULES ═══
   • ⭐ NO PO PICKER. A scan is matched to the OLDEST-DUE open PO that still has quantity left for that SKU
     (order_id as the tie-break); when every PO that carries the SKU is full, the oldest is used and the case reads
     "over" (never refused, never blocking); a SKU on no pack PO is "not on a PO" (Julia decides). The crew never
     sees a PO number except in the strip, the start card and the drawers.
   • COUNTERS = the pack's `received_units` (what Finale held when the pack was built) + today's intents (this tablet
     AND the list read, de-duplicated by IntentId) + this tablet's best-by-only rows that have no intent.
     ⛔ An intent the poster posted at/before `pack.built` is already inside the pack figure — it is skipped, or it
     would be counted twice. Cancelled and `fix` rows never count.
   • ⛔ Counts are ADVISORY. The poster re-derives everything from live Finale; the page never decides what posts.
   • CASE QUANTITY PRECEDENCE (MASTER-PLAN §9.9): learned_gtin > po_line > learned_upc > finale_std > kehe_uos >
     kehe_casepack; a number the operator entered earlier today (page `packs[sku]`) beats them all. The prefill is
     ALWAYS shown with its source and always confirmed — never silent.

   API (RX.po): pos() line(po,sku) counts(po,line) matchFor(p|sku) classify(p,qty) caseQty(p) lineStatus(po,line)
                summary() dueText(po) scannedUnits(poId,sku) */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const PO = RX.po, t = RX.t;
const RANK = ["learned_gtin","po_line","learned_upc","finale_std","kehe_uos","kehe_casepack"];
const PKMAP = {g:"learned_gtin", learned_gtin:"learned_gtin", l:"learned_upc", learned_upc:"learned_upc",
               f:"finale_std", finale_std:"finale_std", u:"kehe_uos", kehe_uos:"kehe_uos", c:"kehe_casepack", kehe_casepack:"kehe_casepack"};
const pageRows = () => { try{ return rows; }catch(_){ return []; } };
const pageAudit = () => { try{ return isAudit(); }catch(_){ return false; } };
const num = (x) => (typeof x === "number" && isFinite(x)) ? x : (+x || 0);

PO.pos = function(){
  const d = RX.pack.data; if(!d) return [];
  return (d.pos || []).slice().sort((a, b) => String(a.eta || "9999").localeCompare(String(b.eta || "9999")) || String(a.order_id).localeCompare(String(b.order_id)));
};
PO.line = (po, sku) => ((po && po.lines) || []).find(l => l.sku === sku) || null;
const builtMs = () => { const d = RX.pack.data; const m = d && d.built ? Date.parse(d.built) : NaN; return isNaN(m) ? 0 : m; };

PO.scannedUnits = function(poId, sku){
  const built = builtMs(); let u = 0; const seen = new Set(); const shelves = [];
  for(const v of RX.intents.allToday()){
    const f = v.fields || {};
    if(f.Kind === "fix" || f.State === "cancelled" || f.Sku !== sku || String(f.Po || "") !== String(poId)) continue;
    if(v.fin && v.fin.FinState === "posted"){ const at = Date.parse(v.fin.FinAt); if(!isNaN(at) && at <= built) continue; }
    u += num(f.Units); seen.add(v.iid); if(f.Location) shelves.push(f.Location);
  }
  for(const r of pageRows()){
    if(r.audit || r.deleted || !r.prod || r.prod.sku !== sku || String(r._po || "") !== String(poId)) continue;
    if(r.rx && (r.rx.iid || (r.rx.fields && r.rx.fields.noIntent))) continue;
    if(r.units > 0) u += r.units;
  }
  return {units:u, shelves:[...new Set(shelves)]};
};
PO.counts = function(po, line){
  const ordered = num(line.ordered_units != null ? line.ordered_units : line.qty);
  const pack = num(line.received_units);
  const sc = PO.scannedUnits(po.order_id, line.sku);
  const total = pack + sc.units;
  return {ordered, pack, scanned:sc.units, total, left:ordered - total, shelves:sc.shelves};
};
PO.matchFor = function(p){
  const sku = typeof p === "string" ? p : (p && p.prod && p.prod.sku);
  if(!RX.pack.data || !sku || String(sku).startsWith("!")) return null;
  const cands = RX.pack.poLinesBySku(sku).slice().sort((a, b) => String(a.po.eta || "9999").localeCompare(String(b.po.eta || "9999")) || String(a.po.order_id).localeCompare(String(b.po.order_id)));
  if(!cands.length) return {po:null, line:null, left:0, status:"notpo", counts:null};
  let pick = null;
  for(const c of cands){ const k = PO.counts(c.po, c.line); if(k.left > 0){ pick = {c, k}; break; } }
  if(!pick){ pick = {c:cands[0], k:PO.counts(cands[0].po, cands[0].line)}; }
  return {po:pick.c.po, line:pick.c.line, left:pick.k.left, status: pick.k.left > 0 ? "ok" : "over", counts:pick.k};
};
const upcOf = (line) => num(line && line.units_per_case) > 0 ? num(line.units_per_case) : 0;
const fmt = (x) => String(Math.round(x * 100) / 100);
PO.classify = function(p, qty){
  const m = PO.matchFor(p); if(!m) return null;
  if(m.status === "notpo") return {status:"notpo", match:m};
  const c = m.counts, upc = upcOf(m.line), after = c.total + num(qty);
  const cases = upc > 0;
  const k = cases ? after / upc : after, n = cases ? c.ordered / upc : c.ordered;
  const status = after > c.ordered ? "over" : (after === c.ordered ? "complete" : "ok");
  return {status, k:fmt(k), n:fmt(n), unit:cases ? "cases" : "units", over:fmt(k - n), match:m};
};
PO.caseQty = function(p){
  const sku = p.prod.sku, found = {};
  let sess = 0; try{ sess = packs[sku]; }catch(_){}
  if(sess > 0) return {value:sess, basis:"session"};
  const cat = (p.gtin && CATALOG[p.gtin]) || p.prod || {};
  if(num(cat.pack) > 0) found[PKMAP[cat.pk] || "kehe_casepack"] = num(cat.pack);
  const info = RX.pack.skuInfo(sku);
  if(info && info.case_qty && num(info.case_qty.value) > 0 && RANK.indexOf(info.case_qty.basis) >= 0 && !(info.case_qty.basis in found)) found[info.case_qty.basis] = num(info.case_qty.value);
  const m = PO.matchFor(p);
  if(m && m.line && upcOf(m.line) > 0 && !found.po_line) found.po_line = upcOf(m.line);
  for(const b of RANK) if(found[b] > 0) return {value:found[b], basis:b};
  return null;
};
const basisText = (b) => ({session:t("qty_session"), po_line:t("qty_from_po"), learned_gtin:t("qty_learned"), learned_upc:t("qty_learned"),
  finale_std:t("qty_finale"), kehe_uos:t("qty_kehe"), kehe_casepack:t("qty_kehe")}[b] || "");

PO.dueText = function(po){
  const today = RX.today(); if(!po.eta) return "";
  const diff = Math.round((Date.parse(po.eta+"T00:00:00") - Date.parse(today+"T00:00:00")) / 86400000);
  if(diff === 0) return t("due_today");
  if(diff === 1) return t("due_tomorrow");
  const dow = new Date(po.eta+"T00:00:00").toLocaleDateString(undefined, {weekday:"short"});
  return diff < 0 ? t("due_late", {dow}) : "due "+dow;
};
PO.lineStatus = function(po, line){
  const c = PO.counts(po, line), upc = upcOf(line);
  const state = c.total <= 0 ? "notstarted" : (c.total < c.ordered ? "partial" : (c.total === c.ordered ? "done" : "over"));
  let problems = 0; const scans = [];
  for(const v of RX.intents.allToday()){
    const f = v.fields || {};
    if(f.Kind === "fix" || f.Sku !== line.sku || String(f.Po || "") !== String(po.order_id)) continue;
    const fs = v.fin && v.fin.FinState;
    if(fs === "held" || fs === "refused" || +f.DamagedUnits > 0 || (RX.intents.byId(v.iid) && RX.intents.byId(v.iid).denied)) problems++;
    scans.push({iid:v.iid, units:num(f.Units), bin:f.Location || "", at:f.ScanAt || "", op:f.Operator || "", bb:f.BestBy || "", fin:fs || "", state:f.State || ""});
  }
  const cases = upc > 0;
  return Object.assign({state, problems, scans, unit:cases ? "cases" : "units",
    k:fmt(cases ? c.total / upc : c.total), n:fmt(cases ? c.ordered / upc : c.ordered)}, c);
};
PO.summary = function(){
  return PO.pos().map(po => {
    const ls = (po.lines || []).map(l => PO.lineStatus(po, l));
    const done = ls.filter(x => x.state === "done" || x.state === "over").length;
    return {po, lines:ls.length, done, left:ls.length - done, due:PO.dueText(po), statuses:ls};
  });
};

/* ───────────────────────── the over-shipment confirm (round 3, Jack 2026-10-19) ─────────────────────────
   Before the shelf / stage step, when the units received for this SKU on its matched PO — what Finale held when the pack was built
   + every intent today (all tablets, the list read) + this tablet's unsent ones (all inside PO.counts) + THIS case — would be MORE
   than KeHE shipped (the pack line's `shipped_units`) or, when the shipped file is not known (null), more than we ordered, the crew
   is asked once: "You've now received {n} of {item}. KeHE says it shipped {m}. Is {n} right?"
   [Yes, {n} is right] (primary; the intent carries OverConfirmed = true) · [Fix the count] (back to the quantity, nothing recorded).
   ⛔ A CONFIRM, never a cap (hard boundary 6: no hard-coded maximums) and ⛔ never in Best-by-only (that flow runs no steps).
   ⛔ Not for a SKU that is on no PO (there is nothing to exceed). Enter = the primary; a stray scan is refused (the page's
   "finish this item first — scan NOT recorded"). */
PO.overCap = function(p, qty){
  const m = PO.matchFor(p); if(!m || !m.po || !m.line || !m.counts) return null;
  const line = m.line, c = m.counts;
  const sh = line.shipped_units;
  const known = (typeof sh === "number" && isFinite(sh));
  const cap = known ? sh : num(c.ordered);
  if(!(cap > 0) && !known) return null;
  const n = c.total + num(qty);
  return {n, cap, basis: known ? "shipped" : "ordered", over: n > cap, match: m};
};
RX.registerStep("overship", {
  keepScan: false,
  applies(ctx){
    if(ctx.fields && ctx.fields.overConfirmed) return false;
    const p = ctx.p, q = num(p.qty); if(!(q > 0)) return false;
    const o = PO.overCap(p, q); p.rx.over = o;
    return !!(o && o.over);
  },
  start(ctx){
    const o = ctx.p.rx.over || PO.overCap(ctx.p, num(ctx.p.qty)); if(!o){ ctx.done({}); return; }
    const n = fmt(o.n), m = fmt(o.cap);
    const body = `<span class="rx-pa-sub">${RX.esc(t(o.basis === "shipped" ? "overship_body" : "overship_body_ordered", {n, m}))}</span>`;
    prompt_("stop", RX.esc(t("overship_title", {n, item: ctx.p.prod.name})), body,
      `<div class="rx-pa-btns"><button type="button" class="rx-btn primary" data-act="over-yes" data-primary>${RX.esc(t("overship_yes", {n}))}</button>` +
      `<button type="button" class="rx-btn" data-act="over-fix" data-close="3">${RX.esc(t("overship_fix"))}</button></div>`);
    RX.sound("decide");
    setTimeout(() => { const b = document.querySelector("#promptArea [data-primary]"); if(b) b.focus(); }, 30);
  },
  onScan(){ return false; },
});
const overCtx = () => { const s = RX.state.step; return s && s.name === "overship" ? s.ctx : null; };
RX.registerAct("over-yes", () => { const c = overCtx(); if(c) c.done({overConfirmed: true}); });
RX.registerAct("over-fix", () => { if(overCtx()) RX.backToQty(); });

/* ───────────────────────── the qty card ───────────────────────── */
function typedQty(){ const el = document.getElementById("qty"); const n = parseInt(((el && el.value) || "").trim(), 10); return isNaN(n) ? 0 : n; }
function poLineHtml(p, qty){
  const k = PO.classify(p, qty);
  if(!k) return "";
  const dflt = "display:block;margin:0 0 9px;padding:8px 12px;border-left:5px solid var(--line);background:var(--card);font-size:14px";
  if(k.status === "notpo"){
    return `<span id="rxPoLine" class="rx-poline rx-notpo" style="${dflt};border-left-color:var(--stop)"><strong>${RX.esc(t("no_po_short"))}</strong>
      <span class="hint" style="display:inline"> You will be asked to set it aside until purchasing adds it.</span></span>`;
  }
  let msg, col = "var(--line)";
  if(k.status === "over"){ msg = t("over", {k:k.k, n:k.n, unit:k.unit, over:k.over}); col = "var(--wait)"; }
  else if(k.status === "complete"){ msg = t("complete", {k:k.k, n:k.n, unit:k.unit}); col = "var(--go)"; }
  else msg = t("makes", {k:k.k, n:k.n, unit:k.unit});
  const two = PO.pos().filter(po => PO.line(po, p.prod.sku)).length > 1 ? ` <span class="hint" style="display:inline">PO ${RX.esc(k.match.po.order_id)}</span>` : "";
  return `<span id="rxPoLine" class="rx-poline rx-${k.status}" style="${dflt};border-left-color:${col}">${RX.esc(msg)}${two}</span>`;
}
function kindNow(p){ return RX.state.qtyKindChoice || ((p.qtyShown == null || p.qtyShown === typedQty()) ? "full" : "part"); }
function chipsHtml(p){
  const kind = kindNow(p);
  const known = p.qtyShown != null;
  const src = p.qtyBasis ? `<span class="hint rx-qsrc" style="display:inline;margin-left:8px">${RX.esc(p.qtyShown)} per case — ${RX.esc(basisText(p.qtyBasis))}</span>` : "";
  const btn = (act, label, on) => `<button type="button" class="rx-chipbtn${on ? " on" : ""}" data-act="${act}" aria-pressed="${on}">${RX.esc(label)}</button>`;
  const changed = (known && kind === "part") ? `<button type="button" class="rx-chipbtn" data-act="qty-size-changed">${RX.esc(t("qty_size_changed"))}</button>` : "";
  const hint = !known ? `<span class="hint" style="display:block;margin-top:4px">${RX.esc(t("qty_full_hint"))}</span>` : "";
  return `<span id="rxQtyKind" style="display:block;margin-top:10px">${btn("qty-full", t("qty_full"), kind === "full")}${btn("qty-part", t("qty_part"), kind === "part")}${changed}
    <button type="button" class="rx-chipbtn" data-act="qty-damaged" style="margin-left:10px">${RX.esc(t("qty_damaged"))}</button>${src}${hint}</span>`;
}
RX.registerQtyExtra("po", (p) => {
  const q = p.qtyShown != null ? p.qtyShown : (upcOf((PO.matchFor(p) || {}).line) || 0);
  const upc = upcOf((PO.matchFor(p) || {}).line);
  /* ⭐ UX audit 2026-10-19: the chips are built BEFORE the qty box exists, so typedQty() read 0 and every known case
     showed "Part case" selected. Re-render once the card is mounted and the box holds its prefilled number. */
  setTimeout(refreshQtyCard, 0);
  return {body: poLineHtml(p, q > 0 ? q : (upc || 0)),
          after: `<span id="rxQtyX" style="display:block">${chipsHtml(p)}<span id="rxQtyAsk"></span><span id="rxDmg"></span></span>`};
});
function refreshQtyCard(){
  const p = (() => { try{ return pending; }catch(_){ return null; } })(); if(!p) return;
  const line = document.getElementById("rxPoLine");
  if(line){ const h = poLineHtml(p, typedQty()); const tmp = document.createElement("span"); tmp.innerHTML = h; if(tmp.firstChild) line.replaceWith(tmp.firstChild); }
  const k = document.getElementById("rxQtyKind");
  if(k){ const tmp = document.createElement("span"); tmp.innerHTML = chipsHtml(p); k.replaceWith(tmp.firstChild); }
}
document.addEventListener("input", (e) => { if(e.target && e.target.id === "qty" && document.getElementById("rxQtyX")) refreshQtyCard(); });

RX.registerAct("qty-full", () => { RX.state.qtyKindChoice = "full"; refreshQtyCard(); });
RX.registerAct("qty-part", () => { RX.state.qtyKindChoice = "part"; refreshQtyCard(); });
RX.registerAct("qty-size-changed", () => {
  const n = typedQty(); const ask = document.getElementById("rxQtyAsk"); if(!ask) return;
  if(!(n > 0)){ const el = document.getElementById("qty"); if(el) el.style.borderColor = "var(--stop)"; return; }
  ask.innerHTML = `<span style="display:block;margin-top:8px;padding:9px 12px;background:var(--card);border-left:5px solid var(--wait)">${RX.esc(t("qty_size_q", {n}))}
    <button type="button" class="rx-btn primary" data-act="qty-size-yes" style="margin-left:8px">${RX.esc(t("qty_size_yes", {n}))}</button>
    <button type="button" class="rx-btn" data-act="qty-size-no" data-close="1">${RX.esc(t("qty_size_no"))}</button></span>`;
});
RX.registerAct("qty-size-yes", () => {
  const n = typedQty(); const p = (() => { try{ return pending; }catch(_){ return null; } })(); if(!p || !(n > 0)) return;
  try{ packs[p.prod.sku] = n; }catch(_){}
  RX.state.qtyKindChoice = "full";
  const ask = document.getElementById("rxQtyAsk"); if(ask) ask.innerHTML = `<span class="hint" style="display:block;margin-top:6px">Using ${n} per case for this item today.</span>`;
  refreshQtyCard();
});
RX.registerAct("qty-size-no", () => { const ask = document.getElementById("rxQtyAsk"); if(ask) ask.innerHTML = ""; });

/* damaged units are never received: the good count goes in the box and the damaged count rides on the intent */
RX.registerAct("qty-damaged", () => {
  const box = document.getElementById("rxDmg"); if(!box) return;
  box.innerHTML = `<span style="display:block;margin-top:8px;padding:9px 12px;background:var(--card);border-left:5px solid var(--wait)">${RX.esc(t("dmg_q"))}
    <input id="rxDmgN" type="text" inputmode="numeric" maxlength="4" class="num" style="width:90px;font-size:18px;padding:8px;margin:0 8px;min-height:48px" aria-label="Damaged units">
    <button type="button" class="rx-btn primary" data-act="dmg-save">${RX.esc(t("dmg_save"))}</button>
    <button type="button" class="rx-btn" data-act="dmg-cancel" data-close="1">${RX.esc(t("dmg_cancel"))}</button></span>`;
  setTimeout(() => { const el = document.getElementById("rxDmgN"); if(el){ el.focus(); el.addEventListener("keydown", ev => { if(ev.key === "Enter"){ ev.preventDefault(); const b = box.querySelector('[data-act="dmg-save"]'); if(b) b.click(); } }); } }, 20);
});
RX.registerAct("dmg-cancel", () => {
  const p = (() => { try{ return pending; }catch(_){ return null; } })();
  if(p && p.rx && p.rx.fields){ delete p.rx.fields.damaged; }
  const box = document.getElementById("rxDmg"); if(box) box.innerHTML = "";
});
RX.registerAct("dmg-save", () => {
  const p = (() => { try{ return pending; }catch(_){ return null; } })(); if(!p) return;
  const k = parseInt((((document.getElementById("rxDmgN") || {}).value) || "").trim(), 10);
  const total = typedQty() || p.qtyShown || 0;
  if(isNaN(k) || k <= 0 || (total > 0 && k > total)){ const el = document.getElementById("rxDmgN"); if(el) el.style.borderColor = "var(--stop)"; return; }
  if(total > 0 && k >= total) return allDamaged(p, k);
  p.rx = p.rx || {}; p.rx.fields = Object.assign({}, p.rx.fields, {damaged:k});
  const q = document.getElementById("qty"); if(q) q.value = String(total - k);
  const box = document.getElementById("rxDmg"); if(box) box.innerHTML = `<span class="hint" style="display:block;margin-top:6px"><strong>${k} damaged</strong> — not received. ${total - k} to put away.</span>`;
  refreshQtyCard();
});
function allDamaged(p, k){
  /* whole case damaged: nothing to put away and NO BB receipt (a 0-unit receipt would pollute arrival-life). ⭐ ROUND 4 (D36): the
     photos come FIRST (rx/photos.js); the intent is written when they are done. ⛔ Damaged units are never posted to Finale. */
  return RX.photos.askAll(p, k);
}
})();
