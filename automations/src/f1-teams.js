// Teams alert: amount, campaign, one-time or monthly, first name and last initial only.
//__LIB__
return $('Normalize').all().map(function (i) {
  const g = i.json;
  return { json: teams('<b>New gift: ' + esc(money(g.amount)) + '</b> to ' + esc(g.campaign) + ' · ' +
    (g.recurring ? 'monthly' + (g.firstRecurring ? ' (new member)' : '') : 'one-time') + ' · from ' + esc(g.display) +
    (g.major ? '<br>Major gift: a call task for Joey is on the way.' : '')) };
});
