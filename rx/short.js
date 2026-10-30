/* receiving/rx/short.js — "WE NEVER GOT IT": the crew records a PO line as SHORT, once, with the facts in front of them (2026-10-23).
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving). Plan: Procurement & Merchandising/plans/2026-10-23-receiving-crew-short-PLAN.md.

   Jack, 2026-10-23: "a way for them in the app to review an item and say, that it was short, we didn't get that quantity, and confirm
   that that's the case. The app had that follow through and not be an open issue for the person receiving it." (PO 2026101801: 12 Ground
   Bison never arrived; nobody could say so on the tablet, so the buyer had to go back and ask the crew days later.)

   ═══ WHAT IT IS ═══
   One `ReceivingIntents` row, Kind=short (measured 2026-10-23: the list stores the value), State ready | cancelled, Po, Sku,
   FixUnits = the units that never arrived, FixNote "never arrived" | "got fewer", Operator / Device / ScanAt = who and when.
   ⛔ Units = 0 and the poster ignores every Kind ≠ intent (lib/receiving_post.py) ⇒ it can never reach Finale. ⛔ The tablet NEVER
      changes a Finale quantity: the buyer / the close-out own the PO.
   ⛔ RX.intents.allToday() / allPo() never return it (every counter reads them); this file reads RX.intents.shorts().

   ═══ THE RULES ═══
   • Offered only on a line with units MISSING: what KeHE shipped (else what we ordered — RX.po.capOf, the poster's own limit) minus
     what is in Finale or scanned (RX.po.counts: on a cart counts — it is in the building). ⭐ A line KeHE shipped 0 of (its shipped
     file, or a ship confirmation that zeroed the PO line) has nothing missing ⇒ the crew is never asked about it.
   • Live tablets only, and only while the PO-wide read is good (a guess would record the wrong number).
   • The confirm card shows ordered · KeHE shipped · Finale has · scanned on its way, then the units (prefilled with what is missing,
     1..missing). The numbers are re-read at the tap; if they moved, nothing is written and the card says so.
   • One short per line: recording again cancels the earlier record(s) first. Undo = cancel (State cancelled, If-Match).
   • A case that turns up later is scanned as usual; the line then reads "short N, but M scanned since" with ONE button that sets the
     short to what is still missing (or removes it). Readers (the portal close-out) use min(recorded, missing) all the same.
   API (RX.short): line(po, line) → {cap, basis, known, got, missing, rec, recorded, effective, open, stale} | null
                   html(po, line) → the line's short block        finishHtml() → Finish truck's "still missing" list */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const S = RX.short = {};
const I = RX.intents, t = RX.t, esc = RX.esc;

