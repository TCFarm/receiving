/* receiving/rx/po-drawer.js — the TABLET PO drawer, the per-row drawer, and the history-table extension.
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   ⛔ SCOPE (MASTER-PLAN §3 ⚖): Julia's reconciliation lives in the staff portal. The scanner keeps ONLY this tablet
   drawer — progress bar, filters, line rows that expand to their scans. NO desktop `?view=po`, no "Reviewed" column,
   no CSV export, no PO selector. Several open POs are stacked, oldest first.

   HISTORY TABLE (UX §6.1): when a new flow is on, or any row carries an intent, "Src" becomes Shelf and "Saved"
   becomes Status (the chip). In best-by-only the table is EXACTLY today's. Filter chips above it:
   [All] [Waiting] [Problems] [Staged]; portrait shows the last 8 rows plus [Show all].
   Tapping a row anywhere except its own correction cells opens the ROW DRAWER: PO + line, each split portion with its
   chip, suggested vs actual bin, source, who/when, the Finale shipment reference, the reason text for held/refused,
   and [Change shelf] (typed against the pack's bin list; WP4b's putaway may re-register `row-change-bin` with a scan),
   [Moved it? Tell Julia] (a Kind=fix row), [Not all fit?] (only if WP4b registered `last-split`), [Close].

   API (RX.drawer): openPo() openRow(row) close() histRows(rows) shelfCell(r) afterRender() refresh() state */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const D = RX.drawer, t = RX.t, esc = RX.esc;
const $ = (id) => document.getElementById(id);
const pageRows = () => { try{ return rows; }catch(_){ return []; } };
D.state = { open:null, rowN:null, poFilter:"all", poSearch:"", expanded:{}, hist:"all", showAll:false, editing:null, err:"" };
const H = D.state;

const showShelf = () => RX.active() && (RX.flowActive() || pageRows().some(r => r.rx && (r.rx.iid || (r.rx.iids || []).length)));
const portrait = () => { try{ return window.matchMedia("(orientation: portrait)").matches; }catch(_){ return false; } };
const bucket = (r) => {
  if(r.saved === "FAILED" || r.saved === "UNSAVEABLE" || r.fix) return "problems";
  /* ⭐ 2026-10-22: the problem map decides (rx/problems.js) — a held / refused scan the crew can fix is a problem; a staged case keeps
     its own chip (Staged) but the Problems filter lists it too (inProblems), because it is not in Finale until it is shelved */
  const pb = RX.problems ? RX.problems.forRow(r) : null;
  if(pb && pb.owner === "crew" && pb.kind !== "staged") return "problems";
  if(pb && pb.owner === "buyer") return "other";
  const c = RX.intents.chipFor(r); if(!c) return "other";
  if(c.tone === "red" || c.tone === "violet") return "problems";
  if(c.tone === "blue") return "staged";
  if(c.tone === "amber" || c.text === t("chip_ontablet") || c.text === t("chip_sending") || c.text === t("chip_saved")) return "waiting";
  return "other";
};

