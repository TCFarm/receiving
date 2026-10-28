/* receiving/rx/feedback.js — the FEEDBACK button on the receiving tablet (PM-3305). OWNER: Procurement & Merchandising (hosted in
   ProductPipeline/receiving).

   Jack, 2026-10-28: "It should be floating on their screen, maybe in the bottom right … so there's a way for them to dictate feedback on
   things that aren't working directly" and "Add the portal's feedback button to the receiving page."

   ⭐ ONE PIPELINE. This is the staff portal's button (staff-app public/shell/feedback.js + dictate.js) brought to this page, writing the
   SAME job rows, so a report lands exactly where a portal report does: the mini's `staffapp.feedback` handler posts a Teams card and adds
   ONE ledger row to the module's owner (`receiving` → Procurement & Merchandising, IT-Provisioning/Staff Portal/modules.json).
   ⭐ Everything goes through the ClaudeAgents site with the page's own sign-in (Sites.ReadWrite.All), never OneDrive:
     • the screenshot → StaffApp/feedback/<FB-id>/screenshot.png on the site drive;
     • the report     → an AgentJobs row, kind `staffapp.feedback`, Subject = the FB id, the meta in its Payload column;
     • a voice note   → StaffApp/audio/<AUD-id>/audio.webm + a `staffapp.transcribe` row; the text comes back in the row's Result
                        and lands in the box, editable. The mini deletes the audio once transcribed (Jack's app-wide ruling).
   ⛔ SENT ONCE. The FB id is made when Send is pressed and kept with the report until a row for it exists; a retry first looks the
      row up by Title, so a reply lost on the warehouse wifi never makes a second card.
   ⛔ NOTHING IS LOST OFFLINE. An unsent report waits on this tablet (localStorage) and is retried every minute; the button says so.
   API: window.RXFeedback = { open, close, state, _flush, _setTransport } */
