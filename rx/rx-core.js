/* receiving/rx/rx-core.js — the core of the receiving upgrade: namespace, state, page hooks, flow steps,
   commit path, focus rules, sounds. OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).

   ═══════════════════════════════════════════════════════════════════════════════════════════════════════
   ⭐ THE CORE API (what WP4b — recommend.js / putaway.js / staging.js — builds on)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════
   Everything hangs off ONE global, `window.RX`, which exists ONLY if this file loaded (so index.html's
   `window.RX && RX.x()` hooks are safe). Sub-namespaces are created here EMPTY and filled by the later files:
        RX.pack     rx/receive-pack.js   the delivery list (pack.json): load states, cache, indexes
        RX.intents  rx/intents.js        ReceivingIntents client, outbox, polling, poster status, chips
        RX.po       rx/receive-po.js     PO auto-match, line counters, case_qty prefill, the qty-card extras
        RX.ui       rx/start.js          start card, status strip, banners, menu, tiles, sounds toggle
        RX.drawer   rx/po-drawer.js      the PO drawer, the row drawer, the history table extension
   Page globals are read at CALL time by bare name (`pending`, `prompt_`, `clearPrompt`, `CATALOG`, `graph`,
   `account`, `device`, `rows`, `render`, `commit`, `packs`, `isAudit`, `$`, `esc`, `yearFirst`, `reject`,
   `enqueueRecord`, `deleteRow`, `flagSignIn`, `needsSignIn`). ⛔ Never write to a page `const`.

   ── 1. STATE (RX.state — in memory; persisted keys are listed in §9) ──
     RX.state.booted            true after RX.boot()
     RX.state.step              null | {name, ctx}  — the active flow step (§4)
     RX.state.scanLog           raw scans since the last commit (→ the intent's RawScans)
     RX.state.lastRow           the history row the flash card is about (Undo / Not all fit?)
     RX.state.qtyKindChoice     'full'|'part'|null — the operator's chip on the open qty card
     RX.mode()                  'off' | 'shadow' | 'live'  — what the page SHOWS (⛔ not what the poster does)
     RX.active()                mode !== 'off' AND the page is in RECEIVING (not audit). false ⇒ page = today
     RX.flow()                  effective flow: 'bestby' | 'direct' | 'sort' | 'staged' | null
                                ⭐ round 3: in LIVE the default is 'direct' (Put away here) when nobody has chosen / the choice is 6 h
                                stale (null only if the shelf step itself is not registered); RX.flowChosen() says whether a fresh choice stands
     RX.flowActive()            active AND flow ∈ {direct, sort, staged}  (the new flows are on)
     RX.setFlow(f)              refused with "Finish this case first" while an item is open
     RX.practice.on()/set(b)    the shadow "Practice: also scan the shelf tag" toggle (resets at midnight; always false in LIVE)
     RX.now() RX.today() RX.dayKey(ms) RX.iso(ms)   ⭐ ALL time goes through RX.now() (tests fake the clock)

   ── 2. HOOKS the page calls (index.html; every one is `window.RX && …`) ──
     RX.boot()                  after sign-in, in start()
     RX.gate()                  end of modeGate(): true ⇒ the scan is NOT recorded (live, no flow chosen)
     RX.intercept(raw)          handleScan(), BEFORE the "prompt open" refusal: true ⇒ RX consumed the scan
     RX.beforeCommit(pending)   next(): true ⇒ RX took over (runs the steps, calls commit() itself later)
     RX.prefill(p, existing)    askQty(): the number to show; records p.qtyShown / p.qtyBasis
     RX.qtyExtras(p)            askQty(): {body, after} HTML (⛔ block-level <span>, never <div>, in `body`)
     RX.qtyKind(n)              #qok handler: 'full'|'part'
     RX.poRef(p)                commit_(): the matched PO id for the BB row's po_ref ('' ⇒ page's own box)
     RX.onCommit(row)           commit_(), after save(row): writes the intent(s), flash, sound
     RX.histRows(rows) RX.shelfCell(r) RX.chip(r) RX.afterRender()   render()
     RX.onEmptyEnter()          #scan Enter with nothing typed: true ⇒ consumed
     RX.keepScan()              the global click-refocus: true ⇒ keep the scan box focused over a card
     RX.flush() RX.unsentCount()   retryPending() / renderPending() / beforeunload

   ── 3. ADDING A CONTROL ──
     Every control carries a `data-act="name"`. RX.registerAct(name, fn({el, name, ev})) wires one; core acts are
     registered here and in the other rx files. The click router is on `document` in the CAPTURE phase; a click
     inside `.rx-overlay` (drawers) is handled then stopped, so the page's click-refocus never steals an input.

   ── 4. FLOW STEPS (the heart of WP4b) ──
     A flow is a list of step names (RX.CFG.flows): direct = ['exceptions','shelf'], sort = ['exceptions','stage'],
     staged = ['tray']. After the qty is saved the page's next() calls RX.beforeCommit(pending), which runs each
     REGISTERED step in order (an unregistered step is skipped; a flow whose last step is not registered is not
     offered, and degrades to today's commit).

       RX.registerStep(name, {
         applies(ctx) → bool        optional; false ⇒ skipped
         start(ctx)                 REQUIRED. Show the card with the page's prompt_(kind,title,body,actions,
                                    {keepScan:true}) — ⛔ a step MUST keep a `.prompt` card on screen, because the
                                    page refuses a scan "while a prompt is open" and RX.intercept is what lets
                                    the scans you want through. Then wait.
         onScan(ctx, raw) → bool    a scan arrived while this step is active; true ⇒ consumed. false ⇒ the page's
                                    "finish this item first — scan NOT recorded" refusal runs. Raw scans are already
                                    in RX.state.scanLog.
         onEmptyEnter(ctx) → bool   Enter on an empty scan box (e.g. sort: "Enter = top cart")
         keepScan: true             the scan box keeps focus over the card (D2 shelf, stage card)
         abort(ctx)                 cleanup if the item is dropped
       })
       ctx = { p, flow, step, mode, po, fields, done(fields), commit(fields), cancel(fields),
               side(html), clearSide() }
         ctx.po       RX.po.matchFor(p): {po, line, left, status} or null (pack missing / not on a PO)
         ctx.fields   the accumulated intent fields (live object)
         ctx.done(f)  merge f, go to the NEXT step (after the last one: RX.commitWith({}))
         ctx.commit(f) merge f and commit NOW (skip the rest) — e.g. the shadow "Skip" button
         ctx.cancel(f) commit the BB row WITHOUT an intent (Cancel this case; "Set it aside")
     Idle scans (nothing pending): RX.registerIdle(name, {onScan(raw)→bool, onEmptyEnter()→bool, keepScan}) —
       tag-first "arm the shelf", the staged tray. Only consulted when a new flow is active and nothing is pending.

   ── 5. COMMITTING ──
     RX.commitWith(fields)   merge into pending.rx.fields, mark done, call the page's commit(). commit() may still
                             ask "Is this date correct?" and come back through next() → beforeCommit, which now
                             returns false (done) — so a step never runs twice. Field vocabulary:
        state            'ready' | 'staged' | 'skipped'        (default 'ready'; 'staged' when flow = sort)
        bin              Location, exactly as scanned          binSource 'scanned'|'typed'|'armed'
        workflow         'direct' | 'staged'                   (default from the flow)
        stagedArea recommendedBin recReasons(string|array) splitOf tempConfirmed fefoOverride shortDated
        damaged rejected   unit counts never received          units  override of this intent's units
        noIntent:true      commit the BB row, write NO intent  flash  text for the flash card (replaces default)
        extra: [fieldsObj,…]  further intents for the SAME case (split put-away): each is a full field set;
                             every portion gets its own IntentId and SplitOf = the first portion's id.
     The BB Receipts row stays ONE row per case (the best-by ledger is unchanged).
     RX.intents.* is the data layer (create/patch/cancel/fix/query, see intents.js header).

   ── 6. CHIPS ──
     RX.intents.chipFor(row) → {text, tone, title, since?} | null ; RX.chip(row) renders it (null ⇒ the page's own
     tag). tone ∈ grey amber red green violet blue dash strike. Existing FAILED / UNSAVEABLE / fix-not-sent win.

   ── 7. COPY / FOCUS / SOUND ──
     RX.t(key, vars) and RX.COPY (rx-config.js). Focus: a keepScan step re-focuses #scan after every tap (the page's
     click-refocus asks RX.keepScan()); input states focus their input and the page's burst guard polices them.
     RX.sound('saved'|'staged'|'decide'|'refused') — beeps + vibration; the menu toggle only mutes AUDIO.
     RX.toast(msg), RX.flash(html), RX.side.set(html)/clear() (the right-hand panel #rxSide), RX.refresh().

   ── 8. RX.pack (receive-pack.js) ──  RX.pack.data (the parsed pack or null), RX.pack.state (status, stage, bytes…),
        RX.pack.load({force}), RX.pack.staleness(), and the indexes — O(1):
        RX.pack.binInfo(name)→{name,role,temp,active}|null   RX.pack.areaOf(name)→"Cooler shelves"|null
        RX.pack.skuInfo(sku)→pack.skus[sku]|null   RX.pack.candidates(sku)→array
        RX.pack.poById(id)  RX.pack.poLinesBySku(sku)→[{po,line}]   RX.pack.binsSorted()→names
        RX.pack.searchBins(text, sku?, limit)→[{name,role,temp,active,cand}]  (candidates for the SKU first)

   ── 8b. CLOSING EVERY PANEL (round 3, Jack 2026-10-19: "Can't scan it?" opened a panel with no way out) ──
   THE CONTRACT: every panel carries a visible Close / Back / Cancel control (≥ 48 px, plain words) marked `data-close="N"`
   (N = depth: 1 innermost … 3 the panel itself). ESCAPE clicks the shallowest visible one in the top-most area
   (index.html `closeTopPanel`: date modal → drawer → menu → promptArea → lastArea → tray → start card → toast), so the key
   and the button can never drift apart. A prompt with controls and no `data-close` of its own gets the standard footer
   `data-act="prompt-close"` from `prompt_` (label "Close", or "Cancel — scan it again" when an item is open).
   ⛔ CLOSING NEVER RECORDS ANYTHING (no BB row, no intent, no queue entry). "ABANDONED" = the open item is dropped; "KEPT" = it
   stays open exactly as it was.
     PAGE PROMPTS (index.html)
       Find the product by name ........ Close (promptClose): closes; scan box focused. Item: none open (Can't scan it? starts a
                                          new carton) — or ABANDONED if opened from an unknown carton's "Find it by name".
       Unknown / bad-read / unrecognised code, "UPC missing from our system", "Which kind of scanning?", product list not loaded,
       dead-rows "cannot be saved", photo prompts ... Close (promptClose) — nothing is pending ⇒ just closes; with an item
                                          open (UPC-missing, unknown-carton date) the item is ABANDONED and the toast says so.
       Why are you skipping it? ........ Close ⇒ ABANDONED (nothing is recorded: the skip reason was never chosen).
       Date / "Check this date" / "No date on the label" ... Close ⇒ ABANDONED. Quantity / "You entered N — right?" ⇒ ABANDONED.
       "Is this date correct?" / "Is this the same case?" / "Is the date on the package?" ⇒ ABANDONED; a date the item took from
                                          the held-date banner goes BACK to being held.
       "Date captured — now scan the item" (held date) ... Close closes the notice, the date stays HELD (banner keeps its own
                                          Discard).  "Now scan one unit" + the armed banner ... Cancel (unitCancel) ⇒ KEPT: back to
                                          this carton's own date prompt (or just closes).
       Burst refusal ................... OK / Got it (burstOk): the message goes; an item that is open stays KEPT.
       History correction modal ........ Fix it (dcFix): nothing changes. (Row edits use the browser's own Cancel/Escape.)
     RX CARDS (rx/*.js)
       Over-shipment card .............. Fix the count ⇒ back to the quantity, item KEPT.   Short-dated / expired card ⇒ Back (KEPT).
       Shelf step main (D2) ............ Back to the count ⇒ item KEPT, portions placed so far (memory only) are forgotten; a
                                          "Not all fit?" late split ⇒ nothing changes, every unit stays on the first shelf.
       Shelf sub-cards: how many / find the tag / temperature / older-stock / same-case / cancel / leave-rest ⇒ Back to the D2 card.
       Stage card (sort first) ......... Back to the count (KEPT); its "Other cart" list ⇒ Back to the stage card.
       Tray decision cards (temp/older stock) ⇒ Back: nothing is moved, the tray stays.  Not-on-the-list card ⇒ Cancel.  Lot pick ⇒ Close.
       Staged list (the tab) ........... Close ⇒ back to the flow it was opened from; a row's details ⇒ Close; "Cancel it?" ⇒ No;
                                          tray "some" box ⇒ Cancel.
       Qty-card extras ................. "Case size changed?" ⇒ No; "Some damaged" ⇒ Cancel.  More places (side panel) ⇒ Fewer places.
       Last-split ("Not all fit?") input ⇒ Cancel.  Row drawer / PO drawer ⇒ Close (backdrop too); row drawer shelf edit ⇒ Cancel.
       Menu ≡ ⇒ Close.  Start card unfolded ⇒ Hide.  Toasts ⇒ Escape hides.
     ROUND 4 (2026-10-19): Damage-photo card ......... Back to the count (photo-back) ⇒ item KEPT, the photos taken stay with the item,
                                          nothing recorded. Hold card (not on a PO) ... Back to the count (hold-back) ⇒ item KEPT, nothing recorded.
                                          "On hold — waiting for purchasing" card ... Close. Shelf-mode banner ... "Done with this shelf"
                                          (shelf-done, data-close 3, LAST in Escape's order so any open panel closes first).
     ROUND 5 (2026-10-19): "Add 1 case — same date" that pushes the count past KeHE's shipped/ordered re-asks the over-shipment question
                                          on the shelf card: [Yes, n is right] (over-add-yes) · [Undo — take that case off] (over-add-undo,
                                          data-close 3 = Escape) ⇒ the added case is taken back off, the earlier answer restored, nothing recorded.
     NOT PANELS (no Close needed): the status strip, banners that are alerts, the flash card (Undo is its control), chips, tiles.

   ── 8c. ROUND 4 (Jack 2026-10-19) ── flows are now direct = [damage, overship, exceptions, nopo, shelf], sort = [damage, overship,
        exceptions, nopo, stage], staged = [damage, overship, nopo, tray]. `damage` (rx/photos.js): damaged units ⇒ ≥ 1 photo, links in
        the intent's PhotoUrls, note in FixNote. `exceptions` (putaway.js): short-dated is RECEIVED + ShortDated (credit request).
        `nopo` (putaway.js): a case on no open PO ⇒ staged intent "Hold: not on PO" (RecReasons NOT_ON_PO). Shelf mode (putaway.js
        PA.shelf, key rx_shelf_v1) replaces the one-shot armed shelf in Put away here. Best-by only in LIVE writes a staged
        "Not put away yet" intent (beforeCommit). Events: RX.emit("committed", row) from onCommit; RX.emit("abandon", p) from
        RX.abandon() unless {keep:true} (backToQty).

   ── 9. PERSISTED KEYS (localStorage) ──
        rx_flow_v1 {flow,at} · rx_practice_v1 {on,day} · rx_poster_v1 {data,savedAt} (round 5) · rx_shelf_v1 {bin,at,n,who} · IndexedDB rx_photos_v1 (queued damage photos) · rx_pack_v1 {at,etag,pack} · rx_intents_v1 (the outbox +
        last-known status; ⛔ NEVER prunes an unsent row) · rx_sound_v1 · [WP4b: rx_staged_v1 rx_tray_v1 rx_armed_v1]
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function(){
"use strict";
const B = window.__RXBOOT;
if(!B){ try{ console.warn("rx-config.js did not load — the receiving upgrade stays OFF"); }catch(_){} return; }
const CFG = B.CFG;
const RX = { ok:true, CFG, COPY:B.COPY, t:B.t };

/* sub-namespaces, filled by the later files */
RX.pack = {}; RX.intents = {}; RX.po = {}; RX.ui = {}; RX.drawer = {};
RX.poster = { data:null, status:"unknown", readAt:0 };

