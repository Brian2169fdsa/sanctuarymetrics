/* ============================================================================
   /api/projects — the shared store behind the Projects page.

   Rows live in a Supabase table (public.projects). The browser never talks to
   Supabase directly: this function holds the secret key server-side and the
   page reaches it with a shared team password.

   Environment variables (Vercel → Settings → Environment Variables):

     SUPABASE_URL                required. e.g. https://abcd1234.supabase.co
     SUPABASE_SERVICE_ROLE_KEY   required. The secret (service_role / sb_secret_)
                                 key — server-side only, never sent to the page.
     PROJECTS_PASSWORD           optional. The old shared team password, still
                                 accepted as an alternative to signing in.

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

   and for who added / last changed a project (also in supabase/accounts.sql):

     alter table public.projects
       add column if not exists created_by      uuid references public.app_users (id) on delete set null,
       add column if not exists created_by_name text,
       add column if not exists updated_by_name text;

   Two kinds of row share the table:
     seed_key = null      a project added on the page
     seed_key = <title>   the page's edits to an L10 rock (status, importance,
                          due date) — the rock itself still comes from data.js

   Who sees what: people with Reports access (and admins) see and edit the
   whole list. Staff see only the requests they filed themselves (print,
   website, flyer, presentation, social…) and can't change them — they follow
   along and use each one's messages.

   Routes (all need a signed-in account — see api/auth.js — or the old
   X-Projects-Password header):
     GET                  list every row
     POST   {fields}      add a project
     PATCH  ?id=… {fields}        edit a project
     PUT    {seed_key, fields}    create-or-update the edits to an L10 rock
     DELETE ?id=…         remove a project
   ========================================================================== */

const { sendJSON, readBody, supabase, projectWrite, addedBy } = require('../lib/db');
const { authorize, access } = require('../lib/auth');

/* the only columns the page may write, with their maximum lengths */
const FIELDS = { title: 300, owner: 120, status: 120, importance: 20, due: 10, prev_status: 120, source: 200,
                 notes: 4000, event_date: 10, event_address: 300, event_time: 5, attendees: 4000 };
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
const MAX_ATTENDEES = 50;
const DATE_FIELDS = { due: 1, event_date: 1 };

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

async function handler(req, res) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(function (k) { return !process.env[k]; });
  if (missing.length) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Shared projects are not set up yet: missing ' + missing.join(', ') + '.' });
  }
  const who = await authorize(req);
  if (!who) {
    return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see the project list.' });
  }
  const me = who.user || null;
  /* staff (signed in, no Reports access) only follow their own requests */
  const staff = !!me && !access(me).reports;

  const id = new URL(req.url, 'http://x').searchParams.get('id');
  const now = new Date().toISOString();

  try {
    if (req.method === 'GET') {
      const rows = await supabase('GET', '?select=*' + (staff ? '&seed_key=is.null&created_by=eq.' + me.id : '') + '&order=created_at.asc');
      return sendJSON(res, 200, { rows: rows, staff: staff });
    }
    if (staff) {
      return sendJSON(res, 403, { error: 'access', message: 'Your requests are tracked here; marketing updates them. Use the messages to ask about one.' });
    }

    if (req.method === 'POST') {
      const fields = clean(await readBody(req));
      if (!fields.title) { return sendJSON(res, 400, { error: 'title', message: 'A project needs a title.' }); }
      /* who did it is stamped here from the signed-in account, never taken from the page */
      Object.assign(fields, addedBy(me));
      const rows = await projectWrite('POST', '', Object.assign(fields, { seed_key: null }));
      return sendJSON(res, 201, { row: rows[0] });
    }

    if (req.method === 'PATCH') {
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
      const fields = clean(await readBody(req));
      delete fields.title;   /* titles are fixed once added */
      fields.updated_at = now;
      if (me) { fields.updated_by_name = me.name; }
      const rows = await projectWrite('PATCH', '?id=eq.' + id, fields);
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
      if (me) { fields.updated_by_name = me.name; }
      const key = '?seed_key=eq.' + encodeURIComponent(seedKey);
      let rows = await projectWrite('PATCH', key, fields);
      if (!rows.length) {
        /* first edit to this rock: insert, without letting the table's
           'On-track' default override the L10 status */
        const row = Object.assign({ seed_key: seedKey, title: seedKey, source: 'L10 edit', status: '' }, addedBy(me), fields);
        try {
          rows = await projectWrite('POST', '', row);
        } catch (e) {
          if (e.status !== 409) { throw e; }
          rows = await projectWrite('PATCH', key, fields);   /* another tab inserted it first */
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
