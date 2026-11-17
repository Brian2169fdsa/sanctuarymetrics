/* Builds the n8n workflow exports in automations/*.json from the Code-node
   sources in automations/src/. Edit the sources, then: npm run n8n:build
   (Re-import the changed workflow into n8n afterwards.)                    */
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, '..', 'automations', 'src');
const OUT = path.join(__dirname, '..', 'automations');
const code = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace('//__LIB__', () => fs.readFileSync(path.join(SRC, 'lib.js'), 'utf8'));
let uid = 0;
const id = () => 'n' + String(++uid).padStart(4, '0') + '-sci';
const CRED = {
  donorbox: { httpBasicAuth: { id: 'set-on-import', name: 'Donorbox API' } },
  graph: { oAuth2Api: { id: 'set-on-import', name: 'SCI Microsoft Graph' } },
  github: { githubApi: { id: 'set-on-import', name: 'SCI GitHub (contents write)' } },
  sync: { httpHeaderAuth: { id: 'set-on-import', name: 'SCI Fundraising sync secret' } },
  scheduler: { httpHeaderAuth: { id: 'set-on-import', name: 'SCI social scheduler' } }
};
const AUTH = {
  donorbox: { authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth' },
  graph: { authentication: 'genericCredentialType', genericAuthType: 'oAuth2Api' },
  github: { authentication: 'predefinedCredentialType', nodeCredentialType: 'githubApi' },
  sync: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
  scheduler: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }
};
const CFG = "$('Config').first().json";

