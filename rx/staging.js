/* receiving/rx/staging.js — SORT FIRST: the `stage` step ("Which cart?"), and PUT AWAY STAGED: the staged list, the tray,
   the lot pick, leftovers. OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).
   Written against the core API in rx-core.js (registerStep / registerIdle / registerAct / registerCounter) and on
   rx/putaway.js (identify, problems, armed, startShelf, onTag). Needs rx/recommend.js and rx/putaway.js loaded first.

   ═══ THE SHAPE ═══
   sort    = ['exceptions','stage']  The ladder is the same as put-away; after the quantity the STAGE CARD asks which cart. The BB
                                     row is written as today and the intent is written State=staged (StagedArea, RecommendedBin).
                                     ⛔ Nothing goes to Finale from a staged intent.
   staged  = ['tray']                Items are NOT re-received. Each item scan (an IDLE scan — nothing pending) is matched to a
                                     STAGED RECORD and moves into the TRAY; a shelf tag then places the whole tray. A tag first arms
                                     ONE item (the same armed shelf as put-away). The 'tray' STEP only runs for a case that was NOT on
                                     the list and the operator chose [Receive it now]: the ladder runs, the case is staged, and it lands
                                     in the tray.
   ═══ THE RULES ═══
   • ⛔ PLACING IS A CLAIM. A staged record is moved to State=ready with `If-Match: <etag>`. A 412 is read back: if the record is
     still staged and un-posted the claim is retried ONCE with the fresh etag (a benign edit, e.g. the other tablet attaching
     BbItemId); if it is no longer staged someone else placed it — the item leaves the tray, the crew sees "Ashley already put …
     away (bin)" and the list refreshes. ⛔ We NEVER overwrite another tablet's placement. Offline / network failure falls back to
     the core outbox (RX.intents.patch) so nothing is lost.
   • ⛔ THE TRAY EXPIRES. 10 minutes idle (TRAY_IDLE) clears it, with a visible countdown in its last minute and a notice, so a
     tag never silently pairs with items someone scanned long ago. It also clears when the flow changes.
   • THE LIST is `RX.intents.query("fields/State eq 'staged'")` across devices ∪ this tablet's unsent staged intents; a record
     this tablet already placed/cancelled is hidden. Every read has a limit (the core's) and a generation guard here.
   • A changed mind is free: wherever the tag is scanned is where it is received. Only temperature and a MEASURED FEFO date ask,
     and only about the item they concern.
   • ⛔⛔ A SPLIT NEVER DOUBLE-COUNTS (round-2 audit 2026-10-19). "Only some go here" shrinks the staged record and writes the
     record's own IntentId into its SplitOf (the ACK) in ONE If-Match PATCH; the placed portion is created only after that
     PATCH landed — offline, it is created GATED and waits in the outbox (RX.intents.splitLate). If another tablet placed the
     record meanwhile, the shrink is refused and the portion is voided (Julia's fix row). UNDO of a placed portion gives the
     units back to the staged record ONLY once the portion's cancel has LANDED (RX.intents.cancel opts.after) — a cancel that is
     too late (the poster had the portion) never gives them back. The poster checks the same ACK independently.
   • LEFTOVERS: from LEFTOVER_AT (15:30) the strip's "Staged n" is amber and a card offers [Put away now]. Live: when staged items
     exist and nobody has chosen how they are receiving, the staged list opens by itself (RX.setFlow('staged')).

   API (RX.staging): state records() refresh() render() claim(r,fields,expect) tray{...} — acts per SCANNER-UX §9 "Sort"/"Staged". */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const PA = RX.putaway, REC = RX.recommend || window.RXRecommend;
if(!PA || !REC){ try{ console.warn("rx/staging.js: rx/putaway.js / rx/recommend.js did not load — sort-first stays off"); }catch(_){} return; }
const ST = RX.staging = {};
const esc = RX.esc;

const COPY_ADD = {
  stage_other:     "Other area",
  stage_direct:    "I'm at the shelf — scan the tag",
  stage_wrong:     "Pick a cart for {name} first (Enter = top). That scan was not recorded.",
  stage_enter:     "ENTER",
  stage_only:      "Only some",
  stage_back:      "Back",
  dec_back_toast:  "Nothing was moved.",
  stage_anyspot:   "any spot — no history yet",
  stage_older:     "older dates there",
  stage_choose:    "Choose the cart",
  staged_h:        "Put away staged",
  staged_none:     "Nothing is staged.",
  staged_loading:  "Reading the staged list…",
  staged_err:      "Couldn't read the staged list ({why}).",
  staged_retry:    "Try again",
  staged_all:      "All",
  staged_noarea:   "No area",
  staged_by:       "staged {at} by {who}",
  staged_you:      "you",
  staged_cancel:   "Not put away — take it off the list",
  staged_cancel_q: "It was never received. The buyer will see it as not received.",
  staged_cancel_yes:"Yes, take it off",
  staged_cancel_bb_failed:"Taken off the list, but its best-by record could not be removed ({why}). The buyer has been told; nothing else to do.",
  staged_cancel_bb_queued:"No signal: it comes off the list as soon as the tablet reconnects. Its best-by record was kept for now and the buyer has been told.",
  staged_cancel_no:"Keep it",
  oncart_title:    "{name} is already on a cart. Is this that case?",
  oncart_row:      "Yes — this is it: {units} u · best-by {bb} · {area} · staged {when} by {who}",
  oncart_no:       "No — this is another case (we got extra)",
  oncart_sub:      "This would make {n} — KeHE says it shipped {cap}.",
  oncart_sub_ord:  "This would make {n} — the purchase order expects {cap}.",
  oncart_sort:     "{name} is already on the cart — nothing new recorded.",
  oncart_intray:   "{name} from the cart is in your hand. Now scan the SHELF TAG where you put it — nothing new was recorded.",
  putover_title:   "Already received: {have} of {item} — this makes {n}.",
  putover_body:    "KeHE says it shipped {cap}. Did we really get {add} more?",
  putover_body_ord:"The purchase order expects {cap}. Did we really get {add} more?",
  putover_yes:     "Yes — we got {add} extra",
  putover_no:      "No — same case counted twice, remove it",
  putover_removed: "Removed {name} — it was the same case counted twice. Nothing went into Finale.",
  tray_h:          "In hand (tray)",
  tray_empty:      "Tray is empty.",
  tray_clear:      "Clear tray",
  tray_remove:     "Remove",
  tray_some:       "Only some go here",
  tray_offer:      "Put {name} on {bin}",
  tray_offer_n:    "Put these {n} on {bin}",
  tray_offer_hint: "Enter puts it there — or scan another shelf tag",
  tray_some_q:     "How many go on this shelf?",
  tray_some_save:  "Save",
  tray_in:         "in tray",
  tray_expired:    "The tray was cleared after {m} idle minutes — those items are NOT in Finale. Scan each one again, then the shelf tag.",
  tray_now_tag:    "<strong>{name}</strong> is in your hand. Now scan the SHELF TAG where you put it — it is not in Finale until you do.",
  tray_countdown:  "Tray clears in {s} s",
  notstaged:       "{name} isn't on the staged list.",
  notstaged_receive:"Receive it now",
  notstaged_cancel:"Not now",
  lot_h:           "Which best-by is this case?",
  lot_row:         "{bb} · {n} units · {by}",
  placed_flash:    "{n} items → {bin}",
  placed_flash1:   "{n} × {name} → {bin}",
  placed_undo:     "Undo",
  placed_undone:   "Put back on the staged list.",
  conflict:        "{who} already put {name} away{bin}.",
  conflict_gone:   "{name} is no longer on the list.",
  placing:         "Placing…",
  leftovers:       "{n} staged items not put away (oldest {age})",
  leftovers_open:  "Put away now",
  inactive_card:   "{bin} is switched off in Finale. Use another shelf, or tell the buyer.",
  tray_cd_note:    "Still there?",
  hold_wait:       "Waiting for purchasing to add it to the PO",
  hold_wait_card:  "{name} is on hold — waiting for purchasing to add it to the PO.",
  hold_wait_close: "Close",
};
for(const k of Object.keys(COPY_ADD)) if(!(k in RX.COPY)) RX.COPY[k] = COPY_ADD[k];
const t = RX.t;

