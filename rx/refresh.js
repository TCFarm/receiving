/* receiving/rx/refresh.js — "REFRESH FROM FINALE" (PM-3919 package F, page half; 2026-11-11). OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   The button posts ONE job row (kind `receiving.refresh_tablet_data`) and watches it. The contract — the exact row, the poll, the RESULT line, the
   stage words, the limits — is Procurement & Merchandising/routines/job-receiving-refresh-tablet-data.md "Page contract". ⛔ Not invented here.
   Graph: ONE client — rx/photocap.js's (`RXPhoto.jobs.enqueue / poll`). This file makes no Graph call of its own.

   ⭐ EVERY WAIT SHOWS A STAGE, A CLOCK AND ENDS (_shared/APP-PROGRESS-STATUS.md): named step, moving bar (role=progressbar), a live clock (the
   shared `.rx-tick`), 60 s to be picked up and 300 s in all (RX.CFG), each limit ending in plain words + Try again + "the old list stays in use".
   A late answer after a limit changes nothing (generation guard `gen`).
   ⛔ Never blocks scanning: the panel is not modal and nothing here touches #scan.
   ⛔ One press = one job: the control is disabled while a job is open — across a reload too (localStorage `rx_refresh_job_v1`).
   ⛔ The mini is the only place the lists are rebuilt; this page only asks, then re-reads (pack: silent read, then the normal load; catalog:
      not before the result's `pages_ready_utc`). It changes nothing any flow records.
      ⛔ 2026-11-12 review fixes (S1-S8, N1, N5, N6, N10): a reload resumes by polling ONCE before any limit; the catalog read has its own 20 s limit and never
      touches the screen on failure; "Barcodes updated" only when the fetched list is provably newer; the pack is never forced under a case being received
      (it stays queued for the next idle moment); the whole control sits behind RX.CFG.REFRESH_INSTALLED (false until the mini job is installed); a tablet
      clock that is wrong makes the list's age "not known" instead of "just now"; a failed poll is "No signal", never blamed on the mini.
   API: RX.refreshJob = { btnHtml(), menuItemHtml(), ageHtml(opts), ageText(), age(), enabled(), state, _test } */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const CFG = RX.CFG, t = RX.t, esc = RX.esc, P = RX.pack;
const KIND = "receiving.refresh_tablet_data", KEY = "rx_refresh_job_v1";
const $ = (id) => document.getElementById(id);
const R = { gen: 0, busy: false, phase: "idle", rowId: null, postedAt: 0, runningSince: 0, pickedUp: false, retry: "", offNet: false,
            ui: null, doneAt: 0, resumed: false, polled: false, sawRow: false, offSince: 0, offTotal: 0, unavailable: false, srvOff: null, seenPerf: 0 };
RX.refreshJob = R;
R.state = R;

/* ⛔ NEVER OFFER A CONTROL THAT CANNOT WORK (review S7): until the mini job is installed (RX.CFG.REFRESH_INSTALLED) NO Refresh-from-Finale button or menu item is
   drawn; the list-age line and the stale lead still show. rx_refresh_on = "1" turns it on for one test/preview tablet (the READER_INSTALLED pattern). */
const enabled = () => { if(CFG.REFRESH_INSTALLED === true) return true; try{ return localStorage.getItem("rx_refresh_on") === "1"; }catch(_){ return false; } };
R.enabled = enabled;

/* a SERVER time, when the browser lets us read one (the catalog fetch is same-origin; the Graph pack response may hide `Date`) */
RX.noteServerDate = function(h){ const ms = Date.parse(h || ""); if(!isNaN(ms)) R.srvOff = ms - RX.now(); };
const nowTrue = () => RX.now() + (R.srvOff == null ? 0 : R.srvOff);

/* ───────── the age of the delivery list ───────── */
function hm12(ms){ const d = new Date(ms); const h = d.getHours(), m = d.getMinutes(); return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "am" : "pm"); }
function agoWords(ms){
  const m = Math.floor(Math.max(0, ms) / 60000);
  if(m < 1) return t("ago_now");
  if(m < 60) return m + " min ago";
  const h = Math.floor(m / 60);
  return h < 24 ? h + " h ago" : Math.floor(h / 24) + (Math.floor(h / 24) === 1 ? " day ago" : " days ago");
}
/* kind: none (no list) · unknown (no readable `built`) · clock (built is in the FUTURE by the tablet clock: the clock is behind) · future_srv (in the future
   even by a server time) · ok. ⛔ Anything but ok means the age is NOT KNOWN — the stale lead shows (review S8, N5). */
