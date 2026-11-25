/* receiving/rx/feedback.js — the FEEDBACK button on the receiving tablet (PM-3305). OWNER: Procurement & Merchandising (hosted in
   ProductPipeline/receiving).

   Jack, 2026-10-28: "It should be floating on their screen, maybe in the bottom right … so there's a way for them to dictate feedback on
   things that aren't working directly" and "Add the portal's feedback button to the receiving page."
   Jack, 2026-11-25: "turn off the feedback's post to the tech channel in teams — now that we can see them online, we don't want them
   posted in Teams."

   ⭐ ONE PIPELINE, THE PORTAL'S. Since 2026-11-25 this button submits to the AWS feedback service, exactly as the staff portal's button
   does (IT-Provisioning/plans/2026-11-11-feedback-autobuild-CONTRACT.md §3.3): the note lands on the online board (Ideas & fixes, My
   feedback) as module `receiving`, and NOTHING is posted to Teams and no AgentJobs row is written (the old `staffapp.feedback` /
   `staffapp.transcribe` kinds are no longer used by this page). The tablet keeps its own panel, offline outbox and scan guards; only
   the wire changed:
     • where to call: https://internal.mnfood.club/shell/config.json → feedback.api + access.scope (read once per page, CORS *);
     • the token: the page's own sign-in (CFG.clientId, refresh token) asked for the TC Farm Staff API scope (api://…/data). ⛔ That
       needs the "TC Farm Receiving" Entra app to be allowed on that API (admin consent) — until it is, a note is KEPT on the tablet
       (AADSTS65001 → "no_api_access") and goes by itself once it is. See PM-3305 / Staff Portal FEEDBACK.md;
     • the picture: POST /v1/uploads {client_request_id, content_type, size} → PUT the PNG to the presigned url → its upload_id;
     • the report: POST /v1/items {client_request_id, type, text, dictated, priority, private, module:"receiving", context,
       screenshot_upload_id}. The FB id IS the client_request_id, so a retry of the same report is replayed by the service, never a
       second item (U-22);
     • a voice note: raw audio (≤ ~50 s pieces) POSTed to /v1/dictate; the text comes back at once and lands in the box, editable.
       Audio is never stored (service rule). A note recorded with no connection waits in IndexedDB and is transcribed + sent later.
   ⛔ SENT ONCE. The FB id is made when Send is pressed and kept with the report; a retry first looks it up (GET /v1/requests/<id>).
   ⛔ NOTHING IS LOST OFFLINE. An unsent report waits on this tablet (localStorage) and is retried every minute; the button says so.
      A report the service REFUSES for good (too long, unknown screen …) is not kept: its words stay in the box with the reason.
   Defaults the portal asks the person for, fixed here (Jack's tablet UX is one tap): priority "helps", private=false (on the board).
   API: window.RXFeedback = { open, close, state, _flush, _transcribe, _setTransport, _context } */
