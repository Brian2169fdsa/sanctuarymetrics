/* ============================================================================
   Accounts and sessions.

   Users live in public.app_users (see supabase/accounts.sql). Passwords are
   stored as scrypt hashes. Signing in sets an HttpOnly cookie holding a random
   session token; only its SHA-256 lands in public.app_sessions, so a leaked
   table can't be replayed as a login.

   authorize(req) is what every endpoint calls. It returns:
     { user }            signed in with an account
     { legacy: true }    no account, but the old shared team password header
                         (kept so the existing pages keep working)
     null                neither
   ========================================================================== */

const crypto = require('crypto');
const { passwordOk, supabase } = require('./db');

const COOKIE = 'sm_session';
const SESSION_DAYS = 30;
const MAX_FAILED = 5;            /* wrong passwords before a short lockout */
const LOCK_MINUTES = 15;
const USER_COLS = 'id,email,name,role,disabled,must_change_password,last_login_at,created_at';

/* ── passwords ──────────────────────────────────────────────────────────── */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}
function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') { return false; }
  const want = Buffer.from(parts[2], 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(parts[1], 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}
function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 10) { return 'Use at least 10 characters.'; }
  if (pw.length > 200) { return 'That password is too long.'; }
  return '';
}
/* readable temporary password, e.g. "plum-river-4821-stone" */
const WORDS = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fern', 'grove', 'harbor', 'iris', 'juniper', 'kestrel',
  'lumen', 'maple', 'nova', 'olive', 'pine', 'quartz', 'river', 'sage', 'tide', 'umber', 'violet', 'willow', 'zephyr'];
function tempPassword() {
  const w = function () { return WORDS[crypto.randomInt(WORDS.length)]; };
  return w() + '-' + w() + '-' + crypto.randomInt(1000, 9999) + '-' + w();
}

/* ── cookies ────────────────────────────────────────────────────────────── */
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(function (p) {
    const i = p.indexOf('=');
    if (i > 0) { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  });
  return out;
}
function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge);
}
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/* ── sessions ───────────────────────────────────────────────────────────── */
async function startSession(res, user, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await supabase('POST', '', { token_hash: sha(token), user_id: user.id, expires_at: expires,
                               user_agent: String(ua || '').slice(0, 200) }, { Prefer: 'return=minimal' }, 'app_sessions');
  setCookie(res, token, SESSION_DAYS * 86400);
}
async function endSession(req, res) {
  const token = cookies(req)[COOKIE];
  if (token) { await supabase('DELETE', '?token_hash=eq.' + sha(token), null, { Prefer: 'return=minimal' }, 'app_sessions'); }
  setCookie(res, '', 0);
}

async function currentUser(req) {
  if (req._user !== undefined) { return req._user; }
  req._user = null;
  const token = cookies(req)[COOKIE];
  if (!token || token.length > 100) { return null; }
  const rows = await supabase('GET', '?token_hash=eq.' + sha(token) + '&expires_at=gt.' + encodeURIComponent(new Date().toISOString()) +
                              '&select=user:app_users(' + USER_COLS + ')', null, null, 'app_sessions');
  const u = rows && rows[0] && rows[0].user;
  if (u && !u.disabled) { req._user = u; }
  return req._user;
}

/* signed-in account, else the old team password, else nothing */
async function authorize(req, opts) {
  opts = opts || {};
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const u = await currentUser(req);
      if (u) { return { user: u }; }
    } catch (e) {
      /* accounts tables not created yet — fall through to the team password */
    }
  }
  const given = req.headers['x-projects-password'];
  if (given && process.env.PROJECTS_PASSWORD && passwordOk(given, process.env.PROJECTS_PASSWORD)) { return { legacy: true }; }
  if (given && opts.printPassword && process.env.PRINT_PASSWORD && passwordOk(given, process.env.PRINT_PASSWORD)) {
    return { legacy: true, printOnly: true };
  }
  return null;
}

/* ── the master admin list ───────────────────────────────────────────────── */
function adminEmails() {
  return (process.env.ADMIN_EMAILS || 'breinhart@sanctuaryrecoverycenters.com')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

/* ── alerts ─────────────────────────────────────────────────────────────── */
async function admins() {
  return supabase('GET', '?role=eq.admin&disabled=is.false&select=id,email,name', null, null, 'app_users');
}
/* one alert per recipient; failures never block the action that caused them */
async function sendAlerts(userIds, alert) {
  const ids = userIds.filter(function (id, i) { return id && userIds.indexOf(id) === i; });
  if (!ids.length) { return; }
  try {
    await supabase('POST', '', ids.map(function (id) {
      return { user_id: id, from_user_id: alert.from_user_id || null, title: String(alert.title).slice(0, 200),
               body: alert.body ? String(alert.body).slice(0, 2000) : null, link: alert.link || null,
               project_ref: alert.project_ref || null, kind: alert.kind || 'alert' };
    }), { Prefer: 'return=minimal' }, 'alerts');
  } catch (e) { /* the alerts table may not exist yet */ }
}

module.exports = {
  COOKIE: COOKIE, USER_COLS: USER_COLS, MAX_FAILED: MAX_FAILED, LOCK_MINUTES: LOCK_MINUTES,
  hashPassword: hashPassword, verifyPassword: verifyPassword, passwordProblem: passwordProblem, tempPassword: tempPassword,
  startSession: startSession, endSession: endSession, currentUser: currentUser, authorize: authorize,
  adminEmails: adminEmails, admins: admins, sendAlerts: sendAlerts
};