const COPY_ADD = {
  sh_never:       "We never got this",
  sh_fewer:       "We got fewer — {n} missing",
  sh_h:           "Record {name} as short?",
  sh_facts:       "PO {po}: ordered {ordered} · KeHE shipped {shipped} · Finale has {have}{coming}.",
  sh_facts_coming:" · {n} scanned, going into Finale",
  sh_unk:         "not known yet",
  sh_look:        "Only once you have looked: not on a cart, the dock, the cooler or the freezer.",
  sh_units:       "Units that never arrived (up to {n})",
  sh_yes:         "Yes — record it short",
  sh_back:        "Back",
  sh_bad_n:       "Type a whole number from 1 to {n}.",
  sh_changed:     "The numbers changed on another tablet or in Finale. Nothing was saved — look again.",
  sh_noread:      "The PO could not be read — try again in a minute. Nothing was saved.",
  sh_who:         "Signed in as {who}.",
  sh_done:        "Recorded: {n} short. Purchasing sees it at close-out — nothing else to do.",
  sh_tag:         "short {n}",
  sh_rec:         "Short {n} — {who} said it never arrived ({when}).",
  sh_undo:        "Undo",
  sh_undone:      "Short removed.",
  sh_stale:       "{m} scanned since then — {left} still missing.",
  sh_stale_cap:   "The PO changed since (KeHE's shipped figure) — {left} still missing.",
  sh_hold:        "{n} case(s) on this tablet are still To identify (HOLD shelf). Check none of them is this item first.",
  sh_denied:      "Not saved — this tablet was not allowed to record it ({why}). Tell purchasing.",
  sh_stale_set:   "Change the short to {n}",
  sh_stale_rm:    "It all came — remove the short",
  sh_sending:     " (still sending from this tablet)",
  sh_fin_h:       "Still missing on PO {po}",
  sh_fin_line:    "{name}: {got} of {cap} — {n} not scanned",
  sh_fin_go:      "Open it",
  sh_fin_none:    "Every line on PO {po} is scanned or recorded short.",
  po_f_short:     "Short",
  sh_closed:      "PO closed out by {who} ({when}) with this line short — the short is final here. To change it, tell purchasing.",
  sh_closed_no:   "Not changed — this PO was closed out by {who} ({when}). Tell purchasing.",
  sh_gone:        "PO {po} is no longer open for receiving — ask purchasing to change it.",
  sh_co_unknown_new:"Close-out status could not be read just now. Record it only if you are sure this PO has not been closed out yet.",
  sh_co_unknown:  "Close-out status could not be read just now, so shorts on this PO cannot be changed from the tablet. Try again later or tell purchasing.",
};
for(const k of Object.keys(COPY_ADD)) if(!(k in RX.COPY)) RX.COPY[k] = COPY_ADD[k];

S.state = { asking:null, err:"", msg:{}, busy:new Set() };

/* ⭐ PM-3126 (2026-10-24): a crew short on a PO that has been CLOSED OUT is evidence the close-out used (who said it never arrived, and
   when) — Undo or a re-record would erase it silently (a re-recorded short gets a NEW id). The pack publishes, per PO, `closed_out` =
   {by, at, edit_id, skus, crew_intent_ids} or null, and `sources.closeouts.error` when the close-out log could not be read.
     closed  — `closed_out` set: EVERY line of the PO is LOCKED (ruling: Jack, 2026-10-24) — no record, no Undo, no fix-up; the line
               says who closed it out and to tell the buyer. (`skus` / `crew_intent_ids` are no longer needed to decide.)
     lock_all — `closed_out.lock_all` (a close-out QBO recorded with no shorts): EVERY crew short on the PO is final, named or not.
     unknown — `closed_out.unknown` (the pack could not tell for THIS PO; it carries lock_all): every short write on the PO is refused.
     unknown — `sources.closeouts` missing (an older pack), its `error` or `qbo_error` set, or a PO with no `closed_out` key: null is NOT "open";
               an EXISTING short is left alone — Undo, fix-up and re-record are refused with a warning; a line with no short may still
               record one (the card warns that the close-out could not be checked).
     gone    — the PO is not in the current pack at all (left receiving): every short write refused, "ask purchasing" (§5b).
     open    — `closed_out` null and no error.
   Checked again at the moment of every tap (the pack may have refreshed). -> {state, co?} */
