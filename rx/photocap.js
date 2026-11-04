/* receiving/rx/photocap.js — READ THE LABEL FROM A PHOTO (2026-11-04). OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   Ruling: Jack, 2026-11-04 — many cases print the best-by (and lot) as plain laser text, not a barcode. "Photos to capture and OCR the best
   buy dates as default instead of typing … scan the barcode OR click to take a photo (or multiple ones) that finds the most usable
   barcodes and gets the item details, case qty and best buy date in one step … make it possible to bypass the item scanning section …
   confirm the item/dates from the image for them to approve."

   THE FLOW (one sheet, every step has Cancel):  📷 Photo (1-3 pictures)  →  Read it  →  [Uploading n of N → Waiting for the reader, with a
   live clock and a 90 s limit]  →  the READING drawn beside the photo  →  Use this date / Fix date / Try again.
   ⛔ NOTHING is saved by the reading. "Use this date" puts the date through the page's OWN date path (askDate → #dok → real-date test, life
      ceiling, "is this date correct?", the days toast), so a model-read date is checked exactly like a typed one. Source gets `+photo`.
   ⛔ A reading with no usable date goes straight to the big-button picker (rx/datepick.js) — the reader never guesses.
   ⛔ A case barcode that ALREADY carries a date is never overwritten by a photo.
   ⛔ A photo is for ONE case: the open case is captured when the sheet opens and compared when "Use this date" is pressed (stale = refused).
   ⭐ With no case open the photo can START one: its barcode (if the reader found one) goes through the page's ordinary scan path
      (`handle`), so catalog lookup, PO match, learn-an-alias and every guard are the same as a scan. No barcode → the reader's item text is
      matched against the catalog and the crew TAP the product; nothing is guessed. (A location label scanned first still sets WHERE —
      audit mode — so "scan a location, then photograph each case" needs no new mode.)
   BACKEND: job kind `receiving.read_label` (staged for the mini; the wire contract is in Procurement & Merchandising/plans/
   2026-11-04-receiving-and-freezer-ux-BUILD-PLAN.md). Until it is installed the row never completes: the 90 s limit ends in plain words and
   the picker — typing is never blocked.
   API: window.RXPhoto = { open(opts), close(), state, _setTransport(t), _test } */
