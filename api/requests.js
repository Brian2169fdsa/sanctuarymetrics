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
     POST {kind: 'business_cards' | 'flyer' | 'new_flyer' | 'website_edit' | 'presentation_edit', …}   file one request

   A flyer request (flyer.html) can carry edits area by area — area_edits:
   [{area, now, change}] — plus general edits, and a quantity of 0 when it's
   edits only, no prints yet. A new_flyer request asks marketing for a design
   that doesn't exist yet. A presentation_edit (presentations.html) names a
   deck by deck_id and carries slide_edits: [{slide, change}]; the deck's
   title and SharePoint link are looked up here, not taken from the page.
   Signed-in requests are filed under the account's own name and email.

   Order tracking (supabase/print-orders.sql) — the "Order status" list at
   the bottom of print.html:
     GET                                  orders + recent handouts
     POST {kind: 'handout', …}            log where materials were handed out
     POST {kind: 'order', …}              admin: add an order by hand
     PATCH ?order=<id> {status, …}        admin: move an order along
     DELETE ?handout=<id>                 the person who logged it, or an admin
   A request above that asks for prints also adds a "Requested" order.

   ?pal=… is the PAL Forward email tracker (pal-email.html) — see lib/pal.js.
   ========================================================================== */

const { sendJSON, readBody, supabase, projectWrite, addedBy } = require('../lib/db');
const { authorize, admins, sendAlerts, access } = require('../lib/auth');

const QUANTITIES = { business_cards: [250, 500, 1000], flyer: [0, 25, 50, 100, 250, 500, 1000],
                     new_flyer: [0, 25, 50, 100, 250, 500, 1000] };
const KINDS = { business_cards: 1, flyer: 1, new_flyer: 1, website_edit: 1, presentation_edit: 1 };
const MAX_AREA_EDITS = 30;
const EDIT_TYPES = ['Change text', 'Page title / Google description', 'Images or video', 'Add a section',
                    'Remove something', 'Fix a link or button', 'New page', 'Other'];
const SITE_URL = /^https:\/\/www\.sanctuaryrecoverycenters\.com(\/[^\s]*)?$/;
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;

function str(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max); }

function bad(message) { const e = new Error(message); e.bad = true; return e; }

/* validate the request and turn it into a projects row */
function toRow(body, user, deck) {
  const kind = body.kind;
  if (!KINDS[kind]) { throw bad('Unknown request type.'); }

  /* a signed-in request is always filed as that person */
  const by = user ? str(user.name, 120) : str(body.requester_name, 120);
  const byEmail = user ? str(user.email, 200) : str(body.requester_email, 200);
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
  } else if (kind === 'presentation_edit') {
    if (!deck) { throw bad('That presentation isn\'t here any more.'); }
    const edits = str(body.edits, 3000);
    const slideEdits = (Array.isArray(body.slide_edits) ? body.slide_edits : []).slice(0, MAX_AREA_EDITS).map(function (e) {
      return { slide: Number(e && e.slide), change: str(e && e.change, 1500) };
    }).filter(function (e) { return Number.isInteger(e.slide) && e.slide >= 1 && e.slide <= deck.slide_count && e.change; });
    if (!slideEdits.length && !edits) { throw bad('Write a change for at least one slide first.'); }
    title = 'Presentation edits: ' + deck.title + (slideEdits.length ? ' (' + slideEdits.length + ' slide' + (slideEdits.length === 1 ? '' : 's') + ')' : '');
    lines.push('PRESENTATION EDITS — ' + deck.title);
    if (deck.sharepoint_url) { lines.push('PowerPoint: ' + deck.sharepoint_url); }
    lines.push('On the site: presentations.html#deck=' + deck.id);
    slideEdits.forEach(function (e) { lines.push('', 'Slide ' + e.slide + ': ' + e.change); });
    if (edits) { lines.push('', slideEdits.length ? 'Also:' : 'Requested edits:', edits); }
  } else if (kind === 'new_flyer') {
    const topic = str(body.topic, 160);
    const audience = str(body.audience, 200);
    const message = str(body.message, 2000);
    const details = str(body.details, 3000);
    if (!topic) { throw bad('Say what the flyer is for.'); }
    if (!message) { throw bad('Say what the flyer should say or do.'); }
    title = 'New flyer: ' + topic + (qty ? ' (' + qty + ')' : '');
    lines.push('NEW FLYER — ' + topic, 'For: ' + (audience || '—'), 'Prints: ' + (qty ? qty : 'design only for now'),
      '', 'What it should say / do:', message);
    if (details) { lines.push('', 'Must include / photos / ideas:', details); }
  } else {
    const flyer = str(body.flyer, 120);
    const edits = str(body.edits, 3000);
    if (!flyer) { throw bad('Pick a flyer.'); }
    const areaEdits = (Array.isArray(body.area_edits) ? body.area_edits : []).slice(0, MAX_AREA_EDITS).map(function (a) {
      return { area: str(a && a.area, 80), now: str(a && a.now, 600), change: str(a && a.change, 1500) };
    }).filter(function (a) { return a.area && a.change; });
    const anyEdits = !!(edits || areaEdits.length);
    if (!qty && !anyEdits) { throw bad('Ask for at least one change, or pick how many to print.'); }
    title = (anyEdits ? (qty ? 'Edit + order flyer: ' : 'Edit flyer: ') : 'Order flyer: ') + flyer + (qty ? ' (' + qty + ')' : '');
    lines.push('FLYER — ' + flyer + ' — ' + (qty ? qty + ' prints' : 'edits only, no prints yet'));
    areaEdits.forEach(function (a, i) {
      lines.push('', (i + 1) + '. ' + a.area + (a.now ? ' — now: "' + a.now.slice(0, 200) + (a.now.length > 200 ? '…' : '') + '"' : ''),
        '   Change to: ' + a.change);
    });
    if (edits) { lines.push('', areaEdits.length ? 'Also:' : 'Requested edits:', edits); }
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
    source: (kind === 'website_edit' ? 'Website edit request · ' : kind === 'new_flyer' ? 'New flyer request · '
      : kind === 'presentation_edit' ? 'Presentation edit request · ' : 'Print request · ') + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' }),
    seed_key: null
  };
}

