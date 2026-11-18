/* ============================================================================
   Project themes: sorts every task on the Projects page into a theme, so the
   Analytics tab can show where the work goes. Used by the page (projects.html)
   and by the API (api/projects.js adds `theme` to every row it returns).

   How a task is sorted, first match wins:
     1. where it came from: requests filed from the print shop, website edits,
        presentations, social media, Salesforce, CP-AO and cost cutting pages
        stamp their own source, so those are certain
     2. otherwise, words in the title (then the notes) against THEMES below,
        in order. Put a more specific theme above a broader one.
   Anything that matches nothing lands in "Other". To re-sort a task, add a
   word to its title, or add a pattern here. Nothing is stored: themes are
   worked out fresh every time, so changing a rule re-sorts everything.
   ========================================================================== */
(function (root) {
  var THEMES = [
    { key: 'heaplus', name: 'HEAplus (CP-AO) & assistors', color: '#6B4C9A',
      source: /^CP-AO portal/i, words: /\b(assistor|heaplus|cp-?ao|ahcccs|cp-?101)\b/i },
    { key: 'salesforce', name: 'Salesforce & CRM', color: '#17739E',
      source: /^Salesforce request/i, words: /\b(salesforce|crm|adcrr|population record)\b/i },
    { key: 'sci', name: 'Sanctuary CI & fundraising', color: '#E17F55',
      source: null, words: /(sanctuary community initiative|\bsci\b|sanctuaryci|donor|donorbox|giving|fundrais|nonprofit|grant\b|giving tuesday)/i },
    { key: 'reporting', name: 'Reporting & analytics', color: '#2C5468',
      source: null, words: /\b(report|reports|reporting|metrics|analytics|dashboard|kpi|biziq|ga4|tracking|data pull)\b/i },
    { key: 'print', name: 'Print & flyers', color: '#D98A1F',
      source: /^(Print request|New flyer request)/i, words: /\b(print|prints|flyer|flyers|business cards?|brochure|banner|signage|poster|postcard|mailer)\b/i },
    { key: 'presentations', name: 'Presentations', color: '#B06F14',
      source: /^Presentation edit request/i, words: /\b(presentation|deck|slides|powerpoint|pptx)\b/i },
    { key: 'website', name: 'Website', color: '#1C9AD6',
      source: /^Website edit request/i, words: /\b(website|web ?page|landing page|seo|wordpress|domain|site edit|homepage)\b/i },
    { key: 'social', name: 'Social media & content', color: '#2E8B6F',
      source: /^Social media/i, words: /\b(social|instagram|facebook|linkedin|tiktok|youtube|post|posts|video|videos|reel|reels|content|newsletter|remember when|podcast|radio)\b/i },
    { key: 'brand', name: 'Brand & legal', color: '#8C2A14',
      source: null, words: /\b(brand|branding|logo|trade ?mark|style guide)\b/i },
    { key: 'events', name: 'Events & community', color: '#C0492B',
      source: null, words: /\b(event|events|outreach|community|conference|fair|summit|lunch|luncheon|open house|pal forward|ribbon)\b/i },
    { key: 'it', name: 'IT, systems & costs', color: '#6C7C86',
      /* "IT" only in capitals (acronym): the word "it" in "Get it approved" is not IT */
      source: /^Cost cutting/i, acronym: /\bIT\b/, words: /\b(tech|computer|laptop|email|e-mail|microsoft|m365|office 365|google workspace|license|licenses|password|tablet|tablets|adovo|edovo|teams|sharepoint|phone|printer|wifi|software|cost|costs)\b/i }
  ];
  var OTHER = { key: 'other', name: 'Other', color: '#B9C4CA' };

  /* the theme for one task: { title, source, notes, isEvent } */
  function themeOf(t) {
    t = t || {};
    var src = String(t.source || ''), title = String(t.title || ''), notes = String(t.notes || '');
    var i;
    for (i = 0; i < THEMES.length; i++) { if (THEMES[i].source && THEMES[i].source.test(src)) { return THEMES[i]; } }
    for (i = 0; i < THEMES.length; i++) { if (THEMES[i].words.test(title) || (THEMES[i].acronym && THEMES[i].acronym.test(title))) { return THEMES[i]; } }
    if (t.isEvent || t.is_event) { return THEMES.filter(function (x) { return x.key === 'events'; })[0]; }
    for (i = 0; i < THEMES.length; i++) {
      if (THEMES[i].words.test(notes.slice(0, 600)) || (THEMES[i].acronym && THEMES[i].acronym.test(notes.slice(0, 600)))) { return THEMES[i]; }
    }
    return OTHER;
  }
  /* where a task came from, for the "requests vs planned work" split */
  function originOf(t) {
    var src = String((t && t.source) || '');
    if (/request|^Social media|^CP-AO portal/i.test(src)) { return 'Staff requests'; }
    if (/^L10/i.test(src) || (t && t.seed)) { return 'L10 rocks'; }
    if (/^Cost cutting/i.test(src)) { return 'Cost cutting'; }
    return 'Added here';
  }
  /* three buckets for the status split */
  function stageOf(status) {
    var s = String(status || '').toLowerCase();
    if (/^(done|complete)/.test(s)) { return 'done'; }
    if (/^(new|on hold)/.test(s) || !s) { return 'todo'; }
    return 'doing';
  }

  var api = { THEMES: THEMES, OTHER: OTHER, themeOf: themeOf, originOf: originOf, stageOf: stageOf };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.PROJECT_THEMES = api; }
})(this);
