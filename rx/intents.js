/* receiving/rx/intents.js — the ReceivingIntents client, the outbox, polling, poster status and CHIPS.
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   The contract is `Procurement & Merchandising/meetings/receiving-designs/INTENTS-INTERFACE.md` (list
   `ReceivingIntents` on tcfarm0.sharepoint.com:/sites/ClaudeAgents). ⛔ The page writes ONLY page-owned columns and
   NEVER a Fin* column (the Mac-mini poster owns those). `RX.INTENT_FIELDS` / `RX.INTENT_CHOICES` below MUST equal
   `lib/receiving_intents.py` PAGE_COLUMNS / CHOICES — a seams test diffs them by PARSING THIS FILE, so keep them as
   plain literals.

   ═══ WHAT AN INTENT IS HERE ═══
   One "put-away" of (part of) one scanned case. The BB Receipts row (the best-by ledger) stays ONE row per case;
   a split case has several intents sharing `SplitOf`. Intents are advisory + evidence: the poster, not the page,
   decides what reaches Finale.

   ═══ THE RULES THAT MAKE IT SAFE ═══
   • ⭐ IntentId `ri-<uuid4>` is minted at scan time and is the dedupe key (a UNIQUE column).
   • ⛔ LOOKUP BEFORE RETRY: once a POST has been attempted its outcome is unknown (the reply may have been lost).
     The next attempt first reads `fields/IntentId eq '…'`; a found item is ADOPTED, never re-POSTed. A duplicate
     answer (409, or a 4xx naming a unique/duplicate violation) ⇒ look it up ⇒ saved. ⇒ exactly one item.
   • ⭐ THE OUTBOX `rx_intents_v1` NEVER PRUNES AN UNSENT ROW (§9.4). Only rows already safe in SharePoint and final
     (posted / refused / shadow / cancelled / skipped) are pruned, after midnight; anything unsent survives for ever
     and stays in "On tablet n".
   • ⛔ 403 ⇒ DENIED, never "saved": the chip reads "Receive in Finale app" and a `!INTENT_DENIED` telemetry row goes
     out through the page's own reject(). A denied row is NOT retried (a retry after the crew received it in Finale
     would double-receive). 401 ⇒ the page's sign-in banner; the row is held and sent after sign-in.
   • PATCH always carries `If-Match: <etag>`. 412 ⇒ re-read; if the poster has already acted (FinState ≠ '') the change
     is refused: a cancel becomes `CancelTooLate=true`, an edit becomes a `Kind=fix` row for the buyer.
   • Polling: every POLL_OPEN while anything is not final, else POLL_IDLE; every read has a time limit; a late answer
     is dropped by a generation guard.

   ═══ API (RX.intents) ═══
   create(fields, meta)          → rec   (full page-column map; fills IntentId/Kind/PageMode/ScanDay/ScanAt/Device/Operator)
   createFromRow(row)            → [rec] (called by RX.onCommit from row.rx.fields — see rx-core.js §5)
   patch(iid, colFields)         → 'queued'|'merged'|'too_late'|'none'  (unsent ⇒ merged into the pending POST)
   cancel(iid)                   → 'cancelled'|'too_late'|'none'
   fix({of, units, bin, note})   → rec    (Kind=fix; the poster ignores it, Julia's tab lists it)
   byId(iid)  forRow(row) → [rec]  allToday() → [{iid, fields, fin, itemId, etag, local}]  editable(rec)
   chipFor(row) → {text, tone, title, rank, since?}|null     chipOf(rec) → same for one intent
   query(odataFilter, {select})  → [{id, etag, iid, fields, fin}]  (paged; throws on ANY failure — never partial)
   allPo() → allToday() ∪ every intent of the open pack POs (any day, any tablet; 2026-10-22)
   flush()  unsent()  poll()  denied()  resolveList()  state
   rec = {iid, day, createdAt, fields, itemId, etag, sent, tried, inflight, patches[], fin, denied, cancelled, …} */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const CFG = RX.CFG, I = RX.intents, t = RX.t;

RX.INTENT_FIELDS = ["IntentId","Kind","State","PageMode","ScanDay","ScanAt","ReadyAt","Po","Sku","Upc","Gtin14","Units","Cases","CaseQty","QtyKind","BestBy","Lot","Location","BinSource","Workflow","StagedArea","RecommendedBin","RecReasons","SplitOf","TempConfirmed","FefoOverride","ShortDated","CancelTooLate","OverConfirmed","DamagedUnits","RejectedUnits","RawScans","PhotoUrls","Operator","Device","BbItemId","PlacedBy","FixUnits","FixBin","FixNote"];
RX.INTENT_CHOICES = {"Kind":["intent","fix"],"State":["staged","ready","skipped","cancelled"],"PageMode":["off","shadow","live"],"QtyKind":["full","part"],"BinSource":["scanned","typed","armed"],"Workflow":["direct","staged"]};
const FIN_FIELDS = ["FinState","FinReason","FinPo","FinShipment","FinBatch","FinAt","FinUnitsPosted","FinUnitsHeld","FinUnitsWould"];
const NUM = new Set(["Units","Cases","CaseQty","DamagedUnits","RejectedUnits","FixUnits"]);
const BOOL = new Set(["TempConfirmed","FefoOverride","ShortDated","CancelTooLate","OverConfirmed"]);
const CORE_COLS = ["IntentId","State","PageMode","ScanDay","Sku","Units"];
const KEY = "rx_intents_v1";
const PAGE_SEL = RX.INTENT_FIELDS.filter(k => k !== "RawScans" && k !== "PhotoUrls").concat(FIN_FIELDS).join(",");   // the two long note columns are never needed in a list read

I.state = { listErr:"", storeErr:"", resolving:false, deniedAt:0, lastTelemetry:0, lastPollAt:0, lastPollErr:"", polls:0 };

/* ───────────────────────── the store (outbox + last-known status) ───────────────────────── */
/* ⛔ ROUND-2 AUDIT 2026-10-19 (5): TWO TABS ON ONE TABLET SHARE `rx_intents_v1`. Each tab held the whole outbox in memory and
   save() wrote it back WHOLE, so the second tab's save silently erased every intent the first tab had queued (and a reload
   then lost them for good). Every write is now a MERGE: re-read the stored copy, merge it with this tab's by intent id, write
   the union. The rules that make the merge safe:
     • a record this tab CHANGED since its last sync gets a higher `rev` and wins its fields; one it did not change takes the
       stored copy (the other tab's edit). Records only one side knows are kept.
     • facts that only ever move one way are UNIONED whatever the rev: sent, tried, denied, an unsent cancel, the queued
       patches (by patch id, minus the ones either side already applied — `doneP`), the poster's FinState.
     • a delete leaves a TOMBSTONE (`gone`, 3 days). A tombstone for a CANCEL is applied as a cancel in the other tab (it may
       have already tried to send it); a tombstone for a PRUNE never deletes a record that still has work to send.
     • the merge is IN PLACE (same objects), so a send in flight keeps its references; a patch is removed by id, never shift().
   Another tab's write arrives through the `storage` event and is merged without a write-back (no ping-pong). */
