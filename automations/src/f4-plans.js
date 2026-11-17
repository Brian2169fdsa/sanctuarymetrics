// f4 New member, f5 Failed payment, f6 Cancelled plan — one pass over the
// plans every hour, comparing each plan's status with the last run.
// The first run only records statuses; it sends nothing.
//__LIB__
const S = $getWorkflowStaticData('global');
const today = phxNow().toISODate();
const plans = rows('GET plans').filter(function (p) { return String(p.type).toLowerCase() === 'monthly'; });
const donors = graphRows('GET donor list');
const byDonor = {}, unsub = {};
donors.forEach(function (r) {
  const f = r.fields || {};
  if (f.DonorboxDonorId) { byDonor[String(f.DonorboxDonorId)] = r; }
  if (f.Unsubscribed && f.Email) { unsub[String(f.Email).toLowerCase()] = true; }
});
const listBase = 'https://graph.microsoft.com/v1.0/sites/' + CFG.sharepointSiteId + '/lists/' + CFG.donorListId + '/items';
const TIERS = { 10: 'Cactus Wren', 25: "Gambel's Quail", 50: "Harris's Hawk", 100: 'Phoenix' };
function tierOf(a) { a = Number(a) || 0; return a >= 100 ? 'Phoenix' : (TIERS[Math.round(a)] || (a >= 50 ? "Harris's Hawk" : a >= 25 ? "Gambel's Quail" : 'Cactus Wren')); }
const out = [], count = { f4: 0, f5: 0, f6: 0 };
function graph(method, url, body, flow) { out.push({ json: { method: method, url: url, body: body, flow: flow } }); }
function email(p, subject, html, flow) {
  const to = String((p.donor || {}).email || '').toLowerCase();
  if (!to || unsub[to]) { return; }                       /* unsubscribes are honored in every sequence */
  const m = mail(to, subject, html); graph('POST', m.url, m.body, flow);
}
function setFields(p, fields, flow) {
  const row = byDonor[String((p.donor || {}).id)];
  if (row) { graph('PATCH', listBase + '/' + row.id + '/fields', fields, flow); }
  else {
    const d = p.donor || {};
    graph('POST', listBase, { fields: Object.assign({ Title: ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || 'Donor ' + d.id,
      DonorboxDonorId: String(d.id), FirstName: d.first_name || '', LastName: d.last_name || '', Email: d.email || '' }, fields) }, flow);
  }
}
function task(title, flow) {
  graph('POST', 'https://graph.microsoft.com/v1.0/planner/tasks', { planId: CFG.plannerPlanId, bucketId: CFG.plannerBucketId, title: title,
    dueDateTime: DateTime.now().plus({ days: 3 }).toUTC().toISO() }, flow);
}

/* TEMPLATES: review the wording, then set emailsApproved in Config. Do not
   add participant stories or statistics that aren't in the plan data. */
const T = {
  welcome: function (first, tier) { return '<p>Dear ' + esc(first || 'friend') + ',</p><p>Welcome to The Sanctuary, at the ' + esc(tier) +
    ' level. Your monthly gift is the steady support that keeps housing, rides and IDs within reach for people leaving treatment or incarceration.</p>' +
    '<p>We would like to thank you on our Wall of Support. Reply with the name you would like shown, or "anonymous" if you would rather not be listed.</p>' +
    '<p>[REVIEW: welcome kit line, once decision d3 on member merchandise is made]</p><p>With gratitude,<br>[Signature]</p>'; },
  failed: function (first, day) { return '<p>Dear ' + esc(first || 'friend') + ',</p><p>' + (day === 0 ? 'Your monthly gift to The Sanctuary did not go through.' :
    'A quick reminder: your monthly gift to The Sanctuary is still paused because the payment did not go through.') +
    ' It is usually an expired or replaced card. You can update it in a minute here: <a href="' + esc(CFG.donorPortalUrl) + '">' + esc(CFG.donorPortalUrl) + '</a>.</p>' +
    '<p>Thank you for being part of the steady support.<br>[Signature]</p>'; },
  exit: function (first) { return '<p>Dear ' + esc(first || 'friend') + ',</p><p>Your monthly gift to The Sanctuary has ended. Thank you for every month you gave.</p>' +
    '<p>If you are willing, one question: what was the main reason you stopped? Just reply to this email. Every answer is read.</p><p>[Signature]</p>'; }
};

S.status = S.status || {};
S.failed = S.failed || {};
const first = !S.initialized;
plans.forEach(function (p) {
  const id = String(p.id), is = String(p.status).toLowerCase(), was = S.status[id];
  S.status[id] = is;
  if (first) { if (is === 'failed') { S.failed[id] = { since: today, sent: [0, 3, 7] }; } return; }
  const d = p.donor || {}, name = shortName(d.first_name, d.last_name);
  /* f4: a plan we haven't seen, now active */
  if (was === undefined && is === 'active') {
    const tier = tierOf(p.amount);
    setFields(p, { Tier: tier, Recurring: true, MemberSince: String(p.started_at || today).slice(0, 10) }, 'f4');
    task('Welcome kit: ' + name + ' (' + tier + ', $' + Math.round(Number(p.amount) || 0) + '/month)', 'f4');
    email(p, 'Welcome to The Sanctuary', T.welcome(d.first_name, tier), 'f4');
    count.f4++;
  }
  /* f5: failed payment, emails on day 0, 3 and 7, flagged after day 7 */
  if (is === 'failed' && !S.failed[id]) { S.failed[id] = { since: today, sent: [] }; }
  if (is === 'active' && S.failed[id]) { delete S.failed[id]; setFields(p, { PaymentIssue: false }, 'f5'); }
  if (S.failed[id] && is === 'failed') {
    const f = S.failed[id], age = Math.floor(DateTime.fromISO(today).diff(DateTime.fromISO(f.since), 'days').days);
    [0, 3, 7].forEach(function (day) {
      if (age >= day && f.sent.indexOf(day) < 0) {
        f.sent.push(day);
        if (age - day <= 1) { email(p, day === 0 ? 'Your monthly gift did not go through' : 'Reminder: please update your card', T.failed(d.first_name, day), 'f5'); count.f5++; }
      }
    });
    if (age > 7 && !f.flagged) {
      f.flagged = true;
      setFields(p, { PaymentIssue: true }, 'f5');
      graph('POST', teams('').url, teams('<b>Failed monthly payment, day 8:</b> ' + esc(name) + ' ($' + Math.round(Number(p.amount) || 0) +
        '/month). Three emails sent; a personal follow-up may help.').body, 'f5');
    }
  }
  /* f6: cancelled */
  if (was && was !== 'cancelled' && is === 'cancelled') {
    delete S.failed[id];
    setFields(p, { Recurring: false, CancelledOn: today }, 'f6');
    email(p, 'Thank you, and one question', T.exit(d.first_name), 'f6');
    task('Personal note to ' + name + ': cancelled their $' + Math.round(Number(p.amount) || 0) + '/month gift', 'f6');
    count.f6++;
  }
});
S.initialized = true;
S.counts = count;
return out;
