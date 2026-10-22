/* node --test tests/  — CP-AO validators, SSN rules, AI parsing, PDFs */
const test = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const R = require('../lib/cpao');
const P = require('../lib/cpao-pdf');
const F = require('../tests/cpao-fixtures');
const crypto = require('crypto');

test('SSN rules', function () {
  assert.strictEqual(R.ssnProblem('123-45-6789'), '');
  assert.strictEqual(R.ssnProblem('123456789'), '');
  ['000-12-3456', '666-12-3456', '900-12-3456', '999-12-3456'].forEach(function (s) { assert.match(R.ssnProblem(s), /first three/); });
  assert.match(R.ssnProblem('123-00-4567'), /middle two/);
  assert.match(R.ssnProblem('123-45-0000'), /last four/);
  assert.match(R.ssnProblem('12345678'), /all 9/);
  assert.match(R.ssnProblem(''), /all 9/);
  assert.strictEqual(R.maskSsn('123456789'), '•••-••-6789');
  assert.strictEqual(R.fmtSsn('123456789'), '123-45-6789');
});

test('date of birth: 18 or older, real date', function () {
  assert.strictEqual(R.dobProblem('2008-10-22', '2026-10-22'), '');
  assert.match(R.dobProblem('2008-10-23', '2026-10-22'), /18 or older/);
  assert.match(R.dobProblem('1900-01-01', '2026-10-22'), /year/);
  assert.match(R.dobProblem('1990-02-30', '2026-10-22'), /Enter/);
  assert.match(R.dobProblem('', '2026-10-22'), /Enter/);
});

test('field validators', function () {
  const a = Object.assign({}, F.answers);
  assert.deepStrictEqual(R.checkFields(['first_name', 'last_name', 'zip', 'phone', 'email', 'state', 'city', 'title_position', 'pay_status', 'hire_date'], a, {}, '2026-10-22'), {});
  const bad = R.checkFields(['zip', 'phone', 'email', 'state', 'first_name'],
    { zip: '8502', phone: '555-0100', email: 'jane@', state: 'Arizona', first_name: 'J4ne' }, {}, '2026-10-22');
  assert.deepStrictEqual(Object.keys(bad).sort(), ['email', 'first_name', 'phone', 'state', 'zip']);
  assert.strictEqual(R.fmtPhone('(602) 555-0100'), '602-555-0100');
  assert.strictEqual(R.fmtPhone('1 602 555 0100'), '602-555-0100');
  /* middle initial: blank needs the box ticked */
  assert.ok(R.checkFields(['middle_initial'], { middle_initial: '' }, {}).middle_initial);
  assert.deepStrictEqual(R.checkFields(['middle_initial'], { middle_initial: '', no_middle_name: true }, {}), {});
  assert.ok(R.checkFields(['middle_initial'], { middle_initial: 'QR' }, {}).middle_initial);
  /* title must be from the schema list, Other needs text */
  assert.ok(R.checkFields(['title_position'], { title_position: 'Boss' }, {}).title_position);
  assert.ok(R.checkFields(['title_other'], { title_position: 'Other', title_other: '' }, {}).title_other);
  assert.ok(R.checkFields(['hire_date'], { hire_date: '2099-01-01' }, {}).hire_date);
});

test('Layer A: complete application passes; blank signature and missing consent block', function () {
  const ok = { answers: F.answers, sensitive: F.validSensitive, conditions_agreed: true, signature: F.signature() };
  assert.deepStrictEqual(R.layerA(ok, '2026-10-22'), []);
  const fields = R.layerA(Object.assign({}, ok, { signature: F.blankSignature(), conditions_agreed: false }), '2026-10-22')
    .map(function (i) { return i.field; }).sort();
  assert.deepStrictEqual(fields, ['conditions_ack', 'user_signature']);
  const wet = R.layerA(Object.assign({}, ok, { signature: null, wet_signed: true }), '2026-10-22');
  assert.deepStrictEqual(wet, []);
  assert.ok(R.inkPixels(F.signature()) > 500);
  assert.strictEqual(R.inkPixels(F.blankSignature()), 0);
  assert.strictEqual(R.inkPixels(Buffer.from('not a png')), 0);
});

