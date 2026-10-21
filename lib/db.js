/* ============================================================================
   Shared server helpers: JSON responses, request bodies, password compare,
   and calls to Supabase's REST API with the service-role key.
   (lib/ is not under api/, so Vercel doesn't turn it into an endpoint.)
   ========================================================================== */

const crypto = require('crypto');

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

/* one call to Supabase's REST API (PostgREST); table defaults to projects */
async function supabase(method, query, body, extraHeaders, table) {
  const url = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/' + (table || 'projects') + (query || '');
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


module.exports = { sendJSON: sendJSON, readBody: readBody, passwordOk: passwordOk, supabase: supabase };
