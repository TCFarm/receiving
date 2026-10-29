/* receiving/rx/photos.js — ROUND 4 (Jack, 2026-10-19, DECISIONS D36): DAMAGED UNITS NEED EVIDENCE.
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   THE RULE: when a person records damaged units ("Some damaged" on the quantity card, or a whole damaged case) the item CANNOT finish
   until at least one photo is taken or attached. Several photos are allowed; thumbnails show; one optional line says what is wrong.
   • The photos go to the page's EXISTING photo folder (`BB Receipts Photos`, the same `driveId` / `getToken` / `shrink` the failed-scan
     photo uses). The uploaded files' web links are written to the intent's `PhotoUrls` (JSON list); the optional note goes to the
     intent's `FixNote` (text, ≤ 250 chars; on an intent row it carries this note — Julia's credit tab reads it).
   • ⛔ DAMAGED UNITS ARE STILL NEVER RECEIVED (unchanged): they ride on `DamagedUnits` and feed the KeHE credit list.
   • ⭐ OFFLINE CHOICE (never lose evidence): a photo that cannot be uploaded now (no signal / no library / signed out) is KEPT ON THE
     TABLET in IndexedDB (`rx_photos_v1`, the blob itself) and the item MAY finish — the intent is written without those links and a
     later sync (tick / `online` / boot) uploads the photo and queues `RX.intents.setPhotoUrls`, a patch that is applied even if the poster
     already acted and is retried, never dropped. A queued photo counts in "On tablet n" (RX.unsentCount) and in the unload warning.
     ⛔ If this tablet CANNOT hold a photo (IndexedDB unavailable) and the upload failed, finishing is BLOCKED with a plain message
     rather than lose the evidence.
   • Back / Escape: nothing is recorded; the photos of a Back stay with the item (so a changed count does not mean re-taking them);
     they are discarded only when the item is dropped (RX.emit "abandon") or committed with no intent.

   API (RX.photos): askAll(p,k) pending() sync() list() canQueue() idbOK   — acts: photo-go photo-back photo-remove */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const PH = RX.photos = {};
const esc = RX.esc, t0 = RX.t;
const COPY_ADD = {
  ph_title:    "Photos of the damage — {n} damaged",
  ph_body:     "KeHE needs proof to credit damaged units. Take at least one photo: the damage and the case label.",
  ph_sub:      "{n} damaged — not received. They go on the KeHE credit list.",
  ph_take:     "📷 Take a photo",
  ph_attach:   "Attach photos",
  ph_note_ph:  "What's wrong? (optional)",
  ph_go:       "Continue",
  ph_need:     "Take at least one photo first — KeHE will not credit damage without one.",
  ph_remove:   "Remove",
  ph_saved:    "Saved ✓",
  ph_up:       "Uploading…",
  ph_wait:     "Waiting for signal — kept on this tablet",
  ph_noqueue:  "No signal, and this tablet cannot keep a photo. Wait for signal, then press Continue.",
  ph_all_flash:"Nothing to put away — recorded as damaged for purchasing.",
};
for(const k of Object.keys(COPY_ADD)) if(!(k in RX.COPY)) RX.COPY[k] = COPY_ADD[k];
const t = RX.t;

(function css(){
  if(document.getElementById("rxPhCss")) return;
  const s = document.createElement("style"); s.id = "rxPhCss";
  s.textContent = `.rx-ph-th{display:inline-block;margin:6px 8px 6px 0;vertical-align:top;width:110px}
.rx-ph-th img{display:block;width:110px;height:80px;object-fit:cover;border:1px solid var(--line);border-radius:4px}
.rx-ph-st{display:block;font-size:12px;color:var(--ink-2);margin:2px 0}
.rx-ph-lbl{display:inline-flex;align-items:center;justify-content:center;min-height:56px;padding:0 16px;cursor:pointer}
.rx-ph-note{width:100%;font-size:18px;padding:10px;margin:8px 0;min-height:48px;border:1px solid var(--line);border-radius:4px;background:var(--ground);color:var(--ink)}`;
  document.head.appendChild(s);
})();