/* ───────────────────────── small helpers ───────────────────────── */
RX.now   = () => Date.now();                     // ⭐ the ONE clock — Playwright's page.clock fakes Date
RX.dayKey = (ms) => { const d = new Date(ms == null ? RX.now() : ms);
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
RX.today = () => RX.dayKey();
RX.iso   = (ms) => new Date(ms == null ? RX.now() : ms).toISOString();
RX.esc   = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
/* ⭐ PM-3332 (Jack, 2026-10-28: "We need Finale skus showing on the receiving app … prob also brand"): the BRAND and the FINALE SKU of
   an item, as one small line under its name — two products that read alike (Powdered Sugar 16oz from two brands) are told apart, and an
   error names the exact SKU. ONE helper, used by every card and list that shows an item. */
RX.brandOf = (sku) => { try{ const c = (typeof CATALOG_BY_SKU === "object" && CATALOG_BY_SKU && CATALOG_BY_SKU[sku]) || null; if(c && c.br) return c.br;
  const i = RX.pack && RX.pack.skuInfo ? RX.pack.skuInfo(sku) : null; return (i && (i.brand || i.br)) || ""; }catch(_){ return ""; } };
RX.idLine = (sku) => { if(!sku || String(sku).startsWith("!")) return "";
  return `<span class="rx-idl num" data-sku="${RX.esc(sku)}" style="display:block;font-size:13px;color:var(--ink-3);font-weight:400">${RX.esc([RX.brandOf(sku), sku].filter(Boolean).join(" · "))}</span>`; };
RX.clock = (ms) => { const s = Math.max(0, Math.floor(ms/1000)); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), x = s%60;
  return (h ? h+":"+String(m).padStart(2,"0") : String(m))+":"+String(x).padStart(2,"0"); };
