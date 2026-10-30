/* ============================================================================
   The cost rules: which licensed accounts look like waste, and what removing
   them saves. Plain rules over the daily pull — no AI, no estimates — so every
   dollar figure traces back to a person, a license and a price.

   lib/m365-ai.js hands these to Claude to rank, explain and pick from; Claude
   never invents a dollar figure. Each finding:
     { id, title, cat, urgency, users: [upn], kept: [upn], monthly, why, action, hipaa }

   Accounts on the keep list (m365_keep) never appear in a cut or downgrade.
   Accounts already in an approved-but-not-done or recently declined cut for
   the same rule are left out too (opts.exclude), so the same people aren't
   proposed again every morning.
   ========================================================================== */

const K = require('./m365-skus');

/* rule id → what removing one account saves per month */
const CUT_IDS = ['blocked', 'idle90', 'sharedlic', 'dups'];
function perAccount(id, p, price) {
  if (CUT_IDS.indexOf(id) >= 0) { return p.paid.reduce(function (s, l) { return s + (price[l] || 0); }, 0); }
  if (id === 'stacked') { return price[K.EXO2] || 0; }
  if (id === 'std2basic') { return Math.max(0, (price[K.STANDARD] || 0) - (price[K.BASIC] || 0)); }
  return 0;
}
function round(n) { return Math.round(n * 100) / 100; }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

