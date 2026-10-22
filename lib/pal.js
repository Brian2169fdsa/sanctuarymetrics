/* ============================================================================
   PAL Forward 2026 outreach email tracker — served from /api/requests?pal=…
   (no function of its own: the site is at Vercel's 12-function limit).
   Reports access only; the contact list never leaves this route.

     GET  ?pal=1                                   contacts + notes/counters
     POST ?pal=group    {group, status}            mark a whole group sent / pending
     POST ?pal=campaign {notes, replies, bounces, rsvps}
     POST ?pal=import   (CSV body: email,domain,group,status,sent_date)  admins

   Tables: supabase/pal-email.sql.
   ========================================================================== */

const { sendJSON, supabase } = require('./db');
const { access } = require('./auth');
const S = require('./storage');

const EMAIL = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[A-Za-z]{2,}$/;
function bad(m, status) { const e = new Error(m); e.bad = true; e.status = status || 400; return e; }
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }); }
function db(method, table, query, body, headers) { return supabase(method, query, body, headers, table); }

/* all rows; PostgREST pages at 1000 by default, so read in pages */
async function allContacts() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await db('GET', 'pal_contacts', '?select=email,domain,grp,status,sent_date&order=grp.asc,email.asc', null,
                          { Range: from + '-' + (from + 999), 'Range-Unit': 'items' });
    out.push.apply(out, rows);
    if (rows.length < 1000) { return out; }
  }
}

/* a tiny CSV reader: no quoted commas in this file, but quotes are stripped */
function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
  const head = lines.shift().split(',').map(function (h) { return h.trim().toLowerCase().replace(/"/g, ''); });
  const col = function (n) { const i = head.indexOf(n); if (i < 0) { throw bad('The CSV needs a "' + n + '" column.'); } return i; };
  const ie = col('email'), id = head.indexOf('domain'), ig = col('group'), is = head.indexOf('status'), idt = head.indexOf('sent_date');
  const seen = {};
  const rows = [];
  lines.forEach(function (l, n) {
    const c = l.split(',').map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
    const email = (c[ie] || '').toLowerCase();
    if (!EMAIL.test(email)) { throw bad('Row ' + (n + 2) + ' doesn\'t have a valid email.'); }
    if (seen[email]) { return; }
    seen[email] = 1;
    const grp = Number(c[ig]);
    if (!Number.isInteger(grp) || grp < 1 || grp > 999) { throw bad('Row ' + (n + 2) + ' has no group number.'); }
    const status = (is >= 0 && /^sent$/i.test(c[is] || '')) ? 'sent' : 'pending';
    const date = idt >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(c[idt] || '') ? c[idt] : null;
    rows.push({ email: email, domain: (id >= 0 && c[id]) ? c[id].toLowerCase() : email.split('@')[1], grp: grp,
                status: status, sent_date: status === 'sent' ? (date || today()) : null });
  });
  if (!rows.length) { throw bad('The CSV has no contacts.'); }
  return rows;
}

async function handle(req, res, who, which) {
  const me = who.user;
  if (!me || !access(me).reports) { return sendJSON(res, 403, { error: 'forbidden', message: 'The PAL email tracker needs Reports access.' }); }
  if (req.method === 'GET') {
    const camp = (await db('GET', 'pal_campaign', '?id=eq.1&select=*'))[0] || { notes: '', replies: 0, bounces: 0, rsvps: 0 };
    return sendJSON(res, 200, { contacts: await allContacts(), campaign: camp, admin: access(me).admin, today: today() });
  }
  if (req.method !== 'POST') { return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' }); }

  if (which === 'import') {
    if (!access(me).admin) { return sendJSON(res, 403, { error: 'forbidden', message: 'Only an admin can import the list.' }); }
    /* the page sends it as application/octet-stream, which Vercel hands over as a Buffer */
    const text = typeof req.body === 'string' ? req.body : (await S.readRaw(req, 2000000)).toString('utf8');
    const rows = parseCsv(text);
    const stamp = { updated_by_name: me.name, updated_at: new Date().toISOString() };
    for (let i = 0; i < rows.length; i += 500) {
      await db('POST', 'pal_contacts', '?on_conflict=email', rows.slice(i, i + 500).map(function (r) { return Object.assign(r, stamp); }),
               { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }
    return sendJSON(res, 200, { ok: true, imported: rows.length });
  }

  const b = await new Promise(function (resolve, reject) {
    if (req.body) { return resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body); }
    S.readRaw(req, 40000).then(function (raw) { resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {}); }, reject);
  });
  if (which === 'group') {
    const g = Number(b.group);
    if (!Number.isInteger(g) || g < 1) { throw bad('Which group?'); }
    if (b.status !== 'sent' && b.status !== 'pending') { throw bad('Sent or pending?'); }
    await db('PATCH', 'pal_contacts', '?grp=eq.' + g, {
      status: b.status, sent_date: b.status === 'sent' ? today() : null, updated_by_name: me.name, updated_at: new Date().toISOString() },
      { Prefer: 'return=minimal' });
    return sendJSON(res, 200, { ok: true, group: g, status: b.status, sent_date: b.status === 'sent' ? today() : null });
  }
  if (which === 'campaign') {
    const f = { updated_by_name: me.name, updated_at: new Date().toISOString() };
    if ('notes' in b) { f.notes = String(b.notes || '').slice(0, 20000); }
    ['replies', 'bounces', 'rsvps'].forEach(function (k) {
      if (k in b) {
        const n = Number(b[k]);
        if (!Number.isInteger(n) || n < 0 || n > 100000) { throw bad('Counters are whole numbers.'); }
        f[k] = n;
      }
    });
    const rows = await db('POST', 'pal_campaign', '?on_conflict=id', Object.assign({ id: 1 }, f), { Prefer: 'resolution=merge-duplicates,return=representation' });
    return sendJSON(res, 200, { ok: true, campaign: rows[0] });
  }
  throw bad('Unknown action.', 404);
}

/* errors in the shape the page expects */
module.exports = async function pal(req, res, who, which) {
  try {
    return await handle(req, res, who, which);
  } catch (e) {
    if (e.bad) { return sendJSON(res, e.status, { error: 'bad_request', message: e.message }); }
    if (/(PGRST205|42P01)[\s\S]*pal_/.test(e.message)) {
      return sendJSON(res, 503, { error: 'not_set_up', message: 'The PAL email tables aren\'t in Supabase yet — run supabase/pal-email.sql (or ALL.sql).' });
    }
    if (/JSON/.test(e.message)) { return sendJSON(res, 400, { error: 'bad_request', message: 'Could not read the request.' }); }
    return sendJSON(res, 502, { error: 'storage', message: 'Could not reach the database. Try again shortly.' });
  }
};
