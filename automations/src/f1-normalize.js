// One verified donation per item, read back from Donorbox. Marks it handled.
//__LIB__
const S = $getWorkflowStaticData('global');
S.seen = S.seen || [];
const out = [];
$input.all().forEach(function (item) {
  const body = item.json;
  const d = Array.isArray(body) ? body[0] : (body && body.id ? body : null);
  if (!d || d.status !== 'paid') { return; }
  if (S.seen.indexOf(String(d.id)) >= 0) { return; }
  S.seen.push(String(d.id));
  const donor = d.donor || {};
  out.push({ json: {
    donationId: d.id,
    amount: Number(d.amount) || 0,
    campaign: (d.campaign || {}).name || 'Unknown campaign',
    recurring: !!d.recurring,
    firstRecurring: !!d.first_recurring_donation,
    date: phxDate(d.donation_date),
    // private fields: they go to the SharePoint donor list only
    donorId: donor.id, first: donor.first_name || '', last: donor.last_name || '', email: donor.email || '',
    anonymous: !!d.anonymous_donation,
    major: (Number(d.amount) || 0) >= CFG.majorGiftUsd,
    // what Teams may show: first name and last initial only
    display: d.anonymous_donation ? 'Anonymous' : shortName(donor.first_name, donor.last_name)
  } });
});
S.seen = S.seen.slice(-5000);
return out;
