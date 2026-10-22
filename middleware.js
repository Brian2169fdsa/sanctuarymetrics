/* The site's front door. Every page needs a signed-in account: no valid
   sm_session cookie → straight to login.html, which sends people back to the
   page they asked for once they're in.

   Runs on Vercel before any page is served (Routing Middleware, Web APIs
   only). It checks the session the same way lib/auth.js does — SHA-256 of
   the cookie looked up in app_sessions, unexpired, account not turned off.

   Not gated:
   - login.html: the sign-in page itself
   - account.html: the admin's first-time setup / ?password=1 fallback (it
     sends anyone else to login.html on its own)
   - cpao-apply.html: the HEAplus application, which checks the invite link
     itself (api/cpao.js) — someone invited at a personal email has no site
     account and opens it with an access code instead
   - /api/*: each function checks access itself, and sanctuaryci.org posts
     analytics to /api/collect
   - images, fonts, scripts and styles, so login.html can draw itself

   Then by access level (the same rules as access() in lib/auth.js):
   - the reports need Reports access (or admin)
   - the cost-cutting pages need Cost management access (or admin)
   - everything else is for all staff
   Someone opening a page they can't use lands on home.html, which shows
   what they can open.                                                       */

const OPEN_PAGES = new Set(['/login.html', '/account.html', '/cpao-apply.html']);
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|js|map|txt)$/i;

const ADMIN_PAGES = new Set([]);
/* the HEAplus tab (cpao-admin.html) is open to all staff: api/cpao.js decides
   who sees the admin side and who sees only their own progress */
const REPORT_PAGES = new Set(['/', '/index.html', '/compare.html', '/twoweeks.html', '/sanctuaryci.html', '/pal-email.html', '/pal-email']);
const COST_PAGES = new Set(['/costs.html', '/google.html', '/microsoft.html', '/microsoft-analytics.html',
  '/microsoft-savings.html', '/email.html', '/groups.html', '/teams.html', '/sharepoint.html']);

export const config = { matcher: '/((?!api/).*)' };

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function cookie(request, name) {
  const all = request.headers.get('cookie') || '';
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; }
    }
  }
  return '';
}

/* the signed-in account's access, or null; reads the access columns when
   supabase/accounts.sql has added them, and the old setup when not */
async function account(request) {
  const token = cookie(request, 'sm_session');
  if (!token || token.length > 100) { return null; }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/app_sessions?token_hash=eq.' + (await sha256(token)) +
    '&expires_at=gt.' + encodeURIComponent(new Date().toISOString()) + '&select=user:app_users(';
  const get = (cols) => fetch(base + cols + ')', { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  let r = await get('disabled,role,access_reports,access_costs');
  if (r.status === 400) { r = await get('disabled,role'); }
  if (!r.ok) { return null; }
  const rows = await r.json();
  const u = rows[0] && rows[0].user;
  if (!u || u.disabled) { return null; }
  const admin = u.role === 'admin';
  return { admin: admin, reports: admin || u.access_reports !== false, costs: admin || u.access_costs === true };
}

export default async function middleware(request) {
  const path = new URL(request.url).pathname;
  if (OPEN_PAGES.has(path) || ASSET.test(path)) { return; }
  /* accounts not set up on this deployment: nobody could sign in, so don't lock the site */
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { return; }
  let who = null;
  try {
    who = await account(request);
  } catch (e) {
    /* Supabase didn't answer — fall through to the sign-in page, which says so */
  }
  if (who) {
    if ((REPORT_PAGES.has(path) && !who.reports) || (COST_PAGES.has(path) && !who.costs) || (ADMIN_PAGES.has(path) && !who.admin)) {
      const home = new URL('/home.html', request.url);
      if (path !== '/') { home.searchParams.set('denied', path.replace(/^\/+/, '')); }
      return new Response(null, { status: 302, headers: { Location: home.toString(), 'Cache-Control': 'no-store' } });
    }
    return;
  }
  const page = path.replace(/^\/+/, '') || 'home.html';
  const login = new URL('/login.html', request.url);
  if (/^[a-z0-9-]+\.html$/i.test(page)) { login.searchParams.set('next', page); }
  return new Response(null, { status: 302, headers: { Location: login.toString(), 'Cache-Control': 'no-store' } });
}
