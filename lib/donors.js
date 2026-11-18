/* ============================================================================
   /api/donors — "Who's giving": SCI donors and the member-gift tracker.

   PRIVATE DATA. Donor names, gift history and addresses come only from the
   Supabase tables in supabase/donors.sql and leave this function only for a
   signed-in person with Reports access, using their OWN account (the shared
   team password is refused, so "sent by" is always a real person). The
   button count (?count=1) returns a number, never a name. Emails, phone
   numbers and payment details are never stored or returned.

   Served from /api/projects?store=donors (vercel.json rewrites /api/donors to
   it): the site is at Vercel's 12-function limit.

   Routes (signed in, Reports access; "admin" = site admins only):
     GET    ?count=1                    {toSend}
     GET                                the Donors view: donors (no addresses), queue, charts data, config
     GET    ?id=<donor>                 one donor: address, gift history, items, change log
     PATCH  ?id=<donor> {staff, anonymous, offline, notes, address, monthly_amount}
     PUT    ?action=item&id=<item> {status, size, method, sent_on, tracking}
     POST   ?action=sent&id=<item>      mark sent today by the signed-in person
     POST   ?action=gift&id=<donor> {date, amount, campaign, note}   offline gift (fallback form)
     DELETE ?action=gift&id=<gift>      remove a hand-entered gift
     POST   ?action=import {csv, commit}       admin: preview, then write (seed import)
     POST   ?action=donor {name}               admin: add a donor by hand
     PUT    ?action=settings {thankYou}        admin: the thank-you rule
     POST   ?action=resolve {donorbox_id, to}  admin: unmatched Donorbox record → donor id | 'new' | 'ignore'
     POST   ?action=sync                       admin, or Vercel cron with CRON_SECRET: Donorbox sync
   ========================================================================== */

const { sendJSON, readBody, supabase } = require('./db');
const { authorize, access } = require('./auth');
const C = require('./donors-config');

const T = { donors: 'sci_donors', gifts: 'sci_gifts', items: 'sci_fulfillment', log: 'sci_donor_log',
            unmatched: 'sci_donorbox_unmatched', settings: 'sci_donor_settings' };
const ID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_STATUS = ['not-owed', 'owed', 'packed', 'sent', 'delivered', 'declined'];
const OPEN = { owed: 1, packed: 1 };            /* not yet sent */

function bad(m) { const e = new Error(m); e.bad = true; return e; }
function nameKey(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function phxToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max); }

