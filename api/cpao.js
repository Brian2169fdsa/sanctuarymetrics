/* ============================================================================
   /api/cpao — the CP-AO Assistor Portal (AHCCCS HEAplus access).

   One function for both sides, to stay inside Vercel's 12-function limit:

   STAFF (cpao-apply.html#t=<invite token>). The token comes in the
   X-CPAO-Token header — never in a URL the server logs — and the person must
   also be signed in to the site with the Microsoft account the invite was
   sent to (that replaces the emailed 6-digit code: it's MFA-backed and needs
   no mailer). Five tries from the wrong account lock the link.
   Someone invited at a personal email (no Sanctuary Microsoft account) gets
   a 6-digit access code instead: Brian sees it once when he invites them and
   gives it to them himself (text or in person — it's never in the email).
   It comes in the X-CPAO-Code header; five wrong codes lock the link.
     GET  ?action=apply                     where they are + saved answers
     POST ?action=save   {step, answers, sensitive, agree, signature}
     GET  ?action=print                     CPAO_REQUIRE_WET_SIGNATURE: the
                                            pre-filled CP-101 to print and sign
     POST ?action=scan   (raw PDF body)     …and the signed scan
     POST ?action=submit                    Layer A + Claude check → routed

   WHO SEES WHAT on cpao-admin.html (access() in lib/auth.js):
     cpao_admin   the admin side below — site admins plus CPAO_ADMINS. Only a
                  site admin may countersign, change settings, build or mark
                  a batch, rotate the key or purge: those use his signature
                  or speak for him to CPAO (SITE_ADMIN_ONLY)
     cpao_mail    the roster, stages and CPAO letter uploads (mailRoute)
     cpao_manager the roster and stages, plus inviting people to the CP-101
                  (mailRoute, manager); nothing else
     everyone     their own stage in the process, found by their email
                  (selfRoute) — no application details — and, once CPAO
                  approves them, uploading their AZLearns certificates:
     POST ?action=cert_upload[&id=][&done=1]   (raw PDF/JPG/PNG, X-Course)

   ADMIN (cpao-admin.html; HEAplus admins):
     GET  ?action=roster | detail&id= | audit&id= | file&key= | directory
     GET  ?action=preview_pdf&id=   their CP-101 PDF (made on the fly before countersigning)
     POST ?action=invite | update | reveal | countersign | send_back | status | followup
                 | settings | batch | push {id} (Add/Remove form for one person now)
                 | mark_sent | send_batch {id} (email it to CPAO from the site admin's mailbox) | rotate | purge

   CRON (vercel.json, daily 15:00 UTC = 8:00 Phoenix): GET ?action=cron with
   Authorization: Bearer <CRON_SECRET>. Builds the weekly batch on
   settings.batch_weekday and runs the retention purge every day.

   PII rules: date of birth, SSN and home address are sealed with
   lib/cpao-crypto.js before they're stored, are only decrypted for the staff
   member themself, the PDF, or an admin "reveal" (which is audit-logged), and
   never go into URLs, logs, error messages, emails or Claude.
   ========================================================================== */

const { sendJSON, supabase, projectWrite, addedBy } = require('../lib/db');
const crypto = require('crypto');
const { currentUser, access, admins, sendAlerts } = require('../lib/auth');
const S = require('../lib/storage');
const K = require('../lib/cpao-crypto');
const R = require('../lib/cpao');
const P = require('../lib/cpao-pdf');
const G = require('../lib/cpao-graph');

const BUCKET = 'cpao';
const LINK_SECONDS = 300;          /* signed download links: 5 minutes */
const INVITE_DAYS = 14;
const MAX_FAILURES = 5;
const PURGE_AFTER_SENT_DAYS = 90;
const STATUSES = ['invited', 'in_progress', 'needs_fix', 'ready_for_countersign', 'countersigned', 'queued_for_batch',
  'sent_to_cpao', 'cpao_correction_requested', 'approved_training_assigned', 'training_complete', 'certs_sent_to_cpao',
  'final_approved', 'active', 'denied', 'remove_requested', 'removed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[A-Za-z]{2,}$/;

function bad(message, status, kind) { const e = new Error(message); e.bad = true; e.status = status || 400; e.kind = kind; return e; }
function str(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max); }
function wetMode() { return String(process.env.CPAO_REQUIRE_WET_SIGNATURE || '').toLowerCase() === 'true'; }
function ipOf(req) { return str(String(req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress), 60) || null; }
function site(req) { return (process.env.SITE_URL || ('https://' + req.headers.host)).replace(/\/+$/, ''); }
function nowIso() { return new Date().toISOString(); }
function db(method, table, query, body, headers) { return supabase(method, query, body, headers, table); }

