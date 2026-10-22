/* ============================================================================
   Field-level encryption for CP-101 PII (date of birth, SSN, home address).

   AES-256-GCM with a 32-byte key from CPAO_PII_KEY (base64 or hex). Each
   value is stored as  v1:<key id>:<base64 iv|tag|ciphertext>  where the key
   id is the first 8 hex characters of the key's SHA-256, so a value always
   says which key sealed it.

   Rotating the key: put the new key in CPAO_PII_KEY and the old one in
   CPAO_PII_KEY_OLD, redeploy, press "Re-encrypt with the new key" on the
   admin page (or POST /api/cpao?action=rotate), then remove
   CPAO_PII_KEY_OLD. See CPAO.md.
   ========================================================================== */

const crypto = require('crypto');

function parseKey(raw) {
  if (!raw) { return null; }
  const s = String(raw).trim();
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) { throw new Error('CPAO_PII_KEY must be 32 bytes (base64 or 64 hex characters).'); }
  return { key: buf, id: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8) };
}
function keys() {
  const current = parseKey(process.env.CPAO_PII_KEY);
  if (!current) { const e = new Error('The PII key isn\'t set: add CPAO_PII_KEY in Vercel.'); e.code = 'no_key'; throw e; }
  const old = parseKey(process.env.CPAO_PII_KEY_OLD);
  return { current: current, all: old ? [current, old] : [current] };
}
function configured() { try { keys(); return true; } catch (e) { return false; } }

/* object → sealed string */
function seal(obj) {
  const k = keys().current;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k.key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1:' + k.id + ':' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
/* sealed string → object (throws if tampered with or the key is gone) */
function open(sealed) {
  if (!sealed) { return {}; }
  const m = /^v1:([0-9a-f]{8}):(.+)$/.exec(sealed);
  if (!m) { throw new Error('Unrecognised ciphertext.'); }
  const k = keys().all.filter(function (x) { return x.id === m[1]; })[0];
  if (!k) { const e = new Error('This record was sealed with a key that is no longer configured.'); e.code = 'old_key'; throw e; }
  const buf = Buffer.from(m[2], 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k.key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
/* was this sealed with an older key? */
function stale(sealed) {
  const m = /^v1:([0-9a-f]{8}):/.exec(sealed || '');
  return !!m && m[1] !== keys().current.id;
}

/* random URL-safe token, and the hash we store instead of it */
function token() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

module.exports = { seal: seal, open: open, stale: stale, configured: configured, token: token, hashToken: hashToken };