(function(){
"use strict";
const SITE = "tcfarm0.sharepoint.com:/sites/ClaudeAgents", LIST = "AgentJobs", KIND = "receiving.read_label";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_PHOTOS = 3, UP_MS = 30000;
/* ⛔ NEVER OFFER A CONTROL THAT CANNOT WORK: the reader (job kind `receiving.read_label`) is STAGED on the mini and not installed until Jack signs the bundle.
   Until then the two photo buttons stay HIDDEN. To turn it on: set READER_INSTALLED = true and deploy (a test/preview tablet can set
   localStorage rx_photocap_on = "1"). */
const READER_INSTALLED = false;
const enabled = () => { if(READER_INSTALLED) return true; try{ return localStorage.getItem("rx_photocap_on") === "1"; }catch(_){ return false; } };
function showButtons(){ for(const id of ["rlPhotoBtn", "photoDateBtn"]){ const b = document.getElementById(id); if(b) b.hidden = !enabled(); } }
let WAIT_MS = 90000, POLL_MS = 2000;
const S = { el: null, cur: null, busy: false, siteId: null, listId: null, tick: null };
const pad = (n) => String(n).padStart(2, "0");
const e_ = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $ = (id) => document.getElementById(id);
function newId(){
  const d = new Date(), a = "abcdefghijklmnopqrstuvwxyz0123456789"; let r = "";
  for(let i = 0; i < 4; i++) r += a.charAt(Math.floor(Math.random() * a.length));
  return "RL-" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "-" + r;
}

/* ── transport: the page's own Graph sign-in (tests replace it) ── */
async function tok(){ if(typeof getToken !== "function") throw new Error("not signed in"); return getToken(); }
async function gfetch(url, opts, ms){
  const t = await tok(), o = opts || {}, ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms || 20000);
  try{ return await fetch(url, Object.assign({}, o, {signal: ac.signal, headers: Object.assign({}, o.headers || {}, {Authorization: "Bearer " + t})})); }
  finally{ clearTimeout(tm); }
}
async function failOf(r, what){ let m = ""; try{ const j = await r.json(); m = (j && j.error && j.error.message) || ""; }catch(_){}
  const e = new Error((m || ("HTTP " + r.status)) + " (" + what + ")"); e.status = r.status; throw e; }
let T = {
  async ids(){
    if(S.siteId && S.listId) return;
    const sr = await gfetch(GRAPH + "/sites/" + SITE + "?$select=id"); if(!sr.ok) await failOf(sr, "the ClaudeAgents site");
    const sid = (await sr.json()).id;
    const lr = await gfetch(GRAPH + "/sites/" + sid + "/lists?$select=displayName,id&$top=200"); if(!lr.ok) await failOf(lr, "the job lists");
    const l = ((await lr.json()).value || []).find(x => String(x.displayName).toLowerCase() === LIST.toLowerCase());
    if(!l) throw new Error("the " + LIST + " list was not found");
    S.siteId = sid; S.listId = l.id;
  },
  async upload(rel, blob){
    await T.ids();
    const url = GRAPH + "/sites/" + S.siteId + "/drive/root:/StaffApp/" + rel.split("/").map(encodeURIComponent).join("/") + ":/content?@microsoft.graph.conflictBehavior=replace";
    const r = await gfetch(url, {method: "PUT", headers: {"Content-Type": "image/jpeg"}, body: blob}, UP_MS);
    if(!r.ok) await failOf(r, "the photo upload");
    return "StaffApp/" + rel;
  },
  async enqueue(id, payload){
    await T.ids();
    const fields = {Title: KIND + ":" + id, Kind: KIND, Subject: id, Params: "{}", State: "queued", Attempts: 0,
                    RequestedUtc: new Date().toISOString().slice(0, 19) + "Z", RequestedBy: (typeof account === "string" && account) || "",
                    Payload: JSON.stringify(payload)};
    const r = await gfetch(GRAPH + "/sites/" + S.siteId + "/lists/" + S.listId + "/items",
                           {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({fields})});
    if(!r.ok) await failOf(r, "the job queue");
    return (await r.json()).id;
  },
  async poll(rowId){
    await T.ids();
    const r = await gfetch(GRAPH + "/sites/" + S.siteId + "/lists/" + S.listId + "/items/" + encodeURIComponent(rowId) + "?$expand=fields($select=State,Message,Result)");
    if(!r.ok) await failOf(r, "the job queue");
    const f = (await r.json()).fields || {}; let res = null; try{ res = f.Result ? JSON.parse(f.Result) : null; }catch(_){}
    return {state: f.State || "", message: f.Message || "", result: res};
  }
};

/* ── validate what came back: never trust the reader's shape ── */
function clean(res, id){
  const bad = !res || typeof res !== "object" || res.id !== id;
  if(bad) return null;
  const out = {status: res.status === "ok" ? "ok" : "unreadable", confidence: res.confidence === "high" ? "high" : "low",
               best_by: null, lot: null, gtin: null, upc: null, item_text: null, case_qty: null, notes: String(res.notes || "").slice(0, 200)};
  if(window.RXDate && typeof res.best_by === "string" && RXDate.days(res.best_by) != null) out.best_by = res.best_by;
  else if(res.best_by) out.confidence = "low";
  if(typeof res.lot === "string" && res.lot.trim()) out.lot = res.lot.trim().slice(0, 40);
  for(const k of ["gtin", "upc"]) if(typeof res[k] === "string" && /^\d{8,14}$/.test(res[k])) out[k] = res[k];
  if(typeof res.item_text === "string" && res.item_text.trim()) out.item_text = res.item_text.trim().slice(0, 120);
  if(Number.isInteger(res.case_qty) && res.case_qty >= 1 && res.case_qty <= 1000) out.case_qty = res.case_qty;
  if(out.status === "ok" && !out.best_by && !out.gtin && !out.upc && !out.item_text) out.status = "unreadable";
  return out;
}

/* ── sheet ── */
function ensureCss(){
  if($("pcCss")) return;
  const s = document.createElement("style"); s.id = "pcCss";
  s.textContent = `#pcSheet{position:fixed;inset:0;z-index:75;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}
#pcSheet .pcBox{background:var(--card,#fff);color:var(--ink,#101c18);width:100%;max-width:760px;max-height:96vh;overflow:auto;border-radius:14px 14px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom,0px))}
#pcSheet button{min-height:56px;font-size:20px;border:2px solid var(--line,#dbe4df);background:var(--ground,#f4f7f5);color:var(--ink,#101c18);border-radius:10px;padding:6px 14px;margin:4px 6px 4px 0}
#pcSheet button.pcGo{background:var(--go,#0b6e4f);border-color:var(--go,#0b6e4f);color:#fff;font-weight:700}
.pcThumbs img{width:96px;height:72px;object-fit:cover;border:1px solid var(--line,#dbe4df);border-radius:6px;margin:0 6px 6px 0}
.pcBar{height:10px;background:var(--line-2,#eef3f0);border-radius:6px;overflow:hidden;margin:10px 0}.pcBar i{display:block;height:100%;background:var(--go,#0b6e4f);width:5%;transition:width .4s}
.pcRead{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:18px;margin:8px 0}.pcRead dt{color:var(--ink-3,#6d8079)}.pcRead dd{margin:0}
.pcDate{font-size:30px;font-weight:800}.pcWarn{padding:9px 12px;background:var(--wait-soft,#fdf0dc);border-left:5px solid var(--wait,#a8620a);margin:8px 0;font-size:17px}`;
  document.head.appendChild(s);
}
function close(){ if(S.tick){ clearInterval(S.tick); S.tick = null; } if(S.el){ S.el.remove(); S.el = null; } S.cur = null; S.busy = false; }
function body(html){ const b = $("pcBody"); if(b) b.innerHTML = html; }
function mount(title){
  ensureCss();
  if(S.el) S.el.remove();
  const el = document.createElement("div"); el.id = "pcSheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", title);
  el.innerHTML = `<div class="pcBox"><strong style="font-size:20px">${e_(title)}</strong><div id="pcBody"></div></div>`;
  el.addEventListener("keydown", (e) => { if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); close(); } }, true);
  document.body.appendChild(el); S.el = el; return el;
}
const thumbs = () => `<div class="pcThumbs" id="pcThumbs">${(S.cur.photos || []).map(p => `<img alt="photo" src="${e_(p.url)}">`).join("")}</div>`;

