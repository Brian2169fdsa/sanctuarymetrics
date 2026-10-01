# Sanctuary Metrics Pipeline: intake summary

Status key: ✅ confirmed · 🟡 pre-filled, not yet confirmed · ❓ not gathered · ⛔ blocker

As of 2026-10-01. The Make values were read live from the account. Meta,
LinkedIn, GA4 and Sheet values haven't been gathered yet: there was no
browser access to those dashboards, and the build went ahead without them.
Every unknown is a named `SET_ME_*` placeholder in the blueprint, never a
guessed value.

No secrets in this file. Tokens, app secrets and keys are named only, and
live in Make's keychain or a gitignored `.env`.

## 1. Meta: Facebook + Instagram

| Item | Value | Status |
|---|---|---|
| Facebook Page ID | 100063738294812 (Sanctuary Recovery Centers) | 🟡 |
| Instagram Business Account ID | Resolve via `GET /100063738294812?fields=instagram_business_account{id,username}`. The 131544476868638 in exports is likely **not** it (IG user IDs usually start `1784…`). | ❓ → `SET_ME_IG_BUSINESS_ACCOUNT_ID` |
| Page meets the ≥100-likes Insights threshold | 2,356 followers on Aug 6 | 🟡 |
| Meta app (App ID, owning Business portfolio) | | ❓ |
| Permissions: `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights` | | ❓ |
| Access level | | ❓ (see blocker M1) |
| Token: type, expiry, scopes (from the Access Token Debugger, never the token itself) | | ❓ |
| Business Manager system user with only the Sanctuary Page assigned | | ❓ |

## 2. LinkedIn: Company Page

| Item | Value | Status |
|---|---|---|
| Organization URN | `urn:li:organization:` + numeric ID (Page admin view URL `linkedin.com/company/<ID>/admin`) | ❓ → `SET_ME_LINKEDIN_ORG_ID` |
| Developer app + Client ID; Page admin verified it | | ❓ |
| Community Management API access | | ⛔ expected (see L1) |
| Scopes `rw_organization_admin`, `r_organization_social` | | ❓ |

## 3. Website: GA4 (replacing Duda's native stats)

| Item | Value | Status |
|---|---|---|
| Duda Site ID | 53a051d0 | 🟡 |
| GA4 installed on the Duda site | Check per `GA4_SETUP.md` §0 | ❓ |
| GA4 Property ID (numeric) | | ❓ → `SET_ME_GA4_PROPERTY_ID` |
| Measurement ID (G-…) | | ❓ |
| Key events `click_to_call`, `form_submit_lead` | Not set up yet as far as is known | ❓ |
| Custom channel group for social referrals | Definition ready in `GA4_SETUP.md` §2 | ❓ |
| Data API auth | OAuth via Make's GA4 app (Make doesn't take service-account keys); dedicated Viewer-only account recommended | 🟡 |

## 4. Destination: Google Sheet + repo

| Item | Value | Status |
|---|---|---|
| Google account Make connects with | | ❓ |
| Metrics Sheet ID | | ❓ → `SET_ME_METRICS_SHEET_ID` |
| Repo / default branch | Brian2169fdsa/sanctuarymetrics (private) / `main` | ✅ |
| Report structure | Not single-file: `index.html` renders from `data.js` (hand-built snapshots Aug 6 / Aug 20 / Sep 3 / Sep 17, all Thursdays) via `ui.js` | ✅ |
| Pipeline output | `data/metrics.json`, committed weekly by `.github/workflows/metrics.yml` | ✅ built |
| Vercel project | `sanctuarymetrics` (team phoenix-creative-works); deploys `main` and builds per-branch previews | ✅ |
| GitHub secret `METRICS_CSV_URL` | | ❓ |

## 5. Make.com (read live via the Make MCP)

