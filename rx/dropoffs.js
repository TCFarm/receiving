/* receiving/rx/dropoffs.js — VENDOR DROP-OFF POs on the tablet (crew build `dropoff-planner`, PM5; 2026-11-12).
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   A consignment vendor books a drop-off in the Vendor Portal; Finale then holds a $0 PO for it (`TCF-…`). The pack
   (Procurement & Merchandising/lib/receiving_pack.py) lists such a PO in `pos` like KeHE's once it is LOCKED, with
   `vendor: "dropoff:<party id>"` and a `dropoff` block (owner, vendor name, arrival time), and lists a portal booking that is
   still a DRAFT on (or after) its day in `not_ready`. This file:
     • labels a drop-off PO in the Delivery drawer: "Vendor drop-off · <vendor> · <time> · arriving today", and says plainly
       when the receiving poster is NOT live for that vendor (poster_status.json `modes[<vendor key>]`): receive it in the
       Finale app (the same rule the KeHE chip follows);
     • adds the "Arriving today" group at the top of the drawer: today's vendor drop-offs, then each NOT READY one with
       "Not ready to receive — lock now".
   LOCK NOW posts ONE AgentJobs row, kind `receiving.vendor_po_lock_now` (Subject = the order id, Params {"order_id": …}), through
   the page's ONE job client (`RXPhoto.jobs.enqueue / poll`, rx/photocap.js) and watches it (the rx/refresh.js pattern):
     ⭐ EVERY WAIT SHOWS A STAGE, A CLOCK AND ENDS (_shared/APP-PROGRESS-STATUS.md): Sending → Waiting for the office computer →
        Locking it in Finale, a live clock (the shared `.rx-tick`), LOCK_PICKUP_MS to be picked up and LOCK_TOTAL_MS in all, each
        limit ending in plain words + Try again. A late answer after a limit changes nothing (generation guard).
     ⛔ One press = one row (the button is gone while a row is open for that PO).
     ⛔ NEVER OFFER A CONTROL THAT CANNOT WORK: until the job is installed on the mini (RX.CFG.LOCKNOW_INSTALLED) there is no button —
        the row says "ask purchasing to lock it". localStorage rx_locknow_on = "1" turns it on for one test tablet.
     ⛔ The page never locks anything itself and never decides what posts: the mini re-checks the order in its own ledger.
   API: RX.dropoffs = { isDropoff(po), vendorOf(po), posterLive(vk), poLabel(po), sectionHtml(), modeKeyForPo(poId), state } */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const CFG = RX.CFG, t = RX.t, esc = RX.esc;
const KIND = "receiving.vendor_po_lock_now";
const COPY_ADD = {
  do_label:        "Vendor drop-off",
  do_today:        "arriving today",
  do_group:        "Arriving today",
  do_group_n:      "{n} vendor drop-off(s) today",
  do_not_live:     "The receiving poster is not live for this vendor yet — receive it in the Finale app.",
  do_not_ready:    "Not ready to receive",
  do_not_ready_why:"This drop-off is still a draft in Finale, so nothing can be received on it yet.",
  do_lock_btn:     "Lock now",
  do_lock_ask:     "Ask purchasing to lock it (the lock button is not switched on yet).",
  do_st_posting:   "Sending the request…",
  do_st_waiting:   "Waiting for the office computer…",
  do_st_retrying:  "It is being changed right now — trying again…",
  do_st_running:   "Locking it in Finale…",
  do_ok:           "Locked — ready to receive. Refreshing the list…",
  do_bad_post:     "Could not send the request ({why}). Nothing changed.",
  do_bad_pickup:   "The office computer did not pick this up within a minute. Nothing changed yet.",
  do_bad_total:    "No answer in time. It may still lock by itself — refresh the list in a minute.",
  do_bad_person:   "A person needs to look: {why}",
  do_again:        "Try again",
};
for(const k of Object.keys(COPY_ADD)) if(!(k in RX.COPY)) RX.COPY[k] = COPY_ADD[k];
const DEF = {LOCKNOW_INSTALLED: false, LOCK_POLL_MS: 3000, LOCK_PICKUP_MS: 60000, LOCK_TOTAL_MS: 240000};
for(const k of Object.keys(DEF)) if(!(k in CFG)) CFG[k] = DEF[k];

const D = { locks: {} };          // order id -> {phase, gen, rowId, postedAt, pickedUp, msg, tone}
RX.dropoffs = D;
D.state = D;

