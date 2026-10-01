#!/usr/bin/env python3
"""Build data/metrics.json from the Make-fed metrics Sheet.

The Make scenario (pipeline/make/sanctuary-metrics.blueprint.json) appends
long-format rows to the Sheet's `metrics` tab every week. This script reads
that tab as CSV, enforces the pipeline guardrails, and writes the JSON the
report reads.

    python3 tools/build-metrics-json.py --csv metrics.csv --out data/metrics.json
    python3 tools/build-metrics-json.py --csv "$METRICS_CSV_URL" --out data/metrics.json

Guardrails (any violation exits non-zero and writes nothing):
  * schema: exactly the columns in COLUMNS, nothing extra
  * client scope: Sanctuary only; any row mentioning Cholla is rejected
  * PHI: only allow-listed channels/metrics; dimensions may not carry query
    strings, email addresses or phone numbers (no form contents, ever)
  * real data only: a blank value is never filled in; it is published as
    pending, and pending rows stay pending until a verified number replaces them
  * freshness: --max-age-days fails the build when the newest run is stale,
    so a dead token or paused scenario can't go unnoticed
"""
import argparse
import csv
import datetime as dt
import io
import json
import re
import sys
import urllib.request

COLUMNS = ['run_date', 'channel', 'metric', 'dimension', 'value',
           'window_start', 'window_end', 'period', 'source', 'status', 'note']

METRICS = {
    'facebook': {'views', 'unique_viewers', 'interactions', 'follows', 'unfollows',
                 'cta_clicks', 'page_profile_views', 'followers_total'},
    'instagram': {'views', 'reach', 'accounts_engaged', 'interactions',
                  'profile_link_taps', 'posts_published', 'followers_total'},
    'website': {'sessions', 'users', 'page_views', 'engagement_rate',
                'avg_session_duration_sec', 'key_events', 'bounce_rate'},
    'linkedin': {'impressions', 'clicks', 'engagement_rate', 'new_followers',
                 'followers_total'},
}
STATUSES = {'ok', 'manual_verified', 'pending_verified_export'}
PERIODS = {'28d', '14d', '7d', 'lifetime'}
DIMENSION_KINDS = {'channel', 'page', 'event'}

FORBIDDEN_CLIENT = re.compile(r'cholla', re.I)
EMAIL = re.compile(r'[^@\s]+@[^@\s]+\.[a-z]{2,}', re.I)
PHONE = re.compile(r'(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}')


class GuardrailError(Exception):
    pass


def read_csv(src):
    if re.match(r'https?://', src):
        with urllib.request.urlopen(src, timeout=60) as r:
            text = r.read().decode('utf-8-sig')
    else:
        with open(src, encoding='utf-8-sig') as f:
            text = f.read()
    return list(csv.DictReader(io.StringIO(text)))


def parse_date(s, field, n):
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        raise GuardrailError('row %d: %s %r is not YYYY-MM-DD' % (n, field, s))


def parse_number(s):
    s = s.strip().replace(',', '')
    if s == '':
        return None
    try:
        v = float(s)
    except ValueError:
        return 'bad'
    return int(v) if v.is_integer() else v


def check_row(row, n):
    if FORBIDDEN_CLIENT.search(' '.join(row.values())):
        raise GuardrailError('row %d mentions Cholla; this store is Sanctuary-only' % n)

    ch, metric = row['channel'], row['metric']
    if ch not in METRICS:
        raise GuardrailError('row %d: unknown channel %r' % (n, ch))
    if metric not in METRICS[ch]:
        raise GuardrailError('row %d: metric %r is not allow-listed for %s' % (n, metric, ch))
    if row['status'] not in STATUSES:
        raise GuardrailError('row %d: status %r not in %s' % (n, row['status'], sorted(STATUSES)))
    if row['period'] not in PERIODS:
        raise GuardrailError('row %d: period %r not in %s' % (n, row['period'], sorted(PERIODS)))

    dim = row['dimension']
    if dim:
        kind, _, val = dim.partition('=')
        if kind not in DIMENSION_KINDS or not val:
            raise GuardrailError('row %d: dimension %r must be channel=/page=/event=' % (n, dim))
        if '?' in val or EMAIL.search(val) or PHONE.search(val):
            raise GuardrailError('row %d: dimension %r looks like it carries personal data' % (n, dim))
    for field in ('note',):
        if EMAIL.search(row[field]) or PHONE.search(row[field]):
            raise GuardrailError('row %d: %s looks like it carries personal data' % (n, field))


