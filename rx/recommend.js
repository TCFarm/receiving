/* receiving/rx/recommend.js — the put-away RECOMMENDER. PURE: no DOM, no RX, no page globals, no clock of its own.
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   ⭐ ONE FUNCTION:   RXRecommend.rank(skuEntry, incomingBestBy, incomingUnits, pack, now) → result
      (also mounted at `RX.recommend` when the core is loaded). `skuEntry` = `pack.skus[sku]` (or null), `incomingBestBy` =
      'YYYY-MM-DD' or ''/null, `incomingUnits` = units arriving, `pack` = the whole pack (reads `pack.bins`, `pack.areas`,
      `pack.recommend`), `now` = epoch ms (passed in so the vectors are deterministic).

      result = { cands:[{bin, role, temp, units, oldest, daysCover, daysCoverWith, slow, lastIn, lots, score, best?}],
                 reason:{code, text, date?}, advice:[{code, text}], fefo:{measured, olderBin, olderDate},
                 other:[{bin, role, temp, units, mismatch:true}], area:{key,name,text}|null }

   ═══ THE RULES (MASTER-PLAN §9.8 — these OVERRIDE the UX design's ranking; mirrored by recommend_vectors.json) ═══
   1. CANDIDATES are the SKU's recent bins whose temperature matches the item. A bin of another temperature is NOT a
      candidate — it is listed under `other`. An inactive bin (`pack.bins[bin][2] === 0`) is dropped.
   2. RANK BY PREFERRED ROLE FIRST, THEN SCORE WITHIN THE ROLE. The preferred role comes from the FIRST rule that fires:
        INCOMING_OLDEST  the incoming best-by is older than EVERY dated lot on hand           ⇒ pick
        FEFO_BLOCK       a MEASURED backstock lot is OLDER than the incoming best-by          ⇒ backstock (the shelf is
                         blocked; new stock goes behind the older), + advice BRING_FORWARD
        PICK_EMPTY       the pick shelf holds nothing                                          ⇒ pick
        PICK_LOW         pick cover (units ÷ daily_rate) is under `pick_low_days` (3)          ⇒ pick
        PICK_STOCKED     otherwise                                                             ⇒ backstock (if any)
   3. ⛔ THE SAME best-by IS NOT OLDER. A lot dated like the incoming case never blocks and never makes it "oldest".
   4. ⛔ ONLY A MEASURED DATE BLOCKS. "Measured" = a Finale lot date in `candidates[].lots` (or a scan). `skus[sku].est_oldest`
      (the dated book, basis "estimated") produces ADVICE text only (EST_OLDER) and NEVER `fefo.measured`.
   5. CHECK_BACKSTOCK_DATES advice only when backstock is ON HAND and part of it is undated (suppressed when there is none).
   6. NO HISTORY (no candidate left) ⇒ an AREA-level suggestion from the storage class ("Cooler shelves — any spot").
   7. ⛔ The top candidate always agrees with the reason line: if the preferred role has no candidate the code is replaced
      by ONLY_PICK / ONLY_BACKSTOCK / LAST_PUT_AWAY, so a "BEST" pill never contradicts the sentence under it.
   Weights/thresholds come from `pack.recommend` (config/receiving_recommend.json); a missing key falls back to DEFAULTS. */
