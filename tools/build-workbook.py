"""Build a six-sheet Excel workbook from sharepoint-usage.json.

One tab per dataset (sites, teams, groups, mailboxes, email activity) plus a
Summary whose totals are live formulas over those tabs. Reads only the payload
the site already publishes, so it needs no Microsoft credentials.

    python3 tools/build-workbook.py

The window is whatever scan.py pulled -- 180 days is the Graph maximum.
"""
import json, datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

SRC = "sharepoint-usage.json"
OUT = "M365-usage-export.xlsx"

d = json.load(open(SRC))
t = d["tenants"][0]
sites, groups, teams = t["sites"], t["groups"], t["teams"]
mailboxes = t["people"]["mailboxes"]
email = t["people"]["email_activity"]
teams_users = t["people"]["teams_users"]

FONT = "Arial"
HDR_FILL = PatternFill("solid", fgColor="1F3864")
HDR_FONT = Font(name=FONT, bold=True, color="FFFFFF", size=10)
BODY = Font(name=FONT, size=10)
TITLE = Font(name=FONT, bold=True, size=14, color="1F3864")
NOTE = Font(name=FONT, size=9, italic=True, color="666666")

wb = Workbook()

def sheet(name, headers, rows, widths=None, numfmts=None):
    ws = wb.create_sheet(name)
    for c, h in enumerate(headers, 1):
        cell = ws.cell(1, c, h)
        cell.font = HDR_FONT; cell.fill = HDR_FILL
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    for r, row in enumerate(rows, 2):
        for c, v in enumerate(row, 1):
            cell = ws.cell(r, c, v)
            cell.font = BODY
            if numfmts and numfmts.get(c):
                cell.number_format = numfmts[c]
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows)+1}"
    for c in range(1, len(headers) + 1):
        ws.column_dimensions[get_column_letter(c)].width = (widths or {}).get(c, 16)
    ws.row_dimensions[1].height = 30
    return ws

# ---------- SharePoint sites ----------
SITE_COLS = [
    ("Site / Channel", "title", 34), ("Team name", "team_name", 26),
    ("URL", "url", 46), ("Type", None, 16), ("Owner", "owner", 26),
    ("Days idle", "days_idle", 10), ("Last activity", "last_activity", 13),
    ("Files", "file_count", 10), ("Active files (180d)", "active_files", 13),
    ("Page views (180d)", "page_views", 13), ("Storage (GB)", None, 12),
    ("Members", "members", 10), ("Guests", "guests", 9),
    ("Channel messages (180d)", "channel_messages", 14),
    ("Orphaned", "orphaned", 11), ("Verdict", "verdict", 22),
]
def site_type(s):
    if s.get("is_channel_site"): return "Teams channel"
    if s.get("is_group_site"):   return "Teams / M365 group"
    return "SharePoint site"

srows = []
for s in sorted(sites, key=lambda r: -(r.get("page_views") or 0)):
    row = []
    for label, key, _ in SITE_COLS:
        if label == "Type": row.append(site_type(s))
        elif label == "Storage (GB)":
            b = s.get("storage_used")
            row.append(round(b / 1e9, 2) if b else None)
        elif key == "orphaned": row.append("Yes" if s.get("orphaned") else "")
        else: row.append(s.get(key))
    srows.append(row)

sheet("SharePoint Sites", [c[0] for c in SITE_COLS], srows,
      widths={i: c[2] for i, c in enumerate(SITE_COLS, 1)},
      numfmts={8: "#,##0", 9: "#,##0", 10: "#,##0", 11: "#,##0.00",
               12: "#,##0", 13: "#,##0", 14: "#,##0"})

# ---------- Teams ----------
TEAM_COLS = ["Team Name", "Team Type", "Last Activity Date", "Active Users",
             "Active Channels", "Channel Messages", "Post Messages",
             "Reply Messages", "Reactions", "Urgent Messages", "Mentions",
             "Meetings Organized", "Guests", "Active Shared Channels",
             "Active External Users"]
