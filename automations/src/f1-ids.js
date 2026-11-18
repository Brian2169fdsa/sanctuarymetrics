// The webhook is only a "something happened" ping. Nothing in its body is
// trusted: we take the donation ids from it, skip ones already handled, and
// re-read each donation from the read-only Donorbox API in the next node.
// A forged call can at most make us look up a real donation, once.
const S = $getWorkflowStaticData('global');
S.seen = S.seen || [];
let body = $('Donorbox webhook').first().json.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
const list = Array.isArray(body) ? body : (body && (body.donations || body.data || [body])) || [];
const ids = [];
list.forEach(function (d) {
  const id = d && (d.id || (d.donation && d.donation.id));
  if (/^\d{1,15}$/.test(String(id)) && S.seen.indexOf(String(id)) < 0 && ids.indexOf(String(id)) < 0) { ids.push(String(id)); }
});
return ids.slice(0, 20).map(function (id) { return { json: { id: id } }; });
