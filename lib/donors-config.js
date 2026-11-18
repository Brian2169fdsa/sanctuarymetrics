/* ============================================================================
   The one place to edit membership tiers and what each donor is owed.

   Change a tier's minimum or its items here and every derived tier, every
   owed item and the Donors page follow; nothing else needs editing. The
   page receives this object from /api/donors.

   Rules:
   - A tier is chosen from the donor's active monthly BASE amount (before
     covered fees). An amount between tiers takes the tier below.
   - Items are cumulative: a tier owes its own items plus every item of the
     tiers below it.
   - When a donor moves up a tier, the new items are added as Owed. Items
     already created (sent or not) are never changed or removed.
   - One-time and offline donors are owed what the thank-you rule says. The
     rule's default is here; the team changes it on the page (admins), and
     that setting is stored with the donor data, not in code.
   ========================================================================== */

const DONOR_CONFIG = {
  tiers: [
    { name: 'Cactus Wren', minMonthly: 10, items: [{ item: 'Sticker and enamel pin' }] },
    { name: "Gambel's Quail", minMonthly: 25, items: [{ item: 'Journal or tee', apparel: true }] },
    { name: "Harris's Hawk", minMonthly: 50, items: [{ item: 'Tote bag' }] },
    { name: 'Phoenix', minMonthly: 100, items: [] }          /* same physical items as Harris's Hawk */
  ],

  /* thank-you rule for one-time and offline donors
     mode: 'per-donor'  one note per donor
           'min-total'  one note when the donor's total is at least minUsd
           'per-gift'   one note per recorded gift (one per donor until gift history exists)
           'off'        none                                                    */
  thankYouDefault: { mode: 'per-donor', minUsd: 100, item: 'Thank-you note' },

  /* Donorbox "cover the fees" gross-up, used to turn a charged amount back
     into the base amount: charged = (base + fixedUsd) / (1 - pct).
     $10 → $10.86 and $20 → $21.41 with these values.                       */
  coveredFee: { pct: 0.0515, fixedUsd: 0.30, snapWithinUsd: 0.15 },

  /* Donorbox supporter records to leave out of the sync */
  excludeNames: [/\btest\b/i, /^donorbox$/i],

  statuses: [
    ['not-owed', 'Not owed'], ['owed', 'Owed'], ['address-needed', 'Address needed'], ['packed', 'Packed'],
    ['sent', 'Sent'], ['delivered', 'Delivered'], ['declined', 'Declined by donor']
  ],
  methods: [['mail', 'Mail'], ['hand-delivered', 'Hand-delivered']]
};

/* the tier for a base monthly amount, or null */
function tierFor(monthly, cfg) {
  cfg = cfg || DONOR_CONFIG;
  let tier = null;
  cfg.tiers.slice().sort(function (a, b) { return a.minMonthly - b.minMonthly; }).forEach(function (t) {
    if (Number(monthly) >= t.minMonthly) { tier = t; }
  });
  return tier;
}
/* every item a tier owes, cumulative */
function tierItems(tier, cfg) {
  cfg = cfg || DONOR_CONFIG;
  if (!tier) { return []; }
  const out = [];
  cfg.tiers.slice().sort(function (a, b) { return a.minMonthly - b.minMonthly; }).forEach(function (t) {
    if (t.minMonthly <= tier.minMonthly) {
      t.items.forEach(function (i) { out.push({ item: i.item, apparel: !!i.apparel, reason: t.name + ' tier' }); });
    }
  });
  return out;
}
/* a charged plan amount back to its base: 10.86 → 10, 21.41 → 20, 25 → 25 */
function baseAmount(charged, cfg) {
  cfg = cfg || DONOR_CONFIG;
  const c = Number(charged) || 0;
  if (Math.abs(c - Math.round(c)) < 0.005) { return Math.round(c); }
  const f = cfg.coveredFee, base = c * (1 - f.pct) - f.fixedUsd, near = Math.round(base);
  return Math.abs(base - near) <= f.snapWithinUsd ? near : Math.round(c * 100) / 100;
}

module.exports = { DONOR_CONFIG: DONOR_CONFIG, tierFor: tierFor, tierItems: tierItems, baseAmount: baseAmount };
