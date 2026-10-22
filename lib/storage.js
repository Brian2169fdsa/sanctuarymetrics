/* ============================================================================
   Supabase storage helpers for the private image buckets (presentations,
   social). Everything goes through the service-role key, server-side only;
   the browser only ever gets short-lived signed links.
   ========================================================================== */

const SIGN_SECONDS = 60 * 60;

function bad(message) { const e = new Error(message); e.bad = true; return e; }

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
async function sign(bucket, paths) {
  if (!paths.length) { return {}; }
  const rows = await storage('POST', 'object/sign/' + bucket, JSON.stringify({ expiresIn: SIGN_SECONDS, paths: paths }),
                             { 'Content-Type': 'application/json' });
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1';
  const out = {};
  (rows || []).forEach(function (r) { if (r.signedURL && r.path) { out[r.path] = base + r.signedURL; } });
  return out;
}
/* one private object's bytes */
async function download(bucket, path) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(process.env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/object/' + bucket + '/' + path,
                        { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (!r.ok) { const e = new Error('Storage ' + r.status + ' reading ' + path); e.status = r.status; throw e; }
  return Buffer.from(await r.arrayBuffer());
}
function upload(bucket, path, buf, type) {
  return storage('POST', 'object/' + bucket + '/' + path, buf,
                 { 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'max-age=3600' });
}
function remove(bucket, paths) {
  if (!paths.length) { return Promise.resolve(); }
  return storage('DELETE', 'object/' + bucket, JSON.stringify({ prefixes: paths }), { 'Content-Type': 'application/json' });
}

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

module.exports = { storage: storage, sign: sign, download: download, upload: upload, remove: remove,
                   readRaw: readRaw, imageType: imageType, bad: bad };