(function css(){
  if(document.getElementById("rxStCss")) return;
  const s = document.createElement("style"); s.id = "rxStCss";
  s.textContent = `.rx-st-wrap{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:12px 16px;margin-bottom:14px}
.rx-st-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.rx-st-row{border-bottom:1px solid var(--line-2)}
.rx-st-rowbtn{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;width:100%;text-align:left;border:0;border-radius:0;background:none;min-height:52px;padding:8px 4px}
.rx-st-rowbtn .bin{font-family:var(--mono);font-weight:700;min-width:120px}
.rx-st-rowbtn .nm{flex:1;min-width:150px}
.rx-st-rowbtn .by{font-size:12px;color:var(--ink-3)}
.rx-st-x{padding:6px 4px 12px 8px;font-size:13px;color:var(--ink-2)}
.rx-st-tray{border:2px solid var(--go);border-radius:5px;padding:9px 12px;margin:8px 0;background:var(--go-soft)}
.rx-st-tline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:3px 0}
.rx-st-cd{font-weight:700;color:var(--wait)}
.rx-st-note{margin:8px 0;padding:9px 12px;border-left:5px solid var(--wait);background:var(--wait-soft);border-radius:0 4px 4px 0}
.rx-st-pick{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;width:100%;min-height:72px;text-align:left;margin:0 0 8px;padding:10px 14px;border:2px solid var(--line);border-radius:5px;background:var(--card)}
.rx-st-pick.top{border-color:var(--go);background:var(--go-soft)}
.rx-st-pick .area{font-size:20px;font-weight:700;min-width:190px}
.rx-st-pick .bin{font-family:var(--mono);font-size:16px}
.rx-st-pick .info{font-size:13px;color:var(--ink-2);flex-basis:100%}
.rx-st-key{display:inline-block;margin-right:8px;padding:2px 7px;border-radius:3px;background:var(--go);color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em}
.rx-st-lot{display:block;width:100%;min-height:64px;margin:0 0 8px;text-align:left;font-size:17px}
.rx-st-n{width:100px;font-size:20px;padding:8px}`;
  document.head.appendChild(s);
})();

const $ = (id) => document.getElementById(id);
const pend = () => { try{ return pending; }catch(_){ return null; } };
const acct = () => { try{ return account; }catch(_){ return ""; } };
const pageRows = () => { try{ return rows; }catch(_){ return []; } };
const yf = (d) => (typeof yearFirst === "function") ? yearFirst(d) : esc(d);
const btn = (act, label, cls, extra) => `<button type="button" class="rx-btn ${cls || ""}" data-act="${act}" ${extra || ""}>${esc(label)}</button>`;
const TRAY_KEY = "rx_tray_v1";
const trayIdle = () => RX.CFG.TRAY_IDLE || 10 * 60 * 1000;
const leftoverAt = () => RX.CFG.LEFTOVER_AT || "15:30";
const pollEvery = () => RX.CFG.STAGED_POLL || 60 * 1000;
const catOf = (sku) => { try{ return (CATALOG_BY_SKU && CATALOG_BY_SKU[sku]) || {}; }catch(_){ return {}; } };
const nameOf = (sku) => { const si = RX.pack.skuInfo(sku); return (si && si.name) || catOf(sku).name || sku; };
const nice = (op) => { const s = String(op || "").split("@")[0].replace(/[._]+/g, " ").trim(); return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : "someone"; };
/* ⭐ ROUND 4 (D9): a "Hold: not on PO" record is NOT put-away-able until the current pack shows its SKU on an open PO line */
const isHold = (r) => String(r.area || "").indexOf(PA.HOLD_AREA || "Hold: not on PO") === 0;
/* ⛔ ROUND 5: the SAME rule as the portal's Hold tab (kehe-orders/receiving.js openLineFor): a pack PO line for the SKU with OPEN units
   (open_units, else ordered − received). A line that is already fully received is not a place to receive the held case into. */
const numOf = (v) => (typeof v === "number" ? (isFinite(v) ? v : null) : (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? +v : null));
const openLine = (sku) => {
  if(!RX.pack.data) return null;
  for(const x of RX.pack.poLinesBySku(sku)){ const l = x.line || {};
    const o = numOf(l.open_units) != null ? numOf(l.open_units) : (numOf(l.ordered_units) != null && numOf(l.received_units) != null ? numOf(l.ordered_units) - numOf(l.received_units) : null);
    if(o != null && o > 0) return x; }
  return null;
};
const holdReady = (r) => { try{ return !!openLine(r.sku); }catch(_){ return false; } };
const holdWaiting = (r) => isHold(r) && !holdReady(r);
const groupOf = (r) => holdWaiting(r) ? (PA.HOLD_AREA || "Hold: not on PO") : (isHold(r) ? (RX.pack.areaOf(r.bin) || t("staged_noarea")) : (r.area || t("staged_noarea")));
const whoText = (r) => (r.by && r.by === acct()) ? t("staged_you") : nice(r.by);

ST.state = {list: [], listAt: 0, loading: false, startedAt: 0, err: "", gen: 0, area: null, expanded: null, confirm: null, hidden: new Set(),
            tray: RX.store.get(TRAY_KEY, null) || {items: [], at: 0}, some: null, dec: null, lot: null, notstaged: null, placed: null, notice: "",
            bypass: false, autoOpened: false, placing: false, lastPoll: 0, returnFlow: null};
const S = ST.state;
if(!Array.isArray(S.tray.items)) S.tray = {items: [], at: 0};
const saveTray = () => { if(S.tray.items.length) RX.store.set(TRAY_KEY, S.tray); else RX.store.del(TRAY_KEY); };

/* ───────────────────────── the staged records ───────────────────────── */
function norm(it){
  const f = it.fields || {};
  return {iid: it.iid || f.IntentId, itemId: it.itemId || it.id || null, etag: it.etag || null, sku: f.Sku || "", units: +f.Units || 0, best: f.BestBy || "",
          area: f.StagedArea || "", bin: f.RecommendedBin || "", po: f.Po || "", by: f.Operator || "", device: f.Device || "", at: f.ScanAt || "",
          reasons: f.RecReasons || "", caseQty: +f.CaseQty || 0, fields: f};
}
ST.records = function(){
  const I = RX.intents, map = new Map();
  for(const r of S.list){ const rec = I.byId(r.iid); if(rec && rec.fields && rec.fields.State !== "staged") continue; map.set(r.iid, r); }
  /* ⭐ 2026-10-23 PM: ∪ every intent of the open pack POs (any day, any tablet), so the receive screens' "already on a cart?" sees a
     cart record from another day even before the staged list has been read */
  for(const e of (I.allPo ? I.allPo() : I.allToday())){
    const f = e.fields || {};
    if(f.Kind === "fix" || f.State !== "staged" || (e.fin && e.fin.FinState)) { if(map.has(e.iid) && f.State !== "staged" && e.local) map.delete(e.iid); continue; }
    const rec = I.byId(e.iid); if(rec && (rec.cancelled || rec.denied)) continue;
    if(!map.has(e.iid)) map.set(e.iid, norm({iid: e.iid, fields: f, etag: e.etag, itemId: e.itemId}));
  }
  /* ⭐ 2026-10-23: a cart record whose case is already put away is not work (rx/problems.js P.dupIids — the ONE rule) */
  const dups = (RX.problems && RX.problems.dupIids) ? RX.problems.dupIids() : new Set();
  const out = [...map.values()].filter(r => !S.hidden.has(r.iid) && r.sku && !dups.has(r.iid));
  out.sort((a, b) => String(a.bin || "~").localeCompare(String(b.bin || "~")) || String(a.area).localeCompare(String(b.area)) || String(a.at).localeCompare(String(b.at)));
  return out;
};
const byIid = (iid) => ST.records().find(r => r.iid === iid) || S.list.find(r => r.iid === iid) || null;
const inTray = (iid) => S.tray.items.some(x => x.iid === iid);
RX.registerCounter("staged", () => ST.records().length);
const nowLate = () => {
  const d = new Date(RX.now()), hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  return hm >= leftoverAt();
};
ST.late = () => ST.records().filter(r => !holdWaiting(r)).length > 0 && nowLate();

/* ───────────────────────── reading the list (limit + generation guard) ───────────────────────── */
const shouldPoll = () => RX.active() && (RX.mode() === "live" || RX.flowActive());
ST.refresh = async function(){
  if(S.loading) return;
  const gen = ++S.gen; S.loading = true; S.startedAt = RX.now(); S.err = ""; S.lastPoll = RX.now();
  ST.render();
  try{
    const items = await RX.intents.query("fields/State eq 'staged'");
    if(gen !== S.gen) return;
    S.list = items.filter(it => it.fields && it.fields.State === "staged" && it.fields.Kind !== "fix" && !(it.fin && it.fin.FinState))
                  .map(it => norm({iid: it.iid, fields: it.fields, etag: it.etag, itemId: it.id}));
    S.listAt = RX.now();
  }catch(e){
    if(gen !== S.gen) return;
    S.err = e && e.timeout ? "it took too long" : (e && e.status === 403 ? "this tablet isn't allowed to read it" : ((e && e.message) || "no network"));
  }finally{
    if(gen === S.gen){
      S.loading = false;
      if(!S.err && RX.mode() === "live" && !S.autoOpened && !RX.flowChosen() && !pend() && ST.records().length){ S.autoOpened = true; RX.setFlow("staged"); }
      ST.render(); RX.refresh();
    }
  }
};
RX.registerAct("staged-retry", () => ST.refresh());

