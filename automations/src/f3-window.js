// Decide how much to pull. First run (or once a week): every donation, so
// refunds and edits to old gifts are picked up. Otherwise: from two days
// before the last pull, de-duplicated on donation id in the compute step.
const CFG = $('Config').first().json;
const S = $getWorkflowStaticData('global');
const now = DateTime.now().setZone(CFG.tz);
const lastFull = S.lastFullPull ? DateTime.fromISO(S.lastFullPull) : null;
const full = !S.donations || !lastFull || now.diff(lastFull, 'days').days >= 7;
const from = full ? '' : DateTime.fromISO(S.lastPull).minus({ days: 2 }).toISODate();
return [{ json: {
  full: full,
  donationsUrl: CFG.donorboxApi + '/donations?per_page=100&order=asc' + (from ? '&date_from=' + from : ''),
  stateUrl: CFG.siteUrl + '/api/fundraising-state',
  contentsBase: 'https://api.github.com/repos/' + CFG.githubRepo + '/contents/'
} }];