function coState(poId){
  const d = RX.pack.data; const po = d && RX.pack.poById ? RX.pack.poById(poId) : null;
  const src = d && d.sources && d.sources.closeouts;
  /* ⭐ PM-3126 §5b (plan 2026-10-23-closeout-crew-intent, decided 2026-10-24): a PO the current pack does not list has LEFT receiving
     (fully received or closed out — the builder only packs OPEN POs): every short write on it is refused, "ask purchasing" */
  if(d && !po) return {state:"gone", po:String(poId)};
  /* review (1): a NEWER pack already fetched but not yet applied (applied at an idle moment) that no longer lists the PO wins too */
  const q = RX.pack.queued && RX.pack.queued.data;
  if(q && Array.isArray(q.pos) && !q.pos.some(p => String(p.order_id) === String(poId))) return {state:"gone", po:String(poId)};
  if(!po || !src || !Object.prototype.hasOwnProperty.call(po, "closed_out")) return {state:"unknown"};      // no pack yet, an older pack, a PO without the key
  const co = po.closed_out;
  /* null = "not closed out" ONLY when both sources were read; with the portal log (`error`) or QBO-Tools' records (`qbo_error`) unreadable,
     a null is "can't tell". ⛔ A NON-null answer the pack still reached is honoured even then (review 2026-10-24 (1): QBO can still say
     "closed, these lines" when only the log failed, and the builder marks POs it cannot tell as {unknown, lock_all}) */
  if(!co) return (src.error || src.qbo_error) ? {state:"unknown"} : {state:"open"};
  /* ⭐ 2026-10-24 (pack follow-up): THIS PO cannot be told — {unknown:true, error, lock_all:true, skus:[every line]} */
  if(co.unknown) return {state:"unknown", co, lockAll: co.lock_all !== false};
  /* closed out; `lock_all` (e.g. a QBO close-out record with no shorts) = every crew short on the PO is final */
  return {state:"closed", co, lockAll: !!co.lock_all};
}
S.coState = coState;
/* -> "" (free to change) | the words that refuse the change */
function locked(poId, sku, recs){
  const c = coState(poId);
  if(c.state === "gone") return t("sh_gone", {po:String(poId)});
  if(c.state === "unknown"){
    if(c.lockAll) return t("sh_co_unknown");                              // the pack says THIS PO cannot be told: every short is locked
    return (recs || []).length ? t("sh_co_unknown") : "";                 // source-wide unknown: an existing short is left alone; a first may be recorded
  }
  if(c.state !== "closed") return "";
  /* ⭐ ruling (Jack, 2026-10-24, PM-3171): "it should all be locked out once completed and billed in QBO" — a closed-out PO locks EVERY
     crew short on it, named in `skus` / `crew_intent_ids` or not. ⛔ No reopen path from the tablet ("we may need a way to re-open/adjust
     this in the future, but not now"). */
  const co = c.co || {};
  return t("sh_closed_no", {who: short_(co.by) || "purchasing", when: whenText(co.at || "")});
}
S.locked = (poId, sku) => locked(poId, sku, records(poId, sku));
const A = S.state;
const keyOf = (po, sku) => String(po) + "|" + String(sku);
const fmtN = (x) => String(Math.round((+x || 0) * 100) / 100);
const poRead = () => !(I.state && (I.state.poErr || !I.state.poLoaded));
const whoAmI = () => { try{ return account || ""; }catch(_){ return ""; } };
const short_ = (s) => String(s || "").split("@")[0];
const nameOf = (sku) => { const i = RX.pack.skuInfo(sku); return (i && i.name) || sku || "this item"; };
const usable = () => RX.mode() === "live" && poRead() && !!(RX.po && RX.po.capOf && RX.po.counts);
/* ⛔ a forced drawer refresh focuses the PO search box, and the drawer then skips every later redraw while focus sits in an input — so
   "still sending" would stay on screen after the record was saved or refused. An EMPTY search box is not someone typing: release it. */
const unstick = () => { const a = document.activeElement; if(a && a.id === "rxPoSearch" && !String(a.value || "").trim()) try{ a.blur(); }catch(_){} };
const refresh = () => { RX.refresh(); RX.call("drawer", "refresh", true); unstick(); try{ if(window.RXIdentify) RXIdentify.render(); }catch(_){} };
/* when this tablet's short is sent or refused, the line must say so */
RX.on("intents", () => { if(RX.drawer && RX.drawer.state && RX.drawer.state.open === "po"){ unstick(); RX.call("drawer", "refresh"); } });

