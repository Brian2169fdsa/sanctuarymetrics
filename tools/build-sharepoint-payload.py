#!/usr/bin/env python3
"""
build-sharepoint-payload.py
---------------------------
Turns scan.py's per-tenant output into the single file the SharePoint tab
reads: sharepoint-usage.json at the repo root.

    python scan.py --config config.json --enrich --out out/
    python tools/build-sharepoint-payload.py --in out/ --out sharepoint-usage.json

What it does:
  · merges every out/<tenant>.json into one payload
  · strips fields the page never uses, so nothing extra is published
  · redacts owner email addresses BY DEFAULT (see --include-owners)
  · stamps the payload with a generation time

Owner redaction is on by default on purpose. The payload is committed to the
repo and served by Vercel, so anything left in it is readable by anyone who
can reach the site. Owner principal names are real staff email addresses.
Turn redaction off only once you have confirmed the deployment is protected.

This script never talks to Microsoft. It only reshapes files scan.py wrote.
"""

import argparse
import glob
import json
import os
import sys
from datetime import datetime, timezone

# Exactly the fields sharepoint.html reads. Anything else is dropped rather
# than published "just in case".
KEEP = [
    "tenant", "site_id", "url", "title", "owner", "template",
    "days_idle", "last_activity", "file_count", "active_files", "page_views",
    "storage_used", "storage_quota",
    "is_group_site", "is_channel_site", "members", "guests",
    "team_name", "channel_messages", "orphaned", "verdict", "score",
]


def redact_owner(owner):
    """alice.smith@sanctuary.org -> a•••@sanctuary.org — enough to tell rows
    apart and spot orphans, not enough to publish a staff mailing list."""
    owner = (owner or "").strip()
    if not owner:
        return ""
    if "@" not in owner:
        return owner[:1] + "•••"
    local, _, domain = owner.partition("@")
    return (local[:1] or "?") + "•••@" + domain


def clean_site(site, include_owners):
    out = {k: site.get(k) for k in KEEP if k in site}
    if not include_owners:
        out["owner"] = redact_owner(out.get("owner"))
    return out


# Columns in the group, team and per-person reports that name a human. Matched
# on the column name rather than a fixed list, because these reports carry
# different columns per tenant and a hardcoded list silently misses one — which
# is how a staff mailing list ends up in a published file.
IDENTITY = ("user principal name", "owner principal name", "display name",
            "user display name", "owner display name", "recipient")


def is_identity(col):
    c = col.strip().lower()
    return any(k in c for k in IDENTITY)


def clean_rows(rows, include_people):
    """Keep every column — these reports vary per tenant and guessing which
    ones matter is how fields end up silently empty — but redact the ones that
    name a person unless the caller opted in."""
    out = []
    for r in rows:
        rec = {}
        for k, v in r.items():
            if not include_people and is_identity(k):
                rec[k] = redact_owner(v)
            else:
                rec[k] = v
        out.append(rec)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="indir", default="out",
                    help="directory holding scan.py's per-tenant JSON (default: out)")
    ap.add_argument("--out", default="sharepoint-usage.json",
                    help="payload to write (default: sharepoint-usage.json)")
    ap.add_argument("--include-owners", action="store_true",
                    help="publish owner email addresses in full (default: redacted)")
    ap.add_argument("--include-people", action="store_true",
                    help="publish the names and addresses in the group, team and "
                         "per-person reports in full (default: redacted). These "
                         "are named employees and the payload is served as a "
                         "static file — only use this behind a protected "
                         "deployment.")
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.indir, "*.json")))
    paths = [p for p in paths if os.path.basename(p) != os.path.basename(args.out)]
    if not paths:
        sys.exit(f"No JSON files found in {args.indir!r}. Run scan.py first.")

    tenants, skipped = [], []
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                blob = json.load(f)
        except (OSError, ValueError) as e:
            skipped.append(f"{os.path.basename(path)}: {e}")
            continue
        if not isinstance(blob, dict) or "sites" not in blob:
            skipped.append(f"{os.path.basename(path)}: no 'sites' key — not a scan.py output")
            continue
        people = blob.get("people") or {}
        tenants.append({
            "tenant": blob.get("tenant", os.path.splitext(os.path.basename(path))[0]),
            "refresh_date": blob.get("refresh_date", ""),
            "period_days": blob.get("period_days"),
            "concealed": bool(blob.get("concealed")),
            "sites": [clean_site(s, args.include_owners) for s in blob["sites"]],
            "groups": clean_rows(blob.get("groups") or [], args.include_people),
            "teams": clean_rows(blob.get("teams") or [], args.include_people),
            "people": {k: clean_rows(v or [], args.include_people)
                       for k, v in people.items()},
        })

    if not tenants:
        sys.exit("Nothing usable to write.\n  " + "\n  ".join(skipped))

    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "owners_redacted": not args.include_owners,
        "people_redacted": not args.include_people,
        "tenants": tenants,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)

    total = sum(len(t["sites"]) for t in tenants)
    channels = sum(1 for t in tenants for s in t["sites"] if s.get("is_channel_site"))
    ngroups = sum(len(t["groups"]) for t in tenants)
    nteams = sum(len(t["teams"]) for t in tenants)
    npeople = sum(len(v) for t in tenants for v in t["people"].values())
    concealed = [t["tenant"] for t in tenants if t["concealed"]]

    print(f"Wrote {args.out}")
    print(f"  {len(tenants)} tenant(s) · {total} sites · {channels} Teams channel sites")
    print(f"  {ngroups} group rows · {nteams} team rows · {npeople} per-person rows")
    if not npeople:
        print("  (no per-person rows — re-run scan.py with --people-detail for "
              "the Email and Teams user tabs)")
    print(f"  owners: {'REDACTED' if payload['owners_redacted'] else 'PUBLISHED IN FULL'}")
    print(f"  people: {'REDACTED' if payload['people_redacted'] else 'PUBLISHED IN FULL'}")
    for s in skipped:
        print(f"  skipped {s}")
    if concealed:
        print(f"  WARNING: names are concealed in {', '.join(concealed)} — "
              f"turn off report anonymisation in the M365 admin centre and re-pull.")
    if args.include_owners or args.include_people:
        print("  WARNING: staff names and email addresses are in this file and it "
              "gets published as a static file. Confirm the deployment is "
              "protected before committing.")


if __name__ == "__main__":
    main()
