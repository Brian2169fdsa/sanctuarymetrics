# SharePoint / Teams usage — how to connect it

The **SharePoint** tab is live and waiting for data. It reads one static file,
`sharepoint-usage.json`, from the site root. If that file is absent the page
shows the awaiting-data state. Nothing is ever estimated.

Preview the layout without any credentials: **`/sharepoint.html?demo=1`** —
loudly watermarked as sample data, and unreachable unless you type it.

---

## Start here: Microsoft permissions

**Nothing works until an app registration exists with admin consent.** These
are *application* permissions (app-only, client-credentials) — a regular user
account cannot grant them. You need **Global Administrator**, or Application
Administrator + Privileged Role Administrator.

| Permission | Needed for | What it cannot do |
|---|---|---|
| `Reports.Read.All` | the usage numbers themselves | open a file, a page, a message or a mailbox |
| `Sites.Read.All` | site id + URL, to attach Teams activity to the right site | read site content |
| `Group.Read.All` | group/team names and member counts | read group conversations |

The last two are only needed for `--enrich` (team names joined to sites).
Without them you still get every site's usage.

There is also a **tenant setting** to change, which also needs an admin:
M365 admin centre → **Settings → Org settings → Reports** → uncheck
**"Display concealed user, group, and site names in all reports"**. Leave it on
and every site and team name comes back as a hash.

`tools/register-app.ps1` does the app registration for you.

---

## The pipeline

```
tools/register-app.ps1        → config.json           (once per tenant, admin)
tools/scan.py                 → out/<tenant>.json     (Graph reports API)
tools/build-sharepoint-payload.py → sharepoint-usage.json
git commit                    → Vercel redeploys      → the tab renders it
```

All three scripts are in `tools/` in this repo, so a clone has everything.

---

## Step by step

Commands are shown for **PowerShell on macOS** (`pwsh`), since that is what
this project is run from. On Windows PowerShell use `py` in place of `python3`,
and note `&&` only works in PowerShell 7+ — the steps below use separate lines
so they work everywhere.

### 0. Get a clone (once)

The scripts live in the repo, so work from inside it — not from your home
directory.

```powershell
cd ~
git clone https://github.com/Brian2169fdsa/sanctuarymetrics.git
cd sanctuarymetrics
```

Already have a clone? Just `cd` into it and `git pull`.

### 1. Register the app (once per tenant, needs admin)

Only two Graph sub-modules are needed — the full `Microsoft.Graph` meta-module
is ~40 modules and takes far longer:

```powershell
Install-Module Microsoft.Graph.Authentication -Scope CurrentUser
Install-Module Microsoft.Graph.Applications -Scope CurrentUser
```

Then run it with **your own verified tenant domain**:

```powershell
./tools/register-app.ps1 -Tenants @{ "Sanctuary Recovery" = "sanctuaryrecoverycenters.com" } -Enrich
```

Any verified domain in the tenant works — the `.onmicrosoft.com` one is not
required. Find it under M365 admin centre → Settings → Domains. Get this wrong
and you will be sent to sign in to *somebody else's* directory: plausible
domains like `sanctuary.onmicrosoft.com` belong to unrelated companies, and the
error is `Selected user account does not exist in tenant '<someone else>'`.

It opens a browser to sign you in, creates the app, grants the permissions
above, and writes `config.json` with a client secret in plaintext. **That file
is gitignored — keep it that way.**

**Run Graph in its own PowerShell session.** `ExchangeOnlineManagement` bundles
an older `Microsoft.Identity.Client` (MSAL); once that is loaded in a process,
Graph sign-in fails with `Method not found: ...WithLogging(IIdentityLogger,
Boolean)`. Assemblies cannot be unloaded, so the fix is a fresh `pwsh` — never
`Get-Mailbox` and Graph in the same window.

### 2. Turn off name concealment

M365 admin centre → Settings → Org settings → Reports → uncheck *"Display
concealed user, group, and site names in all reports"*. See above.

### 3. Set up Python (once)

macOS has no `python` command — it is `python3`. Check, then install the one
dependency in a virtual environment (newer macOS refuses a bare `pip install`):

