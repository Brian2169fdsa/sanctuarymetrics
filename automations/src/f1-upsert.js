// Build the SharePoint request: create the donor, or update their row.
// This list, in SCI's own Microsoft 365, is the only place donor details land.
//__LIB__
return $input.all().map(function (item, i) {
  const g = $('Normalize').all()[i].json;
  const found = (item.json.value || [])[0];
  const base = 'https://graph.microsoft.com/v1.0/sites/' + CFG.sharepointSiteId + '/lists/' + CFG.donorListId + '/items';
  const f = found ? found.fields : {};
  const fields = {
    Title: (g.first + ' ' + g.last).trim() || 'Donor ' + g.donorId,
    DonorboxDonorId: String(g.donorId), FirstName: g.first, LastName: g.last, Email: g.email,
    LastGiftDate: g.date, LastGiftUsd: g.amount, LastCampaign: g.campaign,
    GiftCount: (Number(f.GiftCount) || 0) + 1, TotalGivenUsd: Math.round(((Number(f.TotalGivenUsd) || 0) + g.amount) * 100) / 100,
    Recurring: g.recurring || !!f.Recurring
  };
  if (!found) { fields.FirstGiftDate = g.date; fields.JourneyStep = 'new'; }
  if (g.major) { fields.MajorGift = true; }
  return { json: found
    ? { method: 'PATCH', url: base + '/' + found.id + '/fields', body: fields }
    : { method: 'POST', url: base, body: { fields: fields } } };
});