(function(){
"use strict";
const PORTAL_CFG = "https://internal.mnfood.club/shell/config.json", MODULE = "receiving", MAX_TEXT = 3400;
const KEY_Q = "rx_fb_outbox_v1", KEY_SENT = "rx_fb_sent_v1", KEY_DRAFT = "rx_fb_draft_v1", KEY_V = "rx_fb_voice_v1";
const MAX_SEC = 120, PIECE_SEC = 50, RETRY_MS = 60000;
const S = { open: false, type: "bug", text: "", shot: true, busy: false, msg: "", kind: "", rec: null, sec: 0, timer: null,
            dict: "", dictated: false, cfg: null, tk: null, outbox: [], sent: [] };
const el = (id) => document.getElementById(id);
const e_ = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ls = { get(k, d){ try{ const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; }catch(_){ return d; } },
             set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(_){} } };
S.outbox = (ls.get(KEY_Q, []) || []).filter(x => x && x.id && x.meta);
S.sent = (ls.get(KEY_SENT, []) || []).filter(x => x && x.id).slice(0, 8);
S.text = String(ls.get(KEY_DRAFT, "") || "");                         // misuse review 10: a draft survives a reload
S.voice = (ls.get(KEY_V, []) || []).filter(x => x && x.aid && (x.key || x.keys));   // PM-3307: voice notes recorded with no connection

/* ── PM-3307 (Jack, 2026-10-28: "The voice notes should be able to be recorded offline"): recordings and screenshots wait in this
   tablet's IndexedDB (localStorage cannot hold a blob). ⛔ Unavailable IndexedDB (a private window) only means they cannot wait — said. */
const IDB = { db: null,
  open(){ return this.db || (this.db = new Promise((ok, no) => { try{ const r = indexedDB.open("rx_feedback", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("blobs"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }catch(e){ no(e); } })); },
  async op(mode, fn){ const db = await this.open(); return new Promise((ok, no) => { const t = db.transaction("blobs", mode), st = t.objectStore("blobs");
    const r = fn(st); t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error); }); },
  put(k, b){ return this.op("readwrite", st => st.put(b, k)); }, get(k){ return this.op("readonly", st => st.get(k)); },
  del(k){ return this.op("readwrite", st => st.delete(k)).catch(() => {}); } };
const pad = (n) => String(n).padStart(2, "0");
function newId(prefix){
  const d = new Date(), a = "abcdefghijklmnopqrstuvwxyz0123456789"; let r = "";
  for(let i = 0; i < 4; i++) r += a.charAt(Math.floor(Math.random() * a.length));
  return prefix + "-" + d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "-" + r;
}

/* ── the transport: the AWS feedback service, with the page's own sign-in (tests replace T) ── */
const WORDS = {
  unauthorized: "Sign in again on this tablet.",
  no_api_access: "This tablet's sign-in is not set up for Feedback yet (IT has to allow it once).",
  not_configured: "The feedback service is not reachable from this page yet.",
  upstream: "The feedback service had a problem or there is no connection.",
  busy: "The service is busy. Try again in a minute.",
  bad_request: "That was not accepted. Tell a developer.",
  too_long: "Please keep it under {n} characters.", too_short: "Say a few words so the others understand.",
  too_large: "That file is too large.", unknown_module: "The Receiving screen is not on the feedback list yet. Tell a developer.",
  no_staff_identity: "Sign in with your TC Farm account.", forbidden: "That is not allowed from this account. Sign in with your TC Farm account.",
  daily_limit: "You have reached today's limit. It resets at midnight.", dictation_failed: "That recording did not turn into text.",
  storage_error: "The feedback service had a problem.", idempotency_mismatch: "That was not accepted. Tell a developer."
};
const FOR_GOOD = {bad_request: 1, too_long: 1, too_short: 1, unknown_module: 1, no_staff_identity: 1, forbidden: 1, idempotency_mismatch: 1, too_large: 1, dictation_failed: 1};
function oops(status, code, reason, retry){ const e = new Error(reason); e.status = status; e.code = code; e.reason = reason; e.retry = retry; return e; }
function failOf(status, j){
  const b = (j && typeof j === "object") ? j : {};
  const code = (typeof b.error === "string" && WORDS[b.error]) ? b.error
    : status === 401 ? "unauthorized" : status === 429 ? "busy" : status === 413 ? "too_large" : status === 403 ? "forbidden" : status >= 500 ? "upstream" : "bad_request";
  const reason = WORDS[code].replace(/\{(\w+)\}/g, (m, k) => (b[k] != null ? String(b[k]) : ""));
  return oops(status, code, reason, !FOR_GOOD[code]);
}
async function fetchTo(url, o, ms){
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms);       // a hung request ends
  try{ return await fetch(url, Object.assign({}, o, {signal: ac.signal})); } finally{ clearTimeout(tm); }
}
async function cfg(){
  if(S.cfg) return S.cfg;
  let r; try{ r = await fetchTo(PORTAL_CFG, {cache: "no-store", credentials: "omit"}, 15000); }catch(_){ throw oops(0, "upstream", WORDS.upstream, true); }
  if(!r.ok) throw oops(r.status, "not_configured", WORDS.not_configured, true);
  let j = null; try{ j = await r.json(); }catch(_){}
  const f = (j && j.feedback) || {}, api = String(f.api || "").replace(/\/$/, ""), scope = j && j.access && j.access.scope;
  if(f.backend !== "aws" || !/^https:\/\/[A-Za-z0-9.-]+$/.test(api) || typeof scope !== "string" || scope.indexOf("api://") !== 0)
    throw oops(0, "not_configured", WORDS.not_configured, true);
  return (S.cfg = {api, scope});
}
/* the Staff API token from the SAME refresh token as the page's Graph sign-in (a refresh token is good for every resource the app is
   allowed on). ⛔ The page's own token / refresh token are never replaced by this answer. */
async function staffTok(force){
  const c = await cfg();
  if(!force && S.tk && Date.now() < S.tk.exp - 60000) return S.tk.t;
  const rt = (typeof refreshTok === "string" && refreshTok) || "";
  if(!rt || typeof CFG === "undefined" || typeof AUTH !== "string") throw oops(401, "unauthorized", WORDS.unauthorized, true);
  let r;
  try{ r = await fetchTo(AUTH + "/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, credentials: "omit",
        body: new URLSearchParams({client_id: CFG.clientId, grant_type: "refresh_token", refresh_token: rt, scope: c.scope + " openid profile offline_access"})}, 20000); }
  catch(_){ throw oops(0, "upstream", WORDS.upstream, true); }
  const j = await r.json().catch(() => ({}));
  if(!r.ok || !j.access_token){
    if(/AADSTS65001|AADSTS500011|AADSTS70011|AADSTS650057|consent|not authorized/i.test(String(j.error_description || ""))) throw oops(403, "no_api_access", WORDS.no_api_access, true);
    if(r.status >= 500) throw oops(r.status, "upstream", WORDS.upstream, true);
    throw oops(401, "unauthorized", WORDS.unauthorized, true);
  }
  S.tk = {t: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000};
  return S.tk.t;
}
async function api(method, path, o){
  o = o || {};
  for(let pass = 0; pass < 2; pass++){
    const tok = await staffTok(pass === 1), c = await cfg();
    const h = Object.assign({Authorization: "Bearer " + tok, Accept: "application/json"}, o.headers || {});
    let body; if(o.json !== undefined){ h["Content-Type"] = "application/json"; body = JSON.stringify(o.json); } else if(o.raw !== undefined) body = o.raw;
    let r; try{ r = await fetchTo(c.api + path, {method, headers: h, body, cache: "no-store", credentials: "omit"}, o.ms || (method === "GET" ? 20000 : 60000)); }
    catch(_){ throw oops(0, "upstream", WORDS.upstream, true); }
    if(r.status === 401 && pass === 0){ S.tk = null; continue; }          // one fresh token, then say so
    let j = null; if(r.status !== 204){ try{ j = await r.json(); }catch(_){} }
    if(r.ok) return j;
    throw failOf(r.status, j);
  }
}
let T = {
  async upload(cid, blob){
    const u = await api("POST", "/v1/uploads", {json: {client_request_id: cid + "-p", content_type: "image/png", size: blob.size}});
    if(!u || !u.url || !u.upload_id) throw oops(0, "upstream", WORDS.upstream, true);
    let r; try{ r = await fetchTo(u.url, {method: "PUT", headers: u.headers || {}, body: blob, credentials: "omit", cache: "no-store"}, 90000); }
    catch(_){ throw oops(0, "upstream", "The picture did not upload.", true); }
    if(!r.ok) throw oops(r.status, "upstream", "The picture did not upload.", true);
    return u.upload_id;
  },
  async lookup(cid){                                              // the report already saved under this key? → {n} | null
    try{
      const r = await api("GET", "/v1/requests/" + encodeURIComponent(cid));
      const ok = r && (r.status === "done" || (Number(r.status) >= 200 && Number(r.status) < 300)) && r.response;
      return ok ? {id: (r.response.item && (r.response.item.n || r.response.item.number)) || cid} : null;
    }catch(e){ if(e && e.status === 404) return null; throw e; }
  },
  async submit(body){
    try{ const r = await api("POST", "/v1/items", {json: body}); return {id: (r && r.item && (r.item.n || r.item.number)) || body.client_request_id}; }
    catch(e){ if(e && e.status === 412){ const have = await T.lookup(body.client_request_id); if(have) return have; } throw e; }
  },
  async dictate(blob){
    const r = await api("POST", "/v1/dictate", {raw: blob, headers: {"Content-Type": blob.type || "audio/webm", "X-Dictate-Context": encodeURIComponent("Receiving tablet: feedback")}});
    if(!r || typeof r.text !== "string") throw oops(0, "dictation_failed", WORDS.dictation_failed, false);
    return r.text;
  }
};