test('Layer B payload never carries SSN, DOB, address or phone', function () {
  const p = R.redact({ answers: F.answers, sensitive: F.validSensitive }, '2026-10-22');
  const json = JSON.stringify(p);
  ['123456789', '6789', '1990', '123 Example', '555-0100', 'jexample'].forEach(function (bit) { assert.ok(json.indexOf(bit) < 0, bit + ' leaked'); });
  assert.strictEqual(p.ssn_present_and_valid, true);
  assert.strictEqual(p.dob_present_and_valid, true);
  assert.strictEqual(p.email_domain, 'sanctuaryrecoverycenters.com');
});

test('AI answer parsing falls back to admin_review', function () {
  assert.strictEqual(R.parseAi('nope').status, 'admin_review');
  assert.strictEqual(R.parseAi('[]').status, 'admin_review');
  assert.strictEqual(R.parseAi('{"status":"great","issues":[]}').status, 'admin_review');
  assert.strictEqual(R.parseAi('{"status":"pass"}').status, 'admin_review');
  assert.strictEqual(R.parseAi(null).status, 'admin_review');
  const pass = R.parseAi('{"status":"pass","issues":[],"admin_notes":"Clean."}');
  assert.deepStrictEqual([pass.status, pass.admin_notes], ['pass', 'Clean.']);
  /* a block forces fix_required; fix_required with only warnings becomes admin_review */
  assert.strictEqual(R.parseAi('{"status":"pass","issues":[{"field":"last_name","message_for_staff":"Check your last name","severity":"block"}],"admin_notes":""}').status, 'fix_required');
  const w = R.parseAi('{"status":"fix_required","issues":[{"field":"first_name","message_for_staff":"Is Bob your legal name?","severity":"warn"}],"admin_notes":""}');
  assert.strictEqual(w.status, 'admin_review');
  assert.strictEqual(w.issues[0].step, 1);
});

test('Layer B with a mock client, and its failures', async function () {
  const app = { answers: F.answers, sensitive: F.validSensitive, conditions_agreed: true, signature: F.signature() };
  let sent = null;
  const client = { beta: { messages: { create: async function (req) { sent = req;
    return { stop_reason: 'end_turn', model: req.model, content: [{ type: 'text', text: '{"status":"pass","issues":[],"admin_notes":"ok"}' }] }; } } } };
  const r = await R.checkApplication(app, '2026-10-22', client);
  assert.strictEqual(r.result.status, 'pass');
  assert.strictEqual(sent.model, R.MODEL);
  assert.ok(JSON.stringify(sent.messages).indexOf('123456789') < 0);
  const boom = { beta: { messages: { create: async function () { const e = new Error('x'); e.status = 529; throw e; } } } };
  assert.strictEqual((await R.checkApplication(app, '2026-10-22', boom)).result.status, 'admin_review');
  const refuse = { beta: { messages: { create: async function () { return { stop_reason: 'refusal', content: [] }; } } } };
  assert.strictEqual((await R.checkApplication(app, '2026-10-22', refuse)).result.status, 'admin_review');
  /* Layer A failures never reach Claude */
  sent = null;
  const a = await R.checkApplication(Object.assign({}, app, { conditions_agreed: false }), '2026-10-22', client);
  assert.strictEqual(a.result.status, 'fix_required');
  assert.strictEqual(sent, null);
});

test('business days', function () {
  assert.strictEqual(R.addBusinessDays('2026-10-22', 2), '2026-10-26');   /* Thu → Mon */
  assert.strictEqual(R.addBusinessDays('2026-10-19', 2), '2026-10-21');
  assert.strictEqual(R.addDays('2026-10-22', 14), '2026-11-05');
});

test('CP-101 PDF: 4 pages, file name', async function () {
  const bytes = await P.cp101({ answers: F.answers, sensitive: F.validSensitive, user_signature: F.signature(), user_signed_at: '2026-10-22T17:00:00Z' });
  assert.strictEqual(await P.pageCount(bytes), 4);
  assert.strictEqual(P.cp101FileName(F.answers, '2026-10-22'), 'CP-101_Example_Jane_2026-10-22.pdf');
});

