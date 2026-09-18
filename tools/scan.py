#!/usr/bin/env python3
"""
M365 Sprawl Scanner
-------------------
Pulls SharePoint site usage + Microsoft 365 Groups activity + Teams activity from
Microsoft Graph, joins them, scores every site/team, and writes:

    out/<tenant>.json      raw + scored records
    out/dashboard.html     self-contained dashboard (all tenants)

Usage:
    python scan.py --config config.json
    python scan.py --demo                # fake data, no credentials needed

Graph app permissions:

    --reports-only  (default, recommended)
        Reports.Read.All        aggregate counts and dates only.
                                Cannot read a file, a message, or a mailbox.

    full mode (--enrich)
        Reports.Read.All
        Sites.Read.All          site metadata (id + webUrl) so Teams activity
        Group.Read.All          can be joined to the right SharePoint site.
                                Still no content access.

IMPORTANT: In the M365 admin center go to
  Settings > Org settings > Reports > uncheck
  "Display concealed user, group, and site names in all reports"
Otherwise every Site URL and Team Name comes back as a hash and this is useless.
"""

import argparse
import csv
import io
import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone

import requests

GRAPH = "https://graph.microsoft.com"
PERIOD = "D180"          # D7 | D30 | D90 | D180
TIMEOUT = 120

# ---------------------------------------------------------------- thresholds
# Tune these. They are the entire policy of the tool.
DEAD_DAYS = 180          # no activity at all in the window
STALE_DAYS = 90          # activity, but old
SMALL_BYTES = 100 * 1024**2   # under this = cheap to just delete
BIG_BYTES = 1024**3           # over this = archive, don't delete
LOW_FILES = 10
LOW_VIEWS = 5

ONEDRIVE_TEMPLATES = {"SPSPERS", "PERSONAL"}
SYSTEM_TEMPLATES = {"APPCATALOG", "SRCHCEN", "POINTPUBLISHINGHUB",
                    "POINTPUBLISHINGTOPIC", "SPSMSITEHOST", "EHS", "TENANTADMIN"}


# =========================================================== graph plumbing
def get_token(tenant_id, client_id, client_secret):
    r = requests.post(
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": f"{GRAPH}/.default",
            "grant_type": "client_credentials",
        },
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def get_report_csv(token, func, period=PERIOD, version="v1.0"):
    """Report endpoints 302 to a CSV download. requests follows it for us."""
    url = f"{GRAPH}/{version}/reports/{func}(period='{period}')"
    r = requests.get(url, headers={"Authorization": f"Bearer {token}"},
                     timeout=TIMEOUT)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    text = r.content.decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def graph_paged(token, path):
    """GET a collection, following @odata.nextLink."""
    url = f"{GRAPH}/v1.0{path}"
    headers = {"Authorization": f"Bearer {token}", "ConsistencyLevel": "eventual"}
    out = []
    while url:
        r = requests.get(url, headers=headers, timeout=TIMEOUT)
        if r.status_code >= 400:
            break
        body = r.json()
        out.extend(body.get("value", []))
        url = body.get("@odata.nextLink")
    return out


def graph_get(token, path):
    r = requests.get(f"{GRAPH}/v1.0{path}",
                     headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT)
    return r.json() if r.status_code < 400 else None


