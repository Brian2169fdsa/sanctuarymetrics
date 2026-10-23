/* ============================================================================
   Accounts and sessions.

   Users live in public.app_users (see supabase/accounts.sql). Passwords are
   stored as scrypt hashes. Signing in sets an HttpOnly cookie holding a random
   session token; only its SHA-256 lands in public.app_sessions, so a leaked
   table can't be replayed as a login.

   What someone may open (access(user)):
     admin            everything, plus people, requests and the social queue
     access_reports   the reports (Report, Compare, Two weeks, sanctuaryci.org)
                      and the full project list
     access_costs     the cost-cutting pages
     cpao_admin       the admin side of the HEAplus (CP-AO) portal: site
                      admins plus the emails in CPAO_ADMINS. Countersigning,
                      settings and the weekly batch stay with the site admin
                      (they use his signature)
     cpao_manager     a read-only view of everyone's HEAplus stage, for
                      managers (CPAO_MANAGERS) — no forms, letters or details.
                      A manager who isn't an admin gets only HEAplus, Print
                      orders and Social media (limited_nav; middleware.js
                      MANAGER_PAGES does the same for whole pages)
     cpao_mail        CPAO letter uploads (CPAO_MAIL_UPLOADERS) — a limited
                      view; everyone else sees only their own HEAplus progress
   Everyone else is staff: home, social media, the print shop, presentations,
   website edits and their own requests. middleware.js applies the same rules
   to whole pages.

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
const BASE_COLS = 'id,email,name,role,disabled,must_change_password,last_login_at,created_at';
const USER_COLS = BASE_COLS + ',access_reports,access_costs';

/* the access columns arrive with supabase/accounts.sql; until it has run,
   read accounts without them so sign-in keeps working */
let HAS_ACCESS = null;
let CHECKED_AT = 0;
async function userCols() {
  if (HAS_ACCESS === null || (!HAS_ACCESS && Date.now() - CHECKED_AT > 60000)) {
    try {
      await supabase('GET', '?select=access_reports,access_costs&limit=1', null, null, 'app_users');
      HAS_ACCESS = true;
    } catch (e) {
      HAS_ACCESS = false;
    }
    CHECKED_AT = Date.now();
  }
  return HAS_ACCESS ? USER_COLS : BASE_COLS;
}
/* a missing access_reports column means the old setup, where everyone saw the reports */
/* who can upload CPAO mail (letters AHCCCS posts to Sanctuary) on cpao-mail.html:
   admins plus CPAO_MAIL_UPLOADERS (comma-separated emails) */
function cpaoMailUploaders() {
  return (process.env.CPAO_MAIL_UPLOADERS || 'efischer@sanctuaryrecoverycenters.com')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}
function cpaoAdmins() {
  return (process.env.CPAO_ADMINS || 'joe@sanctuaryrecoverycenters.com,kaycock@sanctuaryrecoverycenters.com,efischer@sanctuaryrecoverycenters.com')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}
function cpaoManagers() {
  return (process.env.CPAO_MANAGERS || 'blee@sanctuaryrecoverycenters.com')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}
function access(u) {
  if (!u) { return { admin: false, reports: false, costs: false, cpao_admin: false, cpao_manager: false, cpao_mail: false }; }
  const admin = u.role === 'admin', email = String(u.email || '').toLowerCase();
  const cpaoAdmin = admin || cpaoAdmins().indexOf(email) >= 0;
  const limited = !cpaoAdmin && cpaoManagers().indexOf(email) >= 0;
  return { admin: admin, reports: !limited && (admin || u.access_reports !== false), costs: !limited && (admin || u.access_costs === true),
           cpao_admin: cpaoAdmin, cpao_manager: cpaoAdmin || limited,
           cpao_mail: cpaoAdmin || cpaoMailUploaders().indexOf(email) >= 0, limited_nav: limited };
}

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
/* adds to any Set-Cookie already on the response (Microsoft sign-in sets two) */
function addCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', (Array.isArray(prev) ? prev : prev ? [prev] : []).concat(cookie));
}
function setCookie(res, value, maxAge) {
  addCookie(res, COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge);
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
                              '&select=user:app_users(' + (await userCols()) + ')', null, null, 'app_sessions');
  const u = rows && rows[0] && rows[0].user;
  if (u && !u.disabled) { req._user = u; await viewAs(req, u); }
  return req._user;
}

