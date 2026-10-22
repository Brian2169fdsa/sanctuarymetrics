/* ============================================================================
   CP-101 rules: the field schema, validators (Layer A), the redacted Claude
   completeness check (Layer B) and the parsing of its answer.

   cpao/assets/cpao_field_schema.json is the contract: required fields, who
   fills them and where they print all come from there.

   Where the answers live:
     answers    (cpao_applications.answers, plain JSON) — first_name,
                middle_initial, no_middle_name, last_name, legal_name_ack,
                city, state, zip, phone, email, title_position, title_other,
                pay_status ('paid' | 'volunteer'), hire_date (YYYY-MM-DD)
     sensitive  (sealed with lib/cpao-crypto.js) — date_of_birth (YYYY-MM-DD),
                ssn (9 digits), home_address
   The sensitive three never reach Claude, logs or error messages: Layer B only
   gets booleans about them (redact()).
   ========================================================================== */

const zlib = require('zlib');
const SCHEMA = require('../cpao/assets/cpao_field_schema.json');
const { AZ_ZIPS, AZ_CITIES } = require('../cpao/az-places.js');

const C = SCHEMA.constants;
const FIELDS = SCHEMA.cp101_individual_user_application.fields;
const TITLE_OPTIONS = FIELDS.filter(function (f) { return f.key === 'title_position'; })[0].options_hint;
const SENSITIVE = FIELDS.filter(function (f) { return f.sensitive; }).map(function (f) { return f.key; });
const MODEL = process.env.CPAO_MODEL || 'claude-sonnet-5-5';
const SANCTUARY_DOMAINS = ['sanctuaryrecoverycenters.com', 'sanctuaryrc.com'];

/* the steps of the staff form and the answer keys each one owns */
const STEPS = [
  { n: 1, name: 'About you', keys: ['first_name', 'middle_initial', 'no_middle_name', 'last_name', 'legal_name_ack'] },
  { n: 2, name: 'Identity', keys: ['date_of_birth', 'ssn'] },
  { n: 3, name: 'Contact', keys: ['home_address', 'city', 'state', 'zip', 'phone', 'email'] },
  { n: 4, name: 'Role', keys: ['title_position', 'title_other', 'pay_status', 'hire_date'] },
  { n: 5, name: 'Conditions for access', keys: [] },
  { n: 6, name: 'Sign', keys: [] },
  { n: 7, name: 'Review and submit', keys: [] }
];
function stepOf(key) {
  if (key === 'conditions_ack') { return 5; }
  if (key === 'user_signature') { return 6; }
  for (const s of STEPS) { if (s.keys.indexOf(key) >= 0) { return s.n; } }
  return 7;
}

/* ── small formatters ─────────────────────────────────────────────────── */
function digits(v) { return String(v || '').replace(/\D/g, ''); }
function s(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max || 200); }
function isDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) { return false; }
  const t = new Date(d + 'T12:00:00Z');
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
}
function today(tz) { return new Date().toLocaleDateString('en-CA', { timeZone: tz || 'America/Phoenix' }); }
function ageOn(dob, on) {
  const a = dob.split('-').map(Number), b = on.split('-').map(Number);
  return b[0] - a[0] - ((b[1] < a[1] || (b[1] === a[1] && b[2] < a[2])) ? 1 : 0);
}
function mdy(d) { return isDate(d) ? d.slice(5, 7) + '/' + d.slice(8, 10) + '/' + d.slice(0, 4) : ''; }
function fmtSsn(v) { const d = digits(v); return d.length === 9 ? d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5) : ''; }
function maskSsn(v) { const d = digits(v); return d.length === 9 ? '•••-••-' + d.slice(5) : ''; }
function fmtPhone(v) {
  let d = digits(v);
  if (d.length === 11 && d[0] === '1') { d = d.slice(1); }
  return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : '';
}
function titleOf(a) { return a.title_position === 'Other' ? s(a.title_other, 80) : s(a.title_position, 80); }
function fullName(a) { return (s(a.first_name, 40) + ' ' + s(a.last_name, 40)).trim(); }