const vendors = () => ((RX.pack.data || {}).vendors) || {};
D.vendorOf = (po) => { const v = vendors()[po && po.vendor]; return v && v.kind === "dropoff" ? v : null; };
D.isDropoff = (po) => !!(po && (po.dropoff || String(po.vendor || "").startsWith("dropoff:")));
D.modeKeyForPo = function(poId){
  const d = RX.pack.data; if(!d || !poId) return null;
  const po = (d.pos || []).find(p => String(p.order_id) === String(poId));
  return po && D.isDropoff(po) ? String(po.vendor) : null;
};
D.posterLive = (vk) => { const ps = RX.poster; const m = ps && ps.data && ps.data.modes && ps.data.modes[vk]; return m === "live"; };
const isToday = (eta) => !!eta && String(eta).slice(0, 10) === RX.today();

D.poLabel = function(po){
  if(!D.isDropoff(po)) return "";
  const v = D.vendorOf(po) || {}, x = po.dropoff || {};
  const bits = [t("do_label"), x.vendor_name || v.name || x.owner || "", x.arrival_time || "", isToday(po.eta) ? t("do_today") : ""].filter(Boolean);
  let h = `<div class="hint rx-dropoff" data-dropoff="${esc(po.order_id)}"><strong>${esc(bits.join(" · "))}</strong></div>`;
  if(!D.posterLive(po.vendor)) h += `<div class="rx-note rx-amber" data-dropoff-notlive="${esc(po.order_id)}">${esc(t("do_not_live"))}</div>`;
  return h;
};

const enabled = () => { if(CFG.LOCKNOW_INSTALLED === true) return true; try{ return localStorage.getItem("rx_locknow_on") === "1"; }catch(_){ return false; } };
D.enabled = enabled;
const open = (L) => !!L && ["posting", "waiting", "retrying", "running"].includes(L.phase);

function lockHtml(nr){
  const id = String(nr.order_id), L = D.locks[id];
  const who = [nr.vendor_name || nr.owner || "", nr.arrival_time || ""].filter(Boolean).join(" · ");
  const lines = (nr.lines || []).map(l => `${esc((RX.pack.skuInfo(l.sku) || {}).name || l.sku)} ×${esc(l.qty_units == null ? "?" : l.qty_units)}`).join(", ");
  let h = `<div class="rx-line rx-notready" data-notready="${esc(id)}"><div><strong>${esc(t("do_not_ready"))}</strong> · PO ${esc(id)}${who ? " · " + esc(who) : ""}</div>
    <div class="hint">${esc(t("do_not_ready_why"))}${lines ? " " + lines : ""}</div>`;
  if(open(L)){
    const words = {posting: t("do_st_posting"), waiting: t("do_st_waiting"), retrying: t("do_st_retrying"), running: t("do_st_running")}[L.phase];
    const step = {posting: 1, waiting: 2, retrying: 2, running: 3}[L.phase];
    h += `<div class="rx-note" role="status" data-lock-status="${esc(id)}">${esc(words)} <span class="rx-tick" aria-hidden="true" data-from="${L.postedAt}">${RX.clock(RX.now() - L.postedAt)}</span>
      <div class="rx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="3" aria-valuenow="${step}"><span style="width:${Math.round(step / 3 * 100)}%"></span></div></div>`;
  }else if(L && L.phase === "done"){
    h += `<div class="rx-note rx-green" role="status" data-lock-status="${esc(id)}">${esc(L.msg)}</div>`;
  }else{
    if(L && L.phase === "bad") h += `<div class="rx-note rx-red" role="alert" data-lock-status="${esc(id)}">${esc(L.msg)}</div>`;
    if(L && L.phase === "bad" && !L.again) return h + `</div>`;        // a person decides: pressing again would only ask the same question
    h += enabled()
      ? `<button type="button" class="rx-btn primary" data-act="dropoff-lock" data-po="${esc(id)}">${esc(L && L.phase === "bad" && L.again ? t("do_again") : t("do_lock_btn"))}</button>`
      : `<div class="hint" data-lock-ask="${esc(id)}">${esc(t("do_lock_ask"))}</div>`;
  }
  return h + `</div>`;
}