| Item | Value | Status |
|---|---|---|
| Zone / org / team | us2.make.com / "My Organization" (8738238) / "My Team" (2761263) | ✅ |
| Plan | **Free**: 1,000 ops/month, 15-min minimum interval, 5-min max run, 7-day logs, **2 active scenarios** | ✅ |
| Usage | 0 of 1,000 this cycle (resets 2026-10-21) | ✅ |
| Existing scenarios | 2, both **inactive** (M365 Email; Speed-to-Lead). Room for this one. | ✅ |
| HTTP "Make a request" (`http:MakeRequest` v4) | Available | ✅ |
| Google Sheets v2, Google Analytics 4 v1, Flow Control, Tools | Available | ✅ |
| Connections | Only Make AI + Microsoft (admin@phxcw.com). **No Google, Meta or LinkedIn yet.** | ✅ |
| Estimated cost | about 40 ops/run, about 175/month | ✅ |

---

## Blockers

| # | Blocker | Impact | Expected | Way around |
|---|---|---|---|---|
| **L1** | LinkedIn **Community Management API** approval for the developer app | No LinkedIn data flows automatically | Weeks to months; LinkedIn may decline small orgs | Manual rows (`pending_verified_export` → paste → `manual_verified`). The API calls are specified and ready (`API_SPEC.md` §4). |
| **M1** | Meta access level / App Review for the 5 permissions | FB/IG calls fail until granted | 2–4 weeks *if* review is needed | Probably not needed: if the app belongs to the Business portfolio that owns the Page and the token comes from a role-holder or system user, Standard Access covers your own Page's insights. Confirm by checking the app's owner. |
| M2 | Meta token | Pipeline goes silent when it dies | | System-user token with no expiry (README → Token upkeep), plus three alarms |
| G1 | GA4 possibly not installed on Duda | No website data | Same day once installed, but data only starts from install | `GA4_SETUP.md` §0. History stays on Duda, labeled. |
| G2 | Lead key events not configured | Click-to-call and Form cards stay pending | Same day; counts start from setup | `GA4_SETUP.md` §1 |
| P1 | Free plan allows 2 active scenarios | If both existing scenarios get switched on, this one can't run | | Upgrade to Core, or keep one off |

## Gap list: stays manual or pending until cleared

Nothing in this list gets a placeholder or an estimate. Each item renders
as "Pending — verified export" until a real number exists.

| Report element | Why the pipeline can't fill it | Until then |
|---|---|---|
| All LinkedIn cards (impressions, clicks, engagement rate, followers, top posts, industry/location) | L1 | Manual paste from LinkedIn Page analytics export → `manual_verified` |
| Facebook / Instagram, everything | M1/M2 until a working token exists | Current screenshot exports |
| Website, everything | G1 until GA4 is live; GA4 never backfills before install | Duda figures for past periods, labeled "not comparable" |
| Click-to-call, Form submissions | G2 | Pending |
| Facebook **link clicks** (rollup "21 clicks") | Page-level link-click metrics were retired; `page_total_actions` counts CTA/contact clicks, which is a different thing | Pending, or label the rollup "CTA clicks" |
| Facebook / Instagram **messages** + response rate/time | Not exposed in Page/IG insights | Manual from Business Suite inbox |
| Facebook **views by content format**, **top posts**; IG **where views came from** | Post-level / breakdown pulls not in this first build (possible later: `/posts?fields=insights.metric(post_media_view)`, IG `views` with `breakdown=follower_type`) | Manual |
| Meta **vs. peers** benchmarks | Business Suite UI only, no API | Manual |
| Weekly bar charts | First build stores 28-day totals; overlapping 28-day windows can't be turned into weekly bars | Pending; add `period=week` (Meta) and a week dimension (GA4) pulls as a follow-up |
| BizIQ | Vendor report, outside this pipeline | Unchanged |
| Prior-period ▲/▼ chips | Need the run 4 weeks earlier | Appear automatically from the 5th weekly run |