test('Org form: 6 rows per copy, overflow makes more copies, flattened', async function () {
  const row = function (i) { return { name: 'Person ' + i, work_address: 'x', phone: '602-555-0100', email: 'p@x.com', worker_type: 'Employee', hire_date: '01/01/2025', action: 'Add' }; };
  const list = function (n) { return Array.from({ length: n }, function (_, i) { return row(i + 1); }); };
  assert.strictEqual(await P.pageCount(await P.orgForm(list(6), { signature: F.signature() })), 3);
  assert.strictEqual(await P.pageCount(await P.orgForm(list(7), { signature: F.signature() })), 6);
  assert.strictEqual(await P.pageCount(await P.orgForm(list(13), {})), 9);
  const doc = await PDFDocument.load(await P.orgForm(list(2), {}));
  assert.strictEqual(doc.getForm().getFields().length, 0);
  const r = P.orgRow({ first_name: 'Jane', last_name: 'Example', hire_date: '2025-03-17', worker_type: null, work_address: null },
    { pay_status: 'volunteer', phone: '6025550100', email: 'j@x.com' }, 'Add');
  assert.deepStrictEqual([r.worker_type, r.hire_date, r.phone, r.work_address], ['Volunteer', '03/17/2025', '602-555-0100', R.C.default_work_address]);
});

test('PII sealing round-trips and spots the old key', function () {
  const K = require('../lib/cpao-crypto');
  process.env.CPAO_PII_KEY = crypto.randomBytes(32).toString('base64');
  delete process.env.CPAO_PII_KEY_OLD;
  const sealed = K.seal(F.validSensitive);
  assert.ok(sealed.indexOf('123456789') < 0);
  assert.deepStrictEqual(K.open(sealed), F.validSensitive);
  assert.strictEqual(K.stale(sealed), false);
  const tampered = sealed.slice(0, -4) + (sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(function () { K.open(tampered); });
  process.env.CPAO_PII_KEY_OLD = process.env.CPAO_PII_KEY;
  process.env.CPAO_PII_KEY = crypto.randomBytes(32).toString('hex');
  assert.strictEqual(K.stale(sealed), true);
  assert.deepStrictEqual(K.open(sealed), F.validSensitive);
  delete process.env.CPAO_PII_KEY_OLD;
  assert.throws(function () { K.open(sealed); }, /no longer configured/);
  assert.strictEqual(K.hashToken('abc').length, 64);
});

test('Arizona city and ZIP come from the list, not the AI', function () {
  const chk = function (city, zip, state) { return R.checkFields(['city', 'zip'], { city: city, zip: zip, state: state || 'AZ' }, {}); };
  assert.deepStrictEqual(chk('Peoria', '85383'), {});
  assert.deepStrictEqual(chk('peoria', '85345'), {});
  assert.deepStrictEqual(chk('Anthem', '85086'), {});           /* not the ZIP's post office, still a real place */
  assert.deepStrictEqual(chk('San Tan Valley', '85143'), {});
  assert.deepStrictEqual(chk('Saint Johns', '85936'), {});
  assert.match(chk('Peroia', '85383').city, /ZIP 85383 is Peoria/);
  assert.match(chk('Pheonix', '85020').city, /Phoenix/);
  assert.match(chk('Phoenix', '90210').zip, /Arizona ZIP/);
  assert.deepStrictEqual(chk('Austin', '78701', 'TX'), {});     /* only Arizona addresses are checked against the list */
  /* the AI can't block on city/ZIP, and an email note is only ever a warning */
  const r = R.parseAi('{"status":"fix_required","issues":[{"field":"city","message_for_staff":"City looks misspelled","severity":"block"},' +
    '{"field":"email","message_for_staff":"Use your work email","severity":"block"}],"admin_notes":""}');
  assert.strictEqual(r.status, 'admin_review');
  assert.deepStrictEqual(r.issues.map(function (i) { return i.field + ':' + i.severity; }), ['email:warn']);
});