function stepShoot(note){
  const c = S.cur, n = c.photos.length;
  body(`<p style="font-size:17px;margin:8px 0">Photograph the label that prints the <strong>best-by date and lot</strong>. Add up to ${MAX_PHOTOS} photos
      (the date side, and the barcode side).</p>${note ? `<div class="pcWarn">${e_(note)}</div>` : ""}${thumbs()}
    <input id="pcFile" type="file" accept="image/*" capture="environment" hidden>
    <div><button type="button" id="pcAdd">${n ? "📷 Add another photo" : "📷 Take a photo"}</button>
    ${n ? `<button type="button" id="pcRead" class="pcGo">Read it</button>` : ""}<button type="button" id="pcCancel">Cancel</button></div>`);
  $("pcCancel").onclick = close;
  $("pcAdd").onclick = () => { if(c.photos.length >= MAX_PHOTOS) return stepShoot("Three photos is the most — press Read it."); $("pcFile").click(); };
  $("pcFile").onchange = async (ev) => {
    const f = ev.target.files && ev.target.files[0]; if(!f) return;
    let blob = f; try{ if(typeof shrink === "function") blob = (await shrink(f)) || f; }catch(_){ blob = f; }
    c.photos.push({blob, url: URL.createObjectURL(blob)}); stepShoot();
  };
  if(n) $("pcRead").onclick = read;
}

