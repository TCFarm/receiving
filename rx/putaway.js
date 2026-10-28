/* receiving/rx/putaway.js — the `exceptions` step (short-dated / expired) and the `shelf` step (D2: "Now scan the shelf tag"),
   the recommendation panel, split put-away, the armed shelf, the same-case add, the bin search, "Not all fit?".
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving). Written against the core API in rx-core.js
   (registerStep / registerIdle / registerAct / commitWith) — READ ITS HEADER FIRST. Needs rx/recommend.js loaded before it.

   ═══ THE RULES THIS FILE ENFORCES (SCANNER-UX §3.3/§5, MASTER-PLAN §9.1/§9.8) ═══
   • ⭐ THE TAG SCAN IS THE PROOF of where a case went. Candidates in the panel are INFORMATION, never buttons.
   • ⛔ NOTHING IS RECORDED BY A REFUSAL: an unknown tag, an inactive bin, a different product, a date barcode — each shows
     its sentence on the D2 card and writes no BB row and no intent. (A different product is consumed HERE, so the page's
     generic "finish this item first" never replaces our wording.)
   • ⛔ FEFO STOPS THE CREW ONLY ON A MEASURED DATE. The card appears when the operator scans a PICK shelf while a Finale-lot
     / scanned backstock date is OLDER than this case (`rank().fefo.measured`). An ESTIMATED date (the dated book) is advice
     text in the panel and nothing more. Same date is not older.
   • ⛔ A TEMPERATURE MISMATCH asks (`temp-yes` / `temp-no`); only Yes records it, with TempConfirmed.
   • ⭐ ROUND 4 (D12) SHELF MODE: a tag scanned with nothing pending in Put away here is the STICKY current shelf (banner "Putting away
     into …", Done / Escape / 10 min idle clear it, a different tag switches); every case goes there with no tag scan, FEFO/temperature
     still checked per case. (The ONE-SHOT armed shelf of rounds 1-3 survives only in the staged tray, staging.js.)
   • ⭐ ROUND 4: the `nopo` step (D9 hold) and the exceptions card's "Receive it (we'll ask KeHE for a credit)" (D13).
   • ⛔ NO SKIP. Shadow and live both: the practice toggle (start.js) is how a volunteer opts in; a case that cannot be put
     away is "Cancel this case" (BB row saved, no intent). If the pack never loaded the shelf step cancels with a plain flash
     rather than write an intent with no shelf.
   • A SPLIT writes ONE BB row per case and one intent per portion (SplitOf = the first portion's id). Portions are collected
     in memory and written together at the end; "Leave the rest" records the remainder as RejectedUnits (Julia's short list).
   • ⛔⛔ "NOT ALL FIT?" (a split of an intent that ALREADY EXISTS) NEVER SHRINKS THE FIRST INTENT UP FRONT (round-2 audit
     2026-10-19). Save only remembers the number; nothing is written until the other portion(s) have a shelf. Then ONE call
     (`RX.intents.splitLate`) queues the shrink — with the first intent's SplitOf = its own id as the ACK — and creates the new
     portions GATED: they are not sent until the shrink has LANDED. If the poster claimed the first intent in between, the
     shrink is refused, the portions are voided and Julia gets one fix row. ⇒ the case total can never exceed what was
     scanned (the poster checks the same ACK independently). An abandoned "Not all fit?" changes NOTHING: all the units stay on
     the first shelf, and the crew is told so.
   • A rejected short-dated / expired case is NOT a BB receipt (a receipt would put phantom stock in the dated book — the same
     rule as an all-damaged case): one intent with Units 0, RejectedUnits = the case, ShortDated true.

   API (RX.putaway): identify(raw) problems(item,info,rank) rankFor(p) itemTemp(sku,cls) armed{get,set,clear,take,fresh}
                     cur check(ctx) decisionHook onTag(...) — plus the acts listed in SCANNER-UX §9 "Shelf step"/"Flash". */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const REC = RX.recommend || window.RXRecommend;
if(!REC){ try{ console.warn("rx/putaway.js: rx/recommend.js did not load — the shelf step stays off"); }catch(_){} return; }
const PA = RX.putaway = {};
const esc = RX.esc;

/* ───────────────────────── copy (merged into RX.COPY; an existing key is never overwritten) ───────────────────────── */
const COPY_ADD = {
  btn_some:        "Only some go here",
  btn_cant:        "Can't scan the tag",
  btn_cancel_case: "Cancel this case",
  btn_leave_rest:  "Leave the rest",
  btn_back:        "Back",
  btn_cancel:      "Cancel",
  btn_save:        "Save",
  d2_units:        "{n} units · best by {bb}",
  d2_cases:        "{n} units · {c} cases · best by {bb}",
  d2_pending_n:    "{n} units go on the next shelf you scan.",
  d2_po:           "PO line: {msg}",
  unknown_tag_hint:"Scan the tag again. If the tag is wrong or missing, tap Can't scan the tag.",
  nothing_recorded:"Nothing was recorded.",
  date_in_d2:      "Dates go before the shelf. That scan was not recorded.",
  wrong_detail:    "The case you just scanned ({code}) was not recorded. Scan it again after.",
  temp_msg:        "This is a {shelf} shelf. {name} is {item}.",
  temp_title:      "Check the temperature",
  temp_no:         "No — scan another tag",
  temp_yes:        "Yes, it goes here",
  fefo_title:      "Older stock is in backstock.",
  fefo_body:       "{bin} has best by {older}. This case is {date}. Newer stock should go behind the older.",
  fefo_change:     "Put it in backstock instead",
  fefo_anyway:     "It goes on the shelf anyway",
  staging_note:    "Staging spot — it still needs to go to its shelf later.",
  samesku_title:   "Another case of {name}?",
  samesku_add:     "Add 1 case — same date",
  samesku_new:     "Different date",
  samesku_diff:    "That case has a different date ({date}), so it cannot be added to this one.",
  samesku_newmsg:  "Scan the shelf for the first case, then scan this one again. That scan was not recorded.",
  samesku_added:   "Added — {n} units · {c} cases.",
  overadd_undo:    "Undo — take that case off",
  overadd_undone:  "Took that case back off — {n} units.",
  binpick_title:   "Find the shelf tag",
  binpick_ph:      "Type part of the shelf name",
  binpick_none:    "No matching shelf.",
  binpick_used:    "used before",
  some_title:      "How many go on this shelf?",
  some_hint:       "The rest stays to be put away.",
  cancelrest_q:    "Leave {n} units unreceived? They'll show to the buyer as short.",
  cancelrest_yes:  "Yes, leave them",
  cancelcase_q:    "Cancel this case? The best-by is still saved; it just won't go into Finale.",
  cancelcase_yes:  "Yes, cancel",
  armed_banner:    "Shelf {bin} ready — scan the item to put here",
  armed_discard:   "Discard",
  rec_h:           "Where it goes",
  rec_best:        "BEST",
  rec_more:        "More places ({n})",
  rec_less:        "Fewer places",
  role_pick:       "Pick shelf",
  role_backstock:  "Backstock",
  role_staging:    "Staging",
  role_unknown:    "Other",
  rec_onhand:      "{n} on hand",
  rec_empty:       "empty",
  rec_oldest:      "oldest {d}",
  rec_cover:       "{a} left now · {b} with this",
  rec_slow:        "slow seller",
  rec_lasthere:    "last here {d}",
  short_title:     "Short date — {days} days left ({cls} needs {need}).",
  short_body:      "KeHE should have shipped more life than this. Receiving it creates a credit request for KeHE automatically.",
  short_keep:      "Receive it (we'll ask KeHE for a credit)",
  short_reject:    "Reject — don't put away",
  exp_title:       "It's expired. Receive it anyway?",
  exp_reject:      "Reject — set it aside",
  exp_keep:        "Receive it anyway",
  reject_flash:    "Not received — recorded for the buyer. Set it aside.",
  nopack_flash:    "Shelf list isn't loaded — saved best-by only. Receive this one in the Finale app.",
  last_split_q:    "How many did you put on {bin}?",
  last_split_bad:  "Enter a number from 1 to {max}.",
  last_split_one:  "Already split — fix it in the history.",
  last_split_stage:"Only a put-away can be split.",
  split_done:      "✓ {n} × {name} → {bin} (rest of the case)",
  split_short:     "Saved — {n} units left unreceived (short).",
  hold_title:      "Not on the KeHE order. Set it aside in the holding area until purchasing adds it.",
  hold_set:        "Set aside (holding)",
  hold_hint:       "Optional: scan a hold shelf tag, or type a label, so it can be found again.",
  hold_ph:         "Hold spot (optional)",
  hold_flash:      "Set aside in the holding area — waiting for purchasing to add it to the PO.",
  shelf_banner:    "Putting away into {bin}",
  offer_title:     "Put it on {bin}?",
  offer_line:      "Shelf {bin} was scanned first. Press Enter or the green button to put it there, or scan another shelf tag.",
  offer_all:       "Put all {n} on {bin}",
  offer_some:      "Put {n} on {bin}",
  shelf_hint:      "scan a different shelf tag to switch",
  shelf_n:         "{n} cases here",
  shelf_n1:        "{n} case here",
  shelf_done:      "Done with this shelf",
  shelf_switched:  "Now putting away into {bin}.",
  shelf_expired:   "Shelf {bin} was cleared after {m} idle minutes. Scan a shelf tag to start again.",
  shelf_cleared:   "Shelf cleared.",
};
for(const k of Object.keys(COPY_ADD)) if(!(k in RX.COPY)) RX.COPY[k] = COPY_ADD[k];
const t = RX.t;

