# SCI fundraising automations

The n8n workflows behind the **SCI Fundraising** page (`fundraising.html`), plus how to set them up and test them.

```
Donorbox (read-only API + donation webhook)
   │
   ▼
n8n ── f3 metrics sync ──► data/fundraising-metrics.json (GitHub commit → Vercel redeploy)
   │                         aggregates only, read by the page
   ├── f1/f2, f4–f8 ───────► SharePoint "SCI Donors" list (the only place donor details land),
   │                         Teams, Planner tasks, donor email
   ├── f9, f10 ────────────► Teams reminders and the weekly digest
   └── every workflow ─────► /api/fundraising-state?action=run (run reports for the Automations tab)

fundraising.html ──► /api/fundraising-state  (checklist, decisions, post statuses; Supabase)
```

## What's in this folder

| File | Automations | Trigger |
|---|---|---|
| `f3-metrics-sync.json` | f3 Metrics sync | Every 15 minutes, and when f1 calls it |
| `f1-f2-new-and-major-gift.json` | f1 New gift, f2 Major gift | Donorbox donation webhook |
| `f4-f6-plan-changes.json` | f4 New member, f5 Failed payment, f6 Cancelled plan | Hourly, comparing plan statuses with the last run |
| `f7-f8-donor-journey-and-lapsed.json` | f7 Donor journey, f8 Lapsed donor | Daily 9:12 a.m. |
| `f9-social-queue.json` | f9 Social queue | Daily 7 a.m. |
| `f10-weekly-digest.json` | f10 Weekly digest | Mondays 8 a.m. |
| `f0-error-reporter.json` | Marks a failed automation red on the page and alerts Teams | Error workflow for all of the above |
| `campaign-map.json` | Donorbox campaign id → plan campaign id | Read by f3 |
| `src/` | The Code-node sources the JSON is built from | `npm run n8n:build` |

