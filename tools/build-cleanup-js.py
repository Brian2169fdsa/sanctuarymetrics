#!/usr/bin/env python3
"""Build microsoft-cleanup.js from the M365 license cleanup log (CSV).

    python3 tools/build-cleanup-js.py sanctuary_m365_license_cleanup_2026-10-15.csv

The raw CSV stays out of git (see .gitignore). This writes only the fields the
"Cost cut so far" page uses, plus the headline totals computed here, so every
number on the page traces back to a CSV row rather than being typed by hand.

Email addresses are published as the part before the @ (the repo and site are
public). Set SHOW_FULL_EMAIL = True to publish full addresses instead.

Decisions taken on 2026-10-15 that are not in the CSV itself live in
OVERRIDES / ADDED_OPEN_ITEMS below, each with the reason, so they stay visible.
"""
import csv
import json
import re
import sys
from datetime import date

SHOW_FULL_EMAIL = False
HOME_DOMAIN = 'sanctuaryrecoverycenters.com'

EXO = 'Exchange Online (Plan 2)'
OVERRIDES = {
    # The CSV says "EXO P2 rate TBD from invoice"; $9.60 is the rate used in the
    # Sept 27 usage review until the invoice line is confirmed.
    'exo_rate': 9.60,
    # EXO P2 subscription target: the CSV row says 2 (jschall@, joe@ kept). On
    # review both already hold Business Standard (50 GB mailbox) and EXO P2 adds
    # no encryption, so the subscription goes to 0.
    'exo_target': 0,
    # The 10-seat monthly Standard subscription bills at $16.80 (the CSV notes
    # "monthly sub rate may differ" from the $14.21 annual average).
    'standard_monthly_rate': 16.80,
}

ADDED_OPEN_ITEMS = [
    {'item': 'rweaver@ still holds Exchange Online (Plan 2)',
     'action': 'Remove EXO P2 (missed in the bulk unassign). Holds Premium, so mailbox and encryption are unaffected.',
     'status': 'TO DO'},
    {'item': 'jschall@ and joe@sanctuaryci.org: EXO P2 kept by mistake',
     'action': 'Both hold Business Standard, which already includes a 50 GB mailbox, and EXO P2 provides no message '
               'encryption. Remove EXO P2 from both, then cancel the EXO P2 subscription to 0.',
     'status': 'TO DO'},
]
# Merged into the CSV's own mailbox-retention OPEN_ITEM row rather than listed twice.
RETENTION_DETAIL = ('25 unlicensed mailboxes auto-delete around 2026-11-14. Decide shared-mailbox conversion or hold '
                    'per mailbox before then, kmaguire first.')


def num(v):
    v = (v or '').strip()
    if not re.fullmatch(r'-?\d+(\.\d+)?', v):
        return None
    f = float(v)
    return int(f) if f.is_integer() and '.' not in v else f


def who(addr):
    addr = addr.strip()
    if SHOW_FULL_EMAIL or '@' not in addr:
        return addr
    local, domain = addr.split('@', 1)
    return local + '@' if domain.lower() == HOME_DOMAIN else local + '@' + domain


def rate_for(product, row_price, rates):
    if product == EXO:
        return OVERRIDES['exo_rate']
    return rates.get(product, row_price)