/* JSON body with a bigger limit than lib/db (signature PNGs) */
async function body(req, limit) {
  if (req.body && !Buffer.isBuffer(req.body)) { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  const raw = await S.readRaw(req, limit || 600000);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
}

/* ── audit: never PII in detail ─────────────────────────────────────────── */
async function audit(actor, action, staffId, detail, req) {
  try {
    await db('POST', 'cpao_audit_log', '', { actor: actor || 'system', action: action, staff_id: staffId || null,
      detail: detail || null, ip: req ? ipOf(req) : null }, { Prefer: 'return=minimal' });
  } catch (e) { console.error('cpao audit write failed: ' + action); }
}

/* ── shared lookups ─────────────────────────────────────────────────────── */
async function staffById(id) {
  if (!UUID.test(String(id || ''))) { throw bad('Which person?'); }
  const s = (await db('GET', 'cpao_staff', '?id=eq.' + id + '&select=*'))[0];
  if (!s) { throw bad('That person isn\'t on the roster any more.', 404); }
  return s;
}
async function latestApp(staffId) {
  return (await db('GET', 'cpao_applications', '?staff_id=eq.' + staffId + '&select=*&order=created_at.desc&limit=1'))[0] || null;
}
async function settings() {
  return (await db('GET', 'cpao_settings', '?id=eq.1&select=*'))[0] || { batch_weekday: 1, pdf_retention_days: 365 };
}
/* every status change (and the Add/Remove form) stamps the date it happened
   in stage_dates, which the person page's stage tracker shows */
async function setStaff(id, fields, action, stage) {
  const f = Object.assign({ updated_at: nowIso() }, fields);
  if (action) { f.last_action = action; f.last_action_at = f.updated_at; }
  stage = stage || f.status;
  if (stage) {
    try {
      const cur = (await db('GET', 'cpao_staff', '?id=eq.' + id + '&select=stage_dates'))[0];
      f.stage_dates = Object.assign({}, (cur && cur.stage_dates) || {}, { [stage]: f.updated_at });
    } catch (e) { /* stage_dates not added yet (supabase/cpao.sql) — keep going without it */ }
  }
  return (await db('PATCH', 'cpao_staff', '?id=eq.' + id, f))[0];
}
function owner() { return str(process.env.CPAO_OWNER || process.env.PRINT_OWNER, 120) || R.C.site_admin_name; }
async function project(title, notes, due, by, importance) {
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' });
  const rows = await projectWrite('POST', '', Object.assign({
    title: title.slice(0, 300), owner: owner(), status: 'New', importance: importance || 'Med', due: due || null,
    notes: notes.slice(0, 4000), source: 'CP-AO portal · ' + today, seed_key: null }, addedBy(by || null)));
  const p = rows[0];
  try {
    const ref = 'row:' + p.id;
    await sendAlerts((await admins()).map(function (u) { return u.id; }), { kind: 'request', project_ref: ref,
      title: p.title, body: notes.slice(0, 500), link: 'projects.html#open=' + encodeURIComponent(ref) });
  } catch (e) { /* alerts are a nice-to-have */ }
  return p;
}
async function closeProject(id) {
  if (!id) { return; }
  try { await projectWrite('PATCH', '?id=eq.' + id, { status: 'Done' }); } catch (e) { /* removed by hand — fine */ }
}
async function signedLink(key) { return (await S.sign(BUCKET, [key], LINK_SECONDS))[key] || null; }

/* ════════════════════════════ STAFF SIDE ════════════════════════════════ */

/* personal-email invites: a 6-digit code Brian passes on himself */
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function codeHash(staffId, code) { return K.hashToken(staffId + ':' + code); }
function codeFields(s) {
  const code = newCode();
  return { code: code, fields: { invite_code_hash: codeHash(s.id, code) } };
}

/* the invite token + the signed-in account (or, for a personal email, the
   access code) must both match */
async function invitee(req) {
  const t = str(req.headers['x-cpao-token'], 100);
  if (!t) { throw bad('This page needs the link from your invite email.', 401); }
  const s = (await db('GET', 'cpao_staff', '?invite_token_hash=eq.' + K.hashToken(t) + '&select=*'))[0];
  if (!s || !s.invite_expires_at || new Date(s.invite_expires_at) < new Date()) {
    throw bad('This link has expired or was already used. Ask ' + R.C.site_admin_name + ' for a new one.', 410);
  }
  if (s.invite_failures >= MAX_FAILURES) { throw bad('This link is locked. Ask ' + R.C.site_admin_name + ' for a new one.', 423); }
  if (s.sign_in === 'code') {
    const c = R.digits(str(req.headers['x-cpao-code'], 20));
    if (!c) { throw bad('Enter the 6-digit access code ' + R.C.site_admin_name + ' gave you.', 401, 'need_code'); }
    if (!s.invite_code_hash || codeHash(s.id, c) !== s.invite_code_hash) {
      const failures = (s.invite_failures || 0) + 1;
      await db('PATCH', 'cpao_staff', '?id=eq.' + s.id, { invite_failures: failures });
      await audit(s.email, 'invite_wrong_code', s.id, { failures: failures }, req);
      throw bad(failures >= MAX_FAILURES ? 'That code is wrong and the link is now locked. Ask ' + R.C.site_admin_name + ' for a new one.'
        : 'That code isn\'t right. ' + (MAX_FAILURES - failures) + ' tries left.', 403, 'need_code');
    }
    return { staff: s, me: { email: s.email, name: s.first_name + ' ' + s.last_name } };
  }
  const me = await currentUser(req);
  if (!me) { throw bad('Sign in with your Sanctuary Microsoft account first.', 401); }
  if (String(me.email).toLowerCase() !== String(s.email).toLowerCase()) {
    await db('PATCH', 'cpao_staff', '?id=eq.' + s.id, { invite_failures: (s.invite_failures || 0) + 1 });
    await audit(me.email, 'invite_wrong_account', s.id, { failures: (s.invite_failures || 0) + 1 }, req);
    throw bad('This invite was sent to a different work account. Sign in with that account, or ask ' + R.C.site_admin_name + ' to re-send it.', 403);
  }
  return { staff: s, me: me };
}
async function appFor(staff) {
  let app = await latestApp(staff.id);
  if (!app || app.submitted_at && staff.status === 'invited') {
    app = (await db('POST', 'cpao_applications', '', { staff_id: staff.id, answers: {
      first_name: staff.first_name, last_name: staff.last_name, email: staff.email, state: 'AZ',
      title_position: R.TITLE_OPTIONS.indexOf(staff.title_position) >= 0 ? staff.title_position : (staff.title_position ? 'Other' : ''),
      title_other: R.TITLE_OPTIONS.indexOf(staff.title_position) >= 0 ? '' : (staff.title_position || ''),
      hire_date: staff.hire_date || '' } }))[0];
  }
  return app;
}
function editable(staff) { return ['invited', 'in_progress', 'needs_fix'].indexOf(staff.status) >= 0; }

/* what the form gets back: their own answers; SSN only as the last 4 */
function staffView(staff, app, x) {
  const ai = app.ai_check_result;
  return {
    staff: { first_name: staff.first_name, last_name: staff.last_name, email: staff.email, status: staff.status },
    editable: editable(staff), step: app.step, answers: app.answers || {},
    sensitive: { date_of_birth: x.date_of_birth || '', home_address: x.home_address || '', ssn_last4: x.ssn ? R.digits(x.ssn).slice(5) : '' },
    conditions_agreed: !!app.conditions_agreed_at, signed: !!(app.user_signature_key || app.wet_signed_upload_key),
    submitted: !!app.submitted_at && !editable(staff),
    /* the email note is for Brian, not something they must change */
    issues: staff.status === 'needs_fix' && ai ? (ai.issues || []).filter(function (i) { return !(i.field === 'email' && i.severity === 'warn'); }) : [],
    wet: wetMode(), titles: R.TITLE_OPTIONS, site_admin: R.C.site_admin_name, org: R.C.dba
  };
}

async function staffRoute(req, res, action) {
  const { staff, me } = await invitee(req);
  const app = await appFor(staff);
  const x = app.sensitive_ciphertext ? K.open(app.sensitive_ciphertext) : {};

  if (req.method === 'GET' && action === 'apply') {
    await audit(me.email, 'apply_open', staff.id, { step: app.step }, req);
    return sendJSON(res, 200, staffView(staff, app, x));
  }
  if (!editable(staff) && action !== 'apply') { throw bad('This application was already submitted.', 409); }

  if (req.method === 'GET' && action === 'print') {
    if (!wetMode()) { throw bad('Sign on screen instead.'); }
    const pdf = await P.cp101ToPrint({ answers: app.answers, sensitive: x });
    await audit(me.email, 'print_prefilled', staff.id, null, req);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + P.cp101FileName(app.answers) + '"');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(Buffer.from(pdf));
  }
  if (req.method === 'POST' && action === 'scan') {
    if (!wetMode()) { throw bad('Sign on screen instead.'); }
    const raw = await S.readRaw(req, 4000000);
    if (raw.toString('ascii', 0, 5) !== '%PDF-') { throw bad('Upload the scan as a PDF (not a photo).'); }
    let pages;
    try { pages = await P.pageCount(raw); } catch (e) { throw bad('That PDF couldn\'t be opened. Scan it again as a PDF.'); }
    if (pages !== 4) { throw bad('The signed form has 4 pages — this scan has ' + pages + '. Scan all 4 pages into one PDF.'); }
    const key = 'applications/' + staff.id + '/' + app.id + '/wet-signed.pdf';
    await S.upload(BUCKET, key, raw, 'application/pdf');
    await db('PATCH', 'cpao_applications', '?id=eq.' + app.id, { wet_signed_upload_key: key, user_signed_at: nowIso(), user_ip: ipOf(req), step: Math.max(app.step, 7), updated_at: nowIso() });
    await audit(me.email, 'sign_wet_upload', staff.id, { pages: pages }, req);
    return sendJSON(res, 200, { ok: true });
  }
  if (req.method === 'POST' && action === 'save') {
    const b = await body(req);
    const step = Number(b.step);
    if (!(step >= 1 && step <= 7)) { throw bad('Which step?'); }
    const patch = { updated_at: nowIso() };
    const def = R.STEPS[step - 1];
    if (def.keys.length) {
      const answers = Object.assign({}, app.answers || {});
      const sealed = Object.assign({}, x);
      const inA = b.answers || {}, inX = b.sensitive || {};
      def.keys.forEach(function (k) {
        if (R.SENSITIVE.indexOf(k) >= 0) {
          /* SSN left blank on a resumed form keeps the saved one */
          if (k === 'ssn' && !str(inX.ssn, 20) && sealed.ssn) { return; }
          sealed[k] = k === 'ssn' ? R.digits(inX[k]).slice(0, 9) : str(inX[k], k === 'home_address' ? 200 : 10);
        } else if (k === 'no_middle_name' || k === 'legal_name_ack') {
          answers[k] = inA[k] === true;
        } else {
          answers[k] = str(inA[k], k === 'title_other' ? 80 : 120);
        }
      });
      if (answers.state) { answers.state = answers.state.toUpperCase(); }
      if (answers.no_middle_name) { answers.middle_initial = ''; }
      if (answers.middle_initial) { answers.middle_initial = answers.middle_initial.toUpperCase(); }
      const errors = R.checkStep(step, answers, sealed);
      if (Object.keys(errors).length) { return sendJSON(res, 400, { error: 'fields', fields: errors, message: 'Fix the highlighted fields.' }); }
      patch.answers = answers;
      /* fixing a field clears what the last check said about it (the next
         submit checks everything again) */
      const ai = app.ai_check_result;
      if (staff.status === 'needs_fix' && ai && (ai.issues || []).length) {
        patch.ai_check_result = Object.assign({}, ai, { issues: ai.issues.filter(function (i) { return def.keys.indexOf(i.field) < 0; }) });
      }
      if (def.keys.some(function (k) { return R.SENSITIVE.indexOf(k) >= 0; })) { patch.sensitive_ciphertext = K.seal(sealed); }
    }
    if (step === 5) {
      if (b.agree !== true) { throw bad('Tick "I agree" to continue.'); }
      patch.conditions_agreed_at = nowIso();
      await audit(me.email, 'conditions_agreed', staff.id, null, req);
    }
    if (step === 6 && !wetMode()) {
      const png = Buffer.from(str(b.signature, 800000).replace(/^data:image\/png;base64,/, ''), 'base64');
      if (R.inkPixels(png) < 80) { throw bad('Sign in the box — the signature looks blank.'); }
      const key = 'applications/' + staff.id + '/' + app.id + '/user-signature.png';
      await S.upload(BUCKET, key, png, 'image/png');
      Object.assign(patch, { user_signature_key: key, user_signed_at: nowIso(), user_ip: ipOf(req) });
      await audit(me.email, 'sign_user', staff.id, null, req);
    }
    patch.step = Math.max(app.step || 1, Math.min(step + 1, 7));
    const saved = (await db('PATCH', 'cpao_applications', '?id=eq.' + app.id, patch))[0];
    if (staff.status === 'invited') { await setStaff(staff.id, { status: 'in_progress' }, 'Started the application'); }
    await audit(me.email, 'save_step', staff.id, { step: step }, req);
    return sendJSON(res, 200, staffView(Object.assign({}, staff, { status: staff.status === 'invited' ? 'in_progress' : staff.status }),
      saved, saved.sensitive_ciphertext ? K.open(saved.sensitive_ciphertext) : {}));
  }
  if (req.method === 'POST' && action === 'submit') {
    const sig = app.user_signature_key ? await S.download(BUCKET, app.user_signature_key) : null;
    const check = await R.checkApplication({ answers: app.answers, sensitive: x, conditions_agreed: !!app.conditions_agreed_at,
      signature: sig, wet_signed: wetMode() && !!app.wet_signed_upload_key });
    const result = Object.assign({ checked_at: nowIso(), model: check.model || null }, check.result);
    await audit(me.email, 'ai_check', staff.id, { request: check.request || null, response: check.response || null, result: result }, req);
    const name = R.fullName(app.answers);
    await db('PATCH', 'cpao_applications', '?id=eq.' + app.id, { ai_check_result: result, submitted_at: nowIso(), updated_at: nowIso() });
    if (result.status === 'fix_required') {
      await setStaff(staff.id, { status: 'needs_fix' }, 'Check found things to fix');
      return sendJSON(res, 200, { status: 'needs_fix', issues: result.issues });
    }
    const warns = (result.issues || []).map(function (i) { return '- ' + i.message_for_staff; });
    const p = await project('CP-101 ready to countersign: ' + name,
      ['Automatic check: ' + (result.status === 'pass' ? 'passed' : 'needs a look') + (result.admin_notes ? ' — ' + result.admin_notes : '')]
        .concat(warns.length ? ['', 'Warnings:'].concat(warns) : [])
        .concat(['', 'Open it: ' + site(req) + '/cpao-admin.html#staff=' + staff.id]).join('\n'),
      R.addBusinessDays(R.today(), 2), me, result.status === 'admin_review' ? 'Hot' : 'Med');
    /* single-use: the link stops working once it's submitted */
    await setStaff(staff.id, { status: 'ready_for_countersign', project_id: p.id, invite_token_hash: null, invite_expires_at: null },
      'Submitted — ready to countersign');
    return sendJSON(res, 200, { status: 'ready_for_countersign' });
  }
  throw bad('Unknown action.', 404);
}

