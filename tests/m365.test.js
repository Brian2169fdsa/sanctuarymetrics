/* node --test tests/m365.test.js — the daily Microsoft pull, the cost rules
   and the checks on Claude's answer. No network: Graph is a fake fetch. */
const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/m365');
const AI = require('../lib/m365-ai');

const SKU = {
  basic: { skuId: 'b', skuPartNumber: 'O365_BUSINESS_ESSENTIALS', prepaidUnits: { enabled: 5 }, consumedUnits: 4 },
  std: { skuId: 's', skuPartNumber: 'O365_BUSINESS_PREMIUM', prepaidUnits: { enabled: 3 }, consumedUnits: 3 },
  prem: { skuId: 'p', skuPartNumber: 'SPB', prepaidUnits: { enabled: 3 }, consumedUnits: 2 },
  exo: { skuId: 'x', skuPartNumber: 'EXCHANGEENTERPRISE', prepaidUnits: { enabled: 2 }, consumedUnits: 1 },
  free: { skuId: 'f', skuPartNumber: 'FLOW_FREE', prepaidUnits: { enabled: 10000 }, consumedUnits: 3 }
};
function user(upn, name, lic, extra) {
  return Object.assign({ id: upn, userPrincipalName: upn, displayName: name, accountEnabled: true, userType: 'Member',
    createdDateTime: '2025-01-01T00:00:00Z', assignedLicenses: lic.map(function (l) { return { skuId: l }; }) }, extra || {});
}
function act(upn, last) {
  return { 'Report Refresh Date': '2026-10-28', 'User Principal Name': upn, 'Is Deleted': 'False',
    'Exchange Last Activity Date': last, 'OneDrive Last Activity Date': '', 'SharePoint Last Activity Date': '', 'Teams Last Activity Date': last };
}
function raw() {
  return {
    org: 'Test Org', skus: Object.values(SKU), warnings: [], groupSites: {}, purposes: {},
    users: [
      user('active@x.com', 'Active Alice', ['s']),                              /* std, desktop → nothing */
      user('web@x.com', 'Web Will', ['s']),                                     /* std, web only → std2basic */
      user('blocked@x.com', 'Blocked Bob', ['p', 'x'], { accountEnabled: false }), /* blocked + stacked */
      user('idle@x.com', 'Idle Ida', ['b']),                                    /* idle 120 → idle90 */
      user('kept@x.com', 'Kept Kim', ['b']),                                    /* idle but on the keep list */
      user('shared@x.com', 'Front Desk', ['b']),                                /* shared mailbox with a license */
      user('dup1@x.com', 'Dana Dup', ['b']),
      user('dup2@x.com', 'Dana Dup', ['s']),                                    /* the idler of the pair → dups */
      user('guest@y.com', 'Guest', [], { userType: 'Guest' })
    ],
    reports: {
      subs: [{ skuPartNumber: 'SPB', totalLicenses: 3, nextLifecycleDateTime: '2026-11-15T00:00:00Z', createdDateTime: '2025-11-15T00:00:00Z', status: 'Enabled' }],
      active: [act('active@x.com', '2026-10-27'), act('web@x.com', '2026-10-20'), act('blocked@x.com', '2026-05-01'),
        act('idle@x.com', '2026-06-30'), act('kept@x.com', ''), act('shared@x.com', '2026-10-27'),
        act('dup1@x.com', '2026-10-27'), act('dup2@x.com', '2026-08-01')],
      mailboxes: [{ 'User Principal Name': 'shared@x.com', 'Recipient Type': 'Shared', 'Storage Used (Byte)': String(2 * 1024 ** 3), 'Prohibit Send/Receive Quota (Byte)': String(50 * 1024 ** 3), 'Has Archive': 'False', 'Is Deleted': 'False' },
        { 'User Principal Name': 'active@x.com', 'Recipient Type': 'User', 'Storage Used (Byte)': String(45 * 1024 ** 3), 'Prohibit Send/Receive Quota (Byte)': String(50 * 1024 ** 3), 'Is Deleted': 'False' }],
      email: [{ 'User Principal Name': 'active@x.com', 'Send Count': '10', 'Receive Count': '40', 'Is Deleted': 'False' }],
      teamsUsers: [{ 'User Principal Name': 'active@x.com', 'Team Chat Message Count': '2', 'Private Chat Message Count': '3', 'Meeting Count': '4', 'Is Deleted': 'False' }],
      onedrive: [], groups: [], teams: [{ 'Team Id': 't1', 'Team Name': 'Ops', 'Team Type': 'Private', 'Last Activity Date': '2026-10-01', 'Active Users': '3', 'Channel Messages': '0', 'Is Deleted': 'False' }],
      apps: [{ 'User Principal Name': 'active@x.com', 'Word (Windows)': 'Yes', Mobile: 'No', 'Is Deleted': 'False' },
        { 'User Principal Name': 'web@x.com', 'Word (Windows)': 'No', 'Excel (Windows)': 'No', 'PowerPoint (Windows)': 'No', 'Word (Mac)': 'No', 'Excel (Mac)': 'No', 'PowerPoint (Mac)': 'No', Mobile: 'Yes', 'Is Deleted': 'False' }],
      sites: [{ 'Report Refresh Date': '2026-10-28', 'Site Id': 'site1', 'Site URL': '', 'Owner Principal Name': 'owner@x.com', 'Root Web Template': 'Group',
        'Last Activity Date': '', 'File Count': '0', 'Active File Count': '0', 'Page View Count': '0', 'Storage Used (Byte)': '1000', 'Storage Allocated (Byte)': '1', 'Is Deleted': 'False' },
        { 'Site Id': 'od', 'Root Web Template': 'Personal', 'Is Deleted': 'False' }]
    }
  };
}
const keep = [{ upn: 'kept@x.com', reason: 'test' }];
function F(b, id) { return b.review.findings.find(function (f) { return f.id === id; }); }

