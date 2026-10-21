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
   - /api/*: each function checks access itself, and sanctuaryci.org posts
     analytics to /api/collect
   - images, fonts, scripts and styles, so login.html can draw itself        */

const OPEN_PAGES = new Set(['/login.html', '/account.html']);
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|js|map|txt)$/i;

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

async function signedIn(request) {
  const token = cookie(request, 'sm_session');
  if (!token || token.length > 100) { return false; }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/app_sessions?token_hash=eq.' + (await sha256(token)) +
    '&expires_at=gt.' + encodeURIComponent(new Date().toISOString()) + '&select=user:app_users(disabled)';
  const r = await fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) { return false; }
  const rows = await r.json();
  return !!(rows[0] && rows[0].user && !rows[0].user.disabled);
}

export default async function middleware(request) {
  const path = new URL(request.url).pathname;
  if (OPEN_PAGES.has(path) || ASSET.test(path)) { return; }
  /* accounts not set up on this deployment: nobody could sign in, so don't lock the site */
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { return; }
  try {
    if (await signedIn(request)) { return; }
  } catch (e) {
    /* Supabase didn't answer — fall through to the sign-in page, which says so */
  }
  const page = path.replace(/^\/+/, '') || 'index.html';
  const login = new URL('/login.html', request.url);
  if (/^[a-z0-9-]+\.html$/i.test(page)) { login.searchParams.set('next', page); }
  return new Response(null, { status: 302, headers: { Location: login.toString(), 'Cache-Control': 'no-store' } });
}
