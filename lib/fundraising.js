/* ============================================================================
   The shared store behind the SCI Fundraising page (fundraising.html).

   Served from /api/projects?store=fundraising (vercel.json also rewrites
   /api/fundraising-state to it). It lives inside the Projects function, not
   a function of its own, because the site is at Vercel's 12-function limit —
   and because it is the same storage the Projects page already uses: a
   Supabase table (supabase/fundraising.sql) reached only server-side with
   the service-role key.

   Who may call it:
     - signed-in people with Reports access (or the old team password):
       read everything; change checklist, decision, post and campaign items
     - admins: also the page settings (auto-posting switch, QCO confirmation)
     - n8n, with the X-Fundraising-Sync-Secret header matching
       FUNDRAISING_SYNC_SECRET: read everything, record automation runs, and
       move an already-approved post to scheduled/posted. It can't approve.

   Routes:
     GET                                   → {items: {item_id: {kind, data, updated_at, updated_by_name}}, admin}
     PUT    {id: 'post:gt-05', data: {…}}  merge fields into one item
     POST   ?action=copy {template, date}  dated copy of a template post → {id}
     POST   ?action=run {id: 'f3', status: 'success'|'error', message?, at?}   n8n only
     DELETE ?id=copy:c-…                   remove a dated copy (and its post state)

   Rules enforced here as well as on the page:
     - a post marked held can't reach approved/scheduled/posted until an
       admin has recorded the qualifying-charity confirmation and its code
     - a needsRelease post needs a release recorded first
     - a needsApprovalFrom post needs the approval recorded first
   No donor data is accepted: every field is a status, a link, or a short note.
   ========================================================================== */

const crypto = require('crypto');
const { sendJSON, readBody, supabase, passwordOk } = require('./db');
const { authorize, access } = require('./auth');
const PLAN = require('../data/sci-fundraising-data.json');