const recJson = (r) => { const o = {}; for(const k of Object.keys(r)) if(k !== "inflight") o[k] = r[k]; return JSON.stringify(o); };
let lastJson = {};
function loadStore(){
  const s = RX.store.get(KEY, null);
  const out = {v:1, recs:{}, gone:{}};
  if(s && s.v === 1 && s.recs && typeof s.recs === "object"){
    for(const k of Object.keys(s.recs)){ const r = s.recs[k]; if(r && r.iid && r.fields && typeof r.fields === "object") { r.inflight = false; r.patches = Array.isArray(r.patches) ? r.patches : []; out.recs[k] = r; } }
    if(s.gone && typeof s.gone === "object") out.gone = s.gone;
  }
  lastJson = {}; for(const k of Object.keys(out.recs)) lastJson[k] = recJson(out.recs[k]);
  return out;
}
let S = loadStore();
const hasWork = (r) => (!r.sent && !r.cancelled && !r.denied) || (r.patches && r.patches.length) || (!r.sent && r.tried);
function drop(k, why){ if(S.recs[k]){ delete S.recs[k]; } S.gone = S.gone || {}; S.gone[k] = {at:RX.now(), why:why || "prune"}; delete lastJson[k]; }
I._drop = drop;
function mergeInto(m, d){
  const dRev = d.rev || 0, mRev = m.rev || 0;
  const base = dRev > mRev ? d : m, other = base === m ? d : m;
  const mp = new Map((m.patches || []).map(p => [p && p.id, p]));
  const done = new Set([...(m.doneP || []), ...(d.doneP || [])]);
  const order = [], seen = new Set();
  for(const p of (base.patches || []).concat(other.patches || [])){ if(!p || !p.id || seen.has(p.id) || done.has(p.id)) continue; seen.add(p.id); order.push(mp.get(p.id) || p); }
  const sent = !!(m.sent || d.sent), tried = !!(m.tried || d.tried);
  const sentSide = m.sent ? m : (d.sent ? d : base);
  const fin = (base.fin && base.fin.FinState) ? base.fin : ((other.fin && other.fin.FinState) ? other.fin : (base.fin || {}));
  if(base !== m){
    for(const k of Object.keys(base)){ if(k === "inflight" || k === "patches") continue; m[k] = base[k]; }
    m.fields = Object.assign({}, base.fields);
  }
  m.patches = order; m.doneP = [...done].slice(-100);
  m.sent = sent; m.tried = tried; m.fin = fin;
  if(sent){ m.itemId = m.itemId || sentSide.itemId || other.itemId || null; m.etag = sentSide.etag || m.etag || null; m.sentAt = m.sentAt || sentSide.sentAt || null; }
  m.denied = m.denied || other.denied || null;
  m.outcome = (m.outcome === "unknown" || d.outcome === "unknown") ? "unknown" : ((m.outcome || d.outcome) || undefined);
  if(!sent && (m.cancelled || d.cancelled)){ m.cancelled = true; m.fields.State = "cancelled"; }
  m.rev = Math.max(mRev, dRev);
  return m;
}
function applyTombstone(k, g){
  const r = S.recs[k]; if(!r) return;
  if(g && g.why === "cancel"){
    /* the other tab cancelled it (or voided it). If this tab already tried / sent it, the cancel must still reach the server */
    if(r.sent){ if(!r.cancelled && !r.patches.some(p => p.fields && p.fields.State === "cancelled")){ r.patches.push({id:RX.newId(), fields:{State:"cancelled"}, tries:0, prevState:r.fields.State}); r.cancelled = true; r.fields.State = "cancelled"; } return; }
    if(r.tried || r.inflight){ r.cancelled = true; r.fields.State = "cancelled"; return; }
    delete S.recs[k]; delete lastJson[k]; return;
  }
  if(!hasWork(r)){ delete S.recs[k]; delete lastJson[k]; }
}
/* -> true when this tab had changes the stored copy does not have */
function syncDisk(){
  let disk = null; try{ disk = RX.store.get(KEY, null); }catch(_){}
  const drecs = (disk && disk.v === 1 && disk.recs && typeof disk.recs === "object") ? disk.recs : {};
  const dgone = (disk && disk.gone && typeof disk.gone === "object") ? disk.gone : {};
  S.gone = S.gone || {};
  let dirty = false;
  for(const k of Object.keys(S.recs)){ const r = S.recs[k]; if(recJson(r) !== lastJson[k]){ const dr = drecs[k]; r.rev = Math.max(r.rev || 0, (dr && dr.rev) || 0) + 1; dirty = true; } }
  for(const k of Object.keys(dgone)) if(!S.gone[k]) S.gone[k] = dgone[k];
  for(const k of Object.keys(drecs)){
    const d = drecs[k]; if(!d || !d.iid || !d.fields || typeof d.fields !== "object") continue;
    const m = S.recs[k];
    if(!m){ if(S.gone[k] && !(S.gone[k].why === "cancel" && (d.sent || d.tried))) continue;
            d.inflight = false; d.patches = Array.isArray(d.patches) ? d.patches : []; S.recs[k] = d; continue; }
    mergeInto(m, d);
  }
  for(const k of Object.keys(S.recs)) if(!drecs[k] && lastJson[k] !== undefined && !S.gone[k] && recJson(S.recs[k]) === lastJson[k]) dirty = true;   // ours, missing on disk (the other tab overwrote it)
  for(const k of Object.keys(S.gone)) applyTombstone(k, S.gone[k]);
  const cut = RX.now() - 3 * 86400000;
  for(const k of Object.keys(S.gone)) if(!(S.gone[k] && S.gone[k].at > cut)) delete S.gone[k];
  return dirty;
}
function writeOut(){
  const ok = RX.store.set(KEY, S);
  if(ok){ lastJson = {}; for(const k of Object.keys(S.recs)) lastJson[k] = recJson(S.recs[k]); }
  return ok;
}
window.addEventListener("storage", (ev) => {
  if(ev && ev.key && ev.key !== KEY) return;
  try{ if(syncDisk()) writeOut(); else { lastJson = {}; for(const k of Object.keys(S.recs)) lastJson[k] = recJson(S.recs[k]); } RX.refresh(); }catch(_){}
});
/* ⛔ AUDIT 2026-10-19 (L): RX.store.set swallows a quota error, so a full localStorage left the outbox living ONLY in memory
   — a reload then lost every unsent intent, silently. A failed write first drops what is already safe (sent + final
   rows, the sent rows' RawScans copy), retries, and if it still fails RAISES storeErr + tells the crew once. */
function compactForSpace(){
  let n = 0;
  for(const k of Object.keys(S.recs)){ const r = S.recs[k];
    if(r.sent && !r.patches.length && isFinal(r)){ drop(k, "prune"); n++; continue; }
    if(r.sent && r.fields && r.fields.RawScans){ delete r.fields.RawScans; n++; } }
  return n;
}
function save(){
  try{ syncDisk(); }catch(e){ try{ console.error("rx: outbox merge failed", e); }catch(_){} }
  if(writeOut()){ if(I.state.storeErr){ I.state.storeErr = ""; RX.refresh(); } return true; }
  if(compactForSpace() && writeOut()){ I.state.storeErr = ""; return true; }
  if(!I.state.storeErr){ I.state.storeErr = "full"; try{ console.error("rx: rx_intents_v1 could not be saved (storage full?)"); }catch(_){}
    try{ RX.toast(t("store_full")); }catch(_){} RX.refresh(); }
  return false;
}
I._store = () => S;
I._save = save;
I._reload = () => { S = loadStore(); };
I.byId = (iid) => S.recs[iid] || null;
I.forRow = (row) => { const x = row && row.rx; if(!x) return []; const ids = (x.iids && x.iids.length) ? x.iids : (x.iid ? [x.iid] : []);
  return ids.map(i => S.recs[i]).filter(Boolean); };
const finOf = (f) => { const o = {}; let any = false; for(const k of FIN_FIELDS){ if(f && f[k] !== undefined && f[k] !== null && f[k] !== ""){ o[k] = f[k]; any = true; } } return any ? o : {}; };
const isFinal = (rec) => {
  if(rec.cancelled) return true;
  const fs = (rec.fin && rec.fin.FinState) || "";
  if(fs === "posted" || fs === "refused" || fs === "shadow") return true;
  if(rec.fields.State === "skipped" || rec.fields.State === "cancelled") return true;
  if(rec.fields.Kind === "fix") return true;
  if(rec.fields.PageMode === "shadow" && rec.sent && rec.fields.State !== "staged") return true;    // shadow ends at "Saved"
  return false;
};
I.isFinal = isFinal;
/* sent, or a POST was attempted whose outcome is not a definite refusal (round-2 (4)) */
I.maybeOnServer = (r) => !!r && (!!r.sent || (!!r.tried && r.outcome !== "refused"));
I.editable = (rec) => !!rec && !rec.denied && !(rec.fin && rec.fin.FinState);
I.unsent = () => Object.values(S.recs).filter(r => !r.sent && !r.denied && !r.cancelled).length
                 + Object.values(S.recs).filter(r => r.sent && r.patches.length).length;
I.denied = () => Object.values(S.recs).some(r => r.denied && r.day === RX.today());

