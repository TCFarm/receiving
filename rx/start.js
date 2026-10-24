/* receiving/rx/start.js — the start card, the status strip, banners, the header flow button and menu, the flash
   card and the toast. OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   ═══ WHAT THE CREW SEES (MASTER-PLAN §9.1 — M10: the crew is never slowed) ═══
   • SHADOW (the Tuesday rollout): the default is TODAY'S flow — "Best-by only" — no shelf step, no skip button,
     nothing extra per case. The start card shows today's delivery and ONE toggle, "Practice: also scan the shelf
     tag" (session-only, resets at midnight, `rx_practice_v1`). Turning it on offers the tiles Best-by only /
     Put away here / Sort first for one volunteer. ⛔ There is NO per-item Skip (the shelf-step's own
     "Skip — I'll use the Finale app" is WP4b's and appears only if its step registers one).
   • LIVE (round 3, Jack 2026-10-19 — "go live for everyone"): two tiles, Put away here (PRE-SELECTED — RX.flow() defaults to it) /
     Sort first, plus a small secondary link "Best-by only (no shelf scan)" as the fallback. No practice toggle, no practice
     banner, no "Nothing is posted to Finale" copy. The staged list auto-opens when staged items exist and nobody has chosen.
   • OFF: nothing here renders and the page is exactly what it was before the upgrade.
   ⛔ A tile is offered only if its flow's LAST step is registered (RX.flowAvailable) — so shipping this file without
   WP4b's flows shows no tiles and no toggle instead of a button that does nothing.

   Loading follows _shared/APP-PROGRESS-STATUS.md: named step, moving progress bar (role=progressbar), a live clock
   (aria-hidden — the step text is the aria-live part), and every wait ends in plain words with Try again.

   API (RX.ui): refresh() toast(msg) chipHtml(chip,row) flashPut(row,recs) flashText(text,row) renderStart()
                renderStrip() renderBanner() */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const U = RX.ui, t = RX.t, esc = RX.esc;
/* ⭐ 2026-10-23 (Jack: "delayed 8:19 - this will now just say 8 min"): the poster's age on the strip is whole minutes — "8:19" read as a
   time of day. Spinners keep RX.ago's seconds clock (a wait shows a moving clock, _shared/APP-PROGRESS-STATUS.md). */
RX.agoMin = (ms) => { const m = Math.max(0, Math.floor((+ms || 0) / 60000)); return m < 1 ? "<1 min" : m < 120 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; };
const $ = (id) => document.getElementById(id);
const pageAudit = () => { try{ return isAudit(); }catch(_){ return false; } };
const pageRows = () => { try{ return rows; }catch(_){ return []; } };
const pend = () => { try{ return pending; }catch(_){ return null; } };
const flowLabel = (f) => ({bestby: RX.mode() === "live" ? t("link_bestby_live") : t("tile_bestby"), direct:t("tile_direct"), sort:t("tile_sort"), staged:"Staged items"}[f] || f);