```powershell
python3 --version
python3 -m venv .venv
./.venv/bin/python -m pip install requests
```

### 4. Pull

```powershell
./.venv/bin/python tools/scan.py --config config.json --enrich --out out/
```

### 5. Build the payload

```powershell
./.venv/bin/python tools/build-sharepoint-payload.py --in out/ --out sharepoint-usage.json
```

Keeps only the fields the page reads, and **redacts owner email addresses by
default** (`alice@x.org` → `a•••@x.org`). Use `--include-owners` to publish
them in full, once you have confirmed the deployment is protected.

### 6. Publish

```powershell
git add sharepoint-usage.json
git commit -m "SharePoint usage pull"
git push
```

Vercel redeploys and the tab fills in. Repeat steps 4–6 for each new pull.

---

## What the page does with it

- One row per SharePoint site, **including one row per Teams private or shared
  channel**, since each of those has its own site.
- Filters: tenant, site type (Teams team / Teams channel / M365 group /
  SharePoint), verdict, free-text search, and sort.
- Summary tiles: sites, Teams channels, storage, page views, active files,
  sites idle 90d+, sites with no owner.
- `verdict` / `score` are rendered when present. They are `scan.py`'s
  thresholds, not Microsoft's — a recommendation to review, never an action.
  **Nothing on this page changes anything in the tenant.**

### Accepted payload shapes

All three work, so `scan.py` output drops straight in:

```jsonc
{ "tenant": "...", "refresh_date": "...", "period_days": 180, "sites": [ ... ] }
[ { "tenant": "...", "sites": [...] }, { ... } ]
{ "generated": "...", "tenants": [ { "tenant": "...", "sites": [...] } ] }
```

Per-site fields the page renders: `title`, `team_name`, `owner`, `days_idle`,
`members`, `guests`, `file_count`, `active_files`, `page_views`,
`channel_messages`, `storage_used`, `verdict`, plus `url`/`site_id` as the row
tooltip, `is_group_site`/`is_channel_site` for the type, and `orphaned` /
`external_sharing` as row tags. `score` drives the sort.

A count that was never measured reads `—`, never `0` — `members` and
`channel_messages` are null on any site whose group was not resolved, and on
sites that are not group-backed at all.

`storage_quota`, `last_activity`, `template` and `anon_links` are published but
not displayed. `storage_quota` in particular is the tenant's pooled allocation
repeated on every row, not a per-site limit, so a share of it would read `<1%`
on every site.

---

## Two limits worth knowing before anyone promises "every channel"

**1. Standard channels have no usage of their own.** Private and shared channels
each get their own SharePoint site, so they show up here individually. Standard
channels are folders inside the team's single site — their usage is inside that
team's row and Microsoft provides no way to separate it. There is no
per-channel usage report in Graph. The page states this in its scope section.

**2. `--enrich` costs roughly one Graph call per group.** Enrichment is what
attaches the group display name, team name, member and guest counts, and
channel message counts to a site, so by default every group is resolved —
a usage review of everything needs everything.

Two flags tune it. `--dormant-only` resolves only groups idle 90+ days, which
is the right trade when hunting dead sites to clean up rather than reviewing
usage; active teams then arrive with no team name, member count or message
count. `--max-lookups N` caps the calls (default 2000) and warns how many
groups it left unresolved rather than truncating silently.

---

## Privacy

What is collected: names, owners, dates, counts, sizes, sharing flags.

What is **never** collected, because the permission cannot: file contents, page
contents, chat or channel message text, mailboxes. `channel_messages` is a
count produced by Microsoft's own activity report — the number of messages,
never a message.

**Before committing a real pull, confirm Vercel Deployment Protection covers
Production, not just previews.** `sharepoint-usage.json` is a complete
inventory of every site, team and channel with owners and sizes. It is served
as a static file at `/sharepoint-usage.json` to anyone who can reach the site.
Owner redaction is on by default for exactly this reason; it is a mitigation,
not a substitute for protecting the deployment.

`config.json` (client secrets) and `out/` (unredacted pulls) are both
gitignored. Keep them out of the repo.