function wf(name, build) {
  const nodes = [], connections = {};
  let x = 0;
  const api = {
    add(n, opts) {
      const node = Object.assign({ id: id(), name: n.name, type: n.type, typeVersion: n.v, position: n.pos || [x += 220, n.y || 300], parameters: n.p }, opts || {});
      if (n.cred) { node.credentials = CRED[n.cred]; }
      if (n.notes) { node.notes = n.notes; node.notesInFlow = true; }
      nodes.push(node);
      return n.name;
    },
    link(from, to, outIdx) {
      outIdx = outIdx || 0;
      connections[from] = connections[from] || { main: [] };
      while (connections[from].main.length <= outIdx) { connections[from].main.push([]); }
      connections[from].main[outIdx].push({ node: to, type: 'main', index: 0 });
    },
    chain() { for (let i = 0; i < arguments.length - 1; i++) { api.link(arguments[i], arguments[i + 1]); } }
  };
  build(api);
  return { name: name, nodes: nodes, connections: connections, active: false, pinData: {},
           settings: { executionOrder: 'v1', timezone: 'America/Phoenix', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
           tags: [{ name: 'SCI fundraising' }] };
}
/* node makers */
const configNode = (y) => ({ name: 'Config', type: 'n8n-nodes-base.code', v: 2, y: y, p: { jsCode: fs.readFileSync(path.join(SRC, 'config.js'), 'utf8') },
  notes: 'Non-secret settings. Fill in the Microsoft IDs.' });
const codeNode = (name, file, y, notes) => ({ name, type: 'n8n-nodes-base.code', v: 2, y, p: { mode: 'runOnceForAllItems', jsCode: code(file) }, notes });
function http(name, o) {
  const p = Object.assign({ method: o.method || 'GET', url: o.url }, AUTH[o.auth] || {});
  if (o.headers) { p.sendHeaders = true; p.headerParameters = { parameters: Object.keys(o.headers).map((k) => ({ name: k, value: o.headers[k] })) }; }
  if (o.json) { p.sendBody = true; p.specifyBody = 'json'; p.jsonBody = o.json; }
  p.options = o.options || {};
  return { name, type: 'n8n-nodes-base.httpRequest', v: 4.2, y: o.y, p, cred: o.auth, notes: o.notes };
}
const DONORBOX_PAGES = { pagination: { pagination: { parameters: { parameters: [{ name: 'page', value: '={{ $pageCount + 1 }}' }] },
  paginationCompleteWhen: 'responseIsEmpty', limitPagesFetched: true, maxRequests: 500, requestInterval: 300 } } };
const GRAPH_PAGES = { pagination: { pagination: { paginationMode: 'responseContainsNextURL', nextURL: '={{ $response.body["@odata.nextLink"] }}',
  paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body["@odata.nextLink"] }}', limitPagesFetched: true, maxRequests: 100 } } };
const ghGet = (name, file, y, notes) => http(name, { auth: 'github', y, notes,
  url: "={{ 'https://api.github.com/repos/' + " + CFG + ".githubRepo + '/contents/" + file + "?ref=' + " + CFG + ".githubBranch }}",
  headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
const stateGet = (y) => http('GET state', { auth: 'sync', y, url: '={{ ' + CFG + ".siteUrl + '/api/fundraising-state' }}",
  notes: 'Post statuses, settings and run reports (no donor data).' });
const report = (name, idExpr, y, extra) => http(name, Object.assign({ auth: 'sync', method: 'POST', y,
  url: '={{ ' + CFG + ".siteUrl + '/api/fundraising-state?action=run' }}",
  json: '={{ JSON.stringify({ id: ' + idExpr + ", status: $json.runStatus || 'success', message: String($json.runMessage || $json.summary || '').slice(0, 280) }) }}",
  notes: 'Tells the Fundraising page this automation ran.' }, extra || {}));
const graphReq = (name, y, method) => http(name, { auth: 'graph', y, method: method || '={{ $json.method }}', url: '={{ $json.url }}', json: '={{ JSON.stringify($json.body) }}' });
const ifUrl = (name, y) => ({ name, type: 'n8n-nodes-base.if', v: 2, y, p: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ id: 'has-url', leftValue: '={{ !!$json.url }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } });
const cron = (name, expr, y) => ({ name, type: 'n8n-nodes-base.scheduleTrigger', v: 1.2, y, p: { rule: { interval: [{ field: 'cronExpression', expression: expr }] } } });
const runsCode = (ids, y) => ({ name: 'Runs', type: 'n8n-nodes-base.code', v: 2, y, p: { jsCode:
  "// one run report per automation in this workflow\nconst c = $getWorkflowStaticData('global').counts || {};\nconst s = $getWorkflowStaticData('global').summary;\nreturn " +
  JSON.stringify(ids) + ".map(function (id) { return { json: { runId: id, runMessage: s || (c[id] !== undefined ? c[id] + ' sent' : '') } }; });" } });

const W = {};

W['f3-metrics-sync'] = wf('SCI f3 · Metrics sync', (a) => {
  const t1 = a.add({ name: 'Every 15 minutes', type: 'n8n-nodes-base.scheduleTrigger', v: 1.2, y: 220, p: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } });
  const t2 = a.add({ name: 'Called by New gift', type: 'n8n-nodes-base.executeWorkflowTrigger', v: 1, y: 400, p: {} });
  const c = a.add(configNode(300));
  a.link(t1, c); a.link(t2, c);
  const ex = { executeOnce: true };
  const w = a.add(codeNode('Window', 'f3-window.js', 300), ex);
  const g1 = a.add(http('GET campaigns', { auth: 'donorbox', y: 300, url: '={{ ' + CFG + ".donorboxApi + '/campaigns?per_page=100' }}", options: DONORBOX_PAGES }), Object.assign({ alwaysOutputData: true }, ex));
  const g2 = a.add(http('GET plans', { auth: 'donorbox', y: 300, url: '={{ ' + CFG + ".donorboxApi + '/plans?per_page=100' }}", options: DONORBOX_PAGES }), Object.assign({ alwaysOutputData: true }, ex));
  const g3 = a.add(http('GET donations', { auth: 'donorbox', y: 300, url: "={{ $('Window').first().json.donationsUrl }}", options: DONORBOX_PAGES,
    notes: 'Read-only. Full pull weekly, incremental otherwise.' }), Object.assign({ alwaysOutputData: true }, ex));
  const g4 = a.add(stateGet(300), ex);
  const g5 = a.add(ghGet('GET campaign map', 'automations/campaign-map.json', 300, 'Donorbox campaign id → plan campaign id'), Object.assign({ onError: 'continueRegularOutput' }, ex));
  const g6 = a.add(ghGet('GET current file', 'data/fundraising-metrics.json', 300), Object.assign({ onError: 'continueRegularOutput' }, ex));
  const comp = a.add(codeNode('Compute', 'f3-compute.js', 300, 'Aggregates only. Throws if an email or donor name would be published.'), ex);
  const rep = a.add(report('Report run', "'f3'", 300), ex);
  const iff = a.add({ name: 'Changed?', type: 'n8n-nodes-base.if', v: 2, y: 300, p: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ id: 'changed', leftValue: "={{ $('Compute').first().json.changed }}", rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} } });
  const put = a.add(http('Commit metrics file', { auth: 'github', method: 'PUT', y: 240,
    url: "={{ 'https://api.github.com/repos/' + " + CFG + ".githubRepo + '/contents/data/fundraising-metrics.json' }}",
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    json: "={{ JSON.stringify(Object.assign({ message: $('Compute').first().json.message, content: $('Compute').first().json.content, branch: " + CFG +
      ".githubBranch, committer: { name: 'sci-metrics-bot', email: 'sci-metrics-bot@users.noreply.github.com' } }, $('Compute').first().json.sha ? { sha: $('Compute').first().json.sha } : {})) }}",
    notes: 'Only when values changed. Vercel redeploys on the commit.' }), ex);
  a.chain(c, w, g1, g2, g3, g4, g5, g6, comp, rep, iff); a.link(iff, put, 0);
});

W['f1-f2-new-and-major-gift'] = wf('SCI f1-f2 · New gift and major gift', (a) => {
  const hook = a.add({ name: 'Donorbox webhook', type: 'n8n-nodes-base.webhook', v: 2, y: 300,
    p: { httpMethod: 'POST', path: 'sci-donorbox-donation-CHANGE-ME', responseMode: 'onReceived', options: {} },
    notes: 'Set the path to a long random string, then paste the production URL into Donorbox → Custom webhooks (donations).' }, { webhookId: 'sci-donorbox-donation' });
  const c = a.add(configNode(300));
  const ids = a.add(codeNode('Donation ids', 'f1-ids.js', 300, 'Nothing in the webhook body is trusted; ids only, de-duplicated.'));
  const get = a.add(http('GET donation', { auth: 'donorbox', y: 300, url: '={{ ' + CFG + ".donorboxApi + '/donations?id=' + $json.id }}", notes: 'Re-read from Donorbox (read-only).' }));
  const norm = a.add(codeNode('Normalize', 'f1-normalize.js', 300));
  const find = a.add(http('Find donor', { auth: 'graph', y: 300,
    url: "={{ 'https://graph.microsoft.com/v1.0/sites/' + " + CFG + ".sharepointSiteId + '/lists/' + " + CFG + ".donorListId + \"/items?$expand=fields&$filter=fields/DonorboxDonorId eq '\" + $json.donorId + \"'\" }}",
    headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } }));
  const ups = a.add(codeNode('Upsert request', 'f1-upsert.js', 300));
  const save = a.add(graphReq('Save donor (private list)', 300));
  const tm = a.add(codeNode('Teams message', 'f1-teams.js', 300, 'First name and last initial only.'), { executeOnce: true });
  const post = a.add(graphReq('Post to Teams', 300, 'POST'));
  const task = a.add(codeNode('Major gift?', 'f2-task.js', 160, 'Gifts of $250 or more.'), { executeOnce: true });
  const plan = a.add(http('Call task for Joey', { auth: 'graph', method: 'POST', y: 160, url: 'https://graph.microsoft.com/v1.0/planner/tasks', json: '={{ JSON.stringify($json.body) }}' }));
  const r2 = a.add(report('Report f2', "'f2'", 160), { executeOnce: true });
  const sync = a.add({ name: 'Update metrics (f3)', type: 'n8n-nodes-base.executeWorkflow', v: 1, y: 440,
    p: { source: 'database', workflowId: { __rl: true, value: '', mode: 'list' }, options: { waitForSubWorkflow: false } },
    notes: 'Pick "SCI f3 · Metrics sync" after import.' }, { executeOnce: true });
  const r1 = a.add(report('Report f1', "'f1'", 440), { executeOnce: true });
  a.chain(hook, c, ids, get, norm, find, ups, save, tm, post);
  a.chain(post, task, plan, r2);
  a.chain(post, sync, r1);
});

W['f4-f6-plan-changes'] = wf('SCI f4-f6 · New member, failed payment, cancelled plan', (a) => {
  const t = a.add(cron('Every hour', '7 * * * *', 300));
  const c = a.add(configNode(300));
  const g1 = a.add(http('GET plans', { auth: 'donorbox', y: 300, url: '={{ ' + CFG + ".donorboxApi + '/plans?per_page=100' }}", options: DONORBOX_PAGES }), { alwaysOutputData: true, executeOnce: true });
  const g2 = a.add(http('GET donor list', { auth: 'graph', y: 300, url: "={{ 'https://graph.microsoft.com/v1.0/sites/' + " + CFG + ".sharepointSiteId + '/lists/' + " + CFG + ".donorListId + '/items?$expand=fields&$top=999' }}", options: GRAPH_PAGES }), { executeOnce: true });
  const pc = a.add(codeNode('Plan changes', 'f4-plans.js', 300, 'First run records statuses only. Email templates inside: review before emailsApproved.'), { alwaysOutputData: true });
  const iff = a.add(ifUrl('Anything to send?', 220));
  const g = a.add(graphReq('Graph request', 220));
  const runs = a.add(runsCode(['f4', 'f5', 'f6'], 420), { executeOnce: true });
  const rep = a.add(report('Report runs', '$json.runId', 420));
  a.chain(t, c, g1, g2, pc, iff); a.link(iff, g, 0); a.chain(pc, runs, rep);
});

W['f7-f8-donor-journey-and-lapsed'] = wf('SCI f7-f8 · Donor journey and lapsed donors', (a) => {
  const t = a.add(cron('Daily 9:12 a.m.', '12 9 * * *', 300));
  const c = a.add(configNode(300));
  const g1 = a.add(http('GET donor list', { auth: 'graph', y: 300, url: "={{ 'https://graph.microsoft.com/v1.0/sites/' + " + CFG + ".sharepointSiteId + '/lists/' + " + CFG + ".donorListId + '/items?$expand=fields&$top=999' }}", options: GRAPH_PAGES }), { executeOnce: true });
  const g2 = a.add(http('GET unsubscribe replies', { auth: 'graph', y: 300,
    url: "={{ 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(" + CFG + ".senderMailbox) + '/messages?$search=\"unsubscribe\"&$top=100&$select=from,subject,bodyPreview,receivedDateTime' }}" }), { executeOnce: true, alwaysOutputData: true });
  const j = a.add(codeNode('Journey', 'f7-journey.js', 300, 'Day 1, 14, 60, month 11. Templates inside: review before emailsApproved.'), { alwaysOutputData: true });
  const iff = a.add(ifUrl('Anything to send?', 220));
  const g = a.add(graphReq('Graph request', 220));
  const runs = a.add(runsCode(['f7', 'f8'], 420), { executeOnce: true });
  const rep = a.add(report('Report runs', '$json.runId', 420));
  a.chain(t, c, g1, g2, j, iff); a.link(iff, g, 0); a.chain(j, runs, rep);
});

W['f9-social-queue'] = wf('SCI f9 · Social queue', (a) => {
  const t = a.add(cron('Daily 7 a.m.', '0 7 * * *', 300));
  const c = a.add(configNode(300));
  const g1 = a.add(ghGet('GET plan', 'data/sci-fundraising-data.json', 300), { executeOnce: true });
  const g2 = a.add(stateGet(300), { executeOnce: true });
  const q = a.add(codeNode('Queue', 'f9-queue.js', 300, 'Never sends held posts or needsRelease posts without a release.'), { alwaysOutputData: true });
  const isT = a.add({ name: 'Teams?', type: 'n8n-nodes-base.if', v: 2, y: 160, p: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ id: 'r', leftValue: '={{ $json.route }}', rightValue: 'teams', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} } });
  const tm = a.add(graphReq('Teams reminder', 160, 'POST'));
  const isS = a.add({ name: 'Scheduler?', type: 'n8n-nodes-base.if', v: 2, y: 300, p: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ id: 'r', leftValue: '={{ $json.route }}', rightValue: 'scheduler', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} } });
  const sch = a.add(http('Send to scheduler', { auth: 'scheduler', method: 'POST', y: 300, url: 'https://REPLACE-WITH-YOUR-SCHEDULER-WEBHOOK',
    json: '={{ JSON.stringify({ postId: $json.postId, date: $json.date, time: $json.time, channels: $json.channels, format: $json.format, text: $json.text }) }}',
    notes: 'Only reached when schedulerConnected is true AND auto-posting is on in the page AND the post is approved.' }));
  const mark = a.add(http('Mark scheduled', { auth: 'sync', method: 'PUT', y: 300, url: '={{ ' + CFG + ".siteUrl + '/api/fundraising-state' }}",
    json: "={{ JSON.stringify({ id: 'post:' + $('Send to scheduler').item.json.postId, data: { status: 'scheduled' } }) }}" }));
  const runs = a.add(runsCode(['f9'], 440), { executeOnce: true });
  const rep = a.add(report('Report run', '$json.runId', 440));
  a.chain(t, c, g1, g2, q); a.link(q, isT); a.link(isT, tm, 0); a.link(q, isS); a.link(isS, sch, 0); a.link(sch, mark); a.chain(q, runs, rep);
});

