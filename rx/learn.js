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
   ⭐ BUILD WAVE R4 (Jack, 2026-10-21 — an ambiguous code is asked "in BOTH places": the buyer's list AND "the tablet the next time
   that code is scanned"): the mini publishes `app/receiving/past_scans.json` (Procurement & Merchandising/scripts/receiving_past_scans.py)
   — per code the crew gave up on, the products sharing its brand prefix, those on that truck first. When an unknown code has
   candidates the unknown card asks "Is this one of these?"; a tap still goes through OPEN THE CASE and the three ticks (the tablet's
   rule is unchanged), it only skips the search. A code the buyer already learned in the portal is simply known (refresh()).
   ⭐ Learn errors are VISIBLE (plan 4b): a learning still waiting to save after 2 minutes, or refused by SharePoint, shows a banner
   (#lnBanner) until it saves or is dismissed — never silent. "Learned — every tablet knows it within a minute" once it saves.
   ⭐⭐ WRONG ITEM (PM-3303; Jack, 2026-10-28: "if it's finding the wrong UPC … they should be able to … find the right SKU … and correct
   which UPC code is matched"; "The crew member's three ticks are enough for a wrong-item fix, no second approval"). A code the catalog
   maps to the WRONG product is re-pointed with the SAME three screens (open the case, find it, three ticks). The row is a learning whose
   `Confirmed` JSON carries {reassign:true, old_sku} (no new list column). ⛔ apply() re-points a code ONLY away from the product the crew
   said was wrong — if the catalog has since moved it elsewhere, nothing happens. The open scan carries on as the right product (its date
   and lot are kept). The catalog builder learns it permanently from a REASSIGN telemetry row; Finale adds the code to the right product,
   and if Finale has it on another product the row is held for a person to move by hand — every tablet keeps using the correction.
   To undo: Wrong item? again, back to the first product (the newest correction wins).
   API: window.RXLearn = { setCandidate, start, apply, refresh, state, wrongItem } */
(function(){
"use strict";
const SITE = "tcfarm0.sharepoint.com:/sites/ClaudeAgents", LIST = "BarcodeLearnings";
const KEY_Q = "learn_outbox_v1", KEY_C = "learn_cache_v1";
const REFRESH_MS = 60000, MIN_GAP_MS = 20000, READ_LIMIT_MS = 8000;
const S = { cand: null, learned: {}, siteId: null, listId: null, lastFetch: 0, fetching: null, outbox: [], flushing: false,
            unitTicked: false, pick: null, err: "", preSku: null, asks: null, asksAt: 0, refused: [] };
const KEY_A = "learn_asks_v1", KEY_R = "learn_refused_v1", ASK_MS = 30 * 60000, STUCK_MS = 2 * 60000;

const ls = { get(k, d){ try{ const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; }catch(_){ return d; } },
             set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(_){} } };
S.learned = ls.get(KEY_C, {}) || {};
S.outbox = (ls.get(KEY_Q, []) || []).filter(x => x && x.fields && x.fields.Code);
S.asks = ls.get(KEY_A, null);
S.refused = (ls.get(KEY_R, []) || []).filter(x => x && x.code);
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
    if(L.reassign){
      /* ⛔ a crew wrong-item fix moves the code ONLY away from the product they named — the code itself, or (a case code with no
         entry of its own) the consumer UPC it derives to */
      const via = cur || ((/^\d{14}$/.test(code) && typeof gtin14ToConsumer === "function") ? CATALOG[gtin14ToConsumer(code)] : null);
      if(cur && cur.sku === L.sku && cur.reassigned) continue;
      /* replay the chain from what the catalog says now; a step applies only while the code is on that step's old product */
      let at = via ? via.sku : null;
      for(const st of (L.chain || [{sku: L.sku, oldSku: L.oldSku}])) if(at && st.oldSku && at === st.oldSku) at = st.sku;
      const fin = at && bySku[at];
      const lastStep = (L.chain || [])[(L.chain || []).length - 1] || {};
      if(fin && via && at === via.sku && Array.isArray(via.alt) && !via.reassigned && lastStep.pin && !lastStep.undo){   // PM-3314: a PIN — settled
        const b0 = Object.assign({}, via); delete b0.alt; CATALOG[code] = Object.assign(b0, {learned: true, reassigned: true}); n++; continue;
      }
      if(!fin || !via || at === via.sku) continue;
      CATALOG[code] = Object.assign({}, fin, {learned: true, reassigned: true}); n++; continue;
    }
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
      let url = `/sites/${S.siteId}/lists/${S.listId}/items?$expand=${encodeURIComponent("fields($select=Code,Sku,ProductName,Revoked,LearnId,FinState,FinReason,Confirmed,LearnedAt)")}&$top=500`;
      let pages = 0;
      while(url && pages < 20){
        const b = await G(url); pages++;
        for(const it of (b && b.value) || []){
          const f = it.fields || {}; const code = String(f.Code || "");
          if(!code || !f.Sku) continue;
          /* review M1: a learning the mini REFUSED or HELD for a person (not one it is still posting) is not applied — Finale says
             the code is not this product (e.g. CODE_ON_OTHER_PRODUCT), so the tablet must not receive it as one */
          /* PM-3303: a wrong-item fix Finale cannot apply by itself (REASSIGN …) waits for a person in FINALE only — the tablets keep it */
          const dead = f.FinState === "refused" || f.FinState === "failed" || (f.FinState === "held" && !/^(POSTING|UNCERTAIN|REASSIGN)/.test(String(f.FinReason || "")));
          let cf = {}; try{ cf = JSON.parse(f.Confirmed || "{}") || {}; }catch(_){ cf = {}; }
          const ra = cf.reassign ? {reassign: true, oldSku: String(cf.old_sku || ""), others: Array.isArray(cf.others) ? cf.others : [],
                                    pin: cf.pin === true, undo: cf.undo === true, shared: cf.shared === true} : {};
          /* review M2: a revoked (or dead) row never hides a live one for the same code, whatever the list order */
          if(f.Revoked || dead){ if(!map[code]) map[code] = {sku: f.Sku, name: f.ProductName || "", revoked: true}; continue; }
          if(ra.reassign){                                   // review 2: EVERY fix, replayed oldest first (a chain A→B→C ends on C)
            const prev = (map[code] && map[code].reassign) ? (map[code].chain || []) : [];
            const chain = prev.concat([{sku: f.Sku, oldSku: ra.oldSku, at: String(f.LearnedAt || ""), id: Number(it.id) || 0, lid: f.LearnId || "",
                                        others: ra.others, pin: ra.pin, undo: ra.undo, shared: ra.shared}])
              .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
            const last = chain[chain.length - 1];
            map[code] = {sku: last.sku, name: last.sku === f.Sku ? (f.ProductName || "") : ((map[code] || {}).name || ""), reassign: true, oldSku: last.oldSku, chain};
          }
          else if(!map[code] || map[code].revoked) map[code] = {sku: f.Sku, name: f.ProductName || ""};
        }
        url = b && b["@odata.nextLink"] ? String(b["@odata.nextLink"]).replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : null;
      }
      for(const q of S.outbox){ const f = q.fields;
        if(q.reassign){ const prev = (map[f.Code] && map[f.Code].chain) || [];
          let qc = {}; try{ qc = JSON.parse(f.Confirmed || "{}") || {}; }catch(_){ qc = {}; }
          map[f.Code] = {sku: f.Sku, name: f.ProductName, local: true, reassign: true, oldSku: q.oldSku,
                         chain: prev.concat([{sku: f.Sku, oldSku: q.oldSku, at: String(f.LearnedAt || ""), id: 1e12, lid: f.LearnId,
                                              others: qc.others || [], pin: qc.pin === true, undo: qc.undo === true, shared: qc.shared === true}])}; }
        else if(!map[f.Code]) map[f.Code] = {sku: f.Sku, name: f.ProductName, local: true}; }
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
        else if(e && e.permanent){ console.warn("learning refused by SharePoint, dropped", q.fields, e);
          S.refused.push({code: q.fields.Code, sku: q.fields.Sku, why: String((e && e.message) || "refused").slice(0, 160), at: Date.now()}); ls.set(KEY_R, S.refused); }
        else break;                                                   // network / auth: keep it for the next pass
      }
      const saved = S.outbox.shift(); ls.set(KEY_Q, S.outbox);
      if(saved && !S.refused.some(r => r.code === saved.fields.Code && r.at >= saved.at) && typeof RX === "object" && RX.toast) RX.toast(`Learned ${saved.fields.Code} — every tablet knows it within a minute`);
    }
  }catch(_){ /* site lookup failed: retried next pass */ }
  finally{ S.flushing = false; banner(); }
}

