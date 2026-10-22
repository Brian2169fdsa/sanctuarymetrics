/* ============================================================================
   Optional Microsoft Graph mail for the CP-AO portal, as the site admin's
   mailbox (constants.site_admin_email). Off unless turned on:

     CPAO_SEND_EMAIL=true            invites and "please fix" notes are emailed
     CPAO_CREATE_OUTLOOK_DRAFT=true  the weekly batch leaves a DRAFT to CPAO in
                                     the site admin's Drafts. Never sent by us.

   Both use the Microsoft sign-in app (MS_CLIENT_ID / MS_CLIENT_SECRET) and need
   the application permissions Mail.Send (email) and Mail.ReadWrite (draft),
   admin-consented in Entra ID. Without them the portal still works: the admin
   page shows the invite link to copy, and the batch is downloaded by hand.

   Never put PII in these emails: names and links only.
   ========================================================================== */

const { msTenant } = require('./auth');
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

module.exports = { sendMail: sendMail, draftToCpao: draftToCpao, emailOn: function () { return on('CPAO_SEND_EMAIL') && ready(); },
                   draftOn: function () { return on('CPAO_CREATE_OUTLOOK_DRAFT') && ready(); } };