/* ═════════════════════════════ ADMIN SIDE ═══════════════════════════════ */

async function invite(req, me, b) {
  let s;
  const link = K.token();
  const fields = { invite_token_hash: K.hashToken(link), invite_expires_at: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), invite_failures: 0 };
  let code = null;
  if (b.id) {
    s = await staffById(b.id);
    if (s.status === 'denied') {
      /* a fresh application after a denial */
      s = await setStaff(s.id, Object.assign(fields, { status: 'invited' }), 'Invited to reapply');
    } else {
      if (!editable(s)) { throw bad('Their application is already in — re-invite only works before it\'s submitted, or after "Send back".'); }
      s = await setStaff(s.id, fields, 'Invite re-sent');
    }
    /* a new link for a personal email comes with a new code */
    if (s.sign_in === 'code') { const c = codeFields(s); code = c.code; s = await setStaff(s.id, c.fields); }
  } else {
    const personal = b.sign_in === 'code';
    const row = {
      first_name: str(b.first_name, 40), last_name: str(b.last_name, 40), email: str(b.email, 200).toLowerCase(),
      title_position: str(b.title_position, 80) || null, worker_type: ['Employee', 'Contractor', 'Volunteer'].indexOf(b.worker_type) >= 0 ? b.worker_type : 'Employee',
      is_site_admin: b.is_site_admin === true, hire_date: R.isDate(b.hire_date) ? b.hire_date : null,
      work_address: str(b.work_address, 200) || R.C.default_work_address, status: 'invited'
    };
    if (personal) { row.sign_in = 'code'; }
    if (!row.first_name || !row.last_name) { throw bad('Add their first and last name.'); }
    if (!EMAIL.test(row.email)) { throw bad(personal ? 'Add their email.' : 'Add their work email.'); }
    const dup = await db('GET', 'cpao_staff', '?email=eq.' + encodeURIComponent(row.email) + '&status=not.in.(removed,denied)&select=id');
    if (dup.length) { throw bad('They\'re already on the roster' + (b.existing === true ? '.' : ' — use Re-send invite on their row.')); }
    /* someone who already has HEAplus access: on the tracker as Active, no
       invite and no forms (the CP-101 is only for people added from now on) */
    if (b.existing === true) {
      const now = nowIso();
      s = (await db('POST', 'cpao_staff', '', Object.assign(row, { status: 'active', heaplus_username: str(b.heaplus_username, 80) || null,
        last_action: 'Added — already has HEAplus access', last_action_at: now })))[0];
      try { s = await setStaff(s.id, {}, null, 'active'); } catch (e) { /* stage_dates not added yet */ }
      await audit(me.email, 'add_existing', s.id, null, req);
      delete s.invite_token_hash; delete s.invite_code_hash;
      return { ok: true, staff: s, existing: true };
    }
    s = (await db('POST', 'cpao_staff', '', Object.assign(row, fields, { last_action: 'Invited', last_action_at: nowIso() })))[0];
    if (personal) { const c = codeFields(s); code = c.code; s = await setStaff(s.id, c.fields); }
  }
  const url = site(req) + '/cpao-apply.html#t=' + link;
  let emailed = false, emailError = null;
  try {
    emailed = await G.sendMail(s.email, 'Individual User Application (HEAplus access)', [
      s.first_name + ', please take a moment to fill out the Individual User Application. You only need to complete the sections that ask for your personal information; I\'ll fill in the Sanctuary details. Once it\'s processed you\'ll get an email with instructions to log into the training portal (AZLearns) and complete the required courses. The AHCCCS background check can take anywhere from 1 week to 3 months.',
      '', code ? 'Start here: ' + url + '\nYou\'ll need the 6-digit access code I give you (I\'ll text it or tell you in person).'
               : 'Start here (sign in with your Sanctuary Microsoft account): ' + url,
      '', 'The link works for ' + INVITE_DAYS + ' days.', '', '— Brian'].join('\n'));
  } catch (e) { emailError = 'The email didn\'t send — copy the link instead.'; }
  await audit(me.email, b.id ? 'reinvite' : 'invite', s.id, { emailed: emailed }, req);
  delete s.invite_token_hash; delete s.invite_code_hash;
  return { ok: true, staff: s, link: url, code: code, emailed: emailed, email_error: emailError };
}

async function roster(me) {
  const staff = (await db('GET', 'cpao_staff', '?select=*&order=updated_at.desc')).map(function (s) {
    delete s.invite_token_hash; delete s.invite_code_hash;
    return s;
  });
  const apps = await db('GET', 'cpao_applications', '?select=id,staff_id,step,submitted_at,sa_signed_at,pdf_storage_key,batch_id,ai_check_result,purged_at,created_at&order=created_at.desc');
  const latest = {};
  apps.forEach(function (a) { if (!latest[a.staff_id]) { latest[a.staff_id] = a; } });
  const st = await settings();
  const batches = await db('GET', 'cpao_batches', '?select=id,week_of,status,rows,sent_at,project_id,org_form_storage_key,bundle_storage_key,created_at&order=created_at.desc&limit=30');
  return {
    staff: staff.map(function (s) {
      const a = latest[s.id];
      return Object.assign({}, s, { app: a ? { id: a.id, step: a.step, submitted_at: a.submitted_at, sa_signed_at: a.sa_signed_at,
        has_pdf: !!a.pdf_storage_key, ai_status: a.ai_check_result && a.ai_check_result.status, purged: !!a.purged_at } : null });
    }),
    batches: batches,
    settings: { site_admin_phone: st.site_admin_phone || '', has_signature: !!st.site_admin_signature_key,
                batch_weekday: st.batch_weekday, pdf_retention_days: st.pdf_retention_days },
    setup: { pii_key: K.configured(), ai: !!process.env.ANTHROPIC_API_KEY, model: R.MODEL, cron: !!process.env.CRON_SECRET,
             email: G.emailOn(), outlook_draft: G.draftOn(), wet: wetMode() },
    statuses: STATUSES, titles: R.TITLE_OPTIONS, constants: R.C
  };
}

async function detail(req, me, id) {
  const s = await staffById(id);
  const a = await latestApp(s.id);
  let x = {};
  let keyProblem = null;
  if (a && a.sensitive_ciphertext) { try { x = K.open(a.sensitive_ciphertext); } catch (e) { keyProblem = e.message; } }
  await audit(me.email, 'view_application', s.id, null, req);
  const links = {};
  if (a && a.user_signature_key) { links.signature = await signedLink(a.user_signature_key); }
  delete s.invite_token_hash; delete s.invite_code_hash;
  return {
    staff: s,
    app: a ? {
      id: a.id, form_version: a.form_version, step: a.step, answers: a.answers,
      sensitive: { date_of_birth: !!x.date_of_birth, ssn_last4: x.ssn ? R.digits(x.ssn).slice(5) : '', home_address: !!x.home_address },
      key_problem: keyProblem, conditions_agreed_at: a.conditions_agreed_at, user_signed_at: a.user_signed_at, user_ip: a.user_ip,
      has_signature: !!a.user_signature_key, wet_signed: !!a.wet_signed_upload_key, ai_check_result: a.ai_check_result,
      submitted_at: a.submitted_at, sa_signed_at: a.sa_signed_at, has_pdf: !!a.pdf_storage_key, batch_id: a.batch_id, purged_at: a.purged_at
    } : null,
    links: links
  };
}