/* ── learn errors are VISIBLE: a banner while a learning waits too long to save, or after SharePoint refused one ── */
function banner(){
  let b = el("lnBanner");
  const old = S.outbox.filter(q => Date.now() - (q.at || 0) > STUCK_MS);
  if(!old.length && !S.refused.length){ if(b) b.remove(); return; }
  if(!b){ b = document.createElement("div"); b.id = "lnBanner"; b.setAttribute("role", "alert");
    b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:50;padding:10px max(16px,env(safe-area-inset-left,0px)) calc(10px + env(safe-area-inset-bottom,0px));background:var(--warn-bg,#fff3cd);color:var(--ink,#222);border-top:2px solid var(--warn,#b8860b);font-size:15px";
    document.body.appendChild(b); }
  const parts = [];
  if(old.length) parts.push(`⚠️ <strong>${old.length} new barcode${old.length === 1 ? "" : "s"} not saved to the shared list yet</strong> (${old.map(q => e_(q.fields.Code)).join(", ")}). They are kept on this tablet and retried — keep it online. Other tablets do not know ${old.length === 1 ? "it" : "them"} yet.`);
  if(S.refused.length) parts.push(`⛔ <strong>SharePoint refused ${S.refused.length === 1 ? "a learned barcode" : S.refused.length + " learned barcodes"}</strong>: ${S.refused.map(r => e_(r.code) + " → " + e_(r.sku)).join(", ")}. Other tablets and Finale do not know it. Tell Jack. <button type="button" data-act="learn-banner-ok" style="margin-left:6px;min-height:0;padding:4px 10px">OK</button>`);
  b.innerHTML = parts.join("<br>");
}

/* ── the buyer's list of codes to identify (app/receiving/past_scans.json, read with the signed-in token like the pack) ── */
const ASK_PATH = "TC Farm/Claude Files/Procurement & Merchandising/app/receiving/past_scans.json";
async function loadAsks(force){
  if(typeof graph !== "function") return;
  if(!force && Date.now() - S.asksAt < ASK_MS) return;
  S.asksAt = Date.now();
  try{
    const drive = window.RX && RX.CFG && RX.CFG.pack && RX.CFG.pack.drive_id; if(!drive) return;
    const j = await G(`/drives/${drive}/root:/${ASK_PATH.split("/").map(encodeURIComponent).join("/")}:/content`);
    if(!j || j.kind !== "receiving_past_scans" || !Array.isArray(j.items)) return;
    const map = {};
    for(const it of j.items){
      if(!it || it.status !== "identify" || !Array.isArray(it.candidates) || !it.candidates.length) continue;
      map[pkey(it.code)] = it.candidates.slice(0, 6).map(c => ({sku: String(c.sku || ""), name: String(c.name || ""), truck: !!c.on_that_truck})).filter(c => c.sku);
    }
    S.asks = {built: j.built_utc || "", map}; ls.set(KEY_A, S.asks);
  }catch(_){ /* keep the last copy: the question is a shortcut, never a gate */ }
}
function asksFor(code){
  const bySku = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {};
  const list = (S.asks && S.asks.map && S.asks.map[pkey(code)]) || [];
  return list.filter(c => bySku[c.sku]).slice(0, 4);                // only products this tablet can show and confirm
}

/* ── the flow ── */
function setCandidate(c){
  const code = String((c && c.code) || "");
  S.cand = validCheck(code) ? {code, raw: String(c.raw || code)} : null;
  return !!S.cand;
}
const learnBtn = () => {
  if(!S.cand) return "";
  const asks = asksFor(S.cand.code);
  const q = asks.length ? `<div id="lnAsk" style="margin:0 0 10px;padding:10px;border:1px solid var(--line);border-radius:4px">
      <strong>Is this one of these?</strong> <span class="hint" style="display:inline">The buyer's list suggests them${asks.some(a => a.truck) ? " — the first was on that truck" : ""}. You still open the case and check.</span>
      <div style="margin-top:8px">${asks.map(a => `<button class="lnask" data-act="learn-ask" data-sku="${e_(a.sku)}" style="display:block;width:100%;text-align:left;margin:0 0 6px">${e_(a.name || a.sku)} <span class="num" style="font-size:12px;color:var(--ink-3)">${e_(a.sku)}${a.truck ? " · on that truck" : ""}</span></button>`).join("")}</div></div>` : "";
  return q + `<button class="primary" id="learnStart" data-act="learn-start">Product we carry, new barcode? Learn it</button>`;
};
function sizeOf(name){ const m = /\s-\s([^-]*\d[^-]*)$/.exec(String(name || "")); return m ? m[1].trim() : ""; }
function codesFor(sku){ const out = []; for(const k in CATALOG){ if(CATALOG[k] && CATALOG[k].sku === sku && !CATALOG[k].learned) out.push(k); } return out.slice(0, 3); }
const cancel = `<div class="pcloseRow"><button type="button" class="pclose" data-act="learn-cancel" data-close="3">Cancel — nothing learned</button></div>`;

/* opts (B2, rx/identify.js): {noReplay, onLearned, onDifferent} — learning a carton ALREADY recorded unnamed: nothing is replayed (a
   second receipt would double it); its saved date attaches once the code resolves. */
const T = (n, what) => (S.mode === "wrong" ? "Wrong item — " : "Learn a new barcode — ") + n + " of 3: " + what;
function start(preSku, opts){
  if(!S.cand) return;
  S.mode = "learn";
  S.unitTicked = false; S.pick = null; S.preSku = preSku || null; S.opts = opts || null;
  prompt_("", T(1, "open the case"),
    `New barcode <span class="num">${e_(S.cand.code)}</span>.<br><br>
     <strong>Open the case and take out ONE unit.</strong> Look at the unit's own barcode number.`,
    `<label style="display:flex;gap:10px;align-items:center;margin:8px 0 12px;font-size:16px">
       <input type="checkbox" id="lnUnit" data-act="learn-unit" style="width:24px;height:24px">
       The unit inside shows this same number (${e_(S.cand.code.slice(-6))} at the end)</label>
     <button class="primary" id="lnNext1" data-act="learn-next1" disabled>${S.preSku ? "Next — compare it" : "Next — find the product"}</button>${cancel}`, {noClose: true});
}
function find(){
  prompt_("", T(2, "find the product"),
    `Type the name, brand or SKU of the product <strong>in your hand</strong>. Two sizes read alike — check the size.`,
    `<input id="lnq" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search product"
        placeholder="e.g. coco whip, so delicious, FProd8302Folkl"
        style="width:100%;font-size:18px;padding:11px;border:1px solid var(--line);border-radius:4px;background:var(--ground);color:var(--ink)">
     <div id="lnres" style="margin-top:10px;max-height:46vh;overflow:auto"><div class="hint">Type at least two letters.</div></div>${cancel}`,
    {noClose: true});
  setTimeout(() => { const q = el("lnq"); if(q){ q.focus(); q.addEventListener("input", () => results(q.value)); } }, 30);
  /* PM-3314: the other products on this barcode are the likeliest answer — offered first */
  const alts = (S.mode === "wrong" && S.cand && S.cand.alts) || [];
  if(alts.length) setTimeout(() => { const b = el("lnres"); if(b) b.innerHTML = `<div id="lnDidYou"><strong>Did you mean</strong> (the same barcode is on):</div>` +
    alts.map(p => `<button class="lnpick" data-act="learn-pick" data-sku="${e_(p.sku)}" style="display:block;width:100%;text-align:left;margin:6px 0;padding:11px 13px">
      ${p.br ? `<span style="color:var(--ink-2)">${e_(p.br)}</span> ` : ""}${e_(p.name || p.sku)}<div class="num" style="font-size:12px;color:var(--ink-3)">${e_(p.sku)} · size <strong>${e_(sizeOf(p.name) || "?")}</strong></div></button>`).join("") +
    `<div class="hint">Or type the name, brand or SKU above.</div>`; }, 40);
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
  if(!hits.length){ box.innerHTML = S.mode === "wrong"
      ? `<div class="hint">No match. If it is not in our catalog it is a NEW product and cannot be received yet.</div>
         <button id="lnNotIn" data-act="learn-diff" style="margin-top:8px">It's not in our catalog — set the case aside</button>`
      : `<div class="hint">No match. If it is not in our catalog it is a NEW product — this cannot learn it.
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
  const W = S.mode === "wrong" && S.cand && S.cand.old;
  if(W && p.sku === W.sku && !(S.cand && S.cand.always)){            // the product it was wrongly matched to is never the answer
    find();
    setTimeout(() => { const b = el("lnres"); if(b) b.innerHTML = `<div class="hint" id="lnSame0" style="color:var(--stop)"><strong>That is the product it is already matched to.</strong>
      If the product is right and only the DATE is wrong, Cancel and change the date. Otherwise search for the product that is really in the box.</div>`; }, 40);
    return;
  }
  prompt_("", T(3, "is it identical?"),
    (W && S.cand.always ? `This barcode is on ${S.cand.alts.length + 1} products. Confirm it is ALWAYS this one.<br>` :
     W ? `This barcode was matched to <s>${e_(W.name || W.sku)}</s> <span class="num">${e_(W.sku)}</span> — that is what you said is wrong.<br>` : "") +
    `Compare the unit in your hand with what the app has. ⛔ Only if ALL of it matches.`,
    `<table style="width:100%;border-collapse:collapse;font-size:15px;margin:4px 0 10px">
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Brand</td><td><strong>${e_(p.br || "—")}</strong></td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Product</td><td><strong>${e_(p.name || "")}</strong></td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Size</td><td><strong style="font-size:18px">${e_(sizeOf(p.name) || "see the name")}</strong></td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">SKU</td><td class="num">${e_(p.sku)}</td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Storage</td><td>${e_(p.cls || "?")}${p.pack ? ` · ${e_(p.pack)} per case` : ""}</td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">Old barcode</td><td class="num">${e_(codesFor(p.sku).join(", ") || "none on file")}</td></tr>
       <tr><td style="color:var(--ink-3);padding:3px 8px 3px 0">${W ? "This barcode" : "NEW barcode"}</td><td class="num"><strong>${e_(S.cand.code)}</strong></td></tr>
     </table>
     ${tick("lnSame", "Same product — brand and name match the unit")}
     ${tick("lnSize", `Same size / weight${sizeOf(p.name) ? " (" + e_(sizeOf(p.name)) + ")" : ""}`)}
     ${tick("lnVar", "Same flavour / variety")}
     ${(W && S.cand.alts && S.cand.alts.length && !S.cand.always) ? `<label style="display:flex;gap:10px;align-items:center;margin:10px 0 6px;font-size:16px;border-top:1px solid var(--line);padding-top:10px">
        <input type="checkbox" id="lnAlways" style="width:24px;height:24px"> Always this product for this barcode <span class="hint" style="display:inline">(otherwise only this case changes — this barcode is on ${S.cand.alts.length + 1} products)</span></label>` : ""}
     <div style="margin-top:10px"><button class="primary" id="lnLearn" data-act="learn-commit" disabled>${W ? "Correct it to this product" : "Learn this barcode"}</button>
     ${W ? `<button id="lnDiff" data-act="learn-back">Not this one — search again</button>`
         : `<button id="lnDiff" data-act="learn-diff">Not the same — it's a different product</button>`}
     <button id="lnBack" data-act="learn-back">Back — pick another</button></div>${cancel}`, {noClose: true});
}
function ticksOk(){ return ["lnSame", "lnSize", "lnVar"].every(id => { const x = el(id); return x && x.checked; }); }

async function commit(){
  if(!S.cand || !S.pick || !ticksOk() || !S.unitTicked) return;
  if(S.mode === "wrong") return commitWrong();
  const code = S.cand.code, p = S.pick, raw = S.cand.raw;
  const conf = {same_product: true, same_size: true, same_variety: true, unit_opened: true, asked: !!S.preSku && S.preSku === p.sku,
                shown: {name: p.name || "", br: p.br || "", size: sizeOf(p.name), old: codesFor(p.sku)}};
  const fields = {Title: "learn " + code, LearnId: newId(), Code: code, Sku: p.sku, ProductName: String(p.name || "").slice(0, 250),
                  Confirmed: JSON.stringify(conf).slice(0, 4000), Operator: (typeof account === "string" ? account : "") || "",
                  Device: (typeof device === "string" ? device : "") || "", LearnedAt: new Date().toISOString()};
  S.outbox.push({fields, at: Date.now()}); ls.set(KEY_Q, S.outbox);
  S.learned[code] = {sku: p.sku, name: p.name || "", local: true}; ls.set(KEY_C, S.learned);
  try{ if(typeof reject === "function") reject("ALIAS", `${code} -> ${p.sku}`, code); }catch(_){}
  if(!CATALOG[code] || CATALOG[code].sku === p.sku) CATALOG[code] = Object.assign({}, p, {learned: true});
  flush();
  const o = S.opts; S.cand = null; S.pick = null; S.preSku = null; S.opts = null;
  if(o && o.noReplay){                                                 // B2: a carton already recorded — never a second receipt
    if(typeof clearPrompt === "function") clearPrompt();
    try{ if(o.onLearned) o.onLearned(p.sku); }catch(_){}
    if(typeof RX === "object" && RX.toast) RX.toast(`Learning ${code} as ${p.name || p.sku} — the recorded case attaches to it`);
    return;
  }
  try{ pending = null; unresolved = null; }catch(_){}
  if(typeof clearPrompt === "function") clearPrompt();
  if(typeof handleScan === "function") await handleScan(raw);        // the case carries on as the confirmed product
}
function different(){
  const code = S.cand ? S.cand.code : "";
  S.mode = "learn";                                                    // a wrong-item search that found nothing ends here too
  const o = S.opts; S.opts = null;
  if(o && o.noReplay){                                                 // B2: classify the recorded carton; there is no pending scan to clear
    try{ if(o.onDifferent) o.onDifferent(); }catch(_){}
  }
  try{ if(typeof reject === "function") reject("SKIPPED", `${code} :: different product - new item`, code); }catch(_){}
  S.cand = null; S.pick = null;
  try{ pending = null; unresolved = null; }catch(_){}
  prompt_("", "Not learned — set the case aside",
    `This is a <strong>different product</strong>, so it needs to be created before it can be received.
     The skip and its reason are recorded. ⛔ Set the case aside; do not put it away.`);
}
function cancelFlow(){
  if(S.mode === "wrong"){                                              // PM-3303: nothing changed — back to the item that was open
    S.mode = "learn"; S.cand = null; S.pick = null;
    if(typeof pending === "object" && pending && typeof next === "function") return next();
    if(typeof clearPrompt === "function") clearPrompt(); return;
  }
  const o = S.opts; S.pick = null; S.preSku = null; S.opts = null;
  if(o && o.noReplay){ if(typeof clearPrompt === "function") clearPrompt(); return; }   // B2: nothing was pending — never clear a scan
  try{ pending = null; unresolved = null; }catch(_){}
  if(typeof clearPrompt === "function") clearPrompt();
}

/* ── PM-3303: WRONG ITEM — the open scan resolved to the wrong product ── */
/* ⛔ misuse review 1: ONLY the code that was SCANNED moves. A case code (GTIN-14) is the scanned code whenever there is one; its derived
   consumer UPC is never moved with it, or a mis-packed case would re-point the real product's own retail barcode for every tablet. */
function wrongCodes(p){
  const old = p && p.prod; if(!old || !old.sku || String(old.sku).startsWith("!")) return [];
  const g = String(p.gtin || "").replace(/\D/g, ""), u = String(p.upc || "").replace(/\D/g, "");
  const code = g.length === 14 ? g : u;
  if(!code) return [];
  const cur = CATALOG[code] || (code === g && u ? CATALOG[u] : null);
  const catSku = (p.dup && p.dup.primary) || old.sku;                 // PM-3314: the product the CATALOG maps the barcode to
  return (cur && cur.sku === catSku) ? [code] : [];
}
const wrongBtn = () => {
  try{
    const ok = typeof pending === "object" && pending && wrongCodes(pending).length && !(typeof isAudit === "function" && isAudit());
    const d = ok && pending.dup, others = d ? d.all.filter(x => x.sku !== pending.prod.sku) : [];
    const note = d ? `<div id="dupNote" style="margin-top:10px;padding:9px 12px;background:var(--card);border-left:5px solid var(--wait)">
        This barcode is also on <strong>${others.map(x => e_(x.name || x.sku)).join("</strong>, <strong>")}</strong> —
        ${d.how === "po" ? "matched to the one <strong>on this order</strong>" : "you picked this one"}. Not this product? Correct it below.</div>` : "";
    return ok ? note + `<button id="wrongItem" data-act="wrong-start" style="margin-top:10px">Different product in the box? Correct it</button>` : "";
  }catch(_){ return ""; }
};
function wrongItem(){
  if(typeof pending !== "object" || !pending) return;
  const codes = wrongCodes(pending); if(!codes.length) return;
  const old = pending.prod;
  S.mode = "wrong"; S.cand = {code: codes[0], codes, raw: codes[0], old: {sku: old.sku, name: old.name || "", br: old.br || ""},
                              catSku: (pending.dup && pending.dup.primary) || old.sku,
                              alts: pending.dup ? pending.dup.all.filter(x => x.sku !== old.sku) : []};
  S.unitTicked = false; S.pick = null; S.preSku = null; S.opts = null;
  prompt_("", T(1, "open the case"),
    `The app matched barcode <span class="num">${e_(codes[0])}</span> to<br><strong>${e_(old.name || old.sku)}</strong>
     <span class="num">${e_(old.sku)}</span>.<br><br><strong>Open the case and take out ONE unit.</strong>`,
    `<label style="display:flex;gap:10px;align-items:center;margin:8px 0 12px;font-size:16px">
       <input type="checkbox" id="lnUnit" data-act="learn-unit" style="width:24px;height:24px">
       I opened the case — the product inside is NOT ${e_(old.name || old.sku)}</label>
     <button class="primary" id="lnNext1" data-act="learn-next1" disabled>Next — find the right product</button>
     <div class="pcloseRow"><button type="button" class="pclose" data-act="learn-cancel" data-close="3">Cancel — keep it as it was</button></div>`,
    {noClose: true});
}
/* PM-3314: "Always this product for this barcode" after a pick on a shared barcode — the same screens, starting from the picked product */
function alwaysThis(){
  if(typeof pending !== "object" || !pending || !pending.dup) return (typeof next === "function") ? next() : null;
  const codes = wrongCodes(pending); if(!codes.length) return next();
  const cur = pending.prod;
  S.mode = "wrong"; S.cand = {code: codes[0], codes, raw: codes[0], old: {sku: cur.sku, name: cur.name || "", br: cur.br || ""},
                              catSku: pending.dup.primary, alts: pending.dup.all.filter(x => x.sku !== cur.sku), always: true};
  S.unitTicked = false; S.pick = null; S.preSku = cur.sku; S.opts = null;
  prompt_("", T(1, "open the case"),
    `Barcode <span class="num">${e_(codes[0])}</span> is on ${pending.dup.all.length} products. You picked<br><strong>${e_(cur.name || cur.sku)}</strong>.
     <br><br><strong>Open the case and take out ONE unit.</strong>`,
    `<label style="display:flex;gap:10px;align-items:center;margin:8px 0 12px;font-size:16px">
       <input type="checkbox" id="lnUnit" data-act="learn-unit" style="width:24px;height:24px">
       I opened the case — the product inside is ${e_(cur.name || cur.sku)}</label>
     <button class="primary" id="lnNext1" data-act="learn-next1" disabled>Next — compare it</button>
     <div class="pcloseRow"><button type="button" class="pclose" data-act="learn-cancel" data-close="3">Cancel — just this case</button></div>`,
    {noClose: true});
}
function commitWrong(){
  const c = S.cand, p = S.pick, old = c.old;
  if(!c || !p || typeof pending !== "object" || !pending) return;
  if(p.sku === old.sku && !c.always){ return; }
  const ab = el("lnAlways"); if(ab && ab.checked) c.always = true;
  /* ⛔ review 1/2 (2026-10-28): on a SHARED barcode a correction without "Always" re-labels THIS CASE ONLY — a 6-pack case must not take
     the barcode off the single can everywhere. Nothing is written; the barcode keeps asking. */
  if(c.alts && c.alts.length && !c.always){
    const base0 = Object.assign({}, p); delete base0.alt; delete base0.altOnly;
    pending.prod = Object.assign(base0, {}); delete pending.dup;
    S.mode = "learn"; S.cand = null; S.pick = null;
    if(typeof RX === "object" && RX.toast) RX.toast(`This case is ${p.name || p.sku}. The barcode still asks which product — tick "Always" to settle it.`);
    if(typeof next === "function") next();
    return;
  }
  const catSku = c.catSku || old.sku, pin = !!c.always && p.sku === catSku;
  /* PM-3314: `others` = every other live product on the barcode — the mini takes the barcode off them in BigCommerce and Finale */
  const others = [...new Set([catSku].concat((c.alts || []).map(x => x.sku)))].filter(x => x && x !== p.sku);
  const conf = {same_product: true, same_size: true, same_variety: true, unit_opened: true, reassign: true, old_sku: catSku,
                pin, others, shared: !!(c.alts && c.alts.length), shown: {name: p.name || "", br: p.br || "", size: sizeOf(p.name), old_name: old.name || ""}};
  for(const code of c.codes){
    const fields = {Title: "reassign " + code, LearnId: newId(), Code: code, Sku: p.sku, ProductName: String(p.name || "").slice(0, 250),
                    Confirmed: JSON.stringify(conf).slice(0, 4000), Operator: (typeof account === "string" ? account : "") || "",
                    Device: (typeof device === "string" ? device : "") || "", LearnedAt: new Date().toISOString()};
    S.outbox.push({fields, at: Date.now(), reassign: true, oldSku: catSku, others});
    const prev = (S.learned[code] && S.learned[code].chain) || [];
    S.learned[code] = {sku: p.sku, name: p.name || "", local: true, reassign: true, oldSku: catSku,
                       chain: prev.concat([{sku: p.sku, oldSku: catSku, at: fields.LearnedAt, id: 1e12, lid: fields.LearnId, others, pin, shared: conf.shared}])};
    try{ if(typeof reject === "function") reject("REASSIGN", `${code}>${p.sku}<${catSku}`, code); }catch(_){}   /* compact (60 chars); new = old is a PIN */
    const base = Object.assign({}, p); delete base.alt; delete base.altOnly;
    CATALOG[code] = Object.assign(base, {learned: true, reassigned: true});   // wrongCodes() proved it maps to the catalog's product
  }
  ls.set(KEY_Q, S.outbox); ls.set(KEY_C, S.learned);
  flush();
  /* the open case carries on as the right product — its date and lot stay; anything worked out FROM the wrong product does not */
  pending.prod = CATALOG[c.codes[0]] || p; delete pending.dup;
  if(/^(audit_)?gs1_lot/.test(String(pending.source || ""))) pending.source = String(pending.source).replace(/gs1_lot/, "keyed_gs1nodate");
  if(pending.lotAuto){ pending.best = null; pending.lotAuto = null; }
  /* review 3: the old product's "never has a date" flag is not the new product's (an 'always' confirms the product already worked out) */
  if(pending.noDate && !c.always){ pending.source = pending.preNoDateSource || String(pending.source || "").replace(/no_date_on_package/, "keyed_bare");
    pending.noDate = false; delete pending.preNoDateSource; pending.best = null; }
  /* review 4: a date carried over FROM the old product (its last case, its lot format) is asked again */
  if(!c.always && /\+(lastcase|lotsuggest)/.test(String(pending.source || ""))){ pending.best = null; pending.source = String(pending.source).replace(/\+(lastcase|lotsuggest)/g, ""); }
  if(pending.suggest && pending.suggest.tag !== "datelabel") pending.suggest = null;
  delete pending.dateConfirmed; delete pending.qtyShown;
  S.mode = "learn"; S.cand = null; S.pick = null;
  if(typeof RX === "object" && RX.toast) RX.toast(pin ? `${c.codes[0]} is now always ${p.name || p.sku} on every tablet`
                                                       : `Corrected: ${c.codes[0]} is now ${p.name || p.sku} on every tablet`);
  if(typeof next === "function") next();
}

/* ── PM-3306: BARCODE CORRECTIONS — every crew move, newest first, each with Undo (Jack, 2026-10-28: "undoing it and starting over
   would be fine"). Undo writes the REVERSE move (the barcode back on the product it came from; `undo_of` names the move), so every
   tablet, the catalog, Finale and the stores follow it exactly as they followed the move. A settled barcode (a pin) has nothing to undo. */
function fixesList(){
  const bySku = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {};
  const out = [];
  for(const code in S.learned){
    const L = S.learned[code]; if(!L || !L.reassign || L.revoked) continue;
    const ch = L.chain || [{sku: L.sku, oldSku: L.oldSku, at: ""}], last = ch[ch.length - 1];
    if(!last || last.undo) continue;                                   // an undo has nothing further to undo
    const isPin = last.sku === last.oldSku;
    if(isPin && !(last.others || []).length) continue;                 // a pin that took the barcode off nothing
    out.push({code, now: last.sku, was: last.oldSku, at: last.at || "", lid: last.lid || "", pin: isPin, others: last.others || [], shared: !!last.shared,
              nowName: (bySku[last.sku] || {}).name || L.name || last.sku, wasName: (bySku[last.oldSku] || {}).name || last.oldSku});
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 25);
}
function showFixes(){
  const xs = fixesList();
  prompt_("", "Barcode corrections",
    xs.length ? `Newest first. <strong>Undo</strong> puts the barcode back on the product it was on — every tablet, BigCommerce and Finale follow.`
              : `No barcode has been corrected on the tablets yet.`,
    xs.map(x => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
        <span class="num">${e_(x.code)}</span> is now ${x.pin ? "always " : ""}<strong>${e_(x.nowName)}</strong> <span class="num" style="color:var(--ink-3)">${e_(x.now)}</span><br>
        ${x.pin ? `taken off <s>${e_(x.others.join(", "))}</s>` : `was <s>${e_(x.wasName)}</s> <span class="num" style="color:var(--ink-3)">${e_(x.was)}</span>`}
        ${x.at ? `<span class="hint" style="display:inline"> · ${e_(new Date(x.at).toLocaleString([], {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}))}</span>` : ""}
        <div id="fixAsk-${e_(x.code)}"><button data-act="fix-undo" data-code="${e_(x.code)}" style="margin-top:6px">Undo</button></div></div>`).join(""));
}
function undoAsk(code){
  const x = fixesList().find(y => y.code === code), box = el("fixAsk-" + code); if(!x || !box) return;
  box.innerHTML = `<div style="margin-top:6px">Put <span class="num">${e_(code)}</span> back on <strong>${e_(x.pin ? x.others.join(", ") : x.wasName)}</strong>?
    <button class="primary" data-act="fix-undo-yes" data-code="${e_(code)}">Yes, put it back</button>
    <button data-act="fix-undo-no" data-code="${e_(code)}">No</button></div>`;
}
function undoFix(code){
  const x = fixesList().find(y => y.code === code); if(!x) return;
  const bySku = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {};
  const back = bySku[x.was] || {sku: x.was, name: x.wasName};
  /* review 3/4: put the barcode back on EVERY product the move took it off (the old one, and any others on a shared barcode); a pin's
     undo keeps it on the pinned product and restores the others, so the barcode asks again */
  /* a move on a SHARED barcode is undone by giving the barcode back to everyone who had it (nobody loses it); a plain move takes it off
     the product it was moved to */
  const restore = [...new Set([x.was].concat(x.others || []))].filter(s0 => s0 && !(x.pin && s0 === x.now));
  const conf = {reassign: true, old_sku: x.now, others: (x.pin || x.shared) ? [] : [x.now], restore, undo_of: x.lid || (code + "@" + x.at), undo: true,
                shown: {name: back.name || "", old_name: x.nowName}};
  const fields = {Title: "reassign " + code, LearnId: newId(), Code: code, Sku: x.was, ProductName: String(back.name || "").slice(0, 250),
                  Confirmed: JSON.stringify(conf).slice(0, 4000), Operator: (typeof account === "string" ? account : "") || "",
                  Device: (typeof device === "string" ? device : "") || "", LearnedAt: new Date().toISOString()};
  S.outbox.push({fields, at: Date.now(), reassign: true, oldSku: x.now, others: conf.others});
  const prev = (S.learned[code] && S.learned[code].chain) || [];
  S.learned[code] = {sku: x.was, name: back.name || "", local: true, reassign: true, oldSku: x.now,
                     chain: prev.concat([{sku: x.was, oldSku: x.now, at: fields.LearnedAt, id: 1e12, lid: fields.LearnId, others: conf.others, undo: true}])};
  ls.set(KEY_Q, S.outbox); ls.set(KEY_C, S.learned);
  try{ if(typeof reject === "function") reject("REASSIGN", `${code}>${x.was}<${x.now}~u`, code); }catch(_){}   /* ~u: an undo — the catalog restores its own entry */
  if(x.pin && CATALOG[code]){                                         // a pin undone: the barcode asks again, here and now
    const b0 = Object.assign({}, CATALOG[code]); delete b0.reassigned;
    b0.alt = (x.others || []).map(s0 => { const a = Object.assign({}, bySku[s0] || {sku: s0}); delete a.alt; delete a.altOnly; return a; });
    CATALOG[code] = b0;
  } else if(CATALOG[code] && CATALOG[code].sku === x.now && bySku[x.was]){
    const b0 = Object.assign({}, bySku[x.was]); delete b0.altOnly;
    if(x.shared) b0.alt = [x.now].concat(x.others || []).filter(s0 => s0 !== x.was).map(s0 => { const a = Object.assign({}, bySku[s0] || {sku: s0}); delete a.alt; delete a.altOnly; return a; });
    else { delete b0.alt; b0.reassigned = true; }
    CATALOG[code] = Object.assign(b0, {learned: true}); }
  flush();
  if(typeof RX === "object" && RX.toast) RX.toast(`Undone: ${code} is back on ${back.name || x.was} on every tablet`);
  showFixes();
}