function findings(D, opts) {
  opts = opts || {};
  const keep = {};
  (D.keep || []).forEach(function (k) { keep[k.upn] = k.reason || 'on the keep list'; });
  const exclude = opts.exclude || {};
  const price = D.price;
  const lic = D.people.filter(function (p) { return p.paid.length && !p.guest; });
  const has = function (p, l) { return p.licenses.indexOf(l) >= 0; };
  const shared = function (p) { return p.mbx_type === 'Shared'; };
  const idleDays = function (p) { return p.idle === null ? '—' : p.idle; };

  /* same display name on two licensed accounts: keep the most recently active */
  const byName = {};
  lic.forEach(function (p) { const k = p.name.trim().toLowerCase(); if (k) { (byName[k] = byName[k] || []).push(p); } });
  const dupUsers = [];
  Object.keys(byName).forEach(function (k) {
    const g = byName[k];
    if (g.length < 2) { return; }
    g.sort(function (a, b) { return (a.idle === null ? 1e6 : a.idle) - (b.idle === null ? 1e6 : b.idle); });
    g.slice(1).forEach(function (p) { dupUsers.push(p.upn); });
  });

  const raw = [
    { id: 'blocked', cat: 'Cut now', urgency: 'Immediate', title: 'Sign-in blocked accounts still holding paid licenses',
      pick: function (p) { return p.blocked; },
      why: function (n, m) { return n + ' accounts can\'t sign in but still carry ' + money(m) + '/mo of licenses. A blocked account needs no license; a mailbox that must stay can become a shared mailbox (free under 50 GB).'; },
      action: 'Convert the mailbox to shared if anyone still needs it, then remove the license. Delete after 90 days per the offboarding checklist.',
      hipaa: 'Positive: fewer stale identities holding mailboxes that contain PHI.' },
    { id: 'idle90', cat: 'Cut now', urgency: 'Immediate', title: 'Licensed, enabled accounts with no activity in 90+ days',
      pick: function (p) { return !p.blocked && !shared(p) && (p.idle === null || p.idle >= 90); },
      why: function (n) { return n + ' enabled accounts hold a paid license but haven\'t touched email, OneDrive, SharePoint or Teams in 90+ days (or ever). In a treatment organisation with clinical turnover these are usually people who left without an offboarding ticket.'; },
      action: 'Check against the HR roster. Departed: block sign-in, convert to shared if needed, remove the license. Still employed but not using Microsoft 365: Business Basic at most.',
      hipaa: 'Positive: dormant enabled accounts are the usual business-email-compromise entry point.' },
    { id: 'sharedlic', cat: 'Cut now', urgency: 'Immediate', title: 'Shared mailboxes carrying a paid license',
      pick: function (p) { return shared(p) && (p.mbx_gb === null || p.mbx_gb < 45) && !p.archive; },
      why: function (n, m) { return n + ' shared mailboxes carry ' + money(m) + '/mo of licenses. A shared mailbox under 50 GB without an archive works with no license at all.'; },
      action: 'Remove the license from each. Delegates keep access; nothing about the mailbox changes.',
      hipaa: 'Neutral: access is unchanged; make sure each shared mailbox has a named owner.' },
    { id: 'stacked', cat: 'Cut now', urgency: 'At the next monthly cycle', title: 'Exchange Online Plan 2 stacked on Business Premium',
      pick: function (p) { return has(p, K.PREMIUM) && has(p, K.EXO2); },
      why: function (n, m) { return n + ' Premium holders also carry Exchange Online Plan 2 (' + money(m) + '/mo). Premium already includes a mailbox; Plan 2 only adds a bigger quota, which nobody here is close to using.'; },
      action: 'Remove Exchange Online Plan 2 from these accounts and lower the seat count at the next renewal.',
      hipaa: 'Neutral: Premium keeps archiving, retention and Defender; nothing protective is lost.' },
    { id: 'std2basic', cat: 'Downgrade', urgency: 'At renewal', title: 'Business Standard holders who never open desktop Office',
      pick: function (p) { return has(p, K.STANDARD) && !p.blocked && p.idle !== null && p.idle < 90 && p.desktop === false; },
      why: function (n, m) { return n + ' active Business Standard users haven\'t used desktop Word, Excel or PowerPoint in 180 days; the web and mobile apps in Business Basic cover what they do. Moving them saves ' + money(m) + '/mo.'; },
      action: 'Move them to Business Basic as Standard seats come up for renewal. Keep Standard only for a documented desktop-app need.',
      hipaa: 'Neutral: Basic and Standard have the same security features.' },
    { id: 'dups', cat: 'Cut now', urgency: 'Immediate', title: 'Same person, two licensed accounts',
      pick: function (p) { return dupUsers.indexOf(p.upn) >= 0; },
      why: function (n, m) { return n + ' accounts share a display name with another licensed account; these are the less-used one of each pair (' + money(m) + '/mo).'; },
      action: 'Confirm it\'s the same person, forward or convert the spare mailbox to shared, and remove its license.',
      hipaa: 'Positive: one identity per person makes access reviews and audit trails straightforward.' },
    { id: 'idle30', cat: 'Review', urgency: 'Next review', title: 'Licensed accounts quiet for 30–89 days',
      pick: function (p) { return !p.blocked && !shared(p) && p.idle !== null && p.idle > 30 && p.idle < 90; },
      why: function (n) { return n + ' accounts have gone quiet for a month or more. Often leave, part-time or a role change — sometimes a departure nobody reported.'; },
      action: 'Ask each manager. If they\'ve left, offboard; otherwise leave them.', hipaa: 'Watch: a departure that isn\'t reported leaves PHI reachable.' },
    { id: 'basicdesk', cat: 'Review', urgency: 'Next review', title: 'Business Basic holders running desktop Office',
      pick: function (p) { return has(p, K.BASIC) && !has(p, K.STANDARD) && !has(p, K.PREMIUM) && p.desktop === true; },
      why: function (n) { return n + ' Basic holders show desktop Office activity, which Basic doesn\'t license — likely a personal or old activation.'; },
      action: 'Check each one. Either they need Standard (use a seat freed above) or the desktop install should be removed.',
      hipaa: 'Watch: unmanaged desktop installs may keep local copies of documents.' },
    { id: 'bigmbx', cat: 'Watch', urgency: 'Ongoing', title: 'Mailboxes approaching their limit',
      pick: function (p) { return p.mbx_gb !== null && p.mbx_quota_gb && p.mbx_gb >= 0.8 * p.mbx_quota_gb; },
      why: function (n) { return n + ' mailboxes are over 80% of their quota.'; },
      action: 'Turn on archiving or a retention policy before anyone buys a bigger plan.', hipaa: 'Positive: retention policies are a HIPAA expectation anyway.' },
    { id: 'premium', cat: 'Keep', urgency: 'Ongoing', title: 'Business Premium seats — keep, but make them earn it',
      pick: function (p) { return has(p, K.PREMIUM) && !p.blocked; },
      why: function (n) { return n + ' Premium holders. Premium is the security tier (Intune, Defender, Conditional Access), not a productivity upgrade — treat it as a control, not a cost line.'; },
      action: 'Keep Premium on leadership and PHI-heavy roles, and make sure its security features are actually switched on.',
      hipaa: 'Positive: cutting Premium is a compliance decision, not a cost one.' }
  ];

  const P = {};
  D.people.forEach(function (p) { P[p.upn] = p; });
  const out = raw.map(function (r) {
    let users = lic.filter(r.pick).map(function (p) { return p.upn; });
    const cuts = r.cat === 'Cut now' || r.cat === 'Downgrade';
    const kept = cuts ? users.filter(function (u) { return keep[u]; }) : [];
    if (cuts) {
      const ex = exclude[r.id] || [];
      users = users.filter(function (u) { return !keep[u] && ex.indexOf(u) < 0; });
    }
    const monthly = round(users.reduce(function (s, u) { return s + perAccount(r.id, P[u], price); }, 0));
    return { id: r.id, title: r.title, cat: r.cat, urgency: r.urgency, users: users, kept: kept, monthly: monthly,
      why: r.why(users.length, monthly), action: r.action, hipaa: r.hipaa };
  });

  /* seats bought and never assigned */
  const idleSeats = D.sku.filter(function (k) { return k.unassigned > 0 && k.price > 0; });
  const cash = idleSeats.filter(function (k) { return k.term === 'monthly'; });
  const cashM = round(cash.reduce(function (s, k) { return s + k.unassigned * k.price; }, 0));
  const annualM = round(idleSeats.filter(function (k) { return k.term !== 'monthly'; }).reduce(function (s, k) { return s + k.unassigned * k.price; }, 0));
  out.push({ id: 'unassigned', title: 'Seats bought but not assigned to anyone', cat: cashM > 0 ? 'Cut now' : 'Review',
    urgency: cashM > 0 ? 'At the next monthly cycle' : 'At renewal', users: [], kept: [], monthly: cashM,
    why: idleSeats.length ? idleSeats.map(function (k) { return plural(k.unassigned, k.name + ' seat'); }).join(', ') +
      ' are paid for and unassigned' + (annualM ? '; ' + money(annualM) + '/mo of them are on annual terms (reclaim for new hires, reduce at renewal)' : '') + '.'
      : 'Every seat bought is assigned.',
    action: 'Lower the seat count on month-to-month subscriptions now; on annual terms, assign these to new hires before buying more.',
    hipaa: 'Neutral.' });

  /* single seats of an expensive add-on */
  const single = D.sku.filter(function (k) { return k.total === 1 && k.price >= 5; });
  out.push({ id: 'single', title: 'Single-seat add-ons', cat: 'Review', urgency: 'At renewal',
    users: D.people.filter(function (p) { return single.some(function (k) { return p.licenses.indexOf(k.name) >= 0; }); }).map(function (p) { return p.upn; }),
    kept: [], monthly: 0,
    why: single.length ? single.map(function (k) { return k.name + ' (' + money(k.price) + '/mo)'; }).join(', ') + ' — one seat each. Worth confirming each is still used for what it was bought for.' : 'None.',
    action: 'Ask the holder whether it\'s used; don\'t renew if not.', hipaa: 'Neutral.' });

  return out;
}

