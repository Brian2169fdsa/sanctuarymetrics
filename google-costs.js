/* ==========================================================================
   Google cost system: the hand-kept numbers behind google.html
   --------------------------------------------------------------------------
   Goal: cut what Sanctuary pays Google (Workspace), the same way the
   Microsoft licenses were cut. Same rule as microsoft-costs.js: nothing is
   estimated. Anything left null shows as "needed" on the page.

   To fill it in:
     * plans: from Google Admin → Billing → Subscriptions (plan, seats you pay
       for, price per seat per month, Flexible vs. Annual, renewal date)
     * invoices: from Google Admin → Billing → Transactions, one row per month
     * realized: when an invoice shows a cut landing, add it
     * checklist: change a step's status as it happens
   The accounts themselves (usage on both sides, keep/cut choices) live in
   Supabase (google_accounts) behind sign-in, not in this public file.
   tools/build-google-js.py can still build google-users.js from a Google
   Admin export for department totals. See GOOGLE_COSTS.md.
   ========================================================================== */
var GOOGLE_COSTS = {
  asOf: '2026-10-21',      /* 'YYYY-MM-DD' of the last update */

  /* The Google Workspace being cut: Sanctuary Sober Living's. */
  workspace: 'sanctuarysoberliving.com',

  /* Google's tax on these invoices: 5.6% state + 3.5% local. */
  taxRate: 0.091,

  /* One row per Workspace subscription.
     Example: { name: 'Business Starter', seats: 40, price: 8.40, term: 'Flexible', renews: null } */
  plans: [
    { name: 'Business Standard', seats: 13, price: 16.80, term: 'Flexible', renews: 'Monthly · next bill Nov 1, 2026',
      note: 'No contract: billing stops for an account the day it is deleted. Suspended accounts still bill.' }
  ],

  /* Billed total per month, tax included, as on the Google invoices.
     Example: { month: '2026-09', total: 512.40 } */
  invoices: [
    { month: '2026-07', total: 215.79, subtotal: 197.79, tax: 18.00, invoice: '5641164120', seats: '11, then 12 from Jul 8' },
    { month: '2026-08', total: 222.30, subtotal: 203.76, tax: 18.54, invoice: '5665995368', seats: '12, then 13 from Aug 28' },
    { month: '2026-09', total: 238.27, subtotal: 218.40, tax: 19.87, invoice: '5703840971', seats: '13' }
  ],
  paidWith: 'Visa ending 2935 (charged automatically)',

  /* Counts only — the accounts themselves are in Supabase (google_accounts),
     shown on google.html to signed-in staff. From the Oct 21 review. */
  review: {
    checkedOn: '2026-10-21', accounts: 13, ready: 5, verify: 5, keep: 3,
    gmailImported: 7, gmailImportedWhen: 'Nov 2023 – Feb 2024', gmailNotImported: 2,
    googleGB: 48.1, driveNotInM365GB: 5.6,
    sharedDrives: 'TIP 2.0, Cirriculum, Curriculum, Updated IOP Portal, IOP (about 80 MB)'
  },

  /* Where each domain's mail is delivered today (MX records). */
  domains: [
    { domain: 'sanctuaryrc.com', role: 'Secondary', mailTo: 'Microsoft 365' },
    { domain: 'sanctuaryrecoverycenters.com', role: 'Secondary', mailTo: 'Microsoft 365' },
    { domain: 'sanctuarysoberliving.com', role: 'Primary', mailTo: 'Google' }
  ],

  /* Every place in Microsoft 365 a Google migration would leave a trace. */
  evidence: [
    { check: 'Exchange migration batches', result: '0 batches', finding: 'None remain, but the import did happen (see the [Gmail] folders) — the batches were removed after it finished.' },
    { check: 'Migration Manager: Google Workspace', result: 'Never set up', finding: 'Google Drive was not moved with SharePoint Migration Manager.' },
    { check: '"Sanctuary Google Archive" SharePoint site', result: '2 files, 0 GB', finding: 'The site made for the Google files (created Jun 9) is empty.' },
    { check: 'Personal archive site for a kept account', result: '3 files, 0 GB', finding: 'That account\'s Google Drive files are not there.' },
    { check: 'TIP 2.0 SharePoint site', result: '431 files, 0.87 GB', finding: 'Google\'s TIP 2.0 shared drive is 59 MB, so this likely covers it.' },
    { check: 'Gmail history in 365 mailboxes', result: '7 accounts imported', finding: 'Exchange shows [Gmail] folders holding mail dated before each 365 mailbox existed: the Gmail history was imported, Nov 2023 – Feb 2024. Not imported: the 2 accounts with no 365 mailbox.' },
    { check: 'OneDrive storage per user', result: 'Larger than Google Drive for most', finding: 'Most Verify accounts have more in OneDrive than in Google Drive, so files may have been copied there. One (6 MB in OneDrive against 2.9 GB in Drive) clearly was not.' }
  ],

  /* Savings confirmed on an actual invoice. Example: { month: '2026-11', monthly: 84.00, note: '' } */
  realized: [],

  /* Who signs off on Google cuts, and who does the work. */
  approver: null,
  owner: null,

  /* The wind-down plan. status: 'todo' | 'doing' | 'done'. */
  checklist: [
    { step: 'Review every Google account against Microsoft 365',
      detail: 'Done Oct 21: usage from the Google Admin apps report, matched to the 365 mailbox usage report and SharePoint.',
      status: 'done' },
    { step: 'Record the Google subscription and the last three invoices',
      detail: 'Done: 13 × Business Standard, Flexible, $16.80/seat; Jul–Sep invoices below.',
      status: 'done' },
    { step: 'Agree the cut list',
      detail: 'Tick accounts on this page and send them for approval. Ulonda\'s Sober Living account is locked as must-keep.',
      status: 'doing' },
    { step: 'Confirm the Gmail history is in 365',
      detail: 'Done Oct 21: Exchange shows imported [Gmail] folders in 7 mailboxes (Nov 2023 – Feb 2024). Still to export: the 2 accounts with no 365 mailbox.',
      status: 'done' },
    { step: 'Point sanctuarysoberliving.com mail to Microsoft 365',
      detail: 'Its MX still points to Gmail, and info@sanctuarysoberliving.com still receives mail there. Create the 365 mailbox, then switch MX.',
      status: 'todo' },
    { step: 'Move anything still needed to Microsoft 365',
      detail: 'Shared drives and files people still use go to SharePoint / OneDrive; mail is already on Exchange. Confirm with each owner before deleting.',
      status: 'todo' },
    { step: 'Delete the approved accounts in Google Admin',
      detail: 'Flexible plan: billing for an account stops the day it is deleted (suspending does not stop it). Deleting the 5 ready accounts before Nov 1 saves $84 on that bill.',
      status: 'todo' },
    { step: 'Confirm the drop on the next Google invoice',
      detail: 'Add it to realized so the cost cutting overview shows it as money actually saved.',
      status: 'todo' }
  ]
};