def num(v):
    try: return int(v)
    except (TypeError, ValueError): return v or None
trows = [[r.get("Team Name"), r.get("Team Type"), r.get("Last Activity Date")]
         + [num(r.get(c)) for c in TEAM_COLS[3:]]
         for r in sorted(teams, key=lambda r: -(num(r.get("Channel Messages")) or 0))]
sheet("Teams", TEAM_COLS, trows,
      widths={1: 34, 2: 14, 3: 15}, numfmts={i: "#,##0" for i in range(4, 16)})

# ---------- Groups ----------
GRP_COLS = ["Group Display Name", "Group Type", "Owner Principal Name",
            "Last Activity Date", "Member Count", "External Member Count",
            "Exchange Received Email Count", "SharePoint Active File Count",
            "SharePoint Total File Count", "SharePoint Storage (GB)",
            "Exchange Mailbox Storage (GB)"]
grows = []
for r in sorted(groups, key=lambda r: -(num(r.get("SharePoint Active File Count")) or 0)):
    sp = num(r.get("SharePoint Site Storage Used (Byte)"))
    ex = num(r.get("Exchange Mailbox Storage Used (Byte)"))
    grows.append([r.get("Group Display Name"), r.get("Group Type"),
                  r.get("Owner Principal Name"), r.get("Last Activity Date"),
                  num(r.get("Member Count")), num(r.get("External Member Count")),
                  num(r.get("Exchange Received Email Count")),
                  num(r.get("SharePoint Active File Count")),
                  num(r.get("SharePoint Total File Count")),
                  round(sp / 1e9, 2) if sp else None,
                  round(ex / 1e9, 2) if ex else None])
sheet("M365 Groups", GRP_COLS, grows,
      widths={1: 34, 2: 14, 3: 30, 4: 15},
      numfmts={**{i: "#,##0" for i in range(5, 10)}, 10: "#,##0.00", 11: "#,##0.00"})

# ---------- Mailboxes ----------
MB_COLS = ["Display Name", "User Principal Name", "Created Date",
           "Last Activity Date", "Item Count", "Storage Used (GB)",
           "Quota (GB)", "% of quota", "Deleted Items", "Has Archive"]
mrows = []
for r in sorted(mailboxes, key=lambda r: -(num(r.get("Storage Used (Byte)")) or 0)):
    used = num(r.get("Storage Used (Byte)")); quota = num(r.get("Prohibit Send/Receive Quota (Byte)"))
    mrows.append([r.get("Display Name"), r.get("User Principal Name"),
                  r.get("Created Date"), r.get("Last Activity Date"),
                  num(r.get("Item Count")),
                  round(used / 1e9, 2) if used else None,
                  round(quota / 1e9, 2) if quota else None,
                  (used / quota) if used and quota else None,
                  num(r.get("Deleted Item Count")), r.get("Has Archive")])
sheet("Mailboxes", MB_COLS, mrows,
      widths={1: 26, 2: 34, 3: 13, 4: 15},
      numfmts={5: "#,##0", 6: "#,##0.00", 7: "#,##0.00", 8: "0.0%", 9: "#,##0"})

# ---------- Email activity ----------
EM_COLS = ["Display Name", "User Principal Name", "Last Activity Date",
           "Send Count", "Receive Count", "Read Count",
           "Meetings Created", "Meetings Interacted", "Assigned Products"]
erows = [[r.get("Display Name"), r.get("User Principal Name"), r.get("Last Activity Date")]
         + [num(r.get(c)) for c in ("Send Count", "Receive Count", "Read Count",
                                    "Meeting Created Count", "Meeting Interacted Count")]
         + [r.get("Assigned Products")]
         for r in sorted(email, key=lambda r: -(num(r.get("Send Count")) or 0))]
sheet("Email Activity", EM_COLS, erows,
      widths={1: 26, 2: 34, 3: 15, 9: 40}, numfmts={i: "#,##0" for i in range(4, 9)})

