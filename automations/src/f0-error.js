// A workflow failed: report an error run for the automation ids in its name
// ("SCI f4-f6 · ..." → f4, f5, f6) so the page turns that card red.
const e = $input.first().json;
const name = (e.workflow && e.workflow.name) || '';
const m = /\bf(\d+)(?:-f(\d+))?\b/.exec(name);
const ids = [];
if (m) { for (let i = +m[1]; i <= +(m[2] || m[1]); i++) { ids.push('f' + i); } }
const msg = String(((e.execution || {}).error || {}).message || 'Workflow failed').slice(0, 280);
return ids.map(function (id) { return { json: { runId: id, runStatus: 'error', runMessage: (((e.execution || {}).lastNodeExecuted) ? e.execution.lastNodeExecuted + ': ' : '') + msg,
  workflow: name, url: (e.execution || {}).url || '' } }; });