/* ───────────────────────── the queue: memory mirror + IndexedDB ───────────────────────── */
const Q = new Map();                 // id -> entry {id, iid, name, blob, url, linked, draft, at, sku}
PH.idbOK = true;
let dbp = null;
function openDb(){
  if(dbp) return dbp;
  dbp = new Promise((res, rej) => {
    try{
      const r = indexedDB.open("rx_photos_v1", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("q", {keyPath: "id"}); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("idb"));
    }catch(e){ rej(e); }
  });
  return dbp;
}
function dbDo(fn){
  return openDb().then(db => new Promise((res, rej) => {
    const tx = db.transaction("q", "readwrite"), st = tx.objectStore("q");
    let out; try{ out = fn(st); }catch(e){ rej(e); return; }
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    tx.onerror = tx.onabort = () => rej(tx.error || new Error("idb tx"));
  }));
}
const persist = (e) => { if(!PH.idbOK) return Promise.resolve(); const o = {}; for(const k of Object.keys(e)) if(k !== "up" && k !== "th") o[k] = e[k];
  return dbDo(st => st.put(o)).catch(() => { PH.idbOK = false; }); };
const unpersist = (id) => { if(!PH.idbOK) return Promise.resolve(); return dbDo(st => st.delete(id)).catch(() => {}); };
PH.canQueue = () => !!PH.idbOK;
PH.list = () => [...Q.values()];
PH.pending = () => [...Q.values()].filter(e => !e.draft && (!e.url || !e.linked)).length;

RX.onBoot(() => {
  openDb().then(() => dbDo(st => st.getAll())).then(all => {
    for(const e of (all || [])){
      if(e.draft){ unpersist(e.id); continue; }          // a session that never finished: nothing was recorded
      if(!Q.has(e.id)) Q.set(e.id, e);
    }
    setTimeout(PH.sync, 800);
  }).catch(() => { PH.idbOK = false; });
});

/* ───────────────────────── upload ───────────────────────── */
async function putBlob(blob, name){
  let drv = null; try{ drv = driveId; }catch(_){}
  if(!drv) throw new Error("no document library");
  const tk = await getToken();
  const ctrl = new AbortController(); const tm = setTimeout(() => { try{ ctrl.abort(); }catch(_){} }, 30000);
  try{
    const r = await fetch(`${GRAPH}/drives/${drv}/root:/${PHOTO_FOLDER}/${name}:/content`,
      {method: "PUT", headers: {Authorization: "Bearer " + tk, "Content-Type": "image/jpeg"}, body: blob, signal: ctrl.signal});
    if(!r.ok) throw new Error("upload " + r.status);
    const j = await r.json();
    if(!j || !j.webUrl) throw new Error("no link returned");
    return j.webUrl;
  } finally { clearTimeout(tm); }
}
function uploadEntry(e){
  if(e.up) return e.up;
  if(!e.blob) return Promise.resolve();
  e.up = (async () => {
    try{ e.url = await putBlob(e.blob, e.name); e.err = ""; e.blob = null; await persist(e); }
    catch(err){ e.err = (err && err.message) || "upload failed"; }
    finally{ e.up = null; }
  })();
  return e.up;
}
let syncing = false;
PH.sync = async function(){
  if(syncing) return; syncing = true;
  try{
    try{ if(needsSignIn) return; }catch(_){}
    const act = S ? S.p.rx.iid : null;
    for(const e of [...Q.values()]){ if(!e.draft && !e.url) await uploadEntry(e); }
    const by = new Map();
    for(const e of Q.values()){ if(e.draft) continue; (by.get(e.iid) || by.set(e.iid, []).get(e.iid)).push(e); }
    for(const [iid, es] of by){
      if(iid === act) continue;
      const rec = RX.intents.byId(iid);
      if(!rec){ if(RX.now() - Math.min(...es.map(x => x.at || 0)) > 7 * 86400000){ for(const e of es){ Q.delete(e.id); unpersist(e.id); } } continue; }
      const urls = es.filter(e => e.url).map(e => e.url);
      if(urls.length && es.some(e => e.url && !e.linked)){
        RX.intents.setPhotoUrls(iid, urls);
        for(const e of es) if(e.url){ e.linked = true; persist(e); }
      }
      if(es.every(e => e.url && e.linked)){ for(const e of es){ Q.delete(e.id); unpersist(e.id); } }
    }
  }catch(err){ try{ console.error("rx photos sync", err); }catch(_){} }
  finally{ syncing = false; RX.refresh(); }
};
let lastSync = 0;
RX.on("tick", (now) => { if(Q.size && now - lastSync >= (RX.CFG.FLUSH_TICK || 15000)){ lastSync = now; PH.sync(); } });
window.addEventListener("online", () => { PH.sync(); });