/* ── order tracking ─────────────────────────────────────────────────────── */
const ORDER_STATUS = ['requested', 'ordered', 'shipped', 'delivered', 'handed_out', 'cancelled'];
const ORDER_KINDS = ['flyer', 'business_cards', 'presentation', 'other'];
const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NO_TABLES = /(PGRST205|42P01)[\s\S]*print_(orders|handouts)/;

function canManage(who) { return !!who && (who.user ? access(who.user).admin : !!who.legacy && !who.printOnly); }
function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }); }
function day(v, label) {
  const d = str(v, 10);
  if (d && !DAY.test(d)) { throw bad(label + ' must be a date.'); }
  return d || null;
}
function count(v, label, min) {
  if (v === '' || v === null || v === undefined) { return null; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > 100000) { throw bad(label + ' must be a whole number.'); }
  return n;
}
/* the order fields an admin can set (only the ones present in the body) */
function orderFields(body, isNew) {
  const f = {};
  if (isNew || 'item' in body) {
    f.item = str(body.item, 200);
    if (!f.item) { throw bad('Say what was ordered.'); }
  }
  if (isNew || 'kind' in body) {
    f.kind = ORDER_KINDS.indexOf(body.kind) >= 0 ? body.kind : 'other';
  }
  if (isNew || 'status' in body) {
    f.status = isNew && !body.status ? 'ordered' : body.status;
    if (ORDER_STATUS.indexOf(f.status) < 0) { throw bad('Unknown order status.'); }
  }
  if ('quantity' in body) { f.quantity = count(body.quantity, 'Quantity', 0); }
  if ('expected_on' in body) { f.expected_on = day(body.expected_on, 'Expected'); }
  if ('delivered_on' in body) { f.delivered_on = day(body.delivered_on, 'Delivered'); }
  ['vendor', 'stored_at', 'item_ref'].forEach(function (k) { if (k in body) { f[k] = str(body[k], 200) || null; } });
  if ('notes' in body) { f.notes = str(body.notes, 2000) || null; }
  if (f.status === 'delivered' && !('delivered_on' in body)) { f.delivered_on = today(); }
  return f;
}

async function listOrders(who) {
  const orders = await supabase('GET', '?select=*&order=created_at.desc&limit=300', null, null, 'print_orders');
  const handouts = await supabase('GET', '?select=*&order=handed_out_on.desc,created_at.desc&limit=500', null, null, 'print_handouts');
  return { orders: orders, handouts: handouts, admin: canManage(who), me: who.user ? who.user.id : null };
}

async function logHandout(body, who) {
  const by = who.user ? str(who.user.name, 120) : str(body.requester_name, 120);
  if (!by) { throw bad('Add your name so we know who handed them out.'); }
  const qty = count(body.quantity, 'How many', 1);
  if (!qty) { throw bad('Say how many you handed out.'); }
  const location = str(body.location, 300);
  if (!location) { throw bad('Say where you handed them out.'); }
  let item = str(body.item, 200), orderId = null;
  if (body.order_id) {
    if (!UUID.test(String(body.order_id))) { throw bad('Which order?'); }
    const o = (await supabase('GET', '?id=eq.' + body.order_id + '&select=id,item', null, null, 'print_orders'))[0];
    if (!o) { throw bad('That order isn\'t here any more.'); }
    orderId = o.id; item = o.item;
  }
  if (!item) { throw bad('Pick what you handed out.'); }
  const when = day(body.handed_out_on, 'The date') || today();
  if (when > today()) { throw bad('The date can\'t be in the future.'); }
  const rows = await supabase('POST', '', {
    order_id: orderId, item: item, quantity: qty, handed_out_on: when, location: location,
    audience: str(body.audience, 200) || null, notes: str(body.notes, 1000) || null,
    created_by: who.user ? who.user.id : null, created_by_name: by }, null, 'print_handouts');
  return rows[0];
}

