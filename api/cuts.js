/* ============================================================================
   /api/cuts — recommended cost cuts and their approval (costs.html).

     GET                               every recommendation, newest first
     POST   {vendor, department?, title, detail?, monthly_saving?}
                                       recommend a cut (admins only)
     POST   ?id=… {action:'approve', note?}
                                       approve it: it becomes a task on the
                                       Projects page for the cut's owner, and
                                       the admins get an alert
     POST   ?id=… {action:'decline', note?}
     DELETE ?id=…                      remove a recommendation (admins only)

   Google cutover (google.html), all behind a signed-in account:
     GET    ?scope=google              every Google account with its usage and
                                       the team's keep / cut choice
     PATCH  ?scope=google {accounts:[…], decision:'keep'|null}
                                       mark accounts Keep, or clear the choice
     POST   ?scope=google {accounts:[…], note?}
                                       send the ticked accounts for approval as
                                       one cut (seat price × count, before tax)
   Accounts marked must_keep (Ulonda) can never be sent for cutting.

   Approving needs a signed-in account (the approval is recorded by name).
   Tables: supabase/cost-cutting.sql. Tasks go to CUTS_OWNER, defaulting to
   PRINT_OWNER, then "Brian Reinhart".
   ========================================================================== */

const { sendJSON, readBody, supabase } = require('../lib/db');
const A = require('../lib/auth');

const VENDORS = ['Microsoft', 'Google', 'Other'];
const TABLE = 'cost_recommendations';

function owner() { return (process.env.CUTS_OWNER || process.env.PRINT_OWNER || 'Brian Reinhart').slice(0, 120); }
function str(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max); }
function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/* ── Google cutover ──────────────────────────────────────────────────────── */
const SEAT_PRICE = Number(process.env.GOOGLE_SEAT_PRICE || 16.80);   /* Business Standard, Flexible */
const GTABLE = 'google_accounts';

function list(b) {
  return (Array.isArray(b.accounts) ? b.accounts : []).map(function (a) { return String(a).trim().toLowerCase().slice(0, 200); })
    .filter(function (a, i, all) { return a.indexOf('@') > 0 && all.indexOf(a) === i; }).slice(0, 50);
}
function inList(accts) { return 'account=in.(' + accts.map(function (a) { return encodeURIComponent('"' + a + '"'); }).join(',') + ')'; }

