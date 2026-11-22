/* receiving/rx/subst-note.js — READ-ONLY note on the start card: "Supplemental order lines expected" (PM-3701, DESIGN section 9 U13).
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).
   When a supplemental (substitute) KeHE order was SENT for the delivery on the card, its lines are not on the Finale PO until KeHE's confirmation
   email adds them, so the crew would meet an item on the truck that is on no PO line. This reads the mini's
   app/orders/<order Sunday>/kehe/substitute_status.json (order Sunday = the PO's ETA minus 2 days) with the signed-in user's token, exactly as
   receive-pack.js reads pack.json, and shows ONE sentence (+ the lines when the file lists them) until the status says the Finale row is done.
   ⛔ Never writes, never blocks scanning, never claims anything the file does not say; an unreadable file shows nothing (absence is not a claim).
   API: RX.subst.html() -> string for the start card; RX.subst.load() re-reads. */
(function(){
"use strict";
const RX = window.RX; if(!RX) return;
const CFG = RX.CFG, S = RX.subst = { data: {}, gen: 0 };
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const ROOT = "TC Farm/Claude Files/Procurement & Merchandising/app/orders/";
const sundayOf = (eta) => { const t = Date.parse(eta + "T12:00:00Z"); return isNaN(t) ? null : new Date(t - 2 * 86400000).toISOString().slice(0, 10); };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
async function readOne(sun){
  const url = GRAPH + `/drives/${CFG.pack.drive_id}/root:/${enc(ROOT + sun + "/kehe/substitute_status.json")}:/content`;
  let tok = await getToken();
  let r = await fetch(url, {headers:{Authorization:"Bearer " + tok}});
  if(r.status === 401){ try{ tokenExp = 0; }catch(_){} tok = await getToken(); r = await fetch(url, {headers:{Authorization:"Bearer " + tok}}); }
  if(!r.ok) return null;
  let j = null; try{ j = JSON.parse(await r.text()); }catch(_){ j = null; }
  return j && j.sunday === sun && Array.isArray(j.sends) ? j : null;
}
S.load = async function(){
  const my = ++S.gen, d = RX.pack && RX.pack.data; if(!d) return;
  const suns = Array.from(new Set((d.pos || []).map(po => po.eta && sundayOf(po.eta)).filter(Boolean)));
  const out = {};
  for(const s of suns){ try{ const j = await readOne(s); if(j) out[s] = j; }catch(_){ /* nothing is claimed from a file that cannot be read */ } }
  if(my !== S.gen) return;
  S.data = out; RX.refresh();
};
S.items = function(){
  const out = [];
  for(const sun of Object.keys(S.data)){
    for(const e of S.data[sun].sends){
      const tasks = Array.isArray(e.tasks) ? e.tasks : [], tk = (id) => tasks.find(t => t && t.id === id) || {};
      if(tk("send").state !== "done" || tk("finale").state === "done") continue;       // sent, and not yet on the Finale order
      out.push({sun, po: e.po_number, lines: Array.isArray(e.lines) ? e.lines : []});
    }
  }
  return out;
};
/* C's status writer: lines[{upc,item_number,name,quantity (KeHE pieces),units}] — the crew counts UNITS, so ×units is shown */
S.html = function(){
  const it = S.items(); if(!it.length) return "";
  const q = (l) => (l && l.units != null ? l.units : (l && l.quantity != null ? l.quantity : null));
  return `<div class="rx-note rx-amber" data-subst-note="1" role="status"><strong>${esc(RX.t("subst_h"))}</strong> ${esc(RX.t("subst_b"))} ${esc(RX.t("subst_c"))}` +
    it.map(x => x.lines.length ? `<div class="hint">${esc(RX.t("subst_po", {po: x.po || "—"}))}: ${x.lines.slice(0, 12).map(l => esc((l && (l.name || l.sku)) || "?") + (q(l) != null ? " ×" + esc(q(l)) : "")).join(", ")}</div>` : "").join("") + `</div>`;
};
/* a tablet left open all morning re-reads the status (so the note goes when Finale has the lines, or appears when KeHE confirmed late) */
let timer = null;
function arm(){ clearInterval(timer); timer = setInterval(() => { if(!RX.forcedOff() && RX.pack && RX.pack.data) S.load(); }, CFG.SUBST_POLL_MS || 300000); }
RX.onBoot(() => { if(RX.forcedOff()) return; arm(); RX.on && RX.on("pack", () => { S.load(); }); });
})();
