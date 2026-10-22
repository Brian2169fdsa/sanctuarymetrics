/* Golden renders: fill both CP-AO forms with fake data and save PNGs of
   every page in cpao/golden/ so the alignment can be checked by eye.
   Needs pdftoppm (poppler-utils).  Run:  node tools/cpao-golden.js        */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('../lib/cpao-pdf');
const F = require('../tests/cpao-fixtures');

const OUT = path.join(__dirname, '..', 'cpao', 'golden');
(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  const cp = await P.cp101({ answers: F.answers, sensitive: F.sensitive, preview: true,
    user_signature: F.signature(), user_signed_at: '2026-10-22T17:00:00Z',
    sa_signature: F.signature(800, 110), sa_signed_at: '2026-10-23T16:00:00Z' });
  const rows = [];
  for (let i = 1; i <= 8; i++) {
    rows.push({ name: 'Jane Example' + (i > 1 ? ' ' + i : ''), work_address: '1940 E Thunderbird Rd Ste 206, Phoenix, AZ 85022',
      phone: '602-555-01' + String(i).padStart(2, '0'), email: 'jexample' + i + '@sanctuaryrecoverycenters.com',
      worker_type: i === 3 ? 'Volunteer' : 'Employee', hire_date: '03/17/2025', action: i === 7 ? 'Remove' : i === 2 ? 'Add-SA' : 'Add' });
  }
  const org = await P.orgForm(rows, { site_admin_phone: '6025550199', signature: F.signature(800, 110) });
  const files = { 'cp101': cp, 'org-form': org };
  for (const name of Object.keys(files)) {
    const pdf = path.join(OUT, name + '.pdf');
    fs.writeFileSync(pdf, files[name]);
    execFileSync('pdftoppm', ['-png', '-r', '80', pdf, path.join(OUT, name)]);
    fs.unlinkSync(pdf);
  }
  console.log(fs.readdirSync(OUT).join('\n'));
})().catch(function (e) { console.error(e); process.exit(1); });