W['f10-weekly-digest'] = wf('SCI f10 · Weekly digest', (a) => {
  const t = a.add(cron('Mondays 8 a.m.', '0 8 * * 1', 300));
  const c = a.add(configNode(300));
  const g1 = a.add(ghGet('GET metrics', 'data/fundraising-metrics.json', 300), { executeOnce: true });
  const g2 = a.add(ghGet('GET plan', 'data/sci-fundraising-data.json', 300), { executeOnce: true });
  const g3 = a.add(stateGet(300), { executeOnce: true });
  const d = a.add(codeNode('Digest', 'f10-digest.js', 300, 'Aggregates only.'));
  const s = a.add(graphReq('Send (Teams and email)', 220, 'POST'));
  const rep = a.add(report('Report run', "'f10'", 400), { executeOnce: true });
  a.chain(t, c, g1, g2, g3, d, s); a.chain(d, rep);
});

W['f0-error-reporter'] = wf('SCI f0 · Error reporter', (a) => {
  const t = a.add({ name: 'When an SCI workflow fails', type: 'n8n-nodes-base.errorTrigger', v: 1, y: 300, p: {},
    notes: 'Set this workflow as the Error Workflow in every SCI workflow\'s settings.' });
  const c = a.add(configNode(300));
  const e = a.add({ name: 'Which automation', type: 'n8n-nodes-base.code', v: 2, y: 300, p: { jsCode: fs.readFileSync(path.join(SRC, 'f0-error.js'), 'utf8') } });
  const rep = a.add(report('Report error run', '$json.runId', 300), { onError: 'continueRegularOutput' });
  const al = a.add({ name: 'Alert text', type: 'n8n-nodes-base.code', v: 2, y: 300, p: { jsCode:
    "const CFG = $('Config').first().json;\nconst e = $('Which automation').first().json;\nreturn [{ json: { url: 'https://graph.microsoft.com/v1.0/teams/' + CFG.teamId + '/channels/' + CFG.channelId + '/messages',\n  body: { body: { contentType: 'html', content: '<b>SCI automation failed:</b> ' + String(e.workflow).replace(/</g, '&lt;') + '<br>' + String(e.runMessage).replace(/</g, '&lt;') + (e.url ? '<br><a href=\"' + e.url + '\">Open the execution</a>' : '') } } } }];" } },
    { executeOnce: true });
  const g = a.add(graphReq('Teams alert', 300, 'POST'));
  a.chain(t, c, e, rep, al, g);
});

for (const k of Object.keys(W)) { fs.writeFileSync(path.join(OUT, k + '.json'), JSON.stringify(W[k], null, 2) + '\n'); }
console.log(Object.keys(W).join('\n'));