test('CSV parsing: BOM, quotes, CRLF, embedded commas', function () {
  const rows = M.parseCsv('﻿A,B,C\r\n1,"two, 2","say ""hi"""\r\n3,,\r\n');
  assert.deepStrictEqual(rows, [{ A: '1', B: 'two, 2', C: 'say "hi"' }, { A: '3', B: '', C: '' }]);
  assert.deepStrictEqual(M.parseCsv(''), []);
});

test('people, licenses and activity', function () {
  const b = M.build(raw(), { keep: keep, today: '2026-10-30' });
  const P = {};
  b.review.people.forEach(function (p) { P[p.upn] = p; });
  assert.strictEqual(b.ref, '2026-10-28');
  assert.strictEqual(P['active@x.com'].idle, 1);
  assert.strictEqual(P['active@x.com'].desktop, true);
  assert.strictEqual(P['web@x.com'].desktop, false);
  assert.strictEqual(P['kept@x.com'].idle, null);
  assert.strictEqual(P['shared@x.com'].mbx_type, 'Shared');
  assert.strictEqual(P['active@x.com'].teams_chats, 5);
  assert.deepStrictEqual(P['blocked@x.com'].paid, ['Microsoft 365 Business Premium', 'Exchange Online (Plan 2)']);
  assert.strictEqual(P['blocked@x.com'].cost, 36);
  assert.strictEqual(b.review.totals.guests, 1);
  assert.strictEqual(b.review.totals.blocked, 1);
  /* free SKUs never get a dollar line */
  assert.ok(!b.review.sku.some(function (k) { return k.price === 0; }));
  const prem = b.review.sku.find(function (k) { return k.part === 'SPB'; });
  assert.strictEqual(prem.unassigned, 1);
  assert.strictEqual(prem.wasted, 1);
  assert.strictEqual(b.review.subs[0].renew, '2026-11-15');
  assert.strictEqual(b.review.teams_dormant, 1);
});