const inProblems = (r) => bucket(r) === "problems" || (bucket(r) === "staged" && !!(RX.problems && RX.problems.forRow(r)));
D.histRows = function(all){
  if(!showShelf()) return all;
  let out = all;
  if(H.hist !== "all") out = out.filter(r => H.hist === "problems" ? inProblems(r) : bucket(r) === H.hist);
  if(!H.showAll && H.hist === "all" && RX.flowActive() && portrait() && out.length > 8) out = out.slice(0, 8);
  return out;
};
D.shelfCell = function(r){
  if(!showShelf()) return null;
  const recs = RX.intents.forRow(r);
  const bins = [...new Set(recs.map(x => x.fields.Location).filter(Boolean))];
  let h = bins.length ? bins.map(b => `<span class="num">${esc(b)}</span>`).join("<br>") : (recs.some(x => x.fields.State === "staged") ? esc(recs[0].fields.StagedArea || "staged") : esc(t("shelf_none")));
  if(recs.some(x => x.fields.BinSource === "typed")) h += `<div class="hint" style="font-size:11px">${esc(t("shelf_typed"))}</div>`;
  return `<td>${h}</td>`;
};
D.afterRender = function(){
  const on = showShelf();
  const tb = $("histTable");
  if(tb){ const th = tb.querySelectorAll("thead th"); if(th.length >= 5){ th[3].textContent = on ? t("col_shelf") : "Src"; th[4].textContent = on ? t("col_status") : "Saved"; } }
  const tools = $("rxHistTools");
  const all = pageRows();
  if(tools){
    if(!on){ tools.innerHTML = ""; }
    else{
      const cnt = {problems:0}; for(const r of all) if(inProblems(r)) cnt.problems++;
      const f = (k, label, n) => `<button class="rx-chipbtn${H.hist === k ? " on" : ""}" data-act="hist-filter" data-f="${k}" aria-pressed="${H.hist === k}">${esc(label)}${n ? " "+n : ""}</button>`;
      const more = (RX.flowActive() && portrait() && H.hist === "all" && all.length > 8 && !H.showAll) ? `<button class="rx-chipbtn" data-act="hist-show-all">${esc(t("hist_show_all"))}</button>` : "";
      const h = f("all", t("hist_all")) + f("waiting", t("hist_waiting")) + f("problems", t("hist_problems"), cnt.problems) + f("staged", t("hist_staged")) + more;
      if(tools.dataset.h !== h){ tools.innerHTML = h; tools.dataset.h = h; }
    }
  }
  /* the tiles: Cases · In Finale · Waiting · Problems · No typing — only once an intent exists or a new flow is on */
  if(on && RX.flowActive()){
    let mine = all.filter(r => !r.audit); try{ mine = all.filter(r => !!r.audit === isAudit()); }catch(_){}
    let inF = 0, wait = 0, prob = 0, gs1 = 0;
    for(const r of mine){ const b = bucket(r); const c = RX.intents.chipFor(r);
      if(c && c.tone === "green") inF++; if(b === "waiting") wait++; if(inProblems(r)) prob++;
      if(String(r.source || "").endsWith("gs1")) gs1++; }
    const tiles = [[t("tile_cases"), mine.length, false], [t("tile_infinale"), inF, false], [t("tile_waiting"), wait, wait > 0 && false],
                   [t("tile_problems"), prob, prob > 0], [t("tile_notyping"), mine.length ? Math.round(gs1 / mine.length * 100)+"%" : "—", false]];
    const st = $("stats"); if(st) st.innerHTML = tiles.map(([l, v, bad]) => `<div class="stat${bad ? " bad" : ""}"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join("");
  }
  RX.call("ui", "renderStrip");
};
RX.registerAct("hist-filter", ({el}) => { H.hist = el.dataset.f || "all"; H.showAll = false; RX.refresh(); });
RX.registerAct("hist-show-all", () => { H.showAll = true; RX.refresh(); });
RX.registerAct("hist-row", ({el, ev}) => {
  if(ev.target.closest(".datecell,.unitcell,.delcell,.rx-pb,.rx-rowfix")) return;      // their own correction cells (and a problem's button) win
  if(!showShelf()) return;
  const row = pageRows().find(r => String(r.n) === el.dataset.n); if(row) D.openRow(row);
});
/* the correction cells keep their page behaviour; the data-act on them is the same name the control inventory uses */
for(const a of ["row-fix-date", "row-fix-units", "row-delete"]) RX.registerAct(a, () => {});

/* ───────────────────────── the drawer shell ───────────────────────── */
function shell(title, body, extra){
  return `<div class="rx-backdrop" data-act="drawer-close"></div>
    <section class="rx-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${extra || ""}>
      <header class="rx-sheet-h"><strong>${esc(title)}</strong><button class="rx-btn" data-act="drawer-close" data-close="3" aria-label="${esc(t("drawer_close"))}">${esc(t("drawer_close"))}</button></header>
      <div class="rx-sheet-b">${body}</div></section>`;
}
D.close = function(){
  H.open = null; H.rowN = null; H.editing = null; H.err = "";
  const el = $("rxDrawer"); if(el){ el.hidden = true; el.innerHTML = ""; }
  const s = $("scan"); if(s) s.focus();
};
RX.registerAct("drawer-close", () => D.close());
RX.registerAct("po-close", () => D.close());
D.openPo = function(){ H.open = "po"; H.poSearch = ""; D.refresh(true); RX.pack.data ? 0 : RX.pack.load(); };
RX.registerAct("po-open", () => D.openPo());
D.openRow = function(row){ H.open = "row"; H.rowN = row.n; H.editing = null; H.err = ""; D.refresh(true); };

D.refresh = function(force){
  const el = $("rxDrawer"); if(!el || !H.open) return;
  const a = document.activeElement;
  if(!force && a && el.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;      // never re-render under a typing finger
  el.hidden = false;
  const html = H.open === "po" ? poHtml() : rowHtml();
  if(el.dataset.h !== html || force){ el.innerHTML = html; el.dataset.h = html; }
  if(force){ const f = el.querySelector("input"); if(f) f.focus(); }
};

/* ───────────────────────── the PO drawer ───────────────────────── */
function poHtml(){
  const sum = RX.pack.data ? RX.po.summary() : [];
  const S = RX.pack.state;
  let body = "";
  if(!RX.pack.data){
    body = S.status === "loading" ? `<div class="rx-note">${esc(t("po_loading"))}</div>`
      : `<div class="rx-note rx-red">${esc(RX.pack.message() || t("pack_none"))} <button class="rx-btn" data-act="po-refresh">${esc(t("btn_try_again"))}</button></div>`;
    return shell("Delivery", body);
  }
  const fl = [["all", t("po_f_all")], ["notstarted", t("po_f_notstarted")], ["partial", t("po_f_partial")], ["done", t("po_f_done")], ["over", t("po_f_over")], ["short", t("po_f_short")], ["problems", t("po_f_problems")], ["notpo", t("po_f_notpo")]];
  body += `<div class="rx-chiprow">` + fl.map(([k, l]) => `<button class="rx-chipbtn${H.poFilter === k ? " on" : ""}" data-act="po-filter" data-f="${k}" aria-pressed="${H.poFilter === k}">${esc(l)}</button>`).join("") +
    `<button class="rx-btn" data-act="po-refresh" style="margin-left:auto">${esc(t("btn_refresh"))}</button></div>
    <input class="rx-search" id="rxPoSearch" type="search" placeholder="${esc(t("po_search_ph"))}" value="${esc(H.poSearch)}" aria-label="${esc(t("po_search_ph"))}">`;
  const q = H.poSearch.trim().toLowerCase();
  for(const x of sum){
    const pct = x.lines ? Math.round(x.done / x.lines * 100) : 0;
    /* ⭐ 2026-10-22: what is holding THIS truck, in counts the crew can act on; tapping it shows only those lines */
    const hold = [x.staged ? t("pb_sum_staged", {n:x.staged}) : "", (x.crew - x.staged) > 0 ? t("pb_sum_crew", {n:x.crew - x.staged}) : "", x.buyer ? t("pb_sum_buyer", {n:x.buyer}) : ""].filter(Boolean);
    body += `<div class="rx-pohead"><strong>PO ${esc(x.po.order_id)}</strong> · ${esc(x.due)}
      <div class="rx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${x.lines}" aria-valuenow="${x.done}"><span style="width:${pct}%"></span></div>
      <div class="hint">${esc(t("po_progress", {done:x.done, total:x.lines, pct}))}</div>
      <div class="rx-holding" data-po="${esc(x.po.order_id)}">${hold.length ? `<button type="button" class="rx-chipbtn${H.poFilter === "problems" ? " on" : ""}" data-act="po-filter" data-f="problems"><strong>${esc(t("pb_holding"))}:</strong> ${esc(hold.join(" · "))}</button>` : `<span class="hint">${esc(t("pb_none"))}</span>`}</div></div>`;
    let n = 0;
    (x.po.lines || []).forEach((line, i) => {
      const s = x.statuses[i];
      const info = RX.pack.skuInfo(line.sku) || {};
      const name = info.name || line.sku;
      /* a line just fixed stays in Problems while its answer is on screen ("Removed.", "Sent again…") — never vanishes mid-read */
      const said = RX.problems && s.scans.some(c => RX.problems.state.msg[c.iid]);
      if(H.poFilter === "problems" ? (s.problems === 0 && s.buyer === 0 && !said) : (H.poFilter !== "all" && H.poFilter !== "notpo" && s.state !== H.poFilter)) return;
      if(H.poFilter === "notpo") return;
      if(q && !(name.toLowerCase().includes(q) || String(line.sku).toLowerCase().includes(q) || RX.brandOf(line.sku).toLowerCase().includes(q))) return;   // PM-3332: brand searchable
      n++;
      const key = x.po.order_id+"|"+line.sku, open = !!H.expanded[key] || (H.poFilter === "problems" && H.expanded[key] !== false);
      body += `<div class="rx-line rx-${s.state}"><button class="rx-linebtn" data-act="po-line" data-key="${esc(key)}" aria-expanded="${open}">
        <span class="rx-lname">${esc(name)}${RX.idLine(line.sku)}</span><span class="rx-lqty num">${esc(t("po_line_of", {k:s.k, n:s.n, unit:s.unit}))}</span>
        <span class="rx-lshelf">${esc(s.shelves.join(", "))}</span>${s.problems ? `<span class="rx-chip rx-red">${s.problems}</span>` : ""}${RX.short ? RX.short.tag(x.po, line) : ""}</button>`;
      /* ⭐ 2026-10-23: "we never got it" lives on the line (rx/short.js) — above its scans, so a line with NO scans still has it */
      if(open) body += `<div class="rx-scans">` + (RX.short ? RX.short.html(x.po, line) : "") + (s.scans.length ? s.scans.map(c => scanLine(c)).join("") : `<div class="hint">No scans yet.</div>`) + `</div>`;
      body += `</div>`;
    });
    if(!n && H.poFilter !== "notpo") body += `<div class="hint">${esc(t("po_empty"))}</div>`;
  }
  if(H.poFilter === "all" || H.poFilter === "notpo"){
    const np = notOnPo();
    if(np.length) body += `<div class="rx-pohead"><strong>${esc(t("po_f_notpo"))}</strong></div>` + np.map(r => `<div class="rx-line"><span class="rx-lname">${esc(r.prod.name)}${RX.idLine(r.prod.sku)}</span> <span class="num">${r.units ?? "?"}u</span></div>`).join("");
    else if(H.poFilter === "notpo") body += `<div class="hint">${esc(t("po_empty"))}</div>`;
  }
  return shell("Delivery", body);
}
/* one scan under an expanded line: when, who, units, date, shelf, its state in words — then the problem's words + button, and Fix.
   ⭐ 2026-10-22: the date is shown (a scan from another day must be recognisable) and a cancelled scan is struck through, never hidden. */
const FIN_WORDS = {posted:"in Finale", held:"held", refused:"refused", posting:"going into Finale", uncertain:"checking Finale", shadow:"practice"};
function scanLine(c){
  const f = (c.v && c.v.fields) || {};
  const day = c.at ? String(c.at).slice(5, 10) : "";
  const cancelled = c.state === "cancelled" || (RX.intents.byId(c.iid) || {}).cancelled;
  const st = cancelled ? "cancelled" : (c.state === "staged" && !c.fin ? "on a cart" : (FIN_WORDS[c.fin] || (c.fin ? c.fin : "waiting")));
  let h = `<div class="rx-scan${cancelled ? " rx-strike" : ""}" data-iid="${esc(c.iid)}"><span class="num">${esc(day)} ${esc(RX.hhmm(c.at))} ${esc(String(c.op).split("@")[0])} · ${c.units}u${c.bb ? " · bb "+esc(c.bb) : ""}${c.bin ? " · "+esc(c.bin) : (f.StagedArea ? " · "+esc(f.StagedArea) : "")} · ${esc(st)}</span>`;
  if(!cancelled && c.v && f.Kind !== "fix") h += ` <button type="button" class="rx-btn" data-act="fix-open" data-iid="${esc(c.iid)}">${esc(t("fix_btn"))}</button>`;
  const ph = (!cancelled && c.v && RX.problems) ? RX.problems.html(c.v) : "";
  if(ph) h += ph;
  else if(RX.problems && RX.problems.state.msg[c.iid]) h += `<div class="hint rx-pb-msg" role="status">${esc(RX.problems.state.msg[c.iid])}</div>`;
  if(c.v && RX.problems && RX.problems.state.fixing === c.iid) h += RX.problems.fixHtml(c.v);
  return h + `</div>`;
}
function notOnPo(){
  return pageRows().filter(r => !r.audit && !r.deleted && r.prod && !String(r.prod.sku).startsWith("!") && RX.pack.data
    && (RX.po.matchFor(r) || {}).status === "notpo");
}
RX.registerAct("po-filter", ({el}) => { H.poFilter = el.dataset.f || "all"; D.refresh(true); });
RX.registerAct("po-line", ({el}) => { const k = el.dataset.key; const was = el.getAttribute("aria-expanded") === "true"; H.expanded[k] = !was; D.refresh(true); });
RX.registerAct("po-refresh", () => { RX.pack.load({force:true}); });
document.addEventListener("input", (e) => { if(e.target && e.target.id === "rxPoSearch"){ H.poSearch = e.target.value; D.refresh(true); const f = $("rxPoSearch"); if(f){ f.focus(); try{ f.setSelectionRange(f.value.length, f.value.length); }catch(_){} } } });

/* ───────────────────────── the row drawer ───────────────────────── */
function rowHtml(){
  const row = pageRows().find(r => r.n === H.rowN);
  if(!row) return shell("Scan", `<div class="hint">That scan is no longer on this list.</div>`);
  const recs = RX.intents.forRow(row);
  const first = recs[0] && recs[0].fields || {};
  let b = `<div><strong>${esc(row.prod.name)}</strong><div class="num hint">${esc([RX.brandOf(row.prod.sku), row.prod.sku, row.upc || ""].filter(Boolean).join(" · "))}</div></div>`;
  if(first.Po){ const po = RX.pack.poById(first.Po); const line = po && RX.po.line(po, row.prod.sku);
    const ls = line ? RX.po.lineStatus(po, line) : null;
    b += `<div class="rx-kv"><span>PO</span><span class="num">${esc(first.Po)}${ls ? " · line: "+esc(t("po_line_of", {k:ls.k, n:ls.n, unit:ls.unit})) : ""}</span></div>`; }
  b += `<div class="rx-kv"><span>Best by</span><span class="num">${esc(row.best || "no date")}</span></div>`;
  b += `<div class="rx-kv"><span>Units</span><span class="num">${esc(row.units ?? "?")}</span></div>`;
  if(recs.length){
    b += `<div class="rx-h2">Put-away</div>`;
    for(const rec of recs){
      const f = rec.fields, c = RX.intents.chipOf(rec), fin = rec.fin || {};
      b += `<div class="rx-portion"><span class="num">${esc(f.Units)}u → ${esc(f.Location || (f.StagedArea ? f.StagedArea : "—"))}</span>
        <span class="rx-chip rx-${esc(c.tone)}"${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.text)}</span>
        ${f.RecommendedBin && f.RecommendedBin !== f.Location ? `<div class="hint">Suggested: ${esc(f.RecommendedBin)}</div>` : ""}
        ${fin.FinReason ? `<div class="hint">${esc(fin.FinReason)}</div>` : ""}
        ${(!rec.sent && rec.err) ? `<div class="rx-note rx-red">${esc(rec.err)}</div>` : ""}
        ${fin.FinShipment ? `<div class="hint num">Finale shipment ${esc(fin.FinShipment)}</div>` : ""}
        ${(fixable(rec) && RX.problems && RX.problems.state.fixing !== rec.iid) ? `<button type="button" class="rx-btn" data-act="fix-open" data-iid="${esc(rec.iid)}">${esc(t("fix_btn"))}</button>` : ""}
        ${(RX.problems && RX.problems.state.fixing === rec.iid) ? RX.problems.fixHtml(viewOf(rec)) : ""}</div>`;
    }
  }
  const basis = row.qtyBasis ? ` · case size ${esc(row.qtyShown)} (${esc(row.qtyBasis.replace(/_/g, " "))})` : "";
  b += `<div class="rx-kv"><span>Source</span><span>${String(row.source || "").endsWith("gs1") ? "GS1 label" : "keyed"}${basis}</span></div>`;
  b += `<div class="rx-kv"><span>Scanned</span><span>${esc(String(row._op || "").split("@")[0])} · ${esc(RX.hhmm(row._at || 0))}</span></div>`;
  if(RX.problems){ for(const rec of recs){ const v = {iid:rec.iid, fields:rec.fields, fin:rec.fin || {}, itemId:rec.itemId, etag:rec.etag, local:true};
    if(RX.problems.of(v) || RX.problems.state.msg[rec.iid]) b += RX.problems.html(v) || `<div class="hint rx-pb-msg" role="status">${esc(RX.problems.state.msg[rec.iid])}</div>`; } }
  const editable = recs.length && recs.every(r => RX.intents.editable(r));
  let actions = "";
  if(recs.length){
    if(H.editing){
      actions += `<div class="rx-edit"><label class="hint" for="rxBinIn">${esc(t("drawer_shelf_prompt"))}</label>
        <input id="rxBinIn" class="num" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="${esc(t("drawer_shelf_prompt"))}">
        <button class="rx-btn primary" data-act="row-bin-save">${esc(t("drawer_shelf_save"))}</button><button class="rx-btn" data-act="row-bin-cancel" data-close="1">${esc(t("btn_cancel"))}</button>${H.err ? `<div class="rx-note rx-red" role="alert">${esc(H.err)}</div>` : ""}</div>`;
    }else{
      actions += editable ? `<button class="rx-btn" data-act="row-change-bin">${esc(t("drawer_change_shelf"))}</button>`
                          : `<button class="rx-btn" data-act="row-tell-julia">${esc(t("drawer_tell_julia"))}</button>`;
      if(RX.hasAct("last-split") && editable) actions += `<button class="rx-btn" data-act="last-split">${esc(t("drawer_not_all_fit"))}</button>`;
    }
  }
  actions += `<button class="rx-btn" data-act="drawer-close">${esc(t("drawer_close"))}</button>`;
  return shell(row.prod.name, b + `<div class="rx-actions">${actions}</div>`);
}
/* ⭐ PM-3346 (Julia, 2026-10-29: "We need to have the Fix option visible on the main receiving screen instead of hunting for it … a
   history of our current receiving scans … we can review/edit/fix anything we need to before confirming all counts"): every history row
   that has a put-away record shows [Fix], which opens THIS row with the same Fix panel the Delivery list has (wrong count, scanned twice).
   ⛔ On such a row the units cell and × used to change only the best-by record — never what goes into Finale — so they open Fix too. */
const viewOf = (rec) => ({iid:rec.iid, fields:rec.fields, fin:rec.fin || {}, itemId:rec.itemId, etag:rec.etag, local:true});
const fixable = (rec) => { const f = rec.fields || {}; return f.Kind !== "fix" && f.State !== "cancelled" && !rec.cancelled; };
D.fixRow = function(row){
  if(!RX.active() || !RX.intents) return false;
  const recs = RX.intents.forRow(row).filter(fixable); if(!recs.length) return false;
  H.open = "row"; H.rowN = row.n; H.editing = null; H.err = "";
  /* ⛔ review (4): a case split over shelves has one Fix per part — none is preselected, so a whole-case count is never typed into one part */
  if(RX.problems){ const P = RX.problems.state; P.fixing = recs.length === 1 ? recs[0].iid : null; P.fixErr = ""; P.draft = null; P.recvAsk = null; P.lowerAsk = null; P.overAsk = null; P.overOk = null; }
  D.refresh(true);
  setTimeout(() => { const i = document.getElementById("rxFixN"); if(i){ try{ i.focus(); i.select(); }catch(_){} } }, 30);
  return true;
};
RX.fixRow = (row) => D.fixRow(row);
RX.rowFixable = (row) => { try{ return RX.active() && !!RX.intents && RX.intents.forRow(row).some(fixable); }catch(_){ return false; } };
RX.registerAct("row-fix", ({el}) => { const row = pageRows().find(r => String(r.n) === el.dataset.n); if(row) D.fixRow(row); });
function startEdit(kind){ H.editing = kind; H.err = ""; D.refresh(true); }
RX.registerAct("row-change-bin", () => startEdit("change"));
RX.registerAct("row-tell-julia", () => startEdit("tell"));
RX.registerAct("row-bin-cancel", () => { H.editing = null; H.err = ""; D.refresh(true); });
RX.registerAct("row-bin-save", () => {
  const row = pageRows().find(r => r.n === H.rowN); if(!row) return;
  const code = ((($("rxBinIn") || {}).value) || "").trim();
  const info = RX.pack.binInfo(code);
  if(!info){ H.err = t("drawer_shelf_unknown", {code}); D.refresh(true); return; }
  if(!info.active){ H.err = t("drawer_shelf_off", {bin:info.name}); D.refresh(true); return; }
  const recs = RX.intents.forRow(row), rec = recs[recs.length - 1]; if(!rec) return;
  if(H.editing === "change" && RX.intents.editable(rec)) RX.intents.patch(rec.iid, {Location:info.name, BinSource:"typed"});
  else { RX.intents.fix({of:rec.iid, bin:info.name, note:"moved it"}); RX.toast(t("fix_sent")); }
  H.editing = null; H.err = ""; D.refresh(true); RX.refresh();
});
})();
