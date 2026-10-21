/* ============================================================================
   /api/microsoft — "Sign in with Microsoft" (Microsoft 365 / Entra ID).

   OpenID Connect authorization-code flow with PKCE, locked to one tenant:

     GET ?start=1&next=projects.html   → redirect to Microsoft's sign-in page
     GET ?code=…&state=…               → Microsoft sends the person back here;
                                         we swap the code for their ID token,
                                         match it to an account, sign them in

   Only Sanctuary work accounts: the sign-in page is the Sanctuary tenant's
   (d2b75006-…, see lib/auth.js), the token must come from that tenant, and
   the email must be on a Sanctuary domain (sanctuaryrecoverycenters.com or
   sanctuaryrc.com; MS_ALLOWED_DOMAINS overrides).

   Who gets in:
     - anyone with an account (app_users) matching their Microsoft identity —
       linked by Microsoft's object ID after the first sign-in, before that by
       email (either Sanctuary domain). Accounts are created by an admin.
     - the master admin (ADMIN_EMAILS); their account is created on first sign-in
     - with MS_AUTO_CREATE=true, anyone else in the tenant, as a member

   Environment (Vercel → Settings → Environment Variables):
     MS_CLIENT_ID       the sign-in app's application (client) ID
     MS_CLIENT_SECRET   its client secret
     MS_TENANT_ID       optional; defaults to the Sanctuary tenant
     MS_REDIRECT_URI    optional; defaults to https://<this host>/api/microsoft
     MS_AUTO_CREATE     optional; "true" lets anyone in the tenant in as a member
   Setup steps: tools/register-signin-app.ps1, or MICROSOFT_SIGNIN.md.
   ========================================================================== */

const crypto = require('crypto');
const { sendJSON, supabase } = require('../lib/db');
const A = require('../lib/auth');