/* ── what the team sees with the report ── */
function context(){
  const p = (typeof pending === "object" && pending) || null;
  const title = (() => { const h = document.querySelector("#promptArea .prompt h2, #promptArea .prompt h3, #promptArea .prompt strong"); return h ? h.textContent.trim().slice(0, 80) : ""; })();
  const last = (typeof rows !== "undefined" && rows && rows[0]) || null;
  const open = [p && p.prod ? ("open item " + p.prod.sku + " " + (p.prod.name || "")) : "",
                p && (p.upc || p.gtin) ? ("scanned " + (p.gtin || p.upc)) : "",
                last && last.prod ? ("last saved " + last.prod.sku + " " + (last.best || "no date")) : "",
                (typeof device === "string" && device) ? ("tablet " + device) : "",
                (typeof isAudit === "function" && isAudit()) ? "AUDIT mode" : ""].filter(Boolean).join(" · ").slice(0, 400);
  const v = (window.RXVersion && RXVersion.state && RXVersion.state().base) || null;
  return {module: "receiving", stage: title || (p ? "an item is open" : "scan screen"), week: null,
          url: location.origin + location.pathname, open: open || null, app_version: v == null ? null : String(v),
          viewport: window.innerWidth + "x" + window.innerHeight};
}
const who = () => { const a = (typeof account === "string" && account) || ""; return {name: a, upn: a}; };

