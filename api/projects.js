/* ============================================================================
   /api/projects — the shared store behind the Projects page.

   Rows live in a Supabase table (public.projects). The browser never talks to
   Supabase directly: this function holds the secret key server-side and the
   page reaches it with a shared team password.

   Environment variables (Vercel → Settings → Environment Variables):

     SUPABASE_URL                required. e.g. https://abcd1234.supabase.co
     SUPABASE_SERVICE_ROLE_KEY   required. The secret (service_role / sb_secret_)
                                 key — server-side only, never sent to the page.
     PROJECTS_PASSWORD           required. The word the page asks for once.

   It fails closed: any missing variable returns a clear message rather than
   running with an open table.

   Table columns added after launch (run once in Supabase → SQL Editor):

     alter table public.projects
       add column if not exists notes         text,
       add column if not exists is_event      boolean not null default false,
       add column if not exists event_date    date,
       add column if not exists event_address text;

     and for meeting invites (Teams / Outlook buttons on the page):

     alter table public.projects
       add column if not exists event_time     text,      -- 'HH:MM', 24-hour
       add column if not exists event_duration integer,   -- minutes
       add column if not exists attendees      text;      -- comma-separated emails
     notify pgrst, 'reload schema';

   Two kinds of row share the table:
     seed_key = null      a project added on the page
     seed_key = <title>   the page's edits to an L10 rock (status, importance,
                          due date) — the rock itself still comes from data.js

   Routes (all need the X-Projects-Password header):
     GET                  list every row
     POST   {fields}      add a project
     PATCH  ?id=… {fields}        edit a project
     PUT    {seed_key, fields}    create-or-update the edits to an L10 rock
     DELETE ?id=…         remove a project
   ========================================================================== */

const crypto = require('crypto');

const TABLE = 'projects';
/* the only columns the page may write, with their maximum lengths */
const FIELDS = { title: 300, owner: 120, status: 120, importance: 20, due: 10, prev_status: 120, source: 200,
                 notes: 4000, event_date: 10, event_address: 300, event_time: 5, attendees: 4000 };
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
const MAX_ATTENDEES = 50;
const DATE_FIELDS = { due: 1, event_date: 1 };

