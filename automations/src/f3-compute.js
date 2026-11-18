// Compute every field of data/fundraising-metrics.json from the Donorbox
// pull. Only aggregates leave this node: no names, emails, addresses or
// single gifts. A compact cache of past donations (ids, dates, amounts,
// donor id numbers) stays in this workflow's private static data so later
// runs can pull incrementally.
//__LIB__
const S = $getWorkflowStaticData('global');
const W = $('Window').first().json;
const now = phxNow();
const today = now.toISODate();

/* ── campaign map: automations/campaign-map.json in the repo ── */
let MAP = {};
try {
  const f = $('GET campaign map').first().json;
  MAP = JSON.parse(Buffer.from(String(f.content || ''), 'base64').toString('utf8')).map || {};
} catch (e) { MAP = {}; }
const PLAN_NAMES = {   /* most specific first; the map file wins over these */
  'giving-tuesday-2026': /giving tuesday 2026|fill the safety net/i, 'year-end-2026': /bed before the new year/i,
  'az-tax-credit': /tax credit/i, 'second-chances-2027': /second chances/i, 'rides-and-relief-2027': /rides and relief/i,
  'recovery-month-2027': /recovery month/i, 'the-sanctuary': /the sanctuary|monthly membership/i, 'safety-net': /safety net/i
};
function planIdFor(c) {
  if (MAP[String(c.id)]) { return MAP[String(c.id)]; }
  for (const k in PLAN_NAMES) { if (PLAN_NAMES[k].test(c.name || '')) { return k; } }
  return null;
}

/* ── donations: merge this pull into the cache ── */
const pulled = rows('GET donations');
const pii = new Set();           // used only for the leak check at the end
const cache = W.full ? {} : (S.donations || {});
pulled.forEach(function (d) {
  const donor = d.donor || {};
  if (donor.email) { pii.add(String(donor.email).toLowerCase()); }
  if (donor.first_name && donor.last_name) { pii.add((donor.first_name + ' ' + donor.last_name).toLowerCase()); }
  if (String(d.currency || 'usd').toLowerCase() !== 'usd') { return; }
  const net = (Number(d.amount) || 0) - (Number(d.amount_refunded) || 0);
  let feeCovered = null;
  ['fee_covered', 'cover_fee', 'processing_fee_covered', 'donor_covered_fee'].forEach(function (k) { if (k in d) { feeCovered = !!d[k]; } });
  cache[d.id] = [phxDate(d.donation_date), Math.round(net * 100) / 100, donor.id || null, (d.campaign || {}).id || null,
                 d.recurring ? 1 : 0, String(d.utm_source || '').toLowerCase().trim() || null, d.status === 'paid' ? 1 : 0, feeCovered];
});
S.donations = cache;
S.lastPull = now.toISO();
if (W.full) { S.lastFullPull = now.toISO(); }

const gifts = Object.keys(cache).map(function (id) {
  const r = cache[id];
  return { id: id, date: r[0], amount: r[1], donor: r[2], campaign: r[3], recurring: !!r[4], source: r[5], paid: !!r[6], fee: r[7] };
}).filter(function (g) { return g.paid && g.amount > 0; });

/* ── plans ── */
const plans = rows('GET plans');
plans.forEach(function (p) {
  const donor = p.donor || {};
  if (donor.email) { pii.add(String(donor.email).toLowerCase()); }
  if (donor.first_name && donor.last_name) { pii.add((donor.first_name + ' ' + donor.last_name).toLowerCase()); }
});
const monthly = plans.filter(function (p) { return String(p.type).toLowerCase() === 'monthly'; });
const active = monthly.filter(function (p) { return String(p.status).toLowerCase() === 'active'; });
/* status changes since the last run: lost members and recovered failed payments */
S.planStatus = S.planStatus || {};
S.lost = (S.lost || []).filter(function (x) { return x >= now.minus({ days: 30 }).toISODate(); });
S.recovered = (S.recovered || []).filter(function (x) { return x >= now.minus({ days: 30 }).toISODate(); });
monthly.forEach(function (p) {
  const was = S.planStatus[p.id], is = String(p.status).toLowerCase();
  if (was === 'active' && is !== 'active' && is !== 'failed') { S.lost.push(today); }
  if (was === 'failed' && is === 'active') { S.recovered.push(today); }
  S.planStatus[p.id] = is;
});
const tiers = { '10': 0, '25': 0, '50': 0, '100': 0, other: 0 };
let mrr = 0;
active.forEach(function (p) {
  const a = Number(p.amount) || 0;
  mrr += a;
  const k = String(Math.round(a));
  if (Math.abs(a - Math.round(a)) < 0.001 && tiers[k] !== undefined) { tiers[k]++; } else { tiers.other++; }
});
mrr = Math.round(mrr * 100) / 100;
S.mrr = S.mrr || {};
S.mrr[today.slice(0, 7)] = { mrrUsd: mrr, activeMembers: active.length };
const months = Object.keys(S.mrr).sort().slice(-24);

