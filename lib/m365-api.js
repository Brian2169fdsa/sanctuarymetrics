/* ============================================================================
   /api/m365 — the daily Microsoft 365 refresh and what the pages read.

   Served by api/cuts.js (vercel.json rewrites /api/m365 → /api/cuts?scope=m365)
   rather than as its own function: the Vercel plan allows 12 functions per
   deployment and api/ already has 12.

   Read (Cost management access, like the pages themselves):
     GET                    the latest snapshot: review (microsoft.html),
                            the AI review, warnings, when it was taken
     GET ?part=usage        the SharePoint / Teams / Groups / Email payload
     GET ?part=history      one headline row per day, for the trend

   Run (Vercel cron with Authorization: Bearer <CRON_SECRET>, or an admin):
     GET|POST ?action=sync  pull Microsoft Graph, save today's snapshot
                            (cron: /api/m365-sync, rewritten in vercel.json)
     GET|POST ?action=ai    Claude reviews today's snapshot; cuts it
                            recommends go to the Cost cutting approval queue
                            (cron: /api/m365-ai)
     POST     ?action=all   both in one call (may not fit the 60s limit;
                            the page's "Refresh now" calls them one by one)

   Snapshots keep their full detail for 14 days; older rows keep only the
   headline numbers. Tables: supabase/m365.sql. Setup: M365_SYNC.md.
   ========================================================================== */

const { sendJSON, supabase } = require('./db');
const A = require('./auth');
const M = require('./m365');
const AI = require('./m365-ai');

const TABLE = 'm365_snapshots';
const KEEP_DETAIL_DAYS = 14;

function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }); }

async function latest(cols) {
  return (await supabase('GET', '?review=not.is.null&order=taken_on.desc&limit=1&select=' + cols, null, null, TABLE))[0] || null;
}

async function sync() {
  if (!M.configured()) {
    const e = new Error('The Microsoft app isn\'t connected — set M365_CLIENT_ID / M365_CLIENT_SECRET (or MS_CLIENT_ID / MS_CLIENT_SECRET).');
    e.code = 'not_configured';
    throw e;
  }
  const keep = await supabase('GET', '?select=upn,reason', null, null, 'm365_keep');
  let dec = { exclude: {} };
  try { dec = await AI.decisions(); } catch (e) { /* source/ai_key columns not added yet */ }
  const raw = await M.pull();
  const b = M.build(raw, { keep: keep, exclude: dec.exclude, today: today() });
  const day = today();
  await supabase('POST', '?on_conflict=taken_on', { taken_on: day, refreshed_at: new Date().toISOString(), report_date: b.ref,
    review: b.review, usage: b.usage, summary: b.summary, warnings: b.warnings }, { Prefer: 'resolution=merge-duplicates,return=minimal' }, TABLE);
  await supabase('PATCH', '?taken_on=lt.' + daysAgo(KEEP_DETAIL_DAYS) + '&review=not.is.null', { review: null, usage: null },
    { Prefer: 'return=minimal' }, TABLE);
  return { taken_on: day, report_date: b.ref, summary: b.summary, warnings: b.warnings };
}

async function review() {
  if (!process.env.ANTHROPIC_API_KEY) { const e = new Error('Claude isn\'t connected yet — add ANTHROPIC_API_KEY in Vercel.'); e.code = 'not_configured'; throw e; }
  const snap = await latest('taken_on,review');
  if (!snap) { const e = new Error('No Microsoft snapshot yet — run the sync first.'); e.code = 'no_data'; throw e; }
  const hist = (await supabase('GET', '?taken_on=gte.' + daysAgo(120) + '&select=taken_on,summary&order=taken_on.asc', null, null, TABLE))
    .filter(function (r, i, all) { return i % 7 === 0 || i === all.length - 1; })
    .map(function (r) { return Object.assign({ day: r.taken_on }, r.summary); });
  try {
    const dec = await AI.decisions();
    const res = await AI.ask(snap.review, hist, dec.brief);
    const settled = AI.settle(snap.review, res.out);
    const queue = await AI.syncQueue(snap.review, settled);
    settled.queue = queue;
    await supabase('PATCH', '?taken_on=eq.' + snap.taken_on, { ai: settled, ai_model: res.model, ai_at: new Date().toISOString(), ai_error: null },
      { Prefer: 'return=minimal' }, TABLE);
    return { taken_on: snap.taken_on, model: res.model, recommendations: settled.recommendations.length, queue: queue };
  } catch (e) {
    const msg = e instanceof SyntaxError ? 'Claude\'s review came back garbled.' : String(e.message || e).slice(0, 300);
    await supabase('PATCH', '?taken_on=eq.' + snap.taken_on, { ai_error: msg, ai_at: new Date().toISOString() }, { Prefer: 'return=minimal' }, TABLE);
    throw e;
  }
}

module.exports = async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'The database is not set up yet.' });
  }
  const q = new URL(req.url, 'http://x').searchParams;
  const action = q.get('action');
  try {
    if (action) {
      const cron = !!process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET;
      if (!cron) {
        const me = await A.currentUser(req);
        if (!me || me.role !== 'admin') { return sendJSON(res, 403, { error: 'admin', message: 'Only admins can refresh the Microsoft data.' }); }
        if (req.method !== 'POST') { return sendJSON(res, 405, { error: 'method', message: 'Use POST.' }); }
      }
      if (action === 'sync') { return sendJSON(res, 200, await sync()); }
      if (action === 'ai') { return sendJSON(res, 200, await review()); }
      if (action === 'all') {
        const s = await sync();
        let r;
        try { r = await review(); } catch (e) { r = { error: String(e.message || e).slice(0, 300) }; }
        return sendJSON(res, 200, { sync: s, ai: r });
      }
      return sendJSON(res, 400, { error: 'action', message: 'Unknown action.' });
    }

    if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' }); }
    const who = await A.authorize(req);
    if (!who) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see the Microsoft data.' }); }
    if (!A.access(who.user || null).costs) { return sendJSON(res, 403, { error: 'access', message: 'Cost management is only open to the people an admin has given it to.' }); }
    const part = q.get('part') || 'review';
    if (part === 'history') {
      return sendJSON(res, 200, { history: await supabase('GET', '?select=taken_on,report_date,summary&order=taken_on.asc&limit=1000', null, null, TABLE) });
    }
    const cols = part === 'usage' ? 'taken_on,refreshed_at,usage' : 'taken_on,refreshed_at,report_date,review,warnings,ai,ai_model,ai_at,ai_error';
    const row = await latest(cols);
    if (!row) { return sendJSON(res, 404, { error: 'no_data', message: 'No Microsoft snapshot yet.' }); }
    return sendJSON(res, 200, row);
  } catch (e) {
    if (e.code === 'not_configured' || e.code === 'no_data') { return sendJSON(res, 503, { error: e.code, message: e.message }); }
    if (e.status && /Microsoft Graph/.test(e.message)) { return sendJSON(res, 502, { error: 'graph', message: e.message }); }
    const schema = /PGRST20[25]|m365_|ai_key|does not exist/.test(e.message);
    return sendJSON(res, 502, { error: schema ? 'schema' : 'failed',
      message: schema ? 'The Microsoft tables aren\'t in Supabase yet — run supabase/m365.sql in the SQL Editor.' : String(e.message || e).slice(0, 300) });
  }
};
