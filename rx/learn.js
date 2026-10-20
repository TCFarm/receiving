/* receiving/rx/learn.js — LEARN A NEW BARCODE for a product we already carry (PM-2919). OWNER: Procurement & Merchandising
   (hosted in ProductPipeline/receiving).

   Ruling: Jack, 2026-10-20 — "we also need a way to learn a new UPC code in the app for existing products when they change
   codes but the product doesn't change" and "we would need to have the user open the case, search for the SKU, and have them
   confirm the size and information are identical to the original product in the app before it's accepted."

   ═══ THE FLOW (three screens, every one with Cancel) ═══
     1. OPEN THE CASE   take out one unit; tick that the unit carries this same barcode.
     2. FIND IT         search by name, brand or SKU — one row per product, size and SKU on every row.
     3. CONFIRM         the product as the app knows it beside the new code; three ticks — same product, same size/weight,
                        same flavour/variety. [Learn this barcode] stays disabled until all three are ticked.
                        [Not the same] records a skip ("different product — new item") and says to set the case aside.
   On Learn: (a) a `BarcodeLearnings` row on the ClaudeAgents site (persisted outbox; the Mac mini adds the code to the
   product in FINALE — scripts/barcode_learn_finale.py), (b) a `!ALIAS` "code -> sku" record in BB Receipts, which the
   overnight catalog already learns permanently (build_receiving_catalog.case_aliases_detail), (c) the code is added to this
   tablet's CATALOG at once and the original scan is replayed, so the case carries on as that product.
   ⭐ EVERY TABLET learns it within a minute: `refresh()` reads the list (on load, every minute, and just before a code is
   declared unknown) and `apply()` folds it into CATALOG — also after every catalog reload (index.html rebuildSkuIndex).

   ⛔ A learned code never REPLACES a code the catalog already maps to a different product (apply skips it), and a code that
      fails its own check digit is never offered (a mis-read would pair junk with a real product).
   ⛔ A Revoked row is ignored everywhere (the person who fixes a wrong learning sets Revoked in the list).
   API: window.RXLearn = { setCandidate, start, apply, refresh, state } */
(function(){
"use strict";
const SITE = "tcfarm0.sharepoint.com:/sites/ClaudeAgents", LIST = "BarcodeLearnings";
const KEY_Q = "learn_outbox_v1", KEY_C = "learn_cache_v1";
const REFRESH_MS = 60000, MIN_GAP_MS = 20000, READ_LIMIT_MS = 8000;
const S = { cand: null, learned: {}, siteId: null, listId: null, lastFetch: 0, fetching: null, outbox: [], flushing: false,
            unitTicked: false, pick: null, err: "" };

const ls = { get(k, d){ try{ const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; }catch(_){ return d; } },
             set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(_){} } };
S.learned = ls.get(KEY_C, {}) || {};
S.outbox = (ls.get(KEY_Q, []) || []).filter(x => x && x.fields && x.fields.Code);
const e_ = (s) => (typeof esc === "function" ? esc(s) : String(s == null ? "" : s));
const el = (id) => document.getElementById(id);

function validCheck(code){
  const c = String(code || "");
  if(!/^\d+$/.test(c) || [8, 12, 13, 14].indexOf(c.length) < 0) return false;
  let s = 0; const body = c.slice(0, -1);
  for(let i = 0; i < body.length; i++){ const d = +body[body.length - 1 - i]; s += d * (i % 2 === 0 ? 3 : 1); }
  return (10 - s % 10) % 10 === +c.slice(-1);
}
function newId(){ return "bl-" + ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> c / 4).toString(16)); }

/* ── fold learned codes into the catalog ── */
function apply(){
  if(typeof CATALOG !== "object" || !CATALOG) return 0;
  const bySku = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {};
  let n = 0;
  for(const code in S.learned){
    const L = S.learned[code]; if(!L || L.revoked) continue;
    const base = bySku[L.sku]; if(!base) continue;                 // product not in this catalog: nothing to point at
    const cur = CATALOG[code];
    if(cur && cur.sku && cur.sku !== L.sku) continue;              // ⛔ never re-point a code the catalog maps elsewhere
    if(!cur){ CATALOG[code] = Object.assign({}, base, {learned: true}); n++; }
  }
  return n;
}