def build(rows, max_age_days=None, today=None):
    if not rows:
        raise GuardrailError('the metrics tab is empty')
    if list(rows[0].keys()) != COLUMNS:
        raise GuardrailError('columns must be exactly %s, got %s' % (COLUMNS, list(rows[0].keys())))

    runs = {}
    for n, row in enumerate(rows, start=2):  # row 1 is the header
        row = {k: (v or '').strip() for k, v in row.items()}
        check_row(row, n)
        run_date = parse_date(row['run_date'], 'run_date', n)
        end = parse_date(row['window_end'], 'window_end', n)
        start = parse_date(row['window_start'], 'window_start', n) if row['window_start'] else None

        value = parse_number(row['value'])
        if value == 'bad':
            raise GuardrailError('row %d: value %r is not a number' % (n, row['value']))
        status = row['status']
        if value is None:
            # Real data only: a blank is never published as a number.
            status = 'pending_verified_export'
        elif status == 'pending_verified_export':
            raise GuardrailError('row %d: has a value but is still marked pending; '
                                 'set status to manual_verified once checked' % n)

        entry = {
            'value': value,
            'status': status,
            'source': row['source'],
            'period': row['period'],
            'window': {'start': start.isoformat() if start else None, 'end': end.isoformat()},
        }
        if row['note']:
            entry['note'] = row['note']

        run = runs.setdefault(run_date.isoformat(), {'run_date': run_date.isoformat(), 'channels': {}})
        chan = run['channels'].setdefault(row['channel'], {'metrics': {}, 'breakdowns': {}})
        if row['dimension']:
            kind, _, label = row['dimension'].partition('=')
            chan['breakdowns'].setdefault(kind, {}).setdefault(label, {})[row['metric']] = entry
        else:
            key = '%s_%s' % (row['metric'], row['period'])
            if key in chan['metrics']:
                raise GuardrailError('row %d: duplicate %s/%s for run %s (re-run? delete the '
                                     'older rows first)' % (n, row['channel'], key, run_date))
            chan['metrics'][key] = entry

    ordered = [runs[k] for k in sorted(runs)]
    add_derived(ordered)
    add_prior_period(ordered)

    latest = ordered[-1]['run_date']
    today = today or dt.date.today()
    age = (today - dt.date.fromisoformat(latest)).days
    if max_age_days is not None and age > max_age_days:
        raise GuardrailError('newest run is %s (%d days old, limit %d). The Make scenario has '
                             'stopped writing: check the Meta token and the scenario log.'
                             % (latest, age, max_age_days))

    return {
        'schema': 1,
        'generated_at': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        'latest_run': latest,
        'runs': ordered,
    }


def add_derived(runs):
    """Net follows = follows - unfollows, only when both are real numbers."""
    for run in runs:
        fb = run['channels'].get('facebook', {}).get('metrics', {})
        f, u = fb.get('follows_28d'), fb.get('unfollows_28d')
        if f and u and f['value'] is not None and u['value'] is not None:
            fb['net_follows_28d'] = dict(f, value=f['value'] - u['value'], derived='follows - unfollows')


def add_prior_period(runs):
    """Attach change vs. the immediately preceding, non-overlapping 28-day window.

    Weekly runs make this exact: the run four weeks earlier covers the 28 days
    ending the day before this window starts. No match, no change figure.
    """
    by_end = {}
    for run in runs:
        for ch, c in run['channels'].items():
            for key, m in c['metrics'].items():
                by_end[(ch, key, m['window']['end'])] = m
    for run in runs:
        for ch, c in run['channels'].items():
            for key, m in c['metrics'].items():
                if m['period'] == 'lifetime' or m['value'] is None or not m['window']['start']:
                    continue
                prior_end = (dt.date.fromisoformat(m['window']['start']) - dt.timedelta(days=1)).isoformat()
                p = by_end.get((ch, key, prior_end))
                if p and p['value'] not in (None, 0):
                    m['prior'] = {'value': p['value'], 'window': p['window']}
                    m['change_pct'] = round((m['value'] - p['value']) / p['value'] * 100, 1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--csv', required=True, help='path or URL of the metrics tab as CSV')
    ap.add_argument('--out', required=True, help='where to write metrics.json')
    ap.add_argument('--max-age-days', type=int, default=None,
                    help='fail if the newest run is older than this')
    args = ap.parse_args(argv)
    try:
        payload = build(read_csv(args.csv), max_age_days=args.max_age_days)
    except GuardrailError as e:
        print('build-metrics-json: %s' % e, file=sys.stderr)
        return 1
    with open(args.out, 'w') as f:
        json.dump(payload, f, indent=1, sort_keys=False)
        f.write('\n')
    print('wrote %s: %d runs, latest %s' % (args.out, len(payload['runs']), payload['latest_run']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
