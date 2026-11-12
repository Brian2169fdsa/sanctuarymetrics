# Microsoft 365 daily sync + AI cost review

Every morning the site pulls Sanctuary's Microsoft 365 licenses and usage
straight from Microsoft, and Claude reviews it for ways to cut cost. No
downloads, no ZIP files, no scripts to run by hand.

```
11:05 UTC (4:05 am Phoenix)  /api/m365-sync   Microsoft Graph → today's snapshot in Supabase
11:35 UTC (4:35 am Phoenix)  /api/m365-ai     Claude reviews it → cuts to approve on Cost cutting
```

Both run as Vercel scheduled jobs (`vercel.json`; each path is rewritten to
`/api/m365?action=…`), each within the 60-second function limit. An admin can also press
**Refresh now** at the top of the Microsoft usage review.

## What's automatic now, and what isn't

| | Where it comes from |
|---|---|
| Seats bought / assigned per license, renewal dates | Microsoft, daily |
| Every account, its licenses, blocked or not | Microsoft, daily |
| Last activity per workload, mailbox size, email, Teams, OneDrive, desktop vs web Office | Microsoft usage reports, daily |
| SharePoint sites, Groups, Teams activity | Microsoft usage reports, daily |
| Cost rules (blocked, idle 90+, shared mailboxes, stacked Exchange, Standard→Basic, duplicates, unassigned seats) | Computed daily from the above |
| AI ranking, explanations and "Recommendations by lane" | Claude, daily |
| **What actually gets cut** | **People.** The AI proposes; someone approves on Cost cutting; approval makes a task. Nothing is ever changed in Microsoft by the site. |
| Invoices | By hand in `microsoft-costs.js`. Microsoft doesn't expose invoices through this connection. |
| Prices per license | By hand in `lib/m365-skus.js`. Microsoft Graph says what you own, not what you pay. |
| Approved cut, "Cost cut so far", cleanup log | By hand, as before (`microsoft-costs.js`, `microsoft-cleanup.js`). |

## How the AI review stays honest

- **Rules find the candidates; Claude only picks and explains.** Every account
  it recommends must come from a rule's own list, and every dollar figure is
  recomputed by the site from the accounts and the price list. Claude never
  sets a number.
- **The keep list is absolute.** Accounts in `m365_keep` never appear in a cut
  or downgrade. It's seeded with the four people Elyssa asked to keep live.
  Two accounts match "Schall" and two match "Ulonda", so both of each are on
  it. Delete the ones that shouldn't be.
- **Decisions stick.** Accounts in a cut someone **declined** in the last
  90 days aren't proposed again. Accounts in an **approved** cut are left alone
  for 60 days while the work is done.
- **One open proposal per rule.** Tomorrow's run updates it in place instead of
  stacking duplicates. When nobody is left under a rule, its proposal is
  withdrawn automatically.
- **Business Premium is never sent for approval.** It's the security tier.
  Cutting it is a compliance decision, so it's only flagged.
- New proposals ring the admins' bell.

## Setup (once)

### 1. Microsoft: permissions on the app (needs a Global Administrator)

Use the existing Microsoft sign-in app (`MS_CLIENT_ID` / `MS_CLIENT_SECRET`
in Vercel), or a separate one with `M365_CLIENT_ID` / `M365_CLIENT_SECRET` /
`M365_TENANT_ID`.

Go to Entra admin centre → **App registrations** → the app → **API permissions**
→ **Add a permission** → **Microsoft Graph** → **Application permissions**. Add:

| Permission | Why | Can it read content? |
|---|---|---|
| `Reports.Read.All` | all the usage reports | No: counts and dates only |
| `User.Read.All` | accounts, enabled/blocked, licenses (already there for HEAplus) | No |
| `Organization.Read.All` | seats bought and renewal dates | No |
| `Group.Read.All` | names on SharePoint sites | No: not conversations |
| `Sites.Read.All` | URLs on SharePoint sites | It *could* read site files. The site only asks for each group's site name and URL. Skip it to leave site names blank. |
| `MailboxSettings.Read` *(optional)* | tells shared mailboxes apart, when the mailbox report doesn't | No: settings only, not mail |

Then click **Grant admin consent for Sanctuary**.

### 2. Microsoft: stop hiding names in reports

M365 admin centre → **Settings → Org settings → Reports** → untick
**"Display concealed user, group, and site names in all reports"**.

Leave it ticked and every name comes back as a hash, so nothing can be matched
to a person. The page warns about this if it happens.

### 3. Supabase

SQL Editor → paste `supabase/m365.sql` → Run. It's also in `ALL.sql`, and
it's safe to re-run.

### 4. Vercel environment variables

| Variable | |
|---|---|
| `CRON_SECRET` | already set (HEAplus uses it); the scheduled jobs send it |
| `ANTHROPIC_API_KEY` | already set (chat uses it) |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` | already set, or use the `M365_*` trio for a separate app |
| `M365_MODEL` *(optional)* | defaults to `claude-opus-5-5` |

Redeploy after merging.

### 5. First run

Open **Microsoft usage review** and press **Refresh now** (admins only). It
runs the sync and then the AI review, which can take a minute or two. The bar
at the top shows:
- the date of the Microsoft data
- when it was pulled
- the AI review's status
- any warnings, such as a missing permission or a SKU with no price

Until the first sync, every Microsoft page shows the September 29 export,
labelled as such.

## Day to day

- **A license price changes, or a new SKU is bought:** edit `lib/m365-skus.js`.
  The bar at the top lists any license it has no price for.
- **A new invoice arrives:** add it to `invoices` in `microsoft-costs.js`, as before.
- **Someone must never be cut:** add their address to `m365_keep` in Supabase.
- **Approving or declining an AI proposal:** on **Cost cutting**, the same as
  any other recommendation. They're tagged **AI cost review**.

## Data kept

`m365_snapshots` keeps one row per day.
- The full detail (every account, every site) is kept for 14 days.
- After that, only the headline numbers stay, so the **Analytics** trend has a
  row for every month without the database growing.

The detail is only served to people with Cost management access. Unlike the
old `sharepoint-usage.json`, it isn't a public static file.

## Files

| File | |
|---|---|
| `lib/m365-api.js` | the `/api/m365` endpoint the scheduled jobs and the pages call (served by `api/cuts.js` through a rewrite: the Vercel plan allows 12 functions and `api/` has 12) |
| `lib/m365.js` | the Microsoft Graph pull, and turning it into page data |
| `lib/m365-findings.js` | the cost rules and the deduplicated savings |
| `lib/m365-ai.js` | Claude's review, its guard rails, and the approval queue |
| `lib/m365-skus.js` | prices and terms per license |
| `supabase/m365.sql` | snapshots, keep list, AI columns on `cost_recommendations` |
| `tests/m365.test.js` | `npm test`: the rules, the checks on Claude's answer, Graph plumbing against a fake Microsoft |

`tools/scan.py` and `sharepoint-usage.json` still work as a manual fallback
(`SHAREPOINT.md`). The pages only use them when the daily sync has no data.
