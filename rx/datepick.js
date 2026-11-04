/* receiving/rx/datepick.js — THE BIG-BUTTON DATE PICKER AND THE "HOW MANY DAYS" TOAST (2026-11-04). OWNER: Procurement & Merchandising
   (hosted in ProductPipeline/receiving).

   Ruling: Jack, 2026-11-04 — "when they choose to manually enter best buy dates using a calendar, adjust that UX to not show a calendar,
   but instead show big buttons in a pop up that have each month listed as three letter months … then big buttons for the day 1-31 …
   then the year. That way it is easier to tap when they are working in a freezer" and "when they manually enter a best by date … a quick
   toast pop up to tell the total number of days and have option to fix if they see an error".

   API: window.RXDate = { open({value,title,typed,onPick,onCancel}), close(), toast(iso,{onFix,manual}), days(iso), fmt(iso), _isValid }
   ⭐ The picker hands back the SAME thing the old <input type=date> did — an ISO `YYYY-MM-DD` — so every validator downstream (real-date
      test, life ceiling, "is this date correct?") is unchanged. ⛔ It never decides whether a date is believable; the page does.
   ⛔ Only real dates can be completed: the day grid hides days the month does not have, and a 29 Feb is refused in a non-leap year.
   ⭐ Typed MMDDYY stays available inside the sheet (`typed:true`) because the history-correction path also accepts it. */
(function(){
"use strict";
const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const YEARS_AHEAD = 7;
const S = { el: null, m: 0, d: 0, y: 0, step: "m", opts: null };
const pad = (n) => String(n).padStart(2, "0");
const e_ = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const today = () => { const t = new Date(); return {y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate()}; };
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();                    // days in month m (1-12) of year y
function isValid(y, m, d){
  if(!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1)) return false;
  return d <= dim(y, m);
}
function parseIso(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); if(!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3]; return isValid(y, mo, d) ? {y, m: mo, d} : null;
}
function fmt(iso){ const p = parseIso(iso); return p ? `${p.d} ${MON[p.m - 1][0] + MON[p.m - 1].slice(1).toLowerCase()} ${p.y}` : String(iso || ""); }
/* whole calendar days from the tablet's own today (local calendar, not UTC instants — a freezer at 11 pm must not read a day off) */
function days(iso){
  const p = parseIso(iso); if(!p) return null;
  const t = today();
  return Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000);
}