const db = {
  get: (t, q) => supabase('GET', q, null, null, t),
  insert: (t, rows, prefer) => supabase('POST', '', rows, { Prefer: prefer || 'return=representation' }, t),
  upsert: (t, conflict, rows, ignore) => supabase('POST', '?on_conflict=' + conflict, rows,
    { Prefer: (ignore ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates') + ',return=representation' }, t),
  patch: (t, q, fields) => supabase('PATCH', q, fields, null, t),
  del: (t, q) => supabase('DELETE', q, null, { Prefer: 'return=minimal' }, t)
};
function log(donorId, by, action, detail) {
  return db.insert(T.log, [{ donor_id: donorId || null, by_name: by, action: action, detail: detail || {} }], 'return=minimal');
}

/* ── settings ──────────────────────────────────────────────────────────── */
async function settings() {
  const rows = await db.get(T.settings, '?select=key,value,updated_by_name,updated_at');
  const out = {};
  (rows || []).forEach(function (r) { out[r.key] = r; });
  const ty = Object.assign({}, C.DONOR_CONFIG.thankYouDefault, (out.thank_you && out.thank_you.value) || {});
  return { thankYou: ty, lastSync: out.last_sync ? out.last_sync.value : null };
}

/* ── derived figures ───────────────────────────────────────────────────── */
function summarize(d, gifts) {
  const mine = gifts.filter(function (g) { return g.donor_id === d.id; });
  const synced = mine.filter(function (g) { return g.source === 'donorbox'; });
  const manual = mine.filter(function (g) { return g.source === 'manual'; });
  const base = d.synced_at ? synced : null;
  const sum = function (l) { return l.reduce(function (s, g) { return s + Number(g.amount); }, 0); };
  let total = (base ? sum(base) : Number(d.seed_total)) + sum(manual);
  let count = (base ? base.length : d.seed_gifts) + manual.length;
  let last = base ? null : d.seed_last;
  (base || []).concat(manual).forEach(function (g) { if (!last || g.gift_date > last) { last = g.gift_date; } });
  const monthly = Number(d.monthly_amount) || 0;
  const offlineGifts = mine.filter(function (g) { return g.kind === 'offline'; });
  const tier = monthly > 0 ? C.tierFor(monthly) : null;
  return {
    total: money(total), gifts: count, last: last || null, monthly: monthly,
    type: monthly > 0 ? 'monthly' : (d.offline || (mine.length && offlineGifts.length === mine.length) ? 'offline' : 'one-time'),
    tier: tier ? tier.name : null, giftRows: mine
  };
}
function display(item, d) {
  if (item.status === 'owed' && !String(d.address || '').trim() && item.method !== 'hand-delivered') { return 'address-needed'; }
  return item.status;
}
/* what a donor is owed now, from their tier or the thank-you rule */
function owed(d, s, rule) {
  if (s.monthly > 0) { return C.tierItems(C.tierFor(s.monthly)); }
  const item = rule.item || 'Thank-you note';
  if (rule.mode === 'off') { return []; }
  if (rule.mode === 'min-total') { return s.total >= Number(rule.minUsd || 0) ? [{ item: item, reason: 'Thank-you rule' }] : []; }
  if (rule.mode === 'per-gift' && s.giftRows.length) {
    return s.giftRows.map(function (g) { return { item: item + ' (gift of ' + g.gift_date + ')', reason: 'Thank-you rule' }; });
  }
  return [{ item: item, reason: 'Thank-you rule' }];
}
/* add missing owed items. Never changes or removes an existing item, so a
   tier upgrade adds the new item as Owed and leaves sent ones alone. */
async function reconcile(by) {
  const [donors, gifts, items, st] = await Promise.all([
    db.get(T.donors, '?select=*'), db.get(T.gifts, '?select=*'), db.get(T.items, '?select=donor_id,item'), settings()
  ]);
  const have = {};
  items.forEach(function (i) { have[i.donor_id + '|' + i.item] = 1; });
  const add = [];
  donors.forEach(function (d) {
    owed(d, summarize(d, gifts), st.thankYou).forEach(function (o) {
      if (!have[d.id + '|' + o.item]) {
        have[d.id + '|' + o.item] = 1;
        add.push({ donor_id: d.id, item: o.item, apparel: !!o.apparel, reason: o.reason, status: 'owed', updated_by_name: by });
      }
    });
  });
  if (add.length) {
    await db.upsert(T.items, 'donor_id,item', add, true);
    await db.insert(T.log, add.map(function (a) { return { donor_id: a.donor_id, by_name: by, action: 'item added', detail: { item: a.item, reason: a.reason } }; }), 'return=minimal');
  }
  return add.length;
}

/* ── the Donors view ───────────────────────────────────────────────────── */
function publicConfig() {
  const c = C.DONOR_CONFIG;
  return { tiers: c.tiers, statuses: c.statuses, methods: c.methods, thankYouDefault: c.thankYouDefault };
}
async function view(isAdmin) {
  const [donors, gifts, items, st] = await Promise.all([
    db.get(T.donors, '?select=*&order=name.asc'), db.get(T.gifts, '?select=*'),
    db.get(T.items, '?select=*&order=created_at.asc'), settings()
  ]);
  const byMonth = {};
  gifts.forEach(function (g) {
    const m = String(g.gift_date).slice(0, 7);
    byMonth[m] = byMonth[m] || { month: m, gifts: 0, amount: 0 };
    byMonth[m].gifts++; byMonth[m].amount = money(byMonth[m].amount + Number(g.amount));
  });
  const list = donors.map(function (d) {
    const s = summarize(d, gifts);
    return {
      id: d.id, name: d.name, staff: d.staff, anonymous: d.anonymous, offline: d.offline, notes: d.notes,
      total: s.total, gifts: s.gifts, last: s.last, type: s.type, monthly: s.monthly, monthlySource: d.monthly_source, tier: s.tier,
      hasAddress: !!String(d.address || '').trim(), linked: (d.donorbox_ids || []).length > 0, synced: !!d.synced_at,
      items: items.filter(function (i) { return i.donor_id === d.id; }).map(function (i) {
        return Object.assign({}, i, { display: display(i, d) });
      })
    };
  });
  const out = {
    donors: list, giftsByMonth: Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; }),
    config: publicConfig(), thankYou: st.thankYou, lastSync: st.lastSync,
    sync: { enabled: syncEnabled(), configured: !!(process.env.DONORBOX_EMAIL && process.env.DONORBOX_API_KEY) },
    admin: isAdmin
  };
  if (isAdmin) { out.unmatched = await db.get(T.unmatched, '?select=*&resolution=is.null&order=name.asc'); }
  return out;
}
/* the button's number: items owed (including address needed) or packed */
async function toSend() {
  const items = await db.get(T.items, '?select=id&status=in.(owed,packed)');
  return items.length;
}

/* ── the seed import ───────────────────────────────────────────────────── */
function parseCsv(textIn) {
  const src = String(textIn || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const first = src.split('\n')[0] || '';
  const delim = first.indexOf('\t') >= 0 ? '\t' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') { q = false; } else { cell += ch; }
    } else if (ch === '"') { q = true; }
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else { cell += ch; }
  }
  row.push(cell); rows.push(row);
  return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
}
const COLS = { donorname: 'name', name: 'name', totalgiven: 'total', numberofgifts: 'gifts', gifts: 'gifts', mostrecentgift: 'last',
               notes: 'notes', staff: 'staff', anonymous: 'anonymous', offline: 'offline', monthlyamount: 'monthly' };
