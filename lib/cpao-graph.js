/* ============================================================================
   Optional Microsoft Graph mail for the CP-AO portal, as the site admin's
   mailbox (constants.site_admin_email). Off unless turned on:

     CPAO_SEND_EMAIL=true            invites and "please fix" notes are emailed
   On unless turned off (=false), once the sign-in app is set up:
     CPAO_CREATE_OUTLOOK_DRAFT       building an Add/Remove form leaves a DRAFT
                                     to CPAO in the site admin's Drafts, with
                                     the form and every CP-101 attached. Never
                                     sent by us. Needs Mail.ReadWrite.
     CPAO_CHECK_EMAIL                the daily job reads the site admin's mail
                                     for new emails from CPAO (CPAO_MAIL_DOMAINS,
                                     default azahcccs.gov). Needs Mail.ReadWrite
                                     (or Mail.Read).

   "Send to CPAO" (sendToCpao) is different: it only ever runs when the site
   admin presses that button on a batch, and sends from his own mailbox
   (saved in his Sent Items). It needs Mail.Send but no flag.

   Both use the Microsoft sign-in app (MS_CLIENT_ID / MS_CLIENT_SECRET) and need
   the application permissions Mail.Send (email) and Mail.ReadWrite (draft),
   admin-consented in Entra ID. Without them the portal still works: the admin
   page shows the invite link to copy, and the batch is downloaded by hand.

   Never put PII in these emails: names and links only.

   The invite form's staff picker reads the Microsoft 365 directory with the
   same app: application permission User.Read.All (read-only), admin-consented.
   ========================================================================== */

const { msTenant, msDomains } = require('./auth');
const { C } = require('./cpao');

function on(flag) { return String(process.env[flag] || '').toLowerCase() === 'true'; }
function notOff(flag) { return String(process.env[flag] || '').toLowerCase() !== 'false'; }
function ready() { return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET); }

async function token() {
  const r = await fetch('https://login.microsoftonline.com/' + msTenant() + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET,
                                scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' })
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok || !j.access_token) { throw new Error('Graph sign-in failed (' + r.status + ')'); }
  return j.access_token;
}
async function graph(method, path, body) {
  const r = await fetch(/^https:/.test(path) ? path : 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(C.site_admin_email) + path, {
    method: method,
    headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  /* the path can hold a message id — keep it out of the error */
  if (!r.ok) { throw new Error('Graph ' + r.status + ' on ' + path.replace(/^https:\/\/[^?]*/, '').replace(/\/messages\/[^/?]+/, '/messages/…').split('?')[0]); }
  return r.status === 202 || r.status === 204 ? null : r.json();
}

/* ── the staff directory (invite picker) ─────────────────────────────────
   Enabled accounts on the Sanctuary domains that look like people (a first
   and last name). Cached for 10 minutes per warm function. */
let dirCache = null;
async function directory() {
  if (!ready()) { const e = new Error('Microsoft sign-in isn\'t set up (MS_CLIENT_ID / MS_CLIENT_SECRET).'); e.code = 'no_app'; throw e; }
  if (dirCache && Date.now() - dirCache.at < 10 * 60 * 1000) { return dirCache.users; }
  const t = await token();
  const domains = msDomains();
  let url = 'https://graph.microsoft.com/v1.0/users?$count=true&$top=999&$filter=accountEnabled eq true' +
    '&$select=givenName,surname,displayName,mail,userPrincipalName,jobTitle,department,employeeHireDate,officeLocation,streetAddress,city,state,postalCode,businessPhones,mobilePhone';
  const users = [];
  while (url) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t, ConsistencyLevel: 'eventual' } });
    if (r.status === 401 || r.status === 403) {
      const e = new Error('The Microsoft app needs the User.Read.All application permission (admin consent) to list staff.'); e.code = 'no_permission'; throw e;
    }
    if (!r.ok) { throw new Error('Graph ' + r.status + ' listing users'); }
    const j = await r.json();
    (j.value || []).forEach(function (u) {
      const email = String(u.mail || u.userPrincipalName || '').toLowerCase();
      if (!u.givenName || !u.surname || domains.indexOf(email.split('@')[1]) < 0) { return; }
      users.push({
        first_name: u.givenName.trim(), last_name: u.surname.trim(), name: (u.displayName || '').trim(), email: email,
        title: (u.jobTitle || '').trim(), department: (u.department || '').trim(),
        hire_date: u.employeeHireDate ? String(u.employeeHireDate).slice(0, 10) : '',
        work_address: [u.streetAddress, u.city, [u.state, u.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        office: (u.officeLocation || '').trim(),
        phone: (u.businessPhones && u.businessPhones[0]) || ''
      });
    });
    url = j['@odata.nextLink'] || null;
  }
  users.sort(function (a, b) { return (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name); });
  dirCache = { at: Date.now(), users: users };
  return users;
}