/* ── the picker sheet ── */
function close(){ if(S.el){ S.el.remove(); S.el = null; } S.opts = null; }
function cancel(){ const o = S.opts; close(); if(o && o.onCancel) try{ o.onCancel(); }catch(_){} }
function done(y, m, d){
  const o = S.opts; const iso = `${y}-${pad(m)}-${pad(d)}`;
  close();
  if(o && o.onPick) o.onPick(iso);
}
function btn(label, cls, handler, attrs){
  const b = document.createElement("button");
  b.type = "button"; b.className = "dpBtn " + (cls || ""); b.textContent = label;
  if(attrs) for(const k in attrs) b.setAttribute(k, attrs[k]);
  b.addEventListener("click", handler);
  return b;
}
function grid(cols){
  const g = document.createElement("div");
  g.className = "dpGrid"; g.style.gridTemplateColumns = `repeat(${cols}, 1fr)`; return g;
}
function head(){
  const h = document.createElement("div"); h.className = "dpHead"; h.id = "dpHead";
  const part = (txt, step, on) => { const b = btn(txt, "dpPart" + (S.step === step ? " dpOn" : ""), () => { if(on){ S.step = step; draw(); } }, {"data-part": step});
    b.disabled = !on; return b; };
  h.appendChild(part(S.m ? MON[S.m - 1] : "MON", "m", true));
  h.appendChild(part(S.d ? String(S.d) : "DAY", "d", !!S.m));
  h.appendChild(part(S.y ? String(S.y) : "YEAR", "y", !!(S.m && S.d)));
  return h;
}
function draw(){
  if(!S.el) return;
  const body = S.el.querySelector("#dpBody"); body.innerHTML = "";
  const t = today();
  const hd = S.el.querySelector("#dpHeadSlot"); hd.innerHTML = ""; hd.appendChild(head());
  S.el.querySelector("#dpAsk").textContent = S.step === "m" ? "Month" : S.step === "d" ? "Day" : "Year";
  if(S.step === "m"){
    const g = grid(3);
    MON.forEach((n, i) => g.appendChild(btn(n, "dpMon", () => { S.m = i + 1; if(S.d > dim(S.y || 2000, S.m) && !(S.m === 2 && S.d === 29)) S.d = 0; S.step = "d"; draw(); }, {"data-m": String(i + 1)})));
    body.appendChild(g);
  }else if(S.step === "d"){
    /* the longest this month can be: 29 for February (leap-ness is only known once the year is chosen, and is checked there) */
    const max = S.m === 2 ? 29 : dim(2001, S.m);
    const g = grid(7);
    for(let d = 1; d <= max; d++) g.appendChild(btn(String(d), "dpDay", () => { S.d = d; S.step = "y"; draw(); }, {"data-d": String(d)}));
    body.appendChild(g);
  }else{
    const g = grid(4);
    for(let y = t.y; y <= t.y + YEARS_AHEAD; y++){
      const ok = isValid(y, S.m, S.d);
      const b = btn(String(y), "dpYear", () => done(y, S.m, S.d), {"data-y": String(y)});
      if(!ok){ b.disabled = true; b.title = "That date does not exist in " + y; }
      g.appendChild(b);
    }
    body.appendChild(g);
    if(S.m === 2 && S.d === 29){ const n = document.createElement("div"); n.className = "dpNote"; n.textContent = "29 Feb only exists in a leap year."; body.appendChild(n); }
  }
}
function typedRow(){
  const w = document.createElement("div"); w.className = "dpTyped";
  w.innerHTML = `<label for="dpType">Or type six digits MMDDYY</label>
    <div><input id="dpType" type="text" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="MMDDYY" aria-label="Type the date as MMDDYY">
    <button type="button" id="dpTypeGo" class="dpBtn dpGo">Use it</button></div><div id="dpTypeMsg" class="dpNote" aria-live="polite"></div>`;
  const go = () => {
    const v = w.querySelector("#dpType").value.trim(), msg = w.querySelector("#dpTypeMsg");
    const m = /^(\d{2})(\d{2})(\d{2})$/.exec(v);
    if(!m || !isValid(2000 + +m[3], +m[1], +m[2])){ msg.textContent = "That is not a real date — six digits, month then day then year."; return; }
    done(2000 + +m[3], +m[1], +m[2]);
  };
  w.querySelector("#dpTypeGo").addEventListener("click", go);
  w.querySelector("#dpType").addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); go(); } });
  return w;
}
function open(opts){
  close();
  opts = opts || {};
  S.opts = opts; S.m = S.d = S.y = 0; S.step = "m";
  const pre = parseIso(opts.value); if(pre){ S.m = pre.m; S.d = pre.d; S.y = pre.y; }
  const el = document.createElement("div");
  el.id = "dpSheet"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", opts.title || "Pick the best-by date");
  el.innerHTML = `<div class="dpBox"><div class="dpTop"><strong id="dpTitle">${e_(opts.title || "Best-by date")}</strong><span id="dpAsk" class="dpAsk"></span></div>
    <div id="dpHeadSlot"></div><div id="dpBody"></div><div id="dpTypedSlot"></div>
    <div class="dpFoot"><button type="button" id="dpBack" class="dpBtn">Back</button><button type="button" id="dpCancel" class="dpBtn">Cancel</button></div></div>`;
  document.body.appendChild(el); S.el = el;
  if(opts.typed) el.querySelector("#dpTypedSlot").appendChild(typedRow());
  el.querySelector("#dpCancel").addEventListener("click", cancel);
  el.querySelector("#dpBack").addEventListener("click", () => { if(S.step === "y") S.step = "d"; else if(S.step === "d") S.step = "m"; else return cancel(); draw(); });
  el.addEventListener("keydown", (e) => { if(e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); cancel(); } }, true);
  draw();
  return el;
}