# ---------- Summary (formulas, not hardcoded) ----------
ws = wb.active; ws.title = "Summary"
ws["A1"] = "Microsoft 365 usage — Sanctuary Recovery"; ws["A1"].font = TITLE
rows = [
    ("Tenant", t.get("tenant")),
    ("Microsoft data as of", t.get("refresh_date")),
    ("Reporting window", f'{t.get("period_days")} days (Graph maximum is 180 — there is no 1-year window)'),
    ("Pull generated", d.get("generated")),
    ("Names concealed by tenant setting", "No" if t.get("concealed") is False else "Yes"),
    ("Person names in this file", "Redacted — rebuild the payload with --include-people for real names"),
    ("", ""),
    ("SharePoint sites & channels", "=COUNTA('SharePoint Sites'!A2:A100000)"),
    ("  …idle 90+ days", "=COUNTIF('SharePoint Sites'!F2:F100000,\">=90\")"),
    ("  …with no owner", "=COUNTIF('SharePoint Sites'!O2:O100000,\"Yes\")"),
    ("  total storage (GB)", "=SUM('SharePoint Sites'!K2:K100000)"),
    ("  total page views (180d)", "=SUM('SharePoint Sites'!J2:J100000)"),
    ("  total files", "=SUM('SharePoint Sites'!H2:H100000)"),
    ("", ""),
    ("Teams", "=COUNTA(Teams!A2:A100000)"),
    ("  channel messages (180d)", "=SUM(Teams!F2:F100000)"),
    ("  teams with zero messages", "=COUNTIF(Teams!F2:F100000,0)"),
    ("", ""),
    ("M365 groups", "=COUNTA('M365 Groups'!A2:A100000)"),
    ("", ""),
    ("Mailboxes", "=COUNTA(Mailboxes!A2:A100000)"),
    ("  total mailbox storage (GB)", "=SUM(Mailboxes!F2:F100000)"),
    ("People with email activity", "=COUNTA('Email Activity'!A2:A100000)"),
    ("  emails sent (180d)", "=SUM('Email Activity'!D2:D100000)"),
    ("  emails received (180d)", "=SUM('Email Activity'!E2:E100000)"),
]
r = 3
for label, val in rows:
    ws.cell(r, 1, label).font = Font(name=FONT, size=10, bold=not label.startswith("  ") and bool(label))
    c = ws.cell(r, 2, val); c.font = BODY
    if isinstance(val, str) and val.startswith("="):
        c.number_format = "#,##0.00" if "GB" in label else "#,##0"
    r += 1

r += 1
notes = [
    "NOTES AND LIMITS",
    "• Window is 180 days. Microsoft's Graph usage reports offer D7/D30/D90/D180 only — a 1-year window does not exist in this API.",
    "• Standard Teams channels have no usage of their own. Only private and shared channels get their own SharePoint site and appear as rows.",
    "  A standard channel's activity is counted inside its team's single site row. Microsoft publishes no per-standard-channel report.",
    "• 12 of the 71 site rows have a hash for a title and no URL — those are system sites (Tenant Admin, Search Center, Project Web App), not team sites.",
    "• Per-user Teams activity is missing (0 rows): scan.py called a Graph function that does not exist. The fix is in open PR #14, not yet merged.",
    "• Nothing here is estimated. A figure Microsoft did not measure is blank, never 0.",
    "• No file contents, page contents, message text or mailbox contents were collected — the app permissions cannot read them.",
    f"• Source: sharepoint-usage.json, generated {d.get('generated')}, from tools/scan.py against the Microsoft Graph reports API.",
]
for i, n in enumerate(notes):
    c = ws.cell(r + i, 1, n)
    c.font = Font(name=FONT, size=9, bold=(i == 0), color="1F3864" if i == 0 else "666666")
ws.column_dimensions["A"].width = 44
ws.column_dimensions["B"].width = 72

wb.move_sheet("Summary", offset=-10)
wb.save(OUT)
print("wrote", OUT)
print("sheets:", wb.sheetnames)
print("row counts:", len(srows), len(trows), len(grows), len(mrows), len(erows))