R.age = function(){
  const d = P.data;
  if(!d) return {built: null, ms: null, stale: true, kind: "none"};
  const b = d.built ? Date.parse(d.built) : NaN;
  if(isNaN(b)) return {built: null, ms: null, stale: true, kind: "unknown"};
  const age = nowTrue() - b;
  if(age < -CFG.CLOCK_SKEW_MS) return {built: b, ms: null, stale: true, kind: R.srvOff == null ? "clock" : "future_srv"};
  return {built: b, ms: Math.max(0, age), stale: age > CFG.LIST_STALE_MS, kind: "ok"};
};
R.ageText = function(){
  const a = R.age();
  if(a.kind === "none") return t("list_none");
  if(a.kind === "unknown") return t("list_unknown");
  const day = RX.dayKey(a.built) === RX.dayKey(nowTrue()) ? "" : new Date(a.built).toLocaleDateString(undefined, {weekday: "short"}) + " ";
  const at = day + hm12(a.built);
  if(a.kind === "clock") return t("list_clock_wrong", {at});
  if(a.kind === "future_srv") return t("list_future_srv", {at});
  return t("list_built", {at, ago: agoWords(a.ms)});
};
R.staleLead = () => R.age().stale ? t("list_stale_lead") : "";

/* ───────── is the control usable? ───────── */
function why(){
  if(R.unavailable) return t("rf_why_unavailable");
  if(!(window.RXPhoto && RXPhoto.jobs)) return t("rf_why_missing");
  try{ if(needsSignIn || !(token || (refreshTok && account))) return t("rf_why_signin"); }catch(_){ return t("rf_why_signin"); }
  if(typeof navigator !== "undefined" && navigator.onLine === false) return t("rf_why_offline");
  return "";
}
const open = () => R.busy || (R.phase !== "idle" && R.phase !== "ended");
R.btnHtml = function(cls){
  if(!enabled()) return "";
  const w = why(), op = open();
  const label = op ? t("rf_btn_busy") : t("rf_btn");
  return `<button type="button" class="rx-btn ${cls || ""}" data-act="refresh-finale"${w || op ? " disabled" : ""}${w ? ` title="${esc(w)}"` : ""}>${esc(label)}</button>` +
    (w ? ` <span class="hint rx-rf-why" style="display:inline">${esc(w)}</span>` : "");
};
R.menuItemHtml = function(){
  if(!enabled()) return "";
  const w = why(), op = open();
  return `<button class="rx-menuitem" role="menuitem" data-act="refresh-finale"${w || op ? " disabled" : ""}>${esc(op ? t("rf_btn_busy") : t("rf_btn"))}${w ? ` <span class="hint" style="display:inline">· ${esc(w)}</span>` : ""}</button>`;
};
/* the offer next to the age line: the new button when installed, else the OLD plain re-read (it never swaps the list under a case being received) */
const offer = () => enabled() ? R.btnHtml() : `<button type="button" class="rx-btn" data-act="refresh-reread">${esc(t("menu_refresh"))}</button>`;
function ageInner(btn){
  const a = R.age();
  return (a.stale ? `<strong class="rx-stale">${esc(t("list_stale_lead"))}</strong> ` : "") + esc(R.ageText()) + (btn ? " " + offer() : "");
}
/* a live span: the 1 s ticker re-renders it only when its text changes (age minute, stale flip, job opens) */
R.ageHtml = function(opts){
  const btn = !opts || opts.button !== false;
  return `<span class="rx-listage" data-rx-listage="${btn ? 1 : 0}" style="display:block;margin-top:6px">${ageInner(btn)}</span>`;
};
function paintAges(){
  document.querySelectorAll("[data-rx-listage]").forEach(el => {
    const h = ageInner(el.getAttribute("data-rx-listage") === "1");
    if(el.dataset.h !== h){ el.innerHTML = h; el.dataset.h = h; }
  });
}