/* ── the toast ── */
let toastTimer = null;
function toast(iso, o){
  o = o || {};
  const n = days(iso); if(n == null) return null;
  const old = document.getElementById("dpToast"); if(old) old.remove();
  if(toastTimer){ clearTimeout(toastTimer); toastTimer = null; }
  const el = document.createElement("div");
  el.id = "dpToast"; el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
  const when = n === 0 ? "expires TODAY" : n === 1 ? "1 day from today" : n > 1 ? `${n} days from today` : n === -1 ? "1 day ago — already expired" : `${-n} days ago — already expired`;
  el.className = (n <= 7 ? "dpWarn" : "");
  el.innerHTML = `<span id="dpToastTxt">Best-by <strong>${e_(fmt(iso))}</strong> — ${e_(when)}</span>`;
  const fix = btn("Fix", "dpFix", () => { el.remove(); if(toastTimer){ clearTimeout(toastTimer); toastTimer = null; } if(o.onFix) o.onFix(iso); }, {id: "dpToastFix"});
  el.appendChild(fix);
  document.body.appendChild(el);
  toastTimer = setTimeout(() => { if(el.parentNode) el.remove(); toastTimer = null; }, o.ms || 8000);
  return el;
}

/* ── style (self-contained: the page's own variables, big targets for gloves) ── */
const st = document.createElement("style");
st.textContent = `
#dpSheet{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center}
#dpSheet .dpBox{background:var(--card,#fff);color:var(--ink,#101c18);width:100%;max-width:760px;max-height:96vh;overflow:auto;border-radius:14px 14px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom,0px))}
.dpTop{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;font-size:18px}.dpAsk{font-size:22px;font-weight:700;color:var(--go,#0b6e4f)}
.dpHead{display:flex;gap:8px;margin-bottom:10px}.dpPart{flex:1;min-height:56px;font-size:24px;font-weight:700;border:2px solid var(--line,#dbe4df);background:var(--ground,#f4f7f5);color:var(--ink,#101c18);border-radius:10px}
.dpPart.dpOn{border-color:var(--go,#0b6e4f);background:var(--go-soft,#e2f1ea)}.dpPart:disabled{opacity:.45}
.dpGrid{display:grid;gap:8px}.dpBtn{min-height:56px;font-size:22px;border:2px solid var(--line,#dbe4df);background:var(--ground,#f4f7f5);color:var(--ink,#101c18);border-radius:10px;padding:6px 8px}
.dpMon{min-height:68px;font-size:26px;font-weight:700}.dpDay{min-height:58px;font-size:22px;padding:0}.dpYear{min-height:68px;font-size:26px;font-weight:700}.dpYear:disabled{opacity:.35}
.dpFoot{display:flex;gap:10px;margin-top:12px}.dpFoot .dpBtn{flex:1}
.dpTyped{margin-top:14px;border-top:1px solid var(--line,#dbe4df);padding-top:10px}.dpTyped label{display:block;font-size:15px;color:var(--ink-2,#3c4f48);margin-bottom:6px}
.dpTyped input{font-size:24px;min-height:56px;width:9em;padding:4px 10px;border:2px solid var(--line,#dbe4df);border-radius:10px;background:var(--ground,#f4f7f5);color:var(--ink,#101c18)}
.dpGo{background:var(--go,#0b6e4f);color:#fff;margin-left:8px}.dpNote{font-size:15px;color:var(--wait,#a8620a);margin-top:8px}
#dpToast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:70;display:flex;align-items:center;gap:14px;max-width:94vw;padding:12px 14px 12px 18px;border-radius:12px;background:var(--ink,#101c18);color:var(--ground,#f4f7f5);font-size:19px;box-shadow:0 6px 24px rgba(0,0,0,.35)}
#dpToast.dpWarn{background:var(--wait,#a8620a);color:#fff}#dpToast .dpFix{min-height:52px;min-width:84px;font-size:20px;font-weight:700;background:#fff;color:#101c18;border-color:#fff}
`;
document.head.appendChild(st);

window.RXDate = { open, close, toast, days, fmt, _isValid: isValid, _state: () => ({m: S.m, d: S.d, y: S.y, step: S.step, open: !!S.el}) };
})();