/* ⭐ prune: ONLY rows that are safe in SharePoint AND final (or very old). ⛔ never an unsent row. */
function prune(){
  const today = RX.today(); let changed = false;
  for(const k of Object.keys(S.recs)){
    const r = S.recs[k];
    if(!r.sent && !r.denied && !r.cancelled) continue;                         // unsent: survives for ever (§9.4)
    /* ⛔ AUDIT (H): a cancelled row whose POST was ATTEMPTED has an unknown outcome — the server may hold a live intent that
       still needs its cancel (flush looks it up). Pruning it at midnight left that intent `ready` for the poster.
       ⛔ ROUND-2 (4): the same holds when that row was then DENIED (a 403 / persistent 401 on the lookup or the retry): the
       server may still hold the live intent, so a tried-but-unconfirmed row is NEVER pruned, denied or not. */
    if(!r.sent && I.maybeOnServer(r)) continue;
    if(r.inflight) continue;
    if(r.sent && r.patches.length) continue;                                    // an edit still to send
    if(r.day >= today) continue;
    /* ⛔ ROUND-2 (4): a row that was SENT and later denied (its edit / cancel refused) is on the server and its fate is not
       final from here — it stays until the poster's own answer makes it final. */
    if(r.sent && r.denied && !isFinal(r)) continue;
    const ageDays = (RX.now() - (r.createdAt || 0)) / 86400000;
    if(r.denied ? true : (isFinal(r) || ageDays > 3)){ drop(k, "prune"); changed = true; }
  }
  if(changed) save();
}
I.prune = prune;

/* ───────────────────────── building a page field set ───────────────────────── */
function sanitize(fields, L){
  const out = {};
  for(const k of RX.INTENT_FIELDS){
    let v = fields[k];
    if(v === undefined || v === null) continue;
    if(RX.INTENT_CHOICES[k]){ if(v === "" || RX.INTENT_CHOICES[k].indexOf(v) < 0) continue; out[k] = v; continue; }   // ⛔ choice: null, never ''
    if(NUM.has(k)){ v = +v; if(!isFinite(v)) continue; out[k] = v; continue; }
    if(BOOL.has(k)){ out[k] = !!v; continue; }
    v = String(v); if(v === "") continue; out[k] = v;
  }
  if(L && L.cols){ for(const k of Object.keys(out)){ if(!L.cols.has(k.toLowerCase())){ delete out[k]; if(!I._warned) I._warned = {}; if(!I._warned[k]){ I._warned[k] = 1; try{ console.warn("rx: list has no column", k); }catch(_){} } } } }
  return out;
}
const deviceId = () => { try{ return device; }catch(_){ return ""; } };
const acct = () => { try{ return account; }catch(_){ return ""; } };
const pageMode = () => (RX.mode() === "live" ? "live" : (RX.mode() === "off" ? "off" : "shadow"));

function newRec(fields, meta){
  const iid = fields.IntentId || RX.newId();
  const now = RX.now();
  const f = Object.assign({}, fields, {IntentId:iid});
  const rec = { iid, day:f.ScanDay || RX.dayKey(now), createdAt:now, fields:f, itemId:null, etag:null, sent:false, tried:false,
                inflight:false, patches:[], fin:{}, denied:null, cancelled:false, err:"", bbN:(meta && meta.bbN) || null };
  S.recs[iid] = rec; save();
  return rec;
}
I.create = function(fields, meta){
  const now = RX.now();
  const f = Object.assign({ Kind:"intent", PageMode:pageMode(), ScanDay:RX.dayKey(now), ScanAt:RX.iso(now),
                            Operator:acct(), Device:deviceId() }, fields);
  const rec = newRec(f, meta);
  I.kick();
  return rec;
};

I.baseFields = function(row, f, flow){
  const units = (f.units != null) ? f.units : row.units;
  const state = f.state || (flow === "sort" ? "staged" : "ready");
  const staged = (f.workflow ? f.workflow === "staged" : (flow !== "direct"));
  const caseQty = (row.qtyKind === "full" && row.units > 0) ? row.units : ((row.qtyShown > 0) ? row.qtyShown : null);
  const cases = (caseQty > 0 && units != null) ? Math.round(units / caseQty * 100) / 100 : null;
  const at = row._at || RX.now();
  const op = row._op || acct();
  return {
    Kind:"intent", State:state, PageMode:pageMode(), ScanDay:RX.dayKey(at), ScanAt:RX.iso(at),
    ReadyAt: state === "ready" ? RX.iso() : null,
    Po: row._po || "", Sku:row.prod.sku, Upc:row.upc || "", Gtin14:row.gtin || "",
    Units: units, Cases:cases, CaseQty:caseQty, QtyKind: row.qtyKind || null,
    BestBy: row.best || "", Lot: row.lot || "",
    Location: f.bin || "", BinSource: f.bin ? (f.binSource || "scanned") : null,
    Workflow: staged ? "staged" : "direct",
    StagedArea: f.stagedArea || "", RecommendedBin: f.recommendedBin || "",
    RecReasons: Array.isArray(f.recReasons) ? f.recReasons.join(",") : (f.recReasons || ""),
    SplitOf: f.splitOf || "", TempConfirmed: !!f.tempConfirmed, FefoOverride: !!f.fefoOverride, ShortDated: !!f.shortDated, OverConfirmed: !!f.overConfirmed,
    DamagedUnits: f.damaged || null, RejectedUnits: f.rejected || null,
    /* ⭐ ROUND 4 (D36): the evidence for the damaged units — the uploaded photos' web links (JSON list) and the crew's one-line
       "what's wrong" (FixNote is a text column; on an intent row it carries this note, Julia's credit tab reads it). */
    PhotoUrls: (Array.isArray(f.photoUrls) && f.photoUrls.length) ? JSON.stringify(f.photoUrls) : "",
    FixNote: f.fixNote ? String(f.fixNote).slice(0, 250) : "",
    RawScans: JSON.stringify(RX.state.scanLog.slice()),
    Operator: op, Device: deviceId(), BbItemId: row.id || "",
    PlacedBy: state === "ready" ? op : "",
  };
};

I.createFromRow = function(row){
  const rxs = row.rx, f = rxs.fields, flow = rxs.flow || RX.flow();
  rxs.iid = rxs.iid || RX.newId();
  const out = [];
  const main = I.baseFields(row, f, flow); main.IntentId = rxs.iid;
  if(f.damagedAll){ main.Units = 0; }
  out.push(newRec(main, {bbN:row.n}));
  const extras = Array.isArray(f.extra) ? f.extra : [];
  for(const ex of extras){
    const g = Object.assign({}, f, ex); delete g.extra;
    if(!ex.photoUrls) delete g.photoUrls; if(!ex.fixNote) delete g.fixNote;       // the evidence rides on the FIRST portion only (round 4)
    const fl = I.baseFields(row, g, flow);
    fl.IntentId = ex.iid || RX.newId(); fl.SplitOf = rxs.iid; fl.RawScans = "";
    out.push(newRec(fl, {bbN:row.n}));
  }
  /* ⛔ ROUND-2 (1): a case split AT SCAN — the first portion carries the ACK (SplitOf = its OWN id) in the same POST, so the
     poster's split check (lib/receiving_post.py split_verdict) accepts its sibling portions */
  if(out.length > 1) out[0].fields.SplitOf = rxs.iid;
  rxs.iids = out.map(r => r.iid);
  save(); I.kick();
  return out;
};

/* ───────────────────────── Graph plumbing ───────────────────────── */
async function G(path, opts, limit){
  const ctrl = new AbortController(); let timedOut = false;
  const tm = setTimeout(() => { timedOut = true; try{ ctrl.abort(); }catch(_){} }, limit || CFG.POLL_LIMIT);
  try{ return await graph(path, Object.assign({}, opts || {}, {signal:ctrl.signal})); }
  catch(e){ if(timedOut || (e && e.name === "AbortError")){ const x = new Error("timeout"); x.timeout = true; throw x; } throw e; }
  finally{ clearTimeout(tm); }
}
const relUrl = (u) => String(u || "").replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "");
const PREFER = {"Prefer":"HonorNonIndexedQueriesWarningMayFailRandomly"};