/* ───────── the panel ───────── */
function ensurePanel(){
  let el = $("rxRefresh"); if(el) return el;
  const strip = $("rxStrip"); if(!strip) return null;
  el = document.createElement("div"); el.id = "rxRefresh"; el.className = "rx-refresh"; el.hidden = true;
  strip.insertAdjacentElement("afterend", el); return el;
}
function pct(){ return {posting: 4, waiting: 8, run1: 25, run2: 50, run3: 75, apply_pack: 88, apply_cat: 94, wait_cat: 92}[R.phase] || 5; }
function stage(){
  const s = (n, k) => t("rf_step", {n, what: t(k)});
  if(R.offNet && (R.phase === "waiting" || /^run\d$/.test(R.phase))) return t("rf_nosignal");     // review N1: a failed read is the TABLET's signal, never blamed on the mini
  switch(R.phase){
    case "posting": return t("rf_posting");
    case "waiting": return R.retry ? t("rf_retrying", {why: R.retry}) : t("rf_wait_pickup");
    case "run1": return s(1, "rf_run1");
    case "run2": return s(2, "rf_run2");
    case "run3": return s(3, "rf_run3");
    case "apply_pack": return s(4, "rf_apply_pack");
    case "wait_cat": return s(4, "rf_wait_cat");
    case "apply_cat": return s(4, "rf_apply_cat");
  }
  return "";
}
function render(){
  const el = ensurePanel(); if(!el) return;
  if(R.phase === "idle" || !RX.active()){ el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  if(R.phase === "ended"){
    const e = R.end || {};
    el.className = "rx-refresh rx-rf-" + (e.tone || "ok");
    el.innerHTML = `<div class="rx-rf-msg" role="${e.tone === "ok" ? "status" : "alert"}">${e.lines.map(l => `<div>${esc(l)}</div>`).join("")}</div>
      ${e.details ? `<details class="rx-rf-det"><summary>${esc(t("rf_details"))}</summary><div class="hint">${esc(e.details)}</div></details>` : ""}
      <div class="rx-rf-btns">${e.again ? R.btnHtml("primary").replace(">" + esc(t("rf_btn")) + "<", ">" + esc(t("rf_try_again")) + "<") : ""}${e.reload ? `<button type="button" class="rx-btn" data-act="refresh-reload">${esc(t("rf_reload_pack"))}</button>` : ""}<button type="button" class="rx-btn" data-act="refresh-dismiss">${esc(t("rf_ok"))}</button></div>`;
    return;
  }
  const p = pct();
  el.className = "rx-refresh";
  el.innerHTML = `<div class="rx-progress"><div class="rx-step" id="rxRfStage" aria-live="polite">${esc(stage())}</div>
    <div class="rx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><span style="width:${p}%"></span></div>
    <div class="rx-detail"><span class="rx-tick" aria-hidden="true" data-from="${R.postedAt}">${RX.clock(RX.now() - R.postedAt)}</span> ${esc(t("rf_scanning"))}</div></div>`;
}
function setPhase(ph){ if(R.phase !== ph){ R.phase = ph; render(); RX.refresh(); } }
function save(){ RX.store.set(KEY, {rowId: R.rowId, postedAt: R.postedAt}); }
function end(tone, lines, o){
  R.gen++; R.busy = false; R.rowId = null; R.offNet = false; R.offSince = 0;
  if(!(o && o.keep)) RX.store.del(KEY);              // keep: a sign-in problem must not forget the row — after sign-in a reload resumes it
  R.phase = "ended"; R.doneAt = RX.now();
  R.end = Object.assign({tone, lines: [].concat(lines)}, o || {});
  render(); RX.refresh();
}
const stays = () => t("rf_old_stays");

/* ───────── press ───────── */
async function press(){
  if(!enabled() || open() || why()) return;
  R.busy = true;                                   // ⛔ synchronous: a second tap before the repaint does nothing
  const gen = ++R.gen;
  R.retry = ""; R.pickedUp = false; R.runningSince = 0; R.end = null; R.postedAt = RX.now();
  R.resumed = false; R.polled = false; R.sawRow = false; R.offNet = false; R.offSince = 0; R.offTotal = 0;
  setPhase("posting"); render();
  let rowId;
  try{
    const fields = {Title: KIND + ":tablet", Kind: KIND, Subject: "tablet", Params: "{}", State: "queued", Attempts: 0,
                    RequestedUtc: new Date(R.postedAt).toISOString().slice(0, 19) + "Z", RequestedBy: (typeof account === "string" && account) || ""};
    rowId = await RXPhoto.jobs.enqueue(fields);
  }catch(e){
    if(gen !== R.gen) return;
    return end("bad", t("rf_post_failed", {why: String((e && e.message) || e).slice(0, 120), stays: stays()}), {again: true});
  }
  if(gen !== R.gen) return;
  R.rowId = rowId; save(); R.phase = "waiting"; render(); RX.refresh();
  watch(gen);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function parseResult(msg){
  const lines = String(msg || "").split("\n");
  for(let i = lines.length - 1; i >= 0; i--){
    const l = lines[i].trim();
    if(l.startsWith("RESULT ")){ try{ const j = JSON.parse(l.slice(7)); if(j && typeof j === "object") return j; }catch(_){} return null; }
  }
  return null;
}
/* limits — checked on every tick AND after every poll, so a hung read cannot hold the screen.
   ⛔ Review S1: after a RELOAD nothing is judged until the first poll has been tried (the row may be long running or finished). ⛔ Review N1: the PICKUP limit
   counts only time a read SUCCEEDED and showed the row still waiting — time spent without signal is not the mini's fault. */
const offMs = () => R.offTotal + (R.offSince ? RX.now() - R.offSince : 0);
function limits(){
  if(R.phase !== "waiting" && !/^run\d$/.test(R.phase) && R.phase !== "posting") return false;
  if(R.resumed && !R.polled) return false;
  const el = RX.now() - R.postedAt;
  if(el >= CFG.REFRESH_TOTAL_MS){ end("bad", t("rf_lim_total", {stays: stays()}), {again: true}); return true; }
  if(!R.pickedUp && R.phase === "waiting" && R.sawRow && el - offMs() >= CFG.REFRESH_PICKUP_MS){ end("bad", t("rf_lim_pickup", {stays: stays()}), {again: true}); return true; }
  return false;
}
const netUp = () => { if(R.offSince){ R.offTotal += RX.now() - R.offSince; R.offSince = 0; } if(R.offNet){ R.offNet = false; render(); } };
const netDown = () => { if(!R.offSince) R.offSince = RX.now(); if(!R.offNet){ R.offNet = true; render(); } };
/* one read of the row; a 401 forces ONE token refresh and one retry (an access token can be revoked early) */
async function pollOnce(){
  try{ return await RXPhoto.jobs.poll(R.rowId); }
  catch(e){
    if(e && e.status === 401){ try{ tokenExp = 0; }catch(_){} return await RXPhoto.jobs.poll(R.rowId); }
    throw e;
  }
}
const isAuth = (e) => !!(e && (e.auth || e.status === 401));
async function watch(gen){
  let now = R.resumed;                              // a resumed watch reads the row FIRST, before sleeping or judging any limit
  while(gen === R.gen){
    if(!now) await sleep(CFG.REFRESH_POLL_MS);
    now = false;
    if(gen !== R.gen || limits()) return;
    let row;
    try{ row = await pollOnce(); netUp(); }
    catch(e){
      if(gen !== R.gen) return;
      R.polled = true;
      if(e && e.status === 404) return end("bad", t("rf_failed", {stays: stays()}), {again: true, details: "the job row was not found"});
      if(isAuth(e)){ try{ flagSignIn(); }catch(_){} return end("bad", t("rf_why_signin"), {again: false, keep: true}); }
      if(e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) return end("bad", t("rf_failed", {stays: stays()}), {again: true, details: String(e.message || e).slice(0, 200)});
      netDown(); if(limits()) return; continue;      // a dropped read: keep watching until a limit ends it
    }
    if(gen !== R.gen) return;
    R.polled = true; R.sawRow = true;
    const res = parseResult(row.message);
    if(row.state === "running"){
      R.pickedUp = true;
      if(!R.runningSince) R.runningSince = RX.now();
      const el = RX.now() - R.runningSince, st = CFG.REFRESH_STAGE_MS;
      setPhase(el < st[0] ? "run1" : el < st[1] ? "run2" : "run3");
    }else if(row.state === "queued" || row.state === "claimed" || row.state === ""){
      if(row.state === "claimed") R.pickedUp = true;
      if(row.state === "queued" && row.attempts >= 1 && res){ R.pickedUp = true; R.retry = String(res.message || "").slice(0, 100); }
      setPhase("waiting");
    }else{
      return finish(gen, row, res);                  // a final row WINS over any limit: never lose the real result
    }
    if(limits()) return;
  }
}

/* ───────── the row is final ───────── */
async function finish(gen, row, res){
  R.seenPerf = (typeof performance !== "undefined" ? performance.now() : 0);
  if(row.state === "refused"){                       // review S7: the mini has no such job yet — said honestly, with NO Try again, and the control stays off for the session
    R.unavailable = true;
    return end("bad", t("rf_refused"), {again: false, details: String(row.message || row.state).slice(0, 400)});
  }
  if(!res){
    return end("bad", t("rf_failed", {stays: stays()}), {again: true, details: String(row.message || row.state).slice(0, 400)});
  }
  const det = String(res.message || "").slice(0, 400);
  if(res.state === "switched_off") return end("warn", t("rf_off", {stays: stays()}), {details: det});
  if(res.state === "busy"){
    /* review N10: another tablet's refresh may have JUST produced a newer list — read the published one once */
    const found = await rereadOnce(gen);
    if(gen !== R.gen) return;
    const lines = [t("rf_busy")];
    if(found) lines.push(t(found.applied ? "rf_pack_found" : "rf_pack_found_queued", {at: hm12(found.at)}));
    return end("warn", lines, {again: true, details: det});
  }
  /* PM-4032 review (2026-11-17): the mini emails the office ONCE per problem; a later press says so, so nobody keeps pressing */
  const known = Array.isArray(res.already_reported) && res.already_reported.length > 0;
  /* review 2026-11-17 #6: say WHEN the office was told, so an old problem is not read as "all handled" */
  const knownAt = () => { const ts = Object.values(res.incident_since || {}).map(x => Date.parse(x)).filter(x => !isNaN(x));
    return ts.length ? hm12(Math.min(...ts)) : "?"; };
  if(res.state === "failed" || (res.state !== "done" && res.state !== "partial")){
    const fl = [String(res.message || t("rf_failed", {stays: ""})).trim(), stays()];
    if(known) fl.push(t("rf_known", {at: knownAt()}));
    return end("bad", fl, {again: true, details: det});
  }
  const pk = res.pack || {}, ct = res.catalog || {};
  const lines = []; let reload = false, bad = res.state === "partial";
  /* ── the delivery list ── */
  if((pk.status === "built" || pk.status === "fresh") && pk.built_utc){
    const target = Date.parse(pk.built_utc);
    setPhase("apply_pack");
    const r = await getNewPack(gen, target);
    if(gen !== R.gen) return;
    if(r === "ok") lines.push(t(pk.status === "built" ? "rf_pack_built" : "rf_pack_fresh", {at: hm12(Math.max(target, pbuilt()))}));
    else if(r === "queued") lines.push(t("rf_pack_queued"));         // review S6: ready, and applied by the page at the next idle moment
    else{ lines.push(t("rf_pack_late", {stays: stays()})); reload = true; R.reloadTarget = target; R.reloadStatus = pk.status; bad = true; }
  }else lines.push(half(pk, "rf_pack_old"));
  /* ── the barcodes ── */
  if(ct.status === "published" || ct.status === "unchanged" || ct.status === "fresh"){
    const r = await getNewCatalog(gen, res, ct);
    if(gen !== R.gen) return;
    if(r === "updated") lines.push(t("rf_cat_new"));
    else if(r === "reloaded") lines.push(t("rf_cat_reloaded"));
    else if(r === "same") lines.push(t("rf_cat_same"));
    else if(r === "late"){ lines.push(t("rf_cat_late")); bad = true; reload = true; }
    else{ lines.push(t("rf_cat_notloaded", {stays: stays()})); bad = true; }
  }else lines.push(half(ct, "rf_cat_old"));
  if(res.state === "partial") lines.unshift(t("rf_partial"));
  if(known) lines.push(t("rf_known", {at: knownAt()}));
  const goodHalf = (s) => ["built", "fresh", "published", "unchanged"].includes(s);
  const tone = goodHalf(pk.status) && goodHalf(ct.status) && !bad ? "ok" : (goodHalf(pk.status) || goodHalf(ct.status) ? "warn" : "bad");
  end(tone, lines, {again: tone !== "ok", reload, details: det});
}
function half(h, key){
  const after = h.after_utc ? Date.parse(h.after_utc) : NaN;
  const words = String(h.words || h.status || "").trim();
  if((h.status === "budget" || h.status === "held_back") && !isNaN(after)){
    if(/try again after/i.test(words)) return words;      // review S4: the handler's words already carry the time — never say it twice, in two clock formats
    return words + " " + t("rf_pack_after", {at: hm12(after)});
  }
  return t(key, {words});
}
const pbuilt = () => { const d = P.data; return d && d.built ? Date.parse(d.built) : 0; };
const queuedBuilt = () => { const q = P.queued && P.queued.data; const ms = q && q.built ? Date.parse(q.built) : 0; return isNaN(ms) ? 0 : ms; };
/* review N10: ONE silent read of the published list; a newer one is applied at once when the tablet is idle, else left queued for the idle tick */
async function rereadOnce(gen){
  const before = pbuilt();
  try{ await P.load({silent: true}); }catch(_){}
  if(gen !== R.gen) return null;
  const q = queuedBuilt();
  if(q > before) return {at: q, applied: P.applyQueued()};
  return null;
}
/* the pack: OneDrive has to upload it first. Silent read every 10 s up to 120 s. ⛔ Review S6: NEVER forced — a list swapped under a case being received
   changes the PO line, the shelf and the verdict mid-card. A newer list is applied through P.applyQueued (idle moments only); mid-card it stays queued
   and the page's own tick applies it when the case is finished. ⛔ Review N10: the first read happens even when the list in memory already looks
   current — another tablet's refresh may have produced a newer one. Returns "ok" | "queued" | "late" | "gone". */
async function getNewPack(gen, target){
  const t0 = RX.now(); let first = true;
  for(;;){
    if(!first && pbuilt() >= target) return "ok";
    first = false;
    try{ await P.load({silent: true}); }catch(_){}
    if(gen !== R.gen) return "gone";
    const q = queuedBuilt();
    if(q > pbuilt()){
      if(P.applyQueued()){ if(pbuilt() >= target) return "ok"; }
      else if(q >= target) return "queued";
    }
    if(pbuilt() >= target) return "ok";
    if(RX.now() - t0 >= CFG.REFRESH_PACK_WAIT_MS) return "late";
    await sleep(CFG.REFRESH_PACK_TRY_MS);
    if(gen !== R.gen) return "gone";
  }
}
/* "provably newer": both fetches carry a parseable Last-Modified and the new one is later. Equal and unchanged = provably NOT newer. Anything else = unknown. */
function cmpStamp(a, b){
  if(!a || !b) return "unknown";
  const la = Date.parse(a.lm), lb = Date.parse(b.lm);
  if(!isNaN(la) && !isNaN(lb)){
    if(lb > la) return "newer";
    return lb === la && a.len === b.len && (!a.etag || !b.etag || a.etag === b.etag) ? "same" : "unknown";
  }
  return a.etag && b.etag && a.etag === b.etag && a.len === b.len ? "same" : "unknown";
}
/* The barcodes. Returns "updated" | "reloaded" | "same" | "late" | "fail" | "gone".
   ⛔ Review S3: the wait is a DURATION from the mini's own two times (finished_utc → pages_ready_utc), counted on a clock the tablet cannot skew, minus the
   time already spent here — never an absolute time compared with the TABLET clock. ⛔ "updated" is said only when the fetched list is provably newer than
   the one in memory; else "reloaded" (and a provably unchanged one after a publish = "late"). ⛔ Review S2/S5: ONE read of its own with a 20 s limit; on
   failure the old list and the screen are exactly as they were. */
async function getNewCatalog(gen, res, ct){
  const fin = Date.parse(res.finished_utc), rdy = Date.parse(ct.pages_ready_utc);
  let dur = 0;
  if(ct.status === "published") dur = (isNaN(fin) || isNaN(rdy)) ? CFG.REFRESH_CAT_FALLBACK_MS : Math.max(0, rdy - fin);
  const late = dur > CFG.REFRESH_CAT_WAIT_MS;
  const perf = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const wait = Math.min(dur, CFG.REFRESH_CAT_WAIT_MS) - (perf() - R.seenPerf);
  if(wait > 0){
    setPhase("wait_cat");
    const p0 = perf();
    while(perf() - p0 < wait){ await sleep(250); if(gen !== R.gen) return "gone"; }
  }
  setPhase("apply_cat");
  if(typeof fetchCatalogOnce !== "function" || typeof adoptCatalog !== "function") return "fail";
  let got, old = null;
  try{ got = await fetchCatalogOnce(CFG.REFRESH_CAT_FETCH_MS); }catch(_){ got = null; }
  if(gen !== R.gen) return "gone";
  if(!got) return "fail";
  try{ old = catalogStamp; }catch(_){}
  try{ adoptCatalog(got); }catch(_){ return "fail"; }
  if(ct.status !== "published") return "same";
  const c = cmpStamp(old, got.stamp);
  if(c === "newer") return "updated";
  if(c === "same" || late) return "late";
  return "reloaded";
}

/* ───────── acts ───────── */
RX.registerAct("refresh-finale", () => { const m = $("rxMenu"); if(m) m.hidden = true; press(); return "stop"; });
RX.registerAct("refresh-dismiss", () => { R.phase = "idle"; R.end = null; render(); RX.refresh(); return "stop"; });
/* the old plain re-read, as the fallback the panel offers when the new list has not reached this tablet yet */
RX.registerAct("refresh-reload", async () => {
  try{ P.queued = null; await P.load({force: true}); }catch(_){}
  if(R.reloadTarget && pbuilt() >= R.reloadTarget && R.end){
    R.end.lines = [t(R.reloadStatus === "built" ? "rf_pack_built" : "rf_pack_fresh", {at: hm12(R.reloadTarget)})];
    R.end.reload = false; R.end.tone = "ok"; R.end.again = false; R.doneAt = RX.now(); render();
  }
  return "stop";
});
/* the plain "Refresh delivery list" offered beside the age line while the new button is switched off. ⛔ Never forced under a case: the read is silent and the
   new list is applied at the next idle moment (immediately when nothing is open). */
RX.registerAct("refresh-reread", async () => {
  const before = pbuilt();
  try{ await P.load({silent: true}); }catch(_){}
  const q = queuedBuilt();
  if(q > before){
    if(!P.applyQueued()) try{ RX.call("ui", "flashText", t("rf_pack_queued"), null); }catch(_){}
  }
  return "stop";
});

/* ───────── ticker + boot ───────── */
RX.on("tick", () => {
  if(!RX.state.booted) return;
  if(R.phase !== "idle") limits();
  if(R.phase === "ended" && R.end && R.end.tone === "ok" && RX.now() - R.doneAt >= CFG.REFRESH_DONE_MS){ R.phase = "idle"; R.end = null; render(); RX.refresh(); }
  paintAges();
  const w = why() + "|" + open(); if(w !== R.lastWhy){ R.lastWhy = w; RX.refresh(); }     // sign-in lost / signal gone / job opened: repaint every button
});
RX.on("pack", () => { setTimeout(paintAges, 0); });
for(const e of ["online", "offline"]) window.addEventListener(e, () => RX.refresh());
RX.onBoot(() => {
  /* a reload mid-job: keep watching the SAME row — never post a second one. ⛔ Review S1: the first thing a resumed watch does is READ the row; no limit
     is judged before that read, and the limits are then judged from the row's real state and the saved start time (the old code set pickedUp = false and
     fired "has not picked this up" before the first poll, then deleted the saved id — losing a result that was perfectly good). */
  if(!enabled()) return;
  const s = RX.store.get(KEY, null);
  if(!s || !s.rowId) return;
  if(RX.now() - (+s.postedAt || 0) >= CFG.REFRESH_RESUME_MAX_MS){ RX.store.del(KEY); return; }
  R.rowId = String(s.rowId); R.postedAt = +s.postedAt; R.phase = "waiting"; R.busy = false; R.pickedUp = false;
  R.resumed = true; R.polled = false; R.sawRow = false; R.offNet = false; R.offSince = 0; R.offTotal = 0;
  const gen = ++R.gen; render(); watch(gen);
});
R._test = { hm12, parseResult, cmpStamp };
})();