function yes(v) { return /^(y|yes|true|1|x)$/i.test(String(v || '').trim()); }
function amount(v) {
  const s = String(v || '').replace(/[$,\s]/g, '');
  if (s === '') { return 0; }
  if (!/^\d+(\.\d+)?$/.test(s)) { throw bad('not an amount: ' + v); }
  return money(s);
}
function date(v) {
  const s = String(v || '').trim();
  if (!s) { return null; }
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) { return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0'); }
  if (DATE.test(s)) { return s; }
  throw bad('not a date (use MM/DD/YYYY): ' + v);
}
async function importCsv(body, me) {
  const rows = parseCsv(body.csv);
  if (rows.length < 2) { throw bad('Paste the CSV with its header row: Donor Name, Total Given, Number of Gifts, Most Recent Gift, Notes.'); }
  const head = rows[0].map(function (h) { return COLS[String(h).toLowerCase().replace(/[^a-z]/g, '')] || null; });
  ['name', 'total', 'gifts', 'last'].forEach(function (k) {
    if (head.indexOf(k) < 0) { throw bad('Missing column: ' + { name: 'Donor Name', total: 'Total Given', gifts: 'Number of Gifts', last: 'Most Recent Gift' }[k]); }
  });
  const existing = await db.get(T.donors, '?select=id,name_key,seed_total,seed_gifts,seed_last,monthly_amount,monthly_source');
  const byKey = {};
  existing.forEach(function (d) { byKey[d.name_key] = d; });
  const seen = {}, preview = [];
  rows.slice(1).forEach(function (r, n) {
    const v = {};
    head.forEach(function (k, i) { if (k) { v[k] = r[i] === undefined ? '' : String(r[i]).trim(); } });
    const line = { row: n + 2, name: text(v.name, 200) };
    try {
      if (!line.name) { throw bad('no name'); }
      const key = nameKey(line.name);
      if (seen[key]) { throw bad('listed twice'); }
      seen[key] = 1;
      line.total = amount(v.total);
      line.gifts = parseInt(String(v.gifts || '0').replace(/[^\d]/g, ''), 10) || 0;
      line.last = date(v.last);
      line.notes = text(v.notes, 2000);
      line.staff = 'staff' in v ? yes(v.staff) : false;
      line.anonymous = 'anonymous' in v ? yes(v.anonymous) : false;
      line.offline = 'offline' in v ? yes(v.offline) : /\boffline\b/i.test(line.notes);
      line.monthly = 'monthly' in v && String(v.monthly).trim() ? C.baseAmount(amount(v.monthly)) : null;
      const ex = byKey[key];
      if (!ex) { line.action = 'new'; }
      else {
        line.id = ex.id;
        const same = Number(ex.seed_total) === line.total && ex.seed_gifts === line.gifts && (ex.seed_last || null) === line.last &&
          (line.monthly === null || ex.monthly_source === 'team' || ex.monthly_source === 'donorbox' || Number(ex.monthly_amount) === line.monthly);
        line.action = same ? 'unchanged' : 'update';
      }
    } catch (e) { line.action = 'error'; line.error = e.message; }
    preview.push(line);
  });
  const ok = preview.filter(function (l) { return l.action !== 'error'; });
  const result = {
    preview: preview,
    totals: { donors: ok.length, total: money(ok.reduce(function (s, l) { return s + l.total; }, 0)), gifts: ok.reduce(function (s, l) { return s + l.gifts; }, 0),
              errors: preview.length - ok.length }
  };
  if (!body.commit) { return result; }
  if (result.totals.errors) { throw bad('Fix the rows marked as errors first; nothing was written.'); }
  const by = me.name;
  for (const l of ok) {
    if (l.action === 'new') {
      const row = { name: l.name, name_key: nameKey(l.name), staff: l.staff, anonymous: l.anonymous, offline: l.offline, notes: l.notes,
                    seed_total: l.total, seed_gifts: l.gifts, seed_last: l.last, updated_by_name: by };
      if (l.monthly) { row.monthly_amount = l.monthly; row.monthly_source = 'import'; }
      const made = await db.insert(T.donors, [row]);
      await log(made[0].id, by, 'imported', { total: l.total, gifts: l.gifts, last: l.last });
    } else if (l.action === 'update') {
      /* giving figures only: flags, notes, addresses and gift statuses are the team's */
      const ex = byKey[nameKey(l.name)];
      const f = { seed_total: l.total, seed_gifts: l.gifts, seed_last: l.last, updated_at: new Date().toISOString(), updated_by_name: by };
      if (l.monthly !== null && (ex.monthly_source === 'none' || ex.monthly_source === 'import')) { f.monthly_amount = l.monthly; f.monthly_source = 'import'; }
      await db.patch(T.donors, '?id=eq.' + ex.id, f);
      await log(ex.id, by, 'import updated figures', { total: l.total, gifts: l.gifts, last: l.last });
    }
  }
  result.itemsAdded = await reconcile(by);
  result.written = true;
  return result;
}

