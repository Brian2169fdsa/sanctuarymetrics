// ── SCI fundraising: settings for this workflow ─────────────────────────────
// Non-secret settings only. Keys, tokens and passwords live in n8n
// credentials (see automations/README.md), never here.
// Fill in the Microsoft IDs once; the README says where each one comes from.
return [{ json: {
  siteUrl: 'https://sanctuarymetrics.vercel.app',           // the dashboard; /api/fundraising-state lives here
  githubRepo: 'Brian2169fdsa/sanctuarymetrics',             // owner/name
  githubBranch: 'main',                                      // the branch Vercel deploys
  tz: 'America/Phoenix',
  donorboxApi: 'https://donorbox.org/api/v1',
  majorGiftUsd: 250,
  // Microsoft 365 (SCI's own tenant)
  sharepointSiteId: '',         // Graph site id of SCI's SharePoint site
  donorListId: '',              // the private "SCI Donors" list (the only place donor details land)
  teamId: '',                   // Teams team for the fundraising channel
  channelId: '',                // the fundraising channel
  plannerPlanId: '',            // Planner plan for follow-up tasks
  plannerBucketId: '',          // bucket in that plan
  joeyUserId: '',               // Joey's Entra user id (major-gift call tasks)
  senderMailbox: '',            // the monitored SCI address that sends donor email
  digestRecipients: [],         // weekly digest email addresses
  orgName: 'Sanctuary Community Initiative',
  orgAddress: '11645 N Cave Creek Rd, Phoenix, AZ 85020',
  donorPortalUrl: 'https://donorbox.org/user/sign_in',      // VERIFY: Donorbox donor login page
  wallOfSupportUrl: 'https://www.sanctuaryci.org/The-Sanctuary.html',
  // Safety switch: until the email templates are reviewed and approved, every
  // donor email goes to senderMailbox instead of the donor, marked [REVIEW].
  emailsApproved: false,
  // Social queue (f9): a scheduling tool, if one is connected. Leave false to
  // get Teams reminders only. Auto-posting also needs the switch on the page.
  schedulerConnected: false
} }];
