#!/usr/bin/env python3
"""Build google-users.js from a Google Admin user export (CSV).

    python3 tools/build-google-js.py google_users_2026-10-21.csv

Get the CSV from the Google Admin console: Directory → Users → Download
users → "All user info columns" → CSV. The raw file stays out of git (see
.gitignore); this writes only what google.html needs:

  - each person's mailbox name (the part before the @), department, plan,
    status, last sign-in and storage
  - a flag for likely cuts: suspended but still licensed, never signed in,
    or no sign-in for 90+ days
  - totals by plan and by department

Column names vary a little between exports, so they're matched loosely
("Last Sign In [READ ONLY]", "Last Sign In", ... all work).
"""
import csv
import json
import re
import sys
from datetime import date, datetime

SHOW_FULL_EMAIL = False
QUIET_DAYS = 30
INACTIVE_DAYS = 90


def col(row, *names):
    """First non-empty value whose header starts with any of `names`."""
    for key, val in row.items():
        k = (key or '').strip().lower()
        if any(k.startswith(n.lower()) for n in names) and (val or '').strip():
            return val.strip()
    return ''


def who(addr):
    addr = addr.strip().lower()
    return addr if SHOW_FULL_EMAIL else addr.split('@')[0] + '@'


def parse_when(s):
    s = (s or '').strip()
    if not s or re.search(r'never', s, re.I):
        return None
    for fmt in ('%Y/%m/%d %H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y/%m/%d', '%Y-%m-%d', '%m/%d/%Y %H:%M:%S', '%m/%d/%Y',
                '%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ'):
        try:
            return datetime.strptime(s[:26], fmt).date()
        except ValueError:
            continue
    return None


UNITS = {'': 1, 'b': 1, 'k': 1e3, 'kb': 1e3, 'm': 1e6, 'mb': 1e6, 'g': 1e9, 'gb': 1e9, 't': 1e12, 'tb': 1e12}


def gigabytes(s):
    m = re.match(r'^\s*([\d.,]+)\s*([kmgt]?b?)\s*$', (s or '').lower())
    if not m:
        return None
    return round(float(m.group(1).replace(',', '')) * UNITS.get(m.group(2), 1) / 1e9, 2)


def plan_of(licenses):
    """'Google Workspace Business Starter' → 'Business Starter'; several are joined."""
    names = [re.sub(r'^\s*(google\s+workspace|g suite)\s+', '', p, flags=re.I).strip()
             for p in re.split(r'[;,|]', licenses or '') if p.strip()]
    return ' + '.join(names)


def main(path):
    today = date.today()
    users = []
    with open(path, newline='', encoding='utf-8-sig') as f:
        for row in csv.DictReader(f):
            email = col(row, 'Email Address', 'Primary Email', 'Email')
            if '@' not in email:
                continue
            status = col(row, 'Status') or 'Active'
            last = parse_when(col(row, 'Last Sign In', 'Last Login'))
            days = (today - last).days if last else None
            plan = plan_of(col(row, 'Licenses', 'License', 'Assigned Licenses'))
            ou = col(row, 'Org Unit Path', 'Org Unit') or '/'
            dept = col(row, 'Department') or (ou.strip('/').split('/')[-1] if ou.strip('/') else '') or 'Not set'
            suspended = bool(re.search(r'suspend', status, re.I))
            if suspended and plan:
                flag = 'Suspended but still licensed'
            elif plan and last is None:
                flag = 'Never signed in'
            elif plan and days is not None and days >= INACTIVE_DAYS:
                flag = 'No sign-in in %d+ days' % INACTIVE_DAYS
            elif plan and days is not None and days >= QUIET_DAYS:
                flag = 'Quiet (%d–%d days)' % (QUIET_DAYS, INACTIVE_DAYS)
            else:
                flag = ''
            users.append({
                'who': who(email),
                'dept': dept,
                'ou': ou,
                'plan': plan,
                'status': 'Suspended' if suspended else 'Active',
                'lastSignIn': last.isoformat() if last else None,
                'days': days,
                'storageGB': gigabytes(col(row, 'Total Storage', 'Storage Used')),
                'driveGB': gigabytes(col(row, 'Drive Usage')),
                'mailGB': gigabytes(col(row, 'Email Usage')),
                'flag': flag,
                'candidate': flag != '' and not flag.startswith('Quiet'),
            })

    def tally(key):
        out = {}
        for u in users:
            t = out.setdefault(u[key] or 'No license', {'name': u[key] or 'No license', 'users': 0, 'licensed': 0,
                                                         'active30': 0, 'candidates': 0, 'storageGB': 0.0})
            t['users'] += 1
            t['licensed'] += 1 if u['plan'] else 0
            t['active30'] += 1 if u['days'] is not None and u['days'] < QUIET_DAYS else 0
            t['candidates'] += 1 if u['candidate'] else 0
            t['storageGB'] = round(t['storageGB'] + (u['storageGB'] or 0), 2)
        return sorted(out.values(), key=lambda t: -t['users'])

    licensed = [u for u in users if u['plan']]
    data = {
        'source': path.split('/')[-1],
        'built': today.isoformat(),
        'totals': {
            'users': len(users),
            'licensed': len(licensed),
            'active30': sum(1 for u in licensed if u['days'] is not None and u['days'] < QUIET_DAYS),
            'suspendedLicensed': sum(1 for u in licensed if u['status'] == 'Suspended'),
            'neverSignedIn': sum(1 for u in licensed if u['lastSignIn'] is None),
            'inactive90': sum(1 for u in licensed if u['days'] is not None and u['days'] >= INACTIVE_DAYS),
            'candidates': sum(1 for u in users if u['candidate']),
            'storageGB': round(sum(u['storageGB'] or 0 for u in users), 2),
        },
        'byPlan': tally('plan'),
        'byDept': tally('dept'),
        'users': sorted(users, key=lambda u: (not u['candidate'], u['flag'] == '', u['dept'], u['who'])),
    }
    with open('google-users.js', 'w') as f:
        f.write('/* Generated by tools/build-google-js.py from %s — do not edit by hand.\n'
                '   Re-run the script with a fresh Google Admin export to update. */\n' % data['source'])
        f.write('var GOOGLE_USERS = ' + json.dumps(data, indent=1, ensure_ascii=False) + ';\n')
    t = data['totals']
    print('wrote google-users.js: %d users, %d licensed, %d cut candidates' % (t['users'], t['licensed'], t['candidates']))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