/* ── SharePoint plumbing (the page's own delegated token via graph()) ── */
async function G(path, opts){
  let timer; const lim = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), {timeout: true})), READ_LIMIT_MS); });
  try{ return await Promise.race([graph(path, opts || {}), lim]); } finally { clearTimeout(timer); }
}
async function ids(){
  if(S.siteId && S.listId) return true;
  const site = await G(`/sites/${SITE}`); if(!site || !site.id) throw new Error("no ClaudeAgents site");
  const lists = await G(`/sites/${site.id}/lists?$filter=${encodeURIComponent("displayName eq '" + LIST + "'")}`);
  if(!lists || !lists.value || !lists.value.length) throw new Error("list " + LIST + " not found");
  S.siteId = site.id; S.listId = lists.value[0].id; return true;
}
async function refresh(force){
  if(typeof graph !== "function") return 0;
  if(!force && Date.now() - S.lastFetch < MIN_GAP_MS) return 0;
  if(S.fetching) return S.fetching;
  S.fetching = (async () => {
    try{
      await ids();
      const map = {};
      let url = `/sites/${S.siteId}/lists/${S.listId}/items?$expand=${encodeURIComponent("fields($select=Code,Sku,ProductName,Revoked,LearnId)")}&$top=500`;
      let pages = 0;
      while(url && pages < 20){
        const b = await G(url); pages++;
        for(const it of (b && b.value) || []){
          const f = it.fields || {}; const code = String(f.Code || "");
          if(!code || !f.Sku) continue;
          if(f.Revoked){ map[code] = {sku: f.Sku, name: f.ProductName || "", revoked: true}; continue; }
          if(!map[code] || map[code].revoked) map[code] = {sku: f.Sku, name: f.ProductName || ""};
        }
        url = b && b["@odata.nextLink"] ? String(b["@odata.nextLink"]).replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : null;
      }
      for(const q of S.outbox){ const f = q.fields; if(!map[f.Code]) map[f.Code] = {sku: f.Sku, name: f.ProductName, local: true}; }
      S.learned = map; ls.set(KEY_C, map); S.lastFetch = Date.now(); S.err = "";
      return apply();
    }catch(e){ S.err = (e && e.message) || "read failed"; S.lastFetch = Date.now(); return 0; }
    finally{ S.fetching = null; }
  })();
  return S.fetching;
}
async function flush(){
  if(S.flushing || !S.outbox.length || typeof graph !== "function") return;
  S.flushing = true;
  try{
    await ids();
    while(S.outbox.length){
      const q = S.outbox[0];
      try{ await graph(`/sites/${S.siteId}/lists/${S.listId}/items`, {method: "POST", body: JSON.stringify({fields: q.fields})}); }
      catch(e){
        if(e && e.status === 409){ /* duplicate LearnId = already saved */ }
        else if(e && e.permanent){ console.warn("learning refused by SharePoint, dropped", q.fields, e); }
        else break;                                                   // network / auth: keep it for the next pass
      }
      S.outbox.shift(); ls.set(KEY_Q, S.outbox);
    }
  }catch(_){ /* site lookup failed: retried next pass */ }
  finally{ S.flushing = false; }
}

/* ── the flow ── */
function setCandidate(c){
  const code = String((c && c.code) || "");
  S.cand = validCheck(code) ? {code, raw: String(c.raw || code)} : null;
  return !!S.cand;
}
const learnBtn = () => (S.cand ? `<button class="primary" id="learnStart" data-act="learn-start">Product we carry, new barcode? Learn it</button>` : "");
function sizeOf(name){ const m = /\s-\s([^-]*\d[^-]*)$/.exec(String(name || "")); return m ? m[1].trim() : ""; }
function codesFor(sku){ const out = []; for(const k in CATALOG){ if(CATALOG[k] && CATALOG[k].sku === sku && !CATALOG[k].learned) out.push(k); } return out.slice(0, 3); }
const cancel = `<div class="pcloseRow"><button type="button" class="pclose" data-act="learn-cancel" data-close="3">Cancel — nothing learned</button></div>`;

