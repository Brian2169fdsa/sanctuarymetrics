// f9 Social queue, 7 a.m. Phoenix. Posts dated today or tomorrow:
//   approved, auto-posting switched on and a scheduler connected → scheduler
//   approved otherwise → Teams reminder with the copy, channels and format
//   not approved and due within two days → Teams reminder to the approver
// Never sent: held posts, and needsRelease posts without a recorded release.
//__LIB__
const plan = JSON.parse(Buffer.from(String($('GET plan').first().json.content || ''), 'base64').toString('utf8'));
const items = ($('GET state').first().json || {}).items || {};
const st = function (id) { return (items['post:' + id] || {}).data || {}; };
const today = phxNow().toISODate(), tomorrow = phxNow().plus({ days: 1 }).toISODate();
const auto = ((items['setting:autopost'] || {}).data || {}).on === true && CFG.schedulerConnected;
const posts = plan.socialPosts.slice();
Object.keys(items).forEach(function (k) {
  if (items[k].kind !== 'copy') { return; }
  const c = items[k].data, tpl = plan.socialPosts.filter(function (p) { return p.id === c.template; })[0];
  if (tpl) { posts.push(Object.assign({}, tpl, { id: k.replace(/^copy:/, ''), date: c.date, schedule: undefined })); }
});
const due = posts.filter(function (p) { return p.date === today || p.date === tomorrow; });
const toScheduler = [], reminders = [];
let held = 0;
due.forEach(function (p) {
  const s = st(p.id), status = s.status || 'draft';
  if (p.held) { held++; return; }
  if (p.needsRelease && !String(s.release || '').trim()) {
    if (status !== 'skipped' && status !== 'posted') { reminders.push('<b>' + esc(p.id) + '</b> (' + esc(p.date) + '): needs a signed release recorded before it can run. Use the fallback copy or skip it.'); }
    return;
  }
  const copy = s.finalLink ? p.copy.replace(/\[(link|donate link|membership link)\]/g, s.finalLink) : p.copy;
  if (status === 'approved') {
    if (auto) { toScheduler.push({ json: { postId: p.id, date: p.date, time: p.time || null, channels: p.channels, format: p.format, text: copy } }); }
    else {
      reminders.push('<b>Publish ' + esc(p.id) + ' on ' + esc(p.date) + (p.time ? ' at ' + esc(p.time) : '') + '</b> · ' + esc(p.channels.join(', ')) + ' · ' + esc(p.format) +
        '<br><pre>' + esc(copy) + '</pre>' + (/\[[^\]]+\]/.test(copy) ? '<i>Placeholders still in the copy: fill them before posting.</i>' : ''));
    }
  } else if (status === 'draft' || status === 'in-review') {
    reminders.push('<b>Needs approval' + (p.needsApprovalFrom ? ' from ' + esc(p.needsApprovalFrom) : '') + ':</b> ' + esc(p.id) + ' is due ' + esc(p.date) +
      ' (' + esc(p.channels.join(', ')) + '). Approve it on the Fundraising page, Social calendar tab.');
  }
});
$getWorkflowStaticData('global').summary = due.length + ' due, ' + toScheduler.length + ' to scheduler, ' + reminders.length + ' reminders, ' + held + ' held skipped';
const out = toScheduler.map(function (x) { x.json.route = 'scheduler'; return x; });
if (reminders.length) { out.push({ json: Object.assign({ route: 'teams' }, teams('<b>Social queue for ' + esc(today) + ' and ' + esc(tomorrow) + '</b><br><br>' + reminders.join('<hr>') +
  '<br><br><a href="' + esc(CFG.siteUrl) + '/fundraising.html#social">Open the social calendar</a>')) }); }
return out;
