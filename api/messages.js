/* ============================================================================
   /api/messages — the conversation on each project (in its popover).

   A project is named by the same ref the Projects page uses:
     row:<uuid>          a project added on the page
     seed:<L10 title>    an L10 rock

     GET    ?ref=…          that project's messages, oldest first; marks them
                            (and their alerts) read for you
     GET    ?summary=1      per project: total, unread, last message time
     GET    ?people=1       everyone you can @tag: id and name
     POST   {ref, body}     post a message as you; anyone @tagged gets a
                            "tagged you" alert, everyone else the usual one
     DELETE ?id=…           remove a message (your own, or any as admin)
   ========================================================================== */

const { sendJSON, readBody, supabase } = require('../lib/db');
const A = require('../lib/auth');

const REF = /^(row:[0-9a-f-]{36}|seed:.{1,300})$/i;

async function projectTitle(ref) {
  if (ref.indexOf('seed:') === 0) { return ref.slice(5); }
  const rows = await supabase('GET', '?id=eq.' + ref.slice(4) + '&select=title', null, null, 'projects');
  return rows[0] ? rows[0].title : null;
}
function markRead(me, ref) {
  const now = new Date().toISOString();
  return Promise.all([
    supabase('POST', '?on_conflict=user_id,project_ref', { user_id: me.id, project_ref: ref, last_read_at: now },
             { Prefer: 'resolution=merge-duplicates,return=minimal' }, 'project_reads'),
    supabase('PATCH', '?user_id=eq.' + me.id + '&read_at=is.null&project_ref=eq.' + encodeURIComponent(ref),
             { read_at: now }, { Prefer: 'return=minimal' }, 'alerts')
  ]);
}

/* who a message @tags: "@Full Name" for anyone, or "@First" when only one
   person has that first name. Matching ignores case; a tag has to end at a
   word boundary so "@Kim" doesn't catch "@Kimberly".                        */
function tagged(text, people) {
  const low = text.toLowerCase();
  const ends = function (i) { return i >= low.length || !/[a-z0-9]/i.test(low[i]); };
  const has = function (name) {
    const t = '@' + name.toLowerCase();
    for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + 1)) { if (ends(i + t.length)) { return true; } }
    return false;
  };
  const firsts = {};
  people.forEach(function (p) { const f = p.name.split(/\s+/)[0].toLowerCase(); firsts[f] = (firsts[f] || 0) + 1; });
  return people.filter(function (p) {
    const first = p.name.split(/\s+/)[0];
    return has(p.name) || (firsts[first.toLowerCase()] === 1 && has(first));
  });
}

module.exports = async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Accounts are not set up yet.' });
  }
  try {
    const me = await A.currentUser(req);
    if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see and send messages.' }); }
    const q = new URL(req.url, 'http://x').searchParams;

    if (req.method === 'GET') {
      if (q.get('people')) {
        const people = await supabase('GET', '?disabled=is.false&select=id,name&order=name.asc', null, null, 'app_users');
        return sendJSON(res, 200, { people: people, me: me.id });
      }
      if (q.get('summary')) {
        const rows = await supabase('POST', '', { p_user: me.id }, null, 'rpc/message_summary');
        return sendJSON(res, 200, { summary: rows });
      }
      const ref = String(q.get('ref') || '');
      if (!REF.test(ref)) { return sendJSON(res, 400, { error: 'ref', message: 'Unknown project.' }); }
      const rows = await supabase('GET', '?project_ref=eq.' + encodeURIComponent(ref) +
        '&select=id,user_id,author_name,body,created_at&order=created_at.asc&limit=300', null, null, 'project_messages');
      if (q.get('read') !== '0') { await markRead(me, ref); }
      return sendJSON(res, 200, { messages: rows, me: me.id });
    }

    if (req.method === 'POST') {
      const b = await readBody(req);
      const ref = String(b.ref || '');
      const text = String(b.body || '').trim().slice(0, 4000);
      if (!REF.test(ref)) { return sendJSON(res, 400, { error: 'ref', message: 'Unknown project.' }); }
      if (!text) { return sendJSON(res, 400, { error: 'body', message: 'Write a message first.' }); }
      const title = await projectTitle(ref);
      if (!title) { return sendJSON(res, 404, { error: 'not_found', message: 'That project no longer exists.' }); }
      const rows = await supabase('POST', '', { project_ref: ref, user_id: me.id, author_name: me.name, body: text },
                                  null, 'project_messages');
      await markRead(me, ref);
      /* small team: everyone else with an account hears about it — and
         anyone @tagged gets an alert that says so */
      const people = (await supabase('GET', '?disabled=is.false&select=id,name', null, null, 'app_users'))
        .filter(function (u) { return u.id !== me.id; });
      const tags = tagged(text, people);
      const tagIds = tags.map(function (u) { return u.id; });
      const alert = { from_user_id: me.id, project_ref: ref, body: text.length > 280 ? text.slice(0, 277) + '…' : text,
                      link: 'projects.html#open=' + encodeURIComponent(ref) };
      await A.sendAlerts(tagIds, Object.assign({ kind: 'mention', title: me.name + ' tagged you · ' + title }, alert));
      await A.sendAlerts(people.map(function (u) { return u.id; }).filter(function (id) { return tagIds.indexOf(id) < 0; }),
                         Object.assign({ kind: 'message', title: me.name + ' · ' + title }, alert));
      return sendJSON(res, 201, { message: rows[0], tagged: tags.map(function (u) { return u.name; }) });
    }

    if (req.method === 'DELETE') {
      const id = q.get('id');
      if (!/^[0-9a-f-]{36}$/i.test(id || '')) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
      const own = me.role === 'admin' ? '' : '&user_id=eq.' + me.id;
      const rows = await supabase('DELETE', '?id=eq.' + id + own, null, null, 'project_messages');
      if (!rows.length) { return sendJSON(res, 404, { error: 'not_found', message: 'You can only remove your own messages.' }); }
      return sendJSON(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (/JSON|body too large/.test(e.message)) { return sendJSON(res, 400, { error: 'bad_request', message: 'Could not read the request.' }); }
    return sendJSON(res, 502, { error: 'storage', message: 'Could not reach the messages database. Try again shortly.' });
  }
};
