/* receiving/rx/receive-pack.js — the DELIVERY LIST ("pack.json") on the tablet.
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   What it does: reads `pack.json` (schema tcfarm.receiving.pack/1, MASTER-PLAN §1.2) from info@tc.farm's OneDrive
   through Microsoft Graph with the SIGNED-IN user's own token (the page's `getToken()` — the same sign-in as the
   scan list). ⛔ Never from GitHub Pages: PO quantities and the bin map must not be public (DECISIONS D3).

   ⭐ EVERY WAIT SHOWS A STAGE, A CLOCK AND HAS A LIMIT (_shared/APP-PROGRESS-STATUS.md): Step 1 of 2 "Reading
   today's delivery list" with bytes and a progress bar, Step 2 of 2 "Saving it on this tablet"; ends after
   PACK_STALL (no bytes) or PACK_TOTAL, always in plain words with a Try-again. A late answer after a limit (or
   after a newer load began) is IGNORED — the generation guard `P.state.gen`.
   ⛔ Never blocks scanning: a missing pack only turns PO matching off.

   STATES (P.state.status): idle | loading | ok | cached | none
     ok      loaded now.                       cached  the load failed/offline and the saved copy is in use.
     none    no pack at all (red card).
   STALENESS (P.staleness()) — MASTER-PLAN §9.1: judged by "built TODAY and covers the due PO", never by hours:
     red = no pack at all · amber = not built today, or no PO within ±3 days of today · ok otherwise.

   API:  P.data  P.state  P.load({force, silent})  P.staleness()  P.applyQueued()  P.builtToday()
         P.binInfo(name)  P.areaOf(name)  P.skuInfo(sku)  P.candidates(sku)  P.poById(id)  P.poLinesBySku(sku)
         P.binsSorted()  P.searchBins(text, sku, limit)  P.message()  P.cachedAt()
   Cache: localStorage `rx_pack_v1` = {at, etag, pack} (the last GOOD copy; an invalid pack never replaces it). */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const CFG = RX.CFG, P = RX.pack, t = RX.t;
P.data = null;
P.state = { status:"idle", stage:0, bytes:0, total:0, startedAt:0, source:null, why:"", gen:0, cachedAt:0, offline:false, lastOkAt:0 };
let idx = { bins:new Map(), skuPo:new Map(), poById:new Map() };
P.queued = null;

const enc = (path) => path.split("/").map(encodeURIComponent).join("/");
const DRIVE_PATH = () => `/drives/${CFG.pack.drive_id}/root:/${enc(CFG.pack.path)}:/content`;

function validate(j){
  return !!(j && typeof j === "object" && j.schema === CFG.pack.schema && Array.isArray(j.pos)
            && j.skus && typeof j.skus === "object");
}
function buildIndex(data){
  const bins = new Map(), skuPo = new Map(), poById = new Map();
  const b = (data && data.bins) || {};
  for(const name of Object.keys(b)){
    const v = b[name] || [];
    bins.set(String(name).toUpperCase(), {name, role:v[0] || "", temp:v[1] || "", active:v.length > 2 ? !!v[2] : true});
  }
  for(const po of (data && data.pos) || []){
    poById.set(String(po.order_id), po);
    for(const line of (po.lines || [])){
      const k = line.sku; if(!k) continue;
      if(!skuPo.has(k)) skuPo.set(k, []);
      skuPo.get(k).push({po, line});
    }
  }
  idx = { bins, skuPo, poById };
}
function setData(data){ P.data = data; buildIndex(data); RX.emit("pack", data); RX.refresh(); }