/* ───────────────────────── rendering #rxTray ───────────────────────── */
const trayItems = () => S.tray.items.map(x => ({x, r: byIid(x.iid)})).filter(y => y.r);
function chipsHtml(all){
  const groups = new Map();
  for(const r of all){ const k = groupOf(r); groups.set(k, (groups.get(k) || 0) + 1); }
  let sel = S.area;
  if(sel == null){
    const mine = new Map(); for(const r of all) if(r.by === acct()){ const k = groupOf(r); mine.set(k, (mine.get(k) || 0) + 1); }
    let best = null, n = 0; for(const [k, v] of mine) if(v > n){ best = k; n = v; }
    sel = best || "all";
  }
  S.areaShown = sel;
  const chip = (k, label, n) => `<button type="button" class="rx-chipbtn${sel === k ? " on" : ""}" data-act="staged-area" data-area="${esc(k)}" aria-pressed="${sel === k}">${esc(label)} ${n}</button>`;
  return [...groups].map(([k, n]) => chip(k, k, n)).join("") + chip("all", t("staged_all"), all.length);
}
function trayBar(){
  const ti = trayItems();
  let h = `<div class="rx-st-tray" id="rxTrayBar"><strong>${esc(t("tray_h"))}</strong>`;
  if(!ti.length) h += ` <span class="hint" style="display:inline">${esc(t("tray_hint"))}</span></div>`;
  else{
    const left = trayIdle() - (RX.now() - S.tray.at);
    if(left <= 60000) h += ` <span class="rx-st-cd" id="rxTrayCd">${esc(t("tray_countdown", {s: Math.max(0, Math.ceil(left / 1000))}))}</span>`;
    h += ` ${btn("tray-clear", t("tray_clear"), "", 'style="margin-left:8px"')}`;
    for(const {x, r} of ti){
      const u = x.take || r.units;
      h += `<div class="rx-st-tline" data-iid="${esc(r.iid)}"><span>${esc(nameOf(r.sku))}${RX.idLine(r.sku)}</span><span class="num">${u}${x.take && x.take < r.units ? " of " + r.units : ""} u</span>
        ${S.some && S.some.iid === r.iid
          ? `<input id="rxTrayN" class="num rx-st-n" type="text" inputmode="numeric" maxlength="4" autocomplete="off" aria-label="${esc(t("tray_some_q"))}" placeholder="${esc(t("tray_some_q"))}">${btn("tray-some-save", t("tray_some_save"), "primary", `data-iid="${esc(r.iid)}"`)}${btn("tray-some-cancel", t("btn_cancel"), "", 'data-close="1"')}`
          : (r.units > 1 ? btn("tray-some", t("tray_some"), "", `data-iid="${esc(r.iid)}"`) : "")}
        ${btn("tray-remove", "✕", "", `data-iid="${esc(r.iid)}" aria-label="${esc(t("tray_remove"))} ${esc(nameOf(r.sku))}"`)}</div>`;
    }
    const of = offerNow();
    if(of) h += `<div class="rx-st-offer" id="rxTrayOffer">${btn("tray-offer-place", of.iids.length === 1 ? t("tray_offer", {bin: of.bin, name: nameOf(byIid(of.iids[0]).sku)}) : t("tray_offer_n", {bin: of.bin, n: of.iids.length}), "primary", "data-primary")}
      <span class="hint" style="display:inline">${esc(t("tray_offer_hint"))}</span></div>`;
    h += `<div class="hint">${esc(t("tray_hint"))}</div></div>`;
  }
  return h;
}
function rowsHtml(all){
  const sel = S.areaShown;
  let h = "";
  for(const r of all){
    if(inTray(r.iid)) continue;
    if(sel !== "all" && groupOf(r) !== sel) continue;
    const open = S.expanded === r.iid;
    h += `<div class="rx-st-row" data-iid="${esc(r.iid)}"><button type="button" class="rx-st-rowbtn" data-act="staged-row" data-iid="${esc(r.iid)}" aria-expanded="${open}">
      <span class="bin">${esc(r.bin || r.area || "—")}</span><span class="nm">${esc(nameOf(r.sku))}${RX.idLine(r.sku)}</span><span class="num">${r.units} u</span><span class="bb">${r.best ? yf(r.best) : "no date"}</span>
      <span class="by">${esc(t("staged_by", {at: r.at ? RX.hhmm(r.at) : "", who: whoText(r)}))}${r.device && r.by !== acct() ? " (" + esc(String(r.device).slice(0, 4)) + ")" : ""}</span>${holdWaiting(r) ? `<span class="by rx-holdwait" style="flex-basis:100%;font-weight:700;color:var(--ink)">${esc(t("hold_wait"))}</span>` : ""}</button>`;
    if(open){
      h += `<div class="rx-st-x">${r.po ? "PO " + esc(r.po) + " · " : ""}${r.reasons ? esc(String(r.reasons)) + " · " : ""}${esc(r.area || "")}`;
      if(S.confirm === r.iid) h += `<div class="rx-st-note"><strong>${esc(t("staged_cancel_q"))}</strong> ${btn("staged-cancel-yes", t("staged_cancel_yes"), "primary", `data-iid="${esc(r.iid)}"`)}${btn("staged-cancel-no", t("staged_cancel_no"), "", 'data-close="1"')}</div>`;
      else h += `<div>${btn("staged-cancel", t("staged_cancel"), "", `data-iid="${esc(r.iid)}"`)}</div>`;
      h += `<div>${btn("staged-row-close", t("btn_close"), "", 'data-close="2"')}</div>`;     // round 3: the row's details close too (while the confirm is open, Escape closes the confirm first)
      h += `</div>`;
    }
    h += `</div>`;
  }
  return h;
}
function stagedView(){
  const all = ST.records();
  let h = `<div class="rx-st-wrap" id="rxStaged"><div class="rx-st-head"><div class="rx-h" style="margin:0">${esc(t("staged_h"))}</div>${chipsHtml(all)}${btn("staged-close", t("btn_close"), "", 'data-close="3" style="margin-left:auto"')}</div>`;
  if(S.notice) h += `<div class="rx-st-note" role="status">${S.notice}</div>`;
  if(S.loading){ h += `<div class="rx-sub" aria-live="polite">${esc(t("staged_loading"))} <span class="rx-tick" aria-hidden="true" data-from="${S.startedAt}">${RX.clock(RX.now() - S.startedAt)}</span></div>`; }
  else if(S.err){ h += `<div class="rx-note rx-red" role="alert">${esc(t("staged_err", {why: S.err}))} ${btn("staged-retry", t("staged_retry"))}</div>`; }
  h += trayBar();
  const rows = rowsHtml(all);
  h += rows || (!S.loading && !S.err ? `<div class="hint">${esc(t("staged_none"))}</div>` : "");
  return h + `</div>`;
}
const ageText = (ms) => ms < 3600000 ? Math.max(1, Math.round(ms / 60000)) + " min" : Math.floor(ms / 3600000) + " h";
function leftoversCard(){
  const all = ST.records(); if(!all.length) return "";
  const oldest = all.reduce((m, r) => { const ms = Date.parse(r.at); return !isNaN(ms) && ms < m ? ms : m; }, RX.now());
  return `<div class="rx-st-wrap" id="rxLeftovers" style="border-left:5px solid var(--wait)"><strong>${esc(t("leftovers", {n: all.length, age: ageText(RX.now() - oldest)}))}</strong>
    ${btn("leftovers-open", t("leftovers_open"), "primary", 'style="margin-left:10px"')}</div>`;
}
ST.render = function(){
  const el = $("rxTray"); if(!el) return;
  let h = "";
  if(RX.active()){
    const flow = RX.flow();
    if(flow === "staged") h = stagedView();
    else if(ST.late()) h = leftoversCard();
  }
  const a = document.activeElement;
  if(a && el.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName) && flowIs("staged")) return;       // never re-render under a typing finger
  if(el.dataset.h !== h){ el.innerHTML = h; el.dataset.h = h; }
};
const flowIs = (f) => RX.flow() === f;
RX.registerAct("leftovers-open", () => { if(RX.setFlow("staged")) RX.refresh(); });

/* ───────────────────────── the tray ───────────────────────── */
function trayTouch(){ S.tray.at = RX.now(); saveTray(); }
/* PM-3333 + review 2026-10-28: the shelf scanned first is offered for the items taken AFTER it (while it is the current shelf), by the
   person who scanned it — never an item already in the tray before the tag. It lapses for an item the moment that item leaves the tray
   (placed, removed, cancelled), and wholly when another account is on the tablet — never a stale "Put … on X" */
