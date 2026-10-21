/* ============================================================================
   /api/alerts — in-platform alerts (the bell).

     GET                         your latest 50 alerts and your unread count
     GET    ?count=1             just the unread count (the bell polls this)
     POST   {to, title, body?, project_ref?}       admins only
            to = 'all' or an array of user ids
     PATCH  {ids?: [...], all?: true, project_ref?}  mark read
   ========================================================================== */

const { sendJSON, readBody, supabase } = require('../lib/db');
const A = require('../lib/auth');

const REF = /^(row:[0-9a-f-]{36}|seed:.{1,300})$/i;
const UUID = /^[0-9a-f-]{36}$/i;

module.exports = async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Accounts are not set up yet.' });
  }
  try {
    const me = await A.currentUser(req);
    if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in first.' }); }
    const q = new URL(req.url, 'http://x').searchParams;

    if (req.method === 'GET') {
      const unread = await supabase('GET', '?user_id=eq.' + me.id + '&read_at=is.null&select=id&limit=100', null, null, 'alerts');
      if (q.get('count')) { return sendJSON(res, 200, { unread: unread.length }); }
      const rows = await supabase('GET', '?user_id=eq.' + me.id + '&order=created_at.desc&limit=50' +
        '&select=id,kind,title,body,link,project_ref,created_at,read_at,from:app_users!alerts_from_user_id_fkey(name)',
        null, null, 'alerts');
      return sendJSON(res, 200, { unread: unread.length, alerts: rows });
    }

    if (req.method === 'POST') {
      if (me.role !== 'admin') { return sendJSON(res, 403, { error: 'admin', message: 'Only admins can send alerts.' }); }
      const b = await readBody(req);
      const title = String(b.title || '').trim();
      if (!title) { return sendJSON(res, 400, { error: 'title', message: 'Give the alert a title.' }); }
      const ref = b.project_ref ? String(b.project_ref) : '';
      if (ref && !REF.test(ref)) { return sendJSON(res, 400, { error: 'project', message: 'Unknown project.' }); }
      let ids;
      if (b.to === 'all') {
        ids = (await supabase('GET', '?disabled=is.false&select=id', null, null, 'app_users'))
          .map(function (u) { return u.id; }).filter(function (id) { return id !== me.id; });
      } else {
        ids = (Array.isArray(b.to) ? b.to : []).filter(function (id) { return UUID.test(id); }).slice(0, 100);
      }
      if (!ids.length) { return sendJSON(res, 400, { error: 'to', message: 'Pick who gets the alert.' }); }
      await A.sendAlerts(ids, { from_user_id: me.id, title: title, body: b.body, project_ref: ref || null,
                                link: ref ? 'projects.html#open=' + encodeURIComponent(ref) : null });
      return sendJSON(res, 201, { sent: ids.length });
    }

    if (req.method === 'PATCH') {
      const b = await readBody(req);
      let filter = '?user_id=eq.' + me.id + '&read_at=is.null';
      if (Array.isArray(b.ids)) {
        const ids = b.ids.filter(function (id) { return UUID.test(id); }).slice(0, 100);
        if (!ids.length) { return sendJSON(res, 200, { ok: true }); }
        filter += '&id=in.(' + ids.join(',') + ')';
      } else if (b.project_ref) {
        if (!REF.test(String(b.project_ref))) { return sendJSON(res, 400, { error: 'project', message: 'Unknown project.' }); }
        filter += '&project_ref=eq.' + encodeURIComponent(b.project_ref);
      } else if (b.all !== true) {
        return sendJSON(res, 400, { error: 'which', message: 'Say which alerts to mark read.' });
      }
      await supabase('PATCH', filter, { read_at: new Date().toISOString() }, { Prefer: 'return=minimal' }, 'alerts');
      return sendJSON(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (/JSON|body too large/.test(e.message)) { return sendJSON(res, 400, { error: 'bad_request', message: 'Could not read the request.' }); }
    return sendJSON(res, 502, { error: 'storage', message: 'Could not reach the alerts database. Try again shortly.' });
  }
};
