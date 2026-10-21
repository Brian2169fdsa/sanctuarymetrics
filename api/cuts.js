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
    const schema = /PGRST20[25]|cost_recommendations|does not exist/.test(e.message);
    return sendJSON(res, 502, { error: schema ? 'schema' : 'storage',
      message: schema ? 'The cost cutting table isn\'t in Supabase yet — run supabase/ALL.sql in the SQL Editor.'
        : 'Could not reach the database. Try again shortly.' });
  }
};