const meNow = () => { try{ return (typeof account !== "undefined" && account && (account.username || account.homeAccountId)) || ""; }catch(_){ return ""; } };
function offerNow(){
  const o = S.tray.offer; if(!o) return null;
  /* ⛔ review (3): the offer lives only while its shelf is still the CURRENT one (not expired, not Done, not switched) */
  const sh = PA.shelf.current();
  const iids = (typeof o === "object" && Array.isArray(o.iids) && o.by === meNow() && sh && String(sh.bin).toUpperCase() === String(o.bin).toUpperCase())
    ? o.iids.filter(i => S.tray.items.some(x => x.iid === i) && byIid(i)) : [];
  if(!iids.length){ S.tray.offer = null; saveTray(); return null; }
  if(iids.length !== o.iids.length){ o.iids = iids; saveTray(); }
  return o;
}
function clearTray(notice){ S.tray = {items: [], at: 0, offer: null}; S.some = null; saveTray(); S.notice = notice || ""; ST.render(); try{ maybeReturn(); }catch(_){} }
function addToTray(r, take){
  if(inTray(r.iid)) return;
  S.tray.items.push({iid: r.iid, take: take || null}); trayTouch(); S.notice = ""; S.some = null;
  try{ clearPrompt(); }catch(_){}
  RX.sound("staged"); ST.render();
}
RX.registerAct("tray-clear", () => { clearTray(""); RX.sound("decide"); });
RX.registerAct("tray-remove", ({el}) => { S.tray.items = S.tray.items.filter(x => x.iid !== el.getAttribute("data-iid")); S.some = null; trayTouch(); ST.render(); });
RX.registerAct("tray-some", ({el}) => { S.some = {iid: el.getAttribute("data-iid")}; trayTouch(); ST.render(); setTimeout(() => { const i = $("rxTrayN"); if(i){ i.focus(); i.onkeydown = (ev) => { if(ev.key === "Enter"){ ev.preventDefault(); const b = document.querySelector('[data-act="tray-some-save"]'); if(b) b.click(); } }; } }, 25); });
RX.registerAct("tray-some-cancel", () => { S.some = null; const a = document.activeElement; if(a && a.blur && a.id === "rxTrayN") a.blur(); ST.render(); });     // ⭐ Escape leaves focus in the box, and render() never re-renders under a typing finger
RX.registerAct("tray-some-save", ({el}) => {
  const iid = el.getAttribute("data-iid"), r = byIid(iid), inp = $("rxTrayN"), n = parseInt(((inp && inp.value) || "").trim(), 10);
  if(!r || isNaN(n) || n < 1 || n > r.units){ if(inp) inp.style.borderColor = "var(--stop)"; return; }
  const x = S.tray.items.find(q => q.iid === iid); if(x) x.take = n >= r.units ? null : n;
  S.some = null; trayTouch(); ST.render();
});
RX.on("tick", () => {
  if(S.tray.items.length){
    const left = trayIdle() - (RX.now() - S.tray.at);
    if(left <= 0){ clearTray(esc(t("tray_expired", {m: Math.round(trayIdle() / 60000)}))); RX.sound("decide"); }
    else if(left <= 60000){
      const cd = $("rxTrayCd"); if(cd) cd.textContent = t("tray_countdown", {s: Math.max(0, Math.ceil(left / 1000))}); else ST.render();
    }
  }
  RX.state.stagedLate = ST.late();
  if(RX.flow() !== "staged") ST.render();                                      // leftovers appear by the clock
  if(!S.loading && shouldPoll() && RX.now() - S.lastPoll >= pollEvery()) ST.refresh();
});
RX.on("flow", () => { if(RX.flow() !== "staged"){ if(S.tray.items.length) clearTray(""); closeCards(); } else ST.refresh(); ST.render(); });
RX.on("day", () => { clearTray(""); S.hidden.clear(); S.list = []; });
RX.on("intents", () => ST.render()); RX.on("pack", () => ST.render());
RX.onBoot(() => { setTimeout(() => { if(shouldPoll()) ST.refresh(); else ST.render(); }, 1500); });
for(const e of ["steps"]) RX.on(e, () => ST.render());

/* ───────────────────────── claiming a staged record (If-Match) ───────────────────────── */
async function readItem(L, id){ return await graph(`/sites/${L.siteId}/lists/${L.listId}/items/${id}?$expand=fields`); }
const etagOf = (j) => (j && (j.eTag || j["@odata.etag"])) || null;
function adopt(r){
  const I = RX.intents, store = I._store(), f = r.fields || {};
  if(store.recs[r.iid]) return store.recs[r.iid];
  const rec = {iid: r.iid, day: f.ScanDay || RX.today(), createdAt: RX.now(), fields: Object.assign({}, f), itemId: r.itemId, etag: r.etag, sent: true, sentAt: RX.now(), tried: true,
               inflight: false, patches: [], fin: {}, denied: null, cancelled: false, err: "", bbN: null};
  store.recs[r.iid] = rec; I._save(); return rec;                  // ⛔ round-2 (5): through the merging save, never a raw overwrite
}
function mirror(rec, f, etag, iid){
  /* review 2026-10-23 PM (6): also the PO-wide copy, so a record from another tablet placed here stops reading "staged" now */
  const id = iid || (rec && rec.iid);
  const m = id && RX.state.poAll && RX.state.poAll.get(id); if(m){ Object.assign(m.fields, f); if(etag) m.etag = etag; }
  if(!rec) return;
  Object.assign(rec.fields, f); if(etag) rec.etag = etag;
  try{ RX.intents._save(); }catch(_){}
}
/* -> {ok:true} | {ok:true, queued:true} | {ok:false, conflict:true, by, bin, state} | {ok:false, gone:true} | {ok:false, denied:true} */
/* opts.split = [child fields]: this claim SHRINKS r for a split — on a confirmed PATCH the caller creates the portion; when it
   has to be queued, the portion is created GATED on the queued shrink (RX.intents.splitLate) and returned in `children`. */
ST.claim = async function(r, f, expect, opts){
  const I = RX.intents, want = expect || "staged", split = opts && opts.split;
  const rec0 = I.byId(r.iid);
  const queue = () => {
    try{
      adopt(r);
      if(split){ const res = I.splitLate(r.iid, f, split, {expect: want}); return res.ok ? {ok: true, queued: true, children: res.children} : {ok: false, conflict: true, by: "", bin: "", state: "changed"}; }
      I.patch(r.iid, f, {expect: want});
    }catch(_){}
    return {ok: true, queued: true};
  };
  if(rec0 && !rec0.sent) return queue();                                                   // not even sent yet: merge into the pending POST
  let L; try{ L = await I.resolveList(); }catch(e){ return (e && e.status === 403) ? {ok: false, denied: true} : queue(); }
  const itemId = (rec0 && rec0.itemId) || r.itemId; let etag = (rec0 && rec0.etag) || r.etag;
  if(!itemId) return queue();
  for(let attempt = 0; attempt < 2; attempt++){
    try{
      const j = await graph(`/sites/${L.siteId}/lists/${L.listId}/items/${itemId}/fields`,
        {method: "PATCH", headers: etag ? {"If-Match": etag} : {}, body: JSON.stringify(f)});
      mirror(I.byId(r.iid), f, etagOf(j), r.iid);
      return {ok: true, etag: etagOf(j)};
    }catch(e){
      if(e && e.status === 412){
        let cur = null; try{ cur = await readItem(L, itemId); }catch(_){ return queue(); }
        if(!cur) return {ok: false, gone: true};
        const cf = cur.fields || {};
        if(cf.State !== want || cf.FinState) return {ok: false, conflict: true, by: cf.PlacedBy || cf.Operator || "", bin: cf.Location || "", state: cf.State || ""};
        etag = etagOf(cur); continue;                       // still the state we expect: a benign edit moved the etag — retry once
      }
      if(e && e.status === 404) return {ok: false, gone: true};
      if(e && e.status === 403) return {ok: false, denied: true};
      return queue();                                       // network / auth: the core outbox holds it
    }
  }
  return {ok: false, conflict: true, by: "", bin: "", state: "changed"};
};

