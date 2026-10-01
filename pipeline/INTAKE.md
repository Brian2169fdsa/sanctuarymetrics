# Sanctuary Metrics Pipeline: intake summary (running)

Status key: ✅ confirmed · 🟡 pre-filled, awaiting confirmation · ❓ not yet gathered · ⛔ blocker

No secrets in this file. Tokens, app secrets and keys are named only and
live in Make's connection vault or a gitignored `.env`.

## 5. Make.com (read directly via the Make MCP, 2026-10-01)

| Item | Value | Status |
|---|---|---|
| Zone | us2.make.com | ✅ |
| Organization | "My Organization" (id 8738238), owner Phoenix Creative Works | ✅ |
| Team for the scenario | "My Team" (id 2761263) | ✅ |
| Plan | **Free**: 1,000 ops/month, 15-min min interval, 5-min max run, 7-day log retention, **2 active scenarios** | ✅ |
| Ops used this cycle | 0 of 1,000 (resets 2026-10-21) | ✅ |
| Existing scenarios | 2, both **inactive** (M365 Email; Speed-to-Lead). Neither touches Sanctuary metrics. | ✅ |
| HTTP "Make a request" (`http:MakeRequest` v4) | Available | ✅ |
| Google Sheets (v2), JSON, Flow Control, Tools, Data store | Available | ✅ |
| Existing connections | Make AI Provider; Microsoft (admin@phxcw.com). **No Google, Meta or LinkedIn connection yet.** | ✅ |

Notes:
- A weekly run costs roughly 15–25 ops; ~100/month. Free plan is enough.
- Free allows 2 *active* scenarios. Both existing ones are off, so there is
  room. If you switch both of them on later, this one won't fit.
- 7-day execution logs: a failure is only visible in Make for a week, which is
  why the scenario carries its own failure alert.

## 1. Meta: Facebook + Instagram

| Item | Value | Status |
|---|---|---|
| Facebook Page ID | 100063738294812 (Sanctuary Recovery Centers) | 🟡 |
| Instagram Business Account ID | 131544476868638 seen in exports. Likely **not** the IG user ID (those usually start `1784…`); must be resolved via `instagram_business_account` | ❓ |
| Page has ≥100 likes | Expected yes (2,356 followers on Aug 6) | 🟡 |
| Meta app (App ID) | | ❓ |
| Permissions on the app | | ❓ |
| Access level (Standard / Advanced) | | ❓ |
| Long-lived Page token exists (type, expiry, scopes only) | | ❓ |
| Business Manager System User available | | ❓ |

## 2. LinkedIn: Company Page

| Item | Value | Status |
|---|---|---|
| Organization URN / numeric ID | | ❓ |
| Developer app + Client ID | | ❓ |
| Page admin verified the app | | ❓ |
| Community Management API access | | ❓ (expected ⛔) |
| Scopes `r_organization_social`, `rw_organization_admin` | | ❓ |

## 3. Website: GA4 (replacing Duda native stats)

| Item | Value | Status |
|---|---|---|
| Duda Site ID | 53a051d0 | 🟡 |
| GA4 installed on the Duda site | | ❓ |
| GA4 Property ID (numeric) | | ❓ |
| Measurement ID (G-…) | | ❓ |
| Custom channel group for social referrals | | ❓ |
| Data API auth (service account / OAuth) | | ❓ |

## 4. Destination: Google Sheet + repo

| Item | Value | Status |
|---|---|---|
| Google account Make connects with | | ❓ |
| Metrics Sheet ID | | ❓ |
| Repo | Brian2169fdsa/sanctuarymetrics (private) | ✅ |
| Default branch | main | ✅ |
| Report structure | Not single-file: `index.html` renders from `data.js` (hand-built snapshots Aug 6 / Aug 20 / Sep 3 / Sep 17) via `ui.js` | ✅ |
| Pipeline output file | proposed `data/metrics.json` | 🟡 |
| Vercel project name | | ❓ |