/* ── Layer A: deterministic rules ─────────────────────────────────────── */
/* SSA rules: area not 000, 666 or 900-999; group not 00; serial not 0000 */
function ssnProblem(v) {
  const d = digits(v);
  if (d.length !== 9) { return 'Enter all 9 digits of your Social Security Number.'; }
  const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5);
  if (area === '000' || area === '666' || area[0] === '9') { return 'That Social Security Number isn\'t valid — check the first three digits.'; }
  if (group === '00') { return 'That Social Security Number isn\'t valid — check the middle two digits.'; }
  if (serial === '0000') { return 'That Social Security Number isn\'t valid — check the last four digits.'; }
  return '';
}
function dobProblem(v, on) {
  if (!isDate(v)) { return 'Enter your date of birth.'; }
  const age = ageOn(v, on || today());
  if (age < 18) { return 'You must be 18 or older to get HEAplus access.'; }
  if (age > 110) { return 'Check the year of your date of birth.'; }
  return '';
}
const NAME = /^[A-Za-z][A-Za-z .'’-]{0,39}$/;
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[A-Za-z]{2,}$/;
/* Arizona cities, compared loosely: case, dots, dashes and "Saint"/"St" don't matter */
function cityKey(c) { return String(c || '').toLowerCase().replace(/\bsaint\b/g, 'st').replace(/[.'’]/g, '').replace(/[-\s]+/g, ' ').trim(); }
const AZ_CITY_KEYS = new Set(AZ_CITIES.map(cityKey));
function isAz(a) { return s(a.state).toUpperCase() === 'AZ'; }

/* problems in the fields one step owns: {field: message}. Only the keys
   given are checked, so a half-finished form can still be saved per step. */
function checkFields(keys, a, x, on) {
  a = a || {}; x = x || {};
  const e = {};
  const need = function (k, msg) { if (!s(k in x ? x[k] : a[k])) { e[k] = msg; return false; } return true; };
  keys.forEach(function (k) {
    switch (k) {
      case 'first_name': if (need(k, 'Enter your legal first name.') && !NAME.test(s(a[k], 60))) { e[k] = 'Use letters only, as on your driver\'s license.'; } break;
      case 'last_name': if (need(k, 'Enter your legal last name.') && !NAME.test(s(a[k], 60))) { e[k] = 'Use letters only, as on your driver\'s license.'; } break;
      case 'middle_initial':
        if (a.no_middle_name === true) { break; }
        if (!s(a[k])) { e[k] = 'Enter your middle initial, or tick "No middle name".'; }
        else if (!/^[A-Za-z]$/.test(s(a[k]))) { e[k] = 'Just one letter.'; }
        break;
      case 'legal_name_ack': if (a[k] !== true) { e[k] = 'Confirm your name matches your driver\'s license.'; } break;
      case 'date_of_birth': { const p = dobProblem(x[k], on); if (p) { e[k] = p; } break; }
      case 'ssn': { const p = ssnProblem(x[k]); if (p) { e[k] = p; } break; }
      case 'home_address': if (need(k, 'Enter your home address.') && s(x[k], 300).length < 5) { e[k] = 'Enter the full street address.'; } break;
      case 'city':
        if (!need(k, 'Enter your city.')) { break; }
        if (!/^[A-Za-z .'’-]{2,40}$/.test(s(a[k]))) { e[k] = 'Check the city name.'; break; }
        if (isAz(a) && !AZ_CITY_KEYS.has(cityKey(a[k]))) {
          const zc = AZ_ZIPS[s(a.zip)];
          e[k] = 'We don\'t know "' + s(a[k], 40) + '" as an Arizona city — check the spelling' + (zc ? ' (ZIP ' + s(a.zip) + ' is ' + zc + ')' : '') + ', or pick it from the list.';
        }
        break;
      case 'state': if (!/^[A-Z]{2}$/.test(s(a[k]).toUpperCase())) { e[k] = 'Use the 2-letter state, like AZ.'; } break;
      case 'zip':
        if (!/^\d{5}$/.test(s(a[k]))) { e[k] = 'Enter a 5-digit ZIP code.'; }
        else if (isAz(a) && !AZ_ZIPS[s(a[k])]) { e[k] = 'That isn\'t an Arizona ZIP code — check it.'; }
        break;
      case 'phone': if (!fmtPhone(a[k])) { e[k] = 'Enter a 10-digit phone number.'; } break;
      case 'email': if (!EMAIL.test(s(a[k]))) { e[k] = 'Enter a valid email address.'; } break;
      case 'title_position':
        if (!s(a[k])) { e[k] = 'Pick your title.'; }
        else if (TITLE_OPTIONS.indexOf(a[k]) < 0) { e[k] = 'Pick your title from the list.'; }
        break;
      case 'title_other': if (a.title_position === 'Other' && !s(a[k])) { e[k] = 'Type your title.'; } break;
      case 'pay_status': if (a[k] !== 'paid' && a[k] !== 'volunteer') { e[k] = 'Pick paid employee or volunteer.'; } break;
      case 'hire_date': if (!isDate(a[k])) { e[k] = 'Enter your hire date.'; } else if (a[k] > today()) { e[k] = 'Your hire date can\'t be in the future.'; } break;
    }
  });
  return e;
}
function checkStep(n, a, x, on) {
  const step = STEPS.filter(function (t) { return t.n === n; })[0];
  return step ? checkFields(step.keys, a, x, on) : {};
}

/* Layer A for a whole application. app: {answers, sensitive, conditions_agreed,
   signature (PNG Buffer) | wet_signed (true when the scan is uploaded)} */
function layerA(app, on) {
  const keys = [].concat.apply([], STEPS.map(function (t) { return t.keys; }));
  const e = checkFields(keys, app.answers, app.sensitive, on);
  if (!app.conditions_agreed) { e.conditions_ack = 'Read and agree to the Conditions for Access.'; }
  if (app.wet_signed !== true) {
    const ink = app.signature ? inkPixels(app.signature) : 0;
    if (ink < 80) { e.user_signature = 'Sign in the box — the signature looks blank.'; }
  }
  return Object.keys(e).map(function (k) { return { field: k, step: stepOf(k), message_for_staff: e[k], severity: 'block' }; });
}

/* ── signature PNGs: count the pixels that aren't transparent ─────────────
   signature_pad gives an 8-bit RGBA PNG; anything else counts as blank so
   the staff member is asked to sign again. */
function inkPixels(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.readUInt32BE(0) !== 0x89504e47) { return 0; }
    let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
    const idat = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
      else if (kind === 'IDAT') { idat.push(data); }
      else if (kind === 'IEND') { break; }
      off += 12 + len;
    }
    if (depth !== 8 || type !== 6 || interlace || !w || !h || w * h > 4e6) { return 0; }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = 4, stride = w * bpp;
    let prev = Buffer.alloc(stride), count = 0, p = 0;
    for (let y = 0; y < h; y++) {
      const filter = raw[p++];
      const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? line[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (filter === 1) { v += left; }
        else if (filter === 2) { v += up; }
        else if (filter === 3) { v += (left + up) >> 1; }
        else if (filter === 4) {
          const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
          v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        }
        line[i] = v & 255;
      }
      for (let i = 3; i < stride; i += 4) { if (line[i] > 32) { count++; } }
      prev = line;
    }
    return count;
  } catch (e) { return 0; }
}

/* ── Layer B: Claude, on a redacted payload ───────────────────────────── */
/* everything Claude sees. No DOB, SSN, street address, phone or full email. */
function redact(app, on) {
  const a = app.answers || {}, x = app.sensitive || {};
  const email = s(a.email).toLowerCase();
  const d = on || today();
  return {
    today: d,
    first_name: s(a.first_name, 40), middle_initial: s(a.middle_initial, 1), no_middle_name: a.no_middle_name === true,
    last_name: s(a.last_name, 40), legal_name_confirmed: a.legal_name_ack === true,
    title_position: titleOf(a), title_from_list: a.title_position !== 'Other',
    city: s(a.city, 40), state: s(a.state, 2).toUpperCase(), zip: s(a.zip, 5),
    email_domain: email.indexOf('@') > 0 ? email.split('@').pop() : '',
    pay_status: a.pay_status === 'volunteer' ? 'volunteer' : a.pay_status === 'paid' ? 'paid employee' : '',
    hire_date: isDate(a.hire_date) ? a.hire_date : '',
    ssn_present_and_valid: !ssnProblem(x.ssn),
    dob_present_and_valid: !dobProblem(x.date_of_birth, d),
    home_address_present: s(x.home_address).length >= 5,
    phone_present_and_valid: !!fmtPhone(a.phone)
  };
}

const AI_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'issues', 'admin_notes'],
  properties: {
    status: { type: 'string', enum: ['pass', 'fix_required', 'admin_review'] },
    issues: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['field', 'message_for_staff', 'severity'],
      properties: { field: { type: 'string' }, message_for_staff: { type: 'string' }, severity: { type: 'string', enum: ['block', 'warn'] } } } },
    admin_notes: { type: 'string' }
  }
};
const AI_SYSTEM = [
  'You check AHCCCS CP-101 Individual User Applications (HEAplus access) for completeness before the CP-AO Site Administrator at ' +
    C.dba + ' countersigns them. You get a redacted summary: sensitive fields are replaced by true/false flags.',
  '',
  'Past reasons CPAO rejected or returned forms:',
  '1. Missing AHCCCS-registered-provider checkbox (the site fills this — not the staff member\'s problem).',
  '2. Missing website URL (also filled by the site).',
  '3. Name does not match the driver\'s license, or is a nickname.',
  '4. Form cut off or photographed instead of a full PDF.',
  '5. Date of birth entered wrong.',
  '6. Incomplete fields.',
  '',
  'Check for:',
  '- A first name that looks like a nickname (Bob, Mike, Jen, Tony, Kathy, Chris…): severity "warn", ask them to confirm it is the legal name on their license.',
  '- Odd name casing (all caps, all lowercase) or obvious typos.',
  '- Do NOT comment on the city, state or ZIP: they were already checked against the list of Arizona ZIP codes and cities, and a city that differs from the ZIP\'s main post-office name (Anthem, San Tan Valley, Sun City…) is fine.',
  '- An email domain that isn\'t sanctuaryrecoverycenters.com: at most "warn" (never "block") — it is for the site administrator, not the staff member. If the domain is sanctuaryrecoverycenters.com, say nothing about the email.',
  '- A vague title.',
  '- A hire date in the future or more than 30 years before today.',
  '- A blank middle initial without no_middle_name.',
  '- Any *_present_and_valid flag that is false: "block".',
  '',
  'status: "fix_required" if anything is "block"; "admin_review" if only warnings the site administrator should look at; "pass" if clean.',
  'message_for_staff: one plain, friendly sentence the staff member can act on. Never ask for or mention SSN digits or date-of-birth values.',
  'field: the form field key (first_name, middle_initial, last_name, city, state, zip, email, title_position, hire_date, pay_status, ssn, date_of_birth, home_address, phone).',
  'admin_notes: one or two sentences for the site administrator.'
].join('\n');

