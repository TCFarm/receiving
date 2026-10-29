/* receiving/rx/offline.js — WORK WITHOUT SIGNAL (PM-3372, 2026-10-29). OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).
   Plan: Procurement & Merchandising/plans/2026-10-29-receiving-offline-PLAN.md.

   Why (Jack, 2026-10-29): "can the frozen team do the full receiving app flow offline? … they dont have good internet there" — "it can
   even be a manual 'switch to offline mode' option that forces the download".

   What is here:
     • the service worker (`sw.js`) is registered — on the real site (https) only, so the test harness is unchanged unless a test opts
       in (`localStorage rx_sw_test = "1"`). It keeps the page itself on the tablet: a reload with no signal still opens.
     • [Get ready for offline] (start card + menu): five NAMED steps, each with a progress bar, a live elapsed clock and a time limit
       (APP-PROGRESS-STATUS): sign-in · product list · today's delivery list · save the app · send anything waiting. A failed step
       says what failed in plain words, with Try again. The end card says exactly what the tablet holds.
     • the OFFLINE BANNER: while there is no network (or the page started offline) — "Offline — N scans waiting to send · delivery
       list from 9:41". Scans keep queueing in the outboxes that already exist (rx/intents.js, the page's rows, learnings).
   ⛔ It never forces anything to download on an ordinary load: the button is the only full download (Jack's "manual" option).
   ⛔ Things that need a live answer say so (they are not faked): Put away staged for other tablets' carts, Fix on a scan already in
      Finale, learning a barcode, the over-count across other tablets. */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const O = RX.offline = {};
const t = RX.t, esc = RX.esc;
const READY_KEY = "rx_offline_ready_v1";
const STEP_LIMIT_MS = 90 * 1000;

const COPY_ADD = {
  off_btn:          "Going somewhere without signal? Get ready for offline",
  off_menu:         "Get ready for offline",
  off_title:        "Getting ready to work offline",
  off_s_signin:     "Checking your sign-in",
  off_s_catalog:    "Downloading the product list",
  off_s_pack:       "Downloading today's delivery list",
  off_s_app:        "Saving the app on this tablet",
  off_s_send:       "Sending anything waiting",
  off_step:         "Step {i} of {n}: {what}",
  off_elapsed:      "{s} s so far — gives up at {lim} s",
  off_fail_net:     "There is no signal here. Get ready where the Wi-Fi works, then walk in.",
  off_fail_sp:      "SharePoint answered with a problem: {why}. Try again in a minute; tell the office if it keeps happening.",
  off_fail_pack_old:"The delivery list on this tablet is from {at}, not today. Today's list is not built yet — try again in a few minutes.",
  off_fail_auth:    "Your sign-in has run out. Sign in again (top right), then try again.",
  off_fail_catalog: "The product list did not download — the saved copy from {at} is still on the tablet.",
  off_fail_pack:    "Today's delivery list did not download — {why}.",
  off_fail_app:     "The app could not be saved on this tablet ({why}). It still works while there is signal.",
  off_fail_time:    "That step took longer than {lim} s and was stopped.",
  off_try:          "Try again",
  off_done_h:       "Ready to work offline",
  off_done_body:    "Delivery list from {pack}. {n} products. The app is saved on this tablet. {waiting}",
  off_waiting_none: "Nothing is waiting to send.",
  off_waiting_n:    "{n} scans are still waiting — they send by themselves when you are back in signal.",
  off_needs_net:    "Without signal these wait until you are back: putting away cases other tablets put on carts, Fix on a scan already in Finale, learning a new barcode.",
  off_banner:       "Offline — {n} scans waiting to send · delivery list from {pack}. Keep scanning; they send by themselves when you are back in signal.",
  off_banner_none:  "Offline — nothing waiting to send · delivery list from {pack}. Keep scanning; scans send when you are back in signal.",
  off_back:         "Back online — sending {n} waiting scans.",
  off_boot:         "Started without signal — using the settings saved {at}.",
  off_not_ready:    "This tablet has not been got ready for offline today.",
};
for(const k of Object.keys(COPY_ADD)) if(!(k in RX.COPY)) RX.COPY[k] = COPY_ADD[k];

