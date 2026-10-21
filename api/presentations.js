/* ============================================================================
   /api/presentations — PowerPoint decks for presentations.html.

   A deck is a row in public.presentations plus its slides as images in the
   PRIVATE Supabase storage bucket "presentations" (<id>/s<n>.webp full size,
   <id>/t<n>.webp thumbnail). See supabase/presentations.sql. The images
   never sit anywhere public: every read hands back short-lived signed links,
   and only to someone signed in.

   Routes (signed in; the writes are admin only):
     GET                         every ready deck, with a signed cover thumbnail
                                 (admins also see decks still uploading)
     GET    ?id=…                one deck with signed links for every slide
     POST   {title, description, category, sharepoint_url, slide_count}
                                 start a deck → {id}; it stays "uploading"
     PUT    ?id=…&n=…&kind=s|t   upload one slide image (raw image/webp body)
     PATCH  ?id=… {status:'ready', title, …}   finish or edit a deck
     DELETE ?id=…                remove a deck and its slide images

   The browser shrinks each slide to WebP before sending, so one PUT is a few
   hundred KB at most — well under Vercel's 4.5 MB request limit.
   ========================================================================== */

const { sendJSON, readBody, supabase } = require('../lib/db');
const A = require('../lib/auth');

const BUCKET = 'presentations';
const ID = /^[0-9a-f-]{36}$/i;
const MAX_SLIDES = 200;
const MAX_IMAGE = 3 * 1024 * 1024;
const SIGN_SECONDS = 60 * 60;
const SHAREPOINT = /^https:\/\/[a-z0-9-]+\.sharepoint\.com\/\S+$/i;
const COLS = 'id,title,description,category,sharepoint_url,slide_count,status,created_by_name,created_at,updated_at';

function str(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max); }
function bad(message) { const e = new Error(message); e.bad = true; return e; }

/* ── Supabase storage ─────────────────────────────────────────────────── */
function storage(method, path, body, headers) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(process.env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/' + path, {
    method: method,
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key }, headers || {}),
    body: body
  }).then(function (r) {
    return r.text().then(function (text) {
      if (!r.ok) { const e = new Error('Storage ' + r.status + ': ' + text.slice(0, 300)); e.status = r.status; throw e; }
      return text ? JSON.parse(text) : null;
    });
  });
}
/* signed links for many objects in one call; returns path → absolute URL */
async function sign(paths) {
  if (!paths.length) { return {}; }
  const rows = await storage('POST', 'object/sign/' + BUCKET, JSON.stringify({ expiresIn: SIGN_SECONDS, paths: paths }),
                             { 'Content-Type': 'application/json' });
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1';
  const out = {};
  (rows || []).forEach(function (r) { if (r.signedURL && r.path) { out[r.path] = base + r.signedURL; } });
  return out;
}
function slidePath(id, kind, n) { return id + '/' + kind + n + '.webp'; }