/* ── the Donorbox sync (off until DONORBOX_SYNC_ENABLED=true) ──────────── */
function syncEnabled() {
  return process.env.DONORBOX_SYNC_ENABLED === 'true' && !!process.env.DONORBOX_EMAIL && !!process.env.DONORBOX_API_KEY;
}

async function handle(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Donor storage is not set up on this deployment.' });
  }
  const q = new URL(req.url, 'http://x').searchParams;
  const action = q.get('action') || '';
  const id = q.get('id') || '';

  /* the daily Vercel cron: sync only, and only with the cron secret */
  const auth = String(req.headers.authorization || '');
  if (action === 'sync' && process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET) {
    if (!syncEnabled()) { return sendJSON(res, 200, { skipped: 'Donorbox sync is switched off (DONORBOX_SYNC_ENABLED).' }); }
    const r = await require('./donors-sync').run({ name: 'Donorbox sync (scheduled)' }, module.exports);
    return sendJSON(res, 200, r);
  }

  const who = await authorize(req);
  if (!who) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see donors.' }); }
  const me = who.user;
  if (!me) { return sendJSON(res, 403, { error: 'account', message: 'Donor records need your own sign-in, not the shared team password.' }); }
  if (!access(me).reports) { return sendJSON(res, 403, { error: 'access', message: 'Donor records need Reports access.' }); }
  const admin = access(me).admin;
  const needAdmin = function () { if (!admin) { const e = new Error('Only an admin can do that.'); e.status = 403; throw e; } };

  try {
    if (req.method === 'GET') {
      if (q.get('count')) { return sendJSON(res, 200, { toSend: await toSend() }); }
      if (id) {
        if (!ID.test(id)) { throw bad('Bad donor id.'); }
        const [d, gifts, items, history] = await Promise.all([
          db.get(T.donors, '?id=eq.' + id + '&select=*'), db.get(T.gifts, '?donor_id=eq.' + id + '&select=*&order=gift_date.desc'),
          db.get(T.items, '?donor_id=eq.' + id + '&select=*&order=created_at.asc'),
          db.get(T.log, '?donor_id=eq.' + id + '&select=at,by_name,action,detail&order=at.desc&limit=40')
        ]);
        if (!d[0]) { return sendJSON(res, 404, { error: 'not_found', message: 'That donor no longer exists.' }); }
        const s = summarize(d[0], gifts);
        delete s.giftRows;
        return sendJSON(res, 200, { donor: Object.assign({}, d[0], s, { donorbox_ids: undefined }), gifts: gifts,
          items: items.map(function (i) { return Object.assign({}, i, { display: display(i, d[0]) }); }), log: history });
      }
      /* pick up a tier-config or rule change: adds missing owed items only, never edits existing ones */
      await reconcile(me.name);
      return sendJSON(res, 200, await view(admin));
    }

    const body = await readBody(req);
    const by = me.name;

    if (req.method === 'PATCH' && ID.test(id)) {
      const cur = (await db.get(T.donors, '?id=eq.' + id + '&select=*'))[0];
      if (!cur) { return sendJSON(res, 404, { error: 'not_found', message: 'That donor no longer exists.' }); }
      const f = {}, changed = {};
      ['staff', 'anonymous', 'offline'].forEach(function (k) { if (k in body) { f[k] = body[k] === true; } });
      if ('notes' in body) { f.notes = text(body.notes, 2000); }
      if ('address' in body) { f.address = text(body.address, 500); }
      if ('monthly_amount' in body) {
        const m = Number(body.monthly_amount);
        if (!(m >= 0 && m <= 100000)) { throw bad('Monthly amount must be a number.'); }
        f.monthly_amount = C.baseAmount(m); f.monthly_source = f.monthly_amount > 0 ? 'team' : 'none';
      }
      Object.keys(f).forEach(function (k) {
        if (String(cur[k]) !== String(f[k])) { changed[k] = k === 'address' ? (f[k] ? 'updated' : 'removed') : f[k]; }
      });
      if (!Object.keys(changed).length) { return sendJSON(res, 200, { ok: true }); }
      f.updated_at = new Date().toISOString(); f.updated_by_name = by;
      await db.patch(T.donors, '?id=eq.' + id, f);
      await log(id, by, 'donor updated', changed);
      await reconcile(by);
      return sendJSON(res, 200, { ok: true });
    }

    if ((req.method === 'PUT' && action === 'item') || (req.method === 'POST' && action === 'sent')) {
      if (!ID.test(id)) { throw bad('Bad item id.'); }
      const cur = (await db.get(T.items, '?id=eq.' + id + '&select=*'))[0];
      if (!cur) { return sendJSON(res, 404, { error: 'not_found', message: 'That item no longer exists.' }); }
      const f = {};
      if (action === 'sent') { f.status = 'sent'; f.sent_on = phxToday(); f.sent_by = by; }
      else {
        if ('status' in body) {
          if (ITEM_STATUS.indexOf(body.status) < 0) { throw bad('Unknown status.'); }
          f.status = body.status;
          if ((f.status === 'sent' || f.status === 'delivered') && !cur.sent_on && !body.sent_on) { f.sent_on = phxToday(); }
          if ((f.status === 'sent' || f.status === 'delivered') && !cur.sent_by) { f.sent_by = by; }
        }
        if ('size' in body) { f.size = text(body.size, 20); }
        if ('method' in body) { if (['mail', 'hand-delivered'].indexOf(body.method) < 0) { throw bad('Unknown method.'); } f.method = body.method; }
        if ('sent_on' in body) { if (body.sent_on && !DATE.test(body.sent_on)) { throw bad('Date sent must be YYYY-MM-DD.'); } f.sent_on = body.sent_on || null; }
        if ('tracking' in body) { f.tracking = text(body.tracking, 300); }
      }
      f.updated_by_name = by; f.updated_at = new Date().toISOString();
      await db.patch(T.items, '?id=eq.' + id, f);
      const detail = { item: cur.item };
      Object.keys(f).forEach(function (k) { if (k !== 'updated_at' && k !== 'updated_by_name' && String(cur[k]) !== String(f[k])) { detail[k] = f[k]; } });
      await log(cur.donor_id, by, action === 'sent' ? 'marked sent' : 'item updated', detail);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'gift') {
      if (!ID.test(id)) { throw bad('Bad donor id.'); }
      if (!DATE.test(String(body.date || ''))) { throw bad('Pick the gift date.'); }
      const amt = amount(body.amount);
      if (!(amt > 0)) { throw bad('Enter the gift amount.'); }
      await db.insert(T.gifts, [{ donor_id: id, gift_date: body.date, amount: amt, campaign: text(body.campaign, 120), kind: 'offline',
                                  source: 'manual', note: text(body.note, 300), created_by_name: by }], 'return=minimal');
      await log(id, by, 'offline gift added', { date: body.date, amount: amt });
      await reconcile(by);
      return sendJSON(res, 201, { ok: true });
    }
    if (req.method === 'DELETE' && action === 'gift') {
      if (!ID.test(id)) { throw bad('Bad gift id.'); }
      const g = (await db.get(T.gifts, '?id=eq.' + id + '&source=eq.manual&select=*'))[0];
      if (!g) { throw bad('Only hand-entered gifts can be removed here.'); }
      await db.del(T.gifts, '?id=eq.' + id);
      await log(g.donor_id, by, 'offline gift removed', { date: g.gift_date, amount: Number(g.amount) });
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'import') { needAdmin(); return sendJSON(res, 200, await importCsv(body, me)); }
    if (req.method === 'POST' && action === 'donor') {
      needAdmin();
      const name = text(body.name, 200);
      if (!name) { throw bad('Enter a name.'); }
      const made = await db.insert(T.donors, [{ name: name, name_key: nameKey(name), offline: body.offline === true, updated_by_name: by }]);
      await log(made[0].id, by, 'donor added by hand', {});
      await reconcile(by);
      return sendJSON(res, 201, { id: made[0].id });
    }
    if (req.method === 'PUT' && action === 'settings') {
      needAdmin();
      const t = body.thankYou || {};
      const mode = ['per-donor', 'min-total', 'per-gift', 'off'].indexOf(t.mode) >= 0 ? t.mode : null;
      if (!mode) { throw bad('Pick a thank-you rule.'); }
      const v = { mode: mode, minUsd: Math.max(0, Number(t.minUsd) || 0), item: text(t.item, 60) || C.DONOR_CONFIG.thankYouDefault.item };
      await db.upsert(T.settings, 'key', [{ key: 'thank_you', value: v, updated_by_name: by, updated_at: new Date().toISOString() }]);
      await log(null, by, 'thank-you rule changed', v);
      const added = await reconcile(by);
      return sendJSON(res, 200, { ok: true, itemsAdded: added });
    }
    if (req.method === 'POST' && action === 'resolve') {
      needAdmin();
      const dbx = Number(body.donorbox_id);
      const row = (await db.get(T.unmatched, '?donorbox_id=eq.' + dbx + '&select=*'))[0];
      if (!row) { throw bad('That record is no longer waiting.'); }
      if (body.to === 'ignore') {
        await db.patch(T.unmatched, '?donorbox_id=eq.' + dbx, { resolution: 'ignored' });
      } else {
        let target = body.to;
        if (target === 'new') {
          target = (await db.insert(T.donors, [{ name: row.name || 'Donorbox supporter ' + dbx, name_key: nameKey(row.name || 'donorbox ' + dbx), updated_by_name: by }]))[0].id;
        }
        if (!ID.test(String(target))) { throw bad('Pick a donor.'); }
        const d = (await db.get(T.donors, '?id=eq.' + target + '&select=donorbox_ids'))[0];
        if (!d) { throw bad('That donor no longer exists.'); }
        await db.patch(T.donors, '?id=eq.' + target, { donorbox_ids: (d.donorbox_ids || []).concat([dbx]) });
        await db.del(T.unmatched, '?donorbox_id=eq.' + dbx);
        await log(target, by, 'linked a Donorbox record', { donorbox_id: dbx });
      }
      if (syncEnabled()) { await require('./donors-sync').run(me, module.exports); }
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && action === 'sync') {
      needAdmin();
      if (!syncEnabled()) { return sendJSON(res, 409, { error: 'sync_off', message: 'The Donorbox sync is switched off. Set DONORBOX_EMAIL, DONORBOX_API_KEY and DONORBOX_SYNC_ENABLED=true in Vercel.' }); }
      return sendJSON(res, 200, await require('./donors-sync').run(me, module.exports));
    }

    res.setHeader('Allow', 'GET, PATCH, PUT, POST, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (e.status === 403) { return sendJSON(res, 403, { error: 'access', message: e.message }); }
    if (e.status === 409 || /23505|duplicate key/.test(e.message)) { return sendJSON(res, 409, { error: 'duplicate', message: 'A donor with that name already exists.' }); }
    const isBad = e.bad || /JSON|body too large/.test(e.message);
    return sendJSON(res, isBad ? 400 : 502, { error: isBad ? 'bad_request' : 'storage',
      message: isBad ? e.message : 'Could not reach the donor tables. ' + (e.status === 404 ? 'Run supabase/donors.sql in Supabase first.' : 'Try again shortly.') });
  }
}

module.exports = { handle: handle, reconcile: reconcile, settings: settings, nameKey: nameKey, db: db, T: T, log: log, money: money, parseCsv: parseCsv };