/* ───────────────────────── chips, flash, toast ───────────────────────── */
U.chipHtml = (c, row) => `<span class="rx-chip rx-${esc(c.tone)}" data-chip-n="${esc(row.n)}"${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.text)}</span>`;
U.flashText = (text, row) => { RX.flash(`<div class="last rx-last" role="status"><div class="nm">${esc(text)}</div></div>`); };
U.flashPut = function(row, recs){
  const rec = recs[0], f = rec.fields;
  const name = esc(row.prod.name);
  const bb = row.best ? (typeof yearFirst === "function" ? yearFirst(row.best) : esc(row.best)) : "no date";
  const total = recs.reduce((a, r) => a + (+r.fields.Units || 0), 0);
  const bins = [...new Set(recs.map(r => r.fields.Location).filter(Boolean))];
  let head;
  if(f.State === "staged") head = esc(t("staged_flash", {area:f.StagedArea || "area", bin:f.RecommendedBin || "—"}));
  else if(bins.length) head = `✓ ${total} × ${name} → ${esc(bins.join(" + "))} · best by ${bb}`;
  else head = `✓ ${total} × ${name} · best by ${bb}`;
  const custom = row.rx && row.rx.fields && row.rx.fields.flash;
  const btns = `<button class="rx-btn" data-act="last-undo">${esc(t("btn_undo"))}</button>` +
    (RX.hasAct("last-split") ? `<button class="rx-btn" data-act="last-split">${esc(t("btn_notallfit"))}</button>` : "");
  RX.flash(`<div class="last rx-last" role="status"><div class="nm">${custom ? esc(custom) : head}</div>
    <div class="meta">${esc(row.upc || "")}${f.Po ? " · PO "+esc(f.Po) : ""}</div><div class="rx-lastbtns">${btns}</div></div>`);
};
RX.registerAct("last-undo", () => {
  const row = RX.state.lastRow; if(!row) return;
  if(row.inflight){ U.toast("That scan is still saving. Try again in a moment."); return; }
  const recs = RX.intents.forRow(row);
  if(recs.some(r => !RX.intents.editable(r))){ U.toast(t("cancel_too_late")); RX.call("drawer", "openRow", row); return; }
  for(const r of recs) RX.intents.cancel(r.iid);
  try{ deleteRow(row); }catch(_){}
  U.flashText(t("undone"), null); RX.sound("decide"); RX.state.lastRow = null; RX.refresh();
});
let toastTimer = null;
U.toast = function(msg){
  let el = $("rxToast");
  if(!el){ el = document.createElement("div"); el.id = "rxToast"; el.className = "rx-toast"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite"); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, RX.CFG.TOAST_MS);
};

/* ───────────────────────── the start card ───────────────────────── */
function progressHtml(){
  const s = RX.pack.state, pct = s.total > 0 ? Math.min(100, Math.round(s.bytes / s.total * 100)) : (s.stage === 2 ? 100 : 0);
  const kb = (x) => Math.round(x / 1024).toLocaleString();
  const detail = s.stage === 1 ? (s.total > 0 ? `${kb(s.bytes)} of ${kb(s.total)} KB` : `${kb(s.bytes)} KB`) : "";
  return `<div class="rx-progress"><div class="rx-step" aria-live="polite">${esc(s.stage === 2 ? t("pack_step2") : t("pack_step1"))}</div>
    <div class="rx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    <div class="rx-detail">${esc(detail)} <span class="rx-tick" aria-hidden="true" data-from="${s.startedAt}">${RX.clock(RX.now() - s.startedAt)}</span></div></div>`;
}
function poCardHtml(){
  const P = RX.pack, s = P.state, d = P.data;
  if(s.status === "loading" && !d) return progressHtml();
  let h = "";
  if(s.status === "loading") h += progressHtml();
  if(!d){
    return h + `<div class="rx-note rx-red" role="alert">${esc(P.message() || t("pack_none"))} <button class="rx-btn" data-act="start-pack-retry">${esc(t("btn_try_again"))}</button></div>`;
  }
  const sum = RX.po.summary();
  const st = P.staleness();
  if(!sum.length){
    h += `<div class="rx-note rx-amber"><strong>${esc(t("po_none_h"))}</strong><div>${esc(t("po_none_b"))}</div></div>`;
  }else if(sum.length === 1){
    const x = sum[0];
    h += `<div class="rx-po"><strong>${esc(t("po_one", {po:x.po.order_id, due:x.due, lines:x.lines, recv:x.done}))}</strong>
      <button class="rx-btn" data-act="start-po-details">${esc(t("btn_details"))}</button></div>`;
  }else{
    h += `<div class="rx-po"><strong>${esc(t("po_many_h", {n:sum.length}))}</strong>
      <button class="rx-btn" data-act="start-po-details">${esc(t("btn_details"))}</button></div>` +
      sum.map(x => `<div class="rx-porow">${esc(t("po_many_row", {po:x.po.order_id, due:x.due, left:x.left}))}</div>`).join("") +
      `<div class="hint">${esc(t("po_many_hint"))}</div>`;
  }
  const when = d.built ? RX.hhmm(d.built) : "";
  const ago = d.built ? RX.ago(RX.now() - Date.parse(d.built)) : "";
  if(st.level === "amber") h += `<div class="rx-sub rx-amber">${esc(P.builtToday(d) ? t("pack_from_ago", {at:when, ago}) : t("pack_not_today", {when: d.built ? new Date(d.built).toLocaleDateString(undefined, {weekday:"short"})+" "+when : "earlier"}))}
    <button class="rx-btn" data-act="start-pack-retry">${esc(t("btn_refresh"))}</button></div>`;
  else h += `<div class="rx-sub">${esc(t("pack_from", {at:when}))}</div>`;
  if(s.status === "cached" || s.status === "none") h += `<div class="rx-note rx-amber" role="status">${esc(P.message())} <button class="rx-btn" data-act="start-pack-retry">${esc(t("btn_try_again"))}</button></div>`;
  return h;
}
function tileHtml(flow, sel){
  const act = {bestby:"start-bestby", direct:"start-direct", sort:"start-sort"}[flow];
  return `<button class="rx-tile${sel ? " on" : ""}" data-act="${act}" aria-pressed="${sel}"><strong>${esc(t("tile_"+flow))}</strong><span>${esc(t("tile_"+flow+"_sub"))}</span></button>`;
}
/* ⭐ UX audit 2026-10-19 — THE COMPACT START CARD. Once work is under way (an item is in progress, a row exists, or the
   staged list is open) and a choice already stands, the card folds to ONE line: how you're receiving + [Change]. Measured
   before: the full card is ~360 px, so on a 1280×800 tablet the qty card's Save and the shelf step sat below the fold —
   a scroll per case in exactly the flow M10 says must not slow down. ⛔ It never folds while the pack is loading or
   amber/red (the warning must stay visible), nor in live before a flow is chosen (the tiles ARE the question).
   [Change] (start-toggle) or the header flow button (hdr-flow) opens it; choosing a tile folds it again. */
const startOpen = () => !!RX.state.startOpen;
function underway(){ return !!pend() || pageRows().length > 0 || RX.flow() === "staged"; }
function packQuiet(){ const s = RX.pack.state; if(s.status === "loading" || s.status === "cached" || s.status === "none") return false;
  try{ return RX.pack.staleness().level === "ok"; }catch(_){ return false; } }
U.startCompact = function(){
  if(!RX.active() || startOpen()) return false;
  const mode = RX.mode(), flow = RX.flow();
  if(mode === "live" && !flow) return false;
  return underway() && packQuiet() && !!RX.pack.data;
};
U.renderStart = function(){
  const el = $("rxStart"); if(!el) return;
  if(!RX.active()){ el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const mode = RX.mode(), flow = RX.flow(), practice = RX.practice.on();
  if(U.startCompact()){
    el.classList.add("rx-mini");
    const how = mode === "shadow" && !practice ? t("tile_bestby") : flowLabel(flow);
    const h = `<div class="rx-minirow"><span class="rx-grow">${esc(t("start_how"))} <strong>${esc(how)}</strong>${mode === "shadow" ? ` <span class="hint" style="display:inline">· ${esc(practice ? t("mini_practice_on") : t("mini_practice_off"))}</span>` : ""}</span>
      <button class="rx-btn" data-act="start-toggle" aria-expanded="false">${esc(t("btn_change"))}</button></div>`;
    if(el.dataset.h !== h){ el.innerHTML = h; el.dataset.h = h; }
    return;
  }
  el.classList.remove("rx-mini"); delete el.dataset.h;
  let h = `<div class="rx-h">${esc(t("start_h"))}${startOpen() && underway() ? ` <button class="rx-link" data-act="start-toggle" data-close="3" aria-expanded="true" style="float:right;margin-top:-14px;min-height:48px">${esc(t("btn_hide"))}</button>` : ""}</div>` + poCardHtml();
  const avail = ["direct", "sort"].filter(f => RX.flowAvailable(f));
  if(mode === "shadow"){
    if(!avail.length) h += `<div class="hint">${esc(t("shadow_note"))}</div>`;
    else{
      h += `<label class="rx-toggle"><input type="checkbox" data-act="start-practice" ${practice ? "checked" : ""}> <strong>${esc(t("practice_toggle"))}</strong></label>
            <div class="hint">${esc(t("practice_hint"))}</div>`;
      if(practice) h += `<div class="rx-tiles">${tileHtml("bestby", flow === "bestby")}${avail.map(f => tileHtml(f, flow === f)).join("")}</div>`;
    }
  }else if(avail.length){
    /* ⭐ ROUND 3 (Jack, 2026-10-19): LIVE FOR EVERYONE — two tiles, "Put away here" pre-selected (RX.flow() defaults to it), and a
       small secondary link as the fallback. No practice toggle, no practice copy. */
    h += `<div class="rx-h" style="margin-top:12px">${esc(t("start_how"))}</div><div class="rx-tiles">${avail.map(f => tileHtml(f, flow === f)).join("")}</div>
      <div class="rx-aux"><button class="rx-link" data-act="start-bestby" aria-pressed="${flow === "bestby"}">${esc(t("link_bestby_live"))}</button>${flow === "bestby" ? ` <span class="hint" style="display:inline">${esc(t("bestby_live_on"))}</span>` : ""}</div>`;
  }
  h += `<div class="rx-aux">${esc("Counting a shelf?")} <button class="rx-link" data-act="start-audit">${esc(t("audit_link"))}</button>` +
       (RX.CFG.floorcount_url ? ` · <a class="rx-link" data-act="start-floorcount" href="${esc(RX.CFG.floorcount_url)}" target="_blank" rel="noopener">${esc(t("floorcount_link"))}</a>` : "") + `</div>`;
  el.innerHTML = h;
};
RX.registerAct("start-direct", () => { if(RX.setFlow("direct")){ RX.state.startOpen = false; RX.sound("saved"); RX.refresh(); } });
RX.registerAct("start-sort",   () => { if(RX.setFlow("sort")){ RX.state.startOpen = false; RX.sound("saved"); RX.refresh(); } });
RX.registerAct("start-bestby", () => { if(RX.setFlow("bestby")){ RX.state.startOpen = false; RX.refresh(); } });
RX.registerAct("start-toggle", () => { RX.state.startOpen = !RX.state.startOpen; RX.refresh();
  if(RX.state.startOpen){ const s = $("rxStart"); if(s && s.scrollIntoView) s.scrollIntoView({block:"nearest"}); } });
RX.registerAct("start-practice", ({el}) => { RX.practice.set(!!el.checked); });
RX.registerAct("start-audit", () => { try{ chooseMode("audit"); }catch(_){} });
RX.registerAct("start-floorcount", () => {});
RX.registerAct("start-po-details", () => RX.call("drawer", "openPo"));
RX.registerAct("start-pack-retry", () => { RX.pack.load({force:true}); });

/* ───────────────────────── the strip ───────────────────────── */
U.renderStrip = function(){
  const el = $("rxStrip"); if(!el) return;
  if(!RX.active()){ el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const seg = [];
  const sum = RX.pack.data ? RX.po.summary() : [];
  if(sum.length){ const x = sum[0]; seg.push(`<button class="rx-seg" data-act="hdr-po">${esc(t("strip_po", {po:x.po.order_id, done:x.done, total:x.lines}))}${sum.length > 1 ? " +"+(sum.length-1) : ""}</button>`); }
  else seg.push(`<span class="rx-seg">${esc(t("strip_nopo"))}</span>`);
  const mode = RX.mode(), d = RX.poster.data;
  if(mode === "live"){
    const age = RX.intents.posterAgeMs();
    if(RX.intents.posterDelayed()) seg.push(`<button class="rx-seg rx-amber" data-act="banner-poster-details">${esc(t("strip_delayed", {ago:"\u0000"})).replace("\u0000", `<span class="rx-tick" aria-hidden="true" data-fmt="min" data-from="${Date.parse(d.at)}">${RX.agoMin(age)}</span>`)}</button>`);
    else seg.push(`<span class="rx-seg" aria-live="polite">${esc(t("strip_live", {ago:"\u0000"})).replace("\u0000", `<span class="rx-tick" aria-hidden="true" data-fmt="min" data-from="${d ? Date.parse(d.at) : 0}">${d ? RX.agoMin(age) : "—"}</span>`)}</span>`);
  }else seg.push(`<span class="rx-seg">${esc(t("strip_practice"))}</span>`);
  const staged = +RX.counter("staged") || 0;
  if(staged > 0) seg.push(`<button class="rx-seg${RX.state.stagedLate ? " rx-amber" : ""}" data-act="hdr-staged">${esc(t("strip_staged", {n:staged}))}</button>`);
  const ts = RX.intents.unsent ? RX.intents.unsent() : 0;
  if(ts > 0) seg.push(`<span class="rx-seg rx-grey">${esc(t("strip_tablet", {n:ts}))}</span>`);
  const html = seg.join('<span class="rx-sep">·</span>');
  if(el.dataset.h !== html){ el.innerHTML = html; el.dataset.h = html; }
};
RX.registerAct("hdr-po", () => RX.call("drawer", "openPo"));
RX.registerAct("hdr-staged", () => { if(!RX.hasStep("tray")) return; if(RX.setFlow("staged")) RX.refresh(); });
/* ⭐ 2026-10-23 (Eli: "When I click for details on why the finale posting is delayed it just jumps to the scanning section of the page"):
   Details used to fire a 4-second toast, and the page's click-refocus then scrolled to the scan box — so it looked like a jump and said
   nothing. It now opens the explanation IN the banner (what the mini last reported, what is waiting, what to do) and returns "stop" so
   the refocus never runs. A second tap closes it. */
const DET_COPY = {
  pdet_last:    "The Mac mini that sends scans to Finale last reported {ago} ago (it normally reports every 6–7 minutes, at most about 9 when it is posting; this shows after 12).",
  pdet_wait:    "Waiting to go into Finale: {n} scan(s){oldest}.",
  pdet_oldest:  ", oldest {ago}",
  pdet_none:    "Nothing was waiting at that report — every scan it had seen was in Finale.",
  pdet_last_post:"Last scan put into Finale: {ago} ago.",
  pdet_finale:  "Finale is not answering the mini right now.",
  pdet_budget:  "The mini is pausing to stay under Finale's hourly limit — it catches up on its own.",
  pdet_tablet:  "This tablet still holds {n} scan(s) it has not sent — keep this page open with signal.",
  pdet_do:      "Your scans are saved. Keep scanning. If this stays over 30 minutes, tell the buyer.",
  btn_hide:     "Hide",
};
for(const k of Object.keys(DET_COPY)) if(!(k in RX.COPY)) RX.COPY[k] = DET_COPY[k];
RX.state.posterDet = false;
function posterDetHtml(){
  const mins = (ms) => RX.agoMin(ms).replace("<1 min", "under a minute");
  const d = RX.poster.data || {}, age = RX.intents.posterAgeMs(), ago = (iso) => { const m = Date.parse(iso); return isNaN(m) ? "?" : mins(RX.now() - m); };
  const L = [t("pdet_last", {ago: age == null ? "a while" : mins(age)})];
  const n = +d.open_ready || 0;
  L.push(n > 0 ? t("pdet_wait", {n:String(n), oldest: d.oldest_ready_age_s != null ? t("pdet_oldest", {ago: mins((+d.oldest_ready_age_s || 0) * 1000)}) : ""}) : t("pdet_none"));
  if(d.last_post_at) L.push(t("pdet_last_post", {ago: ago(d.last_post_at)}));
  if(d.finale_ok === false) L.push(t("pdet_finale"));
  if(d.finale_budget && d.finale_budget.waiting) L.push(t("pdet_budget"));
  const ts = RX.intents.unsent ? RX.intents.unsent() : 0; if(ts > 0) L.push(t("pdet_tablet", {n:String(ts)}));
  L.push(t("pdet_do"));
  return `<div class="hint rx-pdet" role="status">${L.map(x => `<div>${esc(x)}</div>`).join("")}</div>`;
}
RX.registerAct("banner-poster-details", () => { RX.state.posterDet = !RX.state.posterDet; RX.refresh(); return "stop"; });
RX.registerAct("banner-pack-retry", () => { RX.pack.load({force:true}); });

/* ───────────────────────── banners (one at a time, highest priority first) ───────────────────────── */
U.renderBanner = function(){
  const el = $("rxBanner"); if(!el) return;
  let h = "";
  if(RX.active()){
    let blocked = false;
    try{ blocked = !!needsSignIn || (catalogState && catalogState.src === "none"); }catch(_){}
    if(!blocked){
      if(RX.intents.denied()) h = `<div class="banner rx-banner" role="alert" style="border-left-color:var(--stop)"><strong>${esc(t("denied"))}</strong></div>`;
      else if(RX.mode() === "live" && RX.intents.posterDelayed()) h = `<div class="banner rx-banner" role="status" style="border-left-color:var(--wait)"><strong>${esc(t("poster_down"))}</strong>
        <button class="rx-btn" data-act="banner-poster-details" aria-expanded="${RX.state.posterDet ? "true" : "false"}">${esc(t(RX.state.posterDet ? "btn_hide" : "btn_details"))}</button>${RX.state.posterDet ? posterDetHtml() : ""}</div>`;
      else if(RX.mode() === "shadow" && RX.flowActive()) h = `<div class="banner rx-banner" style="border-left-style:dashed">${esc(RX.poster.status === "ok" ? t("practice") : t("practice_quiet"))}</div>`;
    }
  }
  if(el.dataset.h !== h){ el.innerHTML = h; el.dataset.h = h; }
};

/* ───────────────────────── header: flow button + menu ───────────────────────── */
function ensureHeader(){
  const bar = document.querySelector(".bar"); if(!bar) return;
  if(!$("rxFlowBtn")){
    const fb = document.createElement("button"); fb.id = "rxFlowBtn"; fb.className = "rx-btn"; fb.setAttribute("data-act", "hdr-flow"); fb.hidden = true;
    const mb = document.createElement("button"); mb.id = "rxMenuBtn"; mb.className = "rx-btn"; mb.setAttribute("data-act", "hdr-menu");
    mb.setAttribute("aria-label", "Menu"); mb.setAttribute("aria-haspopup", "true"); mb.textContent = "≡"; mb.hidden = true;
    const who = $("who"); bar.insertBefore(fb, who); bar.insertBefore(mb, $("signout"));
    const m = document.createElement("div"); m.id = "rxMenu"; m.className = "rx-menu rx-overlay"; m.hidden = true; m.setAttribute("role", "menu"); document.body.appendChild(m);
  }
}
function renderHeader(){
  ensureHeader();
  const on = RX.active(), fb = $("rxFlowBtn"), mb = $("rxMenuBtn");
  if(!fb) return;
  mb.hidden = !on;
  const showFlow = on && RX.flowActive();
  fb.hidden = !showFlow; if(showFlow) fb.textContent = flowLabel(RX.flow())+" ▾";
  const so = $("signout"); if(so && on && RX.flowActive()) so.style.display = "none";
  else if(so && $("app") && $("app").style.display !== "none") so.style.display = "";
  const m = $("rxMenu"); if(!on) m.hidden = true;
  if(!m.hidden) renderMenu();
}
function renderMenu(){
  const m = $("rxMenu");
  m.innerHTML = `<button class="rx-menuitem" role="menuitem" data-act="menu-sounds">${esc(RX.soundOn() ? t("menu_sounds_on") : t("menu_sounds_off"))}</button>
    <button class="rx-menuitem" role="menuitem" data-act="menu-refresh-pack">${esc(t("menu_refresh"))}</button>
    <button class="rx-menuitem" role="menuitem" data-act="menu-signout">${esc(t("menu_signout"))}</button>
    <button class="rx-menuitem" role="menuitem" data-act="menu-close" data-close="3">${esc(t("menu_close"))}</button>`;
}
RX.registerAct("hdr-flow", () => {
  if(pend()){ U.toast(t("finish_first")); return; }
  RX.state.startOpen = true; RX.refresh();
  const s = $("rxStart"); if(s){ s.classList.add("rx-pulse"); setTimeout(() => s.classList.remove("rx-pulse"), 1500); s.scrollIntoView({block:"nearest"}); }
});
RX.registerAct("hdr-menu", () => { const m = $("rxMenu"); m.hidden = !m.hidden; if(!m.hidden) renderMenu(); return "stop"; });
RX.registerAct("menu-close", () => { $("rxMenu").hidden = true; const sc = $("scan"); if(sc) sc.focus(); return "stop"; });
RX.registerAct("menu-sounds", () => { RX.setSound(!RX.soundOn()); renderMenu(); });
RX.registerAct("menu-refresh-pack", () => { $("rxMenu").hidden = true; RX.pack.load({force:true}); });
RX.registerAct("menu-signout", () => { $("rxMenu").hidden = true; const b = $("signout"); if(b) b.click(); });
document.addEventListener("click", (e) => { const m = $("rxMenu"); if(m && !m.hidden && !e.target.closest("#rxMenu") && !e.target.closest("#rxMenuBtn")) m.hidden = true; }, true);

/* ───────────────────────── labels + layout ───────────────────────── */
function applyLabels(){
  const on = RX.active(), fa = on && RX.flowActive();
  document.body.classList.toggle("rx-on", !!on);
  document.body.classList.toggle("rx", !!fa);
  const sl = $("scanLabel");
  if(sl){
    if(fa && !pend() && !sl.dataset.orig){ sl.dataset.orig = sl.textContent; sl.textContent = t("scan_label_d0"); }
    else if(fa && !pend() && sl.dataset.orig){ sl.textContent = t("scan_label_d0"); }
    else if(sl.dataset.orig && sl.textContent === t("scan_label_d0") && !fa){ sl.textContent = sl.dataset.orig; delete sl.dataset.orig; }
    else if(sl.dataset.orig && pend() && sl.textContent === t("scan_label_d0")){ sl.textContent = sl.dataset.orig; delete sl.dataset.orig; }
  }
  const box = $("scanbox");
  if(box){ const hide = !!(on && RX.pack.data && (RX.pack.data.pos || []).length); box.style.display = hide ? "none" : ""; }
}

U.refresh = function(){
  U.renderStart(); U.renderStrip(); U.renderBanner(); renderHeader(); applyLabels();
  /* ⭐ UX audit 2026-10-19: the page's "N put-aways waiting to send" banner counts RX.unsentCount() but was only
     re-rendered by the page's own save path, so it kept saying "waiting … do not clear the browser data" after the
     intent had gone out. Every RX refresh (incl. the end of each flush) re-renders it. */
  try{ if(typeof renderPending === "function") renderPending(); }catch(_){}
};

/* ───────────────────────── the 1 s ticker: clocks only (never a full re-render) ───────────────────────── */
RX.on("tick", () => {
  if(!RX.state.booted) return;
  const now = RX.now();
  document.querySelectorAll(".rx-tick").forEach(el => { const from = +el.dataset.from; if(from) el.textContent = el.dataset.fmt === "min" ? RX.agoMin(now - from) : RX.ago(now - from); });
  document.querySelectorAll("[data-chip-n]").forEach(el => {
    const row = pageRows().find(r => String(r.n) === el.dataset.chipN);
    if(!row) return;
    const c = RX.intents.chipFor(row); if(!c) return;
    if(el.textContent !== c.text) el.textContent = c.text;
    const cls = "rx-chip rx-" + c.tone; if(el.className !== cls) el.className = cls;
  });
  const s = RX.pack.state; if(s.status === "loading") U.renderStart();
  // a poster that has gone quiet changes the strip + banner without any event
  U.renderStrip(); U.renderBanner();
});
/* fold/unfold the start card in the SAME frame a prompt opens or closes (a 1 s lag would move the card under the user's eyes) */
function refold(){
  const el = $("rxStart"); if(!el) return;
  /* ⭐ UX audit 2026-10-19: switching to the old audit (chooseMode) emits nothing RX hears, so the start card — PO, practice
     toggle, tiles — stayed on screen IN AUDIT MODE. A visibility that disagrees with RX.active() re-renders everything. */
  if(el.hidden === !!RX.active()){ U.refresh(); return; }
  if(!el.hidden && U.startCompact() !== el.classList.contains("rx-mini")) U.renderStart();
}
RX.on("tick", refold);
{ const prev = RX.afterRender; RX.afterRender = function(){ prev.apply(this, arguments); refold(); }; }     // the page's render() (mode switch, rows) folds/shows at once
RX.onBoot(() => { ensureHeader(); U.refresh();
  const pa = $("promptArea"); if(pa && window.MutationObserver) new MutationObserver(refold).observe(pa, {childList:true}); });
for(const e of ["pack","poster","intents","flow","steps","denied"]) RX.on(e, () => RX.refresh());
})();
