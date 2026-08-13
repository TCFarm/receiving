# TC Farm receiving — best-by capture

Deployable page. Copy `index.html` + `catalog.json` into the **`TCFarm/receiving`**
GitHub repo, enable Pages, and it runs at
`https://tcfarm.github.io/receiving/`.

## What it does

Scan a case → `upc · sku · gtin14 · best_by · lot · source · operator · device`
lands as an item in the **`BB Receipts`** SharePoint list on
`https://tcfarm0.sharepoint.com/sites/tc.farm`.

## Why there is no framework

Auth is hand-rolled **OAuth2 authorization-code + PKCE**. No MSAL, no CDN, no
build step, no `node_modules`, and **no client secret** — PKCE replaces it. One
file that behaves identically on GitHub Pages and `localhost`, with nothing to
keep updated and no third-party script in the path of a warehouse tool.

## Deploying

```bash
# in a clone of TCFarm/receiving
cp index.html catalog.json .
git add -A && git commit -m "receiving: best-by capture" && git push
# GitHub → Settings → Pages → Source: main branch, root
```

Local test: `python3 -m http.server 8000` then open
`http://localhost:8000` — already a registered redirect URI.

⚠️ **The repo must be public** unless the org upgrades — GitHub Pages from a
private repo needs a paid plan. That is safe here: **no receiving data is ever
stored on GitHub.** The repo holds page code plus a product catalog (names,
SKUs, UPCs). Every scan goes to SharePoint and requires a Microsoft sign-in.
The embedded client id and tenant id are identifiers, not secrets.

## `catalog.json`

`{upc: {sku, name, cls, vis}}` — 2,628 products, ~277 KB, regenerated from
BigCommerce. It exists so the page can name a product **without holding a BC
token**, which a public page must never do.

Regenerate when the catalog changes materially:

```python
import bc_catalog, promo_pricing as pp, json
# storage comes from the __Storage_Location custom field — NOT __storage,
# which does not exist and silently yields blanks for every product
```

⚠️ `cls` drives the shelf-life window (Refrigerated 14d, Dry/Frozen 30d).
Source order: the `__Storage_Location` custom field, then the **SKU prefix**
— `R`=Refrigerated, `D`=Dry, `F`=Frozen (Jack, 2026-08-11). That resolves
**all 2,628 products**; the field alone left 4 blank. If a future product
resolves to neither, the page assumes **Refrigerated** — defaulting to the
longer window would silently double an item's assumed life.

## Rules baked in

* ⛔ **Scan the MANUFACTURER label, not KEHE's yellow pick label** — the pick
  label's date is order data, ~3 years off the true best-by.
* **GTIN check digit rejects a misread** before it can enter the ledger.
* **GTIN-14 → consumer barcode**: UPC-A gets its check digit *recomputed* over
  the 11-digit body; **EAN-13 passes through whole**. 5 live products (the NA
  wine range, imported produce) are EAN-13 — rejecting them blocked the scan
  entirely in an earlier revision.
* **`DD == 00` means end-of-month** — "Best By Feb 2029" transmits as `290200`.
* **Frozen items** are asked once per SKU whether the date is on the *package*;
  case-only dates are a soft deadline.
* ⛔ **A row counts as saved only when SharePoint returns its item id.** Retries
  4× with backoff, then marks `FAILED` in red and blocks page close. A silently
  dropped scan is the worst failure this system has.
* Startup **validates every required column** and names any that are missing,
  rather than writing rows with fields silently discarded.

## Related

* `docs/RECEIVING_DATE_CAPTURE.md` — the full spec and cohort design
* `config/receiving_app.json` — ids and endpoints
* `gs1_case_label.py` — the same parsing rules, server side