RX.ago = (ms) => { const s = Math.max(0, Math.floor(ms/1000));
  if(s < 3600) return RX.clock(ms);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h+" h "+m+" m"; };
RX.hhmm = (v) => { const d = new Date(typeof v === "number" ? v : Date.parse(v)); if(isNaN(d)) return "";
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); };
RX.newId = () => { let u;
  try{ u = crypto.randomUUID(); }catch(_){
    u = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c=>{ const r = Math.random()*16|0; return (c==="x" ? r : (r&3|8)).toString(16); }); }
  return "ri-"+u; };
RX.store = {
  get(key, dflt){ try{ const s = localStorage.getItem(key); return s == null ? dflt : JSON.parse(s); }catch(_){ return dflt; } },
  set(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); return true; }catch(_){ return false; } },
  del(key){ try{ localStorage.removeItem(key); }catch(_){} },
};
/* ⛔ ROUND 5 (2026-10-19): THE LAST GOOD POSTER STATUS SURVIVES A RELOAD. RX.mode() is decided by Receiving/poster_status.json; held
   only in memory, a tablet that reloaded in a dead spot (or scanned before the first read answered) showed SHADOW in a live week:
   today's best-by-only flow, no shelf step, intents stamped PageMode=shadow which the poster refuses (PAGE_NOT_LIVE) — a whole
   delivery silently not received. intents.js pollPoster keeps the reading in `rx_poster_v1` on every good read and clears it on a
   404 (no status file is a real answer); until a fresh answer arrives the kept one stands (status "cached"). A tablet that has never
   read one stays in shadow. ⭐ Safe in the other direction: the poster, not the page, decides what posts (its own mode + `since`). */
