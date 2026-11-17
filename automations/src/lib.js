// shared helpers, pasted at the top of Code nodes that need them
const CFG = $('Config').first().json;
function phxDate(d) {
  return DateTime.fromJSDate(d instanceof Date ? d : new Date(d)).setZone(CFG.tz).toISODate();
}
function phxNow() { return DateTime.now().setZone(CFG.tz); }
function money(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
function initial(s) { s = String(s || '').trim(); return s ? s[0].toUpperCase() + '.' : ''; }
function shortName(first, last) { return (String(first || '').trim() || 'A donor') + (last ? ' ' + initial(last) : ''); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function rows(nodeName) {
  // items from an HTTP node; tolerates the empty {} that alwaysOutputData adds
  return $(nodeName).all().map(function (i) { return i.json; }).filter(function (x) { return x && x.id !== undefined; });
}
function graphRows(nodeName) {
  // SharePoint list items across pages (each page is one item with .value)
  const out = [];
  $(nodeName).all().forEach(function (i) { (i.json.value || []).forEach(function (r) { out.push(r); }); });
  return out;
}
function emailHtml(bodyHtml) {
  // every donor email: the body, a way to unsubscribe, and SCI's street address
  const unsub = 'mailto:' + CFG.senderMailbox + '?subject=Unsubscribe';
  return '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#22323B">' + bodyHtml +
    '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0 12px">' +
    '<p style="font-size:12px;color:#6C7C86">' + esc(CFG.orgName) + ' · ' + esc(CFG.orgAddress) + ' · EIN 39-2503445<br>' +
    'You are receiving this because you gave to ' + esc(CFG.orgName) + '. ' +
    '<a href="' + unsub + '">Unsubscribe</a> (or reply with the word unsubscribe) and we will stop all fundraising email to you.</p></div>';
}
function mail(to, subject, bodyHtml) {
  // a Graph sendMail request; while emailsApproved is false it goes to the review mailbox
  const review = !CFG.emailsApproved;
  return {
    url: 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(CFG.senderMailbox) + '/sendMail',
    body: { message: {
      subject: (review ? '[REVIEW, would go to a donor] ' : '') + subject,
      body: { contentType: 'HTML', content: emailHtml(bodyHtml) },
      toRecipients: [{ emailAddress: { address: review ? CFG.senderMailbox : to } }]
    }, saveToSentItems: true }
  };
}
function teams(html) {
  return { url: 'https://graph.microsoft.com/v1.0/teams/' + CFG.teamId + '/channels/' + CFG.channelId + '/messages',
           body: { body: { contentType: 'html', content: html } } };
}
