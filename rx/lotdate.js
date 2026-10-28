/* receiving/rx/lotdate.js — best-by dates FILLED IN for the crew (PM-3297; Jack, 2026-10-28: "can we ensure the date is tracked and entered
   in for them?" … "save this by supplier what to expect and auto-decode the scans … so that next time that supplier is auto entered").
   OWNER: Procurement & Merchandising (hosted in ProductPipeline). Plan: Procurement & Merchandising/plans/2026-10-28-receiving-bestby-fill-PLAN.md.
   Classic script, no dependency on RX: it must keep working if the rx/ flow is rolled back.

   TWO SOURCES OF A DATE NOBODY TYPED:
     • LOT FORMATS — `lot_date_formats.json`, learned nightly by Procurement & Merchandising/scripts/build_lot_date_formats.py from the dates
       the crew typed against GS1 lots. Per key (supplier = catalog brand | lot shape): `suggest` (pre-typed, one Enter) or `auto`
       (entered, no tap — Jack 2026-10-28, after 3 DISTINCT lots agreed).
     • THE LAST CASE — the same product scanned earlier today on this tablet (140 of 148 repeat cases since 10-01 had the same date as the
       case before). ⛔ Always a suggestion, never entered: a mixed-date pallet is common enough that a silent copy would be wrong daily.

   ⛔ TODAY OVERRULES THE FILE. A row typed today for the same key whose date a format does not reproduce removes that format here and now
   (the file only catches up overnight), and an `auto` key with any disagreement today is only a suggestion for the rest of the day.
   ⛔ Every surviving format must decode the lot to the SAME real date, or there is no date at all.
   ⛔ decode()/candidates()/shape()/supplier() are pinned to `lot_date_vectors.json` together with the Python learner
   (test_lot_date_vectors.py runs both). Change one, change both.

   API (window.LotDate): decode(lot,f) candidates(lot,bb) shape(lot) supplier(brand) keyOf(brand,lot) load()
                         forLot({brand,lot}, rows) -> {date, mode, n, why} | null
                         lastCase(sku, rows) -> {date, at} | null
                         state() -> {loaded, keys, built} */