async function read(){
  const c = S.cur; if(!c || S.busy) return;                 // ⛔ twice: a second tap while reading does nothing
  if(typeof navigator !== "undefined" && navigator.onLine === false){
    return stepFail("No signal right now, so the photo cannot be read. Pick the date by hand, or try again when the tablet has signal.");
  }
  S.busy = true; c.id = newId(); c.t0 = Date.now(); c.stage = "Starting…";
  const paint = () => {
    const s = Math.floor((Date.now() - c.t0) / 1000);
    const bar = $("pcBarFill"); if(bar) bar.style.width = Math.min(95, 5 + c.prog) + "%";
    const st = $("pcStage"); if(st) st.textContent = c.stage;
    const ck = $("pcClock"); if(ck) ck.textContent = s + " s of " + (WAIT_MS / 1000) + " s";
  };
  c.prog = 0;
  body(`${thumbs()}<div style="font-size:19px"><strong id="pcStage"></strong></div><div class="pcBar"><i id="pcBarFill"></i></div>
    <div class="hint" id="pcClock" aria-live="polite"></div><div><button type="button" id="pcCancel">Cancel</button></div>`);
  $("pcCancel").onclick = close;
  S.tick = setInterval(paint, 1000); paint();
  const myId = c.id;
  const alive = () => S.cur && S.cur.id === myId;            // closed or replaced meanwhile → drop the result
  try{
    const files = {};
    for(let i = 0; i < c.photos.length; i++){
      c.stage = `Uploading photo ${i + 1} of ${c.photos.length}…`; c.prog = 10 + Math.round(40 * i / c.photos.length); paint();
      files[(i + 1) + ".jpg"] = await T.upload("receiving_label/" + myId + "/" + (i + 1) + ".jpg", c.photos[i].blob);
      if(!alive()) return;
    }
    c.stage = "Sending to the reader…"; c.prog = 55; paint();
    const p = c.pendingRef;
    const meta = {mode: (typeof isAudit === "function" && isAudit()) ? "audit" : "receive", today: new Date().toISOString().slice(0, 10),
                  sku_hint: (p && p.prod && p.prod.sku && !String(p.prod.sku).startsWith("!")) ? p.prod.sku : null, po_lines: [],
                  by: (typeof account === "string" && account) || ""};
    const rowId = await T.enqueue(myId, {v: 1, id: myId, files, meta});
    if(!alive()) return;
    c.stage = "Waiting for the reader…"; c.prog = 60;
    for(;;){
      if(!alive()) return;
      const left = WAIT_MS - (Date.now() - c.t0);
      if(left <= 0) return stepFail("The reader did not answer in " + (WAIT_MS / 1000) + " seconds. Try again, or pick the date by hand.");
      await new Promise(r => setTimeout(r, POLL_MS));
      if(!alive()) return;
      c.prog = Math.min(90, 60 + Math.round(30 * (WAIT_MS - left) / WAIT_MS)); paint();
      const st = await T.poll(rowId);
      if(/^(refused|needs_human|failed)$/.test(st.state)) return stepFail("The reader could not run (" + (st.message || st.state) + "). Pick the date by hand, or try again.");
      if(st.state === "done" || st.result){
        const res = clean(st.result, myId);
        if(!res) return stepFail("The reader sent back something unreadable. Try again, or pick the date by hand.");
        return stepResult(res);
      }
    }
  }catch(e){
    if(alive()) stepFail("That did not go through: " + String((e && e.message) || e).slice(0, 140) + ". Try again, or pick the date by hand.");
  }
}

