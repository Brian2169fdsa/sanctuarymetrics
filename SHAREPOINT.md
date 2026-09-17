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

```powershell
Install-Module Microsoft.Graph -Scope CurrentUser   # large; takes a few minutes
./tools/register-app.ps1 -Tenants @{ "Sanctuary Recovery" = "sanctuary.onmicrosoft.com" } -Enrich
```

It opens a browser to sign you in, creates the app, grants the permissions
above, and writes `config.json` with a client secret in plaintext. **That file
is gitignored — keep it that way.**

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

Per-site fields the page reads: `title`, `team_name`, `url`, `owner`,
`template`, `days_idle`, `last_activity`, `file_count`, `active_files`,
`page_views`, `storage_used`, `storage_quota`, `external_sharing`,
`is_group_site`, `is_channel_site`, `members`, `guests`, `channel_messages`,
`orphaned`, `verdict`, `score`. Missing fields degrade to `—`.

---

## Two limits worth knowing before anyone promises "every channel"

**1. Standard channels have no usage of their own.** Private and shared channels
each get their own SharePoint site, so they show up here individually. Standard
channels are folders inside the team's single site — their usage is inside that
team's row and Microsoft provides no way to separate it. There is no
per-channel usage report in Graph. The page states this in its scope section.

**2. `scan.py --enrich` only resolves team names for *dormant* groups.** It
skips any group active in the last 90 days, and stops after 750 lookups:

```python
if gidle is not None and gidle < STALE_DAYS:
    continue
if resolved > 750:
    break
```

That is correct for its original job (finding dead sites to clean up) but it
means **active teams arrive with no team name attached**. For a usage review of
everything, those two lines need removing or widening — expect roughly one
Graph call per group, so a large tenant will be slower.

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
