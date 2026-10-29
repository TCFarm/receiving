/* receiving/sw.js — THE PAGE SAVES ITSELF ON THE TABLET (PM-3372, 2026-10-29). OWNER: Procurement & Merchandising (hosted here).
   Plan: Procurement & Merchandising/plans/2026-10-29-receiving-offline-PLAN.md.

   Why (Jack, 2026-10-29): the frozen team "dont have good internet there" — a reload in the freezer showed "no internet" and the crew
   could not go on (scans already queued were safe, but nothing new could be scanned).

   THE RULE: same-origin GETs under this folder are NETWORK FIRST. A tablet with signal always gets the live file (and the saved copy is
   refreshed as a side effect); the saved copy is used ONLY when the network request fails. So a published fix is never hidden by a
   stale copy while there is signal.
   ⛔ Never touched: anything cross-origin (Microsoft sign-in, Graph — the page's own outboxes handle those), non-GET requests,
      `version.json` (an offline tablet must never "see" a new version) and this file itself.
   ⛔ The saved key ignores the query string (cache-busters, the sign-in `?code=`), so a navigation back from sign-in finds the page.
   Message {type:"cache-all", urls:[…]} (the "Get ready for offline" button, rx/offline.js): fetch every URL fresh and save it;
   replies {ok, saved, failed:[url]} on the given port. */
"use strict";
const CACHE = "rx-receiving-v1";
const SCOPE = new URL(self.registration.scope).pathname;

const keyOf = (url) => { const u = new URL(url, self.location.href); return u.origin + u.pathname; };
/* ⛔ review (4): the product list, life ceilings and lot formats are NOT saved here — the page keeps its own dated copies of them and
   says "using the saved copy from …"; answered from here they would read as LIVE and overwrite that date */
const skip = (u) => u.origin !== self.location.origin || !u.pathname.startsWith(SCOPE) ||
  /\/(version\.json|sw\.js|catalog\.json|life_ceilings\.json|lot_date_formats\.json)$/.test(u.pathname);
/* ⭐ review (2): weak Wi-Fi HANGS rather than fails — a request that has not answered within the limit is served from the saved copy
   (and still updates it if it arrives). ⭐ review (3): once a page was opened from the saved copy, every file it asks for comes from the
   saved copy too, so one page never mixes an old and a new version of the app. */
const LIMIT_NAV_MS = 4000, LIMIT_FILE_MS = 6000;
const fromCache = new Set();      // client ids whose page was opened from the saved copy

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for(const k of await caches.keys()) if(k.startsWith("rx-receiving-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if(req.method !== "GET") return;
  const u = new URL(req.url);
  if(skip(u)) return;
  const nav = req.mode === "navigate";
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const saved = async () => (await c.match(keyOf(req.url))) ||
      (nav ? ((await c.match(self.location.origin + SCOPE + "index.html")) || (await c.match(self.location.origin + SCOPE))) : null);
    if(!nav && fromCache.has(e.clientId)){ const hit = await saved(); if(hit) return hit; }
    const net = fetch(req).then(async (r) => {
      if(r && r.ok && r.type === "basic"){ try{ await c.put(keyOf(req.url), r.clone()); }catch(_){} }
      return r;
    });
    net.catch(() => {});              // a late failure after the saved copy was served is not an error
    const timer = new Promise((res) => setTimeout(() => res("timeout"), nav ? LIMIT_NAV_MS : LIMIT_FILE_MS));
    let first;
    try{ first = await Promise.race([net, timer]); }catch(err){ first = err; }
    if(first instanceof Response) return first;
    const hit = await saved();
    if(hit){ if(nav && e.resultingClientId) fromCache.add(e.resultingClientId); return hit; }
    return net;                       // nothing saved: wait for the network after all (or its error)
  })());
});

self.addEventListener("message", (e) => {
  const d = e.data || {}, port = e.ports && e.ports[0];
  if(d.type !== "cache-all" || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE), failed = [], keep = new Set();
    let saved = 0;
    for(const url of d.urls){
      try{
        const u = new URL(url, self.location.href); if(skip(u)) continue;
        const r = await fetch(u.href, {cache: "reload"});
        if(!r.ok) throw new Error("HTTP " + r.status);
        await c.put(keyOf(u.href), r.clone()); saved++; keep.add(keyOf(u.href));
        if(u.pathname.endsWith("/index.html")){ await c.put(self.location.origin + SCOPE, r.clone()); keep.add(self.location.origin + SCOPE); }
      }catch(_){ failed.push(url); }
    }
    /* review (3): a complete set replaces the saved app — files that are no longer published are dropped */
    if(!failed.length) for(const k of await c.keys()) if(!keep.has(k.url)) await c.delete(k);
    if(port) port.postMessage({ok: !failed.length, saved, failed});
  })());
});
