/* Fake data for the CP-AO tests and golden renders. Nothing here is a real
   person: Jane Example, SSN 000-00-0000 (which the validators reject on
   purpose — the renders bypass them). */
const zlib = require('zlib');

/* an 8-bit RGBA PNG, transparent, with a scribble drawn by ink(x, y) */
function png(w, h, ink) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      if (ink && ink(x, y)) { row.writeUInt32BE(0x14285aff, 1 + x * 4); }
    }
    rows.push(row);
  }
  const chunk = function (type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([Buffer.from(type), data]);
    let c = ~0;
    for (const b of crcBuf) { c ^= b; for (let k = 0; k < 8; k++) { c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
    return Buffer.concat([len, crcBuf, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
/* a wavy "signature" */
function signature(w, h) {
  w = w || 600; h = h || 120;
  return png(w, h, function (x, y) {
    const mid = h / 2 + Math.sin(x / 18) * h * 0.28 + Math.sin(x / 7) * h * 0.08;
    return x > 20 && x < w - 20 && Math.abs(y - mid) < 3;
  });
}
const blankSignature = function () { return png(600, 120, null); };

const answers = {
  first_name: 'Jane', middle_initial: 'Q', no_middle_name: false, last_name: 'Example', legal_name_ack: true,
  city: 'Phoenix', state: 'AZ', zip: '85022', phone: '602-555-0100', email: 'jexample@sanctuaryrecoverycenters.com',
  title_position: 'Case Manager', title_other: '', pay_status: 'paid', hire_date: '2025-03-17'
};
const sensitive = { date_of_birth: '1990-01-01', ssn: '000000000', home_address: '123 Example Street Apt 4B' };
/* a valid-by-the-rules SSN for validator tests (fake, never issued: 123-45-6789 is
   reserved for advertising by the SSA) */
const validSensitive = { date_of_birth: '1990-01-01', ssn: '123456789', home_address: '123 Example Street Apt 4B' };

module.exports = { png: png, signature: signature, blankSignature: blankSignature, answers: answers, sensitive: sensitive, validSensitive: validSensitive };