RX.POSTER_KEY = "rx_poster_v1";
(() => { const s = RX.store.get(RX.POSTER_KEY, null);
  if(s && s.data && typeof s.data === "object" && s.data.at && (RX.now() - (+s.savedAt || 0)) < 14 * 86400000){ RX.poster.data = s.data; RX.poster.status = "cached"; } })();
RX.call = (ns, fn, ...a) => { try{ const f = RX[ns] && RX[ns][fn]; return typeof f === "function" ? f.apply(RX[ns], a) : undefined; }
                              catch(e){ try{ console.error("rx", ns+"."+fn, e); }catch(_){} } };
const isAuditNow = () => { try{ return typeof isAudit === "function" && isAudit(); }catch(_){ return false; } };
const pendingNow = () => { try{ return pending; }catch(_){ return null; } };   // page `let pending`

/* event bus */
const listeners = {};
RX.on   = (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); };
RX.emit = (evt, data) => { for(const fn of (listeners[evt] || []).slice()){ try{ fn(data); }catch(e){ try{ console.error("rx on", evt, e); }catch(_){} } } };
let refreshTimer = null;
RX.refresh = () => { if(refreshTimer) return;
  refreshTimer = setTimeout(()=>{ refreshTimer = null; RX.refreshNow(); }, 0); };
