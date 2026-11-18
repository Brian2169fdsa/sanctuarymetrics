// f10 Weekly digest, Mondays 8 a.m. Phoenix. Aggregates only.
//__LIB__
const dec = function (n) { return JSON.parse(Buffer.from(String($(n).first().json.content || ''), 'base64').toString('utf8')); };
const M = dec('GET metrics'), plan = dec('GET plan');
const items = ($('GET state').first().json || {}).items || {};
const t = M.totals || {};
const now = phxNow(), weekAgo = now.minus({ days: 7 }).toISODate(), today = now.toISODate();
const week = (M.dailyRaised || []).filter(function (d) { return d.date > weekAgo && d.date <= today; });
const raised7 = week.reduce(function (s, d) { return s + (Number(d.raisedUsd) || 0); }, 0), gifts7 = week.reduce(function (s, d) { return s + (Number(d.donations) || 0); }, 0);
const planned = plan.socialPosts.filter(function (p) { return p.date && p.date > weekAgo && p.date <= today; });
Object.keys(items).forEach(function (k) { if (items[k].kind === 'copy' && items[k].data.date > weekAgo && items[k].data.date <= today) { planned.push({ id: k.replace(/^copy:/, '') }); } });
const posted = planned.filter(function (p) { return ((items['post:' + p.id] || {}).data || {}).status === 'posted'; }).length;
const errors = Object.keys(items).filter(function (k) { return items[k].kind === 'run'; }).map(function (k) {
  const r = items[k].data, n = (r.recent || []).filter(function (x) { return !x.ok && Date.parse(x.at) >= Date.now() - 7 * 864e5; }).length;
  return n ? k.replace('run:', '') + ': ' + n + ' error' + (n === 1 ? '' : 's') + (r.message ? ' (last: ' + r.message + ')' : '') : null;
}).filter(Boolean);
const lines = [
  ['Total raised', money(t.raisedUsd) + ' (' + money(raised7) + ' from ' + gifts7 + ' gifts this week)'],
  ['Donors', (t.donors || 0) + ' total, ' + (t.newDonors30d || 0) + ' new in the last 30 days'],
  ['Monthly members', (t.activeMembers || 0) + ' of a 50-member target (placeholder) · ' + money(t.mrrUsd) + ' a month'],
  ['Members lost, 30 days', String(t.membersLost30d || 0)],
  ['Posts published', posted + ' of ' + planned.length + ' planned this week'],
  ['Automation errors', errors.length ? errors.join('; ') : 'none']
];
const html = '<b>SCI fundraising, week to ' + esc(today) + '</b><br>' + (M.generatedAt ? '' : '<i>The metrics sync has not run yet; figures are zero.</i><br>') +
  '<table>' + lines.map(function (l) { return '<tr><td><b>' + esc(l[0]) + '</b></td><td>' + esc(l[1]) + '</td></tr>'; }).join('') + '</table>' +
  '<p><a href="' + esc(CFG.siteUrl) + '/fundraising.html">Open the Fundraising page</a></p>';
const out = [{ json: Object.assign({ route: 'teams' }, teams(html)) }];
(CFG.digestRecipients || []).forEach(function (to) {
  out.push({ json: { route: 'mail', url: 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(CFG.senderMailbox) + '/sendMail',
    body: { message: { subject: 'SCI fundraising: week to ' + today, body: { contentType: 'HTML', content: html },
      toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false } } });
});
return out;
