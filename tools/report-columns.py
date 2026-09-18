#!/usr/bin/env python3
"""
report-columns.py
-----------------
Prints the column names Microsoft actually returns for each usage report, and
how many rows have a value in each one. No site data is printed — only column
names and counts — so the output is safe to paste into a chat or a ticket.

    python3 tools/report-columns.py --config config.json

Use it when a field on the SharePoint tab is blank for every row. A column that
reports "0 / N non-empty" is either named differently in your tenant than
scan.py expects, or genuinely empty. A column scan.py reads that does not
appear in the list at all is a name mismatch — the fix is to read the real one.
"""

import argparse
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan import get_token, get_report_csv  # noqa: E402

# Same rule the payload builder redacts by, so this listing shows which columns
# would be masked in a published pull.
IDENTITY = ("user principal name", "owner principal name", "display name",
            "user display name", "owner display name", "recipient")


def is_identity(col):
    c = col.strip().lower()
    return any(k in c for k in IDENTITY)

# What scan.py reads out of each report, so a mismatch is obvious at a glance.
EXPECTED = {
    "getSharePointSiteUsageDetail": [
        "Site Id", "Site URL", "Owner Principal Name", "Owner Display Name",
        "Root Web Template", "Last Activity Date", "File Count",
        "Active File Count", "Page View Count", "Storage Used (Byte)",
        "Storage Allocated (Byte)", "External Sharing", "Anonymous Link Count",
        "Is Deleted",
    ],
    "getOffice365GroupsActivityDetail": [
        "Group Id", "Group Display Name", "Last Activity Date",
        "Member Count", "External Member Count",
    ],
    "getTeamsTeamActivityDetail": [
        "Team Id", "Team Name", "Last Activity Date", "Channel Messages",
        "Guests",
    ],
    # The per-person reports. scan.py --people-detail keeps every column rather
    # than a chosen few, so nothing here is "expected" — the point of listing
    # them is to see what each tenant actually returns before anything is built
    # on top of it. A workload the tenant never enabled returns no rows.
    "getMailboxUsageDetail": [],
    "getEmailActivityUserDetail": [],
    "getTeamsUserActivityDetail": [],
}

# Reports whose columns scan.py keeps wholesale — the "(scan.py does not read
# this)" note would be on every line and would mean nothing.
KEEPS_EVERYTHING = {
    "getMailboxUsageDetail",
    "getEmailActivityUserDetail",
    "getTeamsUserActivityDetail",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    args = ap.parse_args()

    with open(args.config) as f:
        cfg = json.load(f)

    for t in cfg["tenants"]:
        print(f"\n=== {t['name']} ===")
        token = get_token(t["tenant_id"], t["client_id"], t["client_secret"])
        for func, expected in EXPECTED.items():
            try:
                rows = get_report_csv(token, func)
            except Exception as e:
                print(f"\n{func}: FAILED — {e}")
                continue
            if not rows:
                print(f"\n{func}: no rows returned")
                continue
            cols = list(rows[0].keys())
            whole = func in KEEPS_EVERYTHING
            note = " — every column kept" if whole else ""
            print(f"\n{func} — {len(rows)} rows, {len(cols)} columns{note}")
            for c in cols:
                filled = sum(1 for r in rows if (r.get(c) or "").strip())
                flag = "" if (whole or c in expected) else "   (scan.py does not read this)"
                identity = "   [redacted unless --include-people]" if (
                    whole and is_identity(c)) else ""
                print(f"  {filled:>5} / {len(rows):<5} {c}{flag}{identity}")
            missing = [] if whole else [c for c in expected if c not in cols]
            if missing:
                print("  MISSING — scan.py reads these but the report has no "
                      "such column:")
                for c in missing:
                    print(f"    {c}")


if __name__ == "__main__":
    main()