function stepFail(msg){
  if(S.tick){ clearInterval(S.tick); S.tick = null; }
  S.busy = false;
  body(`${S.cur ? thumbs() : ""}<div class="pcWarn" id="pcFailMsg">${e_(msg)}</div>
    <div><button type="button" id="pcRetry" class="pcGo">Try again</button><button type="button" id="pcManual">Pick the date by hand</button><button type="button" id="pcCancel">Cancel</button></div>`);
  $("pcCancel").onclick = close;
  $("pcRetry").onclick = () => { S.cur.photos = []; stepShoot(); };
  $("pcManual").onclick = () => manual();
}
/* the picker is the way out of every dead end — the crew can always type or tap the date */
function manual(){
  const c = S.cur; const ref = c && c.pendingRef; close();
  if(!window.RXDate) return;
  RXDate.open({title: "Best-by date", onPick: (iso) => apply({best_by: iso, lot: null, confidence: "high", gtin: null, upc: null, item_text: null, case_qty: null}, iso, ref, "pick")});
}

function stepResult(res){
  const c = S.cur; if(S.tick){ clearInterval(S.tick); S.tick = null; } S.busy = false; c.res = res;
  if(res.status !== "ok" || (!res.best_by && !res.gtin && !res.upc && !res.item_text)) return stepFail("Nothing on the photo could be read. Try again with the printed date in the middle of the photo, or pick the date by hand.");
  const low = res.confidence !== "high";
  const dt = res.best_by;
  body(`${thumbs()}${low ? `<div class="pcWarn">The reader was not sure. Check every value against the box before you use it.</div>` : ""}
    <dl class="pcRead">
      <dt>Best-by</dt><dd>${dt ? `<span class="pcDate" id="pcDate">${e_(RXDate.fmt(dt))}</span><br><span id="pcDays">${e_(daysText(dt))}</span>` : `<strong>not found</strong>`}</dd>
      ${res.lot ? `<dt>Lot</dt><dd>${e_(res.lot)}</dd>` : ""}
      ${(res.gtin || res.upc) ? `<dt>Barcode</dt><dd class="num">${e_(res.gtin || res.upc)}</dd>` : ""}
      ${res.item_text ? `<dt>Item</dt><dd>${e_(res.item_text)}</dd>` : ""}
      ${res.case_qty ? `<dt>Case of</dt><dd>${res.case_qty}</dd>` : ""}
    </dl>
    <div>${dt ? `<button type="button" id="pcUse" class="pcGo">${low ? "The date is right" : "Use this date"}</button><button type="button" id="pcFix">Fix the date</button>`
              : `<button type="button" id="pcFix" class="pcGo">Pick the date</button>`}
    ${(!c.pendingRef && !dt) ? `<button type="button" id="pcOpen">Open this case</button>` : ""}
    <button type="button" id="pcRetry">Try again</button><button type="button" id="pcCancel">Cancel</button></div>`);
  $("pcCancel").onclick = close;
  $("pcRetry").onclick = () => { c.photos = []; stepShoot(); };
  if($("pcUse")) $("pcUse").onclick = () => { const ref = c.pendingRef; const r = c.res; close(); apply(r, dt, ref, "photo"); };
  $("pcFix").onclick = () => { const ref = c.pendingRef, r = c.res; close(); RXDate.open({title: "Fix the best-by date", value: dt || "", onPick: (iso) => apply(r, iso, ref, "photo")}); };
  if($("pcOpen")) $("pcOpen").onclick = () => { const r = c.res, ref = c.pendingRef; close(); apply(r, null, ref, "photo"); };
}
function daysText(iso){ const n = RXDate.days(iso); return n == null ? "" : n === 0 ? "expires TODAY" : n === 1 ? "1 day from today" : n > 1 ? n + " days from today" : (-n) + " days ago — already expired"; }