P.builtToday = (data) => { const d = data || P.data; if(!d || !d.built) return false; const ms = Date.parse(d.built); return !isNaN(ms) && RX.dayKey(ms) === RX.today(); };
P.cachedAt = () => P.state.cachedAt;
P.staleness = function(){
  const d = P.data;
  if(!d) return {level:"red", why:"none"};
  if(!P.builtToday(d)) return {level:"amber", why:"not_today"};
  const today = RX.today();
  const near = (d.pos || []).some(po => { if(!po.eta) return false; const diff = Math.round((Date.parse(po.eta+"T00:00:00") - Date.parse(today+"T00:00:00"))/86400000);   /* ⛔ round-2: rounded — across a DST change (Nov 1) a 3-day gap is 3.04 days and fell out of ±3 */ return diff >= -3 && diff <= 3; });
  if(!near) return {level:"amber", why:"no_near_po"};
  return {level:"ok", why:""};
};
P.binInfo = (name) => idx.bins.get(String(name || "").trim().toUpperCase()) || null;
P.areaOf = (name) => { const d = P.data; if(!d || !d.areas) return null; const k = String(name || "").trim().toUpperCase().split("-")[0]; return d.areas[k] || null; };
P.skuInfo = (sku) => (P.data && P.data.skus && P.data.skus[sku]) || null;
P.candidates = (sku) => { const s = P.skuInfo(sku); return (s && s.candidates) || []; };
P.poById = (id) => idx.poById.get(String(id)) || null;
P.poLinesBySku = (sku) => idx.skuPo.get(sku) || [];
P.binsSorted = () => [...idx.bins.values()].map(x => x.name).sort();
P.searchBins = function(text, sku, limit){
  const q = String(text || "").trim().toUpperCase().replace(/[\s]+/g, "");
  const cands = new Set(P.candidates(sku).map(c => String(c.bin).toUpperCase()));
  const out = [];
  for(const [key, b] of idx.bins){
    if(!b.active) continue;
    if(q && !key.replace(/-/g, "").includes(q.replace(/-/g, ""))) continue;
    out.push({name:b.name, role:b.role, temp:b.temp, active:b.active, cand:cands.has(key)});
  }
  out.sort((a, b) => (b.cand - a.cand) || a.name.localeCompare(b.name));
  return out.slice(0, limit || 40);
};

/* ── cache ── */
function readCache(){ const c = RX.store.get(CFG.pack.cache_key, null); return (c && validate(c.pack)) ? c : null; }
function writeCache(pack, etag){ RX.store.set(CFG.pack.cache_key, {at:RX.now(), etag:etag || "", pack}); }

function whenText(data, at){
  const ms = data && data.built ? Date.parse(data.built) : at;
  if(!ms || isNaN(ms)) return "earlier";
  return RX.dayKey(ms) === RX.today() ? RX.hhmm(ms) : new Date(ms).toLocaleDateString(undefined, {weekday:"short", month:"short", day:"numeric"})+" "+RX.hhmm(ms);
}
P.message = function(){
  const s = P.state, d = P.data;
  if(s.status === "none") return t("pack_none") + (s.why ? " ("+s.why+")" : "");
  if(s.status === "cached"){
    const today = P.builtToday(d);
    const at = whenText(d, s.cachedAt);
    if(s.offline) return t("pack_offline", {at});
    return today ? t("pack_limit_cached", {why:s.why, at}) : t("pack_limit_cached_old", {why:s.why, when:at});
  }
  return "";
};

function useCache(why, offline){
  const s = P.state, c = readCache();
  s.why = why || ""; s.offline = !!offline; s.stage = 0;
  if(c){ s.status = "cached"; s.source = "cache"; s.cachedAt = c.at || 0; setData(c.pack); }
  else { s.status = "none"; s.source = null; RX.emit("pack", null); RX.refresh(); }
}