/* the live short records of one line, newest first */
function records(po, sku){
  const out = [];
  for(const x of (I.shorts ? I.shorts() : [])){
    const f = x.fields || {};
    if(f.State === "cancelled" || String(f.Po || "") !== String(po) || f.Sku !== sku) continue;
    const rec = I.byId(x.iid); if(rec && (rec.cancelled || rec.denied)) continue;
    out.push(x);
  }
  return out.sort((a, b) => String((b.fields || {}).ScanAt || "").localeCompare(String((a.fields || {}).ScanAt || "")));
}
S.records = records;
/* this tablet's own short the list REFUSED (403 / not allowed): shown on the line, never as "Recorded" (review 6) */
function deniedOf(po, sku){
  for(const x of (I.shorts ? I.shorts() : [])){
    const f = x.fields || {}, rec = I.byId(x.iid);
    if(rec && rec.denied && !rec.cancelled && String(f.Po || "") === String(po) && f.Sku === sku) return rec;
  }
  return null;
}

S.line = function(po, line){
  if(!po || !line || !RX.po || !RX.po.capOf || !RX.po.counts) return null;
  const cp = RX.po.capOf(po.order_id, line.sku); if(!cp) return null;
  const c = RX.po.counts(po, line);
  const got = +c.total || 0, missing = Math.max(0, Math.floor((+cp.cap || 0) - got));
  const recs = records(po.order_id, line.sku), rec = recs[0] || null;
  const recorded = rec ? (+((rec.fields || {}).FixUnits) || 0) : 0;
  const effective = Math.min(recorded, missing);
  /* review 1: "scanned since" is measured from what was in when the short was recorded (FixBin "got:<n>"), never inferred from a
     change in the limit — KeHE's shipped file arriving later moves the limit with nothing scanned */
  const m0 = rec ? /^got:(\d+(?:\.\d+)?)$/.exec(String((rec.fields || {}).FixBin || "")) : null;
  const gotAt = m0 ? +m0[1] : null, since = gotAt == null ? null : Math.max(0, got - gotAt);
  return {cap:+cp.cap || 0, basis:cp.basis, known:cp.known, got, missing, rec, recs, recorded, effective, open:missing - effective,
          stale: !!rec && recorded > missing, since, ordered:+c.ordered || 0};
};

/* the facts line: what we ordered, what KeHE shipped, what Finale has, what is scanned and on its way */
function facts(po, line, L){
  const cf = RX.po.confirmed ? RX.po.confirmed(po.order_id, line.sku) : null;
  const have = cf ? +cf.units || 0 : 0, coming = Math.max(0, L.got - have);
  const sh = RX.po.shippedInfo ? RX.po.shippedInfo(po.order_id, line.sku) : null;      // PM-3345: information only — the limit is the PO
  return t("sh_facts", {po:String(po.order_id), ordered:fmtN(L.ordered), shipped: sh != null ? fmtN(sh) : t("sh_unk"), have:fmtN(have),
                        coming: coming > 0 ? t("sh_facts_coming", {n:fmtN(coming)}) : ""});
}
const whenText = (iso) => { const d = new Date(Date.parse(iso)); if(isNaN(d)) return ""; return (iso ? String(iso).slice(5, 10) + " " : "") + RX.hhmm(iso); };

S.tag = function(po, line){
  const L = S.line(po, line); if(!L || !L.rec || !(L.effective > 0)) return "";
  return `<span class="rx-chip rx-short-tag">${esc(t("sh_tag", {n:fmtN(L.effective)}))}</span>`;
};

