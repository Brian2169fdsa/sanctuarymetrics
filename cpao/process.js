/* ============================================================================
   The HEAplus access process, start to finish: the ten stages the CP-AO
   portal tracks, which statuses belong to each, who acts, and how long each
   usually takes. Shared by cpao-admin.html (roster, person page, "How it
   works") and cpao-apply.html (the staff member's "what happens next").
   ========================================================================== */
var CPAO_STAGES = [
  { n: 1, key: 'invited', title: 'Invited', who: 'Brian',
    statuses: ['invited'],
    time: 'Same day',
    text: 'Brian picks the person from the Microsoft 365 staff list and sends their invite link.' },
  { n: 2, key: 'apply', title: 'Fills out the CP-101', who: 'Staff member',
    statuses: ['in_progress', 'needs_fix'],
    time: 'About 15 minutes — please within 2–3 days',
    text: 'They sign in with their work account (or, if invited at a personal email, open the link with the access code Brian gives them) and complete the Individual User Application on their phone or computer. An automatic check sends anything missing back to them.' },
  { n: 3, key: 'countersign', title: 'Brian countersigns', who: 'Brian',
    statuses: ['ready_for_countersign'],
    time: '1–2 business days',
    text: 'Brian reviews the application, countersigns it, and the official CP-101 PDF is made.' },
  { n: 4, key: 'org_form', title: 'Add/Remove form', who: 'Brian',
    statuses: ['countersigned', 'queued_for_batch'],
    time: 'Weekly (batch day, 8:00 am)',
    text: 'Once a week the Organization User Application (the Add/Remove form) is filled in for everyone ready, signed, and bundled with their CP-101s.' },
  { n: 5, key: 'sent', title: 'Sent to CPAO — background check', who: 'AHCCCS / CPAO',
    statuses: ['sent_to_cpao', 'cpao_correction_requested'],
    time: '1 week to 3 months',
    text: 'Brian emails the bundle to CPAO. AHCCCS runs the background check. AHCCCS replies by letter mailed to Sanctuary — Elyssa uploads it in the person\'s card on the HEAplus tab and Brian gets an alert. If CPAO asks for a correction or more information, it is logged as a follow-up and re-sent.' },
  { n: 6, key: 'training', title: 'Approved — AZLearns training', who: 'Staff member',
    statuses: ['approved_training_assigned'],
    time: 'Usually 1–2 weeks to finish',
    text: 'AHCCCS approves the background check and emails the staff member their AZLearns login. They complete the required certification courses online.' },
  { n: 7, key: 'certs', title: 'Certificates turned in', who: 'Staff member → Brian',
    statuses: ['training_complete'],
    time: 'Same day they finish',
    text: 'The staff member sends Brian their course completion certificates.' },
  { n: 8, key: 'final', title: 'Certificates sent to CPAO — final approval', who: 'Brian → CPAO',
    statuses: ['certs_sent_to_cpao'],
    time: 'Brian: 1–2 business days · CPAO reply varies',
    text: 'Brian sends the certificates to CPAO for final approval.' },
  { n: 9, key: 'account', title: 'Final approval — Brian creates the account', who: 'Brian',
    statuses: ['final_approved'],
    time: '1–2 business days',
    text: 'CPAO gives final approval and Brian creates the person\'s HEAplus account.' },
  { n: 10, key: 'active', title: 'Active in HEAplus', who: 'Staff member',
    statuses: ['active'],
    time: 'Done',
    text: 'They can sign in to HEAplus and start helping clients apply.' }
];
var CPAO_TOTAL_TIME = 'About 3 weeks at the quickest, and up to 3–4 months — almost all of it is the AHCCCS background check.';
/* what happens when AHCCCS says no (usually after the background check, step 5) */
var CPAO_DENIAL = [
  'AHCCCS mails a letter to Sanctuary. Elyssa uploads it in the person\'s card on the HEAplus tab, and Brian gets an alert and a task.',
  'Brian opens the person, reads the letter and records the denial with the reason. It goes in their follow-up log, and a task is added for Brian to let them know.',
  'Brian tells the person privately — in person or by phone, not by email with details.',
  'They can\'t use HEAplus. If the reason can be fixed (a wrong date of birth, a name mismatch, a missing document), Brian can invite them to reapply and the process starts again at step 1.'
];

/* the stage a status belongs to (null for denied / removal) */
function cpaoStageOf(status) {
  for (var i = 0; i < CPAO_STAGES.length; i++) { if (CPAO_STAGES[i].statuses.indexOf(status) >= 0) { return CPAO_STAGES[i]; } }
  return null;
}

/* the written process with timings; esc() comes from ui.js */
function cpaoProcessHtml(opts) {
  opts = opts || {};
  return '<ol class="proc">' + CPAO_STAGES.map(function (s) {
    return '<li class="' + (opts.current && opts.current >= s.n ? (opts.current === s.n ? 'now' : 'done') : '') + '">' +
      '<div class="proc-h"><b>' + s.n + '. ' + esc(s.title) + '</b><span class="proc-t">' + esc(s.time) + '</span></div>' +
      '<div class="proc-w">' + esc(s.who) + '</div><p>' + esc(s.text) + '</p></li>';
  }).join('') + '</ol><p class="proc-total"><b>How long overall:</b> ' + esc(CPAO_TOTAL_TIME) + '</p>' +
    '<div class="proc-deny"><b>If AHCCCS denies the application</b><ol>' +
      CPAO_DENIAL.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol></div>';
}
var CPAO_PROCESS_CSS =
  '.proc{list-style:none;margin:0;padding:0;counter-reset:none}' +
  '.proc li{position:relative;padding:0 0 16px 26px;border-left:2px solid #dfe7ec;margin-left:8px}' +
  '.proc li:last-child{border-left-color:transparent}' +
  '.proc li::before{content:"";position:absolute;left:-8px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #b9c7cf}' +
  '.proc li.done::before{background:#2E8B6F;border-color:#2E8B6F}' +
  '.proc li.done{border-left-color:#2E8B6F}' +
  '.proc li.now::before{background:#fff;border-color:#2C5468;box-shadow:0 0 0 4px rgba(44,84,104,.18)}' +
  '.proc-h{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:14.5px}' +
  '.proc-t{font-size:12.5px;font-weight:700;color:#14628a;background:#e8f3fb;border-radius:12px;padding:2px 9px;white-space:nowrap}' +
  '.proc-w{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6C7C86;margin-top:2px}' +
  '.proc p{margin:4px 0 0;font-size:13.5px;line-height:1.5;color:#33434c}' +
  '.proc-total{font-size:14px;margin:4px 0 0;padding:10px 12px;background:#fff8ec;border:1px solid #f1dca6;border-radius:10px}' +
  '.proc-deny{font-size:13.5px;margin:10px 0 0;padding:10px 12px;background:#fbf1ef;border:1px solid #f0c9bd;border-radius:10px;line-height:1.5}' +
  '.proc-deny ol{margin:6px 0 0;padding-left:20px}';
if (typeof module !== 'undefined') { module.exports = { CPAO_STAGES: CPAO_STAGES }; }