/* ── the load ── */
P.load = async function(opts){
  opts = opts || {};
  const s = P.state;
  if(s.status === "loading" && !opts.force && !opts.silent) return;
  const gen = ++s.gen;
  const silent = !!opts.silent && P.data;
  if(!silent){
    if(typeof navigator !== "undefined" && navigator.onLine === false){ useCache(t("pack_nonet"), true); return; }
    s.status = "loading"; s.stage = 1; s.bytes = 0; s.total = 0; s.startedAt = RX.now(); s.why = ""; s.offline = false;
    RX.refresh();
  }
  const ctrl = new AbortController();
  let abortWhy = "";
  let stallT = null, totalT = null;
  const arm = () => { clearTimeout(stallT); stallT = setTimeout(() => { abortWhy = t("pack_timeout"); try{ ctrl.abort(); }catch(_){} }, CFG.PACK_STALL); };
  arm();
  totalT = setTimeout(() => { abortWhy = t("pack_timeout"); try{ ctrl.abort(); }catch(_){} }, CFG.PACK_TOTAL);
  const done = () => { clearTimeout(stallT); clearTimeout(totalT); };
  const stale = () => gen !== s.gen;
  const fail = (why) => { done(); if(stale()) return; if(silent){ return; } useCache(why, false); };
  try{
    let tok = await getToken();
    if(stale()) return done();
    const url = GRAPH + DRIVE_PATH();
    let r = await fetch(url, {headers:{Authorization:"Bearer "+tok}, signal:ctrl.signal});
    if(r.status === 401){                       // an access token can be revoked early: force ONE refresh, retry once
      try{ tokenExp = 0; }catch(_){}
      tok = await getToken();
      r = await fetch(url, {headers:{Authorization:"Bearer "+tok}, signal:ctrl.signal});
    }
    if(stale()) return done();
    if(r.status === 401){ done(); try{ flagSignIn(); }catch(_){} return fail(t("pack_denied")); }
    if(r.status === 403) return fail(t("pack_denied"));
    if(r.status === 404) return fail(t("pack_missing"));
    if(!r.ok) return fail("Graph "+r.status);
    s.total = +(r.headers.get("content-length") || 0) || 0;
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    let text = "";
    if(reader){
      const chunks = []; let got = 0;
      for(;;){
        const {done: fin, value} = await reader.read();
        if(stale()){ try{ reader.cancel(); }catch(_){} return done(); }
        if(fin) break;
        chunks.push(value); got += value.length; s.bytes = got; arm();
        if(!silent) RX.refresh();
      }
      const all = new Uint8Array(got); let o = 0; for(const c of chunks){ all.set(c, o); o += c.length; }
      text = new TextDecoder().decode(all);
    }else{ text = await r.text(); }
    if(stale()) return done();
    done();
    if(!silent){ s.stage = 2; RX.refresh(); }
    let j = null; try{ j = JSON.parse(text); }catch(_){ j = null; }
    if(!validate(j)){ if(silent) return; return useCache(t("pack_bad"), false); }
    if(silent){ P.queued = {data:j, etag:r.headers.get("etag") || ""}; return; }
    writeCache(j, r.headers.get("etag"));
    s.status = "ok"; s.source = "live"; s.stage = 0; s.why = ""; s.offline = false; s.lastOkAt = RX.now(); s.cachedAt = RX.now();
    setData(j);
  }catch(e){
    done();
    if(stale()) return;
    if(silent) return;
    if(e && e.auth){ try{ flagSignIn(); }catch(_){} return useCache(t("pack_denied"), false); }
    if(abortWhy) return useCache(abortWhy, false);
    return useCache(t("pack_nonet"), typeof navigator !== "undefined" && navigator.onLine === false);
  }
};
/* silent refresh: new data is applied only at an idle moment — "never mid-card" */
P.applyQueued = function(){
  const q = P.queued; if(!q) return false;
  let busy = false; try{ busy = !!pending; }catch(_){}
  if(busy || RX.state.step) return false;
  P.queued = null;
  writeCache(q.data, q.etag);
  P.state.status = "ok"; P.state.source = "live"; P.state.lastOkAt = RX.now(); P.state.cachedAt = RX.now();
  setData(q.data); return true;
};

RX.onBoot(() => {
  if(RX.forcedOff()) return;                   // ⭐ OFF (rollback / ?rx=off) = the page makes no pack request at all
  P.load();
  let last = RX.now();
  RX.on("tick", () => {
    P.applyQueued();
    if(RX.now() - last >= CFG.PACK_REFRESH && P.state.status !== "loading"){ last = RX.now(); P.load({silent:true}); }
  });
  RX.on("day", () => { P.load({silent:true}); });
});
})();