S.html = function(po, line){
  if(RX.mode() !== "live") return "";
  const L = S.line(po, line); if(!L) return "";
  const k = keyOf(po.order_id, line.sku), msg = A.msg[k] ? `<div class="hint rx-pb-msg" role="status">${esc(A.msg[k])}</div>` : "";
  const busy = A.busy.has(k) ? " disabled" : "";
  if(A.asking && A.asking.key === k) return askHtml(po, line, L);
  const lk = locked(po.order_id, line.sku, L.recs);
  if(lk){
    const c = coState(po.order_id);
    if(!L.rec && !(L.missing > 0)) return msg;
    const head = L.rec ? `<strong>${esc(t("sh_rec", {n:fmtN(L.recorded), who:short_((L.rec.fields || {}).Operator) || "someone", when:whenText((L.rec.fields || {}).ScanAt)}))}</strong> ` : "";
    const why = c.state === "closed" ? t("sh_closed", {who: short_((c.co || {}).by) || "purchasing", when: whenText((c.co || {}).at || "")}) : t("sh_co_unknown");
    return `<div class="rx-short rx-short-locked" data-short="${esc(k)}" data-co="${esc(c.state)}">${head}<div class="hint" role="status">${esc(why)}</div>${msg}</div>`;
  }
  if(L.rec){
    const f = L.rec.fields || {}, mine = I.byId(L.rec.iid), sending = mine && !mine.sent ? t("sh_sending") : "";
    let h = `<div class="rx-short" data-short="${esc(k)}"><strong>${esc(t("sh_rec", {n:fmtN(L.recorded), who:short_(f.Operator) || "someone", when:whenText(f.ScanAt)}))}</strong>${esc(sending)}
      <button type="button" class="rx-btn" data-act="short-undo" data-key="${esc(k)}"${busy}>${esc(t("sh_undo"))}</button>`;
    if(L.stale && poRead()){
      const why = L.since > 0 ? t("sh_stale", {m:fmtN(L.since), left:fmtN(L.missing)}) : (L.since === 0 ? t("sh_stale_cap", {left:fmtN(L.missing)})
                : t("sh_stale", {m:fmtN(L.recorded - L.missing), left:fmtN(L.missing)}));
      h += `<div class="hint">${esc(why)}</div>
        <button type="button" class="rx-btn primary" data-act="short-fixup" data-key="${esc(k)}"${busy}>${esc(L.missing > 0 ? t("sh_stale_set", {n:fmtN(L.missing)}) : t("sh_stale_rm"))}</button>`;
    }
    return h + msg + `</div>`;
  }
  const dn = deniedOf(po.order_id, line.sku);
  if(dn){ delete A.msg[k]; return `<div class="rx-short rx-red" data-short="${esc(k)}">${esc(t("sh_denied", {why:String(dn.err || dn.denied || "refused")}))}</div>`; }
  if(!(L.missing > 0) || !poRead()) return msg;
  const label = L.got > 0 ? t("sh_fewer", {n:fmtN(L.missing)}) : t("sh_never");
  return `<div class="rx-short" data-short="${esc(k)}"><button type="button" class="rx-btn" data-act="short-ask" data-key="${esc(k)}"${busy}>${esc(label)}</button>${msg}</div>`;
};

function askHtml(po, line, L){
  const k = keyOf(po.order_id, line.sku), me = whoAmI();
  const val = A.asking.val != null ? A.asking.val : String(L.missing);
  return `<div class="rx-fix rx-short-ask" data-short="${esc(k)}"><strong>${esc(t("sh_h", {name:nameOf(line.sku)}))}</strong>${RX.idLine(line.sku)}
    <div class="hint rx-fix-po">${esc(facts(po, line, L))}</div>
    <div class="hint">${esc(t("sh_look"))}</div>
    ${coState(po.order_id).state === "unknown" ? `<div class="rx-note" role="status" data-k="sh-co-unknown">${esc(t("sh_co_unknown_new"))}</div>` : ""}
    ${(() => { let n = 0; try{ n = window.RXIdentify ? RXIdentify.count() : 0; }catch(_){} return n > 0 ? `<div class="rx-note rx-red" role="status" data-k="sh-hold">${esc(t("sh_hold", {n:String(n)}))}</div>` : ""; })()}
    <label class="hint" for="rxShortN">${esc(t("sh_units", {n:fmtN(L.missing)}))}</label>
    <input id="rxShortN" class="num" type="text" inputmode="numeric" maxlength="5" autocomplete="off" value="${esc(val)}" aria-label="${esc(t("sh_units", {n:fmtN(L.missing)}))}">
    <button type="button" class="rx-btn primary" data-act="short-yes" data-key="${esc(k)}"${A.busy.has(k) ? " disabled" : ""}>${esc(t("sh_yes"))}</button>
    <button type="button" class="rx-btn" data-act="short-back" data-key="${esc(k)}">${esc(t("sh_back"))}</button>
    ${me ? `<div class="hint">${esc(t("sh_who", {who:me}))}</div>` : ""}
    ${A.err ? `<div class="rx-note rx-red" role="alert">${esc(A.err)}</div>` : ""}</div>`;
}

