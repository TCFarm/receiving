/* receiving/rx/rx-config.js — timings, flags and the COPY table for the receiving upgrade.
   OWNER: Procurement & Merchandising (hosted in ProductPipeline/receiving).  Classic script: no modules, no build.

   ⭐ LOAD ORDER (index.html <script src> tags, all BEFORE the inline script):
        gs1.js  rx/rx-config.js  rx/rx-core.js  rx/receive-pack.js  rx/intents.js  rx/receive-po.js
        rx/start.js  rx/po-drawer.js   [WP4b adds: rx/recommend.js  rx/putaway.js  rx/staging.js]
   ⛔ This file does NOT create `window.RX`. It parks its tables on `window.__RXBOOT`, and `rx-core.js`
      creates `window.RX` ONLY after its own hooks exist — so `window.RX && RX.intercept(v)` in index.html can
      never hit "RX exists but the function does not". Everything else attaches to `window.RX` afterwards.

   ═══ WHAT LIVES HERE ═══
   RX.CFG     timings (ms), flags, locations. Read at call time, so a test or a hot-fix can change a value.
   RX.COPY    EVERY user-visible string the new code writes (UX design §8). One place, so copy is edited once.
   RX.t(key, vars)   → COPY[key] with {name} placeholders replaced. A missing key returns the key itself and
                       is logged — ⛔ never "undefined" on a crew member's screen.

   ═══ FLAGS (RX.CFG.flags) ═══
   gs1_split_autofill  false  ⛔ a date obtained by the GS1 lot-swallow split is PREFILLED and needs one Enter
                              until the replay shows 0 wrong splits on ≥30 known cases (MASTER-PLAN §9.7, D25).
                              Mirrored onto `window.GS1_SPLIT_AUTOFILL`, which gs1.js reads.
   practice_toggle     true   the "Practice: also scan the shelf tag" session toggle (shadow only).
   rollback_off        false  true ⇒ the page behaves exactly as it did before the upgrade (RX.mode() === "off").
                              Same effect as `?rx=off` on the URL or localStorage `rx_off=1` on one tablet.
   sentinel_page_mode  "shadow"   what the page SHOWS while the poster is in sentinel mode (it is not "live"
                              for the crew: every scan is still also received in the Finale app).
*/
(function(){
"use strict";

const CFG = {
  /* ── timings (ms unless the name says otherwise) ── */
  WAIT_SAVED:      15*1000,         // an intent younger than this reads "Saved", then "Waiting for Finale m:ss"
  WAIT_USUAL:     120*1000,         // "usually under 2 min" (drill-down text only)
  WAIT_SLOW:      5*60*1000,        // "Waiting 6:12 — slow"
  WAIT_ALERT:     15*60*1000,       // "Waiting 16:02 — buyer told"
  /* ⭐ ONE stale threshold. PM-3116 (2026-10-23): MEASURED, not chosen — the poster writes its status at the END of each run, and the 500
     status writes 10-21 20:56Z → 10-24 02:32Z (the file's SharePoint version history) are 382 s apart at the median, 455 s at p95 and
     518 s at most (10-23 14:12 → 14:21, the "delayed 8:19" Eli saw); 475 of the 500 gaps were over the old 5 min, so the banner fired on
     almost every normal cycle. Worst age a tablet can show on a healthy mini = 518 s + `at` written ~9 s before upload + POLL_IDLE 60 s
     ≈ 587 s; ONE missed run ≈ 2 × 382 s = 764 s. 12 min sits between them with ~2 min to spare for a tablet clock that runs fast
     (adversarial review 2026-10-23: 11 left 73 s): no false alarm in the measured history (2.5 days), a missed run still shows. Re-measure from the version history before changing it (Procurement & Merchandising/plans/2026-10-23-receiving-fix-receive-rest-PLAN.md). */
  POSTER_STALE:   12*60*1000,
  POLL_OPEN:      20*1000,          // read this tablet's intents while any is not final
  POLL_IDLE:      60*1000,
  POLL_LIMIT:     10*1000,          // every read has a time limit and a generation guard
  PACK_STALL:     10*1000,          // no bytes for this long ⇒ give up and use the cached copy
  PACK_TOTAL:     30*1000,
  PACK_REFRESH:   30*60*1000,       // silent refresh while the page is in use (applied only at an idle moment)
  FLOW_STALE:     6*3600*1000,      // the same clock as the mode question (MODE_STALE_HOURS)
  FLUSH_TICK:     15*1000,          // outbox retry cadence (the page's own retry is 45 s)
  TOAST_MS:       4000,
  AUTH_401_LIMIT: 10*60*1000,       // ROUND-2 (3): a 401 that survives a fresh token for this long ⇒ §9.12 "receive in the Finale app"
  /* ── locations ── */
  intents: { site: "tcfarm0.sharepoint.com:/sites/ClaudeAgents", list: "ReceivingIntents" },
  poster:  { path: "Receiving/poster_status.json" },        // on the ClaudeAgents site drive (§9.3)
  /* The pack lives in info@tc.farm's OneDrive (the staff app's `data.drive_id`, shell/config.json). ⛔ Never on
     GitHub Pages: PO quantities and the bin map must not be public (DECISIONS D3). */
  pack: { drive_id: "b!hJk_LsjqhE2esYNJF9MH7efG2Lh45dlNkuzHXebLE1NuSPSlvXdrRpSEUMpTF9I7",
          path: "TC Farm/Claude Files/Procurement & Merchandising/app/receiving/pack.json",
          schema: "tcfarm.receiving.pack/1", cache_key: "rx_pack_v1" },
  floorcount_url: "",             // the "Counting a shelf? Use Floor Count" link; empty ⇒ the link is not shown
  vendor: "kehe",
  flags: {
    gs1_split_autofill: false,
    practice_toggle: true,
    rollback_off: false,
    sentinel_page_mode: "shadow",
  },
  /* the flows RX knows and the steps each runs between "qty saved" and "commit".
     ⭐ A step with no registered handler is SKIPPED, so a flow whose steps have not shipped degrades to today's
     best-by-only commit instead of breaking. WP4b registers `shelf`, `stage`, `tray` (and may add `exceptions`). */
  flows: { bestby: [], direct: ["oncart","damage","overship","exceptions","nopo","shelf"], sort: ["oncart","damage","overship","exceptions","nopo","stage"], staged: ["damage","overship","nopo","tray"] },
  scan_log_max: 12,
  PHOTO_WAIT:     10*1000,          // round 5: Continue on the damage-photo card waits this long (twice) for an upload in flight
  SHELF_IDLE:     10*60*1000,       // round 4 (D12): shelf mode clears after this long with no case put away
};

/* ═══ COPY — UX design §8 plus the chip / pack / start strings ═══ */
const COPY = {
  /* scan + steps */
  scan_label_d0:   "Scan a case — or a shelf tag",
  d2_title:        "Now scan the shelf tag",
  split_rest:      "{n} units left — scan the next shelf tag",
  stage_title:     "Which cart? (Enter = top)",
  staged_flash:    "STAGED → {area} ({bin}) — not in Finale yet",
  put_flash:       "✓ {n} × {name} → {bin} · best by {yearFirst}",
  tray_hint:       "Scan items, then the shelf tag. Or tag first, then one item.",
  wrong_product:   "Finish this case first — scan the shelf tag for {name}.",
  unknown_tag:     "That's not a shelf tag we know: {code}.",
  inactive:        "{bin} is switched off in Finale. Use another shelf, or tell the buyer.",
  temp:            "This is a {CLASS} shelf. {name} is {CLASS}.",
  fefo:            "Older stock is in backstock. Newer stock goes behind it.",
  over:            "{k} of {n} {unit} — {over} more than ordered. Put it away; the buyer sorts out the extra.",
  complete:        "this completes the line ({k} of {n} {unit})",
  makes:           "this makes {k} of {n} {unit}",
  no_po:           "Not on the KeHE order. You will be asked to set it aside.",
  no_po_short:     "Not on the KeHE order.",
  poster_down:     "Finale posting is delayed. Your scans are safe — keep going.",
  poster_down_det: "Last check {ago} ago.",
  practice:        "Practice run — also receive these in the Finale app.",
  practice_quiet:  "Practice run — the Finale app is still how you receive.",
  denied:          "Finale queue unreachable — receive in the Finale app.",
  denied_detail:   "This put-away was not sent to Finale. Receive it in the Finale app.",
  /* start screen */
  start_h:         "Today's delivery",
  start_how:       "How are you receiving?",
  tile_bestby:     "Best-by only (as before)",
  tile_bestby_sub: "Scan case, date, count. No shelf step.",
  tile_direct:     "Put away here",
  tile_direct_sub: "I'm at the shelf. Scan case, date, then the shelf tag.",
  tile_sort:       "Sort first",
  tile_sort_sub:   "I'm at the pallet. Scan case, date; it tells you which cart.",
  practice_toggle: "Practice: also scan the shelf tag",
  practice_hint:   "For one volunteer. Nothing is posted to Finale — receive in the Finale app as usual. Turns off at midnight.",
  shadow_note:     "Practice period: scans are saved as before. Nothing from here is posted to Finale yet.",
  audit_link:      "Old audit here",
  btn_change:      "Change",
  btn_hide:        "Hide",
  mini_practice_on:  "practice on",
  mini_practice_off: "practice off",
  floorcount_link: "Counting a shelf? Use Floor Count",
  pick_flow_first: "Choose how you are receiving first — put away here, or sort first.",
  pick_flow_not_recorded: "That scan was not recorded.",
  finish_first:    "Finish this case first.",
  po_one:          "KeHE PO {po} · {due} · {lines} lines · {recv} received",
  po_many_h:       "{n} KeHE deliveries open",
  po_many_row:     "{po} · {due} · {left} left",
  po_many_hint:    "Scans match the right one automatically.",
  po_none_h:       "No KeHE delivery is due today.",
  po_none_b:       "Best-by dates still save. Nothing goes into Finale. If a truck is here, tell the buyer.",
  due_today:       "due today",
  due_tomorrow:    "due tomorrow",
  due_late:        "due {dow} (late)",
  pack_from:       "Delivery list from {at}",
  pack_from_ago:   "Delivery list from {at} ({ago} ago)",
  pack_not_today:  "Delivery list is from {when} — not built today yet.",
  pack_none:       "Today's delivery list didn't load. Scans save on this tablet; PO matching is off until it loads.",
  pack_step1:      "Step 1 of 2 · Reading today's delivery list",
  pack_step2:      "Step 2 of 2 · Saving it on this tablet",
  pack_limit_cached: "Couldn't load it ({why}). Using the copy from {at} today.",
  pack_limit_cached_old: "Couldn't load it ({why}). Using the copy from {when}.",
  pack_offline:    "Offline — using the delivery list saved at {at}.",
  pack_bad:        "the list on the server isn't a delivery list",
  pack_denied:     "this tablet isn't allowed to read it",
  pack_missing:    "no delivery list has been built yet",
  pack_nonet:      "no network",
  pack_timeout:    "it took too long",
  btn_refresh:     "Refresh",
  btn_try_again:   "Try again",
  btn_details:     "Details",
  /* strip */
  strip_po:        "PO {po} · {done}/{total} lines",
  strip_nopo:      "No PO on this list",
  strip_live:      "Finale LIVE · checked {ago} ago",
  strip_practice:  "Practice (not posting)",
  strip_off:       "Finale off",
  strip_delayed:   "Finale posting delayed · {ago}",
  strip_staged:    "Staged {n}",
  strip_tablet:    "On tablet {n}",
  /* menu */
  menu_sounds_on:  "Sounds on",
  menu_sounds_off: "Sounds off",
  menu_refresh:    "Refresh delivery list",
  menu_signout:    "Sign out",
  menu_flow:       "Change how I'm receiving",
  /* chips (UX §3.4) */
  chip_ontablet:   "On tablet",
  chip_ontablet_t: "Saved on this tablet. Sends when the network is back.",
  chip_sending:    "Sending…",
  chip_saved:      "Saved",
  chip_waiting:    "Waiting for Finale {clock}",
  chip_slow:       "Waiting {clock} — slow",
  chip_alert:      "Waiting {clock} — buyer told",
  chip_waiting_t:  "Usually under 2 minutes. Your scan is safe.",
  chip_infinale:   "In Finale ✓",
  chip_reversed:   "Taken back out of Finale (receipt cancelled)",
  chip_held:       "Held for the buyer",
  chip_refused:    "Refused",
  chip_practice:   "Not posted (practice)",
  chip_staged:     "Staged → {area}",
  chip_receive_app:"Receive in Finale app",
  chip_denied_unsure:"Not confirmed — tell the buyer",
  denied_unsure_detail:"This put-away may already be on Finale's list, but this tablet could not confirm it. Don't receive it again — the buyer checks it.",
  chip_signin:     "Held — sign in again",
  chip_signin_t:   "Kept on this tablet. It sends after you sign in again (the banner at the top).",
  chip_cancelled:  "Cancelled",
  chip_checking:   "Checking with Finale",
  chip_damaged:    "{n} damaged",
  chip_fixsent:    "fix sent to the buyer",
  /* history */
  hist_all: "All", hist_waiting: "Waiting", hist_problems: "Problems", hist_staged: "Staged",
  hist_show_all:   "Show all",
  col_shelf: "Shelf", col_status: "Status",
  shelf_none:      "—",
  shelf_typed:     "typed, not scanned",
  tile_cases: "Cases", tile_infinale: "In Finale", tile_waiting: "Waiting", tile_problems: "Problems", tile_notyping: "No typing",
  /* drawer */
  drawer_close:    "Close",
  drawer_po:       "PO {po} · line {line} · {k} of {n} {unit}",
  drawer_change_shelf: "Change shelf",
  drawer_tell_julia:   "Moved it? Tell the buyer",
  drawer_not_all_fit:  "Not all fit?",
  drawer_shelf_prompt: "Scan or type the new shelf tag",
  drawer_shelf_save:   "Save",
  drawer_shelf_unknown:"That's not a shelf tag we know: {code}.",
  drawer_shelf_off:    "{bin} is switched off in Finale. Use another shelf, or tell the buyer.",
  fix_sent:        "Finale already has this. The buyer will fix it there.",
  cancel_too_late: "This is already in Finale. The buyer will reverse it there.",
  split_refused:   "That split could not be recorded — Finale already had the whole case. The buyer will fix it.",
  last_split_kept: "Not split — all {n} units stay on {bin}.",
  store_full:      "This tablet's storage is full — keep this page open until \"On tablet\" is 0, then tell the buyer.",
  undone:          "Cancelled — nothing was sent to Finale.",
  /* PO drawer */
  po_progress:     "{done} of {total} lines · {pct}%",
  po_f_notstarted: "Not started", po_f_partial: "Partial", po_f_done: "Done", po_f_over: "Over",
  po_f_problems:   "Problems", po_f_notpo: "Not on PO", po_f_all: "All",
  po_search_ph:    "Find an item",
  po_line_of:      "{k} of {n} {unit}",
  po_empty:        "No lines match.",
  po_loading:      "Reading the delivery list…",
  /* qty card */
  qty_from_po:     "from the PO",
  qty_learned:     "learned from earlier cases",
  qty_finale:      "Finale case size",
  qty_kehe:        "KeHE case pack",
  qty_session:     "you entered it earlier today",
  qty_full:        "Full case",
  qty_part:        "Part case",
  qty_full_hint:   "Full case teaches us the case size.",
  qty_size_changed:"Case size changed",
  qty_size_q:      "Use {n} per case from now on for this item? (Today on this tablet; everywhere after the next update.)",
  qty_size_yes:    "Yes, use {n}",
  qty_size_no:     "No",
  qty_damaged:     "Some damaged",
  dmg_q:           "How many units are damaged?",
  dmg_save:        "Save",
  dmg_cancel:      "Cancel",
  dmg_all:         "Nothing to put away — recorded as damaged for the buyer.",
  dmg_unknown:     "You entered {k} damaged. Without a count they would be lost from the KeHE credit list. Type how many came in GOOD, or:",
  dmg_all_yes:     "All {k} are damaged — none good",
  dmg_clear:       "Clear the damaged number",
  notpo_setaside:  "Set it aside",
  setaside_flash:  "Set aside — tell the buyer.",
  unnamed_flash:   "Saved unnamed — this one goes into Finale by hand (the buyer).",
  noqty_flash:     "Saved without a quantity — the buyer sorts it out.",
  btn_undo:        "Undo",
  btn_notallfit:   "Not all fit?",
  /* round 3 (Jack, 2026-10-19) */
  link_bestby_live: "Best-by only (no shelf scan)",
  bestby_live_on:   "On now — change it above.",
  menu_close:      "Close",
  overship_title:  "You've now received {n} of {item}.",
  overship_body:   "KeHE says it shipped {m}. Is {n} right?",
  overship_body_ordered: "We ordered {m}. Is {n} right?",
  overship_yes:    "Yes, {n} is right",
  overship_fix:    "Fix the count",
  btn_back_count:  "Back to the count",
  btn_close:       "Close",
  btn_cancel:      "Cancel",
  btn_back:        "Back",
  notput_area:     "Not put away yet",
};

function t(key, vars){
  let s = COPY[key];
  if(typeof s !== "string"){ try{ console.warn("rx COPY missing:", key); }catch(_){} return String(key); }
  if(vars) s = s.replace(/\{(\w+)\}/g, (m,k)=> (vars[k] === undefined || vars[k] === null) ? "" : String(vars[k]));
  return s;
}

window.GS1_SPLIT_AUTOFILL = !!CFG.flags.gs1_split_autofill;   // gs1.js only sets a default when undefined
window.__RXBOOT = { CFG, COPY, t };
})();