/* ── PM-2923 (Jack, 2026-10-20): "we know what this product is, it needs to be finalized in the product listing, please ask
   whoever is working on that to finish it". The mini publishes Receiving/pending_products.json (lib/pending_products.py) on the
   ClaudeAgents drive; a code the catalog cannot resolve is looked up there BEFORE it is called unknown. ── */
const PEND_PATH = "Receiving/pending_products.json", KEY_P = "pending_products_v1", PEND_MS = 60000;
S.pend = ls.get(KEY_P, null);
S.pendAt = 0;
const pkey = (c) => String(c == null ? "" : c).replace(/\D/g, "").replace(/^0+/, "");
async function loadPending(force){
  if(typeof graph !== "function") return;
  if(!force && Date.now() - S.pendAt < PEND_MS) return;
  S.pendAt = Date.now();
  try{
    await ids();
    const j = await G(`/sites/${S.siteId}/drive/root:/${PEND_PATH.split("/").map(encodeURIComponent).join("/")}:/content`);
    if(j && j.items && typeof j.items === "object"){ S.pend = j; ls.set(KEY_P, j); }
  }catch(_){ /* keep the last copy; its `built` time is shown */ }
}
async function pendingFor(codes){
  await loadPending(false);
  const items = (S.pend && S.pend.items) || {};
  for(const c of codes || []){ const k = pkey(c); if(k && items[k]) return Object.assign({_built: S.pend.built || "", _code: String(c)}, items[k]); }
  return null;
}
function builtText(iso){
  const ms = Date.parse(iso || ""); if(isNaN(ms)) return "";
  const d = new Date(ms); return d.toLocaleString([], {month:"numeric", day:"numeric", hour:"numeric", minute:"2-digit"});
}
function showPending(it){
  try{ if(typeof reject === "function") reject("PENDING_PRODUCT", `${it._code} :: ${it.status} ${it.sku || ""}`.slice(0, 60), it._code); }catch(_){}
  prompt_("stop", "We know this product — it's still being set up",
    `<strong>${e_(it.brand ? it.brand + " " : "")}${e_(it.name || it.sku || "")}</strong>${it.storage ? ` · ${e_(it.storage)}` : ""}
     <br>Barcode <span class="num">${e_(it._code)}</span>${it.sku ? ` · SKU <span class="num">${e_(it.sku)}</span>` : ""}
     <br><br>${e_(it.says)}<br><strong>${e_(it.ask)}</strong>
     <br>Once it is finished in the Listing Studio it can be received in Finale and published.
     <br><span class="hint">Listing Studio status as of ${e_(builtText(it._built) || "unknown")}.</span>`,
    `<div style="margin-top:6px"><button class="primary" id="pendGo">Enter the date and hold the case</button>
       <button id="pendSkip">Skip this carton</button>
       <div class="hint">Put the case in the HOLDING area. The date attaches to the product automatically once it is set up —
         nobody has to match it by hand.</div></div>`);
}
setTimeout(() => { loadPending(true); }, 3500);