/* returns true when sent, false when email is off; throws on a Graph error */
async function sendMail(to, subject, text) {
  if (!on('CPAO_SEND_EMAIL') || !ready()) { return false; }
  await graph('POST', '/sendMail', { saveToSentItems: true, message: {
    subject: subject, body: { contentType: 'Text', content: text }, toRecipients: [{ emailAddress: { address: to } }] } });
  return true;
}

/* ── drafts to CPAO ───────────────────────────────────────────────────────
   The draft is made first, then each PDF is attached on its own: small ones
   in one call, big ones (over ~3 MB) through an upload session, so there's
   no overall size limit. Returns {id, web_link}. */
const SMALL = 3000000, CHUNK = 320 * 1024 * 10;   /* upload chunks: multiples of 320 KiB */
async function attach(id, f) {
  const bytes = Buffer.from(f.bytes);
  if (bytes.length <= SMALL) {
    return graph('POST', '/messages/' + encodeURIComponent(id) + '/attachments', { '@odata.type': '#microsoft.graph.fileAttachment',
      name: f.name, contentType: 'application/pdf', contentBytes: bytes.toString('base64') });
  }
  const sess = await graph('POST', '/messages/' + encodeURIComponent(id) + '/attachments/createUploadSession',
    { AttachmentItem: { attachmentType: 'file', name: f.name, size: bytes.length, contentType: 'application/pdf' } });
  for (let at = 0; at < bytes.length; at += CHUNK) {
    const part = bytes.subarray(at, Math.min(at + CHUNK, bytes.length));
    /* the upload URL carries its own auth: no bearer token */
    const r = await fetch(sess.uploadUrl, { method: 'PUT', body: part, headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(part.length),
      'Content-Range': 'bytes ' + at + '-' + (at + part.length - 1) + '/' + bytes.length } });
    if (!r.ok) { throw new Error('Graph ' + r.status + ' on attachment upload'); }
  }
  return null;
}
async function createDraft(subject, text, files) {
  const m = await graph('POST', '/messages', { subject: subject, body: { contentType: 'Text', content: text },
    toRecipients: [{ emailAddress: { address: C.cpao_ops_email } }] });
  try { for (const f of files) { await attach(m.id, f); } }
  catch (e) { try { await graph('DELETE', '/messages/' + encodeURIComponent(m.id)); } catch (x) { /* leave it */ } throw e; }
  return { id: m.id, web_link: m.webLink || null };
}
function failure(e, what) {
  const fail = function (code, msg) { const x = new Error(msg); x.code = code; return x; };
  if (/Graph 40[13]/.test(e.message)) {
    return fail('no_permission', 'Microsoft didn\'t let the site ' + what + ' in ' + C.site_admin_email + '\'s mailbox — the sign-in app needs the ' +
      (what === 'send email' ? 'Mail.Send and Mail.ReadWrite permissions' : 'Mail.ReadWrite permission') + ' (see CPAO.md).');
  }
  return fail('graph', 'Outlook didn\'t take it (' + e.message.replace(/ on .*/, '') + ').');
}