/* a print request that asks for prints starts an order in "Requested" */
async function orderFromRequest(body, project, who) {
  const qty = Number(body.quantity);
  if (!qty || ['business_cards', 'flyer', 'new_flyer'].indexOf(body.kind) < 0) { return; }
  const item = body.kind === 'business_cards' ? 'Business cards — ' + str(body.card && body.card.name, 80)
    : body.kind === 'new_flyer' ? 'New flyer — ' + str(body.topic, 160) : str(body.flyer, 160);
  try {
    await supabase('POST', '', {
      item: item.slice(0, 200), kind: body.kind === 'business_cards' ? 'business_cards' : 'flyer',
      item_ref: body.kind === 'flyer' ? str(body.version, 80) || null : null,
      quantity: qty, status: 'requested', expected_on: day(body.needed_by, 'Needed-by'),
      project_id: project.id, requested_by_name: who.user ? who.user.name : str(body.requester_name, 120) || null
    }, { Prefer: 'return=minimal' }, 'print_orders');
  } catch (e) { /* tracking tables not created yet — the request is saved either way */ }
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
  if (['GET', 'POST', 'PATCH', 'DELETE'].indexOf(req.method) < 0) {
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  }
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  if (q.pal) { return require('../lib/pal')(req, res, who, String(q.pal)); }

  try {
    /* ── order tracking ── */
    if (req.method === 'GET') { return sendJSON(res, 200, await listOrders(who)); }
    if (req.method === 'PATCH') {
      if (!canManage(who)) { return sendJSON(res, 403, { error: 'forbidden', message: 'Only an admin can update orders.' }); }
      if (!UUID.test(String(q.order || ''))) { throw bad('Which order?'); }
      const f = Object.assign(orderFields(await readBody(req), false),
        { updated_at: new Date().toISOString(), updated_by_name: who.user ? who.user.name : 'Team password' });
      const rows = await supabase('PATCH', '?id=eq.' + q.order, f, null, 'print_orders');
      if (!rows.length) { throw bad('That order isn\'t here any more.'); }
      return sendJSON(res, 200, { ok: true, order: rows[0] });
    }
    if (req.method === 'DELETE') {
      if (!UUID.test(String(q.handout || ''))) { throw bad('Which hand-out?'); }
      const h = (await supabase('GET', '?id=eq.' + q.handout + '&select=id,created_by', null, null, 'print_handouts'))[0];
      if (!h) { return sendJSON(res, 200, { ok: true }); }
      if (!canManage(who) && !(who.user && h.created_by === who.user.id)) {
        return sendJSON(res, 403, { error: 'forbidden', message: 'Only the person who logged it, or an admin, can remove it.' });
      }
      await supabase('DELETE', '?id=eq.' + h.id, null, { Prefer: 'return=minimal' }, 'print_handouts');
      return sendJSON(res, 200, { ok: true });
    }
    const body = await readBody(req);
    if (body.kind === 'handout') { return sendJSON(res, 201, { ok: true, handout: await logHandout(body, who) }); }
    if (body.kind === 'order') {
      if (!canManage(who)) { return sendJSON(res, 403, { error: 'forbidden', message: 'Only an admin can add orders.' }); }
      const f = Object.assign(orderFields(body.order || {}, true),
        { requested_by_name: who.user ? who.user.name : null, updated_by_name: who.user ? who.user.name : null });
      return sendJSON(res, 201, { ok: true, order: (await supabase('POST', '', f, null, 'print_orders'))[0] });
    }

    /* ── a new request ── */
    let deck = null;
    if (body.kind === 'presentation_edit') {
      if (!/^[0-9a-f-]{36}$/i.test(String(body.deck_id || ''))) { throw bad('Which presentation?'); }
      deck = (await supabase('GET', '?id=eq.' + body.deck_id + '&select=id,title,sharepoint_url,slide_count', null, null, 'presentations'))[0] || null;
    }
    const row = toRow(body, who.user || null, deck);
    const rows = await projectWrite('POST', '', Object.assign(row, addedBy(who.user)));
    await orderFromRequest(body, rows[0], who);
    /* let the admins know on the bell */
    try {
      const ref = 'row:' + rows[0].id;
      await sendAlerts((await admins()).map(function (u) { return u.id; }), {
        from_user_id: who.user ? who.user.id : null, kind: 'request', project_ref: ref,
        title: 'New request: ' + rows[0].title, body: rows[0].notes, link: 'projects.html#open=' + encodeURIComponent(ref) });
    } catch (e) { /* accounts not set up yet — the task is saved either way */ }
    return sendJSON(res, 201, { ok: true, title: rows[0] && rows[0].title });
  } catch (e) {
    if (NO_TABLES.test(e.message)) {
      return sendJSON(res, 503, { error: 'not_set_up', message: 'Order tracking isn\'t set up in Supabase yet — run supabase/print-orders.sql (or ALL.sql).' });
    }
    if (e.bad || /JSON|body too large/.test(e.message)) {
      return sendJSON(res, 400, { error: 'bad_request', message: e.bad ? e.message : 'Could not read the request.' });
    }
    return sendJSON(res, 502, { error: 'storage', message: 'Could not save the request. Try again shortly.' });
  }
};