async function countersign(req, me, id) {
  const s = await staffById(id);
  if (['ready_for_countersign', 'cpao_correction_requested'].indexOf(s.status) < 0) { throw bad('This one isn\'t waiting for a countersignature.'); }
  const a = await latestApp(s.id);
  if (!a || !a.submitted_at) { throw bad('They haven\'t submitted the application yet.'); }
  const st = await settings();
  if (!st.site_admin_signature_key) { throw bad('Draw your signature under Settings first.'); }
  const x = K.open(a.sensitive_ciphertext);
  const signedAt = nowIso();
  let pdf;
  if (a.wet_signed_upload_key) {
    /* wet-signed: the scan is the record; it already carries both pages 1-4 */
    pdf = await S.download(BUCKET, a.wet_signed_upload_key);
  } else {
    pdf = await P.cp101({ answers: a.answers, sensitive: x, user_signature: await S.download(BUCKET, a.user_signature_key),
      user_signed_at: a.user_signed_at, sa_signature: await S.download(BUCKET, st.site_admin_signature_key), sa_signed_at: signedAt });
  }
  const key = 'applications/' + s.id + '/' + a.id + '/' + P.cp101FileName(a.answers);
  await S.upload(BUCKET, key, Buffer.from(pdf), 'application/pdf');
  await db('PATCH', 'cpao_applications', '?id=eq.' + a.id, { sa_signed_at: signedAt, pdf_storage_key: key, updated_at: signedAt });
  await audit(me.email, 'countersign', s.id, { file: key.split('/').pop() }, req);
  await closeProject(s.project_id);
  await setStaff(s.id, { status: 'countersigned' }, 'Countersigned');
  await setStaff(s.id, { status: 'queued_for_batch', project_id: null }, 'Countersigned — queued for the weekly batch');
  await audit(me.email, 'status', s.id, { to: 'queued_for_batch' }, req);
  return { ok: true };
}

async function sendBack(req, me, b) {
  const s = await staffById(b.id);
  const note = str(b.note, 1000);
  if (!note) { throw bad('Say what they need to fix.'); }
  const a = await latestApp(s.id);
  if (!a) { throw bad('They haven\'t started yet.'); }
  const ai = Object.assign({}, a.ai_check_result || { status: 'fix_required', issues: [] });
  ai.status = 'fix_required';
  ai.issues = [{ field: str(b.field, 40) || 'general', step: R.stepOf(str(b.field, 40)), message_for_staff: note, severity: 'block', from_admin: true }]
    .concat((ai.issues || []).filter(function (i) { return !i.from_admin; }));
  const link = K.token();
  await db('PATCH', 'cpao_applications', '?id=eq.' + a.id, { ai_check_result: ai, submitted_at: null, updated_at: nowIso() });
  await closeProject(s.project_id);
  await setStaff(s.id, { status: 'needs_fix', project_id: null, invite_token_hash: K.hashToken(link),
    invite_expires_at: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), invite_failures: 0 }, 'Sent back to fix');
  const url = site(req) + '/cpao-apply.html#t=' + link;
  let emailed = false;
  try {
    emailed = await G.sendMail(s.email, 'Please fix your Individual User Application',
      s.first_name + ', one thing to fix on your HEAplus application:\n\n' + note + '\n\nOpen it here: ' + url + '\n\n— Brian');
  } catch (e) { /* the link is shown to the admin */ }
  await audit(me.email, 'send_back', s.id, { emailed: emailed }, req);
  return { ok: true, link: url, emailed: emailed };
}

/* manual status changes after CPAO replies; some start a task for Brian */
const STATUS_TASK = {
  cpao_correction_requested: function (n) { return 'CPAO asked for a correction: ' + n; },
  training_complete: function (n) { return 'Send AZLearns certificates to CPAO for final approval: ' + n; },
  final_approved: function (n) { return 'Create HEAplus account for ' + n; }
};
async function setStatus(req, me, b) {
  const s = await staffById(b.id);
  const to = b.status;
  if (STATUSES.indexOf(to) < 0) { throw bad('Unknown status.'); }
  if (to === 'remove_requested' && b.confirm_deactivated !== true) {
    throw bad('Confirm their HEAplus account is already deactivated first.');
  }
  const fields = { status: to };
  if ('heaplus_username' in b) { fields.heaplus_username = str(b.heaplus_username, 80) || null; }
  const name = s.first_name + ' ' + s.last_name;
  /* a denial needs the reason from CPAO's letter; it's logged as a follow-up
     and Brian gets a task to let the person know */
  let denial = null;
  if (to === 'denied') {
    const reason = str(b.reason, 1000);
    if (!reason) { throw bad('Add the reason CPAO gave for the denial.'); }
    const on = str(b.letter_date, 10);
    if (on && !R.isDate(on)) { throw bad('The letter date isn\'t a date.'); }
    denial = { at: nowIso(), by: me.name || me.email, kind: 'denial', due: null,
               text: 'Denied by AHCCCS' + (on ? ' (letter dated ' + R.mdy(on) + ')' : '') + ': ' + reason };
    fields.followups = (s.followups || []).concat([denial]).slice(-100);
  }
  /* moving on means the open task for the last step is done */
  if (s.project_id && to !== s.status) { await closeProject(s.project_id); fields.project_id = null; }
  if (denial) {
    const p = await project('Let ' + name + ' know their HEAplus application was denied',
      denial.text + '\n\nTell them in person or by phone (not by email with details). If the reason can be fixed, you can invite them to reapply from their page: ' +
      site(req) + '/cpao-admin.html#staff=' + s.id, R.addBusinessDays(R.today(), 1), me, 'Hot');
    fields.project_id = p.id;
  } else if (STATUS_TASK[to]) {
    const p = await project(STATUS_TASK[to](name), 'Status changed to ' + to.replace(/_/g, ' ') + '.\n\nOpen: ' + site(req) + '/cpao-admin.html#staff=' + s.id,
      R.addBusinessDays(R.today(), 2), me);
    fields.project_id = p.id;
  }
  await setStaff(s.id, fields, 'Status: ' + to.replace(/_/g, ' '));
  await audit(me.email, 'status', s.id, { from: s.status, to: to }, req);
  if (to === 'removed') { await purgeStaff(s.id, 'removed'); }
  return { ok: true };
}

/* follow-ups: anything CPAO or the person still needs, with an optional
   reminder task on the Projects page */
async function followup(req, me, b) {
  const s = await staffById(b.id);
  const text = str(b.text, 1000);
  if (!text) { throw bad('Write what the follow-up is.'); }
  const due = str(b.due, 10);
  if (due && !R.isDate(due)) { throw bad('The reminder date isn\'t a date.'); }
  const entry = { at: nowIso(), by: me.name || me.email, text: text, due: due || null };
  if (due) {
    const p = await project('Follow up: ' + s.first_name + ' ' + s.last_name + ' — ' + text.slice(0, 120),
      text + '\n\nOpen: ' + site(req) + '/cpao-admin.html#staff=' + s.id, due, me);
    entry.project_id = p.id;
  }
  const list = (s.followups || []).concat([entry]).slice(-100);
  await setStaff(s.id, { followups: list }, 'Follow-up: ' + text.slice(0, 80));
  await audit(me.email, 'followup', s.id, { due: due || null }, req);
  return { ok: true, followups: list };
}

async function saveSettings(req, me, b) {
  const f = { updated_at: nowIso() };
  if ('site_admin_phone' in b) { f.site_admin_phone = str(b.site_admin_phone, 40) || null; }
  if ('batch_weekday' in b) {
    const d = Number(b.batch_weekday);
    if (!(Number.isInteger(d) && d >= 0 && d <= 6)) { throw bad('Pick a day of the week.'); }
    f.batch_weekday = d;
  }
  if ('pdf_retention_days' in b) {
    const d = Number(b.pdf_retention_days);
    if (!(Number.isInteger(d) && d >= 30 && d <= 3650)) { throw bad('Keep PDFs between 30 and 3650 days.'); }
    f.pdf_retention_days = d;
  }
  if (b.signature) {
    const png = Buffer.from(str(b.signature, 800000).replace(/^data:image\/png;base64,/, ''), 'base64');
    if (R.inkPixels(png) < 80) { throw bad('The signature looks blank — draw it again.'); }
    const key = 'settings/site-admin-signature-' + Date.now() + '.png';
    await S.upload(BUCKET, key, png, 'image/png');
    const old = (await settings()).site_admin_signature_key;
    f.site_admin_signature_key = key;
    if (old) { try { await S.remove(BUCKET, [old]); } catch (e) { /* keep going */ } }
    await audit(me.email, 'sign_site_admin_saved', null, null, req);
  }
  await db('PATCH', 'cpao_settings', '?id=eq.1', f);
  await audit(me.email, 'settings', null, { fields: Object.keys(f).filter(function (k) { return k !== 'updated_at'; }) }, req);
  return { ok: true };
}

