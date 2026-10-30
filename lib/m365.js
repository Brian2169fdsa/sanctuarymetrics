/* ============================================================================
   The daily Microsoft 365 pull: licenses, people, activity, mailboxes,
   OneDrive, SharePoint, Groups and Teams, straight from Microsoft Graph.

   It replaces the admin-centre exports (the ZIPs) and tools/scan.py for the
   site. pull() talks to Microsoft; build() turns what came back into
     review   what microsoft.html draws (the same shape its old embedded D had)
     usage    what the SharePoint / Teams / Groups / Email tabs read (the same
              shape sharepoint-usage.json had)
     summary  a dozen headline numbers, kept forever for the trend
   build() never talks to anything, so it is what tests/m365.test.js checks.

   Uses an Entra app with APPLICATION permissions, admin-consented:
     Reports.Read.All       usage reports: counts and dates, no content
     User.Read.All          who exists, enabled or not, which licenses
     Organization.Read.All  seats bought (subscribedSkus) and renewal dates
     Group.Read.All +       only to put real names and URLs on SharePoint
     Sites.Read.All         sites (the usage report leaves them blank)
     MailboxSettings.Read   optional: which mailboxes are shared, when the
                            mailbox report doesn't say
   None of these can open a file, a message or a mailbox.

   Credentials: M365_CLIENT_ID / M365_CLIENT_SECRET / M365_TENANT_ID, falling
   back to the Microsoft sign-in app (MS_CLIENT_ID / MS_CLIENT_SECRET /
   MS_TENANT_ID) so one app can do both. See M365_SYNC.md.

   Tenant setting, or every name comes back as a hash: M365 admin centre →
   Settings → Org settings → Reports → untick "Display concealed user, group,
   and site names in all reports".
   ========================================================================== */

const { msTenant } = require('./auth');
const K = require('./m365-skus');
const F = require('./m365-findings');

const GRAPH = 'https://graph.microsoft.com';
const PERIOD_DAYS = 180;
const GB = 1024 * 1024 * 1024;

function creds() {
  return {
    tenant: (process.env.M365_TENANT_ID || msTenant()).trim(),
    id: process.env.M365_CLIENT_ID || process.env.MS_CLIENT_ID,
    secret: process.env.M365_CLIENT_SECRET || process.env.MS_CLIENT_SECRET
  };
}
function configured() { const c = creds(); return !!(c.id && c.secret); }

/* ── Graph plumbing ──────────────────────────────────────────────────────── */

function graphError(status, what, body) {
  const e = new Error('Microsoft Graph ' + status + ' on ' + what + (body ? ': ' + String(body).slice(0, 200) : ''));
  e.status = status;
  return e;
}

/* a Graph client: get(path) for JSON, csv(path) for a report, batch(reqs) */
function client(fetchImpl) {
  const f = fetchImpl || fetch;
  let tok = null;
  async function token() {
    if (tok) { return tok; }
    const c = creds();
    const r = await f('https://login.microsoftonline.com/' + c.tenant + '/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, scope: GRAPH + '/.default', grant_type: 'client_credentials' })
    });
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.access_token) { throw graphError(r.status, 'sign-in', j.error_description || j.error); }
    tok = j.access_token;
    return tok;
  }
  /* throttled (429) or briefly down (503/504): wait as asked, up to 3 tries */
  async function call(url, init) {
    for (let i = 0; ; i++) {
      const r = await f(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + (await token()) }, (init && init.headers) || {}) }));
      if ((r.status === 429 || r.status === 503 || r.status === 504) && i < 2) {
        const wait = Math.min(Number(r.headers.get('retry-after')) || 2 * (i + 1), 10);
        await new Promise(function (ok) { setTimeout(ok, wait * 1000); });
        continue;
      }
      return r;
    }
  }
  async function get(path) {
    const r = await call(GRAPH + '/v1.0' + path, { headers: { ConsistencyLevel: 'eventual' } });
    if (!r.ok) { throw graphError(r.status, path.split('?')[0], await r.text().catch(function () { return ''; })); }
    return r.json();
  }
  async function paged(path) {
    let url = path, out = [];
    while (url) {
      const j = await get(url);
      out = out.concat(j.value || []);
      url = j['@odata.nextLink'] ? j['@odata.nextLink'].replace(GRAPH + '/v1.0', '') : null;
    }
    return out;
  }
  /* report endpoints answer with a redirect to a CSV download */
  async function csv(func, period, extra) {
    const r = await call(GRAPH + '/v1.0/reports/' + func + "(period='" + period + "')" + (extra || ''), {});
    if (r.status === 404) { return []; }
    if (!r.ok) { throw graphError(r.status, func, await r.text().catch(function () { return ''; })); }
    return parseCsv(await r.text());
  }
  /* up to 20 GETs per round trip; answers keyed by request id */
  async function batch(urls) {
    const out = {};
    for (let i = 0; i < urls.length; i += 20) {
      const reqs = urls.slice(i, i + 20).map(function (u, n) { return { id: String(i + n), method: 'GET', url: u }; });
      const r = await call(GRAPH + '/v1.0/$batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: reqs }) });
      if (!r.ok) { throw graphError(r.status, '$batch', await r.text().catch(function () { return ''; })); }
      ((await r.json()).responses || []).forEach(function (x) { out[x.id] = x; });
    }
    return urls.map(function (u, i) { return out[String(i)] || { status: 0 }; });
  }
  return { get: get, paged: paged, csv: csv, batch: batch };
}