/* ── apply: only through the page's own paths ── */
function say(m){ if(window.RX && RX.toast) RX.toast(m); else if(typeof toast === "function") toast(m); }
async function apply(res, date, ref, how){
  const cur = (typeof pending !== "undefined") ? pending : null;
  if(ref && cur !== ref){ say("That photo was for another case — nothing was changed."); return; }       // ⛔ stale: wrong case
  if(!cur){
    /* a photo can START a case: through the ordinary scan path, never around it */
    const code = res.gtin || res.upc;
    if(code && typeof handle === "function"){
      await handle(code);
      const p = (typeof pending !== "undefined") ? pending : null;
      if(!p){ say("The barcode on the photo was not accepted as a product — scan the case or find it by name."); return; }
      return fill(p, res, date, how);
    }
    return candidates(res, date, how);
  }
  return fill(cur, res, date, how);
}
function fill(p, res, date, how){
  if(!date) return;
  if(p.best && p.best !== date){ say("This case's own barcode already carries a date (" + p.best + ") — the photo did not change it."); return; }   // ⛔ never overwrite
  if(p.best === date) return;
  if(res.lot && !p.lot) p.lot = res.lot;
  p.suggest = {date, tag: how === "pick" ? "photopick" : "photo", why: how === "pick" ? "picked by hand" : "read from a photo and approved"};
  if(typeof askDate === "function") askDate();
  setTimeout(() => { const ok = $("dok"); if(ok) ok.click(); }, 60);                     // it was approved on the sheet: save through the ordinary Save
}
/* no barcode on the photo: match the reader's item text to the catalog and let the crew TAP — never a guess */
function candidates(res, date, how){
  const text = String(res.item_text || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const by = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU) || {};
  const hits = [];
  if(text.length >= 2) for(const sku in by){ const p = by[sku]; const hay = ((p.br || "") + " " + (p.name || "")).toLowerCase();
    const n = text.filter(w => hay.includes(w)).length; if(n >= Math.min(2, text.length)) hits.push([n, p]); if(hits.length > 400) break; }
  hits.sort((a, b) => b[0] - a[0]);
  const top = hits.slice(0, 6).map(x => x[1]);
  mount("Which product is this?");
  S.cur = {photos: [], res, date};
  if(!top.length){ body(`<div class="pcWarn">The photo did not name a product we know. Scan the case barcode, or find it by name, then use the date picker.</div><button type="button" id="pcCancel">Cancel</button>`); $("pcCancel").onclick = close; return; }
  body(`<p>${e_(res.item_text || "")}</p>` + top.map(p => `<button type="button" class="pcPick" data-sku="${e_(p.sku)}" style="display:block;width:100%;text-align:left">${e_(p.name || p.sku)}<br><small>${e_(p.sku)}</small></button>`).join("") +
        `<button type="button" id="pcCancel">None of these</button>`);
  $("pcCancel").onclick = close;
  Array.prototype.forEach.call(S.el.querySelectorAll(".pcPick"), b => b.onclick = async () => {
    const sku = b.dataset.sku; let code = null;
    for(const k in CATALOG){ if(CATALOG[k] && CATALOG[k].sku === sku && !CATALOG[k].learned){ code = k; break; } }
    close();
    if(!code || typeof handle !== "function") return say("No barcode on file for that product — find it by name.");
    await handle(code);
    const p = (typeof pending !== "undefined") ? pending : null;
    if(p) fill(p, res, date, how);
  });
}

/* ── entry ── */
function open(opts){
  opts = opts || {};
  if(S.busy || !enabled()) return;
  const ref = (typeof pending !== "undefined" && pending) ? pending : null;
  mount("Read the label from a photo");
  S.cur = {photos: [], pendingRef: ref, id: null};
  stepShoot();
}

showButtons();
window.RXPhoto = { enabled, showButtons, open, close, state: () => ({open: !!S.el, busy: S.busy, id: S.cur && S.cur.id}), _setTransport: (t) => { T = Object.assign(T, t); }, _test: { clean, setLimits: (w, p) => { WAIT_MS = w; POLL_MS = p; } } };
})();