All schedules run in **America/Phoenix** (set in each workflow's settings; Phoenix has no daylight saving time).

Don't edit Code nodes in the exported JSON by hand. Edit `src/*.js`, run `npm run n8n:build`, and re-import the workflow that changed.

## Hard rules these workflows keep

- **Donorbox is read-only.** Every Donorbox call is a `GET`. Campaigns are built by hand in Donorbox from the build sheet.
- **No donor data on the dashboard.** f3 publishes totals, counts and percentages only. Before committing, it refuses to publish (and errors) if the file contains an email address or any donor's full name. Donor names, emails and gifts go only to the private SharePoint list in SCI's own Microsoft 365. Teams messages show the first name and last initial.
- **No secrets in the repo.** Every key is an n8n credential, referenced by name. The `Config` node in each workflow holds non-secret settings only.
- **Nothing posts to social media on its own.** f9 sends a post to a scheduler only when all of these are true: the post is `approved`, auto-posting is switched on (an admin does this on the page), and `schedulerConnected` is `true` in Config. Otherwise it posts a Teams reminder with the copy for a person to publish.
- **Held and unreleased posts never go out.** f9 skips every `held` post (tax credit), and every `needsRelease` post without a recorded release. The API refuses to approve those as well.
- **Donor email is safe by default.** While `emailsApproved` is `false` in Config, every donor email is sent to the SCI sending mailbox instead, with the subject marked `[REVIEW, would go to a donor]`. Every email carries an unsubscribe link and SCI's street address, and unsubscribes are honored in every sequence.

## Setup order

### 1. Supabase (the page's shared state)

Run `supabase/fundraising.sql` in Supabase → SQL Editor (it's also in `supabase/ALL.sql`). It adds one table, `fundraising_state`, with row level security on and no policies, like the other tables.

### 2. Vercel environment variable

| Variable | Value |
|---|---|
| `FUNDRAISING_SYNC_SECRET` | A long random string (e.g. `openssl rand -hex 32`). n8n sends it as the `X-Fundraising-Sync-Secret` header. With it, n8n can read post statuses, record runs, and mark an *approved* post scheduled or posted. It can't approve anything. |

Everything else the page needs (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) is already set. Redeploy after adding the variable.

### 3. Donorbox

1. Add the **Zapier and API** add-on ($17/month). The API doesn't work without it.
2. Donorbox → Account → API & Zapier Integration: copy the API key.
3. Webhooks come later (step 7).

### 4. n8n credentials

Create these in n8n → Credentials. The names must match exactly; the workflows refer to them by name, and n8n asks you to pick each one the first time you open an imported node.

| Credential name | n8n type | What goes in it |
|---|---|---|
| `Donorbox API` | Basic Auth | User: the Donorbox account email (`DONORBOX_EMAIL`). Password: the API key (`DONORBOX_API_KEY`). |
| `SCI Microsoft Graph` | OAuth2 API | Microsoft identity platform app in **SCI's own tenant**. Auth URL `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize`, token URL `.../oauth2/v2.0/token`. Scopes: `offline_access Sites.ReadWrite.All ChannelMessage.Send Tasks.ReadWrite Mail.Send Mail.Send.Shared Mail.Read.Shared User.Read`. Sign in as the account that owns the monitored sending mailbox (or has Send As on it). |
| `SCI GitHub (contents write)` | GitHub API | A **fine-grained** personal access token for this repository only, permission *Contents: Read and write*, nothing else (`GITHUB_TOKEN`). |
| `SCI Fundraising sync secret` | Header Auth | Name `X-Fundraising-Sync-Secret`, value = `FUNDRAISING_SYNC_SECRET` from step 2. |
| `SCI social scheduler` | Header Auth | Only if a scheduling tool is connected later (see f9). |

`DONORBOX_WEBHOOK_SECRET` is not needed: see "How the webhook is secured" below.

### 5. Microsoft 365 setup (SCI's tenant)

1. **SharePoint list** "SCI Donors" on SCI's site, with these columns (internal names exactly as written):
   `Title` (default), `DonorboxDonorId` (text, **indexed**), `FirstName`, `LastName`, `Email` (text), `FirstGiftDate`, `LastGiftDate`, `MemberSince`, `CancelledOn`, `JourneyAt` (date only), `LastGiftUsd`, `TotalGivenUsd`, `GiftCount` (number), `LastCampaign`, `Tier`, `Segment`, `JourneyStep`, `JourneyRenewalFor` (text), `Recurring`, `MajorGift`, `PaymentIssue`, `Unsubscribed` (yes/no).
   Limit access to the people who need it. Compliance signs off before any contacts are imported (decision d8: no client or patient lists).
2. A Teams channel for fundraising alerts, a Planner plan and bucket for follow-up tasks, and the monitored mailbox that sends donor email.
3. Find the IDs with Graph Explorer:
   - site id: `GET /sites/{hostname}:/sites/{site-name}`
   - list id: `GET /sites/{site-id}/lists?$filter=displayName eq 'SCI Donors'`
   - team and channel: `GET /me/joinedTeams`, then `GET /teams/{id}/channels`
   - plan and bucket: `GET /groups/{team-id}/planner/plans`, then `GET /planner/plans/{id}/buckets`
   - Joey's user id: `GET /users/{joey's address}`

### 6. Import the workflows

Import in this order (n8n → Workflows → Import from file):

1. `f0-error-reporter.json`
2. `f3-metrics-sync.json`
3. `f1-f2-new-and-major-gift.json`: open **Update metrics (f3)** and pick *SCI f3 · Metrics sync*.
4. `f4-f6-plan-changes.json`, `f7-f8-donor-journey-and-lapsed.json`, `f9-social-queue.json`, `f10-weekly-digest.json`

In each workflow:

- Fill in the **Config** node: Microsoft IDs from step 5, `senderMailbox`, `digestRecipients`. Leave `emailsApproved: false` and `schedulerConnected: false` for now.
- Settings → **Error workflow** → *SCI f0 · Error reporter*.
- Select each credential when n8n asks.

Activate f3 first and check the Automations tab on the page shows its run.

### 7. Donorbox webhook (f1 and f2)

1. In f1-f2, open **Donorbox webhook** and change the path from `sci-donorbox-donation-CHANGE-ME` to a long random string. Activate the workflow and copy the **production** URL.
2. In Donorbox, set up a custom webhook for new donations pointing at that URL (Donorbox help: "Custom Webhooks Configuration in Donorbox").
3. If the webhook can't be set up, f3's 15-minute sync still keeps the page current. Only the instant Teams alert and the major-gift task depend on the webhook.

**How the webhook is secured.** Nothing in the webhook body is trusted. f1 takes only the donation ids from it, skips ids it has already handled, and reads each donation back from the read-only Donorbox API before doing anything. A forged call can at most make n8n look up a real donation once. I could not confirm Donorbox's webhook signature format (the help article was not reachable when this was built). If Donorbox does sign requests, add the check to `src/f1-ids.js` as an extra layer.

### 8. Campaign mapping table

`campaign-map.json` maps Donorbox campaign ids to the plan's campaign ids, so live totals land on the right card:

```json
{ "map": { "123456": "safety-net", "123457": "the-sanctuary", "123458": "giving-tuesday-2026" } }
```

Get the ids from Donorbox (the number in a campaign's edit URL) or from f3's **GET campaigns** output. Campaigns not in the map are matched by name (for example "Rides and Relief" → `rides-and-relief-2027`). The map wins when both apply. Year-end 2026 is built from the Giving Tuesday campaign's settings but is a separate Donorbox page, so give it its own entry. Commit changes to `main`; f3 reads the file on its next run.

## Testing each flow

| Flow | Test | Expected |
|---|---|---|
| f3 | Run manually. | `data/fundraising-metrics.json` is committed with `generatedAt` set. Totals match the Donorbox dashboard (raised = sum of each campaign's *total raised*). Run it again with no new gifts: no new commit. Search the committed file for `@` and for a donor's name: nothing. |
| f1 | Make a **$1 one-time gift** on Campaign 1. | Within a minute: a Teams message with the amount, campaign, "one-time" and the first name plus last initial only. A new row in the SharePoint list. On the next sync, the Overview KPIs move. **Refund the test gift afterwards.** |
| f2 | Pin a $250 donation on **GET donation** in n8n and execute the workflow. | A Planner task for Joey, due in 48 hours. |
| f4–f6 | The first run only records plan statuses. Then make a $10 monthly gift, and cancel it in the donor portal. | Welcome-kit task, tier set in the list, a `[REVIEW]` welcome email in the sending mailbox. After cancelling: exit email and a personal-note task. For f5, pin a plan with `status: failed` on **GET plans**. |
| f7–f8 | Set a test row's `FirstGiftDate` to yesterday and `JourneyStep` to `new`. Send yourself an email with subject "unsubscribe" from a test address that is in the list. | A `[REVIEW]` thank-you, `JourneyStep` becomes `thanked`. The test address gets `Unsubscribed = yes` and no further email. |
| f9 | Approve a post dated today on the page; leave another due tomorrow in draft. | One Teams message listing the approved post's copy, channels and format, plus an approval reminder for the draft. Held tax credit posts never appear. |
| f10 | Run manually. | Teams post and email with totals, members, posts published vs planned, and automation errors. |
| f0 | Break a credential on purpose and run f9. | The f9 card on the Automations tab turns red with the error message, and Teams gets an alert. |

Before switching `emailsApproved` to `true`, have the email templates in `src/f4-plans.js` and `src/f7-journey.js` reviewed (they are marked `TEMPLATE` and contain `[REVIEW]` placeholders). Then rebuild and re-import.

## Things to know

- **Commits redeploy the site.** f3 commits to `main` only when a value changed, so Vercel redeploys at most every 15 minutes, and only while gifts are coming in. If that's too often, point `githubBranch` at a branch Vercel doesn't deploy and merge it on a schedule instead.
- **Fee cover rate** isn't in Donorbox's documented API fields. f3 fills it in if a fee-covered field appears in the data; until then the page shows "—".
- **Plan statuses.** Donorbox documents `active` for plans. f4–f6 assume a failed card shows as `failed` and a cancellation as `cancelled`. Check one real plan in each state and adjust `src/f4-plans.js` if the values differ.
- **Donor portal link** (`donorPortalUrl` in Config) needs checking against Donorbox's current donor login page.
- The **"Members lost" and "Failed payments recovered"** counts start from the first f3 run, because they come from status changes between runs.