/* RFC 4180 CSV → array of objects keyed by header (BOM stripped) */
function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { q = false; } } else { cell += c; }
    } else if (c === '"') { q = true; }
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') { i++; }
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') { rows.push(row); }
      row = [];
    } else { cell += c; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) { return []; }
  const head = rows[0].map(function (h) { return h.trim(); });
  return rows.slice(1).map(function (r) {
    const o = {};
    head.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : r[i]; });
    return o;
  });
}

/* ── the pull ────────────────────────────────────────────────────────────── */

/* everything build() needs. A report the app may not read becomes a warning,
   not a failed sync; users and licenses are the floor — without them, fail. */
async function pull(fetchImpl) {
  const g = client(fetchImpl);
  const warnings = [];
  async function soft(label, fn, dflt) {
    try { return await fn(); } catch (e) {
      warnings.push(label + ' unavailable (' + (e.status === 403 ? 'the app lacks the permission' : e.message.slice(0, 120)) + ')');
      return dflt;
    }
  }
  const P = 'D' + PERIOD_DAYS;
  const [org, skus, users] = await Promise.all([
    soft('Organization name', function () { return g.get('/organization?$select=displayName'); }, { value: [] }),
    g.paged('/subscribedSkus'),
    g.paged('/users?$top=999&$select=id,displayName,userPrincipalName,mail,accountEnabled,createdDateTime,jobTitle,userType,assignedLicenses')
  ]);
  const reports = {};
  const jobs = [
    ['subs', 'Subscriptions (renewal dates)', function () { return g.paged('/directory/subscriptions'); }],
    ['active', 'Active users report', function () { return g.csv('getOffice365ActiveUserDetail', P); }],
    ['mailboxes', 'Mailbox usage report', function () { return g.csv('getMailboxUsageDetail', 'D7'); }],
    ['email', 'Email activity report', function () { return g.csv('getEmailActivityUserDetail', P); }],
    ['teamsUsers', 'Teams user activity report', function () { return g.csv('getTeamsUserActivityDetail', 'D30'); }],
    ['onedrive', 'OneDrive usage report', function () { return g.csv('getOneDriveUsageAccountDetail', 'D7'); }],
    ['apps', 'Microsoft 365 Apps usage report', function () { return g.csv('getM365AppUserDetail', P, '?$format=text/csv'); }],
    ['sites', 'SharePoint site usage report', function () { return g.csv('getSharePointSiteUsageDetail', P); }],
    ['groups', 'Groups activity report', function () { return g.csv('getOffice365GroupsActivityDetail', P); }],
    ['teams', 'Teams activity report', function () { return g.csv('getTeamsTeamActivityDetail', P); }]
  ];
  await Promise.all(jobs.map(async function (j) { reports[j[0]] = await soft(j[1], j[2], []); }));

  /* group → its SharePoint site, so sites get a real name and URL */
  const gids = reports.groups.filter(function (r) { return r['Group Id'] && !isTrue(r['Is Deleted']); }).map(function (r) { return r['Group Id']; });
  const groupSites = {};
  await soft('Group site names (Sites.Read.All + Group.Read.All)', async function () {
    const res = await g.batch(gids.map(function (id) { return '/groups/' + id + '/sites/root?$select=id,webUrl'; }));
    const denied = res.filter(function (x) { return x.status === 403; }).length;
    res.forEach(function (x, i) { if (x.status === 200 && x.body) { groupSites[gids[i]] = { id: x.body.id, webUrl: x.body.webUrl }; } });
    if (denied && denied === res.length) { const e = new Error('denied'); e.status = 403; throw e; }
  });

  /* shared mailboxes: from the mailbox report when it says, else each licensed
     account's mailbox settings */
  const purposes = {};
  const hasType = reports.mailboxes.some(function (r) { return 'Recipient Type' in r; });
  if (!hasType) {
    const licensed = users.filter(function (u) { return (u.assignedLicenses || []).length && u.userType !== 'Guest'; });
    await soft('Shared-mailbox check (MailboxSettings.Read)', async function () {
      const res = await g.batch(licensed.map(function (u) { return '/users/' + u.id + '/mailboxSettings?$select=userPurpose'; }));
      const denied = res.filter(function (x) { return x.status === 403; }).length;
      res.forEach(function (x, i) { if (x.status === 200 && x.body && x.body.userPurpose) { purposes[lower(licensed[i].userPrincipalName)] = x.body.userPurpose; } });
      if (denied && denied === res.length) { const e = new Error('denied'); e.status = 403; throw e; }
    });
  }

  return { org: ((org.value || [])[0] || {}).displayName || '', skus: skus, users: users, reports: reports,
           groupSites: groupSites, purposes: purposes, warnings: warnings };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function lower(s) { return String(s || '').trim().toLowerCase(); }
function isTrue(v) { return String(v).toLowerCase() === 'true'; }
function int(v) { const n = parseInt(String(v === undefined ? '' : v).trim(), 10); return isNaN(n) ? 0 : n; }
function numOrNull(v) { const s = String(v === undefined ? '' : v).trim(); if (!s) { return null; } const n = Number(s); return isNaN(n) ? null : n; }
function pick(row, cols) { for (const c of cols) { if (row && row[c] !== undefined && row[c] !== '') { return row[c]; } } return ''; }
function yes(v) { return String(v || '').trim().toLowerCase() === 'yes'; }
function iso(d) { return d.toISOString().slice(0, 10); }
function daysSince(date, ref) {
  const s = String(date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { return null; }
  return Math.max(0, Math.round((Date.parse(ref) - Date.parse(s)) / 86400000));
}
function round(n, d) { const m = Math.pow(10, d || 2); return Math.round(n * m) / m; }
function byUpn(rows, col) {
  const m = {};
  (rows || []).forEach(function (r) { const k = lower(r[col || 'User Principal Name']); if (k && !isTrue(r['Is Deleted'])) { m[k] = r; } });
  return m;
}
/* report names hashed by the "concealed names" tenant setting */
function concealed(v) { v = String(v || ''); return v.length > 30 && v.indexOf('@') < 0 && v.indexOf('/') < 0 && v.indexOf(' ') < 0; }
function refreshDate(rows, today) {
  for (const r of rows || []) { const d = String(r['Report Refresh Date'] || '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { return d; } }
  return today;
}

/* ── SharePoint scoring (ported from tools/scan.py, same thresholds) ─────── */

const DEAD_DAYS = 180, STALE_DAYS = 90, SMALL_BYTES = 100 * 1024 * 1024, BIG_BYTES = GB, LOW_FILES = 10, LOW_VIEWS = 5;
const ONEDRIVE_TEMPLATES = ['SPSPERS', 'PERSONAL'];
const SYSTEM_TEMPLATES = ['APPCATALOG', 'SRCHCEN', 'POINTPUBLISHINGHUB', 'POINTPUBLISHINGTOPIC', 'SPSMSITEHOST', 'EHS', 'TENANTADMIN'];

function humanBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; n = Number(n || 0);
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return (i < 2 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1)) + ' ' + u[i];
}
function scoreSite(rec) {
  const reasons = [];
  let score = 0;
  const idle = rec.days_idle;
  if (idle === null) { score += 55; reasons.push('No recorded activity in ' + PERIOD_DAYS + ' days'); }
  else if (idle >= DEAD_DAYS) { score += 55; reasons.push('Last activity ' + idle + ' days ago'); }
  else if (idle >= STALE_DAYS) { score += 30; reasons.push('Last activity ' + idle + ' days ago'); }
  else if (idle >= 30) { score += 10; reasons.push('Quiet for ' + idle + ' days'); }
  if (rec.file_count <= 1) { score += 20; reasons.push('Essentially empty (no files)'); }
  else if (rec.file_count <= LOW_FILES) { score += 12; reasons.push('Only ' + rec.file_count + ' files'); }
  if (rec.page_views <= LOW_VIEWS && rec.active_files === 0) { score += 10; reasons.push('Nobody opened a page or touched a file'); }
  if (!rec.owner) { score += 12; rec.orphaned = true; reasons.push('No owner on record — orphaned'); }
  if (rec.members === 0 && rec.is_group_site) { score += 8; reasons.push('Group has zero members'); }
  if (rec.storage_used >= BIG_BYTES) { score -= 10; reasons.push('Holds ' + humanBytes(rec.storage_used) + ' — archive rather than delete'); }
  if (rec.guests > 0) { reasons.push(rec.guests + ' guest(s) still have access'); }
  score = Math.max(0, Math.min(100, score));
  const dead = idle === null || idle >= DEAD_DAYS;
  let verdict;
  if (!dead && score < 40) { verdict = 'Keep'; }
  else if (dead && rec.storage_used < SMALL_BYTES && rec.file_count <= LOW_FILES) { verdict = 'Delete'; }
  else if (dead && rec.storage_used >= BIG_BYTES) { verdict = 'Archive'; }
  else if (dead) { verdict = score >= 70 ? 'Delete' : 'Archive'; }
  else { verdict = 'Review'; }
  if (rec.orphaned && verdict === 'Keep') { verdict = 'Review'; }
  rec.verdict = verdict; rec.score = score; rec.reasons = reasons;
  return rec;
}

function buildSites(raw, ref) {
  const R = raw.reports;
  const groupsById = {};
  R.groups.forEach(function (g) { if (g['Group Id']) { groupsById[g['Group Id']] = g; } });
  const teamsById = {};
  R.teams.forEach(function (t) { if (t['Team Id']) { teamsById[t['Team Id']] = t; } });
  let hidden = false;
  const recs = [];
  R.sites.forEach(function (row) {
    const template = String(row['Root Web Template'] || '').toUpperCase().replace(/\s/g, '');
    if (ONEDRIVE_TEMPLATES.indexOf(template) >= 0 || template.indexOf('PERSON') >= 0 || SYSTEM_TEMPLATES.indexOf(template) >= 0) { return; }
    if (isTrue(row['Is Deleted'])) { return; }
    const url = row['Site URL'] || '';
    if (concealed(url)) { hidden = true; }
    recs.push({
      site_id: row['Site Id'] || '', url: url,
      title: url ? (url.replace(/\/+$/, '').split('/').pop() || url) : String(row['Site Id'] || '').slice(0, 8),
      owner: row['Owner Principal Name'] || row['Owner Display Name'] || '', template: row['Root Web Template'] || '',
      days_idle: daysSince(row['Last Activity Date'], ref), last_activity: row['Last Activity Date'] || '',
      file_count: int(row['File Count']), active_files: int(row['Active File Count']), page_views: int(row['Page View Count']),
      storage_used: int(row['Storage Used (Byte)']), storage_quota: int(row['Storage Allocated (Byte)']),
      is_group_site: template === 'GROUP' || template === 'TEAMCHANNEL', is_channel_site: template === 'TEAMCHANNEL',
      members: null, guests: 0, team_name: '', channel_messages: null, orphaned: false
    });
  });
  /* group → site (same join scan.py --enrich made) */
  const bySite = {};
  recs.forEach(function (r) { if (r.site_id) { bySite[r.site_id] = r; } });
  Object.keys(raw.groupSites || {}).forEach(function (gid) {
    const site = raw.groupSites[gid], g = groupsById[gid];
    if (!site || !site.id || !g) { return; }
    const sid = site.id.indexOf(',') >= 0 ? site.id.split(',')[1] : site.id;
    const target = bySite[sid] || recs.find(function (r) { return r.site_id && site.id.indexOf(r.site_id) >= 0; });
    if (!target) { return; }
    if (site.webUrl) { target.url = site.webUrl; }
    target.members = int(g['Member Count']);
    target.guests = int(g['External Member Count']);
    target.title = g['Group Display Name'] || target.title;
    const t = teamsById[gid];
    if (t) {
      target.team_name = t['Team Name'] || '';
      target.channel_messages = int(t['Channel Messages']);
      target.guests = Math.max(target.guests, int(t['Guests']));
      const tidle = daysSince(t['Last Activity Date'], ref);
      if (tidle !== null && (target.days_idle === null || tidle < target.days_idle)) { target.days_idle = tidle; }
    }
  });
  recs.forEach(scoreSite);
  return { sites: recs, concealed: hidden };
}

/* ── the usage payload (what sharepoint-usage.json held) ─────────────────── */

const IDENTITY = ['user principal name', 'owner principal name', 'display name', 'user display name', 'owner display name', 'recipient'];
function redact(v) {
  v = String(v || '').trim();
  if (!v) { return ''; }
  if (v.indexOf('@') < 0) { return v.slice(0, 1) + '•••'; }
  const p = v.split('@');
  return (p[0].slice(0, 1) || '?') + '•••@' + p.slice(1).join('@');
}
function cleanRows(rows) {
  return (rows || []).map(function (r) {
    const o = {};
    Object.keys(r).forEach(function (k) {
      const c = k.trim().toLowerCase();
      o[k] = IDENTITY.some(function (x) { return c.indexOf(x) >= 0; }) ? redact(r[k]) : r[k];
    });
    return o;
  });
}
const SITE_KEEP = ['site_id', 'url', 'title', 'owner', 'template', 'days_idle', 'last_activity', 'file_count', 'active_files', 'page_views',
  'storage_used', 'storage_quota', 'is_group_site', 'is_channel_site', 'members', 'guests', 'team_name', 'channel_messages', 'orphaned', 'verdict', 'score'];

/* ── build ───────────────────────────────────────────────────────────────── */

/* opts: { keep: [{upn, reason}], today: 'YYYY-MM-DD', exclude: {findingId: [upn]} } */
function build(raw, opts) {
  opts = opts || {};
  const today = opts.today || iso(new Date());
  const R = raw.reports;
  const warnings = (raw.warnings || []).slice();
  const ref = refreshDate(R.active, refreshDate(R.sites, today));

  /* licenses */
  const skuById = {}, price = {}, term = {}, unknown = [];
  raw.skus.forEach(function (s) {
    const k = K.sku(s.skuPartNumber);
    skuById[s.skuId] = k.name;
    if (k.price !== null) { price[k.name] = k.price; } else if ((s.consumedUnits || 0) > 0) { unknown.push(s.skuPartNumber); }
    term[k.name] = k.term;
  });
  if (unknown.length) { warnings.push('No price for ' + unknown.join(', ') + ' — add it to lib/m365-skus.js.'); }

  const active = byUpn(R.active), mbx = byUpn(R.mailboxes), mail = byUpn(R.email), tu = byUpn(R.teamsUsers),
    od = byUpn(R.onedrive, 'Owner Principal Name'), apps = byUpn(R.apps);
  if (R.active.length && R.active.slice(0, 20).every(function (r) { return concealed(r['User Principal Name']); })) {
    warnings.push('User names in the reports are concealed, so activity can\'t be matched to people. Untick "Display concealed user, group, and site names in all reports" in M365 admin centre → Settings → Org settings → Reports.');
  }
  const DESK = ['Word (Windows)', 'Excel (Windows)', 'PowerPoint (Windows)', 'Word (Mac)', 'Excel (Mac)', 'PowerPoint (Mac)'];

  const people = raw.users.map(function (u) {
    const upn = lower(u.userPrincipalName);
    const licenses = (u.assignedLicenses || []).map(function (l) { return skuById[l.skuId]; }).filter(Boolean);
    const paid = licenses.filter(function (l) { return price[l] > 0; });
    const a = active[upn], m = mbx[upn], e = mail[upn], t = tu[upn], o = od[upn], ap = apps[upn];
    const ex = a ? daysSince(a['Exchange Last Activity Date'], ref) : null, odd = a ? daysSince(a['OneDrive Last Activity Date'], ref) : null,
      sp = a ? daysSince(a['SharePoint Last Activity Date'], ref) : null, tm = a ? daysSince(a['Teams Last Activity Date'], ref) : null;
    const lasts = a ? ['Exchange', 'OneDrive', 'SharePoint', 'Teams'].map(function (w) { return String(a[w + ' Last Activity Date'] || '').slice(0, 10); })
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort() : [];
    const last = lasts.length ? lasts[lasts.length - 1] : '';
    let type = m && m['Recipient Type'] ? (/shared/i.test(m['Recipient Type']) ? 'Shared' : 'User') : '';
    if (!type && raw.purposes && raw.purposes[upn]) { type = raw.purposes[upn] === 'shared' ? 'Shared' : 'User'; }
    if (!type && m) { type = 'User'; }
    let desktop = null;
    if (ap) {
      const hasCols = DESK.some(function (c) { return c in ap; });
      desktop = hasCols ? DESK.some(function (c) { return yes(ap[c]); }) : (yes(ap.Windows) || yes(ap.Mac));
    }
    return {
      name: u.displayName || upn, upn: upn, created: String(u.createdDateTime || '').slice(0, 10), guest: u.userType === 'Guest',
      blocked: u.accountEnabled === false, softdeleted: false, title: u.jobTitle || '',
      licenses: licenses, paid: paid, cost: round(paid.reduce(function (s, l) { return s + price[l]; }, 0)),
      last: last, idle: last ? daysSince(last, ref) : null, ex: ex, od: odd, sp: sp, teams: tm,
      mbx_type: type, mbx_gb: m ? round(int(m['Storage Used (Byte)']) / GB) : null,
      mbx_quota_gb: m && int(m['Prohibit Send/Receive Quota (Byte)']) ? round(int(m['Prohibit Send/Receive Quota (Byte)']) / GB, 0) : null,
      archive: m ? isTrue(m['Has Archive']) : null,
      od_files: o ? int(o['File Count']) : null, od_gb: o ? round(int(o['Storage Used (Byte)']) / GB) : null,
      teams_chats: t ? int(t['Team Chat Message Count']) + int(t['Private Chat Message Count']) : null,
      teams_meetings: t ? int(pick(t, ['Meeting Count', 'Meetings Count', 'Meetings Attended Count'])) : null,
      desktop: desktop, sent: e ? int(e['Send Count']) : null, recv: e ? int(e['Receive Count']) : null,
      mobile: ap ? yes(ap.Mobile) : null
    };
  });
  const shown = people.filter(function (p) { return p.licenses.length || p.mbx_type; });

  const enabledLic = people.filter(function (p) { return !p.blocked && !p.guest && p.paid.length; });
  const holders = function (name) { return people.filter(function (p) { return p.licenses.indexOf(name) >= 0; }); };
  const isWasted = function (p) { return p.blocked || p.idle === null || p.idle >= 90; };

  const sku = raw.skus.map(function (s) {
    const name = skuById[s.skuId];
    const total = (s.prepaidUnits && s.prepaidUnits.enabled) || 0, assigned = s.consumedUnits || 0;
    const h = holders(name);
    return { name: name, part: s.skuPartNumber, total: total, assigned: assigned, unassigned: Math.max(0, total - assigned),
      active30: h.filter(function (p) { return !p.blocked && p.idle !== null && p.idle <= 30; }).length,
      wasted: h.filter(isWasted).length, price: price[name] === undefined ? null : price[name], term: term[name],
      monthly: price[name] ? round(total * price[name]) : 0 };
  }).filter(function (s) { return s.price > 0 || (s.price === null && s.assigned > 0); })
    .sort(function (a, b) { return b.monthly - a.monthly; });

  const subs = (R.subs || []).filter(function (s) { return s.status !== 'Deleted' && !s.isTrial; }).map(function (s) {
    const k = K.sku(s.skuPartNumber);
    return { name: k.name, qty: s.totalLicenses || 0, profile: '', renew: String(s.nextLifecycleDateTime || '').slice(0, 10),
      purchased: String(s.createdDateTime || '').slice(0, 10), status: s.status || '', term: k.term };
  }).filter(function (s) { return price[s.name] > 0 && s.qty > 0; })
    .sort(function (a, b) { return a.renew < b.renew ? -1 : 1; });

  const totals = {
    users: people.length, licensed: people.filter(function (p) { return p.paid.length; }).length,
    enabled_licensed: enabledLic.length, blocked: people.filter(function (p) { return p.blocked; }).length,
    guests: people.filter(function (p) { return p.guest; }).length,
    unlicensed_enabled: people.filter(function (p) { return !p.blocked && !p.guest && !p.licenses.length; }).length,
    monthly: round(sku.reduce(function (s, k) { return s + (k.monthly || 0); }, 0))
  };
  const adoption = {};
  [['Exchange', 'ex'], ['Teams', 'teams'], ['OneDrive', 'od'], ['SharePoint', 'sp']].forEach(function (w) {
    const n = function (d) { return enabledLic.filter(function (p) { return p[w[1]] !== null && p[w[1]] <= d; }).length; };
    adoption[w[0]] = { d30: n(30), d90: n(90), d180: n(180) };
  });
  const buckets = { 'Active (≤30d)': 0, '31–90d': 0, '91–180d': 0, 'None in 180d / never': 0 };
  enabledLic.forEach(function (p) {
    const i = p.idle;
    buckets[i === null || i > 180 ? 'None in 180d / never' : i <= 30 ? 'Active (≤30d)' : i <= 90 ? '31–90d' : '91–180d']++;
  });

  const site = buildSites(raw, ref);
  if (site.concealed) { warnings.push('SharePoint site names are concealed — untick the concealed-names setting in M365 admin centre → Settings → Org settings → Reports.'); }
  const sp = site.sites.filter(function (s) { return s.is_group_site && !s.is_channel_site; }).map(function (s) {
    return { name: s.title, last: s.days_idle, files: s.file_count, active: s.active_files, gb: round(s.storage_used / GB), views: s.page_views };
  }).sort(function (a, b) { return b.gb - a.gb; });
  const teams = R.teams.filter(function (t) { return !isTrue(t['Is Deleted']); }).map(function (t) {
    return { name: t['Team Name'] || '', type: t['Team Type'] || '', last: daysSince(t['Last Activity Date'], ref),
      active: int(t['Active Users']), msgs: int(t['Channel Messages']) };
  });

  const review = {
    org: raw.org || '', ref: ref, generated: new Date().toISOString(), price: price, term: term, sku: sku, subs: subs, totals: totals, adoption: adoption,
    teams_meet: enabledLic.filter(function (p) { return p.teams_meetings > 0; }).length,
    teams_chat: enabledLic.filter(function (p) { return p.teams_chats > 0; }).length,
    buckets: buckets, sp: sp, sp_gb: round(sp.reduce(function (s, x) { return s + x.gb; }, 0), 1),
    sp_dormant: sp.filter(function (s) { return s.last === null || s.last > 180; }).length,
    teams: teams, teams_dormant: teams.filter(function (t) { return t.msgs === 0; }).length,
    people: shown, keep: (opts.keep || []).map(function (k) { return { upn: lower(k.upn), reason: k.reason || '' }; })
  };
  review.findings = F.findings(review, opts);
  review.savings = F.savings(review);

  const usage = {
    generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', owners_redacted: true, people_redacted: true, live: true,
    tenants: [{
      tenant: raw.org || 'Microsoft 365', refresh_date: ref, period_days: PERIOD_DAYS, concealed: site.concealed,
      sites: site.sites.map(function (s) { const o = {}; SITE_KEEP.forEach(function (k) { o[k] = s[k]; }); o.owner = redact(o.owner); o.tenant = raw.org || ''; return o; }),
      groups: cleanRows(R.groups), teams: cleanRows(R.teams),
      people: { mailboxes: cleanRows(R.mailboxes), email_activity: cleanRows(R.email), teams_users: cleanRows(R.teamsUsers) }
    }]
  };

  const summary = {
    seatsBought: sku.reduce(function (s, k) { return s + (k.price > 0 ? k.total : 0); }, 0),
    seatsAssigned: sku.reduce(function (s, k) { return s + (k.price > 0 ? k.assigned : 0); }, 0),
    licensedUsers: totals.licensed, enabledLicensed: totals.enabled_licensed, active30: buckets['Active (≤30d)'],
    licenseMonthly: totals.monthly, removableMonthly: review.savings.total_monthly, cashMonthly: review.savings.cash_monthly,
    wastedSeats: sku.reduce(function (s, k) { return s + (k.price > 0 ? k.wasted : 0); }, 0)
  };
  return { review: review, usage: usage, summary: summary, warnings: warnings, ref: ref };
}

module.exports = { configured: configured, client: client, pull: pull, build: build, parseCsv: parseCsv, scoreSite: scoreSite, daysSince: daysSince };