function start(){
  if(!S.cand) return;
  S.unitTicked = false; S.pick = null;
  prompt_("", "Learn a new barcode — 1 of 3: open the case",
    `New barcode <span class="num">${e_(S.cand.code)}</span>.<br><br>
     <strong>Open the case and take out ONE unit.</strong> Look at the unit's own barcode number.`,
    `<label style="display:flex;gap:10px;align-items:center;margin:8px 0 12px;font-size:16px">
       <input type="checkbox" id="lnUnit" data-act="learn-unit" style="width:24px;height:24px">
       The unit inside shows this same number (${e_(S.cand.code.slice(-6))} at the end)</label>
     <button class="primary" id="lnNext1" data-act="learn-next1" disabled>Next — find the product</button>${cancel}`, {noClose: true});
}
function find(){
  prompt_("", "Learn a new barcode — 2 of 3: find the product",
    `Type the name, brand or SKU of the product <strong>in your hand</strong>. Two sizes read alike — check the size.`,
    `<input id="lnq" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search product"
        placeholder="e.g. coco whip, so delicious, FProd8302Folkl"
        style="width:100%;font-size:18px;padding:11px;border:1px solid var(--line);border-radius:4px;background:var(--ground);color:var(--ink)">
     <div id="lnres" style="margin-top:10px;max-height:46vh;overflow:auto"><div class="hint">Type at least two letters.</div></div>${cancel}`,
    {noClose: true});
  setTimeout(() => { const q = el("lnq"); if(q){ q.focus(); q.addEventListener("input", () => results(q.value)); } }, 30);
}
function results(q){
  const box = el("lnres"); if(!box) return;
  const t = String(q || "").trim().toLowerCase();
  if(t.length < 2){ box.innerHTML = `<div class="hint">Type at least two letters.</div>`; return; }
  const words = t.split(/\s+/), seen = new Set(), hits = [];
  const bySku = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {};
  for(const sku in bySku){
    const p = bySku[sku]; if(!p || seen.has(sku)) continue;
    const hay = ((p.br || "") + " " + (p.name || "") + " " + sku).toLowerCase();
    if(words.every(w => hay.includes(w))){ seen.add(sku); hits.push(p); }
    if(hits.length >= 40) break;
  }
  if(!hits.length){ box.innerHTML = `<div class="hint">No match. If it is not in our catalog it is a NEW product — this cannot learn it.
      Cancel, skip the carton with reason "not in system" and set it aside.</div>`; return; }
  box.innerHTML = hits.map(p => `<button class="lnpick" data-act="learn-pick" data-sku="${e_(p.sku)}"
      style="display:block;width:100%;text-align:left;margin:0 0 6px;padding:11px 13px;min-height:0;font-size:15px">
      ${p.br ? `<span style="color:var(--ink-2)">${e_(p.br)}</span> ` : ""}${e_(p.name || "(no name)")}
      <div class="num" style="font-size:12px;color:var(--ink-3);margin-top:2px">${e_(p.sku)} · size <strong>${e_(sizeOf(p.name) || "?")}</strong> · ${e_(p.cls || "?")}</div>
    </button>`).join("");
}
function confirm_(sku){
  const p = ((typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {})[sku]; if(!p) return find();
  S.pick = p;
  const tick = (id, label) => `<label style="display:flex;gap:10px;align-items:center;margin:6px 0;font-size:16px">
      <input type="checkbox" id="${id}" class="lnTick" data-act="learn-tick" style="width:24px;height:24px"> ${label}</label>`;
  prompt_("", "Learn a new barcode — 3 of 3: is it identical?",
    `Compare the unit in your hand with what the app has. ⛔ Only if ALL of it matches.`,
    `<table style="width:100%;border-collapse:collapse;font-size:15px;margin:4px 0 10px">
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Brand</td><td><strong>${e_(p.br || "—")}</strong></td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Product</td><td><strong>${e_(p.name || "")}</strong></td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Size</td><td><strong style="font-size:18px">${e_(sizeOf(p.name) || "see the name")}</strong></td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">SKU</td><td class="num">${e_(p.sku)}</td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Storage</td><td>${e_(p.cls || "?")}${p.pack ? ` · ${e_(p.pack)} per case` : ""}</td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Old barcode</td><td class="num">${e_(codesFor(p.sku).join(", ") || "none on file")}</td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">NEW barcode</td><td class="num"><strong>${e_(S.cand.code)}</strong></td></tr>
     </table>
     ${tick("lnSame", "Same product — brand and name match the unit")}
     ${tick("lnSize", `Same size / weight${sizeOf(p.name) ? " (" + e_(sizeOf(p.name)) + ")" : ""}`)}
     ${tick("lnVar", "Same flavour / variety")}
     <div style="margin-top:10px"><button class="primary" id="lnLearn" data-act="learn-commit" disabled>Learn this barcode</button>
     <button id="lnDiff" data-act="learn-diff">Not the same — it's a different product</button>
     <button id="lnBack" data-act="learn-back">Back — pick another</button></div>${cancel}`, {noClose: true});
}
function ticksOk(){ return ["lnSame", "lnSize", "lnVar"].every(id => { const x = el(id); return x && x.checked; }); }

async function commit(){
  if(!S.cand || !S.pick || !ticksOk() || !S.unitTicked) return;
  const code = S.cand.code, p = S.pick, raw = S.cand.raw;
  const conf = {same_product: true, same_size: true, same_variety: true, unit_opened: true,
                shown: {name: p.name || "", br: p.br || "", size: sizeOf(p.name), old: codesFor(p.sku)}};
  const fields = {Title: "learn " + code, LearnId: newId(), Code: code, Sku: p.sku, ProductName: String(p.name || "").slice(0, 250),
                  Confirmed: JSON.stringify(conf).slice(0, 4000), Operator: (typeof account === "string" ? account : "") || "",
                  Device: (typeof device === "string" ? device : "") || "", LearnedAt: new Date().toISOString()};
  S.outbox.push({fields, at: Date.now()}); ls.set(KEY_Q, S.outbox);
  S.learned[code] = {sku: p.sku, name: p.name || "", local: true}; ls.set(KEY_C, S.learned);
  try{ if(typeof reject === "function") reject("ALIAS", `${code} -> ${p.sku}`, code); }catch(_){}
  if(!CATALOG[code] || CATALOG[code].sku === p.sku) CATALOG[code] = Object.assign({}, p, {learned: true});
  flush();
  S.cand = null; S.pick = null;
  try{ pending = null; unresolved = null; }catch(_){}
  if(typeof clearPrompt === "function") clearPrompt();
  if(typeof handleScan === "function") await handleScan(raw);        // the case carries on as the confirmed product
}
function different(){
  const code = S.cand ? S.cand.code : "";
  try{ if(typeof reject === "function") reject("SKIPPED", `${code} :: different product - new item`, code); }catch(_){}
  S.cand = null; S.pick = null;
  try{ pending = null; unresolved = null; }catch(_){}
  prompt_("", "Not learned — set the case aside",
    `This is a <strong>different product</strong>, so it needs to be created before it can be received.
     The skip and its reason are recorded. ⛔ Set the case aside; do not put it away.`);
}
function cancelFlow(){
  S.pick = null;
  try{ pending = null; unresolved = null; }catch(_){}
  if(typeof clearPrompt === "function") clearPrompt();
}

/* Clicks go through the core router (RX.registerAct) so the coverage gate sees a handler for every learn-* button. */
const ACTS = { "learn-start": () => start(), "learn-cancel": () => cancelFlow(), "learn-next1": () => { if(S.unitTicked) find(); },
               "learn-pick": (a) => confirm_(a.el.getAttribute("data-sku")), "learn-back": () => find(),
               "learn-diff": () => different(), "learn-commit": () => { commit(); },
               "learn-unit": (a) => { S.unitTicked = !!a.el.checked; const b = el("lnNext1"); if(b) b.disabled = !S.unitTicked; },
               "learn-tick": () => { const b = el("lnLearn"); if(b) b.disabled = !ticksOk(); } };
if(window.RX && RX.registerAct){
  for(const n of ["learn-start", "learn-cancel", "learn-next1", "learn-pick", "learn-back", "learn-diff", "learn-commit", "learn-unit", "learn-tick"])
    RX.registerAct(n, (a) => { ACTS[n](a); return (n === "learn-unit" || n === "learn-tick") ? undefined : "stop"; });
}
document.addEventListener("change", (e) => {
  const t = e.target; if(!t || !t.getAttribute) return;
  const act = t.getAttribute("data-act");
  if(act === "learn-unit"){ S.unitTicked = !!t.checked; const b = el("lnNext1"); if(b) b.disabled = !S.unitTicked; }
  if(act === "learn-tick"){ const b = el("lnLearn"); if(b) b.disabled = !ticksOk(); }
});

setTimeout(() => { refresh(true); flush(); }, 3000);
setInterval(() => { refresh(false); flush(); }, REFRESH_MS);
window.RXLearn = { setCandidate, start, apply, refresh, flush, learnBtn, validCheck, sizeOf, state: S };
})();