(function(){
"use strict";

const DEFAULTS = {
  role_fit: {preferred: 100, other_role: 40, staging: 10},
  history: {rcv_weight: 10, xin_weight: 5, cap: 30},
  recency: {recent_days: 14, recent_points: 20, stale_days: 56, stale_points: 10},
  has_stock_bonus: 15, fefo_block_penalty: -1000, fefo_unknown_pick_penalty: -25,
  pick_low_days: 3, top_n: 3, behind_older_bonus: 50, primary_pick_bonus: 500,
};
const AREA_BY_TEMP = {R: ["R0", "Cooler shelves"], D: ["DG", "Dry shelves"], F: ["F1", "Freezer floor"]};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function cfgOf(pack){
  const r = (pack && pack.recommend) || {};
  const out = {};
  for(const k of Object.keys(DEFAULTS)){
    const d = DEFAULTS[k], v = r[k];
    out[k] = (d && typeof d === "object") ? Object.assign({}, d, (v && typeof v === "object") ? v : {}) : (typeof v === "number" ? v : d);
  }
  return out;
}
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (x) => { const n = +x; return isFinite(n) ? n : 0; };
const dayNum = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
function shortDate(s){ const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? MON[+m[2] - 1] + " " + (+m[3]) : String(s || ""); }
function fmtDays(x){
  if(x == null || !isFinite(x)) return "";
  if(x < 1) return "under a day";
  const n = Math.round(x); return n + (n === 1 ? " day" : " days");
}
function areaFor(temp, pack){
  const t = String(temp || "").toUpperCase();
  const d = AREA_BY_TEMP[t]; if(!d) return null;
  const areas = (pack && pack.areas) || {};
  const name = areas[d[0]] || d[1];
  return {key: d[0], name, text: name + " — any spot"};
}

const REASON = {
  INCOMING_OLDEST: () => "This case is older than everything on hand — it goes on the shelf, in front.",
  FEFO_BLOCK: (x) => "Older dates are in backstock (" + shortDate(x.date) + ") — put this behind them.",
  PICK_EMPTY: () => "Pick shelf is empty — fill it.",
  PICK_LOW: (x) => "Shelf is running low (" + fmtDays(x.cover) + " left) — fill it.",
  PICK_STOCKED: (x) => "Shelf has " + fmtDays(x.cover) + " already — goes to backstock.",
  ONLY_PICK: () => "The pick shelf is the only place on record for this item.",
  ONLY_BACKSTOCK: () => "No pick shelf on record — backstock is the place.",
  LAST_PUT_AWAY: (x) => "This is where it was last put away" + (x.date ? " (" + shortDate(x.date) + ")." : "."),
  NO_HISTORY: () => "No history for this item — put it where it fits; we'll remember.",
};

function rank(S, incBest, incUnits, pack, now){
  const cfg = cfgOf(pack);
  const out = {cands: [], reason: null, advice: [], fefo: {measured: false, olderBin: null, olderDate: null}, other: [], area: null};
  S = S || {};
  const inc = isDate(incBest) ? incBest : null;
  const iu = num(incUnits) > 0 ? num(incUnits) : 0;
  const rate = num(S.daily_rate) > 0 ? num(S.daily_rate) : 0;
  const temp = S.temp ? String(S.temp).toUpperCase() : null;
  const binsMap = (pack && pack.bins) || {};
  const nowDay = dayNum(dayOf(now == null ? Date.now() : now));

  /* 1. candidates */
  const list = [];
  for(const c of (S.candidates || [])){
    if(!c || !c.bin) continue;
    const bi = binsMap[c.bin];
    if(bi && bi.length > 2 && !bi[2]) continue;                                   // inactive
    const ctemp = String(c.temp || (bi && bi[1]) || "").toUpperCase() || null;
    if(temp && ctemp && ctemp !== temp){ out.other.push({bin: c.bin, role: c.role || "unknown", temp: ctemp, units: num(c.units), mismatch: true}); continue; }
    const lots = (c.lots || []).filter(l => l && num(l[1]) > 0);
    const dated = lots.filter(l => isDate(l[0])).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const lotUnits = lots.reduce((a, l) => a + num(l[1]), 0);
    const units = c.units != null ? num(c.units) : lotUnits;
    const undated = lots.filter(l => !isDate(l[0])).reduce((a, l) => a + num(l[1]), 0) + Math.max(0, units - lotUnits);
    list.push({bin: c.bin, role: c.role || "unknown", temp: ctemp, units, lots, dated, undated, oldest: dated.length ? dated[0][0] : null,
               hist: c.hist || {}, lastIn: c.last_in || null});
  }

  if(!list.length){
    out.reason = {code: "NO_HISTORY", text: REASON.NO_HISTORY({})};
    out.area = areaFor(temp || (S.cls ? ({Refrigerated: "R", Dry: "D", Frozen: "F"}[S.cls]) : null), pack);
    return out;
  }

  /* 2. the preferred role */
  const primaryBin = S.pick && S.pick.bin ? String(S.pick.bin).toUpperCase() : null;
  const picks = list.filter(c => c.role === "pick");
  const primary = (primaryBin && picks.find(c => c.bin.toUpperCase() === primaryBin)) || picks[0] || null;
  const backs = list.filter(c => c.role === "backstock");
  const backOn = backs.filter(c => c.units > 0);
  const backUnits = backOn.reduce((a, c) => a + c.units, 0);
  const allDated = [];
  for(const c of list) if(c.units > 0) for(const l of c.dated) allDated.push(l[0]);
  const minDated = allDated.length ? allDated.reduce((a, b) => (a < b ? a : b)) : null;

  let older = null;                                                                  // the MEASURED older backstock lot
  if(inc){
    for(const c of backOn){
      if(c.oldest && c.oldest < inc && (!older || c.oldest < older.date || (c.oldest === older.date && c.units > older.units))) older = {bin: c.bin, date: c.oldest, units: c.units};
    }
  }
  let code, pref, cover = null;
  const pickUnits = primary ? primary.units : 0;
  if(inc && minDated && inc < minDated){ code = "INCOMING_OLDEST"; pref = "pick"; }
  else if(older){ code = "FEFO_BLOCK"; pref = "backstock"; out.fefo = {measured: true, olderBin: older.bin, olderDate: older.date};
    out.advice.push({code: "BRING_FORWARD", text: "Shelf low? Bring the older ones forward this trip."}); }
  else if(primary && pickUnits <= 0){ code = "PICK_EMPTY"; pref = "pick"; }
  else if(primary && rate > 0 && pickUnits / rate < cfg.pick_low_days){ code = "PICK_LOW"; pref = "pick"; cover = pickUnits / rate; }
  else if(primary){ code = backs.length ? "PICK_STOCKED" : "ONLY_PICK"; pref = backs.length ? "backstock" : "pick"; cover = rate > 0 ? pickUnits / rate : null; }
  else { code = "NO_PICK"; pref = backs.length ? "backstock" : "pick"; }                  // NO_PICK is rewritten below

  /* estimated / undated advice — ADVICE ONLY (rule 4, 5) */
  if(!older && inc && backUnits > 0){
    if(backOn.some(c => c.undated > 0))
      out.advice.push({code: "CHECK_BACKSTOCK_DATES", text: "Some backstock has no date on record — check it before you stack this in front."});
    const est = S.est_oldest;
    if(est && isDate(est.date) && est.date < inc){
      out.advice.push({code: "EST_OLDER", text: "Estimated: older stock may be in backstock (" + shortDate(est.date) + "). Check before you stack this in front.", date: est.date});
      out.fefo.olderDate = est.date;                                                  // measured stays false
    }
  }
  const unknownPick = out.advice.some(a => a.code === "CHECK_BACKSTOCK_DATES");

  /* 3. score + sort */
  const rf = cfg.role_fit, hs = cfg.history, rc = cfg.recency;
  for(const c of list){
    let s = (c.role === pref) ? rf.preferred : (c.role === "staging" || c.role === "unknown" ? rf.staging : rf.other_role);
    s += Math.min(hs.cap, hs.rcv_weight * num(c.hist.rcv) + hs.xin_weight * num(c.hist.xin));
    if(c.lastIn && isDate(c.lastIn)){ const d = nowDay - dayNum(c.lastIn); if(d <= rc.recent_days) s += rc.recent_points; else if(d <= rc.stale_days) s += rc.stale_points; }
    if(c.units > 0) s += cfg.has_stock_bonus;
    if(code === "FEFO_BLOCK" && c.role === "pick") s += cfg.fefo_block_penalty;
    if(unknownPick && c.role === "pick") s += cfg.fefo_unknown_pick_penalty;
    if(code === "FEFO_BLOCK" && older && c.bin === older.bin) s += cfg.behind_older_bonus;
    if(pref === "pick" && primary && c === primary) s += cfg.primary_pick_bonus;           // the sentence is about THIS shelf
    c.score = s;
    c.roleRank = c.role === pref ? 0 : (c.role === "pick" || c.role === "backstock" ? 1 : (c.role === "staging" ? 2 : 3));
  }
  list.sort((a, b) => (a.roleRank - b.roleRank) || (b.score - a.score) || (a.bin < b.bin ? -1 : a.bin > b.bin ? 1 : 0));

  /* 7. the top candidate must agree with the sentence */
  const top = list[0];
  if(top.role !== pref || code === "NO_PICK"){
    code = top.role === "pick" ? "ONLY_PICK" : (top.role === "backstock" ? "ONLY_BACKSTOCK" : "LAST_PUT_AWAY");
    if(code === "LAST_PUT_AWAY") cover = null;
  }
  const rdate = code === "FEFO_BLOCK" ? older.date : (code === "LAST_PUT_AWAY" ? top.lastIn : null);
  out.reason = {code, text: REASON[code]({date: rdate, cover}), date: rdate || null};

  out.cands = list.map((c, i) => {
    const isPick = c.role === "pick";
    return {bin: c.bin, role: c.role, temp: c.temp, units: c.units, oldest: c.oldest, lots: c.lots.map(l => [l[0], l[1]]),
            daysCover: isPick && rate > 0 ? c.units / rate : null, daysCoverWith: isPick && rate > 0 ? (c.units + iu) / rate : null,
            slow: isPick && rate <= 0, lastIn: c.lastIn, score: c.score, best: i === 0 ? true : undefined};
  });
  return out;
}

const api = {rank, DEFAULTS, shortDate, fmtDays, areaFor, cfgOf};
window.RXRecommend = api;
if(window.RX) window.RX.recommend = api;
})();
