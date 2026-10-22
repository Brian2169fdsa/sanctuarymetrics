/* ============================================================================
   CP-AO PDFs with pdf-lib. Coordinates come from cpao_field_schema.json
   (PDF points, origin bottom-left, y = text baseline).

     cp101(data)        the 4-page CP-101 with the staff member's answers,
                        both signatures and dates drawn on the blank form
     orgForm(rows, opt) the fillable Organization User Application: header,
                        6 people per copy (more → extra copies, merged), the
                        site admin's signature in the Signature box, flattened
     merge(list)        one PDF from several (the weekly bundle)
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const R = require('./cpao');

const ASSETS = path.join(__dirname, '..', 'cpao', 'assets');
const ORG = R.SCHEMA.org_user_application;
const INK = rgb(0, 0, 0);
let blanks = null;
function blank(name) {
  blanks = blanks || {};
  if (!blanks[name]) { blanks[name] = fs.readFileSync(path.join(ASSETS, name)); }
  return blanks[name];
}

/* draw text, shrinking it until it fits max width (never below 5pt) */
function text(page, font, value, x, y, size, maxWidth) {
  const v = String(value || '');
  if (!v) { return; }
  let sz = size;
  while (maxWidth && sz > 5 && font.widthOfTextAtSize(v, sz) > maxWidth) { sz -= 0.25; }
  page.drawText(v, { x: x, y: y, size: sz, font: font, color: INK });
}
/* a PNG scaled into a box, keeping its shape, sitting on the box's bottom-left */
async function image(doc, page, png, box) {
  if (!png) { return; }
  const img = await doc.embedPng(png);
  const scale = Math.min(box.w / img.width, box.h / img.height);
  page.drawImage(img, { x: box.x, y: box.y, width: img.width * scale, height: img.height * scale });
}
function signedDate(iso) {
  if (!iso) { return ''; }
  return R.mdy(new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }));
}

/* the value printed for a CP-101 field */
function cp101Value(f, d) {
  const a = d.answers || {}, x = d.sensitive || {};
  switch (f.key) {
    case 'middle_initial': return a.no_middle_name ? 'N/A' : String(a.middle_initial || '').toUpperCase();
    case 'date_of_birth': return R.mdy(x.date_of_birth);
    case 'ssn': return R.fmtSsn(x.ssn) || (d.preview ? String(x.ssn || '') : '');
    case 'home_address': return x.home_address;
    case 'city_state': return [a.city, String(a.state || '').toUpperCase()].filter(Boolean).join(', ');
    case 'phone': return R.fmtPhone(a.phone);
    case 'title_position': return R.titleOf(a);
    case 'user_sign_date': return signedDate(d.user_signed_at);
    case 'user_printed_name': return R.fullName(a);
    case 'sa_sign_date': return signedDate(d.sa_signed_at);
    case 'sa_printed_name': return R.C.site_admin_name;
  }
  if (f.filled_by === 'system') { return R.C[f.key]; }
  return a[f.key];
}

/* d: {answers, sensitive, user_signature (PNG), user_signed_at,
       sa_signature (PNG), sa_signed_at} → Uint8Array */