/* "View as" (the master admin only — ADMIN_EMAILS): the sm_view_as cookie names someone, and every
   page and API then answers as that person — so an admin sees exactly what
   they see. It is read-only: anything but a GET gets no user at all, so no
   change can be made in their name. The cookie is set by the page (account.js);
   it means nothing unless the real session is the master admin's. */
function canViewAs(u) {
  return !!u && u.role === 'admin' && adminEmails().indexOf(String(u.email || '').toLowerCase()) >= 0;
}
const VIEW_COOKIE = 'sm_view_as';
const NO_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';
async function viewAs(req, u) {
  const as = String(cookies(req)[VIEW_COOKIE] || '').trim().toLowerCase().slice(0, 200);
  if (!as || !canViewAs(u) || as === String(u.email || '').toLowerCase()) { return; }
  let t = (await supabase('GET', '?email=eq.' + encodeURIComponent(as) + '&select=' + (await userCols()), null, null, 'app_users'))[0];
  if (t && t.disabled) { return; }
  /* no site account yet (e.g. only on the HEAplus roster): show what a
     standard staff account would see */
  if (!t) {
    if (!/^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/.test(as)) { return; }
    let name = as.split('@')[0];
    try {
      const r = (await supabase('GET', '?email=eq.' + encodeURIComponent(as) + '&select=first_name,last_name&limit=1', null, null, 'cpao_staff'))[0];
      if (r) { name = r.first_name + ' ' + r.last_name; }
    } catch (e) { /* no HEAplus tables — the email will do */ }
    t = { id: NO_ACCOUNT_ID, email: as, name: name, role: 'member', disabled: false, access_reports: true, access_costs: false, no_account: true };
  }
  req._realUser = u;
  req._user = req.method === 'GET' ? Object.assign({}, t, { view_as: true, real_email: u.email, real_name: u.name }) : null;
}
/* the person actually signed in, even while viewing as someone else */
async function realUser(req) {
  await currentUser(req);
  return req._realUser || req._user;
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

/* ── Microsoft sign-in (api/microsoft.js) ─────────────────────────────────
   Pinned to the Sanctuary Recovery Centers tenant. Microsoft's own sign-in
   metadata for sanctuaryrecoverycenters.com and sanctuaryrc.com both name
   this directory. MS_TENANT_ID can override it, but only on purpose.      */
const SANCTUARY_TENANT = 'd2b75006-002d-467c-9718-c57a492f182a';
function msTenant() { return (process.env.MS_TENANT_ID || SANCTUARY_TENANT).trim().toLowerCase(); }
function msDomains() {
  return (process.env.MS_ALLOWED_DOMAINS || 'sanctuaryrecoverycenters.com,sanctuaryrc.com')
    .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}
/* on once the sign-in app's client ID and secret are in Vercel */
function microsoftEnabled() {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
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
  COOKIE: COOKIE, USER_COLS: USER_COLS, userCols: userCols, access: access, MAX_FAILED: MAX_FAILED, LOCK_MINUTES: LOCK_MINUTES,
  hashPassword: hashPassword, verifyPassword: verifyPassword, passwordProblem: passwordProblem, tempPassword: tempPassword,
  cpaoAdmins: cpaoAdmins, cpaoManagers: cpaoManagers, cpaoMailUploaders: cpaoMailUploaders,
  startSession: startSession, endSession: endSession, currentUser: currentUser, realUser: realUser, canViewAs: canViewAs, authorize: authorize, VIEW_COOKIE: VIEW_COOKIE,
  adminEmails: adminEmails, admins: admins, sendAlerts: sendAlerts,
  cookies: cookies, addCookie: addCookie, microsoftEnabled: microsoftEnabled,
  SANCTUARY_TENANT: SANCTUARY_TENANT, msTenant: msTenant, msDomains: msDomains
};
