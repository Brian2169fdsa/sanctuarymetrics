/* ==========================================================================
   Cost cutting: shared helpers for costs.html (the hub) and google.html.
   Reads MS_COSTS / MS_CLEANUP (Microsoft) and GOOGLE_COSTS / GOOGLE_USERS
   (Google) when the page has loaded them; a vendor with no data reports
   nulls, which the pages show as "needed" rather than a guess.
   ========================================================================== */
function cEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function cMoney(n, cents) {
  if (n === null || n === undefined || isNaN(n)) { return '—'; }
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}
function cMonth(ym) {
  return ym ? new Date(ym + '-15T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '';
}

/* ── per-vendor totals on one shape ─────────────────────────────────────
   bill        latest invoiced month, tax included (null = no invoice yet)
   identified  monthly value of licenses/seats already freed or flagged
   pending     comes off once seats are reduced
   realized    confirmed on an invoice                                     */
function costMicrosoft() {
  if (typeof MS_COSTS === 'undefined') { return null; }
  var inv = MS_COSTS.invoices, i = inv.months.length - 1;
  var K = typeof MS_CLEANUP !== 'undefined' ? MS_CLEANUP.kpis : {};
  var realized = (MS_COSTS.realized || []).reduce(function (a, r) { return a + (r.monthly || 0); }, 0) + (K.offInvoiceMonthly || 0);
  return {
    key: 'microsoft', name: 'Microsoft 365', href: 'microsoft-savings.html', color: '#2563eb',
    bill: i >= 0 ? inv.sanctuary[i] + inv.it[i] : null, billMonth: inv.months[i],
    identified: K.freedMonthly || 0, pending: K.pendingMonthly || 0, realized: realized,
    status: 'Licenses removed Oct 15 · seat reductions pending'
  };
}
function costGoogle() {
  if (typeof GOOGLE_COSTS === 'undefined') { return null; }
  var G = GOOGLE_COSTS, U = typeof GOOGLE_USERS !== 'undefined' ? GOOGLE_USERS : null;
  var last = G.invoices.length ? G.invoices[G.invoices.length - 1] : null;
  /* the review's ready + verify accounts × seat price; else flagged export users × plan price */
  var identified = null, seat = G.plans[0] && G.plans[0].price;
  if (G.review && seat) {
    identified = (G.review.ready + G.review.verify) * seat;
  } else if (U && G.plans.length) {
    identified = U.users.filter(function (u) { return u.candidate; }).reduce(function (a, u) {
      var p = G.plans.filter(function (pl) { return pl.name === u.plan; })[0];
      return a + (p && p.price ? p.price : 0);
    }, 0);
  }
  return {
    key: 'google', name: 'Google Workspace', href: 'google.html', color: '#0f9d8a',
    bill: last ? last.total : null, billMonth: last ? last.month : null,
    identified: identified, pending: null,
    realized: G.realized.reduce(function (a, r) { return a + (r.monthly || 0); }, 0),
    candidates: G.review ? G.review.ready + G.review.verify : (U ? U.totals.candidates : null),
    status: G.review ? G.review.ready + ' ready to cut · ' + G.review.verify + ' to verify · ' + G.review.keep + ' kept (of ' + G.review.accounts + ')'
      : U ? U.totals.candidates + ' accounts flagged for review' : 'Waiting for the Google Admin export'
  };
}
function costVendors() { return [costMicrosoft(), costGoogle()].filter(Boolean); }

/* the cost-system tab bar (same look as the Microsoft pages) */
function costBar(current) {
  var tabs = [['costs.html', 'Overview', 'overview'], ['costs.html#departments', 'By department', 'departments'],
              ['microsoft-savings.html', 'Microsoft', 'microsoft'], ['google.html', 'Google', 'google']];
  return '<nav class="ms-bar" aria-label="Cost cutting"><a class="ms-back" href="index.html">&larr; Sanctuary report</a>' +
    tabs.map(function (t) {
      return '<a href="' + t[0] + '"' + (t[2] === current ? ' aria-current="page"' : '') + ' data-tab="' + t[2] + '">' + t[1] + '</a>';
    }).join('') + '<span class="ms-sys">Cost cutting</span></nav>';
}