# ============================================================== helpers
def as_int(v, default=0):
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def days_since(datestr, refresh_date):
    """Report dates are YYYY-MM-DD. Blank = no activity in the whole window."""
    if not datestr or not str(datestr).strip():
        return None
    try:
        d = datetime.strptime(str(datestr).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None
    return max((refresh_date - d).days, 0)


def human_bytes(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:,.1f} {unit}" if unit not in ("B", "KB") else f"{n:,.0f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def looks_concealed(value):
    """Concealed report names are long hex-ish strings with no dots/slashes."""
    v = str(value or "")
    return len(v) > 40 and "/" not in v and "." not in v and " " not in v


# ============================================================== scoring
def score_site(rec):
    """
    Returns (verdict, score 0-100, reasons[]).
    Score = how confident we are this should go. 100 = delete it today.
    """
    reasons = []
    score = 0
    idle = rec["days_idle"]          # None == never active in window
    storage = rec["storage_used"]
    files = rec["file_count"]
    views = rec["page_views"]
    active_files = rec["active_files"]

    # --- inactivity is the main driver
    if idle is None:
        score += 55
        reasons.append(f"No recorded activity in {PERIOD[1:]} days")
    elif idle >= DEAD_DAYS:
        score += 55
        reasons.append(f"Last activity {idle} days ago")
    elif idle >= STALE_DAYS:
        score += 30
        reasons.append(f"Last activity {idle} days ago")
    elif idle >= 30:
        score += 10
        reasons.append(f"Quiet for {idle} days")

    # --- emptiness
    if files <= 1:
        score += 20
        reasons.append("Essentially empty (no files)")
    elif files <= LOW_FILES:
        score += 12
        reasons.append(f"Only {files} files")

    if views <= LOW_VIEWS and active_files == 0:
        score += 10
        reasons.append("Nobody opened a page or touched a file")

    # --- governance flags
    if not rec["owner"]:
        score += 12
        rec["orphaned"] = True
        reasons.append("No owner on record — orphaned")

    if rec.get("members") == 0 and rec["is_group_site"]:
        score += 8
        reasons.append("Group has zero members")

    # --- brakes
    if storage >= BIG_BYTES:
        score -= 10
        reasons.append(f"Holds {human_bytes(storage)} — archive rather than delete")
    if rec.get("external_sharing"):
        reasons.append("Shared externally — review before any action")
    if rec.get("guests", 0) > 0:
        reasons.append(f"{rec['guests']} guest(s) still have access")

    score = max(0, min(100, score))

    # --- verdict
    dead = idle is None or idle >= DEAD_DAYS
    if not dead and score < 40:
        verdict = "Keep"
    elif dead and storage < SMALL_BYTES and files <= LOW_FILES:
        verdict = "Delete"
    elif dead and storage >= BIG_BYTES:
        verdict = "Archive"
    elif dead:
        verdict = "Delete" if score >= 70 else "Archive"
    else:
        verdict = "Review"

    if rec.get("orphaned") and verdict == "Keep":
        verdict = "Review"

    return verdict, score, reasons


# ============================================================== collection
def scan_tenant(tenant, enrich=False, dormant_only=False, max_lookups=2000):
    name = tenant["name"]
    print(f"[{name}] authenticating…", file=sys.stderr)
    token = get_token(tenant["tenant_id"], tenant["client_id"], tenant["client_secret"])

    print(f"[{name}] pulling SharePoint site usage…", file=sys.stderr)
    sites = get_report_csv(token, "getSharePointSiteUsageDetail")

    print(f"[{name}] pulling M365 Groups activity…", file=sys.stderr)
    groups = get_report_csv(token, "getOffice365GroupsActivityDetail")

    print(f"[{name}] pulling Teams activity…", file=sys.stderr)
    teams = get_report_csv(token, "getTeamsTeamActivityDetail")

    refresh = datetime.now(timezone.utc).date()
    for row in sites:
        rd = row.get("Report Refresh Date")
        if rd:
            try:
                refresh = datetime.strptime(rd[:10], "%Y-%m-%d").date()
                break
            except ValueError:
                pass

    # index the group + teams reports so we can enrich sites
    by_group = {}
    for g in groups:
        by_group[g.get("Group Id", "")] = g
    teams_by_id = {t.get("Team Id", ""): t for t in teams}

    concealed = False
    records = []

    for row in sites:
        template = (row.get("Root Web Template") or "").upper().replace(" ", "")
        if template in ONEDRIVE_TEMPLATES or "PERSON" in template:
            continue
        if template in SYSTEM_TEMPLATES:
            continue
        if str(row.get("Is Deleted", "")).lower() == "true":
            continue

        url = row.get("Site URL") or ""
        if looks_concealed(url) or (not url and row.get("Site Id")):
            concealed = concealed or looks_concealed(url)

        rec = {
            "tenant": name,
            "site_id": row.get("Site Id", ""),
            "url": url,
            "title": (url.rstrip("/").split("/")[-1] or url) if url else row.get("Site Id", "")[:8],
            "owner": row.get("Owner Principal Name") or row.get("Owner Display Name") or "",
            "template": row.get("Root Web Template", ""),
            "days_idle": days_since(row.get("Last Activity Date"), refresh),
            "last_activity": row.get("Last Activity Date") or "",
            "file_count": as_int(row.get("File Count")),
            "active_files": as_int(row.get("Active File Count")),
            "page_views": as_int(row.get("Page View Count")),
            "storage_used": as_int(row.get("Storage Used (Byte)")),
            "storage_quota": as_int(row.get("Storage Allocated (Byte)")),
            "external_sharing": str(row.get("External Sharing", "")).lower() == "true",
            "anon_links": as_int(row.get("Anonymous Link Count")),
            "is_group_site": template in ("GROUP", "TEAMCHANNEL"),
            "is_channel_site": template == "TEAMCHANNEL",
            "members": None,
            "guests": 0,
            "team_name": "",
            "channel_messages": None,
            "orphaned": False,
        }
        records.append(rec)

    # ---- resolve group -> site so Teams signal lands on the right row
    site_by_id = {r["site_id"]: r for r in records if r["site_id"]}
    resolved = 0
    for gid, g in (by_group.items() if enrich else []):
        if not gid:
            continue
        # Enrichment is what attaches the group display name, team name, member
        # and guest counts, and channel message counts to a site. Skipping a
        # group means that row arrives with none of them — so by default every
        # group is resolved. --dormant-only restores the original cleanup-hunt
        # behaviour of spending calls only on groups that look dead.
        if dormant_only:
            gidle = days_since(g.get("Last Activity Date"), refresh)
            if gidle is not None and gidle < STALE_DAYS:
                continue
        if resolved >= max_lookups:
            print(f"[{name}] WARNING: stopped enriching at {max_lookups} group "
                  f"lookups; {len(by_group) - resolved} group(s) left unresolved. "
                  f"Raise --max-lookups to cover them.", file=sys.stderr)
            break
        site = graph_get(token, f"/groups/{gid}/sites/root?$select=id,webUrl")
        resolved += 1
        if not site or "id" not in site:
            continue
        sid = site["id"].split(",")[1] if "," in site["id"] else site["id"]
        target = site_by_id.get(sid) or next(
            (r for r in records if r["site_id"] and r["site_id"] in site["id"]), None)
        if not target:
            continue
        target["members"] = as_int(g.get("Member Count"))
        target["guests"] = as_int(g.get("External Member Count"))
        target["group_id"] = gid
        target["title"] = g.get("Group Display Name") or target["title"]
        t = teams_by_id.get(gid)
        if t:
            target["team_name"] = t.get("Team Name", "")
            target["channel_messages"] = as_int(t.get("Channel Messages"))
            target["guests"] = max(target["guests"], as_int(t.get("Guests")))
            tidle = days_since(t.get("Last Activity Date"), refresh)
            if tidle is not None and (target["days_idle"] is None or tidle < target["days_idle"]):
                target["days_idle"] = tidle

    for rec in records:
        verdict, score, reasons = score_site(rec)
        rec["verdict"] = verdict
        rec["score"] = score
        rec["reasons"] = reasons

    if concealed:
        print(f"[{name}] WARNING: site names are concealed. Turn off "
              f"'Display concealed user, group, and site names in all reports' "
              f"in M365 admin center > Settings > Org settings > Reports.",
              file=sys.stderr)

    return {
        "tenant": name,
        "refresh_date": refresh.isoformat(),
        "period_days": int(PERIOD[1:]),
        "concealed": concealed,
        "sites": records,
    }


# ============================================================== demo data
def demo_tenant(name, n=90, seed=7):
    rnd = random.Random(f"{name}{seed}")
    refresh = datetime.now(timezone.utc).date() - timedelta(days=2)
    words = ["intake", "clinical", "billing", "hr-archive", "marketing", "utilization",
             "project-atlas", "compliance", "residential", "iop-notes", "vendor-docs",
             "board", "training", "credentialing", "legacy-forms", "outreach", "qa",
             "detox-team", "records-2019", "facilities", "onboarding", "grants"]
    records = []
    for i in range(n):
        slug = f"{rnd.choice(words)}-{rnd.randint(1, 99)}"
        dead = rnd.random() < 0.42
        idle = None if (dead and rnd.random() < 0.5) else rnd.randint(
            181 if dead else 0, 400 if dead else 120)
        files = rnd.choice([0, 1, 3, 8, 40, 300, 2200])
        storage = int(files * rnd.uniform(2e5, 9e6))
        rec = {
            "tenant": name,
            "site_id": f"{i:08x}",
            "url": f"https://contoso.sharepoint.com/sites/{slug}",
            "title": slug,
            "owner": "" if rnd.random() < 0.18 else f"{rnd.choice(words)}@contoso.com",
            "template": rnd.choice(["GROUP", "GROUP", "STS", "SITEPAGEPUBLISHING"]),
            "days_idle": idle,
            "last_activity": "" if idle is None else (refresh - timedelta(days=idle)).isoformat(),
            "file_count": files,
            "active_files": 0 if dead else rnd.randint(0, 40),
            "page_views": 0 if dead else rnd.randint(0, 300),
            "storage_used": storage,
            "storage_quota": 25 * 1024**4,
            "external_sharing": rnd.random() < 0.25,
            "anon_links": rnd.choice([0, 0, 0, 2, 9]),
            "is_group_site": True,
            "is_channel_site": False,
            "members": rnd.choice([0, 2, 5, 14, 31]),
            "guests": rnd.choice([0, 0, 0, 1, 4]),
            "team_name": slug,
            "channel_messages": 0 if dead else rnd.randint(0, 900),
            "orphaned": False,
        }
        v, s, r = score_site(rec)
        rec.update(verdict=v, score=s, reasons=r)
        records.append(rec)
    return {"tenant": name, "refresh_date": refresh.isoformat(),
            "period_days": int(PERIOD[1:]), "concealed": False, "sites": records}


# ============================================================== main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--out", default="out")
    ap.add_argument("--demo", action="store_true", help="generate sample data")
    ap.add_argument("--enrich", action="store_true",
                    help="join Teams activity to sites (needs Sites.Read.All + Group.Read.All)")
    ap.add_argument("--dormant-only", action="store_true",
                    help="with --enrich, resolve only groups idle %d+ days. Faster, but "
                         "active teams then arrive with no team name, member count or "
                         "message count." % STALE_DAYS)
    ap.add_argument("--max-lookups", type=int, default=2000, metavar="N",
                    help="with --enrich, cap group lookups at N (default 2000). "
                         "Roughly one Graph call each.")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    if args.demo:
        results = [demo_tenant("Cholla Behavioral Health"),
                   demo_tenant("Sanctuary Recovery", n=55, seed=3)]
    else:
        with open(args.config) as f:
            cfg = json.load(f)
        results = []
        for t in cfg["tenants"]:
            try:
                results.append(scan_tenant(t, enrich=args.enrich,
                                           dormant_only=args.dormant_only,
                                           max_lookups=args.max_lookups))
            except Exception as e:                      # keep going across tenants
                print(f"[{t['name']}] FAILED: {e}", file=sys.stderr)

    for r in results:
        with open(os.path.join(args.out, f"{r['tenant'].replace(' ', '_')}.json"), "w") as f:
            json.dump(r, f, indent=2)

    # The standalone dashboard is optional. Its template is not part of this
    # repo — the report site renders the same data instead — so a missing
    # template must not lose a pull that already succeeded.
    here = os.path.dirname(os.path.abspath(__file__))
    path = None
    try:
        with open(os.path.join(here, "dashboard_template.html")) as f:
            tpl = f.read()
        html = tpl.replace("/*__DATA__*/null", json.dumps(results))
        path = os.path.join(args.out, "dashboard.html")
        with open(path, "w") as f:
            f.write(html)
    except FileNotFoundError:
        pass

    total = sum(len(r["sites"]) for r in results)
    kill = sum(1 for r in results for s in r["sites"] if s["verdict"] in ("Delete", "Archive"))
    freed = sum(s["storage_used"] for r in results for s in r["sites"]
                if s["verdict"] in ("Delete", "Archive"))
    print(f"\n{total} sites scanned · {kill} flagged · {human_bytes(freed)} reclaimable")
    if path:
        print(f"Dashboard: {path}")
    print(f"Wrote {len(results)} tenant file(s) to {args.out}/")
    print(f"Next: python3 tools/build-sharepoint-payload.py --in {args.out}/ --out sharepoint-usage.json")


if __name__ == "__main__":
    main()