async function google(req, res, me) {
  if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see the Google accounts.' }); }
  if (req.method === 'GET') {
    const rows = await supabase('GET', '?select=*&order=google_total_mb.desc', null, null, GTABLE);
    const recIds = rows.map(function (r) { return r.cut_rec_id; }).filter(function (x, i, all) { return x && all.indexOf(x) === i; });
    const recs = recIds.length ? await supabase('GET', '?id=in.(' + recIds.join(',') + ')&select=id,status,decided_by_name,decided_at,project_id', null, null, TABLE) : [];
    /* the 365 mailboxes and their folders (migration proof); absent until that SQL is run */
    let mailboxes = [], folders = [];
    try {
      mailboxes = await supabase('GET', '?select=*&order=mailbox.asc', null, null, 'google_m365_mailboxes');
      folders = await supabase('GET', '?select=mailbox,folder,items,mb,oldest,newest,from_gmail&order=mailbox.asc,folder.asc&limit=2000',
                               null, null, 'google_m365_folders');
    } catch (e) { /* tables not created yet */ }
    return sendJSON(res, 200, { accounts: rows, recs: recs, seatPrice: SEAT_PRICE, mailboxes: mailboxes, folders: folders });
  }
  const b = await readBody(req);
  const accts = list(b);
  if (!accts.length) { return sendJSON(res, 400, { error: 'accounts', message: 'Tick at least one account.' }); }
  const rows = await supabase('GET', '?' + inList(accts) + '&select=account,name,verdict,must_keep,must_keep_reason,decision,cut_rec_id,google_total_mb,drive_mb,note', null, null, GTABLE);
  if (rows.length !== accts.length) { return sendJSON(res, 404, { error: 'not_found', message: 'Some of those accounts aren\'t on the list.' }); }
  const now = new Date().toISOString();

  if (req.method === 'PATCH') {
    const decision = b.decision === 'keep' ? 'keep' : null;
    /* an account already sent for cutting comes back only by declining that cut */
    const sent = rows.filter(function (r) { return r.decision === 'cut' && r.cut_rec_id; });
    if (sent.length && decision !== 'keep') {
      return sendJSON(res, 409, { error: 'sent', message: sent.map(function (r) { return r.account; }).join(', ') + ' already sent for approval.' });
    }
    await supabase('PATCH', '?' + inList(accts), { decision: decision, decided_by_name: decision ? me.name : null,
      decided_at: decision ? now : null, cut_rec_id: null, updated_at: now }, { Prefer: 'return=minimal' }, GTABLE);
    return sendJSON(res, 200, { ok: true });
  }

  if (req.method === 'POST') {
    const locked = rows.filter(function (r) { return r.must_keep; });
    if (locked.length) {
      return sendJSON(res, 400, { error: 'must_keep', message: locked.map(function (r) { return r.account + ' (' + (r.must_keep_reason || 'must keep') + ')'; }).join(', ') + ' can\'t be cut.' });
    }
    const already = rows.filter(function (r) { return r.decision === 'cut' && r.cut_rec_id; });
    if (already.length) {
      return sendJSON(res, 409, { error: 'sent', message: already.map(function (r) { return r.account; }).join(', ') + ' already sent for approval.' });
    }
    const n = rows.length, gb = rows.reduce(function (t, r) { return t + Number(r.google_total_mb || 0); }, 0) / 1024;
    const detail = rows.map(function (r) {
      return '• ' + r.account + (r.name ? ' (' + r.name + ')' : '') + ' — review: ' + (r.verdict || '—') +
        (Number(r.drive_mb) ? '; ' + Math.round(r.drive_mb) + ' MB Drive' : '') + (r.note ? '. ' + r.note : '');
    }).join('\n') + '\n\nDelete each account in Google Admin (Flexible plan: billing stops the day it is deleted). ' +
      'Move any Drive files and Gmail history still needed to Microsoft 365 first.' + (b.note ? '\n\nNote: ' + str(b.note, 1000) : '');
    const rec = (await supabase('POST', '', { vendor: 'Google', department: null,
      title: ('Remove ' + n + ' Google account' + (n === 1 ? '' : 's') + ': ' + rows.map(function (r) { return r.account.split('@')[0] + '@'; }).join(', ')).slice(0, 200),
      detail: (detail + '\n\n' + gb.toFixed(1) + ' GB in Google across these accounts.').slice(0, 3000),
      monthly_saving: Math.round(n * SEAT_PRICE * 100) / 100, created_by: me.id }, null, TABLE))[0];
    await supabase('PATCH', '?' + inList(accts), { decision: 'cut', decided_by_name: me.name, decided_at: now, cut_rec_id: rec.id, updated_at: now },
                   { Prefer: 'return=minimal' }, GTABLE);
    const adminIds = (await A.admins()).map(function (u) { return u.id; }).filter(function (x) { return x !== me.id; });
    await A.sendAlerts(adminIds, { from_user_id: me.id, kind: 'request', title: me.name + ' sent ' + n + ' Google account' + (n === 1 ? '' : 's') + ' for approval',
      body: rec.title, link: 'costs.html' });
    return sendJSON(res, 201, { cut: rec });
  }

  res.setHeader('Allow', 'GET, PATCH, POST');
  return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
}

