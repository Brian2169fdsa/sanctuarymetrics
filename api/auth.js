/* ============================================================================
   /api/auth — sign in, sign out, who am I, change password.

     GET                                   → { user } (null when signed out)
     POST {action:'login', email, password}
     POST {action:'logout'}
     POST {action:'setup', email, password, team_password}
          First-time master admin. Only for an email in ADMIN_EMAILS
          (default breinhart@sanctuaryrecoverycenters.com), only while that
          account has no password yet, and only with the team password.
     POST {action:'password', current, password}   change your own password
     POST {action:'profile', name}                 change your display name

   Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PROJECTS_PASSWORD;
   optional ADMIN_EMAILS (comma-separated).
   ========================================================================== */

const { sendJSON, readBody, passwordOk, supabase } = require('../lib/db');
const A = require('../lib/auth');

function pub(u) {
  return u ? { id: u.id, email: u.email, name: u.name, role: u.role, must_change_password: !!u.must_change_password } : null;
}
async function byEmail(email) {
  const rows = await supabase('GET', '?email=eq.' + encodeURIComponent(email) + '&select=' + A.USER_COLS +
                              ',password_hash,failed_logins,locked_until', null, null, 'app_users');
  return rows[0] || null;
}
function patchUser(id, fields) {
  return supabase('PATCH', '?id=eq.' + id, fields, { Prefer: 'return=minimal' }, 'app_users');
}

module.exports = async function handler(req, res) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(function (k) { return !process.env[k]; });
  if (missing.length) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Accounts are not set up yet: missing ' + missing.join(', ') + '.' });
  }

  try {
    if (req.method === 'GET') {
      return sendJSON(res, 200, { user: pub(await A.currentUser(req)), microsoft: A.microsoftEnabled() });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
    }

    const body = await readBody(req);
    const action = body.action;
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);

    if (action === 'login') {
      const u = email && await byEmail(email);
      const now = Date.now();
      if (u && u.locked_until && new Date(u.locked_until).getTime() > now) {
        return sendJSON(res, 429, { error: 'locked', message: 'Too many wrong passwords. Try again in a few minutes.' });
      }
      if (!u || u.disabled || !u.password_hash || !A.verifyPassword(body.password, u.password_hash)) {
        if (u && u.password_hash) {
          const n = (u.failed_logins || 0) + 1;
          await patchUser(u.id, n >= A.MAX_FAILED
            ? { failed_logins: 0, locked_until: new Date(now + A.LOCK_MINUTES * 60000).toISOString() }
            : { failed_logins: n });
        }
        return sendJSON(res, 401, { error: 'login', message: 'That email and password don\'t match an account.' });
      }
      await patchUser(u.id, { failed_logins: 0, locked_until: null, last_login_at: new Date(now).toISOString() });
      await A.startSession(res, u, req.headers['user-agent']);
      return sendJSON(res, 200, { user: pub(u) });
    }

    if (action === 'logout') {
      await A.endSession(req, res);
      return sendJSON(res, 200, { user: null });
    }

    if (action === 'setup') {
      if (A.adminEmails().indexOf(email) < 0) {
        return sendJSON(res, 403, { error: 'setup', message: 'Only the master admin email can use first-time setup.' });
      }
      if (!process.env.PROJECTS_PASSWORD || !passwordOk(body.team_password, process.env.PROJECTS_PASSWORD)) {
        return sendJSON(res, 401, { error: 'setup', message: 'The team password is wrong.' });
      }
      const problem = A.passwordProblem(body.password);
      if (problem) { return sendJSON(res, 400, { error: 'password', message: problem }); }
      let u = await byEmail(email);
      if (u && u.password_hash) {
        return sendJSON(res, 409, { error: 'setup', message: 'This account is already set up — sign in instead.' });
      }
      const fields = { password_hash: A.hashPassword(body.password), must_change_password: false, role: 'admin', disabled: false,
                       last_login_at: new Date().toISOString() };
      if (u) {
        await patchUser(u.id, fields);
        u = Object.assign(u, fields);
      } else {
        const name = String(body.name || '').trim().slice(0, 80) || email.split('@')[0];
        u = (await supabase('POST', '', Object.assign({ email: email, name: name }, fields), null, 'app_users'))[0];
      }
      await A.startSession(res, u, req.headers['user-agent']);
      return sendJSON(res, 200, { user: pub(u) });
    }

    /* everything below needs a signed-in account */
    const me = await A.currentUser(req);
    if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in first.' }); }

    if (action === 'password') {
      const full = await byEmail(me.email);
      if (!A.verifyPassword(body.current, full.password_hash)) {
        return sendJSON(res, 401, { error: 'password', message: 'Your current password is wrong.' });
      }
      const problem = A.passwordProblem(body.password);
      if (problem) { return sendJSON(res, 400, { error: 'password', message: problem }); }
      await patchUser(me.id, { password_hash: A.hashPassword(body.password), must_change_password: false });
      return sendJSON(res, 200, { user: pub(Object.assign(me, { must_change_password: false })) });
    }

    if (action === 'profile') {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) { return sendJSON(res, 400, { error: 'name', message: 'Add a name.' }); }
      await patchUser(me.id, { name: name });
      return sendJSON(res, 200, { user: pub(Object.assign(me, { name: name })) });
    }

    return sendJSON(res, 400, { error: 'action', message: 'Unknown action.' });
  } catch (e) {
    if (/JSON|body too large/.test(e.message)) { return sendJSON(res, 400, { error: 'bad_request', message: 'Could not read the request.' }); }
    const schema = /PGRST20[25]|app_users|app_sessions|does not exist/.test(e.message);
    return sendJSON(res, 502, {
      error: schema ? 'schema' : 'storage',
      message: schema ? 'The accounts tables aren\'t in Supabase yet — run supabase/accounts.sql in the SQL Editor.'
        : 'Could not reach the accounts database. Try again shortly.'
    });
  }
};