RX.refreshNow = () => { RX.call("ui","refresh"); RX.call("drawer","refresh"); try{ if(typeof render === "function") render(); }catch(_){} };
RX.toast = (msg) => RX.call("ui","toast", msg);
RX.flash = (html) => { const el = document.getElementById("lastArea"); if(el) el.innerHTML = html; };
RX.side  = { set(html){ const el = document.getElementById("rxSide"); if(el) el.innerHTML = html; },
             clear(){ const el = document.getElementById("rxSide"); if(el) el.innerHTML = ""; } };

/* ───────────────────────── mode / flow / practice ───────────────────────── */
const FLOW_KEY = "rx_flow_v1", PRACTICE_KEY = "rx_practice_v1";
RX.qs = (() => { try{ return new URLSearchParams(location.search); }catch(_){ return new URLSearchParams(""); } })();
RX.forcedOff = () => { try{ return !!(CFG.flags.rollback_off || RX.qs.get("rx") === "off" || localStorage.getItem("rx_off") === "1"); }catch(_){ return false; } };
RX.mode = function(){
  if(RX.forcedOff()) return "off";
  const pk = RX.pack.data;
  if(pk && pk.vendors && pk.vendors[CFG.vendor] && pk.vendors[CFG.vendor].mode === "off") return "off";
  const ps = RX.poster.data;
  const pm = ps && ps.modes && ps.modes[CFG.vendor];
  if(pm === "off") return "off";
  if(pm === "live") return "live";
  if(pm === "sentinel") return CFG.flags.sentinel_page_mode === "live" ? "live" : "shadow";
  return "shadow";          // shadow, or no poster status at all (⭐ MASTER-PLAN §9.2: absent ⇒ shadow wording)
};
RX.active = () => !!RX.state.booted && RX.mode() !== "off" && !isAuditNow();
RX.practice = {
  on(){ if(!CFG.flags.practice_toggle || RX.mode() === "live") return false; const s = RX.store.get(PRACTICE_KEY, null); return !!(s && s.on && s.day === RX.today()); },
  set(b){ RX.store.set(PRACTICE_KEY, {on:!!b, day:RX.today()});
    if(b && !RX.readFlow()) RX.writeFlow("direct");
    RX.emit("flow"); RX.refresh(); },
};
RX.readFlow = () => { const s = RX.store.get(FLOW_KEY, null); return (s && CFG.flows[s.flow]) ? s : null; };
RX.writeFlow = (f) => { RX.store.set(FLOW_KEY, {flow:f, at:RX.now()}); };
RX.touchFlow = () => { const s = RX.readFlow(); if(s) RX.writeFlow(s.flow); };
RX.flow = function(){
  if(!RX.active()) return null;
  const st = RX.readFlow();
  const fresh = !!st && (RX.now() - st.at) <= CFG.FLOW_STALE;
  if(RX.mode() === "shadow"){
    if(!RX.practice.on()) return "bestby";
    return (fresh && RX.flowAvailable(st.flow)) ? st.flow : (RX.flowAvailable("direct") ? "direct" : "bestby");
  }
  /* ⭐ ROUND 3 (Jack, 2026-10-19): GO LIVE FOR EVERYONE. In live the default is "Put away here" (one tap to change); the
     operator's own choice (incl. the "Best-by only (no shelf scan)" fallback link) holds for FLOW_STALE. null only when
     the shelf step itself is not available. */
  if(fresh && CFG.flows[st.flow] && RX.flowAvailable(st.flow)) return st.flow;
  return RX.flowAvailable("direct") ? "direct" : null;
};
/* ⭐ round 3: has the crew CHOSEN a flow (fresh), as opposed to the live default ("Put away here")? */
RX.flowChosen = () => { const st = RX.readFlow(); return !!st && (RX.now() - st.at) <= CFG.FLOW_STALE; };
RX.flowActive = () => { const f = RX.flow(); return f === "direct" || f === "sort" || f === "staged"; };
RX.setFlow = function(f){
  if(!CFG.flows[f]) return false;
  if(pendingNow()){ RX.toast(RX.t("finish_first")); return false; }
  if(f === "staged" && RX.flow() !== "staged") RX.state.prevFlow = RX.flow();      // so the staged list's Close can go back
  RX.writeFlow(f); RX.emit("flow"); RX.refresh(); return true;
};
RX.flowAvailable = (f) => { if(f === "bestby") return true; const s = CFG.flows[f];
  return !!(s && s.length && steps[s[s.length-1]]); };

/* ───────────────────────── registries ───────────────────────── */
const steps = {}, idles = {}, acts = {}, counters = {}, qtyContribs = {};
RX.registerStep = (name, h) => { steps[name] = h; RX.emit("steps"); RX.refresh(); };
RX.hasStep = (name) => !!steps[name];
RX.registerIdle = (name, h) => { idles[name] = h; };
RX.registerAct = (name, fn) => { acts[name] = fn; };
RX.hasAct = (name) => typeof acts[name] === "function";
RX.registerCounter = (name, fn) => { counters[name] = fn; };
RX.counter = (name) => { try{ return counters[name] ? counters[name]() : null; }catch(_){ return null; } };
RX.registerQtyExtra = (name, fn) => { qtyContribs[name] = fn; };   // fn(p) → {body?, after?}
RX._reg = { steps, idles, acts, counters, qtyContribs };