def main(path):
    with open(path, newline='', encoding='utf-8-sig') as f:
        rows = [r for r in csv.DictReader(f) if (r.get('record_type') or '').strip()]

    # Per-product rate from the CSV's own single-product rows.
    rates = {}
    for r in rows:
        p, price = r['license_or_product'].strip(), num(r['unit_price_monthly_usd'])
        if price and ' + ' not in p:
            rates.setdefault(p, price)

    accounts, exo_done, exo_open, subs, opens = [], [], [], [], []
    freed, freed_lines, licenses = 0.0, {}, 0

    def add_freed(product, qty, price):
        nonlocal freed
        freed += qty * price
        line = freed_lines.setdefault(product, {'product': product, 'qty': 0, 'price': price, 'monthly': 0.0})
        line['qty'] = int(line['qty'] + qty) if float(line['qty'] + qty).is_integer() else line['qty'] + qty
        line['monthly'] = round(line['qty'] * price, 2)

    for r in rows:
        kind = r['record_type'].strip()
        before, after = num(r['qty_before']) or 0, num(r['qty_after']) or 0
        removed = 'removed' in r['action_taken'].lower() and r['status'].strip() == 'DONE'

        if kind == 'ACCOUNT':
            parts = [p.strip() for p in r['license_or_product'].split(' + ')]
            if removed:
                licenses += 1          # one row = one account (as specified)
                each = (before - after) / len(parts)
                for p in parts:
                    add_freed(p, each, rate_for(p, num(r['unit_price_monthly_usd']), rates))
            accounts.append({
                'who': who(r['item']), 'license': r['license_or_product'].strip() if removed else '—',
                'blocked': r['sign_in_blocked'].strip(), 'status': r['status'].strip(),
                'notes': r['notes'].strip(), 'muted': r['status'].strip() == 'NO ACTION NEEDED'})

        elif kind == 'EXO_P2_REMOVAL' and removed:
            qty = int(before - after)
            licenses += qty
            add_freed(EXO, qty, OVERRIDES['exo_rate'])
            names = re.search(r'\((.*)\)', r['item'])
            exo_done.append({'qty': qty, 'who': [who(n if '@' in n else n + '@' + HOME_DOMAIN)
                                                 for n in (names.group(1).split(';') if names else [])],
                             'notes': r['notes'].strip(), 'by': r['action_taken'].strip()})

        elif kind in ('EXO_P2_REMOVAL', 'EXO_P2_KEEP'):
            exo_open.append({'who': who(r['item']), 'status': r['status'].strip(), 'notes': r['notes'].strip()})

        elif kind == 'SUBSCRIPTION':
            product = r['license_or_product'].strip()
            label = r['item'].strip()
            target = num(r['target_qty'])
            price = num(r['unit_price_monthly_usd'])
            note = r['notes'].strip()
            if product == EXO:
                price = OVERRIDES['exo_rate']
                if target != OVERRIDES['exo_target']:
                    note = ('Target changed from %d to %d on Oct 15: jschall@ and joe@sanctuaryci.org already hold '
                            'Business Standard. Remove EXO P2 from rweaver@, jschall@ and joe@, then reduce purchased '
                            '%d to %d; read the cancellation dialog first.' % (target, OVERRIDES['exo_target'],
                                                                              before, OVERRIDES['exo_target']))
                    target = OVERRIDES['exo_target']
            if 'monthly' in label.lower() and 'Standard' in product:
                price = OVERRIDES['standard_monthly_rate']
            status = r['status'].strip()
            pending_monthly = round((after - target) * price, 2) if status == 'PENDING' and price else 0
            subs.append({'product': product, 'label': label, 'action': r['action_taken'].strip(),
                         'before': before, 'after': after, 'target': target, 'price': price,
                         'status': status, 'effective': r['effective_date'].strip(), 'notes': note,
                         'pendingMonthly': pending_monthly})

        elif kind == 'OPEN_ITEM':
            action = r['notes'].strip()
            if 'retention' in r['item'].lower():
                action = RETENTION_DETAIL + ' ' + action
            opens.append({'item': r['item'].strip(), 'action': action, 'status': r['status'].strip(),
                          'was': r['action_taken'].strip()})

    opens = ADDED_OPEN_ITEMS + opens
    # nothing comes off the invoice until a SUBSCRIPTION row is DONE with seats reduced
    off_invoice = sum((s['before'] - s['after']) * (s['price'] or 0) for s in subs if s['status'] == 'DONE')
    pending = sum(s['pendingMonthly'] for s in subs)

    out = {
        'source': path.split('/')[-1], 'built': date.today().isoformat(),
        'loggedOn': '2026-10-15', 'snapshot': '2026-09-27', 'overrides': OVERRIDES,
        'kpis': {
            'accountsRemoved': sum(1 for a in accounts if a['license'] != '—'),
            'exoRemoved': sum(e['qty'] for e in exo_done),
            'licensesRemoved': licenses,
            'freedMonthly': round(freed, 2),
            'offInvoiceMonthly': round(off_invoice, 2),
            'pendingMonthly': round(pending, 2),
        },
        'freedLines': list(freed_lines.values()),
        'subscriptions': subs, 'accounts': accounts, 'exoBulk': exo_done, 'exoOpen': exo_open, 'openItems': opens,
    }
    js = ('/* Generated by tools/build-cleanup-js.py from ' + out['source'] + ' — do not edit by hand.\n'
          '   Re-run the script when the cleanup log changes. */\n'
          'var MS_CLEANUP = ' + json.dumps(out, indent=1, ensure_ascii=False) + ';\n')
    with open('microsoft-cleanup.js', 'w', encoding='utf-8') as f:
        f.write(js)
    print(json.dumps(out['kpis'], indent=1))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