/* ───────────────────────── placing ───────────────────────── */
function copyFields(r, take, f){
  const g = {}; for(const k of RX.INTENT_FIELDS) if(r.fields[k] !== undefined && r.fields[k] !== null && r.fields[k] !== "") g[k] = r.fields[k];
  for(const k of ["IntentId", "ScanAt", "ScanDay", "Operator", "Device", "State", "ReadyAt", "RawScans", "CancelTooLate", "BbItemId", "PageMode", "DamagedUnits", "PhotoUrls", "FixNote"]) delete g[k];   // round 4: damage evidence stays on the original
  g.Units = take; if(r.caseQty > 0) g.Cases = Math.round(take / r.caseQty * 100) / 100;
  /* ⛔ AUDIT 2026-10-19 (J, M3): the portion is part of the SAME scanned case — it keeps the original ScanAt and PageMode.
     A fresh ScanAt/PageMode let a case scanned in SHADOW (and received in the Finale app) pass the poster's live checks
     (PageMode=live, ScanAt ≥ since) once it was put away after live began: a double receipt of the split units. */
  const keep = {}; if(r.fields.ScanAt) keep.ScanAt = r.fields.ScanAt; if(r.fields.PageMode) keep.PageMode = r.fields.PageMode;
  return Object.assign(g, f, keep, {SplitOf: r.iid, Workflow: "staged", Kind: "intent"});
}
async function placeOne(r, take, info, source, extra){
  const f = Object.assign({State: "ready", Location: info.name, BinSource: source, PlacedBy: acct(), ReadyAt: RX.iso()}, extra || {});
  if(isHold(r)){ if(holdWaiting(r)) return {ok: false, gone: true}; try{ const ol = openLine(r.sku); if(ol && ol.po) f.Po = String(ol.po.order_id); }catch(_){} }   // a released hold now has its PO (the line with open units)
  if(take && take < r.units){
    /* ⛔ round-2 (1): the shrink carries the ACK (SplitOf = its own id); the portion exists only after it landed, or GATED on it */
    const rest = r.units - take, upd = {Units: rest, SplitOf: r.iid}; if(r.caseQty > 0) upd.Cases = Math.round(rest / r.caseQty * 100) / 100;
    const child = copyFields(r, take, f);
    const c1 = await ST.claim(r, upd, "staged", {split: [child]}); if(!c1.ok) return c1;
    const portion = c1.queued ? (c1.children || [])[0] : RX.intents.create(child, {}).iid;
    r.units = rest;
    return {ok: true, portion, take};
  }
  const c = await ST.claim(r, f, "staged");
  if(c.ok) S.hidden.add(r.iid);
  return c;
}
function conflictToast(r, res){
  if(res.gone) RX.toast(t("conflict_gone", {name: nameOf(r.sku)}));
  else RX.toast(t("conflict", {who: nice(res.by), name: nameOf(r.sku), bin: res.bin ? " (" + res.bin + ")" : ""}));
}
async function executePlace(dec){
  S.placing = true;
  const placed = [], skippedKeep = [];
  const removed = [];
  for(const q of dec.queue){
    if(q.dup){ S.tray.items = S.tray.items.filter(x => x.iid !== q.rec.iid); const n = await ST.retire(q.rec); if(n !== null) removed.push({r: q.rec, notice: n}); continue; }
    if(q.skip){ skippedKeep.push(q); continue; }
    const res = await placeOne(q.rec, q.take, dec.info, dec.source, q.overConfirmed ? {OverConfirmed: true} : null);
    if(res.ok){ placed.push({r: q.rec, take: q.take, portion: res.portion, prevOver: !!(q.rec.fields && q.rec.fields.OverConfirmed === true)}); S.tray.items = S.tray.items.filter(x => x.iid !== q.rec.iid && !(res.portion && x.iid === q.rec.iid)); }
    else if(res.denied){ RX.toast(t("denied")); }
    else{ conflictToast(q.rec, res); S.tray.items = S.tray.items.filter(x => x.iid !== q.rec.iid); S.hidden.add(q.rec.iid); }
  }
  S.dec = null; S.placing = false; trayTouch();
  try{ clearPrompt(); }catch(_){}
  if(placed.length){
    const units = placed.reduce((a, x) => a + (x.take || x.r.units || 0), 0);
    const head = placed.length === 1 ? t("placed_flash1", {n: units, name: nameOf(placed[0].r.sku), bin: dec.info.name}) : t("placed_flash", {n: placed.length, bin: dec.info.name});
    S.placed = {items: placed, bin: dec.info.name};
    { const sh = PA.shelf.get(); if(sh && String(sh.bin).toUpperCase() === String(dec.info.name).toUpperCase()) for(let i = 0; i < placed.length; i++) PA.shelf.bump(); }   // PM-3361: the shelf bar counts them
    RX.flash(`<div class="last rx-last" role="status"><div class="nm">✓ ${esc(head)}</div><div class="rx-lastbtns">${btn("placed-undo", t("placed_undo"))}</div></div>`);
    RX.sound("saved");
  }
  if(removed.length){ S.notice = removed.map(x => x.notice || t("putover_removed", {name: nameOf(x.r.sku)})).join(" "); if(!placed.length) RX.sound("decide"); }
  ST.refresh(); ST.render(); maybeReturn();
}
function itemFor(r, take){ const c = catOf(r.sku); return {sku: r.sku, name: nameOf(r.sku), cls: c.cls, best: r.best, units: take || r.units}; }
function runDec(){
  const dec = S.dec; if(!dec) return;
  while(dec.idx < dec.queue.length){
    const q = dec.queue[dec.idx], item = itemFor(q.rec, q.take);
    /* ⭐ 2026-10-23 PM: past what KeHE shipped → ask HERE (extra, or the same case counted twice) instead of leaving a hold */
    if(!q.flags.over && !(q.rec.fields && q.rec.fields.OverConfirmed === true) && RX.po && RX.po.putCheck && q.rec.po){
      const earlier = dec.queue.slice(0, dec.idx).filter(e => !e.skip && e.rec.po === q.rec.po && e.rec.sku === q.rec.sku).reduce((a, e) => a + (e.take || e.rec.units || 0), 0);
      const add = q.take || q.rec.units || 0;
      const o = RX.po.putCheck(q.rec.po, q.rec.sku, earlier + add);
      if(o && o.over){ dec.card = {kind: "over", item, o: Object.assign({add, have: o.have + earlier}, {n: o.n, cap: o.cap, basis: o.basis})}; showDecCard(); return; }
    }
    const rank = PA.rankFor(item);
    const probs = PA.problems(item, dec.info, rank).filter(k => !q.flags[k]);
    if(probs.length){ dec.card = {kind: probs[0], item, rank}; showDecCard(); return; }
    dec.idx++;
  }
  dec.card = null; executePlace(dec);
}
function showDecCard(){
  const c = S.dec.card, info = S.dec.info;
  if(c.kind === "over"){
    const o = c.o, v = {item: c.item.name, have: fmtU(o.have), n: fmtU(o.n), cap: fmtU(o.cap), add: fmtU(o.add)};
    prompt_("stop", esc(t("putover_title", v)), `${RX.idLine(c.item.sku)}<span class="rx-pa-sub">${esc(t(o.basis === "shipped" ? "putover_body" : "putover_body_ord", v))}</span>`,
      `<div class="rx-pa-btns">${btn("putover-yes", t("putover_yes", v))}${btn("putover-no", t("putover_no"))}${btn("dec-back", t("btn_back"), "", 'data-close="3"')}</div>`);
    /* ⛔ no primary: Enter must not decide between "extra" and "remove" (review 2026-10-23 PM (4)) — a person taps one */
    RX.sound("decide"); return;
  }
  if(c.kind === "temp"){
    prompt_("stop", esc(t("temp_title")), `<strong>${esc(PA.tempText(c.item, info))}</strong>${RX.idLine(c.item.sku)}`,
      `<div class="rx-pa-btns">${btn("temp-no", t("temp_no"), "primary", "data-primary")}${btn("temp-yes", t("temp_yes"))}${btn("dec-back", t("btn_back"), "", 'data-close="3"')}</div>`);
  }else{
    prompt_("stop", esc(t("fefo_title")), `<strong>${esc(c.item.name)}</strong>${RX.idLine(c.item.sku)}` + esc(PA.fefoText(c.item, c.rank)),
      `<div class="rx-pa-btns">${btn("fefo-change", t("fefo_change"), "primary", "data-primary")}${btn("fefo-anyway", t("fefo_anyway"))}${btn("dec-back", t("btn_back"), "", 'data-close="3"')}</div>`);
  }
  setTimeout(() => { const b = document.querySelector("#promptArea [data-primary]"); if(b) b.focus(); }, 30);
  RX.sound("decide");
}
const fmtU = (x) => String(Math.round((+x || 0) * 100) / 100);
RX.registerAct("putover-yes", () => { const dec = S.dec; if(!dec || !dec.card || dec.card.kind !== "over") return; const q = dec.queue[dec.idx]; q.flags.over = true; q.overConfirmed = true; dec.card = null; try{ clearPrompt(); }catch(_){} runDec(); });
RX.registerAct("putover-no", () => { const dec = S.dec; if(!dec || !dec.card || dec.card.kind !== "over") return; const q = dec.queue[dec.idx]; q.skip = true; q.dup = true; dec.card = null; dec.idx++; try{ clearPrompt(); }catch(_){} runDec(); });
/* ⭐ ROUND 3: Back on a tray decision card — NOTHING is moved: the placement is dropped, the tray and the staged list stay as they were */
RX.registerAct("dec-back", () => { if(!S.dec) return; S.dec = null; S.placing = false; try{ clearPrompt(); }catch(_){} RX.toast(t("dec_back_toast")); RX.refresh(); });
PA.decisionHook = function(name){
  const dec = S.dec; if(!dec || !dec.card) return;
  const q = dec.queue[dec.idx];
  if(name === "temp-no" || name === "fefo-change"){ q.skip = true; dec.idx++; }
  else q.flags[name === "temp-yes" ? "temp" : "fefo"] = true;
  runDec();
};
function startPlace(info, source, entries){
  S.dec = {info, source, idx: 0, card: null, queue: entries.map(e => ({rec: e.r, take: e.x ? e.x.take : null, flags: {}, skip: false}))};
  runDec();
}
RX.registerAct("placed-undo", async () => {
  const p = S.placed; if(!p) return; S.placed = null;
  let toLate = false;
  for(const it of p.items){
    if(it.portion){
      const rec = RX.intents.byId(it.portion);
      /* ⛔ round-2 (1): the units go back to the staged record only once the portion's cancel has LANDED */
      if(rec && RX.intents.editable(rec)){ adopt(it.r); const res = RX.intents.cancel(it.portion, {after: {iid: it.r.iid, addUnits: it.take, expect: "staged"}}); if(res === "too_late") toLate = true; else it.r.units += it.take; }
      else toLate = true;
      continue;
    }
    const res = await ST.claim(it.r, {State: "staged", Location: "", BinSource: null, PlacedBy: "", ReadyAt: "", OverConfirmed: !!it.prevOver}, "ready");
    if(res.ok) S.hidden.delete(it.r.iid); else toLate = true;
  }
  RX.flash(""); RX.toast(toLate ? t("cancel_too_late") : t("placed_undone")); RX.sound("decide");
  ST.refresh(); ST.render();
});