/* ───────────────────────── the page hooks ───────────────────────── */
RX.gate = function(){
  if(!RX.active()) return false;
  if(RX.mode() === "live" && RX.flow() === null){
    try{
      prompt_("stop", "How are you receiving?",
        RX.t("pick_flow_not_recorded")+" "+RX.t("pick_flow_first"),
        `<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:12px">
           <button class="primary rx-btn" data-act="start-direct">${RX.esc(RX.t("tile_direct"))}</button>
           <button class="primary rx-btn" data-act="start-sort">${RX.esc(RX.t("tile_sort"))}</button></div>`);
    }catch(_){}
    RX.sound("refused"); RX.refresh();
    return true;
  }
  return false;
};

RX.intercept = async function(raw){
  if(!RX.active()) return false;
  const log = RX.state.scanLog; log.push(String(raw)); while(log.length > CFG.scan_log_max) log.shift();
  const st = RX.state.step;
  if(st){
    if(!pendingNow()){ RX.state.step = null; }
    else{
      const h = steps[st.name];
      if(h && h.onScan){ try{ if(await h.onScan(st.ctx, String(raw))) return true; }catch(e){ try{ console.error("rx step onScan", e); }catch(_){} } }
      return false;
    }
  }
  if(pendingNow() || !RX.flowActive()) return false;
  for(const k of Object.keys(idles)){
    const h = idles[k];
    try{ if(h.onScan && await h.onScan(String(raw))) return true; }catch(e){ try{ console.error("rx idle onScan", e); }catch(_){} }
  }
  return false;
};

RX.onEmptyEnter = function(){
  if(!RX.active()) return false;
  const st = RX.state.step;
  if(st && pendingNow()){ const h = steps[st.name]; if(h && h.onEmptyEnter){ try{ return !!h.onEmptyEnter(st.ctx); }catch(_){ return false; } } return false; }
  if(pendingNow() || !RX.flowActive()) return false;
  for(const k of Object.keys(idles)){ const h = idles[k]; try{ if(h.onEmptyEnter && h.onEmptyEnter()) return true; }catch(_){} }
  return false;
};

RX.keepScan = function(){
  if(!RX.active()) return false;
  const st = RX.state.step;
  if(st && pendingNow()){ const h = steps[st.name]; return !!(h && h.keepScan); }
  if(!pendingNow() && RX.flowActive()){ for(const k of Object.keys(idles)) if(idles[k].keepScan) return true; }
  return false;
};

/* ⭐ ROUND 3 — leaving a step WITHOUT recording anything.
   RX.abandon()      the open item is being dropped (the page's Close on a prompt): the step's abort() runs, the side panel clears.
   RX.backToQty()    "Back"/"Fix the count" on a step card: the step is torn down, everything the steps decided is forgotten
                     (damaged units, entered earlier on the qty card, stay), the SAME item is asked its quantity again with
                     the number it had. ⛔ Nothing is written: no BB row, no intent. */
RX.abandon = function(opts){
  const p0 = pendingNow();
  const st = RX.state.step;
  if(st){ const h = steps[st.name]; try{ if(h && h.abort) h.abort(st.ctx); }catch(e){ try{ console.error("rx abort", e); }catch(_){} } }
  RX.state.step = null; RX.side.clear();
  if(!(opts && opts.keep)) RX.emit("abandon", p0);          // round 4: the item is dropped — rx/photos.js discards its damage photos
};
const STEP_KEYS = ["state","bin","binSource","workflow","stagedArea","recommendedBin","recReasons","splitOf","tempConfirmed","fefoOverride",
                   "shortDated","rejected","extra","overConfirmed","units","flash","noIntent","photoUrls","fixNote"];
RX.backToQty = function(){
  const p = pendingNow(); if(!p) return false;
  RX.abandon({keep:true});
  const rxs = p.rx || (p.rx = {});
  rxs.done = false; rxs.i = -1; delete rxs.d2; delete rxs.stage; delete rxs.exc; delete rxs.note;
  if(rxs.fields) for(const k of STEP_KEYS) delete rxs.fields[k];
  try{ clearPrompt(); }catch(_){}
  const had = p.qty;
  try{ askQty(); }catch(e){ try{ console.error("rx backToQty", e); }catch(_){} return false; }
  setTimeout(() => { const el = document.getElementById("qty"); if(el && had != null && !p.qtyUnknown){ el.value = String(had); el.focus(); el.select(); } }, 60);
  RX.refresh();
  return true;
};
RX.registerAct("prompt-close", () => { try{ closePromptDefault("button"); }catch(e){ try{ console.error("rx prompt-close", e); }catch(_){} } return "stop"; });

/* which steps will run for this pending item */
RX.stepsFor = function(p, flow){
  const names = CFG.flows[flow] || [];
  const out = [];
  for(const n of names){
    const h = steps[n]; if(!h) continue;
    out.push(n);
  }
  return out;
};
const receivable = (p) => {
  const sku = String((p.prod || {}).sku || "");
  if(sku.startsWith("!")) return "unnamed";
  if(p.qtyUnknown || p.qty == null) return "noqty";
  return "";
};

