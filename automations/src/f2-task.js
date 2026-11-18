// Major gift: a Planner task for Joey to call within 48 hours.
//__LIB__
return $('Normalize').all().filter(function (i) { return i.json.major; }).map(function (i) {
  const g = i.json;
  return { json: { body: {
    planId: CFG.plannerPlanId, bucketId: CFG.plannerBucketId,
    title: 'Call ' + g.display + ' within 48 hours: ' + money(g.amount) + ' to ' + g.campaign,
    dueDateTime: DateTime.now().plus({ hours: 48 }).toUTC().toISO(),
    assignments: CFG.joeyUserId ? { [CFG.joeyUserId]: { '@odata.type': '#microsoft.graph.plannerAssignment', orderHint: ' !' } } : {}
  } } };
});
