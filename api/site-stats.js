/* ============================================================================
   /api/site-stats — the numbers behind the sanctuaryci.org page.

   GET ?site=sanctuaryci.org&days=30   (signed in, or the X-Projects-Password header)

   Calls the site_stats() function in Supabase (supabase/site-analytics.sql),
   which does all the counting in the database and returns one JSON object.
   ========================================================================== */

const { sendJSON, supabase } = require('../lib/db');
const { authorize } = require('../lib/auth');

const DAYS = [1, 7, 30, 90, 365];

module.exports = async function handler(req, res) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(function (k) { return !process.env[k]; });
  if (missing.length) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Site analytics are not set up yet: missing ' + missing.join(', ') + '.' });
  }
  if (!(await authorize(req))) {
    return sendJSON(res, 401, { error: 'password', message: 'Sign in, or enter the team password.' });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  }

  const q = new URL(req.url, 'http://x').searchParams;
  const site = String(q.get('site') || 'sanctuaryci.org').toLowerCase().replace(/^www\./, '');
  const days = Number(q.get('days')) || 30;
  if (!/^[a-z0-9.-]{3,100}$/.test(site)) { return sendJSON(res, 400, { error: 'site', message: 'Bad site.' }); }
  if (DAYS.indexOf(days) < 0) { return sendJSON(res, 400, { error: 'days', message: 'days must be one of ' + DAYS.join(', ') + '.' }); }

  try {
    const stats = await supabase('POST', '', { p_site: site, p_days: days }, null, 'rpc/site_stats');
    return sendJSON(res, 200, stats);
  } catch (e) {
    /* PGRST202 = the function doesn't exist yet (SQL not run) */
    const missingFn = e.status === 404 || /PGRST202|PGRST205|site_stats|site_events/.test(e.message);
    return sendJSON(res, 502, {
      error: missingFn ? 'schema' : 'storage',
      message: missingFn ? 'The analytics tables aren\'t in Supabase yet — run supabase/site-analytics.sql in the SQL Editor.'
        : 'Could not reach the analytics database. Try again shortly.'
    });
  }
};