/* a tap whose PO is no longer in the pack: say so (the button was drawn from an older pack) -> true when refused */
function goneTap(k){
  const i = String(k || "").lastIndexOf("|"); if(i < 0) return false;
  const poId = String(k).slice(0, i);
  if(!(RX.pack.data && RX.pack.poById)) return false;
  if(RX.pack.poById(poId) && coState(poId).state !== "gone") return false;          // in the pack, and not dropped by a queued newer one
  A.asking = null; A.msg[k] = t("sh_gone", {po:poId});
  try{ RX.toast(t("sh_gone", {po:poId})); }catch(_){} refresh(); return true;
}
/* (po, line) for a key, from the pack */
function find(k){
  const i = String(k || "").lastIndexOf("|"); if(i < 0) return null;
  const poId = k.slice(0, i), sku = k.slice(i + 1);
  const po = RX.pack.poById ? RX.pack.poById(poId) : null; const line = po && RX.po.line(po, sku);
  return line ? {po, line, k} : null;
}

/* a short record: Units 0 (never a receipt), the units in FixUnits */
function record(po, line, n, note, got){
  const info = RX.pack.skuInfo(line.sku) || {};
  return I.create({Kind:"short", State:"ready", Po:String(po.order_id), Sku:line.sku, Upc:String(info.upc || ""), Units:0,
                   FixUnits:n, FixNote:note, FixBin:"got:" + fmtN(got || 0)}, {});
}
/* cancel every live short of the line: this tablet's own through the outbox, another tablet's through the If-Match write.
   -> "" | the reason in words (then NOTHING else is written) */
async function cancelAll(L){
  /* another tablet's records FIRST (they can fail: 412 / offline); this tablet's own only once those landed (review 8) */
  const recs = (L.recs || []).slice().sort((a, b) => (I.byId(a.iid) ? 1 : 0) - (I.byId(b.iid) ? 1 : 0));
  for(const x of recs){
    const g = coState(String((x.fields || {}).Po || ""));                      // review (2): the PO may leave mid-loop
    if(g.state === "gone") return t("sh_gone", {po:g.po});
    const rec = I.byId(x.iid);
    if(rec){ I.cancel(x.iid); continue; }
    const P = RX.problems; if(!P || !P.patchIntent) return t("sh_noread");
    const r = await P.patchIntent(x, {State:"cancelled"}, "");
    if(!r.ok) return P.whyText ? P.whyText(r.why) : t("sh_changed");
  }
  return "";
}

/* ⭐ PM-3384 (Jack, 2026-10-29): a lower count through Fix that the crew says NEVER ARRIVED also becomes the line's crew short, so it
   reaches expected credits like "We never got it". A line's short is ONE absolute number (the newest live record; the older ones are
   cancelled), so the new record is the existing short PLUS these d units, never beyond the PO line. Same guards as "We never got it":
   live mode, the PO readable, not closed out. -> {ok:true, n} | {ok:false, msg} */