/* review (5): a time that is not today carries its date — "09:41" for a list built yesterday read as today's */
const hhmm = (ms) => { try{ if(!ms) return "?"; const s = RX.hhmm(new Date(ms).toISOString());
  return RX.dayKey(ms) === RX.today() ? s : new Date(ms).toLocaleDateString(undefined, {weekday: "short", month: "short", day: "numeric"}) + " " + s; }catch(_){ return "?"; } };
const swAllowed = () => { try{ return location.protocol === "https:" || localStorage.getItem("rx_sw_test") === "1"; }catch(_){ return location.protocol === "https:"; } };

/* ── the service worker ── */
O.swReady = null;
if("serviceWorker" in navigator && swAllowed()){
  O.swReady = navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).catch(() => null);
}

/* ── what is waiting to send (every outbox the page has) ── */
/* review (7): the SAME count the page's own "Unsaved" uses — scan rows, held corrections, the learning/correction outbox and every
   RX outbox (put-aways, photos) — minus rows that can never send by themselves (UNSAVEABLE: the banner never promises those) */
O.waiting = function(){
  let n = 0;
  try{ n += rows.filter(r => r && r.saved !== "saved" && r.saved !== "UNSAVEABLE").length + rows.filter(r => r && r.fix).length; }catch(_){}
  try{ n += outbox.length; }catch(_){}
  try{ n += RX.unsentCount ? RX.unsentCount() : 0; }catch(_){}
  return n;
};
const packAt = () => { try{ const d = RX.pack && RX.pack.data; const ms = d && Date.parse(d.built); return isNaN(ms) ? 0 : ms; }catch(_){ return 0; } };
/* review (8): navigator.onLine stays TRUE on Wi-Fi with no internet (the freezer) — what the page's own calls saw decides (NET) */
O.isOffline = () => {
  try{
    if(!navigator.onLine) return true;
    const f = (typeof NET !== "undefined" && NET.fail) || 0, ok = (typeof NET !== "undefined" && NET.ok) || 0;
    if(f > ok) return true;
    return !!(typeof offlineBoot !== "undefined" && offlineBoot && !ok);
  }catch(_){ return !navigator.onLine; }
};
let wasOffline = false;
/* back in signal: refresh the saved start-up ids (review 6 — a column added while offline) and send everything */
O.onBack = async function(){
  try{ if(typeof offlineBoot !== "undefined" && offlineBoot && !(typeof noTokenOffline !== "undefined" && noTokenOffline)){ await bootstrapOnline(); offlineBoot = null; saveBoot(); } }catch(_){}
  const n = O.waiting(); if(n) RX.toast(t("off_back", {n}));
  try{ if(RX.intents && RX.intents.flush) RX.intents.flush(); }catch(_){}
  try{ if(typeof retryPending === "function") retryPending(); }catch(_){}
  O.render();
};

/* ── the banner ── */
function ensureBar(){
  let el = document.getElementById("rxOffline");
  if(!el){ const app = document.getElementById("app"); if(!app) return null;
    el = document.createElement("div"); el.id = "rxOffline"; el.setAttribute("role", "status"); app.insertBefore(el, app.firstChild); }
  return el;
}
O.render = function(){
  const el = ensureBar(); if(!el) return;
  let h = "";
  const off = O.isOffline();
  /* review (1): Sign out while offline would end the only pass and lock the crew out until they walk back into signal */
  try{ const so = document.getElementById("signout"); if(so) so.style.visibility = off ? "hidden" : ""; }catch(_){}
  if(off){
    const n = O.waiting(), p = packAt() ? hhmm(packAt()) : "?";
    let boot = ""; try{ if(typeof offlineBoot !== "undefined" && offlineBoot) boot = ` <span class="hint" style="display:inline">${esc(t("off_boot", {at: hhmm(offlineBoot.at)}))}</span>`; }catch(_){}
    h = `<div class="banner rx-banner" id="rxOfflineBar" style="border-left-color:var(--wait)"><strong>${esc(n ? t("off_banner", {n, pack: p}) : t("off_banner_none", {pack: p}))}</strong>${boot}</div>`;
  }
  if(el.dataset.h !== h){ el.innerHTML = h; el.dataset.h = h; }
};
window.addEventListener("offline", () => O.render());
window.addEventListener("online", () => { try{ NET.ok = Date.now(); }catch(_){} O.onBack(); });
RX.on("tick", () => { const off = O.isOffline(); if(wasOffline && !off) O.onBack(); wasOffline = off; O.render(); });
RX.onBoot(() => O.render());