let SITE = null, LST = null, resolving = null;
async function resolveSite(){
  if(SITE) return SITE;
  const site = await G(`/sites/${CFG.intents.site}`);
  if(!site || !site.id) throw new Error("no ClaudeAgents site");
  SITE = site.id; return SITE;
}
I.resolveSite = resolveSite;
async function resolveList(){
  if(LST) return LST;
  if(resolving) return resolving;
  resolving = (async () => {
    const siteId = await resolveSite();
    const lists = await G(`/sites/${siteId}/lists?$filter=displayName eq '${CFG.intents.list}'`);
    if(!lists || !lists.value || !lists.value.length){ const e = new Error("list "+CFG.intents.list+" not found"); e.missing = true; throw e; }
    const L = {siteId, listId:lists.value[0].id, cols:null};
    try{
      const c = await G(`/sites/${siteId}/lists/${L.listId}/columns?$select=name`);
      if(c && c.value && c.value.length){ L.cols = new Set(c.value.map(x => String(x.name).toLowerCase())); }
    }catch(e){ if(e && e.status === 403) throw e; /* a column read that fails is not fatal: the POST decides */ }
    if(L.cols){ const miss = CORE_COLS.filter(k => !L.cols.has(k.toLowerCase())); if(miss.length){ const e = new Error("list is missing columns: "+miss.join(", ")); e.unready = true; throw e; } }
    LST = L; return L;
  })();
  try{ return await resolving; } finally{ resolving = null; }
}
I.resolveList = resolveList;
I._resetResolve = () => { SITE = null; LST = null; };

async function lookup(L, iid){
  const r = await G(`/sites/${L.siteId}/lists/${L.listId}/items?$expand=fields&$filter=${encodeURIComponent("fields/IntentId eq '"+String(iid).replace(/'/g, "''")+"'")}&$top=1`, {headers:PREFER});
  const v = r && r.value && r.value[0]; return v || null;
}
function adopt(rec, item){
  rec.itemId = String(item.id); rec.etag = item.eTag || item["@odata.etag"] || rec.etag; rec.sent = true; rec.sentAt = rec.sentAt || RX.now();
  rec.fin = finOf(item.fields || {}); rec.err = "";
}

function denyRec(rec, kind, e){
  rec.denied = kind; rec.err = (e && e.message) || kind; I.state.deniedAt = RX.now();
  const now = RX.now();
  if(now - I.state.lastTelemetry > 30*60*1000){
    I.state.lastTelemetry = now;
    try{ if(typeof reject === "function") reject("INTENT_DENIED", `${rec.iid} ${(e && e.status) || kind}`, rec.fields.Upc || ""); }catch(_){}
  }
  RX.emit("denied", rec); RX.refresh();
}
function failCommon(rec, e){
  if(e && e.status === 403){ denyRec(rec, "forbidden", e); return "denied"; }
  if(e && (e.unready || e.missing)){ denyRec(rec, "refused", e); return "denied"; }
  if(e && e.auth){
    /* ⛔ ROUND-2 (3): `graph()` already retried a 401 ONCE with a forced token refresh, so a 401 that reaches here (it carries
       `status`) was refused with a FRESH token — a permission problem, not an expired sign-in. The banner is still shown first
       (the wrong account may be signed in: a sign-in fixes that), the row stays HELD on the tablet (never "saved"), and if the
       401 is still there AUTH_401_LIMIT later the row becomes §9.12's denial: "Finale queue unreachable — receive in the Finale
       app" + a `!INTENT_DENIED` row. ⭐ An EXPIRED sign-in (no status: no token could be had at all) keeps the banner only —
       while signed out nothing, not even the telemetry, can reach SharePoint, and the one control that fixes it is that
       banner; the chip says "Held — sign in again" so the crew is never told it was saved. */
    if(e.status === 401){ rec.auth401 = true; if(!I.state.auth401At) I.state.auth401At = RX.now(); }
    rec.err = "held — sign in again"; try{ flagSignIn(); }catch(_){} return "auth";
  }
  rec.err = (e && e.message) || "network";
  return "net";
}
/* a call to the intents list WORKED: the 401 was transient (or fixed by a sign-in) */
function authOk(rec){
  if(rec){ rec.auth401 = false; if(rec.err === "held — sign in again") rec.err = ""; }
  if(I.state.auth401At){ I.state.auth401At = 0; for(const r of Object.values(S.recs)) r.auth401 = false; }
}
/* ⛔ ROUND-2 (3): the escalation runs on the clock, because while the banner is up NOTHING else runs (flush and poll pause) */
function authEscalate(){
  const at = I.state.auth401At; if(!at) return;
  if(RX.now() - at < (CFG.AUTH_401_LIMIT || 10*60*1000)) return;
  I.state.auth401At = 0;
  for(const r of Object.values(S.recs)){
    if(r.auth401 && !r.sent && !r.denied && !r.cancelled){ r.auth401 = false; denyRec(r, "unauthorized", {status:401, message:"the intents list refused this account (HTTP 401 after a fresh sign-in)"}); }
  }
  save(); RX.refresh();
}
I._authEscalate = authEscalate;

async function sendCreate(rec){
  let L; try{ L = await resolveList(); }catch(e){ return failCommon(rec, e); }
  if(rec.tried){
    try{ const found = await lookup(L, rec.iid); if(found){ adopt(rec, found); authOk(rec); return "ok"; } }
    catch(e){ return failCommon(rec, e); }
  }
  const wasTried = rec.tried;
  rec.tried = true; rec.inflight = true; save(); RX.refresh();
  try{
    const created = await G(`/sites/${L.siteId}/lists/${L.listId}/items`,
      {method:"POST", body:JSON.stringify({fields:Object.assign({Title:rec.iid}, sanitize(rec.fields, L))})}, 20000);
    if(!created || !created.id) throw new Error("no item id returned");      // ⛔ only a returned id counts as saved
    rec.itemId = String(created.id); rec.etag = created.eTag || created["@odata.etag"] || null;
    rec.sent = true; rec.sentAt = RX.now(); rec.err = ""; authOk(rec);
    return "ok";
  }catch(e){
    /* ⭐ ROUND-2 (4): a 401/403 ANSWER means the list refused THIS POST — nothing was created by it. `outcome` records
       whether every attempt so far was such a refusal ("refused") or one may have reached the list ("unknown" — a lost
       reply, a timeout, a 5xx). `tried` stays monotonic (lookup before retry); `outcome` decides the chip and the prune. */
    if(e && (e.status === 403 || e.status === 401)){ if(!wasTried && rec.outcome !== "unknown") rec.outcome = "refused"; }
    else rec.outcome = "unknown";
    if(e && e.status === 403) return failCommon(rec, e);
    if(e && e.auth) return failCommon(rec, e);
    /* ⭐ MEASURED (lead, 2026-10-18): a duplicate IntentId POST answers HTTP 400 (not 409). So ANY 400/409 is "look it
       up": found ⇒ saved (adopt id + etag); not found ⇒ a GENUINE error — shown, and the row stays UNSENT (never
       "saved", never silently dropped). Only 403 is a denial. */
    if(e && e.permanent){
      try{ const found = await lookup(L, rec.iid); if(found){ adopt(rec, found); return "ok"; } }catch(_){ return "net"; }
      rec.err = (e.message || "refused") + (e.status ? " (HTTP "+e.status+")" : "");
      return "perm";      // ⛔ AUDIT (D): NOT "net" — that broke the flush loop, so ONE refused row blocked every later intent
    }
    rec.err = (e && e.message) || "network"; return "net";   // timeout / network / 5xx: `tried` stays set ⇒ lookup next time
  }finally{ rec.inflight = false; save(); }
}

function etagOf(j){ return (j && (j.eTag || j["@odata.etag"])) || null; }
async function refreshRec(L, rec){
  const j = await G(`/sites/${L.siteId}/lists/${L.listId}/items/${rec.itemId}?$expand=fields`);
  if(j){ rec.etag = etagOf(j) || rec.etag; rec.fin = finOf(j.fields || {}); }
  return j;
}
async function patchOnce(L, rec, fields, etag){
  const headers = etag ? {"If-Match":etag} : {};
  const j = await G(`/sites/${L.siteId}/lists/${L.listId}/items/${rec.itemId}/fields`,
    {method:"PATCH", headers, body:JSON.stringify(sanitize(fields, L))}, 20000);
  rec.etag = etagOf(j) || rec.etag;
  return j;
}
/* page-owned columns that are EVIDENCE, not control: a change to only these never needs Julia (AUDIT E) */
const EVIDENCE = new Set(["BbItemId","RawScans","RecReasons","RecommendedBin"]);
const evidenceOnly = (f) => { const ks = Object.keys(f || {}); return ks.length > 0 && ks.every(k => EVIDENCE.has(k)); };
/* a patch that can never be applied: a control change becomes a fix row for Julia, never a silent drop */
/* ⛔ ROUND-2 (1): the SHRINK of a split never landed (the poster had the case first, another tablet moved it, the list refused
   it). The portions that were waiting on it are VOIDED — never sent, because the first part still carries every unit — and ONE
   fix row tells Julia where those units physically are. ⇒ never double-counted, never silently lost. -> true when it handled it */
