# Sanctuary metrics pipeline

Replaces screenshot exports with a weekly automated pull.

```
Make.com (Thu 05:00 Phoenix, weekly)
  ├─ Facebook Graph API ─┐
  ├─ Instagram Graph API ├─► Google Sheet "metrics" tab (the metrics store)
  ├─ GA4 Data API        │
  └─ LinkedIn: manual ───┘   (pending rows until the API is approved)
                                   │
GitHub Action (Thu 07:00 Phoenix) ─┘ reads the tab as CSV
  └─ tools/build-metrics-json.py ─► data/metrics.json ─► commit to main ─► Vercel redeploys
```

| File | What it is |
|---|---|
| `INTAKE.md` | Every setup value, what's confirmed, blockers, and the gap list |
| `make/sanctuary-metrics.blueprint.json` | Importable Make scenario |
| `API_SPEC.md` | Exact endpoints and metric names, mapped to the report's KPI cards |
| `GA4_SETUP.md` | GA4 install on Duda, key events, channel group, auth, switchover |
| `../tools/build-metrics-json.py` | Sheet CSV → `data/metrics.json`, with the guardrails enforced |
| `../.github/workflows/metrics.yml` | Weekly build and commit |

---

## The metrics store (Sheet `metrics` tab)

Long format: one row per channel × metric × window. Row 1 is this header,
exactly as written:

```
run_date | channel | metric | dimension | value | window_start | window_end | period | source | status | note
```

| Column | Meaning |
|---|---|
| `run_date` | Day the scenario ran (YYYY-MM-DD, Phoenix) |
| `channel` | `facebook`, `instagram`, `website` or `linkedin`. Nothing else is accepted. |
| `metric` | Allow-listed name, e.g. `views`, `sessions`, `key_events`. See `API_SPEC.md`. |
| `dimension` | Blank for channel totals. For breakdowns: `channel=…`, `page=…` or `event=…`. |
| `value` | The number, or blank when the source couldn't provide it |
| `window_start` / `window_end` | Inclusive dates the number covers. Blank start means lifetime. |
| `period` | `28d`, `14d`, `7d` or `lifetime` |
| `source` | `meta_graph_api`, `ga4_data_api`, `linkedin_manual` |
| `status` | `ok` (from an API), `manual_verified` (pasted from a verified export), or `pending_verified_export` |
| `note` | Page name / IG handle for audit, or why a row is pending |

Rules the build enforces, so the Sheet can't slip:

- **PHI:** only allow-listed channels and metrics. A dimension with a query
  string, email address or phone number fails the build. No form contents
  ever enter the Sheet: the website pulls counts only, by `pagePath`
  (without query strings) and by key-event name.
- **Sanctuary only:** any row mentioning Cholla fails the build. The Make
  scenario also refuses to run unless the Page ID and linked IG account
  match the configured Sanctuary IDs.
- **Real data only:** a blank value is published as
  `pending_verified_export` and never filled in. A value still marked
  pending fails the build until someone sets it to `manual_verified`.
- **Freshness:** the Action fails when the newest run is more than 8 days
  old, so a dead token shows up within a week.
- **Re-runs:** a second run on the same day makes duplicate rows, and the
  build stops. Delete the older rows for that `run_date` first.

## `data/metrics.json`

```json
{
  "schema": 1,
  "generated_at": "…",
  "latest_run": "2026-10-08",
  "runs": [{
    "run_date": "2026-10-08",
    "channels": {
      "facebook": {
        "metrics": {
          "views_28d": {"value": 0, "status": "ok", "source": "meta_graph_api", "period": "28d",
                        "window": {"start": "…", "end": "…"},
                        "prior": {"value": 0, "window": {…}}, "change_pct": 0.0},
          "net_follows_28d": {"…": "derived: follows - unfollows"}
        },
        "breakdowns": {}
      },
      "website": {"metrics": {}, "breakdowns": {"channel": {}, "page": {}, "event": {}}}
    }
  }]
}
```

`change_pct` exists only when the run four weeks earlier covers exactly the
prior 28 days. Otherwise there's no change chip, and nothing is estimated.

## Report integration

