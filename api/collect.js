/* ============================================================================
   /api/collect — visitor analytics from sanctuaryci.org, in and out.

   POST  events from the site's tracker (below)
   GET   ?site=sanctuaryci.org&days=30 — the totals behind sanctuaryci.html,
         for signed-in people with Reports access. (This was /api/site-stats;
         it lives here so the site stays within Vercel's 12 functions.)

   The site loads analytics.js, which sends small batches of events here with
   navigator.sendBeacon (a "simple" cross-origin POST, so no preflight). Each
   event becomes a row in public.site_events (see supabase/site-analytics.sql).

   Public by design — browsers call it — so it:
     - only accepts requests whose Origin is in ANALYTICS_ORIGINS
     - drops bots and crawlers by user agent
     - keeps only known fields, each capped in length
     - never stores the IP address; location is Vercel's coarse
       country / region / city for the request

   Environment variables:
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required (same as projects)
     ANALYTICS_ORIGINS   optional, comma-separated. Defaults to
                         https://sanctuaryci.org,https://www.sanctuaryci.org
   ========================================================================== */

const { sendJSON, supabase } = require('../lib/db');
const A = require('../lib/auth');

const DEFAULT_ORIGINS = 'https://sanctuaryci.org,https://www.sanctuaryci.org';
const TYPES = { pageview: 1, engage: 1, click: 1, form: 1, vital: 1 };
const MAX_EVENTS = 25;
const MAX_BODY = 32000;
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|python-requests|curl|wget|httpclient|axios|node-fetch|phantom|selenium|puppeteer|playwright/i;
/* text columns the browser may set, with their maximum lengths */
const TEXT = { path: 300, title: 200, visitor_id: 40, session_id: 40, pageview_id: 40, referrer: 500,
               utm_source: 100, utm_medium: 100, utm_campaign: 150, utm_content: 150, utm_term: 150,
               lang: 20, tz: 60, screen: 20, target: 300, label: 120 };

function allowed() {
  return (process.env.ANALYTICS_ORIGINS || DEFAULT_ORIGINS).split(',').map(function (s) { return s.trim().replace(/\/+$/, ''); });
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  const ok = allowed().indexOf(origin) >= 0;
  if (ok) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  return ok;
}

function rawBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === 'string' ? req.body
      : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
  }
  return new Promise(function (resolve, reject) {
    let raw = '';
    req.on('data', function (c) {
      raw += c;
      if (raw.length > MAX_BODY) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', function () { resolve(raw); });
    req.on('error', reject);
  });
}

/* coarse browser / OS / device from the user agent — no fingerprinting */
function agent(ua) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /FBAN|FBAV|Instagram|LinkedInApp/.test(ua) ? 'In-app (social)' : /Firefox|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const device = /iPad|Tablet|Android(?!.*Mobile)/.test(ua) ? 'tablet' : /Mobi|iPhone|iPod|Android/.test(ua) ? 'mobile' : 'desktop';
  return { browser: browser, os: os, device: device };
}

function header(req, name) {
  const v = req.headers[name];
  if (!v) { return null; }
  try { return decodeURIComponent(String(v)).slice(0, 80); } catch (e) { return String(v).slice(0, 80); }
}

function refDomain(ref, site) {
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    return host === site ? null : host;   /* moving between the site's own pages isn't a referral */
  } catch (e) { return null; }
}

/* every column a row can carry — a bulk insert needs the same keys on every row */
const COLUMNS = ['site', 'type', 'new_visitor', 'ref_domain', 'device', 'browser', 'os', 'country', 'region', 'city',
                 'scroll_pct', 'engaged_ms', 'props'].concat(Object.keys(TEXT));