function voidSplit(rec, p, why){
  const kids = (p && p.split) || []; if(!kids.length) return false;
  let units = 0, rej = 0; const bins = [];
  for(const cid of kids){
    const c = S.recs[cid]; if(!c) continue;
    units += +c.fields.Units || 0; rej += +c.fields.RejectedUnits || 0;
    if(c.fields.Location && bins.indexOf(c.fields.Location) < 0) bins.push(c.fields.Location);
    if(!c.sent && !c.tried && !c.inflight) drop(cid, "cancel");
    else { c.cancelled = true; c.fields.State = "cancelled"; if(c.sent) c.patches.push({id:RX.newId(), fields:{State:"cancelled"}, tries:0}); }
  }
  if(p.prevUnits != null){ rec.fields.Units = p.prevUnits; if(p.prevCases != null) rec.fields.Cases = p.prevCases; }
  if(p.prevSplitOf !== undefined) rec.fields.SplitOf = p.prevSplitOf;
  const where = rec.fields.Location || rec.fields.StagedArea || "its first shelf";
  const note = units ? `split not recorded (${why}): ${units} of these units are on ${bins.join(" + ") || "another shelf"}, but the list still has the whole case on ${where}`
                     : `split not recorded (${why}): ${rej} units were left as short, but the list still has the whole case on ${where}`;
  I.fix({of:rec.iid, units: units || null, bin: bins.join(" + "), note});
  try{ RX.toast(t("split_refused")); }catch(_){}
  return true;
}
function dropPatch(rec, p, why){
  if(voidSplit(rec, p, why)) return;
  const f = p.fields || {};
  if(f.State === "cancelled"){ rec.cancelled = false; rec.fields.State = p.prevState || (rec.fields.State === "cancelled" ? "ready" : rec.fields.State); }
  if(!evidenceOnly(f) && !p.tooLateOk){
    I.fix({of:rec.iid, units:f.Units, bin:f.Location, note:(f.State === "cancelled" ? "cancel" : "edit")+" refused: "+why});
    try{ RX.toast(t(f.State === "cancelled" ? "cancel_too_late" : "fix_sent")); }catch(_){}
  }
}
/* ⛔ ROUND-2 (5): a patch leaves the queue BY ID (never shift(): another tab's merge may have reordered the array while this
   one was on the wire) and its id is remembered in `doneP`, so a merge with a stale copy never re-queues it. */
function takeP(rec, p){
  rec.patches = (rec.patches || []).filter(x => x !== p && !(x && p && x.id === p.id));
  if(p && p.id){ rec.doneP = (rec.doneP || []).concat([p.id]).slice(-100); }
}
/* a patch that LANDED: run what was waiting on it (ROUND-2 (1): a placed-undo restores the staged original only now) */
function afterApplied(rec, p){
  const a = p && p.after; if(!a) return;
  const t0 = S.recs[a.iid]; if(!t0) return;
  const f = {Units: (+t0.fields.Units || 0) + (+a.addUnits || 0)};
  if(+t0.fields.CaseQty > 0) f.Cases = Math.round(f.Units / +t0.fields.CaseQty * 100) / 100;
  I.patch(a.iid, f, {expect:a.expect || null});
}
async function sendPatches(rec){
  let L; try{ L = await resolveList(); }catch(e){
    /* ⛔ AUDIT (G): the intent IS saved — a list problem now must not turn it into a "denied" (never-saved) row */
    if(e && e.auth && e.status !== 403) return failCommon(rec, e);
    rec.err = (e && e.message) || "network"; return "net";
  }
  while(rec.patches.length){
    const p = rec.patches[0];
    try{
      if(!rec.etag){ await refreshRec(L, rec); }
      if(rec.fin && rec.fin.FinState && !p.tooLateOk){ takeP(rec, p); await tooLate(L, rec, p); save(); continue; }
      /* ⛔ AUDIT (C): mark the patch IN FLIGHT — I.patch used to merge a newer edit into this object after its body was
         already serialised, and the shift() below then threw the newer edit away */
      p.sending = true;
      try{ await patchOnce(L, rec, p.fields, rec.etag); } finally { p.sending = false; }
      Object.assign(rec.fields, p.fields); takeP(rec, p); authOk(rec); afterApplied(rec, p); save();
    }catch(e){
      if(e && e.status === 412){
        let cur = null;
        try{ cur = await refreshRec(L, rec); }catch(e2){ return (e2 && e2.status === 403) ? "net" : failCommon(rec, e2); }
        p.tries = (p.tries || 0) + 1;
        if(rec.fin && rec.fin.FinState && !p.tooLateOk){ takeP(rec, p); await tooLate(L, rec, p).catch(()=>{}); save(); continue; }
        /* ⛔ ROUND-2 (1): a patch that assumed a State (a staged record being split / restored) is refused when the server
           moved on — another tablet placed it. Never written over someone else's placement. */
        const sf = (cur && cur.fields) || {};
        if(p.expect && sf.State && sf.State !== p.expect){ takeP(rec, p); dropPatch(rec, p, "someone else moved it (" + sf.State + ")"); save(); continue; }
        if(p.tries >= 3 && p.keep){ p.tries = 0; return "net"; }      // ⭐ evidence is never dropped: try again on the next flush
        if(p.tries >= 3){ takeP(rec, p); dropPatch(rec, p, "changed on another tablet"); save(); continue; }
        continue;
      }
      if(e && e.status === 404){ takeP(rec, p); voidSplit(rec, p, "the first part is gone from the list"); save(); continue; }       // the item is gone (retention) — nothing to edit
      if(e && e.status === 403){
        /* ⛔ AUDIT (G): 403 on a PATCH of a SAVED intent (e.g. the list lets a person edit only their own items, and another
           person is signed in now). It used to mark the rec `denied` — chip "Receive in Finale app" for a saved intent, and
           Cancel then DELETED it locally while the server copy stayed live. Now: the edit becomes a fix row + telemetry. */
        takeP(rec, p); dropPatch(rec, p, "HTTP 403");
        try{ if(typeof reject === "function") reject("INTENT_DENIED", `${rec.iid} patch 403`, rec.fields.Upc || ""); }catch(_){}
        save(); continue;
      }
      if(e && e.permanent){ takeP(rec, p); dropPatch(rec, p, "HTTP "+e.status); save(); continue; }
      return failCommon(rec, e);
    }
  }
  save(); return "ok";
}
/* the poster has already acted: a cancel becomes CancelTooLate, an edit becomes a fix request for Julia */
async function tooLate(L, rec, p){
  if(voidSplit(rec, p, "Finale already had the case")) { RX.refresh(); return; }
  const f = p.fields || {};
  /* ⛔ AUDIT (E): an evidence-only patch (the BB row id) after the poster acted is simply dropped — it used to become a
     fix row for the buyer and a "sent to Julia" toast after a perfectly normal put-away (any time the poster marked the intent
     before the BB row's id was known — every shadow intent on a slow BB save). */
  if(evidenceOnly(f)) return;
  if(f.State === "cancelled"){
    rec.cancelled = false; rec.cancelTooLate = true;
    rec.fields.State = p.prevState || (rec.fields.State === "cancelled" ? "ready" : rec.fields.State);
    /* ⛔ AUDIT (F): queued as its own patch (retried through a 412 with a fresh etag) — it used to be one try, swallowed */
    rec.patches.unshift({id:RX.newId(), fields:{CancelTooLate:true}, tries:0, tooLateOk:true});
    I.fix({of:rec.iid, note:"cancelled after Finale had it"});
    RX.toast(t("cancel_too_late"));
  }else{
    I.fix({of:rec.iid, units:f.Units, bin:f.Location, note:p.note || ""});
    RX.toast(t("fix_sent"));
  }
  RX.refresh();
}