/* ───────────────────────── idle scans: items into the tray, tags place it ───────────────────────── */
function closeCards(){ const had = !!(S.lot || S.notstaged || S.dec); S.lot = null; S.notstaged = null; S.dec = null; if(had){ try{ clearPrompt(); }catch(_){} } }
const oldestFirst = (a) => a.slice().sort((x, y) => String(x.best || "9999").localeCompare(String(y.best || "9999")) || String(x.at).localeCompare(String(y.at)));
function onTagScan(id){
  const info = id.info;
  if(!info.active){ prompt_("stop", esc(t("inactive_card", {bin: info.name})), esc(t("nothing_recorded")), undefined, {keepScan: true}); RX.sound("refused"); return true; }
  /* ⭐ PM-3361 (Jack, 2026-10-29: "those paths should … work the same for the same step"): a shelf tag here does what it does in Put
     away here — it becomes the CURRENT shelf until another tag, Done or 10 min idle (PA.shelf). Items in the tray go there now; every
     item scanned after it is offered for it (Enter). It used to arm ONE item, so the crew scanned tag, item, tag, item. */
  const sw = PA.shelf.set(info.name);
  if(sw.had && !sw.same) RX.toast(t("shelf_switched", {bin: info.name}));
  if(S.tray.items.length){
    const entries = trayItems().map(({x, r}) => ({x, r}));
    if(!entries.length){ clearTray(""); return true; }
    trayTouch(); startPlace(info, "scanned", entries); return true;
  }
  RX.sound("staged"); ST.render(); return true;
}
async function onItemScan(id, raw){
  const mineAll = ST.records().filter(r => r.sku === id.sku && !inTray(r.iid));
  const all = mineAll.filter(r => !holdWaiting(r));
  /* PM-3361: the current shelf, else a one-shot arm. ⛔ review (3): an item going into the TRAY does not keep the shelf alive — only a
     placement does (PA.shelf.bump) — so the 10-min idle ends a shelf the crew walked away from */
  const sh = PA.shelf.current();
  const armed = sh ? {bin: sh.bin} : PA.armed.take();
  if(!all.length && mineAll.length){                                                  // round 4: on hold — put-away is disabled until the PO line exists
    prompt_("stop", esc(t("hold_wait_card", {name: id.prod.name})), RX.idLine(id.sku), `<div class="rx-pa-btns">${btn("hold-wait-close", t("hold_wait_close"), "primary", 'data-close="3"')}</div>`, {keepScan: true});
    RX.sound("refused"); return true;
  }
  if(!all.length){
    S.notstaged = {raw, name: id.prod.name, armed: armed ? armed.bin : null};
    prompt_("stop", esc(t("notstaged", {name: id.prod.name})), "", `<div class="rx-pa-btns">${btn("notstaged-receive", t("notstaged_receive"), "primary", "data-primary")}${btn("notstaged-cancel", t("notstaged_cancel"), "", 'data-close="3"')}</div>`);
    setTimeout(() => { const b = document.querySelector("#promptArea [data-primary]"); if(b) b.focus(); }, 30);
    RX.sound("decide"); return true;
  }
  const lots = [...new Set(all.map(r => r.best || ""))];
  let pick = null;
  if(id.best){ const m = all.filter(r => r.best === id.best); if(m.length) pick = oldestFirst(m)[0]; }
  if(!pick && lots.length === 1) pick = oldestFirst(all)[0];
  if(!pick){ openLotPick(all, armed); return true; }
  take(pick, armed); return true;
}
function take(r, armed){
  /* ⭐ PM-3333: a shelf tag scanned FIRST no longer places the item at once (no "Only some" was possible) — the item goes in the tray and
     the shelf is OFFERED there: [Put the tray on <shelf>] or "Only some go here" first, the same as item-then-tag */
  addToTray(r);
  if(armed){ const info = RX.pack.binInfo(armed.bin || armed);
    if(!(info && info.active)) S.tray.offer = null;
    else{ const o = offerNow(); S.tray.offer = (o && o.bin === info.name) ? Object.assign(o, {iids: o.iids.concat(o.iids.includes(r.iid) ? [] : [r.iid])}) : {bin: info.name, iids: [r.iid], by: meNow()}; } }
  saveTray(); ST.render();          // an item scanned with no tag joins the tray and leaves the earlier item's offer alone
}
function openLotPick(all, armed){
  const byLot = new Map(); for(const r of oldestFirst(all)) if(!byLot.has(r.best || "")) byLot.set(r.best || "", r);
  S.lot = {lots: [...byLot.values()], armed};
  const btns = S.lot.lots.map((r, i) => `<button type="button" class="rx-btn rx-st-lot${i === 0 ? " primary" : ""}" data-act="lot-pick" data-iid="${esc(r.iid)}"${i === 0 ? " data-primary" : ""}>${r.best ? yf(r.best) : "no date"} · ${r.units} u · ${esc(t("staged_by", {at: r.at ? RX.hhmm(r.at) : "", who: whoText(r)}))}</button>`).join("");
  prompt_("go", esc(t("lot_h")), `<strong>${esc(nameOf(all[0].sku))}</strong>${RX.idLine(all[0].sku)}`, `<div>${btns}</div><div class="rx-pa-btns">${btn("lot-close", t("btn_close"), "", 'data-close="3"')}</div>`, {keepScan: true});
  RX.sound("decide");
}
RX.registerAct("tray-offer-place", () => {   // PM-3333: place the tray on the shelf that was scanned first
  const o = offerNow(); if(!o) { ST.render(); return; } const bin = o.bin, info = RX.pack.binInfo(bin);
  S.tray.offer = null; saveTray();
  if(!info || !info.active){ ST.render(); RX.toast(t("unknown_tag", {code: bin})); return; }
  const entries = trayItems().filter(({r}) => o.iids.includes(r.iid)).map(({x, r}) => ({x, r})); if(!entries.length){ ST.render(); return; }
  trayTouch(); startPlace(info, "armed", entries);
});
RX.registerAct("hold-wait-close", () => { try{ clearPrompt(); }catch(_){} });
RX.registerAct("lot-close", () => { S.lot = null; try{ clearPrompt(); }catch(_){} });
RX.registerAct("staged-close", () => { if(pend()){ RX.toast(t("finish_first")); return; } const prev = RX.state.prevFlow; RX.state.prevFlow = null; if(RX.setFlow(prev && prev !== "staged" ? prev : "direct")) RX.refresh(); });
RX.registerAct("staged-row-close", () => { S.expanded = null; S.confirm = null; ST.render(); });
RX.registerAct("lot-pick", ({el}) => {
  const lot = S.lot; if(!lot) return;
  const r = lot.lots.find(x => x.iid === el.getAttribute("data-iid")); S.lot = null; try{ clearPrompt(); }catch(_){}
  if(r) take(r, lot.armed);
});
RX.registerAct("notstaged-cancel", () => { const n = S.notstaged; S.notstaged = null; try{ if(n) noteDropped(n.raw, "NOT_STAGED"); }catch(_){} try{ clearPrompt(); }catch(_){} });
RX.registerAct("notstaged-receive", () => {
  const n = S.notstaged; if(!n) return; S.notstaged = null; try{ clearPrompt(); }catch(_){}
  S.bypass = true; setTimeout(() => { S.bypass = false; }, 800);
  try{ handleScan(n.raw); }catch(_){}
});
RX.registerIdle("tray", {
  get keepScan(){ return RX.flow() === "staged" && !S.some; },
  async onScan(raw){
    if(RX.flow() !== "staged") return false;
    if(S.bypass){ S.bypass = false; return false; }
    if(S.placing) return true;
    const id = PA.identify(raw);
    if((S.dec && S.dec.card) || S.notstaged){                    // a modal question is open: refused, never recorded (SCANNER-UX §8 rule 3)
      if(id.kind === "tag" || id.kind === "product"){ try{ noteDropped(raw, "MODAL"); }catch(_){} RX.toast("Answer the question first. That scan was not recorded."); RX.sound("refused"); return true; }
      return false;
    }
    if(id.kind === "tag"){ closeCards(); return onTagScan(id); }
    if(id.kind === "product"){ closeCards(); return await onItemScan(id, raw); }
    return false;                                             // dates / unknown codes: the page's own handling
  },
  onEmptyEnter(){
    if(RX.flow() === "staged" && S.lot && S.lot.lots.length){ const r = S.lot.lots[0], armed = S.lot.armed; S.lot = null; try{ clearPrompt(); }catch(_){} take(r, armed); return true; }
    if(RX.flow() === "staged" && !S.dec && !S.some && offerNow()){ const b = document.querySelector('[data-act="tray-offer-place"]'); if(b){ b.click(); return true; } }   // Enter = the offered shelf
    return false;
  },
});