const STATE_COOKIE = 'sm_ms';
const GUID = /^[0-9a-f-]{36}$/i;

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function redirect(res, to) { res.statusCode = 302; res.setHeader('Location', to); res.setHeader('Cache-Control', 'no-store'); res.end(); }
function safeNext(n) { return /^[a-z0-9-]+\.html(#[\w=:%.\-]*)?$/i.test(String(n || '')) ? n : 'projects.html'; }
function fail(res, code, email) {
  A.addCookie(res, STATE_COOKIE + '=; Path=/api/microsoft; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  redirect(res, '/account.html?ms_error=' + encodeURIComponent(code) + (email ? '&email=' + encodeURIComponent(email) : ''));
}
function redirectUri(req) {
  if (process.env.MS_REDIRECT_URI) { return process.env.MS_REDIRECT_URI; }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return 'https://' + host + '/api/microsoft';
}
function authority() { return 'https://login.microsoftonline.com/' + A.msTenant() + '/oauth2/v2.0'; }

module.exports = async function handler(req, res) {
  if (!A.microsoftEnabled() || !GUID.test(A.msTenant())) {
    /* keys not in Vercel yet: say so on the account page instead of a bare error */
    const next = safeNext(new URL(req.url, 'http://x').searchParams.get('next'));
    return redirect(res, '/account.html?ms_error=notsetup&next=' + encodeURIComponent(next));
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return sendJSON(res, 405, { error: 'method' }); }
  const q = new URL(req.url, 'http://x').searchParams;

  /* ── step 1: off to Microsoft ── */
  if (q.get('start')) {
    const st = { s: b64url(crypto.randomBytes(24)), n: b64url(crypto.randomBytes(24)), v: b64url(crypto.randomBytes(48)),
                 next: safeNext(q.get('next')) };
    A.addCookie(res, STATE_COOKIE + '=' + b64url(JSON.stringify(st)) + '; Path=/api/microsoft; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
    const params = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID, response_type: 'code', response_mode: 'query',
      redirect_uri: redirectUri(req), scope: 'openid profile email', state: st.s, nonce: st.n,
      code_challenge: b64url(crypto.createHash('sha256').update(st.v).digest()), code_challenge_method: 'S256',
      prompt: 'select_account'
    });
    if (q.get('hint')) { params.set('login_hint', String(q.get('hint')).slice(0, 200)); }
    return redirect(res, authority() + '/authorize?' + params);
  }

  /* ── step 2: back from Microsoft ── */
  if (q.get('error')) { return fail(res, q.get('error') === 'access_denied' ? 'cancelled' : 'microsoft'); }
  let st;
  try { st = JSON.parse(Buffer.from(A.cookies(req)[STATE_COOKIE] || '', 'base64url').toString()); } catch (e) { st = null; }
  if (!st || !q.get('code') || q.get('state') !== st.s) { return fail(res, 'expired'); }

  let claims;
  try {
    const r = await fetch(authority() + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET,
        grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(req), code_verifier: st.v,
        scope: 'openid profile email' })
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) { return fail(res, 'microsoft'); }
    /* The ID token came straight from Microsoft's token endpoint over TLS in
       exchange for our client secret, so OpenID Connect lets us read it
       without re-checking the signature. The claims are still checked. */
    claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
  } catch (e) {
    return fail(res, 'microsoft');
  }
  const tenant = A.msTenant();
  if (claims.aud !== process.env.MS_CLIENT_ID || String(claims.tid).toLowerCase() !== tenant ||
      claims.iss !== 'https://login.microsoftonline.com/' + claims.tid + '/v2.0' ||
      claims.nonce !== st.n || !(claims.exp * 1000 > Date.now())) {
    return fail(res, 'microsoft');
  }

  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 0) { return fail(res, 'noemail'); }
  const local = email.split('@')[0], domains = A.msDomains();
  if (domains.indexOf(email.split('@')[1]) < 0) { return fail(res, 'domain', email); }
  const oid = GUID.test(claims.oid || '') ? claims.oid.toLowerCase() : null;

  try {
    const find = function (filter) {
      return supabase('GET', '?' + filter + '&select=' + A.USER_COLS + '&limit=2', null, null, 'app_users');
    };
    /* 1. the account already linked to this Microsoft identity */
    let u = null;
    if (oid) { try { u = (await find('ms_oid=eq.' + oid))[0]; } catch (e) { /* ms_oid column not added yet */ } }
    /* 2. the exact email, then the same name on the other Sanctuary domain */
    if (!u) { u = (await find('email=eq.' + encodeURIComponent(email)))[0]; }
    if (!u) {
      const alias = await find('email=in.(' + domains.map(function (d) { return encodeURIComponent('"' + local + '@' + d + '"'); }).join(',') + ')');
      if (alias.length === 1) { u = alias[0]; }
    }
    if (!u) {
      const isAdmin = A.adminEmails().indexOf(email) >= 0;
      if (!isAdmin && process.env.MS_AUTO_CREATE !== 'true') { return fail(res, 'noaccount', email); }
      u = (await supabase('POST', '?select=' + A.USER_COLS, { email: email, name: String(claims.name || email.split('@')[0]).slice(0, 80),
        role: isAdmin ? 'admin' : 'member', must_change_password: false }, null, 'app_users'))[0];
      if (!isAdmin) {
        await A.sendAlerts((await A.admins()).map(function (a) { return a.id; }), {
          title: u.name + ' joined with Microsoft sign-in', body: email, link: 'account.html#people' });
      }
    }
    if (u.disabled) { return fail(res, 'disabled', email); }
    const fields = { last_login_at: new Date().toISOString(), failed_logins: 0, locked_until: null };
    if (oid) {
      try { await supabase('PATCH', '?id=eq.' + u.id + '&ms_oid=is.null', { ms_oid: oid }, { Prefer: 'return=minimal' }, 'app_users'); }
      catch (e) { /* ms_oid column not added yet — email matching still works */ }
    }
    /* a temporary password nobody needs any more: drop it */
    if (u.must_change_password) { Object.assign(fields, { password_hash: null, must_change_password: false }); }
    await supabase('PATCH', '?id=eq.' + u.id, fields, { Prefer: 'return=minimal' }, 'app_users');
    A.addCookie(res, STATE_COOKIE + '=; Path=/api/microsoft; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    await A.startSession(res, u, req.headers['user-agent']);
    return redirect(res, '/' + st.next);
  } catch (e) {
    return fail(res, 'storage');
  }
};
