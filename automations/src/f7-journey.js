// f7 Donor journey and f8 Lapsed donors, once a day over the private donor list.
// Unsubscribe replies in the sending mailbox are applied first, so they are
// honored in this run and in every other sequence (f4-f6 read the same column).
//__LIB__
const today = phxNow();
const donors = graphRows('GET donor list');
const listBase = 'https://graph.microsoft.com/v1.0/sites/' + CFG.sharepointSiteId + '/lists/' + CFG.donorListId + '/items';
const out = [], count = { f7: 0, f8: 0, unsub: 0 };
function graph(method, url, body, flow) { out.push({ json: { method: method, url: url, body: body, flow: flow } }); }

/* unsubscribe replies */
const asked = {};
$('GET unsubscribe replies').all().forEach(function (i) {
  (i.json.value || []).forEach(function (m) {
    const from = (((m.from || {}).emailAddress || {}).address || '').toLowerCase();
    if (from && /unsubscribe/i.test((m.subject || '') + ' ' + (m.bodyPreview || ''))) { asked[from] = true; }
  });
});

/* TEMPLATES: review the wording, then set emailsApproved in Config. */
const T = {
  day1: ['Thank you from Joey', function (f) { return '<p>Dear ' + esc(f || 'friend') + ',</p><p>Thank you for your gift to Sanctuary Community Initiative. ' +
    'When treatment ends, the need for a safe bed, a ride to work and a valid ID does not. Your gift helps fund exactly that.</p><p>[REVIEW: Joey\'s own words]</p><p>Joey<br>[Title]</p>'; }],
  day14: ['What your gift makes possible', function (f) { return '<p>Dear ' + esc(f || 'friend') + ',</p><p>Two weeks ago you gave to the safety net. ' +
    'Among Sanctuary participants since July 2025, 94% had no new arrests across all check-ins. Stable housing and practical support are what that number is made of.</p>' +
    '<p>[REVIEW: one released story or a housing staff note, if available]</p><p>[Signature]</p>'; }],
  day60: ['Be the steady support', function (f) { return '<p>Dear ' + esc(f || 'friend') + ',</p><p>A one-time gift covers a ride. A monthly gift keeps a bed open. ' +
    'Would you join The Sanctuary, our monthly givers, from $10 a month? <a href="' + esc(CFG.wallOfSupportUrl) + '">Join The Sanctuary</a>.</p><p>[Signature]</p>'; }],
  month11: ['A year of support', function (f) { return '<p>Dear ' + esc(f || 'friend') + ',</p><p>Almost a year ago you gave to Sanctuary Community Initiative. ' +
    'Would you renew your support this year? [REVIEW: link to the current campaign]</p><p>[Signature]</p>'; }]
};

donors.forEach(function (r) {
  const f = r.fields || {}, email = String(f.Email || '').toLowerCase();
  if (email && asked[email] && !f.Unsubscribed) { graph('PATCH', listBase + '/' + r.id + '/fields', { Unsubscribed: true }, 'unsub'); count.unsub++; f.Unsubscribed = true; }
  const patch = {};
  /* f8: lapsed — no gift in 12 months */
  if (f.LastGiftDate && DateTime.fromISO(String(f.LastGiftDate).slice(0, 10)) <= today.minus({ months: 12 }) && f.Segment !== 'october-reactivation') {
    patch.Segment = 'october-reactivation'; count.f8++;
  }
  /* f7: one journey step per donor per day, in order */
  if (!f.Unsubscribed && email && f.FirstGiftDate) {
    const days = Math.floor(today.diff(DateTime.fromISO(String(f.FirstGiftDate).slice(0, 10)), 'days').days);
    const sinceLast = f.LastGiftDate ? today.diff(DateTime.fromISO(String(f.LastGiftDate).slice(0, 10)), 'months').months : 0;
    const step = f.JourneyStep || 'new';
    let send = null, next = null;
    if (step === 'new' && days >= 1) { send = 'day1'; next = 'thanked'; }
    else if (step === 'thanked' && days >= 14) { send = 'day14'; next = 'impact'; }
    else if (step === 'impact' && days >= 60) { if (!f.Recurring) { send = 'day60'; } next = 'upgrade-asked'; }
    else if ((step === 'upgrade-asked' || step === 'renewed') && sinceLast >= 11 && f.JourneyRenewalFor !== String(f.LastGiftDate)) {
      send = 'month11'; next = 'renewed'; patch.JourneyRenewalFor = String(f.LastGiftDate);
    }
    if (next) { patch.JourneyStep = next; patch.JourneyAt = today.toISODate(); }
    if (send) {
      const m = mail(email, T[send][0], T[send][1](f.FirstName));
      graph('POST', m.url, m.body, 'f7'); count.f7++;
    }
  }
  if (Object.keys(patch).length) { graph('PATCH', listBase + '/' + r.id + '/fields', patch, 'f7'); }
});
$getWorkflowStaticData('global').counts = count;
return out;