/* ── the weekly batch ───────────────────────────────────────────────────── */
/* only: staff ids for "Push through now" — an Add/Remove form for just them,
   today, without waiting for (or disturbing) the weekly batch */
async function buildBatch(req, actor, only) {
  let adds = await db('GET', 'cpao_staff', '?status=eq.queued_for_batch&select=*&order=last_name.asc');
  let removes = await db('GET', 'cpao_staff', '?status=eq.remove_requested&select=*&order=last_name.asc');
  const picked = function (x) { return !only || only.indexOf(x.id) >= 0; };
  adds = adds.filter(picked); removes = removes.filter(picked);
  if (only && !adds.length && !removes.length) { throw bad('They aren\'t waiting for the Add/Remove form — countersign them first.'); }
  if (!adds.length && !removes.length) {
    await audit(actor, 'batch_empty', null, null, req);
    return { ok: true, empty: true };
  }
  const st = await settings();
  if (!st.site_admin_signature_key) { throw bad('Draw your signature under Settings first — the Org form needs it.'); }
  const sig = await S.download(BUCKET, st.site_admin_signature_key);
  /* a re-run replaces any batch that wasn't sent yet (a push replaces only
     a draft that was just for them) */
  let drafts = await db('GET', 'cpao_batches', '?status=eq.draft&select=id,project_id,org_form_storage_key,bundle_storage_key,rows');
  if (only) {
    drafts = drafts.filter(function (d) { return (d.rows || []).some(function (r) { return only.indexOf(r.staff_id) >= 0; }); });
    if (drafts.some(function (d) { return (d.rows || []).some(function (r) { return only.indexOf(r.staff_id) < 0; }); })) {
      throw bad('They\'re already on an Add/Remove form with other people that hasn\'t been sent — open Weekly batches to download it.');
    }
  }
  for (const d of drafts) {
    await closeProject(d.project_id);
    try { await S.remove(BUCKET, [d.org_form_storage_key, d.bundle_storage_key].filter(Boolean)); } catch (e) { /* gone already */ }
    await db('PATCH', 'cpao_applications', '?batch_id=eq.' + d.id, { batch_id: null });
    await db('DELETE', 'cpao_batches', '?id=eq.' + d.id, null, { Prefer: 'return=minimal' });
  }
  const rows = [], cp101s = [], files = [], appIds = [];
  for (const s of adds) {
    const a = await latestApp(s.id);
    if (!a || !a.pdf_storage_key) { continue; }
    rows.push(Object.assign(P.orgRow(s, a.answers, s.is_site_admin ? 'Add-SA' : 'Add'), { staff_id: s.id }));
    const bytes = await S.download(BUCKET, a.pdf_storage_key);
    cp101s.push(bytes);
    files.push({ name: a.pdf_storage_key.split('/').pop(), bytes: bytes });
    appIds.push(a.id);
  }
  removes.forEach(function (s) { rows.push(Object.assign(P.orgRow(s, null, s.is_site_admin ? 'Remove-SA' : 'Remove'), { staff_id: s.id })); });
  if (!rows.length) { await audit(actor, 'batch_empty', null, { note: 'queued people had no countersigned PDF' }, req); return { ok: true, empty: true }; }

  const weekOf = R.today();
  const batch = (await db('POST', 'cpao_batches', '', { week_of: weekOf, status: 'draft', rows: rows.map(function (r) {
    return { staff_id: r.staff_id, name: r.name, action: r.action }; }) }))[0];
  const org = await P.orgForm(rows, { site_admin_phone: st.site_admin_phone, signature: sig });
  const bundle = await P.merge([org].concat(cp101s));
  const base = 'batches/' + weekOf + '-' + batch.id.slice(0, 8) + '/';
  const orgName = 'Organization_User_Application_' + weekOf + '.pdf', bundleName = 'CPAO_batch_' + weekOf + '.pdf';
  await S.upload(BUCKET, base + orgName, Buffer.from(org), 'application/pdf');
  await S.upload(BUCKET, base + bundleName, Buffer.from(bundle), 'application/pdf');
  if (appIds.length) { await db('PATCH', 'cpao_applications', '?id=in.(' + appIds.join(',') + ')', { batch_id: batch.id }); }
  for (const r of rows) {
    await setStaff(r.staff_id, {}, 'On the Add/Remove form (week of ' + R.mdy(weekOf) + ')', 'org_form');
  }

  const nAdd = rows.filter(function (r) { return /^Add/.test(r.action); }).length, nRemove = rows.length - nAdd;
  const draft = G.draftOn();
  const p = await project((only ? 'CPAO Add/Remove form ready: ' + rows.map(function (r) { return r.name; }).join(', ') : 'Weekly CPAO batch ready: ' + nAdd + ' add, ' + nRemove + ' remove'), [
    'Who:'].concat(rows.map(function (r) { return '- ' + r.name + ' — ' + r.action; })).concat([
    '', 'Download the bundle and the Org form: ' + site(req) + '/cpao-admin.html#batch=' + batch.id,
    '', 'Review → send to ' + R.C.cpao_ops_email + ' from your mailbox (only the site admin may email CPAO) → click Mark as Sent.',
    draft ? 'A draft with the files attached is waiting in your Outlook Drafts.' : ''
  ]).join('\n'), weekOf, null, 'Hot');
  await db('PATCH', 'cpao_batches', '?id=eq.' + batch.id, { org_form_storage_key: base + orgName, bundle_storage_key: base + bundleName, project_id: p.id });
  let drafted = false;
  try {
    const m = cpaoEmail(weekOf, nAdd, nRemove);
    drafted = await G.draftToCpao(m.subject, m.text, [{ name: orgName, bytes: org }].concat(files));
  } catch (e) { await audit(actor, 'outlook_draft_failed', null, null, req); }
  await audit(actor, 'batch_built', null, { batch_id: batch.id, add: nAdd, remove: nRemove, outlook_draft: drafted }, req);
  return { ok: true, batch_id: batch.id, add: nAdd, remove: nRemove, outlook_draft: drafted };
}

/* the email to CP-AO Operations (an Outlook draft, or "Send to CPAO") */
function cpaoEmail(weekOf, nAdd, nRemove) {
  return { subject: 'HEAplus user access — ' + R.C.dba + ' — ' + R.mdy(weekOf),
    text: 'Hello CP-AO Operations Team,\n\nAttached is our Organization User Application with ' + nAdd + ' add' + (nAdd === 1 ? '' : 's') +
      ' and ' + nRemove + ' removal' + (nRemove === 1 ? '' : 's') + (nAdd ? ', and the Individual User Application for each person being added' : '') +
      '.\n\nThank you,\n' + R.C.site_admin_name + '\n' + R.C.site_admin_title + ', ' + R.C.dba + '\n' + R.C.site_admin_email };
}

/* "Send to CPAO": Brian's click emails the Org form and every CP-101 in the
   batch from his mailbox to CP-AO Operations, then marks the batch sent */
async function sendBatch(req, me, id) {
  if (!UUID.test(String(id || ''))) { throw bad('Which batch?'); }
  const b = (await db('GET', 'cpao_batches', '?id=eq.' + id + '&select=*'))[0];
  if (!b) { throw bad('That batch isn\'t here any more.', 404); }
  if (b.status !== 'draft') { throw bad('That batch was already sent.'); }
  if (!b.org_form_storage_key) { throw bad('The files for this batch are gone — build it again.'); }
  const files = [{ name: b.org_form_storage_key.split('/').pop(), bytes: await S.download(BUCKET, b.org_form_storage_key) }];
  for (const a of await db('GET', 'cpao_applications', '?batch_id=eq.' + id + '&select=pdf_storage_key&order=created_at.asc')) {
    if (a.pdf_storage_key) { files.push({ name: a.pdf_storage_key.split('/').pop(), bytes: await S.download(BUCKET, a.pdf_storage_key) }); }
  }
  const nAdd = (b.rows || []).filter(function (r) { return /^Add/.test(r.action); }).length;
  const m = cpaoEmail(b.week_of, nAdd, (b.rows || []).length - nAdd);
  try { await G.sendToCpao(m.subject, m.text, files); }
  catch (e) { await audit(me.email, 'batch_email_failed', null, { batch_id: id, code: e.code || 'error' }, req); throw bad(e.message, e.code === 'graph' ? 502 : 400); }
  await audit(me.email, 'batch_emailed', null, { batch_id: id, to: R.C.cpao_ops_email, files: files.length }, req);
  await markSent(req, me, id);
  return { ok: true, to: R.C.cpao_ops_email, from: R.C.site_admin_email, files: files.length };
}

