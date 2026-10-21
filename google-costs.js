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
   The user list (who has a license, last sign-in, storage, department) is
   built from a Google Admin export by tools/build-google-js.py into
   google-users.js. See GOOGLE_COSTS.md.
   ========================================================================== */
var GOOGLE_COSTS = {
  asOf: null,              /* 'YYYY-MM-DD' of the last update */

  /* One row per Workspace subscription.
     Example: { name: 'Business Starter', seats: 40, price: 8.40, term: 'Flexible', renews: null } */
  plans: [],

  /* Billed total per month, tax included, as on the Google invoices.
     Example: { month: '2026-09', total: 512.40 } */
  invoices: [],

  /* Savings confirmed on an actual invoice. Example: { month: '2026-11', monthly: 84.00, note: '' } */
  realized: [],

  /* Who signs off on Google cuts, and who does the work. */
  approver: null,
  owner: null,

  /* The wind-down plan. status: 'todo' | 'doing' | 'done'. */
  checklist: [
    { step: 'Export the user list from Google Admin and load it here',
      detail: 'Admin console → Directory → Users → Download users → All user info columns → CSV. Then run tools/build-google-js.py.',
      status: 'todo' },
    { step: 'Record the Google subscriptions and the last three invoices',
      detail: 'Billing → Subscriptions and Billing → Transactions. Fill in plans and invoices above.',
      status: 'todo' },
    { step: 'Agree the cut list',
      detail: 'Suspended-but-licensed, never signed in, and no sign-in in 90+ days are the first candidates (flagged on the page). Get sign-off before removing anything.',
      status: 'todo' },
    { step: 'Move anything still needed to Microsoft 365',
      detail: 'Shared drives and files people still use go to SharePoint / OneDrive; mail is already on Exchange. Confirm with each owner before deleting.',
      status: 'todo' },
    { step: 'Remove licenses and reduce the paid seat count',
      detail: 'Removing a license frees a seat; the bill only drops once the subscription\'s seat count is lowered (Annual plans: at renewal).',
      status: 'todo' },
    { step: 'Confirm the drop on the next Google invoice',
      detail: 'Add it to realized so the cost cutting overview shows it as money actually saved.',
      status: 'todo' }
  ]
};