/* the Add/Remove form was built: a DRAFT to CPAO with everything attached.
   false when drafts are off; throws (with a plain message) on a Graph error */
async function draftToCpao(subject, text, files, force) {
  if (!(force ? ready() : draftOn())) { return false; }
  try { return await createDraft(subject, text, files); } catch (e) { throw failure(e, 'make a draft'); }
}
/* only ever deletes a message that is still a draft: one Brian already sent
   (or deleted) is left alone */
async function deleteDraft(id) {
  if (!id || !ready()) { return; }
  try {
    const m = await graph('GET', '/messages/' + encodeURIComponent(id) + '?$select=isDraft');
    if (m && m.isDraft === true) { await graph('DELETE', '/messages/' + encodeURIComponent(id)); }
  } catch (e) { /* gone already */ }
}

/* the site admin pressed "Send to CPAO": the Add/Remove form and CP-101s
   go to CP-AO Operations from his mailbox (saved in Sent Items). Built as a
   draft first so big batches attach fine, then sent. */
async function sendToCpao(subject, text, files) {
  if (!ready()) { const e = new Error('Microsoft sign-in isn\'t set up for the site, so it can\'t send from your mailbox. Download the files and send them yourself.'); e.code = 'not_ready'; throw e; }
  let d;
  try { d = await createDraft(subject, text, files); } catch (e) { throw failure(e, 'send email'); }
  try { await graph('POST', '/messages/' + encodeURIComponent(d.id) + '/send'); }
  catch (e) { await deleteDraft(d.id); const x = failure(e, 'send email'); x.message += ' Nothing was sent — try again, or send it yourself.'; throw x; }
  return true;
}

/* ── emails from CPAO in the site admin's mailbox ──────────────────────────
   Every folder (rules may file them away); only senders on the CPAO domains.
   Returns [{id, subject, from, received_at, web_link, preview}] — preview is
   for matching names only and is never stored. */
function cpaoDomains() {
  return String(process.env.CPAO_MAIL_DOMAINS || 'azahcccs.gov').toLowerCase().split(/[\s,;]+/).filter(Boolean);
}
async function cpaoMail(sinceIso) {
  const domains = cpaoDomains();
  let url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(C.site_admin_email) + '/messages' +
    '?$filter=' + encodeURIComponent('receivedDateTime ge ' + sinceIso) + '&$orderby=receivedDateTime%20desc&$top=100' +
    '&$select=id,internetMessageId,subject,from,receivedDateTime,webLink,bodyPreview,hasAttachments';
  const out = [];
  for (let pages = 0; url && pages < 20; pages++) {
    let j;
    try { j = await graph('GET', url); } catch (e) { throw failure(e, 'read email'); }
    (j.value || []).forEach(function (m) {
      const from = String((m.from && m.from.emailAddress && m.from.emailAddress.address) || '').toLowerCase();
      const dom = from.split('@')[1] || '';
      if (!domains.some(function (d) { return dom === d || dom.endsWith('.' + d); })) { return; }
      out.push({ id: m.id, key: String(m.internetMessageId || m.id).slice(0, 400), subject: String(m.subject || '(no subject)').slice(0, 300), from: from, received_at: m.receivedDateTime,
                 web_link: m.webLink || null, preview: String(m.bodyPreview || ''), attachments: !!m.hasAttachments });
    });
    url = j['@odata.nextLink'] || null;
  }
  return out;
}
function draftOn() { return notOff('CPAO_CREATE_OUTLOOK_DRAFT') && ready(); }
function mailCheckOn() { return notOff('CPAO_CHECK_EMAIL') && ready(); }

module.exports = { sendMail: sendMail, draftToCpao: draftToCpao, deleteDraft: deleteDraft, sendToCpao: sendToCpao, directory: directory,
                   cpaoMail: cpaoMail, cpaoDomains: cpaoDomains,
                   emailOn: function () { return on('CPAO_SEND_EMAIL') && ready(); }, draftOn: draftOn, mailCheckOn: mailCheckOn };