/* ───────────────────────── list acts ───────────────────────── */
RX.registerAct("staged-area", ({el}) => { S.area = el.getAttribute("data-area"); S.expanded = null; ST.render(); });
RX.registerAct("staged-row", ({el}) => { const i = el.getAttribute("data-iid"); S.expanded = S.expanded === i ? null : i; S.confirm = null; ST.render(); });
RX.registerAct("staged-cancel", ({el}) => { S.confirm = el.getAttribute("data-iid"); ST.render(); });
RX.registerAct("staged-cancel-no", () => { S.confirm = null; ST.render(); });
/* take a cart record off the list (cancel) and, once the cancel is CERTAIN, its best-by row (PM-3069 rules, shared by "Not put away"
   and the over card's "same case counted twice"). -> a notice for the crew, '' when all is well, or null when nothing changed */
ST.retire = async function(r){
  const iid = r.iid, rec = RX.intents.byId(iid), PB = RX.problems || {};
  const v = PB.vOf ? (PB.vOf(iid) || {iid, fields: r.fields || {}}) : null;
  let certain = false, queued = false;
  if(rec && !rec.sent && !rec.tried && !rec.inflight){ RX.intents.cancel(iid); S.hidden.add(iid); certain = true; }
  else{ const res = await ST.claim(r, {State: "cancelled"}, "staged"); if(res.ok){ S.hidden.add(iid); certain = !res.queued; queued = !!res.queued; } else{ conflictToast(r, res); return null; } }
  S.tray.items = S.tray.items.filter(x => x.iid !== iid); trayTouch();
  if(v && certain && PB.dropBb){
    const b = await PB.dropBb(v);
    if(!b.ok){ if(PB.tellBbLeft) PB.tellBbLeft(v, b.why || "error"); return t("staged_cancel_bb_failed", {why: esc(b.why || "error")}); }
  }else if(v && queued){ if(PB.tellBbLeft) PB.tellBbLeft(v, "no signal: the cancel was queued"); return t("staged_cancel_bb_queued"); }
  return "";
};
RX.registerAct("staged-cancel-yes", async ({el}) => {
  const iid = el.getAttribute("data-iid"), r = byIid(iid); S.confirm = null; S.expanded = null; S.notice = null; if(!r){ ST.render(); return; }
  const rec = RX.intents.byId(iid), PB = RX.problems || {};
  const v = PB.vOf ? (PB.vOf(iid) || {iid, fields: r.fields || {}}) : null;   // as it was BEFORE the cancel
  /* ⭐ PM-3069: the best-by row goes with it — but ONLY once the cancel is CERTAIN (review 2026-10-22 (1): deleting it while the cancel
     was still queued let a case another tablet had already put away — and the poster posted — lose its best-by).
       never left this tablet  → cancelled here, certain;
       otherwise               → ST.claim: PATCH only if the server still says `staged` (If-Match); certain only when it LANDED, not queued. */
  let certain = false, queued = false;
  if(rec && !rec.sent && !rec.tried && !rec.inflight){ RX.intents.cancel(iid); S.hidden.add(iid); certain = true; }
  else{ const res = await ST.claim(r, {State: "cancelled"}, "staged"); if(res.ok){ S.hidden.add(iid); certain = !res.queued; queued = !!res.queued; } else conflictToast(r, res); }
  S.tray.items = S.tray.items.filter(x => x.iid !== iid); trayTouch();
  if(v && certain && PB.dropBb){
    const b = await PB.dropBb(v);
    if(!b.ok){ if(PB.tellBbLeft) PB.tellBbLeft(v, b.why || "error"); S.notice = t("staged_cancel_bb_failed", {why: esc(b.why || "error")}); }
  }else if(v && queued){ if(PB.tellBbLeft) PB.tellBbLeft(v, "no signal: the cancel was queued"); S.notice = t("staged_cancel_bb_queued"); }
  ST.render(); ST.refresh();
});

/* ───────────────────────── "already on a cart?" — the receive and sort screens (2026-10-23 PM) ─────────────────────────
   Jack: "how do we get the tablets to always show the correct info needed?" — 10-22: 16 frozen cases already on carts were scanned again
   from the receive screens and became SECOND cart records. Now, after the count, when live cart records of that item exist on the same
   PO the crew is asked first. [Yes — this is it] records NOTHING (no best-by row, no intent): in Put away here the record goes into the
   hand (tray) for the shelf tag; in Sort first it is already where it belongs. [No — another case] carries on (the over-shipment
   confirm still asks if it goes past what KeHE shipped). ⛔ Never in Best-by only (that flow runs no steps). */
const dayAt = (iso) => { const d = new Date(Date.parse(iso)); if(isNaN(d)) return ""; return d.toLocaleDateString(undefined, {weekday: "short"}) + " " + RX.hhmm(iso); };
/* ⛔ review 2026-10-23 PM (1): only when this case would take the item PAST what KeHE shipped (else ordered) counting what is already
   received, scanned and on carts (RX.po.overCap) — a normal second, third … case of a line is never asked. (7): cart records of the
   SKU on ANY open PO (a re-scan can match a different PO once the first reads full). */
function onCartFor(p, m){
  if(!p || !p.prod) return [];
  const o = (RX.po && RX.po.overCap) ? RX.po.overCap(p, +p.qty || 0) : null;
  if(!(o && o.over)) return [];
  p.rx = p.rx || {}; p.rx.oncartOver = o;
  const pos = new Set(RX.po.pos().map(po => String(po.order_id)));
  return oldestFirst(ST.records().filter(r => r.sku === p.prod.sku && pos.has(String(r.po)) && !inTray(r.iid) && !holdWaiting(r)
                                           && (r.fields || {}).PageMode === "live"));
}
RX.registerStep("oncart", {
  keepScan: false,
  applies(ctx){
    const p = ctx.p; if(p.rx && p.rx.oncartNo) return false;
    const recs = onCartFor(p, ctx.po); (p.rx || (p.rx = {})).oncart = recs.map(r => r.iid);
    return recs.length > 0;
  },
  start(ctx){
    const p = ctx.p, recs = onCartFor(p, ctx.po); if(!recs.length){ ctx.done({}); return; }
    const same = recs.filter(r => p.best && r.best === p.best), order = same.concat(recs.filter(r => same.indexOf(r) < 0)).slice(0, 4);
    const rows = order.map(r => btn("oncart-pick", t("oncart_row", {units: fmtU(r.units), bb: r.best ? r.best : "no date", area: r.area || "a cart", when: dayAt(r.at), who: whoText(r)}),
      "rx-st-lot", `data-iid="${esc(r.iid)}"`)).join("");
    const o = (p.rx && p.rx.oncartOver) || {};
    const sub = o.cap != null ? `<span class="rx-pa-sub">${esc(t(o.basis === "shipped" ? "oncart_sub" : "oncart_sub_ord", {n: fmtU(o.n), cap: fmtU(o.cap)}))}</span>` : "";
    /* ⭐ "No — another case" is the primary (Enter): it records the case, so a wrong Enter can never lose a real case */
    prompt_("stop", esc(t("oncart_title", {name: p.prod.name})), sub,
      `<div>${rows}</div><div class="rx-pa-btns">${btn("oncart-no", t("oncart_no"), "primary", "data-primary")}${btn("oncart-back", t("btn_back"), "", 'data-close="3"')}</div>`);
    setTimeout(() => { const b = document.querySelector("#promptArea [data-primary]"); if(b) b.focus(); }, 30);
    RX.sound("decide");
  },
  onScan(){ return false; },
});
const onCartCtx = () => { const st = RX.state.step; return st && st.name === "oncart" ? st.ctx : null; };
RX.registerAct("oncart-no", () => { const c = onCartCtx(); if(!c) return; (c.p.rx || (c.p.rx = {})).oncartNo = true; try{ clearPrompt(); }catch(_){} c.done({overConfirmed: true}); });   // the crew just said it is an extra case: the overship step does not ask again
RX.registerAct("oncart-back", () => { if(onCartCtx()) RX.backToQty(); });
RX.registerAct("oncart-pick", ({el}) => {
  const c = onCartCtx(); if(!c) return;
  const iid = el.getAttribute("data-iid"), r = ST.records().find(x => x.iid === iid), name = c.p.prod.name, flow = RX.flow();
  if(!r){ RX.toast(t("conflict_gone", {name})); return; }
  /* ⛔ nothing is recorded: the open scan is dropped exactly as Close drops it (no best-by row, no intent) */
  try{ if(typeof abandonPending === "function") abandonPending(); else RX.abandon(); }catch(_){}
  try{ clearPrompt(); }catch(_){}
  if(flow === "sort"){ RX.toast(t("oncart_sort", {name})); RX.sound("staged"); RX.refresh(); return; }
  /* review 2026-10-23 PM (2): the staged screen only until this record is on a shelf (or the hand is cleared) — then back to the
     screen the crew was on, so the next new case is received, not matched against the cart list */
  if(RX.flow() !== "staged"){ S.returnFlow = flow; RX.setFlow("staged"); }
  addToTray(r); S.notice = t("oncart_intray", {name}); ST.render();
});
function maybeReturn(){
  if(!S.returnFlow || S.tray.items.length || S.dec) return;
  const f = S.returnFlow; S.returnFlow = null;
  if(RX.flow() === "staged") RX.setFlow(f);
}