module.exports = async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Cost cutting is not set up yet.' });
  }
  try {
    const who = await A.authorize(req);
    if (!who) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see recommended cuts.' }); }
    const me = who.user || null;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const idOk = /^[0-9a-f-]{36}$/i.test(id || '');

    if (new URL(req.url, 'http://x').searchParams.get('scope') === 'google') { return google(req, res, me); }

    if (req.method === 'GET') {
      const rows = await supabase('GET', '?select=*&order=created_at.desc&limit=200', null, null, TABLE);
      return sendJSON(res, 200, { cuts: rows, owner: owner() });
    }

    if (req.method === 'POST' && !id) {
      if (!me || me.role !== 'admin') { return sendJSON(res, 403, { error: 'admin', message: 'Only admins can recommend cuts.' }); }
      const b = await readBody(req);
      const vendor = VENDORS.indexOf(b.vendor) >= 0 ? b.vendor : 'Other';
      const title = str(b.title, 200);
      if (!title) { return sendJSON(res, 400, { error: 'title', message: 'Say what the cut is.' }); }
      let saving = null;
      if (b.monthly_saving !== undefined && b.monthly_saving !== null && b.monthly_saving !== '') {
        saving = Math.round(Number(b.monthly_saving) * 100) / 100;
        if (!(saving >= 0 && saving < 1e7)) { return sendJSON(res, 400, { error: 'saving', message: 'Monthly saving must be a dollar amount.' }); }
      }
      const rows = await supabase('POST', '', { vendor: vendor, department: str(b.department, 80) || null, title: title,
        detail: str(b.detail, 3000) || null, monthly_saving: saving, created_by: me.id }, null, TABLE);
      return sendJSON(res, 201, { cut: rows[0] });
    }

    if (req.method === 'POST' && idOk) {
      if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in with your account to approve — the approval is recorded by name.' }); }
      const b = await readBody(req);
      const action = b.action;
      if (action !== 'approve' && action !== 'decline') { return sendJSON(res, 400, { error: 'action', message: 'Unknown action.' }); }
      const note = str(b.note, 1000) || null;
      const now = new Date().toISOString();
      /* only a still-open recommendation can be decided — two people clicking at once can't double-approve */
      const rows = await supabase('PATCH', '?id=eq.' + id + '&status=eq.proposed', {
        status: action === 'approve' ? 'approved' : 'declined', decided_by: me.id, decided_by_name: me.name,
        decided_at: now, decision_note: note }, null, TABLE);
      if (!rows.length) {
        const cur = (await supabase('GET', '?id=eq.' + id + '&select=status,decided_by_name', null, null, TABLE))[0];
        return sendJSON(res, cur ? 409 : 404, { error: cur ? 'decided' : 'not_found',
          message: cur ? 'Already ' + cur.status + (cur.decided_by_name ? ' by ' + cur.decided_by_name : '') + '.' : 'That recommendation no longer exists.' });
      }
      const cut = rows[0];
      const adminIds = (await A.admins()).map(function (u) { return u.id; }).filter(function (x) { return x !== me.id; });

      if (action === 'decline') {
        /* Google accounts sent in this cut go back to undecided, so they can be ticked again */
        try {
          await supabase('PATCH', '?cut_rec_id=eq.' + id, { decision: null, decided_by_name: null, decided_at: null, cut_rec_id: null,
            updated_at: now }, { Prefer: 'return=minimal' }, GTABLE);
        } catch (e) { /* google_accounts not created yet */ }
        await A.sendAlerts(adminIds, { from_user_id: me.id, kind: 'alert', title: me.name + ' declined: ' + cut.title,
          body: note || null, link: 'costs.html' });
        return sendJSON(res, 200, { cut: cut });
      }

      /* approved → a task on the Projects page */
      const lines = ['APPROVED COST CUT — ' + cut.vendor + (cut.department ? ' · ' + cut.department : ''),
        cut.monthly_saving !== null ? 'Saves ' + money(cut.monthly_saving) + ' / month (' + money(cut.monthly_saving * 12) + ' / year)' : null,
        '', cut.detail || null, '', 'Approved by ' + me.name + ' on ' +
        new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' }),
        note ? 'Note: ' + note : null].filter(function (l) { return l !== null; });
      let project;
      try {
        project = (await supabase('POST', '', {
          title: ('Cost cut: ' + cut.title).slice(0, 300), owner: owner(), status: 'New', importance: 'Hot',
          notes: lines.join('\n').replace(/\n{3,}/g, '\n\n').slice(0, 4000),
          source: 'Cost cutting · approved by ' + me.name.slice(0, 120), seed_key: null }))[0];
      } catch (e) {
        /* no task, no approval: put it back so it can be approved again */
        await supabase('PATCH', '?id=eq.' + id, { status: 'proposed', decided_by: null, decided_by_name: null, decided_at: null,
          decision_note: null }, { Prefer: 'return=minimal' }, TABLE);
        throw e;
      }
      await supabase('PATCH', '?id=eq.' + id, { project_id: project.id }, { Prefer: 'return=minimal' }, TABLE);
      await A.sendAlerts(adminIds, { from_user_id: me.id, kind: 'request', project_ref: 'row:' + project.id,
        title: me.name + ' approved: ' + cut.title,
        body: (cut.monthly_saving !== null ? money(cut.monthly_saving) + '/mo. ' : '') + 'It\'s on your project list.',
        link: 'projects.html#open=' + encodeURIComponent('row:' + project.id) });
      return sendJSON(res, 200, { cut: Object.assign(cut, { project_id: project.id }), task: { id: project.id, title: project.title, owner: project.owner } });
    }

    if (req.method === 'DELETE' && idOk) {
      if (!me || me.role !== 'admin') { return sendJSON(res, 403, { error: 'admin', message: 'Only admins can remove recommendations.' }); }
      await supabase('DELETE', '?id=eq.' + id, null, { Prefer: 'return=minimal' }, TABLE);
      return sendJSON(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (/JSON|body too large/.test(e.message)) { return sendJSON(res, 400, { error: 'bad_request', message: 'Could not read the request.' }); }
    const schema = /PGRST20[25]|cost_recommendations|google_accounts|does not exist/.test(e.message);
    return sendJSON(res, 502, { error: schema ? 'schema' : 'storage',
      message: schema ? 'The cost cutting table isn\'t in Supabase yet — run supabase/ALL.sql in the SQL Editor.'
        : 'Could not reach the database. Try again shortly.' });
  }
};