/* ── Get ready for offline ── */
let run = null;          // {i, startedAt, stepAt, failed, done, hidden}
const STEPS = ["signin", "catalog", "pack", "app", "send"];
function card(){
  if(!run) return;
  if(run.hidden && (run.done || run.failed)) run.hidden = false;   // review (9): a hidden run still shows how it ended
  if(run.hidden) return;                            // Close while a step runs hides the card; the run finishes quietly
  const n = STEPS.length, what = t("off_s_" + STEPS[Math.min(run.i, n - 1)]);
  const pct = Math.round((Math.min(run.i, n) / n) * 100);
  let body, acts;
  if(run.done){
    const w = O.waiting();
    body = `${esc(t("off_done_body", {pack: packAt() ? hhmm(packAt()) : "?", n: (() => { try{ return Object.keys(CATALOG).length; }catch(_){ return 0; } })(),
                                      waiting: w ? t("off_waiting_n", {n: w}) : t("off_waiting_none")}))}
            <span class="hint" style="display:block;margin-top:6px">${esc(t("off_needs_net"))}</span>`;
    acts = `<div class="rx-pa-btns"><button type="button" class="rx-btn primary" data-act="offline-close" data-close="3" data-primary>${esc(t("btn_close") || "Close")}</button></div>`;
    prompt_("go", esc(t("off_done_h")), body, acts, {keepScan: true});
    return;
  }
  const s = Math.floor((RX.now() - run.stepAt) / 1000);
  body = `<span id="rxOffStep" style="display:block">${esc(t("off_step", {i: Math.min(run.i + 1, n), n, what}))}</span>
    <span style="display:block;height:8px;background:var(--line);border-radius:4px;margin:8px 0"><span id="rxOffBar" style="display:block;height:8px;width:${pct}%;background:var(--go);border-radius:4px"></span></span>
    ${run.failed ? `<span class="rx-note rx-red" role="alert" style="display:block">${esc(run.failed)}</span>`
                 : `<span class="hint" id="rxOffClock" style="display:block">${esc(t("off_elapsed", {s, lim: STEP_LIMIT_MS / 1000}))}</span>`}`;
  acts = run.failed
    ? `<div class="rx-pa-btns"><button type="button" class="rx-btn primary" data-act="offline-ready" data-primary>${esc(t("off_try"))}</button><button type="button" class="rx-btn" data-act="offline-close" data-close="3">${esc(t("btn_close") || "Close")}</button></div>`
    : `<div class="rx-pa-btns"><button type="button" class="rx-btn" data-act="offline-close" data-close="3">${esc(t("btn_close") || "Close")}</button></div>`;
  prompt_("go", esc(t("off_title")), body, acts, {keepScan: true});
}
const withLimit = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("time"), {timeout: true})), STEP_LIMIT_MS))]);
const netErr = (e) => !!e && !e.auth && !e.status && !e.timeout;

