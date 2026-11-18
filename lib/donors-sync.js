/* ============================================================================
   Donorbox → SCI donors sync (stage 2). Off unless DONORBOX_SYNC_ENABLED=true
   and DONORBOX_EMAIL / DONORBOX_API_KEY are set in Vercel. Read-only: GET
   /donors, /donations and /plans, HTTP Basic auth.

   Matching, per Donorbox supporter record:
     1. a donor already linked to that Donorbox id
     2. otherwise a donor with exactly the same name (the seeded records); the
        id is linked to them, so duplicate supporter records for one person
        merge into one donor
     3. otherwise it waits in "Unmatched records" for a person to link, add
        or ignore. Names in DONOR_CONFIG.excludeNames (test records) are skipped.

   What it updates: Donorbox gift history (replacing the seed figures once a
   donor has Donorbox gifts), and monthly status and amount from active
   monthly plans. What it never touches: gift tracker statuses, addresses,
   notes, and the Staff / Anonymous / Offline flags. New owed items are added
   (a tier upgrade) without changing items already created.
   ========================================================================== */

const C = require('./donors-config');

const BASE = () => (process.env.DONORBOX_API_BASE || 'https://donorbox.org/api/v1').replace(/\/+$/, '');

async function pages(path) {
  const auth = 'Basic ' + Buffer.from(process.env.DONORBOX_EMAIL + ':' + process.env.DONORBOX_API_KEY).toString('base64');
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const r = await fetch(BASE() + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'per_page=100&page=' + page, { headers: { Authorization: auth } });
    if (!r.ok) { throw new Error('Donorbox ' + path + ' answered ' + r.status); }
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) { break; }
    list.forEach(function (x) { out.push(x); });
    if (list.length < 100) { break; }
  }
  return out;
}
function phx(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function fullName(p) { return String(p.name || ((p.first_name || '') + ' ' + (p.last_name || ''))).trim(); }

async function run(me, D) {
  const by = (me && me.name) || 'Donorbox sync';
  const { db, T, nameKey, money } = D;
  const [supporters, donations, plans] = await Promise.all([pages('/donors'), pages('/donations'), pages('/plans')]);
  const excluded = function (name) { return C.DONOR_CONFIG.excludeNames.some(function (re) { return re.test(name); }); };

  let donors = await db.get(T.donors, '?select=id,name,name_key,donorbox_ids,monthly_amount,monthly_source,synced_at');
  const ignored = {};
  (await db.get(T.unmatched, '?select=donorbox_id,resolution')).forEach(function (u) { if (u.resolution === 'ignored') { ignored[u.donorbox_id] = 1; } });
  const byId = {}, byKey = {};
  donors.forEach(function (d) { (d.donorbox_ids || []).forEach(function (x) { byId[x] = d; }); byKey[d.name_key] = d; });

  /* every supporter seen in /donors, /donations or /plans */
  const people = {};
  const see = function (p) {
    if (!p || p.id === undefined) { return; }
    const n = fullName(p);
    people[p.id] = people[p.id] || { id: Number(p.id), name: n, total: 0, gifts: 0, last: null };
    if (!people[p.id].name && n) { people[p.id].name = n; }
  };
  supporters.forEach(see);
  donations.forEach(function (d) { see(d.donor); });
  plans.forEach(function (p) { see(p.donor); });

  /* link by id, then by exact name */
  const links = {}, unmatched = [];
  let linked = 0;
  Object.keys(people).forEach(function (k) {
    const p = people[k];
    if (excluded(p.name) || ignored[p.id]) { return; }
    let d = byId[p.id];
    if (!d && p.name && byKey[nameKey(p.name)]) {
      d = byKey[nameKey(p.name)];
      d.donorbox_ids = (d.donorbox_ids || []).concat([p.id]);
      byId[p.id] = d; links[d.id] = d; linked++;
    }
    if (d) { p.donor = d; } else { unmatched.push(p); }
  });
  for (const k of Object.keys(links)) { await db.patch(T.donors, '?id=eq.' + k, { donorbox_ids: links[k].donorbox_ids }); }

  /* gifts */
  const giftRows = [];
  donations.forEach(function (g) {
    const p = people[(g.donor || {}).id];
    const net = money((Number(g.amount) || 0) - (Number(g.amount_refunded) || 0));
    if (p) { if (net > 0 && g.status !== 'refunded') { p.gifts++; p.total = money(p.total + net); const day = phx(g.donation_date); if (!p.last || day > p.last) { p.last = day; } } }
    if (!p || !p.donor || !(net > 0) || g.status === 'refunded' || String(g.currency || 'usd').toLowerCase() !== 'usd') { return; }
    const type = String(g.donation_type || '').toLowerCase();
    giftRows.push({ donor_id: p.donor.id, gift_date: phx(g.donation_date), amount: net, campaign: String((g.campaign || {}).name || '').slice(0, 120),
                    kind: /offline|cash|check|cheque/.test(type) ? 'offline' : (g.recurring ? 'recurring' : 'one-time'),
                    source: 'donorbox', donorbox_donation_id: Number(g.id) });
  });
  if (giftRows.length) { await db.upsert(T.gifts, 'donorbox_donation_id', giftRows); }
  /* gifts refunded since the last sync */
  const keep = {};
  giftRows.forEach(function (g) { keep[g.donorbox_donation_id] = 1; });
  const old = await db.get(T.gifts, '?source=eq.donorbox&select=id,donorbox_donation_id');
  for (const g of old) { if (!keep[g.donorbox_donation_id]) { await db.del(T.gifts, '?id=eq.' + g.id); } }

  /* monthly status from active monthly plans (base amount, before covered fees) */
  const monthly = {};
  plans.forEach(function (p) {
    const person = people[(p.donor || {}).id];
    if (!person || !person.donor || String(p.type).toLowerCase() !== 'monthly' || String(p.status).toLowerCase() !== 'active') { return; }
    monthly[person.donor.id] = (monthly[person.donor.id] || 0) + C.baseAmount(p.amount);
  });
  const now = new Date().toISOString();
  const touched = {};
  Object.keys(people).forEach(function (k) { if (people[k].donor) { touched[people[k].donor.id] = people[k].donor; } });
  for (const id of Object.keys(touched)) {
    const d = touched[id], m = monthly[id] || 0;
    const f = { synced_at: d.synced_at || (giftRows.some(function (g) { return g.donor_id === id; }) ? now : null) };
    if (m !== Number(d.monthly_amount) || (m > 0 && d.monthly_source !== 'donorbox')) {
      f.monthly_amount = m; f.monthly_source = m > 0 ? 'donorbox' : 'none';
      await D.log(id, by, 'monthly status from Donorbox', { monthly: m });
    }
    if (!f.synced_at) { delete f.synced_at; }
    if (Object.keys(f).length) { await db.patch(T.donors, '?id=eq.' + id, f); }
  }

  /* unmatched records wait for a person */
  if (unmatched.length) {
    await db.upsert(T.unmatched, 'donorbox_id', unmatched.map(function (p) {
      return { donorbox_id: p.id, name: p.name, total: p.total, gifts: p.gifts, last_gift: p.last, seen_at: now };
    }));
  }
  const added = await D.reconcile(by);
  const summary = { at: now, by: by, supporters: Object.keys(people).length, gifts: giftRows.length, linked: linked, unmatched: unmatched.length, itemsAdded: added };
  await db.upsert(T.settings, 'key', [{ key: 'last_sync', value: summary, updated_by_name: by, updated_at: now }]);
  await D.log(null, by, 'Donorbox sync', summary);
  return summary;
}

module.exports = { run: run };