/* deduplicated totals: a person counted in one cut isn't counted again */
function savings(D) {
  const F = {};
  D.findings.forEach(function (f) { F[f.id] = f; });
  const P = {};
  D.people.forEach(function (p) { P[p.upn] = p; });
  const cut = new Set([].concat(F.blocked.users, F.idle90.users, F.sharedlic.users, F.dups.users));
  let cutM = 0, cash = 0;
  cut.forEach(function (u) {
    (P[u] ? P[u].paid : []).forEach(function (l) { const v = D.price[l] || 0; cutM += v; if (D.term[l] === 'monthly') { cash += v; } });
  });
  const stacked = F.stacked.users.filter(function (u) { return !cut.has(u); }).length * (D.price[K.EXO2] || 0);
  const down = F.std2basic.users.filter(function (u) { return !cut.has(u); }).length * Math.max(0, (D.price[K.STANDARD] || 0) - (D.price[K.BASIC] || 0));
  const idle = F.unassigned.monthly;
  return { cut_users: cut.size, cut_monthly: round(cutM), stacked_monthly: round(stacked), downgrade_monthly: round(down),
    unassigned_monthly: idle, cash_monthly: round(cash + stacked + idle), total_monthly: round(cutM + stacked + down + idle) };
}

module.exports = { findings: findings, savings: savings, perAccount: perAccount, CUT_IDS: CUT_IDS };