/* Claude's text → a safe result. Anything malformed → admin_review. */
function parseAi(text) {
  const fallback = function (why) {
    return { status: 'admin_review', issues: [], admin_notes: 'The automatic check didn\'t return a usable answer (' + why + ') — please review this one by hand.', malformed: true };
  };
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return fallback('not JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) { return fallback('not an object'); }
  if (['pass', 'fix_required', 'admin_review'].indexOf(j.status) < 0) { return fallback('unknown status'); }
  if (!Array.isArray(j.issues)) { return fallback('no issue list'); }
  const issues = j.issues.slice(0, 20).map(function (i) {
    return i && typeof i === 'object' ? {
      field: s(i.field, 40), step: stepOf(s(i.field, 40)), message_for_staff: s(i.message_for_staff, 400),
      severity: i.severity === 'block' ? 'block' : 'warn'
    } : null;
  }).filter(function (i) {
    /* city, state and ZIP are checked against the Arizona list in Layer A, so
       Claude's guesses about spelling don't count; email is only ever advice */
    return i && i.message_for_staff && ['city', 'state', 'zip'].indexOf(i.field) < 0;
  }).map(function (i) { if (i.field === 'email') { i.severity = 'warn'; } return i; });
  let status = j.status;
  /* a blocking issue always means a fix, whatever the status said */
  if (issues.some(function (i) { return i.severity === 'block'; })) { status = 'fix_required'; }
  if (status === 'fix_required' && !issues.some(function (i) { return i.severity === 'block'; })) { status = 'admin_review'; }
  return { status: status, issues: issues, admin_notes: s(j.admin_notes, 1000) };
}

/* Run Layer B. Never throws: no key, an API error or a refusal all become
   admin_review so Brian looks at it. Returns {result, request, model}. */
async function layerB(app, on, client) {
  const payload = redact(app, on);
  const request = { model: MODEL, payload: payload };
  if (!client && !process.env.ANTHROPIC_API_KEY) {
    return { result: { status: 'admin_review', issues: [], admin_notes: 'The automatic check is off (no ANTHROPIC_API_KEY) — please review by hand.' }, request: request };
  }
  try {
    if (!client) { const Anthropic = require('@anthropic-ai/sdk'); client = new Anthropic(); }
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: 'Application summary (redacted):\n' + JSON.stringify(payload, null, 1) }]
    });
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      return { result: Object.assign(parseAi(null), { admin_notes: 'The automatic check stopped early (' + response.stop_reason + ') — please review by hand.' }), request: request, model: response.model };
    }
    const text = response.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    return { result: parseAi(text), request: request, response: text.slice(0, 4000), model: response.model };
  } catch (e) {
    return { result: { status: 'admin_review', issues: [], admin_notes: 'The automatic check couldn\'t run (' + (e.status || 'error') + ') — please review by hand.' }, request: request };
  }
}