async function markSent(req, me, id) {
  if (!UUID.test(String(id || ''))) { throw bad('Which batch?'); }
  const b = (await db('GET', 'cpao_batches', '?id=eq.' + id + '&select=*'))[0];
  if (!b) { throw bad('That batch isn\'t here any more.', 404); }
  if (b.status !== 'draft') { throw bad('That batch was already marked sent.'); }
  const sentAt = nowIso();
  await db('PATCH', 'cpao_batches', '?id=eq.' + id, { status: 'sent', sent_at: sentAt });
  for (const r of b.rows || []) {
    const removing = /^Remove/.test(r.action);
    await setStaff(r.staff_id, { status: removing ? 'removed' : 'sent_to_cpao' }, removing ? 'Removal sent to CPAO' : 'Sent to CPAO');
    await audit(me.email, 'status', r.staff_id, { to: removing ? 'removed' : 'sent_to_cpao', batch_id: id }, req);
    if (removing) { await purgeStaff(r.staff_id, 'removed'); }
  }
  await closeProject(b.project_id);
  await project('Check CPAO status for batch ' + R.mdy(b.week_of),
    'Sent ' + R.mdy(R.today()) + ':\n' + (b.rows || []).map(function (r) { return '- ' + r.name + ' — ' + r.action; }).join('\n') +
    '\n\nUpdate each person\'s status on ' + site(req) + '/cpao-admin.html when CPAO replies.', R.addDays(R.today(), 14), me);
  await audit(me.email, 'batch_sent', null, { batch_id: id }, req);
  return { ok: true };
}

/* ── retention ──────────────────────────────────────────────────────────── */
async function purgeApp(a, why) {
  const keys = [a.user_signature_key, a.wet_signed_upload_key].filter(Boolean);
  if (keys.length) { try { await S.remove(BUCKET, keys); } catch (e) { /* already gone */ } }
  await db('PATCH', 'cpao_applications', '?id=eq.' + a.id, { sensitive_ciphertext: null, user_signature_key: null,
    wet_signed_upload_key: null, purged_at: nowIso() });
  await audit('system', 'purge_pii', a.staff_id, { why: why });
}
async function purgeStaff(staffId, why) {
  const apps = await db('GET', 'cpao_applications', '?staff_id=eq.' + staffId + '&purged_at=is.null&select=id,staff_id,user_signature_key,wet_signed_upload_key');
  for (const a of apps) { await purgeApp(a, why); }
}
async function purge() {
  const st = await settings();
  const cutoff = new Date(Date.now() - PURGE_AFTER_SENT_DAYS * 864e5).toISOString();
  const sent = await db('GET', 'cpao_batches', '?status=in.(sent,acknowledged)&sent_at=lt.' + encodeURIComponent(cutoff) + '&select=id');
  let n = 0, pdfs = 0;
  for (const b of sent) {
    const apps = await db('GET', 'cpao_applications', '?batch_id=eq.' + b.id + '&purged_at=is.null&select=id,staff_id,user_signature_key,wet_signed_upload_key');
    for (const a of apps) { await purgeApp(a, '90 days after the batch was sent'); n++; }
  }
  /* generated PDFs follow the retention setting */
  const old = new Date(Date.now() - (st.pdf_retention_days || 365) * 864e5).toISOString();
  const apps = await db('GET', 'cpao_applications', '?pdf_storage_key=not.is.null&sa_signed_at=lt.' + encodeURIComponent(old) + '&select=id,staff_id,pdf_storage_key');
  for (const a of apps) {
    try { await S.remove(BUCKET, [a.pdf_storage_key]); } catch (e) { /* gone */ }
    await db('PATCH', 'cpao_applications', '?id=eq.' + a.id, { pdf_storage_key: null });
    await audit('system', 'purge_pdf', a.staff_id, { retention_days: st.pdf_retention_days });
    pdfs++;
  }
  const oldBatches = await db('GET', 'cpao_batches', '?created_at=lt.' + encodeURIComponent(old) + '&bundle_storage_key=not.is.null&select=id,org_form_storage_key,bundle_storage_key');
  for (const b of oldBatches) {
    try { await S.remove(BUCKET, [b.org_form_storage_key, b.bundle_storage_key].filter(Boolean)); } catch (e) { /* gone */ }
    await db('PATCH', 'cpao_batches', '?id=eq.' + b.id, { org_form_storage_key: null, bundle_storage_key: null });
  }
  return { purged_applications: n, purged_pdfs: pdfs };
}

/* re-seal everything sealed with CPAO_PII_KEY_OLD under the current key */
async function rotate(req, me) {
  const apps = await db('GET', 'cpao_applications', '?sensitive_ciphertext=not.is.null&select=id,sensitive_ciphertext');
  let n = 0;
  for (const a of apps) {
    if (K.stale(a.sensitive_ciphertext)) {
      await db('PATCH', 'cpao_applications', '?id=eq.' + a.id, { sensitive_ciphertext: K.seal(K.open(a.sensitive_ciphertext)) });
      n++;
    }
  }
  await audit(me.email, 'rotate_key', null, { resealed: n, total: apps.length }, req);
  return { ok: true, resealed: n, total: apps.length };
}

/* signed 5-minute link to one of our files; only keys we stored */
async function fileLink(req, me, key) {
  key = str(key, 300);
  if (!/^(applications|batches)\/[A-Za-z0-9._\/-]+\.pdf$/.test(key) && !/^(mail|certs)\/[0-9a-f-]{36}\/[0-9]+\.(pdf|jpg|png)$/.test(key)) { throw bad('Which file?'); }
  if (key.indexOf('..') >= 0) { throw bad('Which file?'); }
  const known = /^(mail|certs)\//.test(key)
    ? (await db('GET', 'cpao_staff', '?followups=cs.' + encodeURIComponent(JSON.stringify([{ file: key }])) + '&select=id')).map(function (r) { return { staff_id: r.id }; })
    : (await db('GET', 'cpao_applications', '?pdf_storage_key=eq.' + encodeURIComponent(key) + '&select=staff_id')).concat(
      await db('GET', 'cpao_batches', '?or=(org_form_storage_key.eq.' + encodeURIComponent(key) + ',bundle_storage_key.eq.' + encodeURIComponent(key) + ')&select=id'));
  if (!known.length) { throw bad('That file isn\'t here any more.', 404); }
  await audit(me.email, 'download', known[0].staff_id || null, { file: key.split('/').pop() }, req);
  return { url: await signedLink(key) };
}

/* ── CPAO mail: letters AHCCCS posts to Sanctuary ──────────────────────────
   Elyssa (CPAO_MAIL_UPLOADERS) uploads the scan or photo; it's filed on the
   person's record, and Brian gets an alert and a task to act on it. */
const LETTER_KINDS = { approved: 'Approved — training assigned', denied: 'Denied', correction: 'Correction or more information needed',
                       final: 'Final approval', other: 'Other' };
const LETTER_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };
async function mailPeople() {
  /* name only: the uploader doesn't need anything else */
  const rows = await db('GET', 'cpao_staff', '?status=in.(sent_to_cpao,cpao_correction_requested,approved_training_assigned,training_complete,certs_sent_to_cpao,final_approved,queued_for_batch,countersigned)&select=id,first_name,last_name&order=last_name.asc');
  return { people: rows.map(function (r) { return { id: r.id, name: r.first_name + ' ' + r.last_name }; }), kinds: LETTER_KINDS };
}
async function mailUpload(req, me, q) {
  const s = await staffById(q.id);
  const kind = LETTER_KINDS[q.kind] ? q.kind : null;
  if (!kind) { throw bad('Pick what the letter says.'); }
  const on = str(q.date, 10);
  if (on && !R.isDate(on)) { throw bad('The letter date isn\'t a date.'); }
  const noteText = str(decodeURIComponent(String(req.headers['x-note'] || '')), 500);
  const raw = await S.readRaw(req, 4000000);
  const ext = raw.toString('ascii', 0, 5) === '%PDF-' ? 'pdf' : S.imageType(raw) === 'image/jpeg' ? 'jpg' : S.imageType(raw) === 'image/png' ? 'png' : null;
  if (!ext) { throw bad('Upload the letter as a PDF, JPG or PNG.'); }
  const key = 'mail/' + s.id + '/' + Date.now() + '.' + ext;
  await S.upload(BUCKET, key, raw, LETTER_TYPES[ext]);
  const name = s.first_name + ' ' + s.last_name;
  const entry = { at: nowIso(), by: me.name || me.email, kind: 'letter', letter: kind, file: key, due: null,
                  text: 'CPAO letter — ' + LETTER_KINDS[kind] + (on ? ' (dated ' + R.mdy(on) + ')' : '') + (noteText ? ': ' + noteText : '') };
  const p = await project('CPAO letter for ' + name + ': ' + LETTER_KINDS[kind],
    entry.text + '\n\nUploaded by ' + entry.by + '. Open their record to view the letter and move them to the next step: ' +
    site(req) + '/cpao-admin.html#staff=' + s.id, R.addBusinessDays(R.today(), 1), me, kind === 'denied' || kind === 'correction' ? 'Hot' : 'Med');
  await setStaff(s.id, { followups: (s.followups || []).concat([entry]).slice(-100) }, 'CPAO letter uploaded: ' + LETTER_KINDS[kind]);
  await audit(me.email, 'letter_upload', s.id, { kind: kind, project_id: p.id }, req);
  return { ok: true };
}