RX.beforeCommit = function(p){
  try{
    if(!p || !RX.active()) return false;
    const rxs = p.rx || (p.rx = {});
    if(rxs.done) return false;                                   // already ran (e.g. after the date check)
    const flow = RX.flow();
    if(!RX.flowActive() || !RX.flowAvailable(flow)){
      rxs.done = true;
      /* ⭐ ROUND 4 (D16): Best-by only in LIVE also writes a STAGED intent ("Not put away yet"): the date is saved, the case is
         received only when it is later put away from the staged list. No prompt is added — the per-case speed is unchanged. */
      if(flow === "bestby" && RX.mode() === "live" && !receivable(p)){
        rxs.flow = "bestby"; rxs.fields = Object.assign({}, rxs.fields, {state:"staged", workflow:"staged", stagedArea:RX.t("notput_area")});
      }else{ const w = receivable(p); if(w) rxs.note = w; }          // ⛔ review 2026-10-22 (3): no count / no name ⇒ no intent here either
      return false;
    }
    const why = receivable(p);
    if(why){ rxs.done = true; rxs.note = why; return false; }    // unnamed / no quantity: no shelf step, no intent
    /* ⭐ the date check belongs BEFORE the shelf: let commit() ask it, then come back through next() */
    try{ if(p.best && !p.dateConfirmed && typeof dateCheck === "function" && dateCheck(p.prod.sku, p.best)) return false; }catch(_){}
    const list = RX.stepsFor(p, flow);
    if(!list.length){ rxs.done = true; return false; }
    rxs.flow = flow; rxs.steps = list; rxs.i = -1; rxs.fields = rxs.fields || {};
    advance(p);
    return true;
  }catch(e){ try{ console.error("rx beforeCommit", e); }catch(_){} if(p && p.rx){ p.rx.done = true; try{ const w = receivable(p); if(w) p.rx.note = w; }catch(_){} } return false; }
};

function makeCtx(p, name){
  const rxs = p.rx;
  const ctx = {
    p, flow: rxs.flow, step: name, mode: RX.mode(), fields: rxs.fields,
    po: RX.po.matchFor ? RX.po.matchFor(p) : null,
    done(f){ if(f) Object.assign(rxs.fields, f); RX.state.step = null; advance(p); },
    commit(f){ RX.state.step = null; RX.commitWith(f || {}); },
    cancel(f){ RX.state.step = null; RX.commitWith(Object.assign({}, f || {}, {noIntent:true})); },
    side(html){ RX.side.set(html); }, clearSide(){ RX.side.clear(); },
  };
  return ctx;
}
function advance(p){
  const rxs = p.rx; rxs.i++;
  while(rxs.i < rxs.steps.length){
    const name = rxs.steps[rxs.i], h = steps[name];
    if(h){
      const ctx = makeCtx(p, name);
      let ok = true;
      try{ if(h.applies && !h.applies(ctx)) ok = false; }catch(_){ ok = false; }
      if(ok){ RX.state.step = {name, ctx}; try{ h.start(ctx); }catch(e){ try{ console.error("rx step start", name, e); }catch(_){} RX.state.step = null; RX.commitWith({noIntent:true}); } RX.refresh(); return; }
    }
    rxs.i++;
  }
  RX.state.step = null;
  RX.commitWith({});
}

RX.commitWith = function(fields){
  const p = pendingNow();
  if(!p) return false;
  const rxs = p.rx || (p.rx = {});
  rxs.fields = Object.assign({}, rxs.fields, fields || {});
  rxs.done = true;
  RX.state.step = null; RX.side.clear();
  if(typeof commit === "function") commit();
  return true;
};

RX.prefill = function(p, existing){
  let v = existing, basis = null;
  try{
    if(RX.flowActive() && !isAuditNow()){ const r = RX.po.caseQty ? RX.po.caseQty(p) : null; if(r && r.value > 0){ v = r.value; basis = r.basis; } }
  }catch(_){}
  p.qtyShown = (v == null) ? null : v; p.qtyBasis = basis;
  RX.state.qtyKindChoice = null;
  return v;
};
RX.qtyExtras = function(p){
  const out = {body:"", after:""};
  try{
    if(!RX.flowActive() || isAuditNow()) return out;
    for(const k of Object.keys(qtyContribs)){ const r = qtyContribs[k](p) || {}; out.body += r.body || ""; out.after += r.after || ""; }
  }catch(e){ try{ console.error("rx qtyExtras", e); }catch(_){} }
  return out;
};
RX.qtyKind = function(n){
  const p = pendingNow() || {};
  if(RX.state.qtyKindChoice === "full" || RX.state.qtyKindChoice === "part") return RX.state.qtyKindChoice;
  const shown = p.qtyShown;
  return (shown == null || shown === n) ? "full" : "part";
};
RX.poRef = function(p){
  try{ if(!RX.active() || !RX.pack.data) return ""; const m = RX.po.matchFor(p); return m && m.po ? String(m.po.order_id) : ""; }catch(_){ return ""; }
};

