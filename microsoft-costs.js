/* ==========================================================================
   Microsoft cost system: the numbers behind "Cost cut so far" and "Analytics"
   --------------------------------------------------------------------------
   One file, edited by hand. To keep it current:
     * each month, add a row to `snapshots` (licenses vs. actual usage)
     * each new Microsoft invoice, append its month and totals to `invoices`
     * when an invoice shows a cut landing, add it to `realized`
   Nothing is estimated: a month with no invoice yet simply has no row.
   ========================================================================== */
var MS_COSTS = {
  asOf: '2026-10-01',

  /* Sales tax on the Microsoft invoices (from the usage review). */
  taxRate: 0.091,

  /* Invoiced totals per month INCLUDING sales tax, by billing profile, as on
     the invoices summarized in the M365 Usage & License Review. */
  invoices: {
    months:    ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
                '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
    sanctuary: [1214.14, 1214.14, 1214.14, 1214.14, 1214.14, 1223.86, 1301.56,
                1435.87, 1437.74, 1451.29, 1455.55, 1455.55, 1575.40],
    it:        [0, 0, 0, 0, 0, 0, 0, 0, 53.88, 599.04, 788.10, 788.10, 788.10]
  },

  /* The cut Elyssa approved: 24 accounts, priced at the current invoice rates. */
  approvedCut: {
    approvedBy: 'Elyssa',
    recordedOn: '2026-10-01',
    accounts: 24,
    lines: [
      { sku: 'Business Basic',    qty: 16, price: 7.35,  note: '' },
      { sku: 'Business Standard', qty: 7,  price: 14.21, note: 'average across the Standard subscriptions' },
      { sku: 'Business Premium',  qty: 1,  price: 26.40, note: '' }
    ],
    /* Comes off the next invoice: the Premium seat + the month-to-month Standard seats. */
    immediateMonthly: 70,
    /* First invoice the cut can appear on (month-to-month subs renew 10/7 and
       10/15/2026). Move it if the drop lands a month later. */
    firstInvoice: '2026-10',
    /* The rest sit on annual terms through 2027: reclaimed for new hires
       rather than a lower bill now. Basic and Standard terms end 9/16/2027
       (one Standard subscription ends 6/1/2027). */
    annualTermEnds: '2027-09-16'
  },

  keptLive: ['Custer', 'Schall', 'Maguire', 'Ulonda'],

  process: {
    owner: 'Mimi',
    offboarding: ['Block sign-in', 'Convert to shared mailbox', 'Remove license', 'Delete after 90 days'],
    snapshotCadence: 'monthly'
  },

  /* Monthly snapshot: licenses vs. actual usage. One row per month. */
  snapshots: [
    { month: '2026-09', source: 'M365 Usage & License Review',
      seatsBought: 181, seatsAssigned: 173, licensedUsers: 151, enabledLicensed: 135,
      active30: 111, licenseMonthly: 2166.28, invoicedMonthly: 2363.50 }
  ],

  /* Per-SKU view from the same review (bought / assigned / used in 30 days). */
  sku: [
    { name: 'Business Basic',    bought: 85, assigned: 85, active30: 61, price: 7.35 },
    { name: 'Business Standard', bought: 53, assigned: 46, active30: 33, price: 14.21 },
    { name: 'Business Premium',  bought: 21, assigned: 20, active30: 17, price: 26.40 },
    { name: 'Exchange Online P2', bought: 20, assigned: 20, active30: 16, price: 9.60 },
    { name: 'Copilot',           bought: 1,  assigned: 1,  active30: 1,  price: 31.50 },
    { name: 'Entra ID P2',       bought: 1,  assigned: 1,  active30: 1,  price: 10.50 }
  ],

  /* Savings confirmed on an actual invoice. Empty until the next invoice lands.
     `monthly` is the drop seen on the invoice, tax included.
     Example row: { month: '2026-10', monthly: 0, note: 'what came off and why' } */
  realized: [],

  /* The message as sent, kept verbatim for the record. */
  message: [
    'Elyssa — here\'s the actual figure for the 24 accounts you approved, at the rates on your current Microsoft invoices:',
    '• 16 × Business Basic ($7.35)\n• 7 × Business Standard ($14.21 avg)\n• 1 × Business Premium ($26.40)',
    '$243/month before tax, $266 with tax — about $2,900 to $3,200 per year.',
    'Of that, roughly $70/mo comes off the next invoice right away (the Premium seat and the month-to-month Standard seats). ' +
    'The rest are seats on the annual term through 2027, so those show up as seats we no longer have to buy for new hires ' +
    'rather than a lower bill this month. I\'ll send a full report once everything\'s cleaned up.',
    'Custer, Schall, Maguire and Ulonda stay live as you asked — no changes to those four.',
    'Mimi — agreed. I\'ll put together a standard offboarding checklist (block sign-in → convert to shared → remove license → ' +
    '90-day delete) and send a monthly snapshot of licenses vs. actual usage so this stays visible going forward.'
  ]
};

/* ── derived figures, shared by both pages ─────────────────────────────── */
var MS = (function (d) {
  var monthly = d.approvedCut.lines.reduce(function (a, l) { return a + l.qty * l.price; }, 0);
  var withTax = monthly * (1 + d.taxRate);
  var inv = d.invoices.months.map(function (m, i) {
    return { month: m, sanctuary: d.invoices.sanctuary[i], it: d.invoices.it[i],
             total: d.invoices.sanctuary[i] + d.invoices.it[i] };
  });
  var latest = inv[inv.length - 1];
  return {
    cutMonthly: monthly,
    cutWithTax: withTax,
    cutYearLow: monthly * 12,
    cutYearHigh: withTax * 12,
    immediate: d.approvedCut.immediateMonthly,
    deferred: monthly - d.approvedCut.immediateMonthly,
    invoices: inv,
    latest: latest,
    /* Invoices include tax, so the targets take the cut off with tax too. */
    immediateWithTax: d.approvedCut.immediateMonthly * (1 + d.taxRate),
    deferredWithTax: (monthly - d.approvedCut.immediateMonthly) * (1 + d.taxRate),
    targetNear: latest.total - d.approvedCut.immediateMonthly * (1 + d.taxRate),
    targetFull: latest.total - withTax,
    realizedTotal: d.realized.reduce(function (a, r) { return a + r.monthly; }, 0)
  };
})(MS_COSTS);

function msMoney(n, cents) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}
function msMonth(m) {
  var p = m.split('-');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + p[0];
}
function msEsc(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