/* ── screenshot (the portal's no-library method: the DOM into an SVG foreignObject, onto a canvas) ── */
function cssText(){ let out = ""; Array.prototype.forEach.call(document.styleSheets, sh => { try{ Array.prototype.forEach.call(sh.cssRules, r => { out += r.cssText + "\n"; }); }catch(_){} }); return out; }
async function screenshot(){
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  const c = document.documentElement.cloneNode(true);
  Array.prototype.forEach.call(c.querySelectorAll("script,noscript,#rxFb,#rxFbFab"), n => n.remove());
  const st = document.createElement("style"); st.textContent = cssText(); (c.querySelector("head") || c).appendChild(st);
  const a = document.documentElement.querySelectorAll("input,textarea,select"), b = c.querySelectorAll("input,textarea,select");
  Array.prototype.forEach.call(a, (x, i) => { const t = b[i]; if(!t) return;
    if(x.tagName === "TEXTAREA") t.textContent = x.value; else if(x.type === "checkbox" || x.type === "radio"){ if(x.checked) t.setAttribute("checked", ""); } else t.setAttribute("value", x.value); });
  c.setAttribute("style", "width:" + w + "px;height:" + h + "px;overflow:hidden;");
  const body = c.querySelector("body"); if(body) body.setAttribute("style", "margin:0;width:" + w + "px;transform:translate(" + (-window.scrollX) + "px," + (-window.scrollY) + "px);transform-origin:0 0;");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject x="0" y="0" width="100%" height="100%">' + new XMLSerializer().serializeToString(c) + "</foreignObject></svg>";
  const img = new Image();
  await new Promise((ok, no) => { const t = setTimeout(() => no(new Error("timed out drawing the page")), 8000);
    img.onload = () => { clearTimeout(t); ok(); }; img.onerror = () => { clearTimeout(t); no(new Error("the tablet could not draw the page")); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
  const k = Math.min(window.devicePixelRatio || 1, 2), cv = document.createElement("canvas");
  cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  const g = cv.getContext("2d"); g.scale(k, k); g.fillStyle = getComputedStyle(document.body).backgroundColor || "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
  return new Promise((ok, no) => { try{ cv.toBlob(bl => bl ? ok(bl) : no(new Error("empty image")), "image/png"); }catch(e){ no(e); } });
}

/* ── send: the screenshot first, then ONE report (looked up before every retry) ── */
const footer = (c) => { const o = String((c && (c.open || c.stage)) || "").trim(); return o ? "[Receiving tablet — " + o.slice(0, 300) + (c.app_version ? " · version " + String(c.app_version).slice(0, 20) : "") + "]" : ""; };
/* the body of POST /v1/items, the same bytes on every retry (the service replays a key only for an identical body) */
function bodyOf(item){
  const m = item.meta || {}, c = m.context || {};
  let text = String(m.text || "").trim(); const foot = footer(c);
  if(foot && text.length + foot.length + 2 <= 4000) text += "\n\n" + foot; else text = text.slice(0, 4000);
  const b = {client_request_id: item.id, type: ["bug", "idea", "question"].indexOf(m.type) >= 0 ? m.type : "bug", text, dictated: !!m.dictated,
             priority: "helps", private: false, module: MODULE,
             context: {url: String(c.url || ""), viewport: String(c.viewport || ""), app_version: c.app_version == null ? "" : String(c.app_version),
                       stage: String(c.stage || "").slice(0, 40), open: String(c.open || "").slice(0, 40)}};
  if(item.up) b.screenshot_upload_id = item.up;
  return b;
}
async function deliver(item, shot){
  if(!shot && item.shotKey && !item.up){ try{ shot = await IDB.get(item.shotKey); }catch(_){ shot = null; } }
  if(shot && !item.up && !item.noShot){
    try{ item.up = await T.upload(item.id, shot); item.meta.has_screenshot = true; }
    catch(e){
      /* a picture the service refuses for good (too big, today's upload limit) goes without; a connection problem keeps the whole report */
      if(e && (e.retry !== false && e.code !== "daily_limit")) throw e;
      item.noShot = true; item.meta.has_screenshot = false; item.meta.screenshot_error = String((e && e.message) || "upload failed").slice(0, 120);
    }
  }
  if((item.up || item.noShot) && item.shotKey){ IDB.del(item.shotKey); delete item.shotKey; }
  if(item.tried){ const have = await T.lookup(item.id); if(have) return have; }   // ⛔ never a second report
  item.tried = true; save();
  return T.submit(bodyOf(item));
}
function save(){ ls.set(KEY_Q, S.outbox.map(x => ({id: x.id, meta: x.meta, up: x.up || "", noShot: !!x.noShot, tried: !!x.tried, at: x.at, shotKey: x.shotKey || ""})));
  ls.set(KEY_SENT, S.sent.slice(0, 8)); ls.set(KEY_V, S.voice); }
let flushing = false;
async function flush(){
  if(flushing) return; flushing = true;
  try{ await flushVoice(); await flushOnce(); } finally{ flushing = false; }
}
/* PM-3307: a voice note recorded offline → transcribed, then sent as a report (with the words typed at the time) by itself */
async function flushVoice(){
  for(const v of S.voice.slice()){
    const keys = v.keys || (v.key ? [v.key] : []);
    v.texts = v.texts || [];
    let stuck = false;
    for(let i = v.texts.length; i < keys.length; i++){
      let blob = null; try{ blob = await IDB.get(keys[i]); }catch(_){ blob = null; }
      if(!blob){ v.texts.push(""); save(); continue; }
      try{ v.texts.push(await T.dictate(blob)); save(); }
      catch(e){
        v.checks = (v.checks || 0) + 1; save();
        /* review 11: never "waiting" for ever — refused for good, or ~30 minutes of tries, and the report goes without the words */
        if(v.checks >= 30 || (e && e.retry === false && e.code !== "dictation_failed")){ v.texts.push(""); save(); continue; }
        stuck = true; break;                                           // still offline: next minute
      }
    }
    if(stuck) break;
    const heard = v.texts.filter(t => t && t.trim()).join(" ").trim();
    const said = heard || "(a voice note recorded offline could not be turned into text — recording " + v.aid + ")";
    const id = newId("FB");
    const meta = {v: 2, id, type: v.type || "bug", text: ((v.draft || "").trim() ? v.draft.trim() + " " : "") + said, at_utc: new Date().toISOString(),
                  by: v.by, context: v.ctx, dictated: !!heard, has_screenshot: false, auto: "a voice note recorded with no connection, sent when it came back"};
    S.outbox.push({id, meta, tried: false, at: Date.now()});
    S.voice = S.voice.filter(x => x !== v); keys.forEach(k => IDB.del(k)); save();
  }
}
async function flushOnce(){
  for(const item of S.outbox.slice()){
    if(item.sending) continue;                                       // review 10: send() is delivering this one right now
    try{
      const r = await deliver(item, null);
      S.outbox = S.outbox.filter(x => x.id !== item.id);
      S.sent.unshift({id: item.id, text: item.meta.text, at: item.meta.at_utc, row: r && r.id}); save();
    }catch(e){
      if(e && e.retry === false){                                    // refused for good: not kept for ever, and said
        S.outbox = S.outbox.filter(x => x.id !== item.id); if(item.shotKey) IDB.del(item.shotKey); save();
        S.msg = "A report kept on this tablet was refused and removed (" + e.reason + ")."; S.kind = "warn"; continue;
      }
      break;                                                         // offline / sign-in: try again next minute
    }
  }
  paint(); if(S.open) render();
}
async function send(){
  if(S.busy) return;
  const text = (el("rxFbText") ? el("rxFbText").value : S.text).trim(); S.text = text;
  if(!text){ S.msg = "Say or type what is wrong first."; S.kind = "warn"; return render(); }
  S.busy = true; S.msg = "Sending…"; S.kind = ""; render();
  /* ⭐ misuse review 10: the picture is of the screen as it was when Feedback was OPENED (a notice may be gone a minute later) */
  let shot = null;
  if(S.shot && S.shotP){ try{ shot = await S.shotP; }catch(_){ shot = null; } }
  const id = newId("FB");
  const meta = {v: 2, id, type: S.type, text, at_utc: new Date().toISOString(), by: who(), context: context(), dictated: !!S.dictated, has_screenshot: false};
  const item = {id, meta, tried: false, at: Date.now()};
  if(shot){ try{ await IDB.put("shot-" + id, shot); item.shotKey = "shot-" + id; }catch(_){} }   // PM-3307: the picture waits with the report
  S.outbox.push(item); save();                                        // ⭐ kept before anything leaves the tablet
  item.sending = true;
  try{
    const r = await deliver(item, shot);
    S.outbox = S.outbox.filter(x => x.id !== id);
    S.sent.unshift({id, text, at: meta.at_utc, row: r && r.id}); save();
    S.text = ""; S.dictated = false; ls.set(KEY_DRAFT, ""); S.shotP = null;
    S.msg = "Sent — thank you. The team sees it on the online Ideas & fixes board" + (r && r.id && String(r.id) !== id ? " (#" + r.id + ")" : "") + ".";
    S.kind = "good";
  }catch(e){
    if(e && e.retry === false){
      /* refused for good: not kept (it would be refused again); the words stay in the box with the reason, press Send to try again */
      S.outbox = S.outbox.filter(x => x.id !== id); if(item.shotKey) IDB.del(item.shotKey); save();
      S.text = text; ls.set(KEY_DRAFT, text);
      S.shotP = screenshot(); S.shotP.catch(() => {});               // the panel is hidden from the picture, so a fresh one is the same screen
      S.msg = "Not sent: " + e.reason + " Your words are still here — press Send to try again."; S.kind = "warn";
    }else{
      S.msg = "Not sent yet — kept on this tablet and sent by itself when it can (" + ((e && (e.reason || e.message)) || "no connection") + ").";
      S.kind = "warn"; S.text = ""; ls.set(KEY_DRAFT, ""); S.shotP = null;
    }
  }
  item.sending = false;
  S.busy = false; render();
}

/* ── voice: record (pieces of ~50 s) → POST each to /v1/dictate → the text into the box ── */
async function startRec(){
  if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)){
    S.msg = "This tablet cannot record here — use the microphone on the keyboard instead."; S.kind = "warn"; return render(); }
  let stream; try{ stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
  catch(_){ S.msg = "The microphone is blocked — allow it for this page, or use the microphone on the keyboard."; S.kind = "warn"; return render(); }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "";
  /* the service takes ~60 s pieces: a new recorder every PIECE_SEC on the same microphone, each piece a file of its own */
  const R = {state: "recording", stopping: false, mr: null, blobs: []};
  const piece = () => {
    const parts = [], mr = mime ? new MediaRecorder(stream, {mimeType: mime}) : new MediaRecorder(stream);
    mr.ondataavailable = e => { if(e.data && e.data.size) parts.push(e.data); };
    mr.onstop = () => {
      if(parts.length) R.blobs.push(new Blob(parts, {type: mr.mimeType || mime || "audio/webm"}));
      if(!R.stopping){ piece(); return; }
      R.state = "inactive"; stream.getTracks().forEach(t => t.stop()); clearInterval(S.timer); S.rec = null;
      if(R.blobs.length) transcribe(R.blobs); else { S.msg = "Nothing was recorded — type it instead."; S.kind = "warn"; render(); }
    };
    R.mr = mr; mr.start();
  };
  S.rec = R; S.sec = 0; piece();
  S.timer = setInterval(() => { S.sec++; const b = el("rxFbMic"); if(b) b.textContent = "Stop (" + S.sec + " s)";
    if(S.sec >= MAX_SEC) stopRec(); else if(S.sec % PIECE_SEC === 0 && R.mr && R.mr.state === "recording") R.mr.stop(); }, 1000);
  S.msg = "Listening — press Stop when you are done."; S.kind = ""; render();
}
function stopRec(){ const R = S.rec; if(R && R.state !== "inactive"){ R.stopping = true; if(R.mr && R.mr.state !== "inactive") R.mr.stop(); } }
async function transcribe(input){
  const blobs = (Array.isArray(input) ? input : [input]).filter(Boolean), aid = newId("AUD");
  S.dict = aid; S.msg = "Turning your voice into text…"; S.kind = ""; render();
  const texts = [];
  try{
    for(const b of blobs){ texts.push(await T.dictate(b)); if(S.dict !== aid) return; }
  }catch(e){
    if(S.dict !== aid) return;
    if(e && e.retry !== false && e.code !== "daily_limit"){
      /* PM-3307: no connection — the recording waits on the tablet and becomes a report by itself when the connection is back */
      try{
        const keys = []; for(let i = 0; i < blobs.length; i++){ const k = "aud-" + aid + "-" + i; await IDB.put(k, blobs[i]); keys.push(k); }
        const box = el("rxFbText");
        S.voice.push({aid, keys, texts, mime: blobs[0].type, type: S.type, draft: box ? box.value : S.text, ctx: context(), by: who(), at_utc: new Date().toISOString()});
        if(box) box.value = ""; S.text = ""; ls.set(KEY_DRAFT, "");
        save(); S.dict = "";
        S.msg = "No connection — your voice note is saved on this tablet. It is turned into text and sent by itself when the connection is back.";
        S.kind = "good"; return render();
      }catch(_){ S.dict = ""; S.msg = "The recording could not be sent (" + ((e && (e.reason || e.message)) || "no connection") + ") and this tablet cannot keep it — type it instead."; S.kind = "warn"; return render(); }
    }
    const got = texts.filter(t => t && t.trim()).join(" ").trim();
    if(got){ const box = el("rxFbText"); const cur = box ? box.value : S.text; S.text = (cur.trim() ? cur.trim() + " " : "") + got; S.dictated = true; if(box) box.value = S.text; }
    S.dict = ""; S.msg = (got ? "Part of it did not come through — check the words and add the rest. " : "Could not turn the recording into text — type it instead. ") + ((e && e.code === "daily_limit") ? e.reason : "");
    S.kind = "warn"; return render();
  }
  const got = texts.filter(t => t && t.trim()).join(" ").trim();
  if(got){
    const box = el("rxFbText"); const cur = box ? box.value : S.text;
    S.text = (cur.trim() ? cur.trim() + " " : "") + got; S.dict = ""; S.dictated = true;
    if(box) box.value = S.text;                                      // render() re-reads the box, so the text goes INTO it first
    S.msg = "Here is what you said — fix anything, then Send."; S.kind = "good"; return render();
  }
  S.dict = ""; S.msg = "Could not turn the recording into text — type it instead."; S.kind = "warn"; render();
}

/* ── the button and the panel ── */
function paint(){
  const f = el("rxFbFab"); if(!f) return;
  const nw = S.outbox.length + S.voice.length;
  f.innerHTML = "Feedback" + (nw ? ` <span style="background:var(--stop,#b3261e);color:#fff;border-radius:9px;padding:0 7px;font-size:12px">${nw} waiting</span>` : "");
  f.setAttribute("aria-expanded", String(S.open));
}
function render(){
  paint();
  let box = el("rxFb");
  if(!S.open){ if(box) box.remove(); return; }
  if(!box){ box = document.createElement("div"); box.id = "rxFb"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Send feedback");
    box.style.cssText = "position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(64px + env(safe-area-inset-bottom,0px));z-index:9999;"+
      "width:min(440px,calc(100vw - 24px));max-height:calc(100vh - 90px);overflow:auto;background:var(--ground,#fff);color:var(--ink,#222);"+
      "border:2px solid var(--ink,#222);border-radius:8px;padding:14px 16px;box-shadow:0 6px 24px rgba(0,0,0,.25);font-size:16px";
    document.body.appendChild(box); }
  const cur = el("rxFbText"); if(cur) S.text = cur.value;
  const lab = {bug: "Something is wrong", idea: "Idea", question: "Question"};
  const msgCol = S.kind === "good" ? "var(--go,#1b7f3b)" : S.kind === "warn" ? "var(--stop,#b3261e)" : "var(--ink-2,#555)";
  box.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><strong style="font-size:18px">Feedback</strong>
       <button type="button" id="rxFbClose" data-act="fb-close" style="min-height:48px;padding:6px 14px">Close</button></div>
     <div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">${["bug", "idea", "question"].map(t =>
       `<button type="button" class="rxFbType" data-act="fb-type" data-v="${t}" aria-pressed="${S.type === t}"
          style="min-height:48px;padding:8px 14px;${S.type === t ? "background:var(--ink,#222);color:var(--ground,#fff)" : ""}">${lab[t]}</button>`).join("")}</div>
     <label for="rxFbText" style="display:block;margin-bottom:4px">${S.type === "bug" ? "What happened, and what did you expect?" : S.type === "idea" ? "What would make this easier?" : "What would you like to know?"}</label>
     <textarea id="rxFbText" rows="4" maxlength="${MAX_TEXT}" style="width:100%;box-sizing:border-box;font-size:16px;padding:9px">${e_(S.text)}</textarea>
     <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">
       <button type="button" id="rxFbMic" data-act="fb-mic" ${S.dict ? "disabled" : ""} style="min-height:48px;padding:9px 14px">${S.rec ? "Stop (" + S.sec + " s)" : S.dict ? "Turning it into text…" : "🎤 Talk instead of typing"}</button>
       <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="rxFbShot" data-act="fb-shot" ${S.shot ? "checked" : ""} style="width:22px;height:22px"> Include a picture of this screen</label>
     </div>
     <div style="font-size:13px;color:var(--ink-3,#666);margin:4px 0 8px">Sent with it: the screen you are on, the item and PO open, this tablet and your name.</div>
     <div id="rxFbMsg" role="status" style="min-height:1.2em;color:${msgCol};margin-bottom:8px">${e_(S.msg)}</div>
     <button type="button" class="primary" id="rxFbSend" data-act="fb-send" ${S.busy || S.rec || S.dict ? "disabled" : ""} style="width:100%;min-height:48px">${S.busy ? "Sending…" : "Send feedback"}</button>
     ${(S.outbox.length + S.voice.length) ? `<div id="rxFbWaiting" style="margin-top:10px;font-size:14px;color:var(--stop,#b3261e)">${S.outbox.length + S.voice.length} waiting to send from this tablet${S.voice.length ? ` (${S.voice.length} voice note${S.voice.length === 1 ? "" : "s"})` : ""} — they go by themselves when the connection is back.</div>` : ""}
     ${S.sent.length ? `<div style="margin-top:12px;font-size:14px"><strong>Sent from this tablet</strong>${S.sent.slice(0, 5).map(s =>
        `<div style="margin-top:4px;color:var(--ink-2,#444)">${e_(String(s.text || "").slice(0, 70))}${String(s.text || "").length > 70 ? "…" : ""}
           <span class="num" style="font-size:12px;color:var(--ink-3,#777)"> · ${e_(s.at ? new Date(s.at).toLocaleString([], {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"}) : "")}</span></div>`).join("")}</div>` : ""}`;
  const t = el("rxFbText");
  if(t){
    t.addEventListener("input", () => { S.text = t.value; ls.set(KEY_DRAFT, S.text); });
    /* ⛔ misuse review 7: a SCAN while Feedback is open is the next case, not words — take it out of the text and hand it to the scanner */
    let run = null;
    t.addEventListener("keydown", (e) => {
      const now = performance.now(), printable = typeof e.key === "string" && e.key.length === 1;
      if(printable){ run = (run && now - run.last <= 40) ? {chars: run.chars + e.key, last: now, start: run.start} : {chars: e.key, last: now, start: t.selectionStart}; return; }
      if(e.key === "Enter" && run && run.chars.length >= 5 && now - run.last <= 150){
        e.preventDefault();
        const code = run.chars; run = null;
        const v = t.value, at = v.lastIndexOf(code);
        if(at >= 0){ t.value = v.slice(0, at) + v.slice(at + code.length); S.text = t.value; ls.set(KEY_DRAFT, S.text); }
        close();
        if(typeof handleScan === "function") handleScan(code);
        return;
      }
      run = null;
    });
  }
}
function open(){
  /* the picture is cloned NOW, before the panel is drawn (screenshot() clones synchronously, then draws in the background) */
  if(!S.shotP){ S.shotP = screenshot(); S.shotP.catch(() => {}); }
  S.open = true; S.msg = S.msg && S.kind === "good" ? "" : S.msg; render(); setTimeout(() => { const t = el("rxFbText"); if(t) t.focus(); }, 30); }
function close(){
  if(S.rec) stopRec(); S.open = false; S.shotP = null; render();   // the next open takes a fresh picture
  /* misuse review 8: back to the scan box when nothing else is asking, or the next scan goes nowhere */
  const pa = document.getElementById("promptArea"), sc = document.getElementById("scan");
  if(sc && !(pa && pa.innerHTML)) setTimeout(() => sc.focus(), 0);
}

/* ⛔ 2026-11-17 (Kaylyn, first live drop-off): the button and the panel sit ABOVE every .rx-overlay (z 9998 — the PO drawer,
   problems, put-away sheets): below it a tap closed the drawer, the picture showed the wrong screen and the text box could not
   be reached, so the cursor stayed in the scan box. Below the toast (10000) and the menu (10001). */
function mount(){
  if(el("rxFbFab")) return;
  const f = document.createElement("button");
  f.type = "button"; f.id = "rxFbFab"; f.setAttribute("data-act", "fb-open"); f.setAttribute("aria-haspopup", "dialog");
  f.style.cssText = "position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9999;"+
    "min-height:48px;padding:10px 18px;border-radius:24px;border:2px solid var(--ink,#222);background:var(--ground,#fff);color:var(--ink,#222);"+
    "font-weight:700;box-shadow:0 3px 12px rgba(0,0,0,.2)";
  document.body.appendChild(f); paint();
}
const ACTS = {
  "fb-open": () => (S.open ? close() : open()), "fb-close": () => close(),
  "fb-type": (a) => { const b = a.el || a; S.type = b.getAttribute("data-v") || "bug"; render(); },
  "fb-mic": () => (S.rec ? stopRec() : startRec()),
  "fb-shot": (a) => { const b = a.el || a; S.shot = !!b.checked; },
  "fb-send": () => { send(); }
};
/* clicks go through the core router (RX.registerAct, rx-core.js) — ONE handler per control, and the coverage gate sees it */
document.addEventListener("keydown", (e) => { if(e.key === "Escape" && S.open){ e.preventDefault(); e.stopImmediatePropagation(); close(); } }, true);
if(window.RX && RX.registerAct) for(const n of ["fb-open", "fb-close", "fb-type", "fb-mic", "fb-shot", "fb-send"]) RX.registerAct(n, (a) => { ACTS[n](a); return n === "fb-shot" ? undefined : "stop"; });

if(document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
setInterval(() => { if(S.outbox.length || S.voice.length) flush(); }, RETRY_MS);
setTimeout(() => { if(S.outbox.length || S.voice.length) flush(); }, 5000);
window.RXFeedback = { open, close, state: S, _flush: flush, _transcribe: transcribe, _setTransport: (t) => { T = Object.assign({}, T, t); }, _context: context };
})();