/* ───────────────────────── the session (the card) ───────────────────────── */
let S = null;         // {p, ctx, mode, k, ph, notice}
const phOf = (p) => { p.rx = p.rx || {}; p.rx.iid = p.rx.iid || RX.newId(); return p.rx.ph = p.rx.ph || {items: [], note: ""}; };
const thumbUrl = (e) => { if(!e.th && e.blob){ try{ e.th = URL.createObjectURL(e.blob); }catch(_){} } return e.th || ""; };
function stateText(e){ return e.url ? t("ph_saved") : (e.up ? t("ph_up") : t("ph_wait")); }
function render(){
  if(!S) return;
  const p = S.p, ph = S.ph;
  const note = document.getElementById("rxPhNote"); if(note) ph.note = note.value;
  const th = ph.items.map((e, i) => `<span class="rx-ph-th" data-id="${esc(e.id)}"><img alt="photo ${i + 1}" src="${esc(thumbUrl(e))}">
      <span class="rx-ph-st">${esc(stateText(e))}</span><button type="button" class="rx-btn" data-act="photo-remove" data-id="${esc(e.id)}">${esc(t("ph_remove"))}</button></span>`).join("");
  const body = `<strong>${esc(p.prod.name)}</strong><span class="rx-pa-sub">${esc(t("ph_sub", {n: S.k}))}</span><span class="rx-pa-sub">${esc(t("ph_body"))}</span>` +
    `<span id="rxPhThumbs" style="display:block">${th}</span>` +
    (S.notice ? `<span class="rx-pa-note" role="alert">${esc(S.notice)}</span>` : "") +
    `<input id="rxPhNote" class="rx-ph-note" type="text" maxlength="200" autocomplete="off" placeholder="${esc(t("ph_note_ph"))}" aria-label="${esc(t("ph_note_ph"))}" value="${esc(ph.note || "")}">`;
  const acts = `<div class="rx-pa-btns"><label class="rx-btn rx-ph-lbl" for="rxPhCam">${esc(t("ph_take"))}</label><input id="rxPhCam" type="file" accept="image/*" capture="environment" style="display:none">
      <label class="rx-btn rx-ph-lbl" for="rxPhPick">${esc(t("ph_attach"))}</label><input id="rxPhPick" type="file" accept="image/*" multiple style="display:none"></div>
    <div class="rx-pa-btns"><button type="button" class="rx-btn primary" data-act="photo-go" data-primary>${esc(t("ph_go"))}</button>
      <button type="button" class="rx-btn" data-act="photo-back" data-close="3">${esc(t("btn_back_count"))}</button></div>`;
  prompt_("stop", esc(t("ph_title", {n: S.k})), body, acts);
}
function open(p, ctx, mode, k){
  const ph = phOf(p);
  S = {p, ctx, mode, k, ph, notice: ""};
  render(); RX.sound("decide");
}
RX.registerStep("damage", {
  keepScan: false,
  applies(ctx){ return (+ctx.fields.damaged || 0) > 0; },
  start(ctx){ open(ctx.p, ctx, "step", +ctx.fields.damaged); },
  onScan(){ return false; },
  abort(){ S = null; },
});
PH.askAll = function(p, k){
  p.rx = p.rx || {}; p.rx.fields = Object.assign({}, p.rx.fields, {damaged: k, state: "ready", damagedAll: true});
  const ctx = {p, flow: RX.flow(), step: "damage", mode: RX.mode(), fields: p.rx.fields, all: true, done(f){ finishAll(p, k, f); }, commit(){}, cancel(){}, side(){}, clearSide(){}};
  RX.state.step = {name: "damage", ctx};
  open(p, ctx, "all", k);
};
function finishAll(p, k, f){
  const row = {prod: p.prod, upc: p.upc, gtin: p.gtin, best: p.best, lot: p.lot, units: 0, qtyKind: null, _po: RX.poRef(p), _at: RX.now(),
               _op: (() => { try{ return account; }catch(_){ return ""; } })(),
               rx: {iid: p.rx.iid, fields: {damaged: k, state: "ready", damagedAll: true, photoUrls: f.photoUrls, fixNote: f.fixNote}, flow: RX.flow(), ph: p.rx.ph}};
  RX.intents.createFromRow(row);
  finalize(p.rx.iid, f.photoUrls);
  RX.state.step = null; S = null;
  try{ pending = null; clearPrompt(); }catch(_){}
  RX.call("ui", "flashText", t("ph_all_flash"), null);
  RX.sound("decide"); RX.state.scanLog.length = 0; RX.refresh();
  setTimeout(PH.sync, 200);
}
/* the intent exists: this item's photos stop being drafts; the ones already uploaded are in its PhotoUrls (linked) */
/* ⛔ ROUND 5: "linked" = the link is IN the intent's PhotoUrls (the links known at Continue). An upload that landed between Continue
   and the commit has a url but is NOT in the intent: marking it linked dropped it from the queue and its link never reached the claim. */