/* ───────────────────────── editing API ───────────────────────── */
I.patch = function(iid, colFields, opts){
  const rec = S.recs[iid]; if(!rec) return "none";
  const expect = (opts && opts.expect) || null;
  if(rec.denied && !rec.sent) { Object.assign(rec.fields, colFields); save(); return "merged"; }
  if(!rec.sent){
    Object.assign(rec.fields, colFields);
    /* ⛔ AUDIT (B): once a POST has been attempted (or is on the wire) its body is fixed — an edit merged only into
       rec.fields was LOST when the item was adopted (lookup / list read) or the in-flight POST succeeded. Queue it too. */
    if(rec.tried || rec.inflight) rec.patches.push({id:RX.newId(), fields:Object.assign({}, colFields), tries:0});
    save(); I.kick(); return "merged";
  }
  if(!I.editable(rec)){ if(evidenceOnly(colFields)) return "too_late"; I.fix({of:iid, units:colFields.Units, bin:colFields.Location}); RX.toast(t("fix_sent")); return "too_late"; }
  const last = rec.patches[rec.patches.length - 1];
  if(last && !last.tries && !last.sending && !last.tooLateOk && !last.fields.State && !last.split && !last.after && !expect && !last.expect) Object.assign(last.fields, colFields);
  else rec.patches.push({id:RX.newId(), fields:Object.assign({}, colFields), tries:0, expect});
  Object.assign(rec.fields, colFields);                // optimistic local mirror
  save(); I.kick(); return "queued";
};
/* opts.after = {iid, addUnits, expect}: run ONLY once this cancel has LANDED on the server (ROUND-2 (1) — a staged placed-undo
   gives the units back to the staged original; doing it before the cancel is confirmed double-counts them if the poster got
   the portion first). A cancel that is too late never runs it. */
I.cancel = function(iid, opts){
  const rec = S.recs[iid]; if(!rec) return "none";
  const after = (opts && opts.after) || null;
  if(rec.denied && !rec.sent && !rec.tried){ drop(iid, "cancel"); if(after) afterApplied(rec, {after}); save(); return "cancelled"; }
  if(!rec.sent){
    const prev = rec.fields.State;
    rec.cancelled = true; rec.fields.State = "cancelled";
    /* ⛔ AUDIT (A): a cancel while the create POST is on the wire (or its outcome is unknown) is QUEUED as a patch — it used
       to set a local flag only, the POST then succeeded, and the server kept a live `ready` intent for the poster. */
    if(rec.inflight || rec.tried) rec.patches.push({id:RX.newId(), fields:{State:"cancelled"}, tries:0, prevState:prev, after});
    else if(after) afterApplied(rec, {after});                   // never attempted: it can never reach the server — safe now
    save(); I.kick(); return "cancelled";
  }
  if(!I.editable(rec)){
    rec.patches.push({id:RX.newId(), fields:{State:"cancelled"}, tries:0, tooLateOk:false}); save(); I.kick();   // sendPatches turns it into CancelTooLate + fix
    return "too_late";
  }
  rec.patches.push({id:RX.newId(), fields:{State:"cancelled"}, tries:0, prevState:rec.fields.State, after});
  rec.cancelled = true; rec.fields.State = "cancelled"; save(); I.kick(); return "cancelled";
};
/* ⛔⛔ ROUND-2 (1) THE SPLIT INVARIANT. A case split AFTER its first intent exists ("Not all fit?", a staged "Only some") is two
   writes: SHRINK the first intent, ADD the other portion(s). If the poster claims the first intent between them with its OLD
   units, the added portion double-counts the case. So:
     • the shrink is ONE patch that also writes the first intent's `SplitOf` = its OWN IntentId (the ACK), with If-Match;
     • the new portions are created GATED: they stay on this tablet (never POSTed) until that patch has LANDED (or, for an
       unsent first intent, until its POST — which then carries the shrink — has landed);
     • if the shrink is refused (the poster had it, another tablet moved it, 403/400), the portions are VOIDED and one fix row
       tells Julia where the units really are (voidSplit) — never double, never silently lost.
   The POSTER enforces the same invariant independently (lib/receiving_post.py `split_verdict`): a portion whose first part has
   no ACK waits while the first part is untouched and is HELD once the first part was acted on without it.
   -> {ok:true, children:[iid…]} | {ok:false, why:'too_late'|'none'} */
I.splitLate = function(iid, shrinkFields, childFieldsList, opts){
  const rec = S.recs[iid]; if(!rec) return {ok:false, why:"none"};
  if(!I.editable(rec) || rec.cancelled) return {ok:false, why:"too_late"};
  const expect = (opts && opts.expect) || null;
  const shrink = Object.assign({}, shrinkFields, {SplitOf: iid});
  const kids = [];
  const p = {id:RX.newId(), fields:shrink, tries:0, split:kids, expect, prevUnits:rec.fields.Units, prevCases:rec.fields.Cases, prevSplitOf:rec.fields.SplitOf || ""};
  const unsentClean = !rec.sent && !rec.tried && !rec.inflight;
  for(const cf of childFieldsList){
    const f = Object.assign({Kind:"intent", PageMode:pageMode(), ScanDay:RX.dayKey(), ScanAt:RX.iso(), Operator:acct(), Device:deviceId()}, cf);
    f.SplitOf = iid;
    const c = newRec(f, {});
    c.gate = {iid, pid: unsentClean ? null : p.id};
    kids.push(c.iid);
  }
  Object.assign(rec.fields, shrink);                       // the local mirror (and, unsent, the body of the POST)
  if(!unsentClean) rec.patches.push(p);
  save(); I.kick();
  return {ok:true, children:kids.slice()};
};
/* a gated portion may be sent only once its first part's shrink has LANDED */
function gateOpen(rec){
  const g = rec.gate; if(!g) return true;
  const P = S.recs[g.iid];
  if(!P || !P.sent) return false;
  if(g.pid && (P.patches || []).some(x => x && x.id === g.pid)) return false;
  if(g.pid && !(P.doneP || []).includes(g.pid)) return false;
  if(P.fields.SplitOf !== g.iid) return false;
  delete rec.gate; return true;
}
I._gateOpen = gateOpen;
I.fix = function(o){
  const of = S.recs[o.of];
  const f = { Kind:"fix", PageMode:pageMode(), Sku:of ? of.fields.Sku : "", Upc:of ? of.fields.Upc : "", Po:of ? of.fields.Po : "",
              SplitOf:o.of, FixUnits:o.units != null ? o.units : null, FixBin:o.bin || "", FixNote:String(o.note || "").slice(0, 250),
              Units:0 };
  return I.create(f, {});
};

/* ⭐ ROUND 4 (D36): the photo links arrive AFTER the intent exists when the upload had to wait for signal (rx/photos.js). PhotoUrls is a
   page-owned NOTE column the poster never reads, so — unlike a control edit — it is applied EVEN IF the poster already acted on the
   intent (`tooLateOk`), and a patch that keeps losing its If-Match race is retried, never dropped (`keep`): the evidence must not be
   lost to a race. -> 'merged' | 'queued' | 'none' */
I.setPhotoUrls = function(iid, urls){
  const rec = S.recs[iid]; if(!rec) return "none";
  const json = JSON.stringify(urls || []);
  rec.fields.PhotoUrls = json;
  if(!rec.sent && !rec.tried && !rec.inflight){ save(); I.kick(); return "merged"; }       // still the body of the unsent POST
  if(rec.denied && !rec.sent){ save(); return "merged"; }
  const last = rec.patches[rec.patches.length - 1];
  if(last && last.keep && !last.sending && !last.tries) last.fields.PhotoUrls = json;
  else rec.patches.push({id:RX.newId(), fields:{PhotoUrls:json}, tries:0, tooLateOk:true, keep:true});
  save(); I.kick(); return "queued";
};