function row(e, base) {
  const out = {};
  COLUMNS.forEach(function (k) { out[k] = null; });
  Object.assign(out, base, { type: e.type });
  Object.keys(TEXT).forEach(function (k) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') { out[k] = String(e[k]).slice(0, TEXT[k]); }
  });
  if (out.path && out.path.charAt(0) !== '/') { out.path = '/' + out.path; }
  if (e.type === 'pageview') {
    out.new_visitor = e.new_visitor === true;
    out.ref_domain = out.referrer ? refDomain(out.referrer, base.site) : null;
    if (!out.ref_domain) { out.referrer = null; }
  }
  if (e.scroll_pct !== undefined) { out.scroll_pct = Math.max(0, Math.min(100, Math.round(Number(e.scroll_pct) || 0))); }
  if (e.engaged_ms !== undefined) { out.engaged_ms = Math.max(0, Math.min(6 * 3600 * 1000, Math.round(Number(e.engaged_ms) || 0))); }
  if (e.props && typeof e.props === 'object') {
    const p = JSON.stringify(e.props);
    if (p.length <= 1000) { out.props = e.props; }
  }
  return out;
}

/* GET: site_stats() in Supabase (supabase/site-analytics.sql) does the counting */
const DAYS = [1, 7, 30, 90, 365];
async function stats(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Site analytics are not set up yet.' });
  }
  let me = null;
  try { me = await A.currentUser(req); } catch (e) { /* accounts not set up */ }
  if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see the site numbers.' }); }
  if (!A.access(me).reports) { return sendJSON(res, 403, { error: 'access', message: 'The reports are open to people with Reports access.' }); }
  const q = new URL(req.url, 'http://x').searchParams;
  const site = String(q.get('site') || 'sanctuaryci.org').toLowerCase().replace(/^www\./, '');
  const days = Number(q.get('days')) || 30;
  if (!/^[a-z0-9.-]{3,100}$/.test(site)) { return sendJSON(res, 400, { error: 'site', message: 'Bad site.' }); }
  if (DAYS.indexOf(days) < 0) { return sendJSON(res, 400, { error: 'days', message: 'days must be one of ' + DAYS.join(', ') + '.' }); }
  try {
    return sendJSON(res, 200, await supabase('POST', '', { p_site: site, p_days: days }, null, 'rpc/site_stats'));
  } catch (e) {
    /* PGRST202 = the function doesn't exist yet (SQL not run) */
    const missingFn = e.status === 404 || /PGRST202|PGRST205|site_stats|site_events/.test(e.message);
    return sendJSON(res, 502, {
      error: missingFn ? 'schema' : 'storage',
      message: missingFn ? 'The analytics tables aren\'t in Supabase yet — run supabase/site-analytics.sql in the SQL Editor.'
        : 'Could not reach the analytics database. Try again shortly.'
    });
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') { return stats(req, res); }
  const originOk = cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = originOk ? 204 : 403; return res.end(); }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return sendJSON(res, 405, { error: 'method' });
  }
  if (!originOk) { return sendJSON(res, 403, { error: 'origin' }); }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured' });
  }
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT.test(ua)) { res.statusCode = 204; return res.end(); }

  let body;
  try { body = JSON.parse(await rawBody(req)); } catch (e) { return sendJSON(res, 400, { error: 'bad_request' }); }
  const events = (Array.isArray(body && body.events) ? body.events : [])
    .filter(function (e) { return e && TYPES[e.type]; }).slice(0, MAX_EVENTS);
  if (!events.length) { res.statusCode = 204; return res.end(); }

  const a = agent(ua);
  const base = {
    site: new URL(req.headers.origin).hostname.replace(/^www\./, ''),
    browser: a.browser, os: a.os, device: a.device,
    country: header(req, 'x-vercel-ip-country'),
    region: header(req, 'x-vercel-ip-country-region'),
    city: header(req, 'x-vercel-ip-city')
  };

  try {
    await supabase('POST', '', events.map(function (e) { return row(e, base); }), { Prefer: 'return=minimal' }, 'site_events');
  } catch (e) {
    return sendJSON(res, 502, { error: 'storage' });
  }
  res.statusCode = 204;
  return res.end();
};