function sendJSON(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }
  return new Promise(function (resolve, reject) {
    let raw = '';
    req.on('data', function (c) {
      raw += c;
      if (raw.length > 20000) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', function () {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* constant-time compare so the password can't be guessed a character at a time */
function passwordOk(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/* keep only known columns; empty strings become null so dates stay valid */
function clean(input) {
  const out = {};
  Object.keys(FIELDS).forEach(function (k) {
    if (!(k in (input || {}))) { return; }
    let v = input[k];
    if (v === null || v === undefined || v === '') { out[k] = null; return; }
    v = String(v).trim().slice(0, FIELDS[k]);
    if (DATE_FIELDS[k] && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { throw new Error(k + ' must be YYYY-MM-DD'); }
    if (k === 'event_time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) { throw new Error('event_time must be HH:MM'); }
    if (k === 'attendees') {
      const list = v.split(/[\s,;]+/).filter(Boolean);
      const bad = list.filter(function (a) { return !EMAIL.test(a); });
      if (bad.length) { throw new Error('Not an email address: ' + bad.slice(0, 3).join(', ')); }
      if (list.length > MAX_ATTENDEES) { throw new Error('Too many invitees (max ' + MAX_ATTENDEES + ')'); }
      v = list.filter(function (a, i) { return list.indexOf(a) === i; }).join(', ') || null;
    }
    out[k] = v;
  });
  if ('event_duration' in (input || {})) {
    const d = input.event_duration;
    if (d === null || d === undefined || d === '') { out.event_duration = null; }
    else {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 5 || n > 1440) { throw new Error('event_duration must be 5–1440 minutes'); }
      out.event_duration = n;
    }
  }
  /* the event flag is the one non-text column */
  if ('is_event' in (input || {})) { out.is_event = input.is_event === true || input.is_event === 'true'; }
  /* turning the event flag off clears the event details with it */
  if (out.is_event === false) {
    out.event_date = null; out.event_address = null;
    out.event_time = null; out.event_duration = null; out.attendees = null;
  }
  return out;
}

/* one call to Supabase's REST API (PostgREST) */
async function supabase(method, query, body, extraHeaders) {
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + TABLE + (query || '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = Object.assign({
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }, extraHeaders || {});
  const r = await fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error('Supabase ' + r.status + ': ' + text.slice(0, 300));
    err.status = r.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function handler(req, res) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'PROJECTS_PASSWORD']
    .filter(function (k) { return !process.env[k]; });
  if (missing.length) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Shared projects are not set up yet: missing ' + missing.join(', ') + '.' });
  }
  if (!passwordOk(req.headers['x-projects-password'], process.env.PROJECTS_PASSWORD)) {
    return sendJSON(res, 401, { error: 'password', message: 'Wrong or missing team password.' });
  }

  const id = new URL(req.url, 'http://x').searchParams.get('id');
  const now = new Date().toISOString();

  try {
    if (req.method === 'GET') {
      const rows = await supabase('GET', '?select=*&order=created_at.asc');
      return sendJSON(res, 200, { rows: rows });
    }

    if (req.method === 'POST') {
      const fields = clean(await readBody(req));
      if (!fields.title) { return sendJSON(res, 400, { error: 'title', message: 'A project needs a title.' }); }
      const rows = await supabase('POST', '', Object.assign(fields, { seed_key: null }));
      return sendJSON(res, 201, { row: rows[0] });
    }

    if (req.method === 'PATCH') {
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
      const fields = clean(await readBody(req));
      delete fields.title;   /* titles are fixed once added */
      fields.updated_at = now;
      const rows = await supabase('PATCH', '?id=eq.' + id, fields);
      if (!rows.length) { return sendJSON(res, 404, { error: 'not_found', message: 'That project no longer exists.' }); }
      return sendJSON(res, 200, { row: rows[0] });
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const seedKey = String(body.seed_key || '').trim().slice(0, 300);
      if (!seedKey) { return sendJSON(res, 400, { error: 'seed_key', message: 'Missing seed_key.' }); }
      const fields = clean(body.fields || {});
      delete fields.title;
      /* status is NOT NULL in the table. On an L10 edit row an empty status
         means "no override — show the L10 status", so null is stored as ''. */
      if ('status' in fields && fields.status === null) { fields.status = ''; }
      fields.updated_at = now;
      const key = '?seed_key=eq.' + encodeURIComponent(seedKey);
      let rows = await supabase('PATCH', key, fields);
      if (!rows.length) {
        /* first edit to this rock: insert, without letting the table's
           'On-track' default override the L10 status */
        const row = Object.assign({ seed_key: seedKey, title: seedKey, source: 'L10 edit', status: '' }, fields);
        try {
          rows = await supabase('POST', '', row);
        } catch (e) {
          if (e.status !== 409) { throw e; }
          rows = await supabase('PATCH', key, fields);   /* another tab inserted it first */
        }
      }
      return sendJSON(res, 200, { row: rows[0] });
    }

    if (req.method === 'DELETE') {
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
      /* only page-added projects can be removed; L10 edit rows stay */
      await supabase('DELETE', '?id=eq.' + id + '&seed_key=is.null');
      return sendJSON(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, PUT, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    const bad = /must be |Not an email|Too many invitees|JSON|body too large/.test(e.message);
    /* PGRST204 = a column the page sent doesn't exist yet (table not migrated) */
    const missingColumn = /PGRST204|Could not find the .* column/.test(e.message);
    return sendJSON(res, bad ? 400 : 502, {
      error: bad ? 'bad_request' : (missingColumn ? 'schema' : 'storage'),
      message: bad ? e.message
        : missingColumn ? 'The projects table is missing a newer column — run the latest update SQL in Supabase (see api/projects.js).'
        : 'Could not reach the projects database. ' + (e.status === 404 ? 'Check the projects table exists.' : 'Try again shortly.')
    });
  }
}

module.exports = handler;
/* shared with api/requests.js, which files print orders into this same table */
module.exports.helpers = { sendJSON: sendJSON, readBody: readBody, passwordOk: passwordOk, supabase: supabase };