(function(){
"use strict";
const SITE = "tcfarm0.sharepoint.com:/sites/ClaudeAgents", LIST = "AgentJobs";
const KEY_Q = "rx_fb_outbox_v1", KEY_SENT = "rx_fb_sent_v1", KEY_DRAFT = "rx_fb_draft_v1", KEY_V = "rx_fb_voice_v1";
const POLL_MS = 4000, TRANSCRIBE_MS = 180000, MAX_SEC = 120, RETRY_MS = 60000;
const S = { open: false, type: "bug", text: "", shot: true, busy: false, msg: "", kind: "", rec: null, sec: 0, timer: null,
            dict: "", siteId: null, listId: null, outbox: [], sent: [] };
const GRAPH = "https://graph.microsoft.com/v1.0";
const el = (id) => document.getElementById(id);
const e_ = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ls = { get(k, d){ try{ const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; }catch(_){ return d; } },
             set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(_){} } };
S.outbox = (ls.get(KEY_Q, []) || []).filter(x => x && x.id && x.meta);
S.sent = (ls.get(KEY_SENT, []) || []).filter(x => x && x.id).slice(0, 8);
S.text = String(ls.get(KEY_DRAFT, "") || "");                         // misuse review 10: a draft survives a reload
S.voice = (ls.get(KEY_V, []) || []).filter(x => x && x.aid && x.key);   // PM-3307: voice notes recorded with no connection

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

/* ── the transport: the page's own Graph sign-in (tests replace it) ── */
async function tok(){ if(typeof getToken !== "function") throw new Error("not signed in"); return getToken(); }
async function gfetch(url, opts){ const t = await tok(); const o = opts || {};
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 20000);          // review 10: a hung request ends
  try{ return await fetch(url, Object.assign({}, o, {signal: ac.signal, headers: Object.assign({}, o.headers || {}, {Authorization: "Bearer " + t})})); }
  finally{ clearTimeout(tm); } }
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
  async upload(rel, blob, ct){
    await T.ids();
    const url = GRAPH + "/sites/" + S.siteId + "/drive/root:/StaffApp/" + rel.split("/").map(encodeURIComponent).join("/") + ":/content?@microsoft.graph.conflictBehavior=fail";
    const r = await gfetch(url, {method: "PUT", headers: {"Content-Type": ct}, body: blob});
    if(r.status === 409) return {ok: true, path: "StaffApp/" + rel, existed: true};      // the same id was uploaded before
    if(!r.ok) await failOf(r, "the upload");
    return {ok: true, path: "StaffApp/" + rel};
  },
  async findRow(title){
    await T.ids();
    const base = GRAPH + "/sites/" + S.siteId + "/lists/" + S.listId + "/items?$expand=fields($select=State,Message,Title,Result)";
    const r = await gfetch(base + "&$top=20&$filter=" + encodeURIComponent("fields/Title eq '" + title.replace(/'/g, "''") + "'"),
                           {headers: {Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly"}});
    let all;
    if(r.ok) all = (await r.json()).value || [];
    else {                                                       /* SharePoint may refuse a filter on a non-indexed column: scan (bounded) */
      all = []; let next = base + "&$top=500", pages = 0;
      while(next && pages++ < 10){ const q = await gfetch(next); if(!q.ok) await failOf(q, "the job queue");
        const j = await q.json(); all = all.concat(j.value || []); next = j["@odata.nextLink"] || null; }
    }
    const rows = all.filter(it => it.fields && it.fields.Title === title).sort((a, b) => Number(b.id) - Number(a.id));
    return rows.length ? T._row(rows[0]) : null;
  },
  async row(id){
    await T.ids();
    const r = await gfetch(GRAPH + "/sites/" + S.siteId + "/lists/" + S.listId + "/items/" + encodeURIComponent(id) + "?$expand=fields($select=State,Message,Title,Result)");
    if(r.status === 404) return null; if(!r.ok) await failOf(r, "the job queue");
    return T._row(await r.json());
  },
  _row(it){ const f = it.fields || {}; let res = null; try{ res = f.Result ? JSON.parse(f.Result) : null; }catch(_){}
    return {id: it.id, state: f.State || "", message: f.Message || "", result: res}; },
  async enqueue(kind, subject, payload){
    await T.ids();
    const fields = {Title: kind + ":" + subject, Kind: kind, Subject: subject, Params: "{}", State: "queued", Attempts: 0,
                    RequestedUtc: new Date().toISOString().slice(0, 19) + "Z", RequestedBy: (typeof account === "string" && account) || ""};
    /* ⛔ review 9: ALWAYS with its Payload. The portal can drop it (it also writes meta.json to the synced folder); this page writes no
       folder, so a row without its Payload is one the mini can never process — better kept on the tablet and retried */
    const pj = JSON.stringify(payload); if(pj.length > 60000) throw new Error("the report is too long to send");
    fields.Payload = pj;
    const r = await gfetch(GRAPH + "/sites/" + S.siteId + "/lists/" + S.listId + "/items",
                           {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({fields})});
    if(!r.ok) await failOf(r, "the job queue");
    return {id: (await r.json()).id};
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

/* ── send: the screenshot first, then ONE row (looked up before every retry) ── */
async function deliver(item, shot){
  const files = Object.assign({}, item.files || {});
  if(!shot && item.shotKey && !files["screenshot.png"]){ try{ shot = await IDB.get(item.shotKey); }catch(_){ shot = null; } }
  if(shot && !files["screenshot.png"]){
    try{ const u = await T.upload("feedback/" + item.id + "/screenshot.png", shot, "image/png"); if(u && u.ok){ files["screenshot.png"] = u.path; item.meta.has_screenshot = true; } }
    catch(e){ item.meta.has_screenshot = false; item.meta.screenshot_error = String((e && e.message) || "upload failed").slice(0, 120); }
  }
  item.files = files;
  if(files["screenshot.png"] && item.shotKey){ IDB.del(item.shotKey); delete item.shotKey; }
  if(item.tried){ const have = await T.findRow("staffapp.feedback:" + item.id); if(have) return have; }   // ⛔ never a second row
  item.tried = true; save();
  return T.enqueue("staffapp.feedback", item.id, {v: 1, meta: item.meta, files});
}
function save(){ ls.set(KEY_Q, S.outbox.map(x => ({id: x.id, meta: x.meta, files: x.files || {}, tried: !!x.tried, at: x.at, shotKey: x.shotKey || ""})));
  ls.set(KEY_SENT, S.sent.slice(0, 8)); ls.set(KEY_V, S.voice); }
let flushing = false;
async function flush(){
  if(flushing) return; flushing = true;
  try{ await flushVoice(); await flushOnce(); } finally{ flushing = false; }
}
/* PM-3307: a voice note recorded offline → uploaded, transcribed, then sent as a report (with the words typed at the time) by itself */
async function flushVoice(){
  for(const v of S.voice.slice()){
    try{
      if(!v.jid){
        const blob = await IDB.get(v.key); if(!blob){ S.voice = S.voice.filter(x => x !== v); save(); continue; }
        const u = await T.upload("audio/" + v.aid + "/" + v.file, blob, v.mime);
        let row = v.tried ? await T.findRow("staffapp.transcribe:" + v.aid) : null;
        if(!row){ v.tried = true; save();
          row = await T.enqueue("staffapp.transcribe", v.aid, {v: 1, id: v.aid, files: {[v.file]: u.path},
                                meta: {v: 1, id: v.aid, purpose: "feedback", module: "receiving", week: null, by: v.by, at_utc: v.at_utc, mime: v.mime}}); }
        v.jid = row.id; save();
      }
      const st = await T.row(v.jid); const rt = st && st.result;
      v.checks = (v.checks || 0) + 1; save();
      /* review 11: never "waiting" for ever — after ~30 checks (about half an hour of connection) the report goes without the words */
      const done = (rt && rt.id === v.aid) || (st && /^(refused|needs_human|failed)$/.test(st.state)) || v.checks >= 30;
      if(!done) continue;                                            // still being transcribed: next minute
      const said = (rt && rt.status === "ok" && rt.text && rt.text.trim()) ? rt.text.trim()
        : "(a voice note recorded offline could not be turned into text — recording " + v.aid + ")";
      const id = newId("FB");
      const meta = {v: 1, id, type: v.type || "bug", text: ((v.draft || "").trim() ? v.draft.trim() + " " : "") + said, at_utc: new Date().toISOString(),
                    by: v.by, context: v.ctx, has_audio: false, has_screenshot: false, auto: "a voice note recorded with no connection, sent when it came back"};
      S.outbox.push({id, meta, files: {}, tried: false, at: Date.now()});
      S.voice = S.voice.filter(x => x !== v); IDB.del(v.key); save();
    }catch(_){ break; }                                              // still offline: next minute
  }
}
async function flushOnce(){
  for(const item of S.outbox.slice()){
    if(item.sending) continue;                                       // review 10: send() is delivering this one right now
    try{
      const r = await deliver(item, null);
      S.outbox = S.outbox.filter(x => x.id !== item.id);
      S.sent.unshift({id: item.id, text: item.meta.text, at: item.meta.at_utc, row: r && r.id}); save();
    }catch(_){ break; }                                              // offline / sign-in: try again next minute
  }
  paint();
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
  const meta = {v: 1, id, type: S.type, text, at_utc: new Date().toISOString(), by: who(), context: context(), has_audio: false, has_screenshot: false};
  const item = {id, meta, files: {}, tried: false, at: Date.now()};
  if(shot){ try{ await IDB.put("shot-" + id, shot); item.shotKey = "shot-" + id; }catch(_){} }   // PM-3307: the picture waits with the report
  S.outbox.push(item); save();                                        // ⭐ kept before anything leaves the tablet
  item.sending = true;
  try{
    const r = await deliver(item, shot);
    S.outbox = S.outbox.filter(x => x.id !== id);
    S.sent.unshift({id, text, at: meta.at_utc, row: r && r.id}); save();
    S.text = ""; ls.set(KEY_DRAFT, ""); S.shotP = null; S.msg = "Sent — thank you. The team gets it on Teams and in the work list (" + id + ").";
    S.kind = "good";
  }catch(e){
    S.msg = "Not sent yet — kept on this tablet and sent by itself when it can (" + ((e && e.message) || "no connection") + ").";
    S.kind = "warn"; S.text = ""; ls.set(KEY_DRAFT, ""); S.shotP = null;
  }
  item.sending = false;
  S.busy = false; render();
}

/* ── voice: record → upload → staffapp.transcribe → the text into the box ── */
async function startRec(){
  if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)){
    S.msg = "This tablet cannot record here — use the microphone on the keyboard instead."; S.kind = "warn"; return render(); }
  let stream; try{ stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
  catch(_){ S.msg = "The microphone is blocked — allow it for this page, or use the microphone on the keyboard."; S.kind = "warn"; return render(); }
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || "";
  const rec = mime ? new MediaRecorder(stream, {mimeType: mime}) : new MediaRecorder(stream), parts = [];
  rec.ondataavailable = e => { if(e.data && e.data.size) parts.push(e.data); };
  rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); clearInterval(S.timer); S.rec = null;
    transcribe(new Blob(parts, {type: rec.mimeType || mime || "audio/webm"})); };
  S.rec = rec; S.sec = 0; rec.start();
  S.timer = setInterval(() => { S.sec++; const b = el("rxFbMic"); if(b) b.textContent = "Stop (" + S.sec + " s)"; if(S.sec >= MAX_SEC) stopRec(); }, 1000);
  S.msg = "Listening — press Stop when you are done."; S.kind = ""; render();
}
function stopRec(){ if(S.rec && S.rec.state !== "inactive") S.rec.stop(); }
async function transcribe(blob){
  const mime = blob.type || "audio/webm", file = /mp4/.test(mime) ? "audio.mp4" : "audio.webm", aid = newId("AUD");
  S.dict = aid; S.msg = "Turning your voice into text…"; S.kind = ""; render();
  let attempted = false;
  try{
    const u = await T.upload("audio/" + aid + "/" + file, blob, mime);
    const meta = {v: 1, id: aid, purpose: "feedback", module: "receiving", week: null, by: who(), at_utc: new Date().toISOString(), mime};
    if(file !== "audio.webm") meta.audio_file = file;
    attempted = true;                                                // review 11: a lost reply must not queue a 2nd job later
    const q = await T.enqueue("staffapp.transcribe", aid, {v: 1, id: aid, files: {[file]: u.path}, meta});
    /* ⭐ counted polls, never the clock: a tablet's clock can jump (sleep, a time sync) and end the wait early */
    for(let n = 0; n < Math.ceil(TRANSCRIBE_MS / POLL_MS); n++){
      await new Promise(r => setTimeout(r, POLL_MS));
      if(S.dict !== aid) return;
      let st = null; try{ st = await T.row(q.id); }catch(_){ st = null; }
      const rt = st && st.result;
      if(rt && rt.id === aid){
        if(rt.status === "ok" && typeof rt.text === "string" && rt.text.trim()){
          const box = el("rxFbText"); const cur = box ? box.value : S.text;
          S.text = (cur.trim() ? cur.trim() + " " : "") + rt.text.trim(); S.dict = "";
          if(box) box.value = S.text;                                // render() re-reads the box, so the text goes INTO it first
          S.msg = "Here is what you said — fix anything, then Send."; S.kind = "good"; return render();
        }
        S.dict = ""; S.msg = "Could not turn the recording into text — type it instead."; S.kind = "warn"; return render();
      }
      if(st && /^(refused|needs_human|failed)$/.test(st.state)){ S.dict = ""; S.msg = "The voice service did not answer — type it instead."; S.kind = "warn"; return render(); }
    }
    S.dict = ""; S.msg = "No text after 3 minutes — the voice service may be offline. Type it instead."; S.kind = "warn"; render();
  }catch(e){
    /* PM-3307: no connection — the recording waits on the tablet and becomes a report by itself when the connection is back */
    try{
      const key = "aud-" + aid; await IDB.put(key, blob);
      const box = el("rxFbText");
      S.voice.push({aid, key, mime, file, type: S.type, draft: box ? box.value : S.text, ctx: context(), by: who(),
                    at_utc: new Date().toISOString(), tried: attempted});
      if(box) box.value = ""; S.text = ""; ls.set(KEY_DRAFT, "");
      save(); S.dict = "";
      S.msg = "No connection — your voice note is saved on this tablet. It is turned into text and sent by itself when the connection is back.";
      S.kind = "good"; render();
    }catch(_){ S.dict = ""; S.msg = "The recording could not be sent (" + ((e && e.message) || "no connection") + ") and this tablet cannot keep it — type it instead."; S.kind = "warn"; render(); }
  }
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
    box.style.cssText = "position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(64px + env(safe-area-inset-bottom,0px));z-index:9990;"+
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
     <textarea id="rxFbText" rows="4" style="width:100%;box-sizing:border-box;font-size:16px;padding:9px">${e_(S.text)}</textarea>
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

function mount(){
  if(el("rxFbFab")) return;
  const f = document.createElement("button");
  f.type = "button"; f.id = "rxFbFab"; f.setAttribute("data-act", "fb-open"); f.setAttribute("aria-haspopup", "dialog");
  f.style.cssText = "position:fixed;right:max(12px,env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9989;"+
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