/* Clicks go through the core router (RX.registerAct) so the coverage gate sees a handler for every learn-* button. */
const ACTS = { "learn-start": () => start(), "learn-cancel": () => cancelFlow(),
               "learn-next1": () => { if(!S.unitTicked) return; const bySku = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {}; if(S.preSku && bySku[S.preSku]) confirm_(S.preSku); else find(); },
               "learn-ask": (a) => start(a.el.getAttribute("data-sku")),
               "learn-banner-ok": () => { S.refused = []; ls.set(KEY_R, S.refused); banner(); },
               "learn-pick": (a) => confirm_(a.el.getAttribute("data-sku")), "learn-back": () => find(),
               "learn-diff": () => different(), "learn-commit": () => { commit(); },
               "learn-unit": (a) => { S.unitTicked = !!a.el.checked; const b = el("lnNext1"); if(b) b.disabled = !S.unitTicked; },
               "learn-tick": () => { const b = el("lnLearn"); if(b) b.disabled = !ticksOk(); },
               "wrong-start": () => wrongItem(),
               "fix-undo": (a) => undoAsk(a.el.getAttribute("data-code")), "fix-undo-no": () => showFixes(),
               "fix-undo-yes": (a) => undoFix(a.el.getAttribute("data-code")) };
if(window.RX && RX.registerAct){
  for(const n of ["learn-start", "learn-cancel", "learn-next1", "learn-pick", "learn-back", "learn-diff", "learn-commit", "learn-unit", "learn-tick", "learn-ask", "learn-banner-ok", "wrong-start", "fix-undo", "fix-undo-yes", "fix-undo-no"])
    RX.registerAct(n, (a) => { ACTS[n](a); return (n === "learn-unit" || n === "learn-tick") ? undefined : "stop"; });
}
document.addEventListener("change", (e) => {
  const t = e.target; if(!t || !t.getAttribute) return;
  const act = t.getAttribute("data-act");
  if(act === "learn-unit"){ S.unitTicked = !!t.checked; const b = el("lnNext1"); if(b) b.disabled = !S.unitTicked; }
  if(act === "learn-tick"){ const b = el("lnLearn"); if(b) b.disabled = !ticksOk(); }
});

setTimeout(() => { refresh(true); flush(); loadAsks(true); banner(); }, 3000);
setInterval(() => { refresh(false); flush(); loadAsks(false); banner(); }, REFRESH_MS);
window.RXLearn = { setCandidate, start, apply, refresh, flush, learnBtn, wrongItem, wrongBtn, wrongCodes, alwaysThis, showFixes, fixesList, validCheck, sizeOf, pendingFor, showPending, loadPending, loadAsks, asksFor, banner, state: S };
})();