const TABLE = 'fundraising_state';
const CHECK_STATUS = ['not-started', 'in-progress', 'done'];
const DECISION_STATUS = ['open', 'decided'];
const POST_STATUS = ['draft', 'in-review', 'approved', 'scheduled', 'posted', 'skipped'];
const APPROVED_UP = { approved: 1, scheduled: 1, posted: 1 };
const RUN_STATUS = ['success', 'error', 'running'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COPY_ID = /^c-[a-z0-9]{8,16}$/;

const POSTS = {};
PLAN.socialPosts.forEach(function (p) { POSTS[p.id] = p; });
const CHECKS = {};
PLAN.checklist.forEach(function (c) { CHECKS[c.id] = c; });
const DECISIONS = {};
PLAN.decisions.forEach(function (d) { DECISIONS[d.id] = d; });
const CAMPAIGNS = {};
PLAN.campaigns.forEach(function (c) { CAMPAIGNS[c.id] = c; });
const FLOWS = {};
PLAN.automations.forEach(function (a) { FLOWS[a.id] = a; });

function bad(message) { const e = new Error(message); e.bad = true; return e; }

function text(v, max) {
  if (v === null || v === undefined) { return ''; }
  return String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}
function url(v) {
  const s = text(v, 500);
  if (!s) { return ''; }
  if (!/^https?:\/\/[^\s<>"']+$/i.test(s)) { throw bad('Links must start with http:// or https://'); }
  return s;
}
function oneOf(v, list, what) {
  if (list.indexOf(v) < 0) { throw bad(what + ' must be one of: ' + list.join(', ')); }
  return v;
}

/* the plan post behind a post id: a plan post, or the template a dated copy came from */
async function postDef(postId, rows) {
  if (POSTS[postId]) { return POSTS[postId]; }
  if (COPY_ID.test(postId)) {
    const copy = rows['copy:' + postId];
    if (copy && POSTS[copy.data.template]) { return Object.assign({}, POSTS[copy.data.template], { date: copy.data.date }); }
  }
  return null;
}

/* why a post can't be approved yet, or '' */
function blocker(def, data, settings) {
  const qco = (settings['setting:qco'] && settings['setting:qco'].data) || {};
  if (def.held && !(qco.confirmed && /^\d{5}$/.test(String(qco.code || '')))) {
    return 'Held: awaiting qualifying charity confirmation. An admin records the confirmation and the five-digit code first.';
  }
  if (def.needsRelease && !text(data.release, 300)) { return 'This post needs a signed release recorded on it before it can be approved.'; }
  if (def.needsApprovalFrom && !text(data.approvedBy, 120)) {
    return 'This post needs ' + def.needsApprovalFrom + '\'s approval recorded before it can be approved.';
  }
  return '';
}

/* every row, keyed by item_id */
async function allRows() {
  const list = await supabase('GET', '?select=item_id,kind,data,updated_at,updated_by_name&order=item_id.asc', null, null, TABLE);
  const out = {};
  (list || []).forEach(function (r) { out[r.item_id] = r; });
  return out;
}
async function upsert(itemId, kind, data, who) {
  const rows = await supabase('POST', '?on_conflict=item_id', [{
    item_id: itemId, kind: kind, data: data, updated_at: new Date().toISOString(), updated_by_name: who || null
  }], { Prefer: 'resolution=merge-duplicates,return=representation' }, TABLE);
  return rows && rows[0];
}

/* the fields one kind of item may hold, cleaned; prev is what's stored */
function cleanItem(kind, key, input, prev, ctx) {
  const out = Object.assign({}, prev);
  const has = function (k) { return Object.prototype.hasOwnProperty.call(input, k); };
  if (kind === 'check') {
    if (!CHECKS[key]) { throw bad('Unknown checklist item.'); }
    if (has('status')) { out.status = oneOf(input.status, CHECK_STATUS, 'status'); }
    if (has('note')) { out.note = text(input.note, 1000); }
  } else if (kind === 'decision') {
    if (!DECISIONS[key]) { throw bad('Unknown decision.'); }
    if (has('status')) { out.status = oneOf(input.status, DECISION_STATUS, 'status'); }
    if (has('notes')) { out.notes = text(input.notes, 2000); }
  } else if (kind === 'campaign') {
    if (!CAMPAIGNS[key]) { throw bad('Unknown campaign.'); }
    if (has('link')) { out.link = url(input.link); }
  } else if (kind === 'post') {
    if (has('status')) { out.status = oneOf(input.status, POST_STATUS, 'status'); }
    if (has('finalLink')) { out.finalLink = url(input.finalLink); }
    if (has('publishedUrl')) { out.publishedUrl = url(input.publishedUrl); }
    if (has('release')) { out.release = text(input.release, 300); }
    if (has('approvedBy')) { out.approvedBy = text(input.approvedBy, 120); }
    if (has('note')) { out.note = text(input.note, 1000); }
  } else if (kind === 'setting') {
    if (!ctx.admin) { throw Object.assign(new Error('Only an admin can change page settings.'), { status: 403 }); }
    if (key === 'autopost') {
      if (has('on')) { out.on = input.on === true; }
    } else if (key === 'qco') {
      if (has('confirmed')) { out.confirmed = input.confirmed === true; }
      if (has('code')) {
        const c = text(input.code, 5);
        if (c && !/^\d{5}$/.test(c)) { throw bad('The QCO code is five digits.'); }
        out.code = c;
      }
      if (has('source')) { out.source = text(input.source, 300); }
    } else { throw bad('Unknown setting.'); }
  } else {
    throw bad('That item can\'t be changed here.');
  }
  return out;
}

async function handle(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Shared state is not set up yet: missing Supabase settings.' });
  }
  const q = new URL(req.url, 'http://x').searchParams;
  const action = q.get('action');

  /* n8n: the shared sync secret, compared in constant time */
  const given = req.headers['x-fundraising-sync-secret'];
  const sync = !!(given && process.env.FUNDRAISING_SYNC_SECRET && passwordOk(given, process.env.FUNDRAISING_SYNC_SECRET));
  let me = null, admin = false, who = 'n8n';
  if (!sync) {
    const a = await authorize(req);
    if (!a) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see the fundraising plan.' }); }
    me = a.user || null;
    if (me && !access(me).reports) { return sendJSON(res, 403, { error: 'access', message: 'The fundraising page needs Reports access.' }); }
    admin = !!(me && access(me).admin);
    who = me ? me.name : 'Team password';
  }

  try {
    if (req.method === 'GET') {
      const rows = await allRows();
      return sendJSON(res, 200, { items: rows, admin: admin });
    }

    if (req.method === 'POST' && action === 'run') {
      if (!sync) { return sendJSON(res, 403, { error: 'access', message: 'Only the automations report runs.' }); }
      const body = await readBody(req);
      const id = text(body.id, 10);
      if (!FLOWS[id]) { throw bad('Unknown automation id.'); }
      const rows = await allRows();
      const prev = (rows['run:' + id] && rows['run:' + id].data) || {};
      const at = body.at && !isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : new Date().toISOString();
      const status = oneOf(body.status || 'success', RUN_STATUS, 'status');
      /* a rolling 7-day list of run times, so the page can count runs and errors */
      const cutoff = Date.now() - 7 * 864e5;
      const recent = (prev.recent || []).filter(function (r) { return Date.parse(r.at) >= cutoff; }).slice(-1500);
      recent.push({ at: at, ok: status !== 'error' });
      const data = { lastRun: at, lastStatus: status, message: text(body.message, 300), recent: recent };
      await upsert('run:' + id, 'run', data, 'n8n');
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && action === 'copy') {
      if (sync) { return sendJSON(res, 403, { error: 'access', message: 'Copies are made on the page.' }); }
      const body = await readBody(req);
      const tpl = POSTS[text(body.template, 40)];
      if (!tpl || !tpl.schedule) { throw bad('Pick one of the unscheduled template posts.'); }
      if (!DATE.test(String(body.date || ''))) { throw bad('Pick a date for the copy.'); }
      const id = 'c-' + crypto.randomBytes(6).toString('hex');
      await upsert('copy:' + id, 'copy', { template: tpl.id, date: body.date }, who);
      return sendJSON(res, 201, { id: id });
    }

    if (req.method === 'DELETE') {
      if (sync) { return sendJSON(res, 403, { error: 'access', message: 'Copies are removed on the page.' }); }
      const id = String(q.get('id') || '').replace(/^copy:/, '');
      if (!COPY_ID.test(id)) { throw bad('Only dated copies can be removed.'); }
      await supabase('DELETE', '?item_id=in.(' + encodeURIComponent('copy:' + id) + ',' + encodeURIComponent('post:' + id) + ')', null, null, TABLE);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const itemId = text(body.id, 120);
      const m = /^(check|decision|post|campaign|setting):([A-Za-z0-9_-]{1,40})$/.exec(itemId);
      if (!m) { throw bad('Unknown item.'); }
      const kind = m[1], key = m[2];
      const input = body.data && typeof body.data === 'object' ? body.data : {};
      const rows = await allRows();
      const prev = (rows[itemId] && rows[itemId].data) || {};

      if (sync) {
        /* n8n may only record that an approved post went out */
        if (kind !== 'post') { return sendJSON(res, 403, { error: 'access', message: 'The automations may only update posts.' }); }
        const okKeys = Object.keys(input).every(function (k) { return k === 'status' || k === 'publishedUrl'; });
        if (!okKeys || (input.status && ['scheduled', 'posted'].indexOf(input.status) < 0) || !APPROVED_UP[prev.status]) {
          return sendJSON(res, 403, { error: 'access', message: 'The automations can only mark an approved post scheduled or posted.' });
        }
      }

      const data = cleanItem(kind, key, input, prev, { admin: admin });
      if (kind === 'post') {
        const def = await postDef(key, rows);
        if (!def) { throw bad('Unknown post.'); }
        if (APPROVED_UP[data.status]) {
          const why = blocker(def, data, rows);
          if (why) { return sendJSON(res, 409, { error: 'blocked', message: why }); }
        }
      }
      const row = await upsert(itemId, kind, data, who);
      return sendJSON(res, 200, { row: row });
    }

    res.setHeader('Allow', 'GET, PUT, POST, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (e.status === 403) { return sendJSON(res, 403, { error: 'access', message: e.message }); }
    const isBad = e.bad || /JSON|body too large/.test(e.message);
    return sendJSON(res, isBad ? 400 : 502, {
      error: isBad ? 'bad_request' : 'storage',
      message: isBad ? e.message : 'Could not reach the fundraising table. ' +
        (e.status === 404 ? 'Run supabase/fundraising.sql in Supabase first.' : 'Try again shortly.')
    });
  }
}

module.exports = { handle: handle, blocker: blocker, POST_STATUS: POST_STATUS };