(function(){
"use strict";
const LAYOUTS = ["YYMMDD","MMDDYY","DDMMYY","YYYYMMDD","MMDDYYYY","MMYYYY","YYMM"];
const MAX_OFFSET = 1100;
const CACHE_KEY = "lot_date_formats_v1";
let FILE = {k:{}, built:"", loaded:false}, loadedDay = "";

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getUTCFullYear() + "-" + pad(d.getUTCMonth()+1) + "-" + pad(d.getUTCDate());
function parseFmt(f){
  const m = /^([YMD]+)@(\d+)(?::(first|last))?(?:\+(\d+))?$/.exec(String(f||""));
  if(!m || LAYOUTS.indexOf(m[1]) < 0) return null;
  return {lay:m[1], pos:+m[2], rule:m[3]||"", off:+(m[4]||0)};
}
function decode(lot, f){
  const p = parseFmt(f); if(!p) return null;
  const s = String(lot||"").slice(p.pos, p.pos + p.lay.length);
  if(s.length !== p.lay.length || !/^\d+$/.test(s)) return null;
  const part = (tok) => { const i = p.lay.indexOf(tok); return i >= 0 ? +s.slice(i, i + tok.length) : null; };
  let y = part("YYYY"); if(y == null){ const yy = part("YY"); y = yy == null ? null : 2000 + yy; }
  const mo = part("MM"); let d = part("DD");
  if(y == null || mo == null || mo < 1 || mo > 12) return null;
  if(d == null){
    if(p.rule !== "first" && p.rule !== "last") return null;
    d = p.rule === "first" ? 1 : new Date(Date.UTC(y, mo, 0)).getUTCDate();
  } else if(p.rule) return null;
  const dt = new Date(Date.UTC(y, mo-1, d));
  if(dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo-1 || dt.getUTCDate() !== d) return null;
  dt.setUTCDate(dt.getUTCDate() + p.off);
  return iso(dt);
}
function shape(lot){ return String(lot||"").replace(/[A-Za-z]/g, "A").replace(/\d/g, "N"); }
/* ⛔ PM-3297 review: the SUPPLIER is the catalog BRAND (`br`), never a UPC prefix — 39 seven-digit prefixes in catalog.json hold more
   than one brand (8500004 = Barebells, Dang AND Serenity Kids), so a prefix key let one brand's proven format auto-date another's. */
function supplier(brand){ return String(brand||"").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function keyOf(brand, lot){ const s = supplier(brand), l = String(lot||"").trim(); return (s && l) ? s + "|" + shape(l) : ""; }
function candidates(lot, bb){
  lot = String(lot||""); const out = new Set();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(bb||"")); if(!m) return out;
  const target = Date.UTC(+m[1], +m[2]-1, +m[3]);
  for(const lay of LAYOUTS){
    for(let pos = 0; pos + lay.length <= lot.length; pos++){
      const rules = lay.indexOf("DD") < 0 ? ["first","last"] : [""];
      for(const r of rules){
        const base = lay + "@" + pos + (r ? ":" + r : "");
        const d0 = decode(lot, base); if(!d0) continue;
        const n = Math.round((target - Date.parse(d0 + "T00:00:00Z")) / 86400000);
        if(n === 0) out.add(base);
        else if(n > 0 && n <= MAX_OFFSET && lay.indexOf("DD") >= 0) out.add(base + "+" + n);
      }
    }
  }
  return out;
}

/* ─────────── the published file ─────────── */
async function load(){
  loadedDay = todayStr();
  for(let i = 0; i < 2; i++){
    try{
      const r = await fetch("lot_date_formats.json", {cache: i ? "no-store" : "no-cache"});
      if(!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if(!j || typeof j.k !== "object") throw new Error("bad file");
      FILE = {k:j.k, built:j.built || "", loaded:true};
      try{ localStorage.setItem(CACHE_KEY, JSON.stringify(FILE)); }catch(_){}
      return;
    }catch(_){ await new Promise(res => setTimeout(res, 400)); }
  }
  /* ⛔ NON-FATAL: no file means no lot dates, never a stopped scan. Last good copy on this tablet. */
  try{ const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if(c && c.k) FILE = Object.assign(c, {loaded:true}); }catch(_){}
}

const todayStr = () => { const t = new Date(); return t.getFullYear() + "-" + pad(t.getMonth()+1) + "-" + pad(t.getDate()); };
const rowDay = (r) => { const t = new Date(r._at || 0); return t.getFullYear() + "-" + pad(t.getMonth()+1) + "-" + pad(t.getDate()); };
const baseOf = (s) => String(s||"").split("+")[0].replace(/^audit_/, "");
/* today's rows that carry a human-checked date for this key — typed, accepted, or an auto date someone corrected */
function todaysEvidence(key, rows){
  const day = todayStr(), out = [];
  for(const r of (rows || [])){
    if(!r || r.deleted || !r.best || !r.lot || rowDay(r) !== day) continue;
    if(keyOf((r.prod||{}).br, r.lot) !== key) continue;
    /* ⛔ same evidence rule as the nightly learner: never an audit row, never a carried last-case date (nobody read it off this lot) */
    const src = String(r.source||"");
    if(r.audit || /^audit_/.test(src) || /\+lastcase/.test(src)) continue;
    const b = baseOf(src);
    if(b === "keyed_gs1nodate" || /\+lotsuggest/.test(src) || b === "gs1_lot") out.push(r);
  }
  return out;
}

/* -> {date, mode, n, why} | null for the lot on this scan */
function forLot(item, rows){
  const lot = String((item && item.lot) || "").trim();
  const key = keyOf((item && item.brand) || "", lot);
  if(!key) return null;
  const e0 = FILE.k[key], ent = (e0 && Array.isArray(e0.f)) ? e0 : null;      // ⛔ a malformed entry is no entry, never a crash
  let fs = ent ? ent.f.slice() : null, mode = ent ? ent.m : "suggest", n = ent ? ent.n : 0, local = false;
  let disagreed = false;
  for(const r of todaysEvidence(key, rows)){
    const c = candidates(r.lot, r.best);
    if(fs == null){ fs = [...c].filter(f => f.indexOf("+") < 0); local = true; continue; }
    const keep = fs.filter(f => c.has(f));
    if(keep.length !== fs.length) disagreed = true;
    fs = keep;
  }
  if(!fs || !fs.length) return null;
  /* ⛔ misuse review: a tablet left on overnight must not keep auto-filling from yesterday's file — reload on a new day, and a file
     more than 36 h old only ever suggests */
  if(loadedDay && loadedDay !== todayStr()) load().catch(()=>{});
  const age = Date.now() - Date.parse(FILE.built || "");
  if(!(age >= 0 && age <= 36 * 3600e3)) mode = "suggest";
  if(disagreed || local) mode = "suggest";
  if(mode === "suggest") fs = fs.filter(f => f.indexOf("+") < 0);
  const dates = new Set(fs.map(f => decode(lot, f)));
  if(dates.size !== 1 || dates.has(null)) return null;
  const date = [...dates][0];
  return {date, mode, n, key, why: local ? "this supplier's lot, from a case typed earlier today"
                              : (mode === "auto" ? `read from the lot number — this supplier's format, proven on ${n} lots`
                                                 : "read from the lot number — this supplier's format")};
}

/* -> {date, at} for the same product's most recent case today on this tablet (receiving only).
   ⛔ A DIFFERENT LOT is a different batch: when this case and the last one both carry a lot and they differ, the last date is not
   offered (found by the test kit 2026-10-28 — a new lot was pre-typed with the old lot's date). */
function lastCase(sku, rows, lot){
  if(!sku || String(sku).startsWith("!")) return null;
  const day = todayStr();
  let best = null;
  for(const r of (rows || [])){
    if(!r || r.deleted || r.audit || !r.best || !r.prod || r.prod.sku !== sku || rowDay(r) !== day) continue;
    if(!best || (r._at || 0) > (best._at || 0)) best = r;
  }
  if(best && lot && best.lot && String(best.lot).trim() !== String(lot).trim()) return null;
  return best ? {date: best.best, at: best._at || 0} : null;
}

window.LotDate = {decode, candidates, shape, supplier, keyOf, load, forLot, lastCase,
                  state: () => ({loaded: FILE.loaded, keys: Object.keys(FILE.k || {}).length, built: FILE.built}),
                  _set: (k) => { FILE = {k: k || {}, built: "test", loaded: true}; }};
})();
