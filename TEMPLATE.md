# Making This Site a Template for New Clients

How to turn this performance-report site into a reusable template, and how to
spin up a copy for a new company without carrying Sanctuary's data along.

---

## Why you must NOT clone or fork

The git history of this repository contains **every version of Sanctuary's
internal data** — report metrics, the L10 leadership dashboard, competitor
analysis — all marked Internal / Confidential. Cloning or forking copies that
history forever, even after you overwrite `data.js`. A fork also stays
publicly linked to the original on GitHub.

**Always start a new client from a history-free snapshot.** Two ways:

### Option A — GitHub template repository (recommended)
1. On GitHub, open **this repo → Settings**.
2. Check **"Template repository"** (near the top).
3. For each new client: click **"Use this template" → "Create a new
   repository"** and name it (e.g. `acmemetrics`). The new repo starts with
   ONE clean commit and no link back to this one.
4. In the new repo, do the **Rebrand checklist** and **Data reset** below
   before anything ships.

### Option B — fresh init (no GitHub template)
```bash
# copy the working files only — no .git directory
mkdir acmemetrics && cp sanctuarymetrics/{*.html,*.js,*.css,*.png,README.md,TEMPLATE.md} acmemetrics/
cd acmemetrics && git init && git add -A && git commit -m "Initial commit from report-site template"
# create an empty repo on GitHub, then:
git remote add origin https://github.com/<you>/acmemetrics && git push -u origin main
```

> Even better: keep one permanently **scrubbed** template repo (do the Data
> reset once, commit, mark it as the template) so every client starts from a
> shell that never contained any other client's numbers.

---

## What is brand-specific (the complete list)

Everything else is data-driven — these are the ONLY places to touch:

| File | What to change |
|---|---|
| `data.js` | All report data (see **Data reset**) and the `LOGO` variable at the top — a base64 data-URI of the client logo |
| `ui.js` | `pageFooter()` — company name, tagline, city, phone. `pageHeader()` needs no edits (it uses `LOGO`) |
| `report.css` | Brand tokens in `:root` (`--blue --teal --coral --gold --ink --muted --line --paper`) and the `.phoenix` gradient stops |
| `index.html`, `compare.html`, `twoweeks.html`, `projects.html` | The `<title>` tag in each |
| `logo.png` | Vendor logo shown in the vendor/SEO section (currently BizIQ) — replace or remove the `<img>` in `renderBizIQ()` |

To generate the `LOGO` data-URI from a PNG:
```bash
echo "data:image/png;base64,$(base64 -w0 client-logo.png)"
```

---

## Data reset (`data.js`)

Delete the Sanctuary contents of every object below and rebuild from the new
client's exports. **Do not leave any Sanctuary rows behind.**

| Object | What it holds |
|---|---|
| `WINDOWS` | Named source date-ranges, e.g. `fbAug20: 'Jul 23 – Aug 19, 2026'`. Every metric points at one of these |
| `CHANNEL_META` | Channel display names + colors |
| `REPORTS` + `REPORT_ORDER` | One snapshot object per reporting date; newest first in `REPORT_ORDER` (the selector defaults to `REPORT_ORDER[0]`) |
| `SERIES` | Trendable metric series for the Compare page — each point `{ label, value, w }` |
| `COMPETITORS` | Competitor table (rendered on the Report page's LinkedIn section and the Compare page) |
| `BIZIQ` | Vendor/SEO campaign section — rename/repurpose per the client's vendor |
| `TWOWEEK` | The two-weeks-at-a-glance tables |
| `L10` | Leadership-dashboard rocks shown in the L10 section and seeded into the Projects tab |

Minimal snapshot skeleton:
```js
var SNAP_X = {
  id: 'YYYY-MM-DD', label: '<Mon D> snapshot', reportDate: '<Mon D, YYYY>',
  dataLine: '<channel windows summary for the footer>',
  summary: { measured: true, lead: '…', kpis: [...], reach: [...], rollup: { head: [...], rows: [...] } },
  channels: {
    website:   { measured: true, source: '…', window: WINDOWS.x, kpis: [...], /* weekly, sources, topPages… */ },
    facebook:  { measured: true, /* … */ },
    instagram: { measured: false, lastWindow: WINDOWS.x },          // "no new export" state
    // or:     { measured: false, pending: true, plannedWindow: WINDOWS.x, lastWindow: WINDOWS.y }
    linkedin:  { measured: true, showCompetitors: true, /* … */ }
  },
  recommendations: ['…']
};
```

### Non-negotiable data rules (these are why the site is trustworthy)
1. **Every metric carries its exact source window** (`w: WINDOWS.x`). Never
   present mismatched windows as the same period.
2. **Never carry numbers forward.** A channel with no new export renders the
   muted `measured: false` state — never last period's figures.
3. **Use platform dedup figures**, never sums of daily rows, for unique/reach
   metrics (daily sums double-count).
4. **Every table needs a `<thead>`** — the mobile stacked-table script keys on
   it. (The `table()` helper in `ui.js` does this automatically; don't
   hand-write tables.)
5. Numbers come **only from real exports** the client hands over. Anything
   missing is "pending verified export," not an estimate.

---

## Per-client spin-up checklist

1. **Create the repo** from the template (Option A above).
2. **Rebrand** — the five-row table above. Verify the logo renders and the
   gradient matches the client's palette.
3. **Data reset** — empty `data.js`, load the first snapshot from the
   client's exports.
4. **Vercel** — *New Project* → import the new repo → framework "Other", no
   build step (static site). It deploys `main` on every push. Never attach a
   new client to another client's Vercel project or domain.
5. **Connect Claude Code** — open a session on the new repo. Hand it the
   client's platform exports (`.xls`/`.xlsx`/CSV) or a metrics markdown brief;
   point it at this file and the rules above.
6. **Verify before sharing:** open all four pages top to bottom, check the
   browser console for errors, switch every period in the selector, and view
   at phone width (no horizontal scroll, charts legible).

## Pages
| Page | Purpose |
|---|---|
| `index.html` | Snapshot report with period selector; sections re-render from `REPORTS` |
| `compare.html` | Channel/metric/period comparison + per-channel context section |
| `twoweeks.html` | Like-for-like 14-day comparison |
| `projects.html` | Project tracker seeded from `L10`; browser-added rows live in localStorage |

`report.css`, `data.js`, `ui.js` are shared by all pages — `index.html` is
**not** standalone and must be served with its siblings.