/* the whole check: Layer A blocks first; then Claude */
async function checkApplication(app, on, client) {
  const a = layerA(app, on);
  if (a.length) {
    return { result: { status: 'fix_required', issues: a, admin_notes: 'Missing or invalid fields.', layer: 'A' } };
  }
  const b = await layerB(app, on, client);
  b.result.layer = 'B';
  return b;
}

/* business days ahead (Mon–Fri), as YYYY-MM-DD */
function addBusinessDays(from, n) {
  const d = new Date(from + 'T12:00:00Z');
  while (n > 0) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) { n--; } }
  return d.toISOString().slice(0, 10);
}
function addDays(from, n) {
  const d = new Date(from + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

module.exports = {
  SCHEMA: SCHEMA, C: C, FIELDS: FIELDS, STEPS: STEPS, TITLE_OPTIONS: TITLE_OPTIONS, SENSITIVE: SENSITIVE, MODEL: MODEL,
  SANCTUARY_DOMAINS: SANCTUARY_DOMAINS, cityKey: cityKey, AI_SCHEMA: AI_SCHEMA, AI_SYSTEM: AI_SYSTEM,
  digits: digits, isDate: isDate, today: today, mdy: mdy, fmtSsn: fmtSsn, maskSsn: maskSsn, fmtPhone: fmtPhone,
  titleOf: titleOf, fullName: fullName, stepOf: stepOf,
  ssnProblem: ssnProblem, dobProblem: dobProblem, checkFields: checkFields, checkStep: checkStep, layerA: layerA,
  inkPixels: inkPixels, redact: redact, parseAi: parseAi, layerB: layerB, checkApplication: checkApplication,
  addBusinessDays: addBusinessDays, addDays: addDays
};