test('cost rules: who, how much, keep list, no double counting', function () {
  const b = M.build(raw(), { keep: keep, today: '2026-10-30' });
  assert.deepStrictEqual(F(b, 'blocked').users, ['blocked@x.com']);
  assert.deepStrictEqual(F(b, 'idle90').users, ['idle@x.com']);           /* kept@ left out */
  assert.deepStrictEqual(F(b, 'idle90').kept, ['kept@x.com']);
  assert.deepStrictEqual(F(b, 'sharedlic').users, ['shared@x.com']);
  assert.deepStrictEqual(F(b, 'stacked').users, ['blocked@x.com']);
  assert.deepStrictEqual(F(b, 'std2basic').users, ['web@x.com']);
  assert.deepStrictEqual(F(b, 'dups').users, ['dup2@x.com']);
  assert.deepStrictEqual(F(b, 'bigmbx').users, ['active@x.com']);
  assert.strictEqual(F(b, 'std2basic').monthly, 6.86);
  /* 1 Premium seat month-to-month unassigned = cash; Basic + EXO also unassigned */
  assert.strictEqual(F(b, 'unassigned').monthly, 26.4 + 9.6);
  const s = b.review.savings;
  /* blocked(36) + idle(7.35) + shared(7.35) + dup2(14.21); the stacked EXO on a blocked account isn't counted twice */
  assert.strictEqual(s.cut_monthly, 64.91);
  assert.strictEqual(s.stacked_monthly, 0);
  assert.strictEqual(s.total_monthly, 64.91 + 6.86 + 36);
  /* exclude list (recently declined) takes accounts out of the rule */
  const b2 = M.build(raw(), { keep: keep, today: '2026-10-30', exclude: { idle90: ['idle@x.com'] } });
  assert.deepStrictEqual(F(b2, 'idle90').users, []);
});

test('usage payload: same shape as sharepoint-usage.json, names redacted', function () {
  const b = M.build(raw(), { keep: keep, today: '2026-10-30' });
  const t = b.usage.tenants[0];
  assert.strictEqual(t.tenant, 'Test Org');
  assert.strictEqual(t.sites.length, 1);                                   /* OneDrive site skipped */
  assert.strictEqual(t.sites[0].owner, 'o•••@x.com');
  assert.strictEqual(t.sites[0].verdict, 'Delete');
  assert.strictEqual(t.people.mailboxes[0]['User Principal Name'], 's•••@x.com');
  assert.ok(Array.isArray(t.teams) && Array.isArray(t.groups));
});

test('Claude\'s answer is checked: candidates only, savings recomputed', function () {
  const b = M.build(raw(), { keep: keep, today: '2026-10-30' });
  const s = AI.settle(b.review, { headline: 'h', lanes: [{ k: 'lic', t: 'Licensing', s: '$1', saw: ['a'], now: ['b'], next: ['c'], hip: 'd' }],
    recommendations: [
      { finding: 'idle90', title: 'Idle', category: 'Cut now', urgency: 'now', accounts: ['IDLE@x.com', 'kept@x.com', 'active@x.com'], why: '', action: '', hipaa: '', send_for_approval: true },
      { finding: 'premium', title: 'Premium', category: 'Cut now', urgency: '', accounts: [], why: '', action: '', hipaa: '', send_for_approval: true },
      { finding: 'unassigned', title: 'Seats', category: 'Cut now', urgency: '', accounts: [], why: '', action: '', hipaa: '', send_for_approval: true },
      { finding: 'idle30', title: 'Quiet', category: 'Review', urgency: '', accounts: [], why: '', action: '', hipaa: '', send_for_approval: true },
      { finding: 'other', title: 'Talk to the vendor', category: 'Review', urgency: '', accounts: ['nobody@x.com'], why: '', action: '', hipaa: '', send_for_approval: false }
    ] });
  const r = s.recommendations;
  assert.deepStrictEqual(r[0].users, ['idle@x.com']);                      /* kept@ and active@ dropped */
  assert.strictEqual(r[0].monthly, 7.35);
  assert.strictEqual(r[0].queue, true);
  assert.strictEqual(r[1].queue, false);                                   /* Premium never queued */
  assert.strictEqual(r[2].monthly, 36);
  assert.strictEqual(r[2].queue, true);
  assert.strictEqual(r[3].queue, false);                                   /* Review never queued */
  assert.deepStrictEqual(r[4].users, []);
  assert.strictEqual(r[4].monthly, null);
  assert.strictEqual(s.lanes[0].k, 'LIC');
  const d = AI.detailOf(r[0], b.review, { 'idle@x.com': b.review.people.find(function (p) { return p.upn === 'idle@x.com'; }) });
  assert.match(d, /Idle Ida — idle@x\.com — Basic — idle 120d/);
});

