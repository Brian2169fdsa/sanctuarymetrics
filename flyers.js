/* ============================================================================
   Flyers people can order or ask edits on (print.html → flyer.html).

   To add a flyer:
   1. Save the design in print/flyers/ as <id>.webp (full size) and
      <id>-thumb.webp (360 px wide). Any image editor's "export as WebP" works.
   2. Add an entry below. A flyer with several versions lists each one under
      `versions`; they share the same areas when the layout matches, or give
      a version its own `areas`.
   3. Optional: the print-ready PDF people can download. Save it in
      print/flyers/ as <id>.pdf, named after the version id (for example
      life-story.pdf, adolescent-b.pdf). A "Download PDF" button appears on
      its own: no change needed here. PDFs are only served to signed-in staff.
   4. `areas` are the parts people can ask to change. Each has a name, what it
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
    id: 'treatment-for-all',
    title: 'Addiction Treatment For All',
    audience: 'Anyone looking for treatment · insurance',
    versions: [
      { id: 'treatment-for-all', label: 'Woman in the desert' },
      { id: 'treatment-for-all-family', label: 'Family', note: 'Child holding a parent\'s hand', areas: 'f' }
    ],
    areas: [
      { name: 'Logo', box: [4, 1, 29, 16], now: 'Sanctuary Recovery Centers logo' },
      { name: 'Contact details', box: [67, 2, 27, 8], now: 'info@sanctuaryrc.com · SanctuaryRC.com · 1 (844) 978-TRUE' },
      { name: 'Insurance logos', box: [63, 10.5, 31, 6],
        now: 'Aetna · BlueCross BlueShield · Banner Health · AHCCCS · Health Choice · Mayo Clinic · Humana · Cigna · Mercy Care' },
      { name: 'Main photo', box: [2, 17.5, 92, 38.5], now: 'Smiling woman in a blanket in the desert' },
      { name: 'Bubble: Accountable care', box: [9, 18.5, 15.5, 11.5], now: 'ACCOUNTABLE CARE AT ALL LEVELS' },
      { name: 'Bubble: Medical staff', box: [9, 30.5, 15.5, 11.5], now: 'MEDICAL STAFF, INTEGRATED COUNSELING' },
      { name: 'Bubble: Relapse prevention', box: [9, 43, 15.5, 11.5], now: 'RELAPSE PREVENTION & CONTINUED CARE' },
      { name: 'Headline', box: [56, 40, 37, 16], now: 'SANCTUARY RECOVERY CENTERS — Addiction Treatment For All.' },
      { name: 'Services list', box: [6, 59, 49, 32],
        now: 'Full Medical Staff & Expert Clinicians at All Levels of Customized Care · Proven Long-Term Results · Spacious, Beautiful Residential Treatment Homes in Inspiring Locations · Morning, Afternoon & Evening Clinics · Group & Individual Counseling · Caring Case Management · Music Therapy, Sound Healing, Yoga, Art, and So Much More for Holistic Care · Women\'s trafficking healing program (in partnership with STIR)' },
      { name: 'Home photos', box: [57, 60.5, 37, 29], now: 'Four photos: living room, wood office, pool, great room' },
      { name: 'Footer banner', box: [2, 93.5, 91, 6.5], now: 'True Healing & Continued Care™' }
    ],
    /* the family version swaps the photo; the bubbles sit a little further left */
    areasF: [
      { name: 'Main photo', box: [2, 17.5, 92, 38.5], now: 'A little girl holding a parent\'s hand, walking outdoors' },
      { name: 'Bubble: Accountable care', box: [5.5, 18.5, 15, 11.5], now: 'ACCOUNTABLE CARE AT ALL LEVELS' },
      { name: 'Bubble: Medical staff', box: [5.5, 30.5, 15, 11.5], now: 'MEDICAL STAFF, INTEGRATED COUNSELING' },
      { name: 'Bubble: Relapse prevention', box: [5, 43.5, 15, 11.5], now: 'RELAPSE PREVENTION & CONTINUED CARE' }
    ]
  },
  {
    id: 'next-steps',
    title: 'Let\'s Take Next Steps Together',
    audience: 'Justice-involved people · reentry',
    versions: [{ id: 'next-steps-together', label: 'Next Steps Together' }],
    areas: [
      { name: 'Main photo', box: [11, 0, 80, 38.5], now: 'Man with arms raised at sunset, birds flying' },
      { name: 'Logo', box: [13, 20, 32, 17], now: 'White Sanctuary logo on the photo' },
      { name: 'Headline', box: [64, 28, 22, 9], now: 'LET\'S TAKE NEXT STEPS TOGETHER' },
      { name: 'Treatment, Counseling and Community', box: [12, 41, 34, 12.5],
        now: 'Treatment, Counseling and Community — With a focus on holistic care, Sanctuary Recovery Centers empowers individuals to rebuild their lives with confidence and resilience.' },
      { name: 'A Partner in Your Journey', box: [12, 54, 36, 19],
        now: 'A Partner in Your Journey — Our support system offers stability, reducing feelings of isolation and providing a sense of belonging. We also encourage accountability and helping maintain positive behavior changes. Partner with people with similar experiences and specialized training. Let us help you navigate reentering society.' },
      { name: 'Have You Thought About?', box: [12, 76, 38, 12.5],
        now: 'Have You Thought About? Counseling · Housing · Community · Case Management · Employment · Transportation' },
      { name: 'Trusted Services for Justice Involved People', box: [53, 41, 40, 21],
        now: 'Trusted Services for Justice Involved People — Sanctuary specializes in supporting individuals transitioning from prison, providing a comprehensive pathway to recovery for those battling substance abuse. Their services extend beyond rehabilitation, offering supportive housing, case management and life skills training to ensure a smooth and successful reintegration into society.' },
      { name: 'Planning Your Next Move', box: [53, 63.5, 35, 6.5],
        now: 'Planning Your Next Move — Leaving confinement can be challenging. Link up with Sanctuary to make the most of your first weeks out.' },
      { name: 'Substance Use Disorder and Mental Health Services', box: [53, 71.5, 35, 7.5],
        now: 'Substance Use Disorder and Mental Health Services — Comprehensive drug and alcohol rehabilitation services paired with licensed therapists for holistic healing.' },
      { name: 'A Community that Cares', box: [53, 80.5, 35, 7],
        now: 'A Community that Cares — We\'re more than a treatment center – we\'re a community that suppports one another.' },
      { name: 'Email', box: [12, 89, 46, 3.5], now: 'admissions@sanctuaryrecoverycenters.com' },
      { name: 'Phone number', box: [60, 88, 28, 5], now: '480-470-9227' },
      { name: 'Footer bar', box: [1, 93.5, 99, 6.5], now: 'Several Arizona Locations · SanctuaryRC.com · info@SanctuaryRC.com' }
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
  },
  {
    id: 'womens-pregnancy',
    title: 'Women\'s Mental Health, Recovery & Family Support',
    audience: 'Pregnant women and mothers facing addiction',
    versions: [{ id: 'womens-pregnancy-family-program', label: 'Pregnancy & family program' }],
    areas: [
      { name: 'Main photo & title', box: [3, 0, 94, 38.5], now: 'Pregnant woman at sunset · SANCTUARY RECOVERY CENTERS' },
      { name: 'Program banner', box: [5, 26, 69, 10],
        now: 'Women\'s Mental Health, Recovery & Family Support Program — Comprehensive, Trauma-Informed Care for Pregnant Women and Mothers Facing Addiction' },
      { name: 'Bubble: Early intervention', box: [79, 1.5, 15, 10.5], now: 'EARLY INTERVENTION BEFORE DCS INVOLVEMENT' },
      { name: 'Bubble: Prenatal care', box: [79, 14, 15, 10.5], now: 'PRENATAL CARE + SUBSTANCE USE RECOVERY' },
      { name: 'Bubble: Family preservation', box: [79, 26.5, 15, 10.5], now: 'FAMILY PRESERVATION IS THE GOAL' },
      { name: 'Home photos', box: [5, 42, 40, 31], now: 'Four photos: living room, wood office, pool, great room' },
      { name: 'Services list', box: [49, 41, 48, 37],
        now: 'Trauma-Informed Addiction Treatment Throughout Full-Term Pregnancy · Compassionate Mental Health Support Services · Onsite or Referred OB Care, Doula Support, and Parenting Classes · Peer Support Staff with Lived Experience · Legal Navigation + DCS Advocacy to Prevent Family Separation · Housing and Childcare Navigation for Post-Treatment Stability · Early Childhood Education Training in Partnership with ASU' },
      { name: 'Contact details', box: [5, 77, 35, 10], now: 'info@sanctuaryrc.com · SanctuaryRC.com · 1 (844) 978-TRUE' },
      { name: 'Insurance logos', box: [53, 80, 45, 10],
        now: 'Molina · Aetna · BlueCross BlueShield · Banner Health · AHCCCS · Health Choice · Mayo Clinic · Humana · Cigna · Mercy Care' },
      { name: 'Footer banner', box: [3, 91, 94, 8], now: 'True Healing & Continued Care' }
    ]
  },
  {
    id: 'womens-core-metrics',
    title: 'C.O.R.E. Women\'s Program — 2025 results',
    audience: 'Funders and referral partners',
    versions: [{ id: 'womens-program-core-metrics-2025', label: '2025 program metrics' }],
    areas: [
      { name: 'Main photo & title', box: [2, 2, 95, 23.5], now: 'Three women in the desert · SANCTUARY RECOVERY CENTERS — WOMEN\'S PROGRAM' },
      { name: 'C.O.R.E Women\'s Program', box: [6, 28, 44, 31.5],
        now: 'C.O.R.E WOMEN\'S PROGRAM — AHCCCS TIP 2.0 & Substance Use Block Grant Impact. The C.O.R.E Women\'s Program provides trauma-informed residential substance use treatment for Medicaid-eligible women impacted by trafficking, justice involvement, and co-occurring disorders. TIP 2.0 and Substance Use Block Grant funding expanded trauma-specific clinical programming and integrated behavioral and social health services at 28th St.' },
      { name: 'Program metrics (2025)', box: [6, 60, 40, 16],
        now: 'Average Length of Stay (LOS): 37 days · Completion Rate: 53% · Total Women Served: 122' },
      { name: 'Funding-enhanced services', box: [54, 28, 38, 27],
        now: 'Implementation of ASU S.T.I.R. trauma-informed framework · Sand Tray Therapy · Music Therapy (Sober Music Company) · Hatha Gong Therapy · Barbell Saves empowerment partnership · Expanded trauma-informed clinical staffing' },
      { name: 'Core program services', box: [54, 58, 38, 16],
        now: 'Residential substance use treatment · Individual and group counseling · Case management · Social health navigation (housing & employment linkage) · Reentry and workforce partnerships' },
      { name: 'Photo strip', box: [6, 79, 88, 13], now: 'Five photos: Barbell Saves, gong session, resource fair, Gratitude Tree, music therapy' },
      { name: 'Footer banner', box: [1, 93.5, 98, 6.5], now: 'True Healing & Continued Care' }
    ]
  },
  {
    id: 'core-outreach',
    title: 'C.O.R.E. Community Outreach',
    audience: 'Community partners · people leaving prison',
    versions: [{ id: 'core-community-outreach', label: 'Community Outreach, Resources & Education' }],
    areas: [
      { name: 'Main photo & logo', box: [3, 1, 93, 35], now: 'Smiling woman with volunteers in a park · Sanctuary C.O.R.E. logo' },
      { name: 'Community Outreach, Resources & Education', box: [8, 37, 37, 25],
        now: 'The C.O.R.E. Program is a community-based outreach initiative from Sanctuary Recovery Centers, designed to help people connect with support, services, and resources when they need them. CORE teams work directly in the community and justice settings to provide guidance, information, and connections to care in a respectful and supportive way.' },
      { name: 'What the CORE Program Provides', box: [8, 62.5, 42, 25.5],
        now: 'CORE helps individuals access: mental health support · substance use and recovery resources · housing and shelter options · insurance and benefits enrollment · transportation assistance · re-entry and community support services. Services are provided by trained peer specialists and focus on practical, real-world needs.' },
      { name: 'Support for Individuals and the Community', box: [53, 37, 40, 24],
        now: 'Sanctuary supports individuals in the community, including those transitioning from prison, by providing a comprehensive pathway focused on mental health care and substance use support. Services extend beyond rehabilitation to include supportive housing, case management, and life skills training that promote stable reintegration and long-term well-being.' },
      { name: 'Planning Your Next Move', box: [53, 62, 38, 10],
        now: 'CORE team members help individuals understand available options and identify next steps based on their needs and situation. Support may begin before release and continue after, when applicable.' },
      { name: 'A Community-Based Program', box: [53, 73, 38, 12],
        now: 'CORE is part of Sanctuary Recovery Centers\' commitment to community outreach and public service. The program works alongside local partners to improve access to care and support across Arizona.' },
      { name: 'Email', box: [8, 88.3, 48, 3.5], now: 'admissions@sanctuaryrecoverycenters.com' },
      { name: 'Phone', box: [63, 87, 28, 5], now: '480-470-9227' },
      { name: 'Footer bar', box: [0, 93, 100, 7], now: 'SanctuaryRC.com · Several Arizona Locations · info@SanctuaryRC.com' }
    ]
  },
  {
    id: 'transitional-living',
    title: 'Transitional Living Center — Nov 2024 update',
    audience: 'Reentry partners and the Arizona Department of Corrections',
    versions: [
      { id: 'transitional-living-update-nov-2024', label: 'Transitional Living Center', note: 'With Jeremy West\'s contact and the address' },
      { id: 'facility-update-nov-2024', label: 'Facility Update', note: 'Earlier version: general contact details', areas: 'o' }
    ],
    areas: [
      { name: 'Logo', box: [0, 0, 31, 20], now: 'Sanctuary logo' },
      { name: 'Title', box: [31, 0, 53, 20], now: 'SANCTAURY RECOVERY CENTERS — TRANSITIONAL LIVING CENTER UPDATE' },
      { name: 'Photo of a young man', box: [84, 4, 16, 28], now: 'Young man in a white T-shirt looking up' },
      { name: 'Progress bar', box: [3, 21, 72, 11],
        now: 'NOVEMBER 2024 | PROGRESS TOWARDS OPENING · Safe location: comfortable housing · Support: onsite staff · Growth: personal responsibilities' },
      { name: 'Message from the CEO', box: [4, 33, 41, 40],
        now: 'More than "Reentry." Renewing Hope. We\'re close. We\'re excited. Renovations are nearly complete… Run by peers in recovery, the facility provides a clean, comfortable space furnished with new or like-new items, giving residents a home they can take pride in. — Joe Landin, CEO' },
      { name: 'Facility photos', box: [48, 33, 47, 40], now: 'Six photos of the building and the empty units' },
      { name: 'Facility highlights', box: [4, 74, 94, 14],
        now: 'NOVEMBER 2024 FACILITY HIGHLIGHTS: 22 two-bedroom units · onsite commercial kitchen · onsite support staff · 15+ years in the industry' },
      { name: 'Partnership line', box: [4, 89, 40, 10],
        now: 'We\'re excited to partner with the Arizona Department of Corrections to create pathways from prison to a brighter future. Contact Jeremy West for tours and info.' },
      { name: 'Contact details', box: [59, 89, 31, 9], now: 'JWEST@SANCTUARYRC.COM · (480) 408-2694 · 9435 N 11TH AVE, PHOENIX, AZ' }
    ],
    /* the earlier "Facility Update" version */
    areasO: [
      { name: 'Title', box: [31, 0, 53, 20], now: 'SANCTAURY RECOVERY CENTERS — FACILITY UPDATE' },
      { name: 'Message from the CEO', box: [4, 33, 41, 40],
        now: 'More than "Reentry." Renewing Hope. We\'re close. We\'re excited. Renovations are nearly complete… Run by peers in recovery, the facility provides a clean, comfortable space furnished, giving residents a home they can take pride in. — Joe Landin, CEO' },
      { name: 'Facility photos', box: [48, 37, 50, 29], now: 'Four photos of the building and the empty units' },
      { name: 'Partnership line', box: [4, 89, 42, 9],
        now: 'We\'re excited to partner with the Arizona Department of Corrections to create pathways from prison to a brighter future.' },
      { name: 'Contact details', box: [59, 89, 31, 10], now: 'INFO@SANCTUARYRC.COM · (844) 978-8783 · Located near North Mountain' }
    ]
  },
  {
    id: 'hiring',
    title: 'Now Hiring — open roles',
    audience: 'Job seekers',
    versions: [
      { id: 'hiring-case-manager', label: 'Case Managers' },
      { id: 'hiring-clinical-director', label: 'Clinical Director', areas: 'd' },
      { id: 'hiring-insurance-ur-rep', label: 'Insurance & UR reps', note: 'Insurance Eligibility and Utilization Review Authorization Representatives', areas: 'i' }
    ],
    areas: [
      { name: 'Main photo & title', box: [4, 1, 76, 38],
        now: 'Case manager meeting a client at a desk · SANCTUARY RECOVERY CENTERS — Addiction Treatment For All.' },
      { name: 'Role bubbles', box: [80, 2, 15, 36], now: 'ADVANCED CASE MANAGEMENT · DEDICATED CASE MANAGER ROLES · INFORMED SUPPORT' },
      { name: 'Headline', box: [6, 40, 84, 4.5], now: 'A CAREER THAT HEALS OUR COMMUNITY' },
      { name: 'About the role', box: [6, 45, 86, 11],
        now: 'We\'re hiring Case Managers to join our team in delivering critical support to individuals on the path to recovery. Join a mission-driven organization focused on accountability, integrated care, and long-term recovery outcomes. Requirements: Minimum 2 years of case management experience in behavioral health.' },
      { name: 'True impact. Great worklife.', box: [6, 57, 42, 27],
        now: 'Provide essential case management services, connecting clients with needed resources and supporting their recovery journey · Collaborate within a multidisciplinary team to ensure seamless, coordinated care' },
      { name: 'Apply today', box: [6, 85, 29, 6], now: 'APPLY TODAY button' },
      { name: 'Why join us?', box: [52, 57, 40, 33],
        now: 'Opportunities for career growth and professional development · A supportive, mission-driven team environment · Make a meaningful impact in addiction recovery and community wellness' },
      { name: 'Contact', box: [6, 92, 52, 6.5], now: 'EMAIL: MANNOUAL@SANCTUARYRC.COM · CALL: 1 (480) 900-1487' },
      { name: 'Joint Commission seal', box: [86, 90, 10, 8], now: 'The Joint Commission National Quality Approval seal' }
    ],
    /* Clinical Director: bubbles on the left, title on the right */
    areasD: [
      { name: 'Main photo & title', box: [3, 3, 93, 38],
        now: 'Clinician reviewing notes with a client · SANCTUARY RECOVERY CENTERS — Addiction Treatment For All.' },
      { name: 'Role bubbles', box: [7, 4, 18, 36], now: 'ADVANCED CLINICAL LEADERSHIP · INDEPENDENTLY LICENSED ROLE · CO-OCCURRING & TRAUMA-INFORMED CARE' },
      { name: 'Headline', box: [6, 44, 84, 4], now: 'A CAREER THAT HEALS OUR COMMUNITY' },
      { name: 'About the role', box: [6, 49, 88, 8],
        now: 'We are seeking an experienced Clinical Director to lead clinical operations and provide oversight for behavioral health and addiction treatment services. Be part of a mission-driven organization delivering accountable, ethical, and high-quality care across all levels of treatment.' },
      { name: 'True impact. Great worklife.', box: [6, 60, 42, 23],
        now: 'Provide expert therapeutic care to individuals on the path to recovery · Collaborate with a multidisciplinary team in a supportive clinical setting' },
      { name: 'Apply today', box: [6, 84, 29, 6], now: 'APPLY TODAY button' },
      { name: 'Why join us?', box: [52, 59, 40, 37],
        now: 'Shape clinical direction and standards organization-wide · Work with dedicated professionals committed to ethical, client-centered care · Play a key role in program expansion and quality improvement' },
      { name: 'Joint Commission seal', box: [88, 91, 9, 8], now: 'The Joint Commission National Quality Approval seal' }
    ],
    /* Insurance Eligibility & UR Authorization reps */
    areasI: [
      { name: 'Role bubbles', box: [69, 8, 27, 24],
        now: 'UTILIZATION REVIEW AUTHORIZATION REPRESENTATIVE · INSURANCE ELIGIBILITY REPRESENTATIVE' },
      { name: 'Headline', box: [6, 40, 84, 4.5], now: 'A CAREER THAT SUPPORTS OUR MISSION' },
      { name: 'About the role', box: [6, 45, 86, 12.5],
        now: 'We\'re hiring Insurance Eligibility and Utilization Review Authorization Representatives to support our Revenue Cycle team. These roles ensure clients can access treatment by verifying coverage, securing authorizations, and coordinating with payers to keep care moving forward. Requirements: Previous insurance or revenue cycle experience preferred; training available for the right candidate.' },
      { name: 'True impact. Great worklife.', box: [6, 57, 42, 28],
        now: 'Verify insurance benefits and eligibility so clients can begin treatment without barriers · Secure authorizations and follow up with payers to support continued care · Work closely with clinical and admissions teams to ensure smooth financial coordination · Contribute to a compassionate, mission-driven organization helping individuals start their recovery journey' },
      { name: 'Why join us?', box: [52, 56.5, 42, 37],
        now: 'Opportunities for career growth in a high-demand healthcare field · Supportive team environment with strong training and mentorship · Mission-driven organization centered on helping individuals access life-changing treatment' }
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
function flyerPdf(v) { return 'print/flyers/' + v.id + '.pdf'; }
/* does this version have a PDF in print/flyers/? Asked once per page */
var _flyerPdf = {};
function flyerHasPdf(v) {
  if (!_flyerPdf[v.id]) {
    _flyerPdf[v.id] = fetch(flyerPdf(v), { method: 'HEAD', credentials: 'same-origin' }).then(function (r) {
      return r.ok && /pdf/i.test(r.headers.get('content-type') || '');
    }, function () { return false; });
  }
  return _flyerPdf[v.id];
}
/* the file name it saves as, e.g. Sanctuary - Adolescent Program - Version B.pdf */
function flyerPdfName(f, v) {
  /* plain characters only: browsers drop a download name with a dash like "—" */
  return ('Sanctuary - ' + f.title + (f.versions.length > 1 ? ' - ' + v.label : '') + '.pdf')
    .replace(/[\u2013\u2014]/g, '-').replace(/[’‘]/g, "'").replace(/[^\x20-\x7E]+/g, '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ');
}
function flyerThumb(v) { return 'print/flyers/' + v.id + '-thumb.webp'; }
