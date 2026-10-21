/* receiving/rx/version.js — A NEW VERSION REACHES THE TABLETS (build wave B2, plan 4b; 2026-10-21).
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   Why: the page is served from GitHub Pages and a tablet keeps the copy it loaded until someone reloads it — a fix published at
   noon (B1, the spaced case labels) did nothing on a tablet left open since morning. `deploy_page.py --push` now publishes
   `version.json` {v} after every pushed file; this file reads it at load and every VERSION_EVERY.
   When the stamp changes:
     · the page is IDLE (no question open — the page's `pending` — and no key pressed for VERSION_IDLE): it reloads itself.
       Nothing is lost: every outbox (scans, learnings, fixes) lives in localStorage and is flushed after the reload.
     · otherwise a banner says a new version is ready, with [Reload now] (data-act version-reload). It never interrupts a scan.
   ⛔ A failed or missing version.json changes nothing (a 404 means "not published yet", never "reload").
   ⛔ deploy_page.py stamps ONCE, after the whole set is pushed (index.html last) — never per file, or an idle tablet would reload
      into new rx/*.js with the old index.html (review H2, 2026-10-21). */
(function(){
"use strict";
const EVERY = 10 * 60000, IDLE = 2 * 60000;
let base = null, lastKey = Date.now(), timer = null;
async function read(){
  try{
    const r = await fetch("version.json?t=" + Date.now(), {cache: "no-store"});
    if(!r.ok) return null;
    const j = await r.json();
    return j && j.v != null && String(j.v) !== "" ? String(j.v) : null;
  }catch(_){ return null; }
}
/* busy = a question is open (`pending`, an unresolved code, anything in #promptArea — the learn screens included) or the crew touched
   the page in the last IDLE (keys, taps, pointer: a touch-only tablet sends no keydown — review M4) */
const busy = () => {
  try{ if(typeof pending !== "undefined" && pending) return true; }catch(_){}
  try{ if(typeof unresolved !== "undefined" && unresolved) return true; }catch(_){}
  const pa = document.getElementById("promptArea"); if(pa && pa.innerHTML.trim()) return true;
  return Date.now() - lastKey < IDLE;
};
/* review M5: GitHub Pages caches rx/*.js for ~10 minutes; refresh every script in the HTTP cache before reloading, so the reload
   runs the NEW code and not the old files with a new page */
async function reloadFresh(){
  try{ await Promise.all([...document.querySelectorAll("script[src]")].map(s => fetch(s.src, {cache: "reload"}).catch(() => null))); }catch(_){}
  location.reload();
}
function banner(){
  if(document.getElementById("verBanner")) return;
  const b = document.createElement("div"); b.id = "verBanner"; b.setAttribute("role", "status");
  b.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:60;padding:calc(8px + env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 8px max(16px,env(safe-area-inset-left,0px));background:var(--accent-bg,#e6f0ff);color:var(--ink,#222);border-bottom:2px solid var(--accent,#2a5bd7);font-size:15px";
  b.innerHTML = `A new version of this page is ready. Finish this case, then <button type="button" data-act="version-reload" style="margin-left:6px;min-height:0;padding:4px 12px">Reload now</button>`;
  document.body.appendChild(b);
}
async function check(){
  const v = await read();
  if(v == null) return "none";
  if(base == null){ base = v; return "base"; }
  if(v === base) return "same";
  if(!busy()){ reloadFresh(); return "reloaded"; }
  banner(); return "banner";
}
for(const ev of ["keydown", "pointerdown", "touchstart"]) document.addEventListener(ev, () => { lastKey = Date.now(); }, true);
if(window.RX && RX.registerAct) RX.registerAct("version-reload", () => { reloadFresh(); return "stop"; });
setTimeout(check, 1500);
timer = setInterval(check, EVERY);
window.RXVersion = { check, read, state: () => ({base, lastKey}), _setBase: (v) => { base = v; }, _setLastKey: (ms) => { lastKey = ms; } };
})();