/* ───────────────────────── the tray STEP: a case that was NOT on the list is received now, staged, and lands in the tray ───────────────────────── */
RX.registerStep("tray", {
  keepScan: true,
  start(ctx){
    const p = ctx.p;
    if(!RX.pack.data){ ctx.cancel({flash: t("nopack_flash")}); return; }
    const rank = PA.rankFor({sku: p.prod.sku, name: p.prod.name, cls: p.prod.cls, best: p.best, units: p.qty}, p.qty);
    const top = rank.cands[0];
    const area = top ? (RX.pack.areaOf(top.bin) || "") : ((rank.area && rank.area.name) || "");
    ctx.commit({state: "staged", workflow: "staged", stagedArea: area, recommendedBin: top ? top.bin : "", recReasons: [rank.reason.code]});
    const row = RX.state.lastRow;
    if(row && row.rx){ for(const rec of RX.intents.forRow(row)){ const r = norm({iid: rec.iid, fields: rec.fields, etag: rec.etag, itemId: rec.itemId}); S.list.push(r); S.tray.items.push({iid: r.iid, take: null}); } trayTouch();
      /* ⭐ 2026-10-22: received this way the case is only STAGED + in hand. On 10-22 eight new frozen items were received like this and
         never got a shelf tag, so none reached Finale and nothing said why. Say the next step, in words, where the eye is. */
      S.notice = t("tray_now_tag", {name: esc(p.prod.name)}); ST.render(); }
  },
  onScan(){ return false; },
});

/* ───────────────────────── the stage step (sort first) ───────────────────────── */
ST.cur = null;
function infoText(c, rank){
  const parts = [];
  if(c.role === "pick" && !c.slow && c.daysCover != null) parts.push(t("rec_cover", {a: REC.fmtDays(c.daysCover), b: REC.fmtDays(c.daysCoverWith)}));
  else parts.push(c.units > 0 ? t("rec_onhand", {n: c.units}) : t("rec_empty"));
  if(rank.fefo.measured && c.bin === rank.fefo.olderBin) parts.push(t("stage_older"));
  if(c.units <= 0 && c.lastIn) parts.push(t("rec_lasthere", {d: REC.shortDate(c.lastIn)}));
  return parts.join(" · ");
}
function stageRows(p){
  const rank = PA.rankFor({sku: p.prod.sku, name: p.prod.name, cls: p.prod.cls, best: p.best, units: p.qty}, p.qty);
  const rows = [], seen = new Set();
  for(const c of rank.cands){
    const area = RX.pack.areaOf(c.bin) || c.bin;
    if(seen.has(area)) continue; seen.add(area);
    rows.push({area, bin: c.bin, info: infoText(c, rank)});
    if(rows.length === 3) break;
  }
  if(!rows.length && rank.area) rows.push({area: rank.area.name, bin: "", info: t("stage_anyspot")});
  return {rows, rank};
}
function renderStage(ctx, notice){
  const p = ctx.p, st = p.rx.stage;
  const bb = p.best ? yf(p.best) : "no date";
  let body = (notice ? `<span class="rx-pa-note" role="alert">${esc(notice)}</span>` : "") + `<strong>${esc(p.prod.name)}</strong>${RX.idLine(p.prod.sku)}<span class="rx-pa-sub">${esc(t("d2_units", {n: p.qty, bb: "\u0000"})).replace("\u0000", bb)}</span>`;
  let acts = "";
  if(st.sub === "other"){
    acts += `<div class="rx-pa-sub"><strong>${esc(t("stage_choose"))}</strong></div>` + st.areas.map(a => `<button type="button" class="rx-st-pick" data-act="stage-area" data-area="${esc(a)}"><span class="area">${esc(a)}</span></button>`).join("") +
            `<div class="rx-pa-btns">${btn("stage-back", t("stage_back"), "", 'data-close="3"')}</div>`;
  }else{
    acts += st.rows.map((r, i) => `<button type="button" class="rx-st-pick${i === 0 ? " top" : ""}" data-act="stage-pick" data-i="${i}">
      <span class="area">${i === 0 ? `<span class="rx-st-key">${esc(t("stage_enter"))}</span>` : ""}${esc(String(r.area).toUpperCase())}</span><span class="bin">${esc(r.bin)}</span><span class="info">${esc(r.info)}</span></button>`).join("");
    acts += `<div class="rx-pa-btns">${btn("stage-other", t("stage_other"))}${btn("stage-direct", t("stage_direct"))}${btn("stage-cancel", t("btn_cancel_case"))}${btn("stage-close", t("btn_back_count"), "", 'data-close="3"')}</div>`;
  }
  prompt_("go", esc(t("stage_title")), body, acts, {keepScan: true});
  RX.side.clear();
}
function areasFor(p){
  const d = RX.pack.data || {}, a = d.areas || {}, temp = PA.itemTemp(p.prod.sku, p.prod.cls);
  const out = []; for(const k of Object.keys(a)){ if(temp && k.charAt(0).toUpperCase() !== temp) continue; if(out.indexOf(a[k]) < 0) out.push(a[k]); }
  return out.length ? out : [...new Set(Object.values(a))];
}
const stageCtx = () => { const s = RX.state.step; return s && s.name === "stage" ? s.ctx : null; };
function commitStage(ctx, row){
  const st = ctx.p.rx.stage; ST.cur = null;
  ctx.commit({state: "staged", workflow: "staged", stagedArea: row.area, recommendedBin: row.bin || "", recReasons: [st.rank.reason.code]});
}
function toShelf(ctx, tagBin){
  const ctx2 = Object.assign({}, ctx, {step: "shelf"});
  RX.state.step = {name: "shelf", ctx: ctx2}; ST.cur = null; RX.side.clear();
  PA.startShelf(ctx2, {noArmed: true});
  if(tagBin) PA.onTag(ctx2, ctx2.p.rx.d2, tagBin, "scanned");
}
RX.registerStep("stage", {
  keepScan: true,
  start(ctx){
    if(!RX.pack.data){ ctx.cancel({flash: t("nopack_flash")}); return; }
    const {rows, rank} = stageRows(ctx.p);
    ctx.p.rx.stage = {rows, rank, sub: "main", areas: []};
    ST.cur = ctx; renderStage(ctx);
  },
  onScan(ctx, raw){
    const st = ctx.p.rx.stage; if(!st || st.sub !== "main") return false;
    const id = PA.identify(raw);
    if(id.kind === "tag"){ toShelf(ctx, id.bin); return true; }          // a tag at the stage card = "I'm at the shelf"
    try{ noteDropped(raw, "STAGE_WRONG"); }catch(_){}
    renderStage(ctx, t("stage_wrong", {name: ctx.p.prod.name})); RX.sound("refused");
    return true;
  },
  onEmptyEnter(ctx){
    const st = ctx.p.rx.stage; if(!st || st.sub !== "main" || !st.rows.length) return false;
    commitStage(ctx, st.rows[0]); return true;
  },
  abort(){ ST.cur = null; },
});
RX.registerAct("stage-pick", ({el}) => { const c = stageCtx(); if(!c) return; const st = c.p.rx.stage, row = st.rows[+el.getAttribute("data-i")]; if(row) commitStage(c, row); });
RX.registerAct("stage-other", () => { const c = stageCtx(); if(!c) return; const st = c.p.rx.stage; st.sub = "other"; st.areas = areasFor(c.p); renderStage(c); });
RX.registerAct("stage-back", () => { const c = stageCtx(); if(!c) return; c.p.rx.stage.sub = "main"; renderStage(c); });
RX.registerAct("stage-area", ({el}) => { const c = stageCtx(); if(c) commitStage(c, {area: el.getAttribute("data-area"), bin: ""}); });
RX.registerAct("stage-direct", () => { const c = stageCtx(); if(c) toShelf(c, null); });
RX.registerAct("stage-close", () => { if(stageCtx()) RX.backToQty(); });
RX.registerAct("stage-cancel", () => { const c = stageCtx(); if(c){ ST.cur = null; c.cancel({}); } });
})();