/* the cards are styled here (rx.css is WP4a's file); classes are rx-pa-* so nothing collides */
(function css(){
  if(document.getElementById("rxPaCss")) return;
  const s = document.createElement("style"); s.id = "rxPaCss";
  s.textContent = `.rx-pa-sub{display:block;margin:4px 0;color:var(--ink-2)}
.rx-pa-note{display:block;margin:0 0 10px;padding:9px 12px;background:var(--card);border-left:5px solid var(--stop);border-radius:0 4px 4px 0;color:var(--ink)}
.rx-pa-po{display:block;margin:6px 0 4px;font-size:13px;color:var(--ink-2)}
.rx-pa-btns{display:flex;gap:9px;flex-wrap:wrap;margin-top:12px}
.rx-pa-btns .rx-btn{min-height:56px}
.rx-pa-panel{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:12px 14px}
.rx-pa-reason{font-size:15px;font-weight:700;margin:2px 0 8px}
.rx-pa-advice{font-size:13px;margin:0 0 8px;padding:6px 10px;border-left:4px solid var(--wait);background:var(--wait-soft)}
.rx-pa-area{font-size:18px;font-weight:700;margin:6px 0}
.rx-pa-cand{border:1px solid var(--line);border-radius:5px;padding:9px 12px;margin:0 0 8px}
.rx-pa-cand.best{border:2px solid var(--go);background:var(--go-soft)}
.rx-pa-bin{font-family:var(--mono);font-size:22px;font-weight:700}
.rx-pa-pill{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:3px;background:var(--go);color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;vertical-align:middle}
.rx-pa-role{margin-left:8px;font-size:13px;color:var(--ink-2)}
.rx-pa-meta{display:block;font-size:13px;color:var(--ink-2);margin-top:2px}
.rx-pa-search{width:100%;font-size:20px;padding:12px;border:1px solid var(--line);border-radius:4px;background:var(--ground);color:var(--ink);min-height:52px;margin:8px 0}
.rx-pa-results .rx-btn{display:block;width:100%;text-align:left;margin:0 0 6px;min-height:52px}
.rx-pa-num{width:120px;font-size:24px;padding:10px;margin:8px 0}
@media (orientation:portrait){.rx-pa-cand:not(.best) .rx-pa-meta{display:none}}`;
  document.head.appendChild(s);
})();

const $ = (id) => document.getElementById(id);
const pend = () => { try{ return pending; }catch(_){ return null; } };
const acct = () => { try{ return account; }catch(_){ return ""; } };
const pageRows = () => { try{ return rows; }catch(_){ return []; } };
const yf = (d) => (typeof yearFirst === "function") ? yearFirst(d) : esc(d);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const TEMP_NAME = {R: "REFRIGERATED", D: "DRY", F: "FROZEN"};
const roleName = (r) => t("role_" + (["pick", "backstock", "staging"].indexOf(r) >= 0 ? r : "unknown"));
const btn = (act, label, cls, extra) => `<button type="button" class="rx-btn ${cls || ""}" data-act="${act}" ${extra || ""}>${esc(label)}</button>`;
const focusPrimary = () => setTimeout(() => { const b = document.querySelector("#promptArea [data-primary]"); if(b) b.focus(); }, 30);
/* ⭐ ENTER = THE PRIMARY ANSWER on a decision card (temperature, FEFO, short-dated, expired, cancel, same case, and the
   tray's cards in staging.js — every rx card that marks a button `data-primary`). focusPrimary() puts focus on that button,
   but one tap on the card (or anywhere that is not a control) leaves focus on <body>, and Enter then did NOTHING — the
   design says Enter chooses the primary. (lead request, 2026-10-19)
   ⛔ Only an Enter aimed at NO control: an input/textarea/select keeps its own Enter, a focused button gets the browser's own
   click (so Enter on the secondary button is still the secondary), and the Enter that SAVED the previous box (the qty or the
   shelf scan that opened this card) has an input as its target and is ignored.
   ⛔ A scanner burst never reaches here: the page's burst guard (capture phase) swallows the whole run INCLUDING its Enter. */