/* ── donors ── */
const firstGift = {}, firstIsOneTime = {};
gifts.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (g) {
  if (!g.donor) { return; }
  if (!firstGift[g.donor]) { firstGift[g.donor] = g.date; firstIsOneTime[g.donor] = !g.recurring; }
});
const d30 = now.minus({ days: 30 }).toISODate();
const newDonors30d = Object.keys(firstGift).filter(function (k) { return firstGift[k] > d30; }).length;
/* one-time donors whose first gift is at least 90 days old: how many started a monthly gift within 90 days */
const planStart = {};
monthly.forEach(function (p) {
  const id = (p.donor || {}).id;
  if (id && p.started_at && (!planStart[id] || p.started_at < planStart[id])) { planStart[id] = String(p.started_at).slice(0, 10); }
});
const d90 = now.minus({ days: 90 }).toISODate();
const cohort = Object.keys(firstGift).filter(function (k) { return firstIsOneTime[k] && firstGift[k] <= d90; });
const upgraded = cohort.filter(function (k) {
  return planStart[k] && planStart[k] >= firstGift[k] && planStart[k] <= DateTime.fromISO(firstGift[k]).plus({ days: 90 }).toISODate();
});
const withFee = gifts.filter(function (g) { return g.fee !== null; });

/* ── campaigns ── */
const camps = rows('GET campaigns').filter(function (c) { return String(c.currency || 'usd').toLowerCase() === 'usd'; });
const byCamp = {};
gifts.forEach(function (g) { (byCamp[g.campaign] = byCamp[g.campaign] || new Set()).add(g.donor); });
const campaigns = camps.map(function (c) {
  return { donorboxId: c.id, planId: planIdFor(c), name: c.name, raisedUsd: Number(c.total_raised) || 0,
           goalUsd: Number(c.goal_amt) || 0, donations: Number(c.donations_count) || 0,
           donors: byCamp[c.id] ? byCamp[c.id].size : 0,
           recurringPlans: active.filter(function (p) { return (p.campaign || {}).id === c.id; }).length };
});

/* ── daily, last 30 days; sources ── */
const daily = [];
for (let i = 29; i >= 0; i--) {
  const day = now.minus({ days: i }).toISODate();
  const g = gifts.filter(function (x) { return x.date === day; });
  daily.push({ date: day, raisedUsd: Math.round(g.reduce(function (s, x) { return s + x.amount; }, 0) * 100) / 100, donations: g.length });
}
const src = {};
gifts.forEach(function (g) { if (!g.source) { return; } src[g.source] = src[g.source] || { source: g.source, donations: 0, raisedUsd: 0 }; src[g.source].donations++; src[g.source].raisedUsd += g.amount; });
const bySource = Object.keys(src).map(function (k) { src[k].raisedUsd = Math.round(src[k].raisedUsd * 100) / 100; return src[k]; })
  .sort(function (a, b) { return b.raisedUsd - a.raisedUsd; });

/* ── automations: the run reports the workflows sent to the site ── */
const state = ($('GET state').first().json || {}).items || {};
const cut = Date.now() - 7 * 864e5;
const automations = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'].map(function (id) {
  const r = (state['run:' + id] || {}).data || {};
  const recent = (r.recent || []).filter(function (x) { return Date.parse(x.at) >= cut; });
  if (id === 'f3') { return { id: id, lastRun: now.toISO(), lastStatus: 'success', runs7d: recent.length + 1, errors7d: recent.filter(function (x) { return !x.ok; }).length }; }
  return { id: id, lastRun: r.lastRun || null, lastStatus: r.lastStatus || 'never', runs7d: recent.length, errors7d: recent.filter(function (x) { return !x.ok; }).length };
});

const out = {
  generatedAt: now.toISO({ suppressMilliseconds: true }),
  totals: {
    raisedUsd: Math.round(campaigns.reduce(function (s, c) { return s + c.raisedUsd; }, 0) * 100) / 100,
    donations: campaigns.reduce(function (s, c) { return s + c.donations; }, 0),
    donors: Object.keys(firstGift).length,
    newDonors30d: newDonors30d,
    activeMembers: active.length,
    mrrUsd: mrr,
    membersLost30d: S.lost.length,
    failedRecovered30d: S.recovered.length,
    feeCoverRatePct: withFee.length ? Math.round(withFee.filter(function (g) { return g.fee; }).length / withFee.length * 100) : null,
    upgradeRate90dPct: cohort.length ? Math.round(upgraded.length / cohort.length * 100) : 0
  },
  membersByTier: tiers,
  campaigns: campaigns,
  dailyRaised: daily,
  monthlyMrr: months.map(function (m) { return { month: m, mrrUsd: S.mrr[m].mrrUsd, activeMembers: S.mrr[m].activeMembers }; }),
  bySource: bySource,
  automations: automations
};

/* ── leak check: no email address or donor full name may appear ── */
const text = JSON.stringify(out).toLowerCase();
if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(text)) { throw new Error('Refusing to publish: the metrics contain an email address.'); }
pii.forEach(function (p) { if (p.length > 4 && text.indexOf(p) >= 0) { throw new Error('Refusing to publish: the metrics contain a donor name.'); } });

/* ── commit only when something other than the timestamps changed ── */
let current = null, sha = null;
try {
  const f = $('GET current file').first().json;
  sha = f.sha || null;
  current = f.content ? JSON.parse(Buffer.from(String(f.content), 'base64').toString('utf8')) : null;
} catch (e) { current = null; }
function key(m) {
  if (!m) { return ''; }
  return JSON.stringify(Object.assign({}, m, { generatedAt: null,
    automations: (m.automations || []).map(function (a) { return [a.id, a.lastStatus, a.errors7d]; }) }));
}
const changed = !current || !current.generatedAt || key(current) !== key(out);
return [{ json: {
  changed: changed,
  sha: sha,
  content: Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8').toString('base64'),
  message: 'Fundraising metrics: ' + money(out.totals.raisedUsd) + ' raised, ' + out.totals.activeMembers + ' members',
  summary: money(out.totals.raisedUsd) + ' raised · ' + out.totals.donors + ' donors · ' + out.totals.activeMembers + ' members' + (changed ? '' : ' (no change)')
} }];