/* ── AZLearns certificates ─────────────────────────────────────────────────
   Once CPAO approves the background check, the person takes the AZLearns
   courses and uploads each completion certificate here (or an admin does it
   for them). Ticking "that's all of them" moves them to Certificates turned
   in, which gives Brian the task to send them to CPAO. */
const CERT_STATUSES = ['approved_training_assigned', 'training_complete'];
async function ownRecord(me) {
  return (await db('GET', 'cpao_staff', '?email=eq.' + encodeURIComponent(String(me.email || '').toLowerCase()) +
    '&status=not.eq.removed&select=*&order=created_at.desc&limit=1'))[0] || null;
}
async function certUpload(req, me, s, q) {
  if (CERT_STATUSES.indexOf(s.status) < 0) {
    throw bad('Certificates are uploaded once CPAO has approved the background check and assigned the AZLearns training.');
  }
  const course = str(decodeURIComponent(String(req.headers['x-course'] || '')), 120);
  const raw = await S.readRaw(req, 4000000);
  const ext = raw.toString('ascii', 0, 5) === '%PDF-' ? 'pdf' : S.imageType(raw) === 'image/jpeg' ? 'jpg' : S.imageType(raw) === 'image/png' ? 'png' : null;
  if (!ext) { throw bad('Upload the certificate as a PDF, JPG or PNG.'); }
  const key = 'certs/' + s.id + '/' + Date.now() + '.' + ext;
  await S.upload(BUCKET, key, raw, LETTER_TYPES[ext]);
  const name = s.first_name + ' ' + s.last_name;
  const entry = { at: nowIso(), by: me.name || me.email, kind: 'cert', file: key, due: null,
                  text: 'AZLearns certificate' + (course ? ': ' + course : '') };
  const fields = { followups: (s.followups || []).concat([entry]).slice(-100) };
  const done = q.done === '1' && s.status === 'approved_training_assigned';
  if (done) {
    await closeProject(s.project_id);
    const certs = fields.followups.filter(function (f) { return f.kind === 'cert'; }).length;
    const p = await project(STATUS_TASK.training_complete(name),
      name + ' finished the AZLearns training and uploaded ' + certs + ' certificate' + (certs === 1 ? '' : 's') + '. Open their record to download them and send them to CPAO: ' +
      site(req) + '/cpao-admin.html#staff=' + s.id, R.addBusinessDays(R.today(), 2), me);
    Object.assign(fields, { status: 'training_complete', project_id: p.id });
  }
  await setStaff(s.id, fields, done ? 'Certificates turned in' : 'Certificate uploaded');
  await audit(me.email, 'cert_upload', s.id, { done: done }, req);
  return { ok: true, status: fields.status || s.status };
}

/* CPAO mail uploaders (not admins) see the roster and each person's stage
   and letters — never the application, PII, invites or settings */
const STAFF_PUBLIC = ['id', 'first_name', 'last_name', 'title_position', 'status', 'stage_dates', 'last_action', 'last_action_at', 'created_at', 'updated_at'];
function limitedStaff(s) {
  const o = {};
  STAFF_PUBLIC.forEach(function (k) { o[k] = s[k]; });
  o.followups = (s.followups || []).filter(function (f) { return f.kind === 'letter'; });
  return o;
}
async function mailRoute(req, res, action, me, q, manager) {
  /* managers see stages only — not the letters */
  const view = function (s) { const o = limitedStaff(s); if (manager) { o.followups = []; } return o; };
  if (req.method === 'GET' && action === 'roster') {
    const staff = await db('GET', 'cpao_staff', '?select=*&status=not.in.(removed)&order=updated_at.desc');
    return sendJSON(res, 200, { limited: true, manager: !!manager, staff: staff.map(view), batches: [], statuses: STATUSES, titles: R.TITLE_OPTIONS, constants: R.C,
      settings: { has_signature: true, site_admin_phone: 'x', batch_weekday: 1 }, setup: {} });
  }
  if (req.method === 'GET' && action === 'detail') {
    const s = await staffById(q.id);
    await audit(me.email, 'view_status', s.id, null, req);
    return sendJSON(res, 200, { limited: true, manager: !!manager, staff: view(s), app: null, links: {} });
  }
  /* managers can also invite people to fill out the CP-101 (and re-send an
     invite) — but not add people as already having access, or as Site Admins */
  if (manager && req.method === 'GET' && action === 'directory') { return sendJSON(res, 200, await directoryList()); }
  if (manager && req.method === 'POST' && action === 'invite') {
    const b = await body(req);
    return sendJSON(res, 200, await invite(req, me, Object.assign(b, { existing: false, is_site_admin: false })));
  }
  if (manager) { return sendJSON(res, 403, { error: 'forbidden', message: 'This is a read-only view — managers can invite people, and see where everyone is.' }); }
  if (req.method === 'GET' && action === 'file') {
    if (!/^mail\//.test(str(q.key, 300))) { throw bad('Only the site administrator can open that file.', 403); }
    return sendJSON(res, 200, await fileLink(req, me, q.key));
  }
  if (req.method === 'GET' && action === 'mail_people') { return sendJSON(res, 200, await mailPeople()); }
  return sendJSON(res, 403, { error: 'forbidden', message: 'Only the site administrator can do that.' });
}

/* everyone else on the HEAplus tab: just where they are in the process */
async function selfRoute(req, res, action, me) {
  if (req.method !== 'GET' || action !== 'roster') {
    return sendJSON(res, 403, { error: 'forbidden', message: 'Only the HEAplus admins can do that.' });
  }
  const s = await ownRecord(me);
  if (s) { await audit(me.email, 'view_own_status', s.id, null, req); }
  /* a denial is told in person first (CPAO_DENIAL), so it isn't shown here */
  const mine = s ? { first_name: s.first_name, status: s.status === 'denied' ? 'on_hold' : s.status,
    stage_dates: s.status === 'denied' ? {} : (s.stage_dates || {}), created_at: s.created_at,
    certs: (s.followups || []).filter(function (f) { return f.kind === 'cert'; }).map(function (f) { return { at: f.at, text: f.text }; }) } : null;
  return sendJSON(res, 200, { self: true, mine: mine, site_admin: R.C.site_admin_name });
}

const SITE_ADMIN_ONLY = { countersign: 1, settings: 1, batch: 1, push: 1, mark_sent: 1, send_batch: 1, rotate: 1, purge: 1 };

/* the Microsoft 365 staff list for the invite picker; failures are a message, not an error page */
async function directoryList() {
  try {
    const onRoster = {};
    (await db('GET', 'cpao_staff', '?status=not.in.(removed,denied)&select=email')).forEach(function (r) { onRoster[r.email.toLowerCase()] = 1; });
    return { users: (await G.directory()).map(function (u) { return Object.assign({ on_roster: !!onRoster[u.email] }, u); }) };
  } catch (e) {
    return { users: [], error: e.code ? e.message : 'Couldn\'t reach the Microsoft directory right now.' };
  }
}

async function adminRoute(req, res, action, me, q) {
  if (req.method === 'GET') {
    if (action === 'roster') { return sendJSON(res, 200, Object.assign(await roster(me), { sa: access(me).admin })); }
    if (action === 'detail') { return sendJSON(res, 200, await detail(req, me, q.id)); }
    if (action === 'audit') {
      const where = q.id ? '?staff_id=eq.' + (UUID.test(q.id) ? q.id : '0') + '&' : '?';
      return sendJSON(res, 200, { entries: await db('GET', 'cpao_audit_log', where + 'select=*&order=at.desc&limit=200') });
    }
    if (action === 'file') { return sendJSON(res, 200, await fileLink(req, me, q.key)); }
    if (action === 'mail_people') { return sendJSON(res, 200, await mailPeople()); }
    if (action === 'directory') { return sendJSON(res, 200, await directoryList()); }
    /* the CP-101 as it stands: the countersigned file once there is one,
       before that the same PDF made on the fly (no countersignature yet) */
    if (action === 'preview_pdf') {
      const s = await staffById(q.id);
      const a = await latestApp(s.id);
      if (!a || !(a.submitted_at || a.user_signature_key || a.wet_signed_upload_key)) { throw bad('They haven\'t signed their application yet.'); }
      if (a.pdf_storage_key) { return sendJSON(res, 200, await fileLink(req, me, a.pdf_storage_key)); }
      const pdf = a.wet_signed_upload_key ? await S.download(BUCKET, a.wet_signed_upload_key)
        : await P.cp101({ answers: a.answers, sensitive: a.sensitive_ciphertext ? K.open(a.sensitive_ciphertext) : {},
          user_signature: a.user_signature_key ? await S.download(BUCKET, a.user_signature_key) : null, user_signed_at: a.user_signed_at,
          sa_signature: null, sa_signed_at: null });
      await audit(me.email, 'preview_pdf', s.id, null, req);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline; filename="CP-101-preview.pdf"');
      return res.end(Buffer.from(pdf));
    }
    if (action === 'app_pdf') {
      const a = await latestApp((await staffById(q.id)).id);
      if (!a || !a.pdf_storage_key) { throw bad('No PDF yet — countersign first.'); }
      return sendJSON(res, 200, await fileLink(req, me, a.pdf_storage_key));
    }
    throw bad('Unknown action.', 404);
  }
  const b = await body(req);
  switch (action) {
    case 'invite': return sendJSON(res, 200, await invite(req, me, b));
    case 'update': {
      const s = await staffById(b.id);
      const f = {};
      ['first_name', 'last_name', 'title_position', 'work_address', 'notes', 'heaplus_username'].forEach(function (k) {
        if (k in b) { f[k] = str(b[k], k === 'notes' ? 2000 : 200) || null; }
      });
      if ('email' in b) { if (!EMAIL.test(str(b.email, 200))) { throw bad('Check the email.'); } f.email = str(b.email, 200).toLowerCase(); }
      if ('worker_type' in b) { if (['Employee', 'Contractor', 'Volunteer'].indexOf(b.worker_type) < 0) { throw bad('Pick Employee, Contractor or Volunteer.'); } f.worker_type = b.worker_type; }
      if ('hire_date' in b) { if (b.hire_date && !R.isDate(b.hire_date)) { throw bad('Hire date must be a date.'); } f.hire_date = b.hire_date || null; }
      if ('is_site_admin' in b) { f.is_site_admin = b.is_site_admin === true; }
      if (f.first_name === null || f.last_name === null) { throw bad('Names can\'t be blank.'); }
      await setStaff(s.id, f, null);
      await audit(me.email, 'update_staff', s.id, { fields: Object.keys(f) }, req);
      return sendJSON(res, 200, { ok: true });
    }
    case 'reveal': {
      const field = ['ssn', 'date_of_birth', 'home_address'].indexOf(b.field) >= 0 ? b.field : null;
      if (!field) { throw bad('Which field?'); }
      const s = await staffById(b.id);
      const a = await latestApp(s.id);
      if (!a || !a.sensitive_ciphertext) { throw bad(a && a.purged_at ? 'This was purged under the retention rule.' : 'Nothing saved yet.'); }
      const x = K.open(a.sensitive_ciphertext);
      await audit(me.email, 'reveal_' + field, s.id, null, req);
      const v = field === 'ssn' ? R.fmtSsn(x.ssn) : field === 'date_of_birth' ? R.mdy(x.date_of_birth) : x.home_address;
      return sendJSON(res, 200, { value: v || '' });
    }
    case 'countersign': return sendJSON(res, 200, await countersign(req, me, b.id));
    case 'send_back': return sendJSON(res, 200, await sendBack(req, me, b));
    case 'status': return sendJSON(res, 200, await setStatus(req, me, b));
    case 'followup': return sendJSON(res, 200, await followup(req, me, b));
    case 'settings': return sendJSON(res, 200, await saveSettings(req, me, b));
    case 'batch': return sendJSON(res, 200, await buildBatch(req, me.email));
    case 'push': {
      const s = await staffById(b.id);
      return sendJSON(res, 200, await buildBatch(req, me.email, [s.id]));
    }
    case 'mark_sent': return sendJSON(res, 200, await markSent(req, me, b.id));
    case 'send_batch': return sendJSON(res, 200, await sendBatch(req, me, b.id));
    case 'rotate': return sendJSON(res, 200, await rotate(req, me));
    case 'purge': { const r = await purge(); await audit(me.email, 'purge_run', null, r, req); return sendJSON(res, 200, Object.assign({ ok: true }, r)); }
  }
  throw bad('Unknown action.', 404);
}

/* ═════════════════════════════════ CRON ═════════════════════════════════ */
async function cron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) { return sendJSON(res, 401, { error: 'unauthorized' }); }
  const st = await settings();
  const day = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' })).getDay();
  const out = { weekday: day, batch_weekday: st.batch_weekday };
  if (day === st.batch_weekday) {
    try { out.batch = await buildBatch(req, 'cron'); } catch (e) { out.batch_error = e.bad ? e.message : 'failed'; await audit('cron', 'batch_failed', null, { error: out.batch_error }, req); }
  }
  out.purge = await purge();
  return sendJSON(res, 200, out);
}