S.addFromFix = async function(poId, sku, d, scanIid){
  const c = find(keyOf(poId, sku)); if(!c) return {ok:false, msg:t("sh_noread")};
  if(!usable()) return {ok:false, msg:t("sh_noread")};
  if(A.busy.has(c.k)) return {ok:false, msg:t("sh_changed")};
  const L = S.line(c.po, c.line); if(!L) return {ok:false, msg:t("sh_noread")};
  const lk = locked(c.po.order_id, c.line.sku, L.recs); if(lk) return {ok:false, msg:lk};
  A.busy.add(c.k);
  try{
    const why = await cancelAll(L); if(why) return {ok:false, msg:why};
    const lk2 = locked(c.po.order_id, c.line.sku, L.recs); if(lk2) return {ok:false, msg:lk2};
    const n = Math.min(L.cap > 0 ? L.cap : Infinity, (L.recorded || 0) + (+d || 0));
    record(c.po, c.line, n, "never arrived (Fix on scan " + scanIid + ")", Math.max(0, L.got - (+d || 0)));
    return {ok:true, n};
  }finally{ A.busy.delete(c.k); refresh(); }
};
RX.registerAct("short-ask", ({el}) => {
  if(goneTap(el.dataset.key)) return;
  const c = find(el.dataset.key); if(!c) return;
  if(!usable()){ A.msg[c.k] = t("sh_noread"); refresh(); return; }
  const L = S.line(c.po, c.line); if(!L || !(L.missing > 0)) return;
  const lk0 = locked(c.po.order_id, c.line.sku, L.recs); if(lk0){ A.msg[c.k] = lk0; refresh(); return; }
  A.asking = {key:c.k, missing:L.missing, got:L.got, rec:L.rec ? L.rec.iid : null, val:null}; A.err = ""; delete A.msg[c.k];
  RX.call("drawer", "refresh", true);
  setTimeout(() => { const i = document.getElementById("rxShortN"); if(i){ try{ i.focus(); i.select(); }catch(_){} } }, 30);
});
RX.registerAct("short-back", () => { A.asking = null; A.err = ""; RX.call("drawer", "refresh", true); });
RX.registerAct("short-yes", async ({el}) => {
  if(goneTap(el.dataset.key)) return;
  const c = find(el.dataset.key); if(!c || !A.asking || A.asking.key !== c.k) return;
  if(A.busy.has(c.k)) return;
  const inp = document.getElementById("rxShortN"), raw = String(inp ? inp.value : "").trim();
  A.asking.val = raw;
  if(!usable()){ A.asking = null; A.msg[c.k] = t("sh_noread"); refresh(); return; }
  const L = S.line(c.po, c.line);
  /* ⛔ the numbers are re-read at the tap: if anything moved, nothing is written (no new meaning under the finger) */
  if(!L || L.missing !== A.asking.missing || L.got !== A.asking.got || (L.rec ? L.rec.iid : null) !== A.asking.rec){ A.asking = null; A.msg[c.k] = t("sh_changed"); refresh(); return; }
  const lk = locked(c.po.order_id, c.line.sku, L.recs); if(lk){ A.asking = null; A.msg[c.k] = lk; refresh(); return; }
  const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if(!(n >= 1 && n <= L.missing)){ A.err = t("sh_bad_n", {n:fmtN(L.missing)}); RX.call("drawer", "refresh", true); return; }
  A.busy.add(c.k); RX.call("drawer", "refresh", true);
  try{
    const why = await cancelAll(L);
    if(why){ A.asking = null; A.msg[c.k] = why; return; }
    /* PM-3126 review (3): the pack may have refreshed to "closed out" while the cancel was on the wire — nothing new is recorded then */
    const lk2 = locked(c.po.order_id, c.line.sku, L.recs); if(lk2){ A.asking = null; A.msg[c.k] = lk2; return; }
    record(c.po, c.line, n, L.got > 0 ? "got fewer" : "never arrived", L.got);
    A.asking = null; A.err = ""; A.msg[c.k] = t("sh_done", {n:fmtN(n)});
  }finally{ A.busy.delete(c.k); refresh(); }
});
RX.registerAct("short-undo", async ({el}) => {
  if(goneTap(el.dataset.key)) return;
  const c = find(el.dataset.key); if(!c || A.busy.has(c.k)) return;
  const L = S.line(c.po, c.line); if(!L || !L.rec) return;
  const lk = locked(c.po.order_id, c.line.sku, L.recs); if(lk){ A.msg[c.k] = lk; refresh(); return; }
  A.busy.add(c.k); RX.call("drawer", "refresh", true);
  try{ const why = await cancelAll(L); A.msg[c.k] = why || t("sh_undone"); }finally{ A.busy.delete(c.k); refresh(); }
});
RX.registerAct("short-fixup", async ({el}) => {
  if(goneTap(el.dataset.key)) return;
  const c = find(el.dataset.key); if(!c || A.busy.has(c.k)) return;
  if(!usable()){ A.msg[c.k] = t("sh_noread"); refresh(); return; }
  const L = S.line(c.po, c.line); if(!L || !L.rec || !L.stale) return;
  const lk = locked(c.po.order_id, c.line.sku, L.recs); if(lk){ A.msg[c.k] = lk; refresh(); return; }
  A.busy.add(c.k); RX.call("drawer", "refresh", true);
  try{
    const why = await cancelAll(L);
    if(why){ A.msg[c.k] = why; return; }
    const L2 = S.line(c.po, c.line);                      // review 8: re-read after the network wait
    if(!L2 || L2.missing !== L.missing){ A.msg[c.k] = t("sh_changed"); return; }
    const lk2 = locked(c.po.order_id, c.line.sku, L.recs); if(lk2){ A.msg[c.k] = lk2; return; }   // PM-3126 review (3)
    if(L.missing > 0){ record(c.po, c.line, L.missing, "got fewer", L2.got); A.msg[c.k] = t("sh_done", {n:fmtN(L.missing)}); }
    else A.msg[c.k] = t("sh_undone");
  }finally{ A.busy.delete(c.k); refresh(); }
});
/* Finish truck → the line in the PO drawer, opened, with its short button in view */
RX.registerAct("short-goto", ({el}) => {
  if(goneTap(el.dataset.key)) return;
  const c = find(el.dataset.key); if(!c) return;
  try{ if(window.RXIdentify && RXIdentify.close) RXIdentify.close(); }catch(_){}
  const D = RX.drawer; if(!D) return;
  D.openPo(); D.state.poFilter = "all"; D.state.expanded[c.k] = true; D.refresh(true);
  setTimeout(() => { const b = document.querySelector(`#rxDrawer [data-short="${CSS.escape(c.k)}"]`); if(b) try{ b.scrollIntoView({block:"center"}); }catch(_){} }, 60);
});
/* keep the typed number across a re-render (the drawer redraws on every poll) */
document.addEventListener("input", (e) => { if(e.target && e.target.id === "rxShortN" && A.asking) A.asking.val = e.target.value; });

