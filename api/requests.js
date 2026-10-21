/* ============================================================================
   /api/requests — self-service requests: business card and flyer orders
   (print.html) and website edit requests (website.html).

   Each request is filed as a new row in the same Supabase table as the
   Projects page (public.projects), so it shows up there as a task with
   status "New". Ticking it done on the Projects page marks it ordered.
   No extra table or SQL is needed.

   Environment variables (Vercel → Settings → Environment Variables):

     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PROJECTS_PASSWORD
                     required — the same three api/projects.js uses.
     PRINT_PASSWORD  optional. A second word that can ONLY submit requests
                     (it can't open the project list). Give it to staff who
                     order cards or ask for edits but shouldn't see the tracker.
                     The team password works here too.
     PRINT_OWNER     optional. Who the task is assigned to on the Projects
                     page. Defaults to "Brian Reinhart".

   Route (signed in, or the X-Projects-Password header). Admins with an
   account get an alert for each new request:
     POST {kind: 'business_cards' | 'flyer' | 'website_edit', …}   file one request
   ========================================================================== */

const { sendJSON, readBody, supabase } = require('../lib/db');
const { authorize, admins, sendAlerts } = require('../lib/auth');

const QUANTITIES = { business_cards: [250, 500, 1000], flyer: [25, 50, 100, 250, 500, 1000] };
const KINDS = { business_cards: 1, flyer: 1, website_edit: 1 };
const EDIT_TYPES = ['Change text', 'Page title / Google description', 'Images or video', 'Add a section',
                    'Remove something', 'Fix a link or button', 'New page', 'Other'];
const SITE_URL = /^https:\/\/www\.sanctuaryrecoverycenters\.com(\/[^\s]*)?$/;
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;

function str(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max); }

function bad(message) { const e = new Error(message); e.bad = true; return e; }

/* validate the request and turn it into a projects row */
function toRow(body) {
  const kind = body.kind;
  if (!KINDS[kind]) { throw bad('Unknown request type.'); }

  const by = str(body.requester_name, 120);
  const byEmail = str(body.requester_email, 200);
  const deliver = str(body.deliver_to, 300);
  const notes = str(body.notes, 2000);
  const needed = str(body.needed_by, 10);
  const qty = Number(body.quantity);
  if (!by) { throw bad('Add your name so we know who asked.'); }
  if (byEmail && !EMAIL.test(byEmail)) { throw bad('Your email doesn\'t look right.'); }
  if (needed && !/^\d{4}-\d{2}-\d{2}$/.test(needed)) { throw bad('Needed-by must be a date.'); }
  if (QUANTITIES[kind] && QUANTITIES[kind].indexOf(qty) < 0) { throw bad('Pick a quantity from the list.'); }

  const lines = [];
  let title;
  if (kind === 'business_cards') {
    const c = body.card || {};
    const card = { name: str(c.name, 80), title: str(c.title, 80), email: str(c.email, 120),
                   phone: str(c.phone, 40), website: str(c.website, 80) };
    if (!card.name) { throw bad('Add the name for the card.'); }
    if (!card.title) { throw bad('Add the job title for the card.'); }
    if (card.email && !EMAIL.test(card.email)) { throw bad('The card email doesn\'t look right.'); }
    title = 'Order business cards: ' + card.name + ' (' + qty + ')';
    lines.push('BUSINESS CARDS — ' + qty,
      'Name: ' + card.name,
      'Title: ' + card.title,
      'Email: ' + (card.email || '—'),
      'Phone: ' + (card.phone || '—'),
      'Website: ' + (card.website || '—'));
  } else if (kind === 'website_edit') {
    const url = str(body.page_url, 300);
    const page = str(body.page_title, 200) || url;
    const type = str(body.edit_type, 60);
    const current = str(body.current_text, 2000);
    const change = str(body.change, 3000);
    if (url && !SITE_URL.test(url)) { throw bad('That isn\'t a sanctuaryrecoverycenters.com page.'); }
    if (EDIT_TYPES.indexOf(type) < 0) { throw bad('Pick what kind of change it is.'); }
    if (!change) { throw bad('Describe the change you want.'); }
    title = 'Website edit: ' + (type === 'New page' && !url ? 'new page' : page) + ' — ' + type;
    lines.push('WEBSITE EDIT — ' + type, 'Page: ' + (url || 'new page'));
    if (current) { lines.push('', 'Currently says:', current); }
    lines.push('', 'Change to / request:', change);
  } else {
    const flyer = str(body.flyer, 120);
    const edits = str(body.edits, 3000);
    if (!flyer) { throw bad('Pick a flyer.'); }
    title = (edits ? 'Edit + order flyer: ' : 'Order flyer: ') + flyer + ' (' + qty + ')';
    lines.push('FLYER — ' + flyer + ' — ' + qty);
    if (edits) { lines.push('', 'Requested edits:', edits); }
  }
  lines.push('', 'Requested by: ' + by + (byEmail ? ' <' + byEmail + '>' : ''));
  if (deliver) { lines.push('Deliver to: ' + deliver); }
  if (notes) { lines.push('', 'Notes: ' + notes); }

  return {
    title: title.slice(0, 300),
    owner: str(process.env.PRINT_OWNER, 120) || 'Brian Reinhart',
    status: 'New',
    importance: str(body.priority, 10) === 'Hot' ? 'Hot' : 'Med',
    due: needed || null,
    notes: lines.join('\n').slice(0, 4000),
    source: (kind === 'website_edit' ? 'Website edit request · ' : 'Print request · ') + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' }),
    seed_key: null
  };
}

module.exports = async function handler(req, res) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
    .filter(function (k) { return !process.env[k]; });
  if (missing.length) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Print requests are not set up yet: missing ' + missing.join(', ') + '.' });
  }
  const who = await authorize(req, { printPassword: true });
  if (!who) {
    return sendJSON(res, 401, { error: 'password', message: 'Sign in, or enter the team password.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  }

  try {
    const row = toRow(await readBody(req));
    const rows = await supabase('POST', '', row);
    /* let the admins know on the bell */
    try {
      const ref = 'row:' + rows[0].id;
      await sendAlerts((await admins()).map(function (u) { return u.id; }), {
        from_user_id: who.user ? who.user.id : null, kind: 'request', project_ref: ref,
        title: 'New request: ' + rows[0].title, body: rows[0].notes, link: 'projects.html#open=' + encodeURIComponent(ref) });
    } catch (e) { /* accounts not set up yet — the task is saved either way */ }
    return sendJSON(res, 201, { ok: true, title: rows[0] && rows[0].title });
  } catch (e) {
    if (e.bad || /JSON|body too large/.test(e.message)) {
      return sendJSON(res, 400, { error: 'bad_request', message: e.bad ? e.message : 'Could not read the request.' });
    }
    return sendJSON(res, 502, { error: 'storage', message: 'Could not save the request. Try again shortly.' });
  }
};
