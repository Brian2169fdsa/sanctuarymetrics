/* ============================================================================
   Flyers people can order or ask edits on (print.html → flyer.html).

   To add a flyer:
   1. Save the design in print/flyers/ as <id>.webp (full size) and
      <id>-thumb.webp (360 px wide). Any image editor's "export as WebP" works.
   2. Add an entry below. A flyer with several versions lists each one under
      `versions`; they share the same areas when the layout matches, or give
      a version its own `areas`.
   3. `areas` are the parts people can ask to change. Each has a name, what it
      says now (quoted in the request so marketing knows exactly what's
      meant), and where it sits on the flyer as % of the image: [left, top,
      width, height]. Areas may overlap; the smaller one wins a click.
   ========================================================================== */
var FLYER_CATALOG = [
  {
    id: 'life-story',
    title: 'Change Your Life Story',
    audience: 'Anyone looking for treatment',
    versions: [{ id: 'life-story', label: 'Change Your Life Story' }],
    areas: [
      { name: 'Headline', box: [5, 3, 49, 14], now: 'Change Your Life Story.' },
      { name: 'Intro line', box: [5, 17, 50, 6],
        now: 'Truly personalized treatment - for anyone looking for their next step towards long-term, healthy recovery.' },
      { name: 'Logo & website', box: [68, 2, 28, 18], now: 'Sanctuary Recovery Centers logo · SanctuaryRC.com' },
      { name: 'Highlights', box: [4, 25, 39, 13],
        now: 'Full Continuum of Care from inpatient treatment to transitional living · Integrated Medical Staff & Supportive Housing' },
      { name: 'Main photo', box: [47, 21, 53, 34], now: 'Hiker with arms raised on a misty mountain' },
      { name: 'Find Your Next Step Here', box: [6, 44, 41, 26],
        now: 'Find Your Next Step Here. Comprehensive Assessments · Customized Treatment Plans · Flexible Scheduling · Case Management · Group & Individual Counseling · IOP & Virtual IOP · Truly Caring, Professional Staff' },
      { name: 'Always available line', box: [6, 71, 41, 9],
        now: 'Sanctuary Recovery Centers is always available for your call, and will help guide you to a healthy recovery, regardless of your situation.' },
      { name: 'Website button', box: [7, 81, 37, 5.5], now: 'Visit SanctuaryRC.com' },
      { name: 'Joint Commission seal', box: [54, 54, 18, 15], now: 'The Joint Commission National Quality Approval seal' },
      { name: 'True Healing circle', box: [70, 45, 29, 23],
        now: 'True Healing & Continued Care — Dedicated to treatment that fits the person, and lasts a lifetime.' },
      { name: 'Phone number', box: [60, 69, 40, 10], now: 'We help every caller. (480) 470-4847 — Call an admissions counselor 24/7' },
      { name: 'Insurance line', box: [54, 80, 43, 6.5],
        now: 'Our trusted program works with most insurances. We partner with state, federal, and community organizations to offer options for all.' },
      { name: 'Photo strip', box: [0, 87, 100, 9], now: 'Four photos: living rooms, office and the desert yard' },
      { name: 'Bottom banner', box: [4, 96, 50, 4], now: 'NEW: Adolescent Male Program Now Open' },
      { name: 'Partner logos', box: [55, 96, 44, 4], now: 'ASU · LegitScript · Psychology Today · Google reviews' }
    ]
  },
  {
    id: 'careers',
    title: 'Careers — Grow Here',
    audience: 'Job seekers',
    versions: [{ id: 'careers-grow-here', label: 'Grow Here' }],
    areas: [
      { name: 'Headline', box: [4, 5, 39, 18], now: 'GROW HERE.' },
      { name: 'Logo & website', box: [54, 2, 42, 24], now: 'Sanctuary logo · SANCTUARYRC.COM' },
      { name: 'Intro', box: [5, 26, 37, 27],
        now: 'A career that heals our community. Mental health care & addiction treatment. Join a growing team serving our neighbors with exceptional care.' },
      { name: 'Photo', box: [44, 29, 56, 25], now: 'Counselor talking with a smiling young woman on a sofa' },
      { name: 'True impact. Great worklife.', box: [5, 59, 40, 22],
        now: 'True impact. Great worklife. Provide excellent care to people on a path to healing. Flexible hours and work schedules available.' },
      { name: 'Apply today & QR code', box: [5, 82, 44, 9], now: 'APPLY TODAY button and QR code' },
      { name: 'Email', box: [5, 91, 46, 4.5], now: 'EMAIL: HR@SANCTUARYRC.COM' },
      { name: 'Hiring across departments', box: [51, 59, 41, 34],
        now: 'Hiring across departments: opportunities for career advancement and professional development; supportive growth environment; meaningful impact in community healing.' },
      { name: 'Joint Commission seal', box: [86, 90, 10, 8], now: 'The Joint Commission National Quality Approval seal' }
    ]
  },
  {
    id: 'adolescent',
    title: 'Male Adolescent Program',
    audience: 'Families of boys 12–17',
    versions: [
      { id: 'adolescent-a', label: 'Version A', note: 'Smiling teen outdoors' },
      { id: 'adolescent-b', label: 'Version B', note: 'Teen by a wood wall' },
      { id: 'adolescent-c', label: 'Version C', note: 'Teen looking up, headline on the right',
        areas: 'c' }
    ],
    areas: [
      { name: 'Logo', box: [3, 0, 24, 15], now: 'Sanctuary Recovery Centers logo' },
      { name: 'Headline', box: [3, 16, 49, 16],
        now: 'RECOVERY · EDUCATION · EMPOWERMENT — Male Adolescent Program at Sanctuary Recovery Centers' },
      { name: 'Main photo', box: [52, 0, 48, 36], now: 'Teen photo across the top' },
      { name: '90 day box', box: [3, 35, 37, 27],
        now: '90 DAY treatment for youth: 10 beds in a nurturing and beautiful home setting serving 12–17 year old males; unique and effective modalities; family involvement and therapy; accredited online educational program.' },
      { name: 'A Path Forward', box: [43, 40, 54, 21],
        now: 'A Path Forward — At Sanctuary Recovery Centers, we recognize the specific challenges faced by young males aged 12–17. Our Male Adolescent Program is dedicated to supporting youth in overcoming obstacles and discovering true potential. In a space where understanding, respect, and camaraderie are paramount, we\'re here every step of the way on your journey to recovery.' },
      { name: 'Roadrunner Home photos', box: [3, 62, 94, 29],
        now: 'Welcome to the Roadrunner Home — photos of the house, the basketball court and a teen studying' },
      { name: 'Call admissions', box: [3, 92, 44, 8], now: 'Call Admissions 24/7 Direct | (480) 690-1759' },
      { name: 'Address & email', box: [50, 93, 46, 7],
        now: '11645 North Cave Creek Rd. Phoenix, Arizona 85020 · admissions@sanctuaryrc.com' }
    ],
    /* version C moves the headline right and the photo left */
    areasC: [
      { name: 'Logo', box: [2, 0, 22, 13], now: 'Sanctuary Recovery Centers logo' },
      { name: 'Headline', box: [54, 3, 43, 19],
        now: 'RECOVERY · EDUCATION · EMPOWERMENT — Male Adolescent Program at Sanctuary Recovery Centers' },
      { name: 'Main photo', box: [16, 13, 38, 25], now: 'Teen looking up, leaning on a wall' }
    ]
  },
  {
    id: 'womens',
    title: 'Women\'s Program',
    audience: 'Women seeking treatment',
    versions: [{ id: 'womens-program', label: 'Women\'s Program' }],
    areas: [
      { name: 'Headline', box: [3, 3, 53, 21], now: 'WOMEN\'S PROGRAM — Empowering Women to Heal and Thrive' },
      { name: 'Logo & website', box: [70, 2, 28, 16], now: 'Sanctuary logo · SANCTUARYRC.COM' },
      { name: 'Program description', box: [2, 30, 39, 45],
        now: 'Sanctuary Recovery Centers offers peer-driven programs empowering women to heal and rebuild. Activities include Barbell Saves gym, outings, yoga, and sound healing sessions led by a Hatha Gong Master. Music therapy is provided by Jay Dow with Sober Music Company… Housing and Employment Resource Fairs… Gratitude Tree… Starfish and ASU STIR programs.' },
      { name: 'Program tagline', box: [2, 77, 34, 10], now: 'A program that supports women\'s recovery and growth' },
      { name: 'Contact details', box: [2, 89, 28, 9], now: 'info@sanctuaryrc.com · SanctuaryRC.com · 1 (844) 978-TRUE' },
      { name: 'Photo: Barbell Saves', box: [46, 25, 27, 24], now: 'BARBELL SAVES — women working out at the gym' },
      { name: 'Photo: Yoga / sound healing', box: [74, 25, 26, 24], now: 'YOGA/SOUND HEALING — sound bowl session' },
      { name: 'Photo: ASU / STIR', box: [46, 50, 27, 25], now: 'ASU/STIR — group session in the living room' },
      { name: 'Photo: Music therapy', box: [74, 50, 26, 25], now: 'MUSIC THERAPY — guitar session' },
      { name: 'Photo: Resources', box: [46, 76, 27, 24], now: 'RESOURCES — group at a resource fair' },
      { name: 'Photo: Spiritual growth', box: [74, 76, 26, 24], now: 'SPIRITUAL GROWTH — the Gratitude Tree' }
    ]
  }
];

/* the areas for one version of a flyer */
function flyerAreas(f, v) {
  if (!v || !v.areas) { return f.areas; }
  /* a version can swap out some areas by name and keep the rest */
  var swap = f['areas' + v.areas.toUpperCase()] || [];
  return f.areas.map(function (a) {
    return swap.filter(function (s) { return s.name === a.name; })[0] || a;
  });
}
function flyerImg(v) { return 'print/flyers/' + v.id + '.webp'; }
function flyerThumb(v) { return 'print/flyers/' + v.id + '-thumb.webp'; }