D.sectionHtml = function(){
  const d = RX.pack.data; if(!d) return "";
  const today = (d.pos || []).filter(p => D.isDropoff(p) && isToday(p.eta));
  const nr = (d.not_ready || []).filter(x => x && x.order_id);
  if(!today.length && !nr.length) return "";
  let h = `<div class="rx-pohead rx-dropoffs" data-sec="dropoffs"><strong>${esc(t("do_group"))}</strong> · ${esc(t("do_group_n", {n: today.length + nr.length}))}</div>`;
  for(const p of today) h += `<div class="hint" data-dropoff-today="${esc(p.order_id)}">PO ${esc(p.order_id)} · ${esc(((p.dropoff || {}).vendor_name) || "")}${(p.dropoff || {}).arrival_time ? " · " + esc(p.dropoff.arrival_time) : ""}</div>`;
  for(const x of nr) h += lockHtml(x);
  return h;
};

/* ───────── press → one job row → watch it ───────── */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const redraw = () => { RX.call("drawer", "refresh"); RX.refresh(); };
function end(id, phase, msg, o){ const L = D.locks[id]; if(!L) return; L.gen++; L.phase = phase; L.msg = msg; Object.assign(L, o || {}); redraw(); }
function parseResult(msg){
  const lines = String(msg || "").split("\n");
  for(let i = lines.length - 1; i >= 0; i--){
    const l = lines[i].trim();
    if(l.startsWith("RESULT ")){ try{ const j = JSON.parse(l.slice(7)); if(j && typeof j === "object") return j; }catch(_){} return null; }
  }
  return null;
}
function limits(id){
  const L = D.locks[id]; if(!open(L)) return false;
  const el = RX.now() - L.postedAt;
  if(el >= CFG.LOCK_TOTAL_MS){ end(id, "bad", t("do_bad_total"), {again: true}); return true; }
  if(!L.pickedUp && el >= CFG.LOCK_PICKUP_MS){ end(id, "bad", t("do_bad_pickup"), {again: true}); return true; }
  return false;
}
async function press(id){
  if(!enabled() || open(D.locks[id]) || typeof window.RXPhoto === "undefined") return;
  const L = D.locks[id] = {phase: "posting", gen: (D.locks[id] ? D.locks[id].gen : 0) + 1, rowId: null, postedAt: RX.now(), pickedUp: false, msg: ""};
  const gen = L.gen;                                       // ⛔ set synchronously: a second tap before the repaint does nothing
  redraw();
  try{
    const fields = {Title: KIND + ":" + id, Kind: KIND, Subject: id, Params: JSON.stringify({order_id: id}), State: "queued", Attempts: 0,
                    RequestedUtc: new Date(L.postedAt).toISOString().slice(0, 19) + "Z", RequestedBy: (typeof account === "string" && account) || ""};
    L.rowId = await window.RXPhoto.jobs.enqueue(fields);
  }catch(e){
    if(gen !== L.gen) return;
    return end(id, "bad", t("do_bad_post", {why: String((e && e.message) || e).slice(0, 120)}), {again: true});
  }
  if(gen !== L.gen) return;
  L.phase = "waiting"; redraw();
  while(gen === L.gen){
    await sleep(CFG.LOCK_POLL_MS);
    if(gen !== L.gen || limits(id)) return;
    let row;
    try{ row = await window.RXPhoto.jobs.poll(L.rowId); }
    catch(e){ if(gen !== L.gen) return; if(limits(id)) return; continue; }      // a dropped read: keep watching until a limit ends it
    if(gen !== L.gen) return;
    const st = String(row.state || ""), res = parseResult(row.message);
    if(st === "running" || st === "claimed"){ L.pickedUp = true; if(L.phase !== (st === "running" ? "running" : "waiting")){ L.phase = st === "running" ? "running" : "waiting"; redraw(); } }
    else if(st === "queued" || st === ""){ if(row.attempts >= 1){ L.pickedUp = true; if(L.phase !== "retrying"){ L.phase = "retrying"; redraw(); } } }
    else if(st === "done"){
      end(id, "done", t("do_ok"));
      try{ RX.pack.load({force: true}); }catch(_){}
      return;
    }else{
      return end(id, "bad", t("do_bad_person", {why: String((res && res.message) || row.message || st).slice(0, 200)}), {again: false});
    }
    if(limits(id)) return;
  }
}
D.press = press;
RX.registerAct("dropoff-lock", ({el}) => { const id = el && el.dataset.po; if(id) press(id); });
RX.on("tick", () => { for(const id of Object.keys(D.locks)) limits(id); });
})();