/* Finish truck: every line of a PO this truck has STARTED (anything scanned or in Finale) that still has units nobody scanned or
   recorded short. A PO with nothing on it yet is another truck, not this one. */
S.finishHtml = function(){
  if(RX.mode() !== "live" || !RX.pack.data || !RX.po || !RX.po.pos) return "";
  let h = "";
  for(const po of RX.po.pos()){
    const ls = (po.lines || []).map(l => ({l, L:S.line(po, l)})).filter(x => x.L);
    if(!ls.some(x => x.L.got > 0)) continue;
    const open = ls.filter(x => x.L.open > 0 && !(coState(po.order_id).state === "closed" && locked(po.order_id, x.l.sku, x.L.recs)));
    h += `<div class="rx-short-fin" data-po="${esc(po.order_id)}" style="margin-top:10px"><strong>${esc(t("sh_fin_h", {po:String(po.order_id)}))}</strong>`;
    if(!poRead()) h += `<div class="hint">${esc(t("sh_noread"))}</div>`;
    else if(!open.length) h += `<div class="hint">${esc(t("sh_fin_none", {po:String(po.order_id)}))}</div>`;
    else h += open.map(x => `<div class="toid-row" style="padding:8px 0;border-top:1px solid var(--line)">${esc(t("sh_fin_line", {name:nameOf(x.l.sku), got:fmtN(x.L.got), cap:fmtN(x.L.cap), n:fmtN(x.L.open)}))}
        <button type="button" class="rx-btn" data-act="short-goto" data-key="${esc(keyOf(po.order_id, x.l.sku))}" style="margin-left:6px">${esc(t("sh_fin_go"))}</button></div>`).join("");
    h += `</div>`;
  }
  return h;
};
})();