async function cp101(d) {
  const doc = await PDFDocument.load(blank('IndividualUserApplicationForm.pdf'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const f of R.FIELDS) {
    if (!f.page) { continue; }
    const page = pages[f.page - 1];
    if (f.type === 'checkbox') {
      const yes = cp101Value(f, d) === true;
      const m = yes ? f.yes_mark : f.no_mark;
      text(page, font, f.mark || 'X', m.x, m.y, f.size || 11);
    } else if (f.type === 'radio') {
      const m = f.options[(d.answers || {})[f.key]];
      if (m) { text(page, font, f.mark || 'X', m.x, m.y, f.size || 11); }
    } else if (f.type === 'signature_image') {
      await image(doc, page, f.key === 'user_signature' ? d.user_signature : d.sa_signature, f.box);
    } else {
      text(page, font, cp101Value(f, d), f.x, f.y, f.size || 10, f.max_width_pt);
    }
  }
  doc.setTitle('CP-101 Individual User Application');
  doc.setProducer(R.C.dba);
  return doc.save();
}
function cp101FileName(answers, on) {
  const clean = function (v) { return String(v || '').replace(/[^A-Za-z0-9-]+/g, ''); };
  return 'CP-101_' + clean(answers.last_name) + '_' + clean(answers.first_name) + '_' + (on || R.today()) + '.pdf';
}

/* one Org form row from a staff record (+ answers if they applied) */
function orgRow(staff, answers, action) {
  const a = answers || {};
  const wt = staff.worker_type || (a.pay_status === 'volunteer' ? 'Volunteer' : 'Employee');
  return {
    name: R.fullName({ first_name: a.first_name || staff.first_name, last_name: a.last_name || staff.last_name }),
    work_address: staff.work_address || R.C.default_work_address,
    phone: R.fmtPhone(staff.work_phone || a.phone),
    email: a.email || staff.email,
    worker_type: wt,
    hire_date: R.mdy(staff.hire_date || a.hire_date),
    action: action
  };
}

/* fill one copy (≤ 6 rows) */
async function orgCopy(rows, opt) {
  const doc = await PDFDocument.load(blank('OrganizationUserApplicationForm.pdf'));
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  /* header boxes print at 11pt; row boxes auto-size so long emails fit */
  const set = function (name, value, size) {
    const f = form.getTextField(name);
    f.setText(String(value || ''));
    f.setFontSize(size || 0);
  };
  ORG.header_fields.forEach(function (h) {
    const from = h.value_from || '';
    set(h.pdf_field, h.value !== undefined ? h.value
      : from === 'settings.site_admin_phone' ? R.fmtPhone(opt.site_admin_phone) || opt.site_admin_phone || ''
      : R.C[from.replace('constants.', '')], 11);
  });
  const map = { 'Legal First and Last NameRow': 'name', 'Work AddressRow': 'work_address', 'Phone NumberRow': 'phone',
                'EmailRow': 'email', 'Employee Contractor or VolunteerRow': 'worker_type', 'Hire DateRow': 'hire_date', 'Add or RemoveRow': 'action' };
  rows.forEach(function (r, i) {
    ORG.row_fields_template.forEach(function (t) {
      const base = t.pdf_field.replace('{n}', '');
      set(t.pdf_field.replace('{n}', String(i + 1)), r[map[base]]);
    });
  });
  set('Printed Legal Name', R.C.site_admin_name, 11);
  form.getTextField('Signature').setText('');
  form.updateFieldAppearances(font);
  form.flatten();
  const sig = ORG.signature_fields.filter(function (f) { return f.pdf_field === 'Signature'; })[0];
  const rect = sig.rect;
  await image(doc, doc.getPages()[sig.page - 1], opt.signature, { x: rect[0] + 4, y: rect[1] + 1, w: rect[2] - rect[0] - 8, h: rect[3] - rect[1] - 2 });
  return doc;
}
/* rows → Uint8Array; 6 rows per copy, copies merged in order */
async function orgForm(rows, opt) {
  opt = opt || {};
  const per = ORG.rows_per_form;
  const chunks = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += per) { chunks.push(rows.slice(i, i + per)); }
  const out = await PDFDocument.create();
  for (const c of chunks) {
    const copy = await orgCopy(c, opt);
    (await out.copyPages(copy, copy.getPageIndices())).forEach(function (p) { out.addPage(p); });
  }
  out.setTitle('Organization User Application');
  out.setProducer(R.C.dba);
  return out.save();
}

async function merge(list) {
  const out = await PDFDocument.create();
  for (const bytes of list) {
    const d = await PDFDocument.load(bytes);
    (await out.copyPages(d, d.getPageIndices())).forEach(function (p) { out.addPage(p); });
  }
  return out.save();
}
async function pageCount(bytes) { return (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount(); }

/* a pre-filled CP-101 with no signatures, for CPAO_REQUIRE_WET_SIGNATURE */
async function cp101ToPrint(d) {
  return cp101(Object.assign({}, d, { user_signature: null, user_signed_at: null, sa_signature: null, sa_signed_at: null }));
}

module.exports = { cp101: cp101, cp101ToPrint: cp101ToPrint, cp101FileName: cp101FileName, orgRow: orgRow, orgForm: orgForm,
                   merge: merge, pageCount: pageCount };