test('the brief Claude sees has the candidates and the decisions', function () {
  const b = M.build(raw(), { keep: keep, today: '2026-10-30' });
  const x = AI.brief(b.review, [], [{ rule: 'idle90', status: 'declined' }]);
  assert.strictEqual(x.findings.find(function (f) { return f.id === 'blocked'; }).candidates[0].upn, 'blocked@x.com');
  assert.strictEqual(x.decisions_by_people[0].status, 'declined');
  assert.ok(JSON.stringify(x).length < 100000);
});

test('pull(): Graph plumbing with a fake fetch', async function () {
  process.env.M365_CLIENT_ID = 'id'; process.env.M365_CLIENT_SECRET = 'secret'; process.env.M365_TENANT_ID = 'tenant';
  const seen = [];
  const r0 = raw();
  function res(status, body, text) {
    return { ok: status < 400, status: status, headers: { get: function () { return null; } },
      json: async function () { return body; }, text: async function () { return text !== undefined ? text : JSON.stringify(body); } };
  }
  function csv(rows) {
    if (!rows.length) { return ''; }
    const h = Object.keys(rows[0]);
    return h.join(',') + '\n' + rows.map(function (r) { return h.map(function (k) { return '"' + String(r[k] || '').replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
  }
  const map = { getOffice365ActiveUserDetail: 'active', getMailboxUsageDetail: 'mailboxes', getEmailActivityUserDetail: 'email',
    getTeamsUserActivityDetail: 'teamsUsers', getOneDriveUsageAccountDetail: 'onedrive', getM365AppUserDetail: 'apps',
    getSharePointSiteUsageDetail: 'sites', getOffice365GroupsActivityDetail: 'groups', getTeamsTeamActivityDetail: 'teams' };
  async function fake(url, init) {
    seen.push(url);
    if (/oauth2/.test(url)) { return res(200, { access_token: 'tok' }); }
    assert.strictEqual(init.headers.Authorization, 'Bearer tok');
    if (/\/organization/.test(url)) { return res(200, { value: [{ displayName: 'Test Org' }] }); }
    if (/\/subscribedSkus/.test(url)) { return res(200, { value: r0.skus }); }
    if (/\/users\?/.test(url)) {
      return /skiptoken/.test(url) ? res(200, { value: r0.users.slice(5) })
        : res(200, { value: r0.users.slice(0, 5), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=2' });
    }
    if (/directory\/subscriptions/.test(url)) { return res(403, { error: 'denied' }); }
    const m = url.match(/reports\/(\w+)\(/);
    if (m) { return res(200, null, csv(r0.reports[map[m[1]]])); }
    if (/\$batch/.test(url)) { return res(200, { responses: [] }); }
    return res(404, {});
  }
  const got = await M.pull(fake);
  assert.strictEqual(got.org, 'Test Org');
  assert.strictEqual(got.users.length, 9);                                 /* both pages */
  assert.strictEqual(got.reports.active.length, 8);
  assert.deepStrictEqual(got.reports.subs, []);
  assert.ok(got.warnings.some(function (w) { return /Subscriptions/.test(w) && /permission/.test(w); }));
  assert.ok(seen.some(function (u) { return /getM365AppUserDetail\(period='D180'\)\?\$format=text\/csv/.test(u); }));
  const b = M.build(got, { keep: keep, today: '2026-10-30' });
  assert.deepStrictEqual(F(b, 'idle90').users, ['idle@x.com']);
});