/* raw request body as a Buffer, refusing anything over the limit */
function readRaw(req, limit) {
  if (Buffer.isBuffer(req.body)) {
    return req.body.length > limit ? Promise.reject(bad('That image is too big.')) : Promise.resolve(req.body);
  }
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { req.destroy(); reject(bad('That image is too big.')); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
/* the first bytes say what an image really is, whatever the header claims */
function imageType(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') { return 'image/webp'; }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { return 'image/jpeg'; }
  if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') { return 'image/png'; }
  return null;
}

function cleanFields(b, creating) {
  const out = {};
  if (creating || 'title' in b) {
    out.title = str(b.title, 200);
    if (!out.title) { throw bad('Give the presentation a title.'); }
  }
  if ('description' in b) { out.description = str(b.description, 600) || null; }
  if ('category' in b) { out.category = str(b.category, 60) || null; }
  if ('sharepoint_url' in b) {
    const url = str(b.sharepoint_url, 1000);
    if (url && !SHAREPOINT.test(url)) { throw bad('That doesn\'t look like a SharePoint link.'); }
    out.sharepoint_url = url || null;
  }
  if ('slide_count' in b) {
    const n = Number(b.slide_count);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SLIDES) { throw bad('A presentation needs 1–' + MAX_SLIDES + ' slides.'); }
    out.slide_count = n;
  }
  if ('status' in b) {
    if (['uploading', 'ready'].indexOf(b.status) < 0) { throw bad('Unknown status.'); }
    out.status = b.status;
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Presentations are not set up yet.' });
  }
  try {
    const me = await A.currentUser(req);
    if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to see presentations.' }); }
    const admin = me.role === 'admin';
    const q = new URL(req.url, 'http://x').searchParams;
    const id = q.get('id');
    if (id && !ID.test(id)) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
    const one = async function () {
      const rows = await supabase('GET', '?id=eq.' + id + '&select=' + COLS, null, null, 'presentations');
      return rows[0] || null;
    };

    if (req.method === 'GET') {
      if (id) {
        const deck = await one();
        if (!deck || (deck.status !== 'ready' && !admin)) { return sendJSON(res, 404, { error: 'not_found', message: 'That presentation isn\'t here.' }); }
        const paths = [];
        for (let n = 1; n <= deck.slide_count; n++) { paths.push(slidePath(deck.id, 's', n), slidePath(deck.id, 't', n)); }
        const urls = await sign(paths);
        deck.slides = [];
        for (let n = 1; n <= deck.slide_count; n++) {
          deck.slides.push({ n: n, full: urls[slidePath(deck.id, 's', n)] || null, thumb: urls[slidePath(deck.id, 't', n)] || null });
        }
        return sendJSON(res, 200, { deck: deck, admin: admin });
      }
      const decks = await supabase('GET', '?select=' + COLS + (admin ? '' : '&status=eq.ready') + '&order=created_at.desc',
                                   null, null, 'presentations');
      const covers = await sign(decks.filter(function (d) { return d.slide_count > 0; })
                                     .map(function (d) { return slidePath(d.id, 't', 1); }));
      decks.forEach(function (d) { d.cover = covers[slidePath(d.id, 't', 1)] || null; });
      return sendJSON(res, 200, { decks: decks, admin: admin });
    }

    if (!admin) { return sendJSON(res, 403, { error: 'admin', message: 'Only admins can add or change presentations.' }); }

    if (req.method === 'POST') {
      const fields = cleanFields(await readBody(req), true);
      if (!fields.slide_count) { throw bad('A presentation needs at least one slide.'); }
      const rows = await supabase('POST', '?select=' + COLS, Object.assign(fields, {
        status: 'uploading', created_by: me.id, created_by_name: me.name }), null, 'presentations');
      return sendJSON(res, 201, { deck: rows[0] });
    }

    if (!id) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
    const deck = await one();
    if (!deck) { return sendJSON(res, 404, { error: 'not_found', message: 'That presentation isn\'t here.' }); }

    if (req.method === 'PUT') {
      const n = Number(q.get('n')), kind = q.get('kind');
      if (!Number.isInteger(n) || n < 1 || n > deck.slide_count) { throw bad('That slide number is out of range.'); }
      if (kind !== 's' && kind !== 't') { throw bad('Unknown image kind.'); }
      const buf = await readRaw(req, MAX_IMAGE);
      const type = imageType(buf);
      if (!type) { throw bad('Slides must be WebP, JPEG or PNG images.'); }
      await storage('POST', 'object/' + BUCKET + '/' + slidePath(deck.id, kind, n), buf,
                    { 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'max-age=3600' });
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'PATCH') {
      const fields = cleanFields(await readBody(req), false);
      fields.updated_at = new Date().toISOString();
      const rows = await supabase('PATCH', '?id=eq.' + deck.id + '&select=' + COLS, fields, null, 'presentations');
      return sendJSON(res, 200, { deck: rows[0] });
    }

    if (req.method === 'DELETE') {
      const paths = [];
      for (let n = 1; n <= deck.slide_count; n++) { paths.push(slidePath(deck.id, 's', n), slidePath(deck.id, 't', n)); }
      if (paths.length) {
        await storage('DELETE', 'object/' + BUCKET, JSON.stringify({ prefixes: paths }), { 'Content-Type': 'application/json' });
      }
      await supabase('DELETE', '?id=eq.' + deck.id, null, { Prefer: 'return=minimal' }, 'presentations');
      return sendJSON(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, PATCH, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (e.bad || /JSON|body too large/.test(e.message)) {
      return sendJSON(res, 400, { error: 'bad_request', message: e.bad ? e.message : 'Could not read the request.' });
    }
    const schema = /PGRST20[25]|relation "?public\.presentations|Bucket not found/i.test(e.message);
    return sendJSON(res, 502, {
      error: schema ? 'schema' : 'storage',
      message: schema ? 'Presentations aren\'t set up in Supabase yet — run supabase/presentations.sql (or ALL.sql).'
                      : 'Could not reach the presentations storage. Try again shortly.'
    });
  }
};