/* ───────────────────────── flush ───────────────────────── */
let flushing = false, flushAgain = false;
I.kick = () => { setTimeout(() => { I.flush(); }, 0); };
I.flush = async function(){
  if(flushing){ flushAgain = true; return; } flushing = true;
  try{
    try{ if(needsSignIn) return; }catch(_){}
    const ids = Object.keys(S.recs).sort((a, b) => S.recs[a].createdAt - S.recs[b].createdAt);
    for(const iid of ids){
      const rec = S.recs[iid]; if(!rec || rec.denied) continue;
      if(!rec.sent && rec.cancelled){
        if(!rec.tried && !rec.inflight){ drop(iid, "cancel"); continue; }    // never attempted — nothing exists to cancel
        let L; try{ L = await resolveList(); const found = await lookup(L, iid);
          if(found){ adopt(rec, found); if(!rec.patches.some(p => p.fields && p.fields.State === "cancelled")) rec.patches.push({id:RX.newId(), fields:{State:"cancelled"}, tries:0}); }
          else { drop(iid, "cancel"); continue; }
        }catch(e){ const r = failCommon(rec, e); if(r === "net" || r === "auth") break; continue; }
      }
      if(!rec.sent && rec.gate && !gateOpen(rec)) continue;          // ROUND-2 (1): a split portion waits for its first part's shrink
      if(!rec.sent){ const r = await sendCreate(rec); if(r === "net" || r === "auth") break; if(r !== "ok") continue; }
      if(rec.sent && rec.patches.length){ const r = await sendPatches(rec); if(r === "net" || r === "auth") break; }
      if(rec.sent && !rec.denied) attachBb(rec);
    }
  } finally { flushing = false; save(); RX.refresh(); if(flushAgain){ flushAgain = false; I.kick(); } }
};
/* the BB Receipts id is only known once the scan row has saved: patch it onto the intent (evidence, not control) */
function attachBb(rec){
  if(rec.fields.BbItemId || rec.bbTried === 2 || rec.fields.Kind === "fix") return;
  let rowsNow = []; try{ rowsNow = rows; }catch(_){}
  const row = rowsNow.find(r => r.rx && ((r.rx.iids || []).indexOf(rec.iid) >= 0 || r.rx.iid === rec.iid));
  /* ⭐ UX audit 2026-10-19: kick a flush, or the patch waited for the next 20-60 s poll and the page showed a red
     "waiting to send … do not clear the browser data" banner + "On tablet 1" after EVERY put-away. */
  if(row && row.id && I.editable(rec)){ rec.bbTried = 2; rec.patches.push({id:RX.newId(), fields:{BbItemId:String(row.id)}, tries:0}); I.kick(); }
}

/* ───────────────────────── reading: today's list, poster status ───────────────────────── */
I.query = async function(filter, o){
  const L = await resolveList();
  const sel = (o && o.select) || PAGE_SEL;
  let url = `/sites/${L.siteId}/lists/${L.listId}/items?$expand=${encodeURIComponent("fields($select="+sel+")")}&$filter=${encodeURIComponent(filter)}&$top=200`;
  const out = []; let pages = 0;
  while(url){
    const j = await G(url, {headers:PREFER});
    if(!j || !Array.isArray(j.value)){ const e = new Error("bad list answer"); throw e; }
    for(const it of j.value){ const f = it.fields || {}; out.push({id:String(it.id), etag:etagOf(it), iid:f.IntentId, fields:f, fin:finOf(f)}); }
    url = j["@odata.nextLink"] ? relUrl(j["@odata.nextLink"]) : null;
    if(++pages > 25) throw new Error("too many pages");
  }
  return out;
};
RX.state.todayAll = new Map();
I.allToday = function(){
  const seen = new Set(), out = [];
  for(const [iid, v] of RX.state.todayAll){ const rec = S.recs[iid];
    out.push(rec ? {iid, fields:Object.assign({}, v.fields, rec.fields), fin:rec.fin && rec.fin.FinState ? rec.fin : v.fin, itemId:v.itemId, etag:rec.etag || v.etag, local:true}
                 : {iid, fields:v.fields, fin:v.fin, itemId:v.itemId, etag:v.etag, local:false}); seen.add(iid); }
  for(const rec of Object.values(S.recs)){ if(seen.has(rec.iid)) continue;
    out.push({iid:rec.iid, fields:rec.fields, fin:rec.fin || {}, itemId:rec.itemId, etag:rec.etag, local:true}); }
  return out;
};
const hasOpen = () => Object.values(S.recs).some(r => !r.denied && !isFinal(r));
const needList = () => !!(Object.keys(S.recs).length || (RX.pack.data && (RX.pack.data.pos || []).length));
function applyList(items){
  const m = new Map();
  for(const it of items){
    if(!it.iid) continue;
    m.set(it.iid, {itemId:it.id, etag:it.etag, fields:it.fields, fin:it.fin});
    const rec = S.recs[it.iid]; if(!rec) continue;
    if(!rec.sent){ adopt(rec, {id:it.id, eTag:it.etag, fields:it.fields}); }
    rec.itemId = rec.itemId || it.id; rec.etag = it.etag || rec.etag; rec.fin = it.fin || {}; rec.lastSeen = RX.now();
    if(!rec.patches.length){            // someone else (another tablet) may have moved it on: take the server's page-owned state
      for(const k of ["State","Location","BinSource","ReadyAt","PlacedBy","StagedArea","CancelTooLate","Units"]){
        if(it.fields[k] !== undefined && it.fields[k] !== null) rec.fields[k] = it.fields[k];
      }
      if(rec.fields.State === "cancelled") rec.cancelled = true;
    }
  }
  RX.state.todayAll = m; save();
}
async function pollList(gen){
  if(!needList()) return;
  const items = await I.query(`fields/ScanDay eq '${RX.today()}'`);
  if(gen !== pollGen) return;                // a late answer is ignored
  applyList(items); I.state.lastPollAt = RX.now(); I.state.lastPollErr = ""; authOk(null);
  await pollPo(gen);
  RX.emit("intents"); RX.refresh();
}
/* ⭐ 2026-10-22 (crew: "what is holding it up?"): EVERY intent of each OPEN pack PO, whatever day and tablet scanned it. Reading only
   ScanDay == today hid yesterday's staged and held cases from every tablet but the one that scanned them, so the PO drawer showed a
   truck at 95% with nothing to act on. Counters and problems read today ∪ these (I.allPo, de-duplicated by IntentId).
   ⛔ A failed read keeps the last good map (never "nothing is wrong"); only today's map is authoritative for this tablet's own rows. */
RX.state.poAll = new Map();
async function pollPo(gen){
  const pos = (RX.pack.data && RX.pack.data.pos || []).map(p => String(p.order_id || "")).filter(x => /^[\w-]{1,40}$/.test(x));
  if(!pos.length){ RX.state.poAll = new Map(); return; }
  try{
    const m = new Map();
    for(const po of pos){
      const items = await I.query(`fields/Po eq '${po}'`);
      if(gen !== pollGen) return;
      for(const it of items){ if(it.iid) m.set(it.iid, {itemId:it.id, etag:it.etag, fields:it.fields, fin:it.fin}); }
    }
    /* ⛔ review 2026-10-22 (4): this tablet's OWN earlier-day records were refreshed only by today's read, so a case another tablet
       put away yesterday still read "on a cart" here and every action met a stale etag. Bring sent records up to date from this read
       exactly as applyList does (fin, etag, page-owned columns when nothing of ours is queued). */
    for(const [iid, v] of m){
      const rec = S.recs[iid]; if(!rec || !rec.sent || rec.inflight || RX.state.todayAll.has(iid)) continue;
      rec.itemId = rec.itemId || v.itemId; rec.etag = v.etag || rec.etag; rec.fin = v.fin || {}; rec.lastSeen = RX.now();
      if(!rec.patches.length){
        for(const k of ["State","Location","BinSource","ReadyAt","PlacedBy","StagedArea","CancelTooLate","Units"]){
          if(v.fields[k] !== undefined && v.fields[k] !== null) rec.fields[k] = v.fields[k];
        }
        if(rec.fields.State === "cancelled") rec.cancelled = true;
      }
    }
    RX.state.poAll = m; I.state.poErr = ""; I.state.poLoaded = true; save();
  }catch(e){ I.state.poErr = (e && e.message) || "error"; }
}
I.allPo = function(){
  const out = I.allToday(), seen = new Set(out.map(x => x.iid));
  for(const [iid, v] of RX.state.poAll){ if(seen.has(iid)) continue; const rec = S.recs[iid];
    out.push(rec ? {iid, fields:Object.assign({}, v.fields, rec.fields), fin:rec.fin && rec.fin.FinState ? rec.fin : v.fin, itemId:v.itemId, etag:rec.etag || v.etag, local:true}
                 : {iid, fields:v.fields, fin:v.fin, itemId:v.itemId, etag:v.etag, local:false}); seen.add(iid); }
  return out;
};
async function pollPoster(gen){
  const ps = RX.poster;
  try{
    const siteId = await resolveSite();
    const j = await G(`/sites/${siteId}/drive/root:/${CFG.poster.path.split("/").map(encodeURIComponent).join("/")}:/content`);
    if(gen !== pollGen) return;
    if(j && typeof j === "object" && j.at){ ps.data = j; ps.status = "ok"; RX.store.set(RX.POSTER_KEY || "rx_poster_v1", {data:j, savedAt:RX.now()}); }
    else { ps.data = null; ps.status = "bad"; RX.store.del(RX.POSTER_KEY || "rx_poster_v1"); }
  }catch(e){
    if(gen !== pollGen) return;
    if(e && (e.status === 404)){ ps.data = null; ps.status = "absent"; RX.store.del(RX.POSTER_KEY || "rx_poster_v1"); }
    else { ps.status = "error"; }                 // keep the last good reading (in memory AND rx_poster_v1, round 5); the page shows its age
  }
  ps.readAt = RX.now(); RX.emit("poster", ps.data); RX.refresh();
}
I.posterDelayed = function(){
  const d = RX.poster.data; if(!d || !d.at) return false;
  const m = d.modes && d.modes[CFG.vendor]; if(m !== "live") return false;
  const ms = Date.parse(d.at); return !isNaN(ms) && (RX.now() - ms) > CFG.POSTER_STALE;
};
I.posterAgeMs = () => { const d = RX.poster.data; if(!d || !d.at) return null; const ms = Date.parse(d.at); return isNaN(ms) ? null : RX.now() - ms; };

