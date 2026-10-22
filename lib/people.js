/* ============================================================================
   People admin (account management), served at /api/auth?people=1. Admins only.
   (It lives inside /api/auth so the site stays within Vercel's 12 functions.)

     GET                                   list every account
     POST   {email, name, role}            create one; returns a temporary password
     PATCH  ?id=… {name?, role?, disabled?, access_reports?, access_costs?, reset_password?}
                                           reset_password returns a new temporary
                                           password and signs that person out
     DELETE ?id=…                          remove an account

   No email is sent — the admin passes the temporary password on, and the
   person is asked to choose their own the first time they sign in.
   ========================================================================== */

const { sendJSON, readBody, supabase } = require('./db');
const A = require('./auth');

const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
const ROLES = ['admin', 'member'];

function signOutEverywhere(id) {
  return supabase('DELETE', '?user_id=eq.' + id, null, { Prefer: 'return=minimal' }, 'app_sessions');
}

module.exports = async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Accounts are not set up yet.' });
  }
  try {
    const me = await A.currentUser(req);
    if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in first.' }); }
    if (me.role !== 'admin') { return sendJSON(res, 403, { error: 'admin', message: 'Only admins can manage accounts.' }); }

    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const idOk = /^[0-9a-f-]{36}$/i.test(id || '');

    if (req.method === 'GET') {
      const rows = await supabase('GET', '?select=' + (await A.userCols()) + '&order=created_at.asc', null, null, 'app_users');
      return sendJSON(res, 200, { users: rows });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
      const name = String(b.name || '').trim().slice(0, 80);
      const role = ROLES.indexOf(b.role) >= 0 ? b.role : 'member';
      if (!EMAIL.test(email)) { return sendJSON(res, 400, { error: 'email', message: 'Enter a valid email address.' }); }
      if (!name) { return sendJSON(res, 400, { error: 'name', message: 'Add the person\'s name.' }); }
      const temp = A.tempPassword();
      let rows;
      try {
        rows = await supabase('POST', '?select=' + (await A.userCols()), { email: email, name: name, role: role,
          password_hash: A.hashPassword(temp), must_change_password: true }, null, 'app_users');
      } catch (e) {
        if (e.status === 409) { return sendJSON(res, 409, { error: 'exists', message: 'There is already an account for ' + email + '.' }); }
        throw e;
      }
      await A.sendAlerts([rows[0].id], { from_user_id: me.id, title: 'Welcome, ' + name.split(' ')[0] + '!',
        body: me.name + ' set up your account. Alerts and project messages will show up here.', link: 'projects.html' });
      return sendJSON(res, 201, { user: rows[0], temp_password: temp });
    }

    if (req.method === 'PATCH') {
      if (!idOk) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
      const b = await readBody(req);
      const fields = {};
      let temp = null;
      if ('name' in b) {
        fields.name = String(b.name || '').trim().slice(0, 80);
        if (!fields.name) { return sendJSON(res, 400, { error: 'name', message: 'Name can\'t be empty.' }); }
      }
      if ('role' in b) {
        if (ROLES.indexOf(b.role) < 0) { return sendJSON(res, 400, { error: 'role', message: 'Unknown role.' }); }
        fields.role = b.role;
      }
      if ('disabled' in b) { fields.disabled = b.disabled === true; }
      /* what a staff member may open beyond the staff pages (admins get everything) */
      if ('access_reports' in b) { fields.access_reports = b.access_reports === true; }
      if ('access_costs' in b) { fields.access_costs = b.access_costs === true; }
      if (id === me.id && (fields.role === 'member' || fields.disabled)) {
        return sendJSON(res, 400, { error: 'self', message: 'You can\'t remove your own admin access.' });
      }
      if (b.reset_password) {
        temp = A.tempPassword();
        Object.assign(fields, { password_hash: A.hashPassword(temp), must_change_password: true, failed_logins: 0, locked_until: null });
      }
      if (!Object.keys(fields).length) { return sendJSON(res, 400, { error: 'empty', message: 'Nothing to change.' }); }
      const rows = await supabase('PATCH', '?id=eq.' + id + '&select=' + (await A.userCols()), fields, null, 'app_users');
      if (!rows.length) { return sendJSON(res, 404, { error: 'not_found', message: 'That account no longer exists.' }); }
      if (temp || fields.disabled) { await signOutEverywhere(id); }
      return sendJSON(res, 200, { user: rows[0], temp_password: temp });
    }

    if (req.method === 'DELETE') {
      if (!idOk) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
      if (id === me.id) { return sendJSON(res, 400, { error: 'self', message: 'You can\'t delete your own account.' }); }
      await supabase('DELETE', '?id=eq.' + id, null, { Prefer: 'return=minimal' }, 'app_users');
      return sendJSON(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (/JSON|body too large/.test(e.message)) { return sendJSON(res, 400, { error: 'bad_request', message: 'Could not read the request.' }); }
    return sendJSON(res, 502, { error: 'storage', message: 'Could not reach the accounts database. Try again shortly.' });
  }
};
