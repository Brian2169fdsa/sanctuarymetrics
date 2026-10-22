/* ============================================================================
   Optional Microsoft Graph mail for the CP-AO portal, as the site admin's
   mailbox (constants.site_admin_email). Off unless turned on:

     CPAO_SEND_EMAIL=true            invites and "please fix" notes are emailed
     CPAO_CREATE_OUTLOOK_DRAFT=true  the weekly batch leaves a DRAFT to CPAO in
                                     the site admin's Drafts. Never sent by us.

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
  const r = await fetch('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(C.site_admin_email) + path, {
    method: method,
    headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { throw new Error('Graph ' + r.status + ' on ' + path); }
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

/* a draft in the site admin's mailbox to CPAO with the files attached */
async function draftToCpao(subject, text, files) {
  if (!on('CPAO_CREATE_OUTLOOK_DRAFT') || !ready()) { return false; }
  await graph('POST', '/messages', {
    subject: subject, body: { contentType: 'Text', content: text },
    toRecipients: [{ emailAddress: { address: C.cpao_ops_email } }],
    attachments: files.map(function (f) {
      return { '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: 'application/pdf',
               contentBytes: Buffer.from(f.bytes).toString('base64') };
    })
  });
  return true;
}

/* the site admin pressed "Send to CPAO": the Add/Remove form and CP-101s
   go to CP-AO Operations from his mailbox. Graph takes about 3 MB of
   attachments in one message; a bigger batch is sent by hand. */
async function sendToCpao(subject, text, files) {
  const fail = function (code, msg) { const e = new Error(msg); e.code = code; return e; };
  if (!ready()) { throw fail('not_ready', 'Microsoft sign-in isn\'t set up for the site, so it can\'t send from your mailbox. Download the files and send them yourself.'); }
  const size = files.reduce(function (n, f) { return n + f.bytes.length; }, 0);
  if (size > 3000000) { throw fail('too_big', 'These files are too big to send through the site (' + Math.round(size / 100000) / 10 + ' MB). Download the bundle and send it from Outlook, then press Mark as Sent.'); }
  try {
    await graph('POST', '/sendMail', { saveToSentItems: true, message: {
      subject: subject, body: { contentType: 'Text', content: text },
      toRecipients: [{ emailAddress: { address: C.cpao_ops_email } }],
      attachments: files.map(function (f) {
        return { '@odata.type': '#microsoft.graph.fileAttachment', name: f.name, contentType: 'application/pdf',
                 contentBytes: Buffer.from(f.bytes).toString('base64') };
      }) } });
  } catch (e) {
    if (/Graph 40[13]/.test(e.message)) {
      throw fail('no_permission', 'Microsoft didn\'t let the site send from ' + C.site_admin_email + ' — the sign-in app needs the Mail.Send permission (see CPAO.md). Download the files and send them yourself for now.');
    }
    throw fail('graph', 'Outlook didn\'t take the email (' + e.message.replace(/ on .*/, '') + '). Nothing was sent — try again, or send it yourself.');
  }
  return true;
}

module.exports = { sendMail: sendMail, draftToCpao: draftToCpao, sendToCpao: sendToCpao, directory: directory, emailOn: function () { return on('CPAO_SEND_EMAIL') && ready(); },
                   draftOn: function () { return on('CPAO_CREATE_OUTLOOK_DRAFT') && ready(); } };