RX.onCommit = function(row){
  try{ RX.emit("committed", row); }catch(_){}
  try{
    RX.touchFlow();
    RX.state.lastRow = row;
    const rxs = row.rx;
    let made = null;
    /* ⛔ PM-3067 (2026-10-22): an item with NO usable quantity (or no name) never writes an intent — not even after "Back to the
       count": backToQty leaves an emptied `fields` object behind, and Chad's Garlic Naan (Back, then "I don't know the count") went to
       the poster as a ready intent with no units and no shelf → BAD_SHAPE. `rxs.note` is set by beforeCommit for exactly these. */
    if(RX.active() && rxs && rxs.fields && !rxs.fields.noIntent && !rxs.note){
      made = RX.intents.createFromRow(row);
    }
    if(RX.active() && RX.flowActive()){
      if(made && made.length){ RX.call("ui","flashPut", row, made); RX.sound(rxs.fields.state === "staged" ? "staged" : "saved"); }
      else if(rxs && rxs.fields && rxs.fields.noIntent){ RX.call("ui","flashText", (rxs.fields.flash || RX.t("setaside_flash")), row); RX.sound("decide"); }
      else if(rxs && rxs.note === "unnamed"){ RX.call("ui","flashText", RX.t("unnamed_flash"), row); }
      else if(rxs && rxs.note === "noqty"){ RX.call("ui","flashText", RX.t("noqty_flash"), row); }
    }
    RX.state.scanLog.length = 0;
    RX.refresh();
  }catch(e){ try{ console.error("rx onCommit", e); }catch(_){} }
};

RX.histRows = (rows) => RX.call("drawer","histRows", rows) || rows;
RX.shelfCell = (r) => RX.call("drawer","shelfCell", r) || null;
RX.chip = (r) => { const c = RX.call("intents","chipFor", r); return c ? RX.call("ui","chipHtml", c, r) : null; };
RX.afterRender = () => RX.call("drawer","afterRender");
RX.flush = async () => { try{ await RX.intents.flush(); }catch(_){} };
RX.unsentCount = () => { try{ return (RX.intents.unsent ? RX.intents.unsent() : 0) + (RX.photos && RX.photos.pending ? RX.photos.pending() : 0); }catch(_){ return 0; } };

/* ───────────────────────── sounds (mutable; the menu toggles AUDIO only) ───────────────────────── */
const SOUNDS = { saved:{f:[660,880],ms:90,vib:[40]}, staged:{f:[600,600],ms:90,vib:[30]},
                 decide:{f:[330],ms:140,vib:[30]}, refused:{f:[220,220],ms:110,vib:[80,60,80]} };
let audioCtx = null;
RX.soundOn = () => RX.store.get("rx_sound_v1", true) !== false;
RX.setSound = (on) => { RX.store.set("rx_sound_v1", !!on); RX.refresh(); };
RX.sound = function(kind){
  const s = SOUNDS[kind]; if(!s) return;
  const audible = RX.soundOn();
  RX.state.soundLog.push({kind, audio:audible, at:RX.now()}); while(RX.state.soundLog.length > 30) RX.state.soundLog.shift();
  try{ if(navigator.vibrate) navigator.vibrate(s.vib); }catch(_){}
  if(!audible) return;
  try{
    const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return;
    audioCtx = audioCtx || new AC();
    let t = audioCtx.currentTime;
    for(const f of s.f){
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + s.ms/1000);
      o.start(t); o.stop(t + s.ms/1000 + 0.02); t += s.ms/1000 + 0.04;
    }
  }catch(_){}
};

/* ───────────────────────── click router (data-act) ───────────────────────── */
RX.registerAct("noop", () => {});
document.addEventListener("click", (ev) => {
  const t = ev.target; if(!t || !t.closest) return;
  const el = t.closest("[data-act]");
  const inOverlay = !!t.closest(".rx-overlay");
  if(el){
    const name = el.getAttribute("data-act");
    const fn = acts[name];
    if(fn){
      if(el.disabled) { if(inOverlay) ev.stopPropagation(); return; }
      let r;
      try{ r = fn({el, name, ev}); }catch(e){ try{ console.error("rx act", name, e); }catch(_){} }
      if(inOverlay || r === "stop") ev.stopPropagation();
      return;
    }
  }
  if(inOverlay) ev.stopPropagation();        // ⛔ the page's click-refocus must never steal an overlay's input
}, true);

/* ───────────────────────── boot + 1 s ticker ───────────────────────── */
RX.state = { booted:false, step:null, scanLog:[], lastRow:null, qtyKindChoice:null, soundLog:[], day:null };
const bootFns = [];
RX.onBoot = (fn) => { bootFns.push(fn); };
RX.boot = function(){
  if(RX.state.booted) return;
  RX.state.booted = true; RX.state.day = RX.today();
  for(const fn of bootFns){ try{ fn(); }catch(e){ try{ console.error("rx boot", e); }catch(_){} } }
  const body = document.body; if(body && RX.mode() !== "off") body.classList.add("rx-on");
  RX.refresh();
  setInterval(() => {
    if(!RX.state.booted) return;
    const d = RX.today();
    if(d !== RX.state.day){ RX.state.day = d; RX.emit("day", d); RX.refresh(); }
    RX.emit("tick", RX.now());
  }, 1000);
};

window.RX = RX;
})();