async function step(name){
  if(name === "signin"){
    /* a real SharePoint round trip: proves the sign-in works now AND refreshes the saved start-up ids (rx_boot_v1) the offline start
       needs. ⛔ Never a forced token refresh — that would throw away a pass that still works. */
    try{ await bootstrapOnline(); saveBoot(); }
    catch(e){
      if(e && e.auth) throw new Error(t("off_fail_auth"));
      /* review (10): only a real network failure is "no signal" — SharePoint answering with an error, or a missing list/column, says so */
      if(e && (e.status || /not found|missing these columns/i.test(String(e.message || "")))) throw new Error(t("off_fail_sp", {why: String(e.message || ("HTTP " + e.status)).slice(0, 160)}));
      throw new Error(t("off_fail_net"));
    }
    return;
  }
  if(name === "catalog"){
    const c = await loadCatalog();
    if(c && Object.keys(c).length){ CATALOG = c; try{ rebuildSkuIndex(); renderCatalogState(); }catch(_){} }
    if(catalogState.src !== "live") throw new Error(t("off_fail_catalog", {at: hhmm(catalogState.at)}));
    return;
  }
  if(name === "pack"){
    await RX.pack.load({force: true});
    const st = RX.pack.state || {};
    if(st.status !== "ok") throw new Error(t("off_fail_pack", {why: (RX.pack.message && RX.pack.message()) || st.why || "no signal"}));
    /* review (5): "ready" with YESTERDAY's list is not ready — the list must be today's */
    if(RX.pack.builtToday && !RX.pack.builtToday()) throw new Error(t("off_fail_pack_old", {at: hhmm(packAt())}));
    return;
  }
  if(name === "app"){
    if(!O.swReady) throw new Error(t("off_fail_app", {why: "this address cannot save it"}));
    const reg = await O.swReady; const sw = reg && (reg.active || navigator.serviceWorker.controller);
    if(!sw) throw new Error(t("off_fail_app", {why: "not ready yet"}));
    const urls = ["./", "index.html"]
      .concat([...document.querySelectorAll("script[src]")].map(s => s.getAttribute("src")))
      .concat([...document.querySelectorAll('link[rel="stylesheet"][href]')].map(l => l.getAttribute("href")).filter(h => !/^https?:/.test(h)));
    const res = await new Promise((resolve) => { const ch = new MessageChannel(); ch.port1.onmessage = (ev) => resolve(ev.data || {}); sw.postMessage({type: "cache-all", urls}, [ch.port2]); });
    const missing = res.failed || [];
    if(missing.length) throw new Error(t("off_fail_app", {why: missing.length + " file(s) did not download"}));
    return;
  }
  if(name === "send"){
    try{ if(RX.intents && RX.intents.flush) await RX.intents.flush(); }catch(_){}
    try{ if(typeof retryPending === "function") await retryPending(); }catch(_){}
    return;                     // what is still waiting is SAID on the end card, never a failure
  }
}
let runSeq = 0;
O.ready = async function(){
  if(run && !run.failed && !run.done){ run.hidden = false; card(); return; }   // ⛔ one run at a time; a second tap shows the running one
  const me = ++runSeq;                                       // review (9): a step that outlived its limit can never touch a newer run
  run = {i: 0, startedAt: RX.now(), stepAt: RX.now(), failed: "", done: false, hidden: false, seq: me};
  const tick = setInterval(() => { if(!run || run.done || run.failed){ clearInterval(tick); return; }
    const c = document.getElementById("rxOffClock"); if(c) c.textContent = t("off_elapsed", {s: Math.floor((RX.now() - run.stepAt) / 1000), lim: STEP_LIMIT_MS / 1000}); }, 500);
  card();
  for(; run.i < STEPS.length; run.i++){
    run.stepAt = RX.now(); card();
    try{ await withLimit(step(STEPS[run.i])); if(!run || run.seq !== me) return false; }
    catch(e){
      if(!run || run.seq !== me) return false;
      run.failed = e && e.timeout ? t("off_fail_time", {lim: STEP_LIMIT_MS / 1000}) : String((e && e.message) || e);
      card(); RX.sound && RX.sound("refused"); return false;
    }
  }
  run.done = true; O.netBack = navigator.onLine;
  try{ localStorage.setItem(READY_KEY, JSON.stringify({at: RX.now(), pack: packAt()})); }catch(_){}
  card(); O.render(); RX.sound && RX.sound("saved");
  return true;
};
O.readyAt = () => { try{ const s = JSON.parse(localStorage.getItem(READY_KEY) || "null"); return s && s.at ? s.at : 0; }catch(_){ return 0; } };

RX.registerAct("offline-ready", () => { try{ const m = document.getElementById("rxMenu"); if(m) m.hidden = true; }catch(_){} O.ready(); return "stop"; });
RX.registerAct("offline-close", () => { if(run && !run.done && !run.failed) run.hidden = true; else run = null; try{ clearPrompt(); }catch(_){} return "stop"; });
})();