The report today is `index.html` + `ui.js`, rendering hand-built snapshots
from `data.js` (Aug 6 / Aug 20 / Sep 3 / Sep 17). Those stay exactly as they
are: they're verified exports and the narrative is human-written.

From the first verified automated run:

1. The Action commits `data/metrics.json`.
2. A new snapshot (next would be Oct 15) takes its KPI numbers from the
   `metrics.json` run whose `run_date` is the snapshot date. Its windows come
   straight from each metric's `window`, which matches how `data.js` already
   records a source window per metric. The lead paragraph and
   recommendations stay hand-written.
3. Any metric with `status: pending_verified_export` renders through the
   report's existing "Not captured this period / Pending" treatment, never
   as a number.

The loader that does step 2 in the page is deliberately not built yet.
There's no verified run to render, and wiring the page to an empty file
would only show blanks. It's a small follow-up once the first real
`metrics.json` lands.

---

## Setup, in order

Values marked ❓ in `INTAKE.md` are needed where noted.

1. **Google Sheet.** As the Google account Make will use, create the
   spreadsheet *Sanctuary Metrics Store*. Name its first tab `metrics` and
   paste the header row above into A1:K1. Record the spreadsheet ID in
   `INTAKE.md`.
2. **Meta token.** See *Token upkeep* below. In Make: Connections → Add →
   **HTTP → API key**, key name `access_token`, placement *Query string*,
   value = the Page token. Name it `Sanctuary Meta Page token`.
3. **Google connections in Make.** One for Google Sheets and one for Google
   Analytics 4, both on the account from step 1. That account needs
   **Viewer** on the GA4 property.
4. **Import.** Make → Scenarios → Create → ⋯ → *Import blueprint* →
   `make/sanctuary-metrics.blueprint.json`. Then:
   - module 1: replace `SET_ME_IG_BUSINESS_ACCOUNT_ID` and `SET_ME_GA4_PROPERTY_ID`
   - modules 2–6: pick the Meta keychain from step 2
   - module 7: pick the GA4 connection
   - modules 8, 11, 13, 15: pick the Sheets connection, and replace `SET_ME_METRICS_SHEET_ID`
5. **Schedule.** Weekly, Thursday 05:00. Make uses the organization's time
   zone (Org → Settings), so check it's America/Phoenix or adjust the hour.
   Report snapshots fall on alternate Thursdays; the in-between runs supply
   the prior-28-day comparisons.
6. **Test.** *Run once.* Check the Sheet's rows against Meta Business Suite
   and GA4 for the same dates before switching the schedule on.
7. **Publish the tab.** In the Sheet: File → Share → *Publish to web* →
   `metrics` tab → CSV. Copy the link. It's unguessable but link-public; it
   only holds aggregate counts.
8. **GitHub secret.** Repo → Settings → Secrets and variables → Actions →
   `METRICS_CSV_URL` = that link. Then run *Actions → metrics → Run
   workflow* once. If `main` has branch protection that blocks the Action's
   push, allow `github-actions` or switch the step to open a PR.

Operations: about 40 per run (5 Graph calls, 1 GA4 call, 4 Sheet writes, and
one Sheet write per GA4 breakdown row), so about 175 a month. That's within
the Free plan's 1,000.

## Token upkeep (so the pipeline doesn't go silent)

Ranked:

1. **System-user token (best).** Meta Business Settings → Users → System
   users → add (role: Employee). Assign it the **Sanctuary Page only** as an
   asset, which is also the client-scoping control: a token that can't see
   Cholla can't leak Cholla. Generate a token for the app with the four
   permissions and expiry **Never**. This needs the Meta app to belong to the
   same Business portfolio as the Page.
2. **Page token from a long-lived user token.** Exchange a user token for a
   60-day one, then call `/me/accounts`. The Page token returned has no
   expiry date. It still dies if that user loses their Page role, changes
   password, or the app is reset.
3. **Raw 60-day user token.** Don't use it. If forced to, put a calendar
   reminder at day 50.

Whichever you pick, there are three alarms:

- Make stops the run on a Graph error (expired token = `OAuthException`
  code 190) and emails the scenario owner.
- After 3 consecutive failures Make deactivates the scenario.
- The GitHub Action's 8-day freshness check fails the next Thursday, which
  shows up as a red ✗ on the repo and an email to whoever watches Actions.