document.addEventListener("keydown", (ev) => {
  if(ev.key !== "Enter" || ev.repeat || ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
  if(!RX.active()) return;
  const tg = ev.target;
  if(tg && tg !== document.body && tg !== document.documentElement){
    if(/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(tg.tagName) || tg.isContentEditable) return;
    if(tg.closest && tg.closest("button, a, input, textarea, select, [data-act]")) return;
  }
  const b = document.querySelector("#promptArea .prompt [data-primary]");
  if(!b || b.disabled) return;
  ev.preventDefault();
  b.click();
});
const shortD = (d) => REC.shortDate(d);

/* ───────────────────────── identifying a raw scan (no side effects: never writes a reject row) ───────────────────────── */
PA.itemTemp = function(sku, cls){
  const si = RX.pack.skuInfo(sku); if(si && si.temp) return String(si.temp).toUpperCase();
  const m = {Refrigerated: "R", Dry: "D", Frozen: "F"}[cls]; if(m) return m;
  const c = String(sku || "").charAt(0).toUpperCase(); return "RDF".indexOf(c) >= 0 && c ? c : "";
};
PA.entryFor = function(p){
  const sku = p.prod.sku, si = RX.pack.skuInfo(sku);
  return si || {name: p.prod.name, cls: p.prod.cls, temp: PA.itemTemp(sku, p.prod.cls), daily_rate: 0, candidates: []};
};
PA.identify = function(raw){
  const v = String(raw == null ? "" : raw).trim();
  if(!v) return {kind: "none"};
  const bi = RX.pack.binInfo(v);
  if(bi) return {kind: "tag", bin: bi.name, info: bi};
  let ais = {}; try{ ais = parseElementString(v) || {}; }catch(_){}
  let gtin = ais["01"] || ais["02"] || null, upc = null;
  if(gtin){
    const d = String(gtin).replace(/\D/g, "");
    if(d.length === 14 && checkDigit(d.slice(0, -1)) === d.slice(-1)) upc = gtin14ToConsumer(gtin);
  }else{
    const d = v.replace(/\D/g, "");
    if(d.length === 12 || d.length === 13) upc = d;
    else if(d.length === 14){ gtin = d; if(checkDigit(d.slice(0, -1)) === d.slice(-1)) upc = gtin14ToConsumer(d); }
  }
  if(!gtin && !upcCandidate(v) && /[\/-]/.test(v)){
    let d0 = null; try{ d0 = parseGs1Date(v); }catch(_){}
    if(d0 && plausibleBB(d0)) return {kind: "date", date: d0};
  }
  let prod = null;
  if(upc || gtin){ const rd = v.replace(/\D/g, ""); prod = (upc && CATALOG[upc]) || (gtin && CATALOG[gtin]) || CATALOG[rd] || null; }
  else{ prod = (typeof CATALOG_BY_SKU !== "undefined" && CATALOG_BY_SKU[v]) || null;
        if(!prod){ const low = v.toLowerCase(); for(const k in CATALOG){ const x = CATALOG[k]; if(x && x.sku && String(x.sku).toLowerCase() === low){ prod = x; break; } } } }
  if(!prod || !prod.sku) return {kind: "unknown", raw: v};
  let best = ""; try{ best = labelDate(ais).date || ""; }catch(_){}
  return {kind: "product", prod, sku: prod.sku, upc: upc || "", gtin: gtin || "", best, lot: ais["10"] || "", raw: v};
};

/* ───────────────────────── tag problems (shared with the tray) ───────────────────────── */
PA.rankFor = function(item, units){
  const si = RX.pack.skuInfo(item.sku);
  const entry = si || {name: item.name, cls: item.cls, temp: PA.itemTemp(item.sku, item.cls), daily_rate: 0, candidates: []};
  return REC.rank(entry, item.best, units != null ? units : item.units, RX.pack.data, RX.now());
};
/* -> ordered list of decisions this tag needs for this item: 'temp' then 'fefo'. ⛔ fefo ONLY when rank.fefo.measured. */
PA.problems = function(item, info, rank){
  const out = [];
  const it = PA.itemTemp(item.sku, item.cls), bt = String(info.temp || "").toUpperCase();
  if(it && bt && it !== bt) out.push("temp");
  if(info.role === "pick" && rank && rank.fefo && rank.fefo.measured) out.push("fefo");
  return out;
};
PA.tempText = (item, info) => t("temp_msg", {shelf: TEMP_NAME[String(info.temp).toUpperCase()] || String(info.temp), name: item.name, item: TEMP_NAME[PA.itemTemp(item.sku, item.cls)] || ""});
PA.fefoText = (item, rank) => t("fefo_body", {bin: rank.fefo.olderBin, older: rank.fefo.olderDate, date: item.best || ""});

/* ───────────────────────── the armed shelf (rx_armed_v1) ───────────────────────── */
const ARMED_KEY = "rx_armed_v1";
PA.armed = {
  get(){ const a = RX.store.get(ARMED_KEY, null); return (a && a.bin) ? a : null; },
  fresh(a){ return !!a && (RX.now() - (a.at || 0)) <= (RX.CFG.BIN_ARM || 4 * 60 * 1000); },
  set(bin){ RX.store.set(ARMED_KEY, {bin, at: RX.now()}); renderArmed(); },
  clear(){ RX.store.del(ARMED_KEY); renderArmed(); },
  take(){ const a = PA.armed.get(); PA.armed.clear(); return PA.armed.fresh(a) ? a : null; },     // ⛔ single-shot, fresh or stale
};
function renderArmed(){
  const el = $("rxArmed"); if(!el) return;
  let a = PA.armed.get();
  if(a && !PA.armed.fresh(a)){ RX.store.del(ARMED_KEY); a = null; }
  const h = (a && RX.active()) ? `<div class="banner rx-banner" role="status" style="border-left-color:var(--go)"><strong>${esc(t("armed_banner", {bin: a.bin}))}</strong>
      ${btn("binarmed-discard", t("armed_discard"), "", 'style="margin-left:8px"')}</div>` : "";
  if(el.dataset.h !== h){ el.innerHTML = h; el.dataset.h = h; }
}
RX.on("tick", renderArmed); RX.on("flow", renderArmed); RX.onBoot(renderArmed);
RX.registerAct("binarmed-discard", () => { PA.armed.clear(); RX.sound("decide"); });

/* ═══ ROUND 4 (D12) — SHELF MODE: a shelf tag scanned with nothing pending is the CURRENT SHELF until a different tag is scanned
   (switch), "Done with this shelf" / Escape, or SHELF_IDLE (10 min) with no case put away. Every case (scan → date → qty) is placed
   there with NO tag scan; the FEFO / temperature checks still run per case against it. Replaces the old one-shot armed shelf in
   Put away here (the one-shot `PA.armed` stays for the staged tray). ═══ */
const SHELF_KEY = "rx_shelf_v1";
const shelfIdle = () => RX.CFG.SHELF_IDLE || 10 * 60 * 1000;
const sameBin = (a, b) => String(a || "").toUpperCase() === String(b || "").toUpperCase();
PA.shelf = {
  notice: "",
  /* ⛔ ROUND 5: the shelf belongs to the person who scanned it. Sign out clears sessionStorage only, so the next person on this
     tablet (within the idle window) had their first case placed on someone else's shelf with no tag scan. */
  get(){ const x = RX.store.get(SHELF_KEY, null); if(!(x && x.bin)) return null;
    if(String(x.who || "") !== String(acct() || "")){ RX.store.del(SHELF_KEY); return null; }
    return x; },
  current(){ const x = PA.shelf.get(); if(!x) return null; if(RX.now() - (x.at || 0) > shelfIdle()){ PA.shelf.expire(); return null; } return x; },
  set(bin){ const x = PA.shelf.get(), same = !!x && sameBin(x.bin, bin);
    RX.store.set(SHELF_KEY, {bin, at: RX.now(), n: same ? (x.n || 0) : 0, who: acct() || ""}); PA.shelf.notice = ""; renderShelf(); return {had: !!x, same}; },
  bump(){ const x = PA.shelf.get(); if(!x) return; x.n = (x.n || 0) + 1; x.at = RX.now(); RX.store.set(SHELF_KEY, x); renderShelf(); },
  touch(){ const x = PA.shelf.get(); if(!x) return; x.at = RX.now(); RX.store.set(SHELF_KEY, x); },
  clear(){ RX.store.del(SHELF_KEY); renderShelf(); },
  expire(){ const x = PA.shelf.get(); if(!x) return; RX.store.del(SHELF_KEY);
    PA.shelf.notice = t("shelf_expired", {bin: x.bin, m: Math.round(shelfIdle() / 60000)}); renderShelf(); try{ RX.toast(PA.shelf.notice); }catch(_){} },
};
function renderShelf(){
  const el = $("rxShelfBar"); if(!el) return;
  const x = RX.active() && RX.flow() === "direct" ? PA.shelf.get() : null;
  let h = "";
  if(x) h = `<div class="banner rx-banner rx-shelfbar" role="status" style="border-left-color:var(--go)"><strong>${esc(t("shelf_banner", {bin: "\u0000"})).replace("\u0000", `<span class="num" id="rxShelfBin">${esc(x.bin)}</span>`)}</strong>
      <span class="hint" style="display:inline"> · ${esc(t("shelf_hint"))} · <span id="rxShelfN">${esc(t((x.n || 0) === 1 ? "shelf_n1" : "shelf_n", {n: x.n || 0}))}</span></span>
      <button type="button" class="rx-btn" data-act="shelf-done" data-close="3" style="margin-left:8px">${esc(t("shelf_done"))}</button></div>`;
  else if(PA.shelf.notice && RX.active() && RX.flow() === "direct") h = `<div class="banner rx-banner" role="status" id="rxShelfNote" style="border-left-color:var(--wait)">${esc(PA.shelf.notice)}</div>`;
  if(el.dataset.h !== h){ el.innerHTML = h; el.dataset.h = h; }
}
RX.on("tick", () => { const x = PA.shelf.get(); if(x && !pend() && RX.now() - (x.at || 0) > shelfIdle()) PA.shelf.expire(); renderShelf(); });
RX.on("flow", () => { if(RX.flow() !== "direct") RX.store.del(SHELF_KEY); renderShelf(); });
RX.on("day", () => { RX.store.del(SHELF_KEY); PA.shelf.notice = ""; renderShelf(); });
RX.onBoot(() => { PA.shelf.current(); renderShelf(); });
RX.registerAct("shelf-done", () => { PA.shelf.clear(); RX.toast(t("shelf_cleared")); RX.sound("decide"); });

RX.registerIdle("putaway", {
  get keepScan(){ return true; },
  onScan(raw){
    if(RX.flow() !== "direct") return false;
    const id = PA.identify(raw); if(id.kind !== "tag") return false;
    if(!id.info.active){
      prompt_("stop", esc(t("inactive", {bin: id.info.name})), esc(t("nothing_recorded")), undefined, {keepScan: true}); RX.sound("refused"); return true;
    }
    const r = PA.shelf.set(id.bin);
    if(r.had && !r.same) RX.toast(t("shelf_switched", {bin: id.bin}));
    RX.sound("staged"); return true;
  },
});

/* ───────────────────────── the exceptions step ───────────────────────── */
function daysLeft(d){ try{ return daysAway(d); }catch(_){ return 9999; } }
function exceptionFor(p){
  if(!p.best || !ISO.test(p.best) || p.noDate) return null;
  const da = daysLeft(p.best);
  if(da < 0) return {kind: "expired", days: -da};
  const cls = p.prod.cls || "Refrigerated";
  let need = 0; try{ need = (GUARANTEE || {})[cls] || 0; }catch(_){}
  if(need && da < need) return {kind: "short", days: da, need, cls};
  return null;
}
RX.registerStep("exceptions", {
  keepScan: false,
  applies(ctx){ ctx.p.rx.exc = exceptionFor(ctx.p); return !!ctx.p.rx.exc; },
  start(ctx){
    const e = ctx.p.rx.exc, p = ctx.p;
    const head = `<strong>${esc(p.prod.name)}</strong>${RX.idLine(p.prod.sku)}<span class="rx-pa-sub">best by ${yf(p.best)}</span>`;
    if(e.kind === "short"){
      prompt_("stop", esc(t("short_title", {days: e.days, cls: e.cls, need: e.need})), head + `<span class="rx-pa-sub">${esc(t("short_body"))}</span>`,
        `<div class="rx-pa-btns">${btn("short-keep", t("short_keep"), "primary", "data-primary")}${btn("short-reject", t("short_reject"))}${btn("step-back", t("btn_back_count"), "", 'data-close="3"')}</div>`);
    }else{
      prompt_("stop", esc(t("exp_title")), head + `<span class="rx-pa-sub">${e.days} day${e.days === 1 ? "" : "s"} past its best-by.</span>`,
        `<div class="rx-pa-btns">${btn("exp-reject", t("exp_reject"), "primary", "data-primary")}${btn("exp-keep", t("exp_keep"))}${btn("step-back", t("btn_back_count"), "", 'data-close="3"')}</div>`);
    }
    focusPrimary();
  },
  onScan(){ return false; },
});
const excCtx = () => { const s = RX.state.step; return s && s.name === "exceptions" ? s.ctx : null; };
/* ⭐ ROUND 3: Back on a step card = back to the quantity, the item KEPT, nothing recorded (rx-core RX.backToQty) */
RX.registerAct("step-back", () => { if(RX.state.step) RX.backToQty(); });
RX.registerAct("short-keep", () => { const c = excCtx(); if(c) c.done({shortDated: true}); });
RX.registerAct("exp-keep",   () => { const c = excCtx(); if(c) c.done({shortDated: true}); });
RX.registerAct("short-reject", () => { const c = excCtx(); if(c) PA.rejectCase(c); });
RX.registerAct("exp-reject",   () => { const c = excCtx(); if(c) PA.rejectCase(c); });

/* ⛔ a rejected case is NOT a BB receipt: one intent, Units 0, RejectedUnits = the case, then the item is dropped */
PA.rejectCase = function(ctx){
  const p = ctx.p, n = +p.qty || 0;
  const row = {prod: p.prod, upc: p.upc, gtin: p.gtin, best: p.best, lot: p.lot, units: n, qtyKind: null, qtyShown: p.qtyShown, _po: RX.poRef(p), _at: RX.now(), _op: acct(), id: "",
               rx: {iid: p.rx && p.rx.iid, ph: p.rx && p.rx.ph,
                    fields: {state: "ready", workflow: "direct", units: 0, rejected: n, shortDated: true,
                             damaged: ctx.fields.damaged || null, photoUrls: ctx.fields.photoUrls, fixNote: ctx.fields.fixNote}, flow: RX.flow()}};
  RX.intents.createFromRow(row);
  RX.emit("committed", row);
  RX.state.step = null; PA.cur = null;
  try{ pending = null; clearPrompt(); }catch(_){}
  RX.side.clear();
  RX.call("ui", "flashText", t("reject_flash"), null);
  RX.sound("decide"); RX.state.scanLog.length = 0; RX.refresh();
};

/* ═══ ROUND 4 (D9) — NOT ON ANY PO ⇒ HOLD. The case is set aside in the holding area (a staged intent, StagedArea "Hold: not on PO",
   RecReasons NOT_ON_PO) until purchasing adds the SKU to a PO; rx/staging.js keeps it disabled until the pack shows the line. ═══ */
PA.HOLD_AREA = "Hold: not on PO";
const holdCtx = () => { const s = RX.state.step; return s && s.name === "nopo" ? s.ctx : null; };
function renderHold(ctx, notice){
  const p = ctx.p, h = ctx.hold;
  const body = (notice ? `<span class="rx-pa-note" role="alert">${esc(notice)}</span>` : "") + `<strong>${esc(p.prod.name)}</strong>${RX.idLine(p.prod.sku)}` +
    `<span class="rx-pa-sub">${esc(t("hold_hint"))}</span>` +
    `<input id="rxHoldTag" class="rx-pa-search" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="60" placeholder="${esc(t("hold_ph"))}" aria-label="${esc(t("hold_ph"))}" value="${esc(h.tag)}">`;
  prompt_("stop", esc(t("hold_title")), body,
    `<div class="rx-pa-btns">${btn("hold-set", t("hold_set"), "primary", "data-primary")}${btn("hold-back", t("btn_back_count"), "", 'data-close="3"')}</div>`, {keepScan: true});
}
RX.registerStep("nopo", {
  get keepScan(){ const a = document.activeElement; return !(a && a.id === "rxHoldTag"); },
  applies(ctx){ const m = RX.po && RX.po.matchFor ? RX.po.matchFor(ctx.p) : null; return !!(m && m.status === "notpo"); },
  start(ctx){ ctx.hold = {tag: ""}; renderHold(ctx); RX.sound("decide"); },
  onEmptyEnter(ctx){ const b = document.querySelector('[data-act="hold-set"]'); if(b){ b.click(); return true; } return false; },
  onScan(ctx, raw){
    const id = PA.identify(raw);
    if(id.kind === "tag"){ ctx.hold.tag = id.bin; renderHold(ctx); RX.sound("staged"); return true; }
    return false;
  },
  abort(){},
});
document.addEventListener("input", (e) => { const c = holdCtx(); if(c && e.target && e.target.id === "rxHoldTag") c.hold.tag = e.target.value; });
RX.registerAct("hold-set", () => {
  const c = holdCtx(); if(!c) return;
  const el = document.getElementById("rxHoldTag"); if(el) c.hold.tag = el.value;
  const tag = String(c.hold.tag || "").trim().slice(0, 60);
  c.commit({state: "staged", workflow: "staged", stagedArea: PA.HOLD_AREA + (tag ? " · " + tag : ""), recReasons: ["NOT_ON_PO"], flash: t("hold_flash")});
});
RX.registerAct("hold-back", () => { if(holdCtx()) RX.backToQty(); });

/* ───────────────────────── the shelf step (D2) ───────────────────────── */
PA.cur = null;                                   // {ctx, d2}
function simulate(entry, portions, best){
  if(!portions.length) return entry;
  const e = Object.assign({}, entry); e.candidates = (entry.candidates || []).map(c => Object.assign({}, c, {lots: (c.lots || []).map(l => l.slice())}));
  for(const x of portions){
    const info = RX.pack.binInfo(x.bin);
    let c = e.candidates.find(q => String(q.bin).toUpperCase() === String(x.bin).toUpperCase());
    if(!c){ c = {bin: info ? info.name : x.bin, role: info ? info.role : "unknown", temp: info ? info.temp : null, units: 0, lots: [], hist: {rcv: 0, xin: 0, sold: 0}, last_in: RX.today()}; e.candidates.push(c); }
    c.units = (+c.units || 0) + x.units; c.lots.push([best || null, x.units]);
  }
  return e;
}
function recompute(d2, p){ d2.rank = REC.rank(simulate(PA.entryFor(p), d2.portions, p.best), p.best, d2.left, RX.pack.data, RX.now()); }
const itemOf = (p, d2) => ({sku: p.prod.sku, name: p.prod.name, cls: p.prod.cls, best: p.best, units: d2.pendingN || d2.left});

function poLine(p, d2){
  try{ const k = RX.po.classify(p, d2.total); if(!k) return ""; if(k.status === "notpo") return t("no_po_short");
    const key = k.status === "over" ? "over" : (k.status === "complete" ? "complete" : "makes");
    return t(key, {k: k.k, n: k.n, unit: k.unit, over: k.over}); }catch(_){ return ""; }
}
function renderMain(ctx, d2){
  const p = ctx.p;
  const offer0 = d2.offer && !d2.portions.length ? d2.offer : null;
  const title = (d2.portions.length || d2.late) ? t("split_rest", {n: d2.left}) : (offer0 ? t("offer_title", {bin: offer0}) : t("d2_title"));
  const bb = p.best ? yf(p.best) : "no date";
  const sub = d2.cases > 1 ? t("d2_cases", {n: d2.left, c: d2.cases, bb: "\u0000"}) : t("d2_units", {n: d2.left, bb: "\u0000"});
  let body = (d2.notice ? `<span class="rx-pa-note" role="alert">${d2.notice}</span>` : "") + `<strong>${esc(p.prod.name)}</strong>${RX.idLine(p.prod.sku)}` +
             `<span class="rx-pa-sub">${esc(sub).replace("\u0000", bb)}</span>`;
  const pl = d2.late ? "" : poLine(p, d2);
  if(pl) body += `<span class="rx-pa-po">${esc(t("d2_po", {msg: pl}))}</span>`;
  if(d2.pendingN) body += `<span class="rx-pa-sub"><strong>${esc(t("d2_pending_n", {n: d2.pendingN}))}</strong></span>`;
  const offer = d2.offer && !d2.portions.length ? d2.offer : null;
  if(offer) body += `<span class="rx-pa-sub" id="rxOffer">${esc(t("offer_line", {bin: "\u0000"})).replace("\u0000", `<strong class="num">${esc(offer)}</strong>`)}</span>`;
  const acts = `<div class="rx-pa-btns">${offer ? btn("bin-offer-yes", d2.pendingN ? t("offer_some", {n: d2.pendingN, bin: offer}) : t("offer_all", {n: d2.left, bin: offer}), "primary", "data-primary") : ""}` +
    `${d2.left > 1 ? btn("bin-some", t("btn_some")) : ""}${btn("bin-cant-scan", t("btn_cant"))}` +
    ((d2.portions.length || d2.late) ? btn("bin-cancel-rest", t("btn_leave_rest")) : btn("bin-cancel", t("btn_cancel_case"))) +
    btn("shelf-back", t("btn_back_count"), "", 'data-close="3"') + `</div>`;
  prompt_("go", esc(title), body, acts, {keepScan: true});
  renderPanel(d2, p);
}
function renderPanel(d2, p){
  const r = d2.rank; if(!r){ RX.side.clear(); return; }
  const topN = REC.cfgOf(RX.pack.data).top_n || 3;
  let h = `<div class="rx-pa-panel"><div class="rx-h">${esc(t("rec_h"))}</div><div class="rx-pa-reason" id="rxReason" data-code="${esc(r.reason.code)}">${esc(r.reason.text)}</div>`;
  for(const a of r.advice) h += `<div class="rx-pa-advice" data-advice="${esc(a.code)}">${esc(a.text)}</div>`;
  if(r.area) h += `<div class="rx-pa-area" id="rxArea">${esc(r.area.text)}</div>`;
  const card = (c, i) => {
    const onhand = c.units > 0 ? t("rec_onhand", {n: c.units}) : t("rec_empty");
    const parts = [esc(onhand)];
    if(c.oldest) parts.push(esc(t("rec_oldest", {d: "\u0000"})).replace("\u0000", yf(c.oldest)));
    if(c.role === "pick") parts.push(c.slow ? esc(t("rec_slow")) : (c.daysCover != null ? esc(t("rec_cover", {a: REC.fmtDays(c.daysCover), b: REC.fmtDays(c.daysCoverWith)})) : ""));
    if(c.units <= 0 && c.lastIn) parts.push(esc(t("rec_lasthere", {d: shortD(c.lastIn)})));
    return `<div class="rx-pa-cand${c.best ? " best" : ""}" data-bin="${esc(c.bin)}"><span class="rx-pa-bin">${esc(c.bin)}</span>${c.best ? `<span class="rx-pa-pill">${esc(t("rec_best"))}</span>` : ""}
      <span class="rx-pa-role">${esc(roleName(c.role))}</span><span class="rx-pa-meta">${parts.filter(Boolean).join(" · ")}</span></div>`;
  };
  r.cands.slice(0, topN).forEach((c, i) => { h += card(c, i); });
  const more = r.cands.slice(topN, topN + 5);
  if(more.length){
    if(PA.moreOpen){ more.forEach(c => { h += card(c); }); h += btn("rec-less", t("rec_less"), "", 'data-close="1"'); }
    else h += btn("rec-more", t("rec_more", {n: more.length}));
  }
  RX.side.set(h + `</div>`);
}
/* ⭐ ROUND 3: Back on the D2 card. A late "Not all fit?" split ⇒ nothing changes, every unit stays on the first shelf. A normal case ⇒
   back to the quantity, the item KEPT; portions already placed in memory are forgotten (nothing was written). */
RX.registerAct("shelf-back", () => { const c = PA.cur; if(!c || c.d2.sub !== "main") return;
  if(c.d2.late && c.d2.first){ PA.lateAbandoned(); return; }
  RX.backToQty(); });
RX.registerAct("rec-less", () => { PA.moreOpen = false; const c = PA.cur; if(c) renderPanel(c.d2, c.ctx.p); });
RX.registerAct("rec-more", () => { PA.moreOpen = true; const c = PA.cur; if(c) renderPanel(c.d2, c.ctx.p); });

function render(ctx, d2){
  const p = ctx.p;
  switch(d2.sub){
    case "some": {
      prompt_("go", esc(t("some_title")), `<strong>${esc(p.prod.name)}</strong>${RX.idLine(p.prod.sku)}<span class="rx-pa-sub">${esc(t("some_hint"))}</span>
        <input id="rxSomeN" class="num rx-pa-num" type="text" inputmode="numeric" maxlength="4" autocomplete="off" aria-label="${esc(t("some_title"))}" value="${d2.left}">`,
        `<div class="rx-pa-btns">${btn("bin-some-save", t("btn_save"), "primary")}${btn("bin-cancel-back", t("btn_back"), "", 'data-close="3"')}</div>`);
      setTimeout(() => { const el = $("rxSomeN"); if(el){ el.focus(); el.select(); el.onkeydown = (ev) => { if(ev.key === "Enter"){ ev.preventDefault(); const b = document.querySelector('[data-act="bin-some-save"]'); if(b) b.click(); } }; } }, 25);
      break; }
    case "bins": {
      prompt_("go", esc(t("binpick_title")), `<strong>${esc(p.prod.name)}</strong>${RX.idLine(p.prod.sku)}
        <input id="rxBinQ" class="rx-pa-search num" data-act="binpick-search" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${esc(t("binpick_ph"))}" aria-label="${esc(t("binpick_ph"))}">
        <span id="rxBinRes" class="rx-pa-results" style="display:block"></span>`,
        `<div class="rx-pa-btns">${btn("bin-cancel-back", t("btn_back"), "", 'data-close="3"')}</div>`);
      renderBinResults("");
      setTimeout(() => { const el = $("rxBinQ"); if(el) el.focus(); }, 25);
      break; }
    case "temp": {
      const info = RX.pack.binInfo(d2.cand.bin), it = itemOf(p, d2);
      prompt_("stop", esc(t("temp_title")), `<strong>${esc(PA.tempText(it, info))}</strong>${RX.idLine(p.prod.sku)}`,
        `<div class="rx-pa-btns">${btn("temp-no", t("temp_no"), "primary", "data-primary")}${btn("temp-yes", t("temp_yes"))}${btn("bin-cancel-back", t("btn_back"), "", 'data-close="3"')}</div>`);
      focusPrimary(); break; }
    case "fefo": {
      prompt_("stop", esc(t("fefo_title")), `<strong>${esc(p.prod.name)}</strong>${RX.idLine(p.prod.sku)}${esc(PA.fefoText(itemOf(p, d2), d2.rank))}`,
        `<div class="rx-pa-btns">${btn("fefo-change", t("fefo_change"), "primary", "data-primary")}${btn("fefo-anyway", t("fefo_anyway"))}${btn("bin-cancel-back", t("btn_back"), "", 'data-close="3"')}</div>`);
      focusPrimary(); break; }
    case "cancel": {
      prompt_("stop", esc(t("btn_cancel_case")), esc(t("cancelcase_q")),
        `<div class="rx-pa-btns">${btn("bin-cancel-yes", t("cancelcase_yes"), "primary", "data-primary")}${btn("bin-cancel-back", t("btn_back"), "", 'data-close="3"')}</div>`);
      focusPrimary(); break; }
    case "cancelrest": {
      prompt_("stop", esc(t("btn_leave_rest")), esc(t("cancelrest_q", {n: d2.left})),
        `<div class="rx-pa-btns">${btn("bin-cancel-rest-yes", t("cancelrest_yes"), "primary", "data-primary")}${btn("bin-cancel-back", t("btn_back"), "", 'data-close="3"')}</div>`);
      focusPrimary(); break; }
    case "overadd": {       /* ROUND 5: the added case pushed the count past what KeHE shipped (or we ordered) */
      const o = d2.overAdd.o, fm = (x) => String(Math.round(x * 100) / 100), n = fm(o.n), m = fm(o.cap);
      prompt_("stop", esc(t("overship_title", {n, item: p.prod.name})), `${RX.idLine(p.prod.sku)}<span class="rx-pa-sub">${esc(t(o.basis === "shipped" ? "overship_body" : "overship_body_ordered", {n, m}))}</span>`,
        `<div class="rx-pa-btns">${btn("over-add-yes", t("overship_yes", {n}), "primary", "data-primary")}${btn("over-add-undo", t("overadd_undo"), "", 'data-close="3"')}</div>`);
      focusPrimary(); break; }
    case "samesku": {
      const same = d2.same || {};
      prompt_("stop", esc(t("samesku_title", {name: p.prod.name})),
        RX.idLine(p.prod.sku) + (same.diff ? `<span class="rx-pa-note">${esc(t("samesku_diff", {date: same.best}))}</span>` : `<span class="rx-pa-sub">${d2.left} units now · +${d2.units0} → ${d2.left + d2.units0}</span>`),
        `<div class="rx-pa-btns">${same.diff ? "" : btn("samesku-add", t("samesku_add"), "primary", "data-primary")}${btn("samesku-newdate", t("samesku_new"), same.diff ? "primary" : "", same.diff ? "data-primary" : "")}${btn("bin-cancel-back", t("btn_back"), "", 'data-close="3"')}</div>`);
      focusPrimary(); break; }
    default: renderMain(ctx, d2);
  }
}
const setSub = (ctx, d2, sub) => { d2.sub = sub; render(ctx, d2); };
function noticeMain(ctx, d2, html, sound){ d2.sub = "main"; d2.notice = html; render(ctx, d2); if(sound) RX.sound(sound); }

function startShelf(ctx, opts){
  opts = opts || {};
  const p = ctx.p, rxs = p.rx;
  if(!RX.pack.data){ ctx.cancel({flash: t("nopack_flash")}); return; }
  const total = +p.qty || 0;
  const d2 = rxs.d2 = rxs.d2 || {total, left: total, units0: total, cases: 1, portions: [], sub: "main", notice: "", pendingN: null, cand: null, late: !!opts.late, first: opts.first || null, restUnits: 0};
  PA.cur = {ctx, d2}; PA.moreOpen = false;
  recompute(d2, p);
  const a = (!d2.late && !opts.noArmed && ctx.flow === "direct") ? PA.shelf.current() : null;       // round 4: shelf mode (sticky), not one-shot
  /* ⭐⭐ PM-3333 (Jack, 2026-10-28: "a shelf tag scanned first still works the same way including partial quantity"): the current shelf
     is OFFERED on this card — [Put all N on <shelf>] (Enter) or [Only some go here] — exactly the choices a shelf scanned after the item
     gets. It used to be placed with no question, so a part case could not be split when the tag came first. */
  if(a && !d2.portions.length && d2.offer === undefined){ PA.shelf.touch(); d2.offer = a.bin; }
  render(ctx, d2);       // ⛔ review 2026-10-28: focus STAYS in the scan box (a scanner typing into a button is refused by the burst
}                        //    guard) — Enter on the empty box accepts the offer (onEmptyEnter below)
PA.startShelf = startShelf;
RX.registerStep("shelf", {
  get keepScan(){ const c = PA.cur; return !c || c.d2.sub === "main"; },
  start(ctx){ startShelf(ctx); },
  onEmptyEnter(ctx){ const c = PA.cur; if(!c || c.ctx !== ctx || c.d2.sub !== "main" || !c.d2.offer || c.d2.portions.length) return false;
    const b = document.querySelector('[data-act="bin-offer-yes"]'); if(b){ b.click(); return true; } return false; },
  onScan(ctx, raw){
    const c = PA.cur; if(!c || c.ctx !== ctx) return false;
    const d2 = c.d2;
    if(d2.sub !== "main") return false;               // a card / input is open: the page's "finish this item first" refusal
    const id = PA.identify(raw);
    if(id.kind === "tag"){ onTag(ctx, d2, id.bin, "scanned"); return true; }
    if(id.kind === "date"){ try{ noteDropped(raw, "SHELF_DATE"); }catch(_){} noticeMain(ctx, d2, esc(t("date_in_d2")), "refused"); return true; }
    if(id.kind === "product"){
      if(id.sku === ctx.p.prod.sku && !d2.late){ d2.same = {best: id.best, diff: !!(id.best && ctx.p.best && id.best !== ctx.p.best)}; setSub(ctx, d2, "samesku"); RX.sound("decide"); return true; }
      try{ noteDropped(raw, "SHELF_WRONG"); }catch(_){}
      noticeMain(ctx, d2, `<strong>${esc(t("wrong_product", {name: ctx.p.prod.name}))}</strong> ${esc(t("wrong_detail", {code: String(raw).slice(0, 24)}))}`, "refused"); return true;
    }
    noticeMain(ctx, d2, `<strong>${esc(t("unknown_tag", {code: String(raw).slice(0, 24)}))}</strong> ${esc(t("unknown_tag_hint"))} ${esc(t("nothing_recorded"))}`, "refused");
    return true;
  },
  abort(){ const c = PA.cur; if(c && c.d2 && c.d2.late && c.d2.first){ PA.lateAbandoned(); return; } PA.cur = null; RX.side.clear(); },
});

/* a tag arrived (scanned, armed or typed): classify it, ask what it needs, then record the portion */
function onTag(ctx, d2, name, source){
  const info = RX.pack.binInfo(name);
  if(!info) return noticeMain(ctx, d2, `<strong>${esc(t("unknown_tag", {code: name}))}</strong> ${esc(t("unknown_tag_hint"))} ${esc(t("nothing_recorded"))}`, "refused");
  if(!info.active) return noticeMain(ctx, d2, `<strong>${esc(t("inactive", {bin: info.name}))}</strong> ${esc(t("nothing_recorded"))}`, "refused");
  d2.cand = {bin: info.name, source, flags: {}};
  /* review 2026-10-28: a DIFFERENT tag scanned on the offer card becomes the current shelf, so the next case is offered the shelf the
     crew is actually at — never the one they just left */
  if(source === "scanned"){ d2.offer = null; if(ctx.flow === "direct"){ const sh = PA.shelf.get(); if(sh && !sameBin(sh.bin, info.name)){ PA.shelf.set(info.name); RX.toast(t("shelf_switched", {bin: info.name})); } } }
  nextCheck(ctx, d2);
}
PA.onTag = onTag;
function nextCheck(ctx, d2){
  const info = RX.pack.binInfo(d2.cand.bin);
  const probs = PA.problems(itemOf(ctx.p, d2), info, d2.rank).filter(k => !d2.cand.flags[k]);
  if(probs.length){ setSub(ctx, d2, probs[0]); RX.sound("decide"); return; }
  commitPortion(ctx, d2);
}
function commitPortion(ctx, d2){
  const cand = d2.cand, info = RX.pack.binInfo(cand.bin), r = d2.rank;
  const n = Math.max(1, Math.min(d2.pendingN || d2.left, d2.left));
  d2.portions.push({bin: info.name, binSource: cand.source, units: n, tempConfirmed: !!cand.flags.temp, fefoOverride: !!cand.flags.fefo,
    recommendedBin: r.cands[0] ? r.cands[0].bin : "", recReasons: [r.reason.code], staging: info.role === "staging", rejected: null});
  d2.left -= n; d2.pendingN = null; d2.cand = null; d2.sub = "main"; d2.notice = "";
  if(d2.left > 0){ recompute(d2, ctx.p); render(ctx, d2); RX.sound("staged"); return; }
  finish(ctx, d2);
}
const mk = (x) => ({bin: x.bin, binSource: x.binSource, units: x.units, tempConfirmed: x.tempConfirmed, fefoOverride: x.fefoOverride,
                    recommendedBin: x.recommendedBin, recReasons: x.recReasons, state: "ready", workflow: "direct", rejected: x.rejected || null});
function finish(ctx, d2){
  if(d2.late) return finishLate(ctx, d2);
  const ps = d2.portions;
  if(!ps.length){ PA.cur = null; ctx.cancel({}); return; }
  if(d2.restUnits) ps[ps.length - 1].rejected = d2.restUnits;
  const fields = mk(ps[0]);
  fields.extra = ps.slice(1).map(x => Object.assign(mk(x), {damaged: null, photoUrls: null, fixNote: null}));
  const staging = ps.some(x => x.staging);
  { const sh = ctx.flow === "direct" ? PA.shelf.get() : null; if(sh && ps.some(x => sameBin(x.bin, sh.bin))) PA.shelf.bump(); }
  PA.cur = null;
  ctx.commit(fields);
  if(staging){ const l = document.querySelector("#lastArea .last"); if(l) l.insertAdjacentHTML("beforeend", `<div class="meta">${esc(t("staging_note"))}</div>`); }
  if(d2.restUnits) RX.toast(t("split_short", {n: d2.restUnits}));
}

/* ───────────────────────── the acts ───────────────────────── */
const cs = () => PA.cur;
RX.registerAct("bin-some", () => { const c = cs(); if(c && c.d2.sub === "main") setSub(c.ctx, c.d2, "some"); });
/* PM-3333: put this case (or the "only some" part) on the shelf that was scanned first — the same checks as scanning the tag now */
RX.registerAct("bin-offer-yes", () => { const c = cs(); if(!c || c.d2.sub !== "main" || !c.d2.offer) return;
  const bin = c.d2.offer; c.d2.offer = null; onTag(c.ctx, c.d2, bin, "armed"); });
RX.registerAct("bin-some-save", () => {
  const c = cs(); if(!c || c.d2.sub !== "some") return;
  const el = $("rxSomeN"), n = parseInt(((el && el.value) || "").trim(), 10), d2 = c.d2;
  if(isNaN(n) || n < 1 || n > d2.left){ if(el) el.style.borderColor = "var(--stop)"; return; }
  d2.pendingN = n >= d2.left ? null : n;
  noticeMain(c.ctx, d2, "", null);
});
RX.registerAct("bin-cant-scan", () => { const c = cs(); if(c && c.d2.sub === "main") setSub(c.ctx, c.d2, "bins"); });
RX.registerAct("binpick-search", () => {});
function renderBinResults(q){
  const c = cs(), box = $("rxBinRes"); if(!c || !box) return;
  const res = RX.pack.searchBins(q, c.ctx.p.prod.sku, 12);
  box.innerHTML = res.length ? res.map(b => `<button type="button" class="rx-btn" data-act="binpick-select" data-bin="${esc(b.name)}"><span class="num">${esc(b.name)}</span> · ${esc(roleName(b.role))}${b.cand ? " · " + esc(t("binpick_used")) : ""}</button>`).join("")
                              : `<span class="rx-pa-sub">${esc(t("binpick_none"))}</span>`;
}
document.addEventListener("input", (e) => { if(e.target && e.target.id === "rxBinQ") renderBinResults(e.target.value); });
RX.registerAct("binpick-select", ({el}) => { const c = cs(); if(c && c.d2.sub === "bins") onTag(c.ctx, c.d2, el.getAttribute("data-bin"), "typed"); });
RX.registerAct("bin-cancel", () => { const c = cs(); if(c && c.d2.sub === "main" && !c.d2.portions.length && !c.d2.late) setSub(c.ctx, c.d2, "cancel"); });
RX.registerAct("bin-cancel-yes", () => { const c = cs(); if(c && c.d2.sub === "cancel"){ PA.cur = null; c.ctx.cancel({}); } });
RX.registerAct("bin-cancel-rest", () => { const c = cs(); if(c && c.d2.sub === "main" && (c.d2.portions.length || c.d2.late)) setSub(c.ctx, c.d2, "cancelrest"); });
RX.registerAct("bin-cancel-rest-yes", () => {
  const c = cs(); if(!c || c.d2.sub !== "cancelrest") return;
  c.d2.restUnits = c.d2.left; c.d2.left = 0;
  finish(c.ctx, c.d2);
});
RX.registerAct("bin-cancel-back", () => { const c = cs(); if(c && c.d2.sub !== "main"){ c.d2.cand = null; noticeMain(c.ctx, c.d2, "", null); } });
RX.registerAct("samesku-add", () => {
  const c = cs(); if(!c || c.d2.sub !== "samesku" || c.d2.same.diff) return;
  const d2 = c.d2, p = c.ctx.p, add = d2.units0;
  p.qty = (+p.qty || 0) + add; d2.left += add; d2.total += add; d2.cases = (d2.cases || 1) + 1;
  const kind0 = p.qtyKind;
  p.qtyKind = "part";                                   // ⛔ a summed pile is not evidence of the CASE size (no !PACK row)
  recompute(d2, p);
  /* ⛔ ROUND 5: the over-shipment question ran ONCE, before the shelf step. An added case could push the count past what KeHE shipped
     with no question (held for Julia), or stretch an earlier "Yes, 12 is right" to 18 (posted without anyone confirming 18). Ask again. */
  let o = null; try{ o = RX.po && RX.po.overCap ? RX.po.overCap(p, +p.qty || 0) : null; }catch(_){ o = null; }
  if(o && o.over){ d2.overAdd = {add, kind: kind0, prev: !!c.ctx.fields.overConfirmed, o}; c.ctx.fields.overConfirmed = false; setSub(c.ctx, d2, "overadd"); RX.sound("decide"); return; }
  noticeMain(c.ctx, d2, esc(t("samesku_added", {n: d2.total, c: d2.cases})), "saved");
});
RX.registerAct("over-add-yes", () => {
  const c = cs(); if(!c || c.d2.sub !== "overadd") return;
  const d2 = c.d2; c.ctx.fields.overConfirmed = true; d2.overAdd = null;
  noticeMain(c.ctx, d2, esc(t("samesku_added", {n: d2.total, c: d2.cases})), "saved");
});
RX.registerAct("over-add-undo", () => {        // Escape = this (data-close 3): the add is taken back, nothing recorded
  const c = cs(); if(!c || c.d2.sub !== "overadd") return;
  const d2 = c.d2, p = c.ctx.p, x = d2.overAdd;
  p.qty = (+p.qty || 0) - x.add; d2.left -= x.add; d2.total -= x.add; d2.cases = Math.max(1, (d2.cases || 1) - 1); p.qtyKind = x.kind;
  c.ctx.fields.overConfirmed = x.prev; d2.overAdd = null;
  recompute(d2, p);
  noticeMain(c.ctx, d2, esc(t("overadd_undone", {n: d2.total})), "decide");
});
RX.registerAct("samesku-newdate", () => { const c = cs(); if(c && c.d2.sub === "samesku") noticeMain(c.ctx, c.d2, esc(t("samesku_newmsg")), "decide"); });

/* the temperature / FEFO decisions. The tray (staging.js) hooks the same four names through PA.decisionHook */
function decide(name){
  const c = cs();
  if(c && (c.d2.sub === "temp" || c.d2.sub === "fefo")){
    const d2 = c.d2;
    if(name === "temp-no" || name === "fefo-change"){ d2.cand = null; noticeMain(c.ctx, d2, "", null); return; }
    d2.cand.flags[name === "temp-yes" ? "temp" : "fefo"] = true; nextCheck(c.ctx, d2); return;
  }
  if(PA.decisionHook) PA.decisionHook(name);
}
for(const n of ["temp-yes", "temp-no", "fefo-change", "fefo-anyway"]) RX.registerAct(n, () => decide(n));

/* ───────────────────────── "Not all fit?" (last-split) — a late portion for a case that is already saved ───────────────────────── */
const splitRow = () => { const D = RX.drawer && RX.drawer.state; if(D && D.open === "row"){ const r = pageRows().find(x => x.n === D.rowN); if(r) return r; } return RX.state.lastRow; };
RX.registerAct("last-split", () => {
  const row = splitRow(); if(!row || !row.rx) return;
  const recs = RX.intents.forRow(row);
  if(recs.length !== 1){ RX.toast(t("last_split_one")); return; }
  const rec = recs[0], f = rec.fields;
  if(f.State !== "ready" || !f.Location){ RX.toast(t("last_split_stage")); return; }
  if(!RX.intents.editable(rec)){ RX.toast(t("fix_sent")); return; }
  if(pend()){ RX.toast(t("finish_first")); return; }
  RX.call("drawer", "close");
  PA.lastSplit = {row, iid: rec.iid, bin: f.Location, units: +f.Units || 0};
  RX.flash(`<div class="last rx-last" role="group"><div class="nm">${esc(t("last_split_q", {bin: f.Location}))}</div>
    <input id="rxLastN" class="num rx-pa-num" type="text" inputmode="numeric" maxlength="4" autocomplete="off" aria-label="${esc(t("last_split_q", {bin: f.Location}))}">
    <div class="rx-lastbtns">${btn("last-split-save", t("btn_save"), "primary")}${btn("last-split-cancel", t("btn_cancel"), "", 'data-close="3"')}</div></div>`);
  setTimeout(() => { const el = $("rxLastN"); if(el){ el.focus(); el.onkeydown = (ev) => { if(ev.key === "Enter"){ ev.preventDefault(); const b = document.querySelector('[data-act="last-split-save"]'); if(b) b.click(); } }; } }, 25);
});
RX.registerAct("last-split-cancel", () => { PA.lastSplit = null; const r = RX.state.lastRow; if(r && r.rx && RX.intents.forRow(r).length) RX.call("ui", "flashPut", r, RX.intents.forRow(r)); else RX.flash(""); });
RX.registerAct("last-split-save", () => {
  const s = PA.lastSplit; if(!s) return;
  const el = $("rxLastN"), n = parseInt(((el && el.value) || "").trim(), 10), max = s.units - 1;
  if(isNaN(n) || n < 1 || n > max){ if(el){ el.style.borderColor = "var(--stop)"; } RX.toast(t("last_split_bad", {max})); return; }
  const rec = RX.intents.byId(s.iid); if(!rec || !RX.intents.editable(rec)){ RX.toast(t("fix_sent")); return; }
  /* ⛔ ROUND-2 (1/2): NOTHING is written here — the shrink waits for the rest to have a shelf (finishLate) */
  const row = s.row, rest = s.units - n;
  PA.lastSplit = null;
  const p = {upc: row.upc, prod: row.prod, gtin: row.gtin || "", lot: row.lot || "", best: row.best, source: row.source, qty: rest, qtyKind: "part", qtyShown: row.qtyShown,
             dateConfirmed: true, rx: {done: true, late: true, fields: {}}};
  const ctx = {p, flow: "direct", step: "shelf", mode: RX.mode(), fields: p.rx.fields, po: null, late: true,
               done(){}, commit(){}, cancel(){ lateAbort(PA.cur, {kept: s.units, bin: s.bin}); }, side(html){ RX.side.set(html); }, clearSide(){ RX.side.clear(); }};
  try{ pending = p; }catch(_){ return; }
  RX.state.step = {name: "shelf", ctx};
  RX.flash("");
  startShelf(ctx, {late: true, first: {iid: s.iid, row, keep: n, units: s.units, bin: s.bin}});
});
/* `kept` ⇒ the late split was ABANDONED: nothing was written, so every unit is still on the first shelf — say so (round-2 (2)) */
function lateAbort(c, kept){
  PA.cur = null; RX.state.step = null;
  try{ pending = null; clearPrompt(); }catch(_){}
  RX.side.clear();
  if(kept && kept.kept) RX.call("ui", "flashText", t("last_split_kept", {n: kept.kept, bin: kept.bin}), null);
  RX.refresh();
}
/* a late split interrupted by the page itself (another flow, a reload of the step) is an abandon too: nothing was written */
PA.lateAbandoned = function(){ const c = PA.cur; if(c && c.d2 && c.d2.late && c.d2.first) lateAbort(c, {kept: c.d2.first.units, bin: c.d2.first.bin}); };
function finishLate(ctx, d2){
  const p = ctx.p, first = d2.first, ps = d2.portions;
  if(d2.restUnits && ps.length) ps[ps.length - 1].rejected = d2.restUnits;
  /* ⛔ AUDIT 2026-10-19 (K, M3): a late portion is part of the SAME scanned case — it keeps the first portion's ScanAt and
     PageMode. "Now" let a case scanned while the page showed shadow pass the poster's live checks after live began. */
  const orig = (RX.intents.byId(first.iid) || {}).fields || {};
  const at0 = Date.parse(orig.ScanAt || "");
  const row = first.row, synth = {prod: p.prod, upc: p.upc, gtin: p.gtin, best: p.best, lot: p.lot, units: p.qty, qtyKind: "part", qtyShown: p.qtyShown, _po: RX.poRef(p) || "",
                                  _at: isNaN(at0) ? (row._at || RX.now()) : at0, _op: acct(), id: row.id || ""};
  /* ⛔ ROUND 5: ...and the case's DECISIONS: the crew's over-shipment Yes (else the poster holds the portion OVER_UNCONFIRMED) and
     short-dated (else the KeHE credit list loses those units). */
  const keepMode = (f) => { if(orig.PageMode) f.PageMode = orig.PageMode; if(orig.ScanAt) f.ScanAt = orig.ScanAt;
    if(orig.OverConfirmed === true) f.OverConfirmed = true; if(orig.ShortDated === true) f.ShortDated = true; return f; };
  const rawScans = JSON.stringify(RX.state.scanLog.slice());
  const kids = [];
  if(!ps.length && d2.restUnits){      // nothing more was put away: the rest is recorded as short, on an intent of its own
    const f = RX.intents.baseFields(synth, {state: "ready", workflow: "direct", units: 0, rejected: d2.restUnits}, "direct");
    f.RawScans = rawScans; f.BbItemId = row.id ? String(row.id) : ""; kids.push(keepMode(f));
  }
  for(const x of ps){
    const f = RX.intents.baseFields(synth, Object.assign(mk(x), {damaged: null}), "direct");
    f.RawScans = rawScans; f.BbItemId = row.id ? String(row.id) : "";
    kids.push(keepMode(f));
  }
  /* ⛔ ROUND-2 (1): the shrink and the new portions in ONE call — the portions are gated on the shrink landing */
  const cq = +orig.CaseQty > 0 ? +orig.CaseQty : 0, keep = first.keep;
  const res = RX.intents.splitLate(first.iid, cq ? {Units: keep, Cases: Math.round(keep / cq * 100) / 100} : {Units: keep}, kids);
  const bins = [...new Set(ps.map(x => x.bin))].join(" + ");
  const placed = ps.reduce((a, x) => a + x.units, 0);
  lateAbort(PA.cur || {});
  if(!res.ok){
    /* the poster acted on the first intent while the crew was finding the shelf: it carries the whole case. Julia's fix row. */
    RX.intents.fix({of: first.iid, units: placed || null, bin: bins, note: `split too late: ${placed} of the ${first.units} units are on ${bins || "no shelf (left as short)"}`});
    RX.call("ui", "flashText", t("split_refused"), null); RX.sound("refused"); RX.state.scanLog.length = 0; RX.refresh(); return;
  }
  RX.call("ui", "flashText", d2.restUnits ? t("split_short", {n: d2.restUnits}) : t("split_done", {n: placed, name: p.prod.name, bin: bins}), null);
  RX.sound("saved"); RX.state.scanLog.length = 0; RX.refresh();
}
})();