function finalize(iid, urls){
  const inIntent = new Set(Array.isArray(urls) ? urls : []);
  for(const e of [...Q.values()]){
    if(e.iid !== iid || !e.draft) continue;
    e.draft = false; e.linked = !!e.url && inIntent.has(e.url); persist(e);
  }
  for(const e of [...Q.values()]) if(e.iid === iid && e.url && e.linked && [...Q.values()].filter(x => x.iid === iid).every(x => x.url && x.linked)){ Q.delete(e.id); unpersist(e.id); }
}
function discard(p){
  const ph = p && p.rx && p.rx.ph; if(!ph) return;
  for(const e of ph.items){ Q.delete(e.id); unpersist(e.id); try{ if(e.th) URL.revokeObjectURL(e.th); }catch(_){} }
  ph.items = []; ph.note = "";
}
RX.on("abandon", (p) => { discard(p); S = null; });
RX.on("committed", (row) => {
  const x = row && row.rx; if(!x || !x.iid) return;
  if(x.fields && x.fields.noIntent){ discard(row); return; }
  if(x.ph) finalize(x.iid, x.fields && x.fields.photoUrls);
  setTimeout(PH.sync, 200);
});

document.addEventListener("change", async (ev) => {
  const el = ev.target; if(!el || (el.id !== "rxPhCam" && el.id !== "rxPhPick")) return;
  const files = [...(el.files || [])]; try{ el.value = ""; }catch(_){}
  if(!S) return;
  for(const f of files){
    if(!S) return;
    let blob = f; try{ if(typeof shrink === "function") blob = (await shrink(f)) || f; }catch(_){ blob = f; }
    const iid = S.p.rx.iid, n = S.ph.items.length + 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const e = {id: RX.newId(), iid, name: `${stamp}_DAMAGE_${String(S.p.prod.sku).replace(/[^A-Za-z0-9]/g, "")}_${n}.jpg`, blob, url: "", linked: false, draft: true, at: RX.now(), sku: S.p.prod.sku};
    Q.set(e.id, e); S.ph.items.push(e); S.notice = ""; persist(e);
    render();
    uploadEntry(e).then(() => { if(S) render(); });
  }
});
RX.registerAct("photo-remove", ({el}) => {
  if(!S) return; const id = el.getAttribute("data-id");
  S.ph.items = S.ph.items.filter(e => e.id !== id);
  const e = Q.get(id); if(e){ try{ if(e.th) URL.revokeObjectURL(e.th); }catch(_){} Q.delete(id); unpersist(id); }
  render();
});
RX.registerAct("photo-back", () => { if(S) RX.backToQty(); });
RX.registerAct("photo-go", async () => {
  if(!S) return;
  const s = S, ph = s.ph;
  const note = document.getElementById("rxPhNote"); if(note) ph.note = note.value;
  if(!ph.items.length){ s.notice = t("ph_need"); render(); RX.sound("refused"); return; }
  const flying = ph.items.filter(e => e.up).map(e => e.up);
  const W = RX.CFG.PHOTO_WAIT || 10000;
  if(flying.length){ await Promise.race([Promise.all(flying), new Promise(r => setTimeout(r, W))]); if(S !== s) return; }
  const again = ph.items.filter(e => !e.url).map(uploadEntry);          // one more try now (a signal may be back)
  if(again.length){ await Promise.race([Promise.all(again), new Promise(r => setTimeout(r, W))]); if(S !== s) return; }
  if(ph.items.some(e => !e.url) && !PH.canQueue()){ s.notice = t("ph_noqueue"); render(); RX.sound("refused"); return; }
  const urls = ph.items.filter(e => e.url).map(e => e.url);
  S = null;                                                       // the card is done (an unfinished S would hold this item's photos back from the sync)
  s.ctx.done({photoUrls: urls, fixNote: String(ph.note || "").trim().slice(0, 250)});
});
})();