/* ══════════════════════════════════════════════════════════════════════ */
const STAFF_ACTIONS = { apply: 1, save: 1, print: 1, scan: 1, submit: 1 };
const NEEDS_KEY = { apply: 1, save: 1, print: 1, scan: 1, submit: 1, reveal: 1, countersign: 1, rotate: 1, preview_pdf: 1 };

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(function (k) { return !process.env[k]; });
  if (missing.length) { return sendJSON(res, 503, { error: 'not_configured', message: 'The CP-AO portal isn\'t set up: missing ' + missing.join(', ') + '.' }); }
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const action = str(q.action, 30);
  try {
    /* the scheduled call: ?action=cron, or a bare /api/cpao carrying the cron secret */
    if (action === 'cron' || (!action && process.env.CRON_SECRET && req.headers.authorization === 'Bearer ' + process.env.CRON_SECRET)) {
      return await cron(req, res);
    }
    /* only the steps that seal or open SSN / birth date / address need the key:
       the roster, staff picker, invites, settings and batches work without it */
    if (!K.configured() && NEEDS_KEY[action]) {
      throw bad('The PII key isn\'t set: add CPAO_PII_KEY in Vercel (see CPAO.md).', 503);
    }
    if (STAFF_ACTIONS[action]) { return await staffRoute(req, res, action); }
    const me = await currentUser(req);
    if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in first.' }); }
    /* letters are uploaded raw, before any JSON body is read */
    if (action === 'mail_upload' && req.method === 'POST' && access(me).cpao_mail) { return sendJSON(res, 200, await mailUpload(req, me, q)); }
    const acc = access(me);
    /* certificates: the person themself, or a HEAplus admin for someone */
    if (action === 'cert_upload' && req.method === 'POST') {
      const s = q.id && acc.cpao_admin ? await staffById(q.id) : await ownRecord(me);
      if (!s) { throw bad('You\'re not in the HEAplus process yet — ask ' + R.C.site_admin_name + '.', 404); }
      return sendJSON(res, 200, await certUpload(req, me, s, q));
    }
    if (acc.cpao_admin) {
      if (req.method === 'POST' && SITE_ADMIN_ONLY[action] && !acc.admin) {
        return sendJSON(res, 403, { error: 'forbidden', message: 'Only ' + R.C.site_admin_name + ' (the Site Administrator) can do that — it uses his signature.' });
      }
      return await adminRoute(req, res, action, me, q);
    }
    if (acc.cpao_mail) { return await mailRoute(req, res, action, me, q); }
    if (acc.cpao_manager) { return await mailRoute(req, res, action, me, q, true); }
    return await selfRoute(req, res, action, me);
  } catch (e) {
    if (e.bad) { return sendJSON(res, e.status, { error: e.kind || 'bad_request', message: e.message }); }
    if (e.code === 'no_key' || e.code === 'old_key') { return sendJSON(res, 503, { error: e.code, message: e.message }); }
    if (/23514[\s\S]*cpao_staff_status_check|(PGRST204|42703)[\s\S]*(followups|stage_dates|sign_in|invite_code_hash)/.test(e.message)) {
      return sendJSON(res, 503, { error: 'not_set_up', message: 'Run the CP-AO update in Supabase first (supabase/cpao.sql) — it adds the new stages, follow-ups and personal-email sign-in.' });
    }
    if (/(PGRST205|42P01)[\s\S]*cpao_/.test(e.message)) {
      return sendJSON(res, 503, { error: 'not_set_up', message: 'The CP-AO tables aren\'t in Supabase yet — run supabase/cpao.sql (or ALL.sql).' });
    }
    if (/Storage 4\d\d/.test(e.message) && /bucket/i.test(e.message)) {
      return sendJSON(res, 503, { error: 'not_set_up', message: 'The private "cpao" storage bucket is missing — run supabase/cpao.sql.' });
    }
    /* never echo the error text: it could hold a value */
    console.error('cpao ' + action + ' failed: ' + (e.status || '') + ' ' + String(e.message).replace(/\d{3}-?\d{2}-?\d{4}/g, '[redacted]').slice(0, 200));
    return sendJSON(res, 502, { error: 'server', message: 'Something went wrong. Try again in a moment.' });
  }
};