let pollTimer = null, polling = false, pollGen = 0;
function schedule(){ clearTimeout(pollTimer); pollTimer = setTimeout(runPoll, hasOpen() ? CFG.POLL_OPEN : CFG.POLL_IDLE); }
async function runPoll(){
  if(polling){ schedule(); return; }
  polling = true; const gen = ++pollGen;
  try{
    I.state.polls++;
    let signedOut = false; try{ signedOut = !!needsSignIn; }catch(_){}
    if(!signedOut && RX.mode() !== "off"){
      await I.flush();
      await pollPoster(gen);
      try{ await pollList(gen); }catch(e){ I.state.lastPollErr = (e && e.message) || "error"; if(e && e.status === 403 || (e && (e.unready || e.missing))) I.state.listErr = I.state.lastPollErr; }
    }
  }catch(e){ try{ console.error("rx poll", e); }catch(_){} }
  finally{ polling = false; schedule(); }
}
I.poll = async () => { clearTimeout(pollTimer); await runPoll(); };
RX.onBoot(() => { prune(); setTimeout(runPoll, 50); });
RX.on("day", () => { prune(); RX.state.todayAll = new Map(); I.poll(); });
window.addEventListener("online", () => { I.kick(); });
RX.on("tick", authEscalate);

/* ───────────────────────── CHIPS (UX §3.4) ───────────────────────── */
const heldShort = (fin) => {
  const reason = String(fin.FinReason || ""); const code = (reason.split(":")[0] || "").trim().toUpperCase();
  const sentence = reason.indexOf(":") >= 0 ? reason.slice(reason.indexOf(":")+1).trim() : "";
  const map = { OVER_ORDERED: () => ((+fin.FinUnitsHeld || 0) ? (+fin.FinUnitsHeld)+" extra" : "extra"),
    NOT_ON_PO: () => "not on a PO", FINALE_APP_OVERLAP: () => "Finale app got it too", EXPIRED: () => "expired",
    DAMAGED: () => "damaged", STALE: () => "too old — receive in Finale app", TEMP_UNCONFIRMED: () => "temperature not confirmed",
    LOT_FORM_UNPROVEN: () => "lot not proven yet" };
  if(map[code]) return map[code]();
  return (sentence || code.toLowerCase().replace(/_/g, " ") || "see the buyer").slice(0, 40);
};
const refusedShort = (fin) => {
  const reason = String(fin.FinReason || ""); const code = (reason.split(":")[0] || "").trim().toUpperCase();
  const sentence = reason.indexOf(":") >= 0 ? reason.slice(reason.indexOf(":")+1).trim() : "";
  const map = { UNKNOWN_BIN: "shelf not recognised", BIN_DISABLED: "shelf switched off", RECEIVING_DISABLED: "shelf switched off", NOT_ON_PO: "not on a PO" };
  return map[code] || (sentence || code.toLowerCase().replace(/_/g, " ") || "see the buyer").slice(0, 40);
};
function chipOf(rec){
  const f = rec.fields, fin = rec.fin || {}, now = RX.now();
  const dmg = (+f.DamagedUnits > 0) ? " · "+t("chip_damaged", {n:f.DamagedUnits}) : "";
  const mk = (text, tone, rank, title, since) => ({text:text + dmg, tone, rank, title:title || "", since:since || null});
  if(rec.cancelled || f.State === "cancelled") return {text:t("chip_cancelled"), tone:"strike", rank:0, title:"", since:null};
  /* ⛔ ROUND-2 (4): a denied row whose POST was attempted may be ON the list (the reply was lost) — never tell the crew to
     receive it in the Finale app (a second receipt if the poster also posts it): Julia checks it. */
  if(rec.denied) return I.maybeOnServer(rec) ? mk(t("chip_denied_unsure"), "red", 93, t("denied_unsure_detail")) : mk(t("chip_receive_app"), "red", 92, t("denied_detail"));
  if(!rec.sent && rec.err === "held — sign in again") return mk(t("chip_signin"), "amber", 45, t("chip_signin_t"));
  if(!rec.sent) return rec.inflight ? mk(t("chip_sending"), "grey", 35) : mk(t("chip_ontablet"), "grey", 40, rec.err ? t("chip_ontablet_t")+" — "+rec.err : t("chip_ontablet_t"));
  if(f.State === "staged" && !fin.FinState) return mk(t("chip_staged", {area:f.StagedArea || "area"}), "blue", 25);
  const fs = fin.FinState || "";
  if(f.PageMode === "shadow" || f.State === "skipped" || fs === "shadow") return mk(t("chip_practice"), "dash", 20);
  if(fs === "posted") return mk(t("chip_infinale"), "green", 10);
  if(fs === "held") return mk(t("chip_held")+" · "+heldShort(fin), "violet", 60, String(fin.FinReason || ""));
  if(fs === "refused") return mk(t("chip_refused")+" · "+refusedShort(fin), "red", 90, String(fin.FinReason || ""));
  if(fs === "posting" || fs === "uncertain") return mk(t("chip_checking"), "amber", 50, String(fin.FinReason || ""));
  /* ready and not yet acted on */
  const ps = RX.poster;
  if(f.PageMode === "live" && ps.status === "ok" && ps.data){
    const m = ps.data.modes && ps.data.modes[CFG.vendor];
    if(m && m !== "live") return mk(t("chip_receive_app"), "red", 91, t("denied_detail"));
  }
  const t0 = Date.parse(f.ReadyAt || f.ScanAt) || rec.createdAt;
  const age = Math.max(0, now - t0);
  if(age < CFG.WAIT_SAVED) return mk(t("chip_saved"), "grey", 30);
  const clock = RX.clock(age);
  if(age < CFG.WAIT_SLOW) return mk(t("chip_waiting", {clock}), "amber", 50, t("chip_waiting_t"), t0);
  if(age < CFG.WAIT_ALERT) return mk(t("chip_slow", {clock}), "amber", 70, t("chip_waiting_t"), t0);
  return mk(t("chip_alert", {clock}), "red", 80, t("chip_waiting_t"), t0);
}
I.chipOf = chipOf;
/* ⭐ the row chip is the WORST of the portions. The page's own FAILED / UNSAVEABLE / "fix not sent" take priority
   (return null ⇒ the page draws its own tag), so B9/B10 behaviour is unchanged. */
I.chipFor = function(row){
  if(!row || !row.rx) return null;
  const recs = I.forRow(row); if(!recs.length) return null;
  if(row.saved === "FAILED" || row.saved === "UNSAVEABLE" || row.fix) return null;
  let best = null;
  for(const rec of recs){ const c = chipOf(rec); if(!best || c.rank > best.rank) best = c; }
  if(best && row.saved !== "saved" && best.rank < 40 && best.tone !== "strike"){ best = Object.assign({}, best, {text:t("chip_ontablet"), tone:"grey", rank:40, title:t("chip_ontablet_t")}); }
  return best;
};
})();
