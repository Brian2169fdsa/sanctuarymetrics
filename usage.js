/* usage.js — shared plumbing for the Teams, Email and Groups tabs.
   ─────────────────────────────────────────────────────────────────────────
   All three read the same file the SharePoint tab does, sharepoint-usage.json,
   and all three read the RAW report rows inside it: scan.py now returns the
   Groups and Teams reports whole rather than picking a few fields, so the
   column names here are Microsoft's, spelled exactly as the CSV spells them.
   tools/report-columns.py prints the real ones for a tenant — when a column
   below stops matching, that is the tool to run rather than guessing.

   Nothing here estimates. A figure Microsoft did not return reads "—", never
   zero: a zero claims a measurement that never happened. */

/* Categorical colours, one per area. The site's own brand set fails a
   colour-vision check as a categorical palette — its coral and gold sit ΔE 5.9
   apart in normal vision, which is effectively the same colour — so these are
   the validated substitutes, keeping the brand blue exactly. The green/coral
   pair still sits in the CVD floor band, which is only legal alongside a
   second cue, so every series here is also directly labelled. */
var AREA = {
  sharepoint: '#1C9AD6',
  teams:      '#8A62C4',
  email:      '#E06A4E',
  groups:     '#3E9B6B'
};

var USAGE_URL = 'sharepoint-usage.json';

/* ── reading report cells ────────────────────────────────────────────────
   Report CSVs hand back strings, and an absent measurement is an empty
   string, not "0". Keep those apart: num() returns null for "no value" so a
   caller can render "—", and numOr0() is for the cases where summing is the
   point. */
function num(row, col) {
  if (!row) { return null; }
  var v = row[col];
  if (v === undefined || v === null || String(v).trim() === '') { return null; }
  var n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
function numOr0(row, col) { var n = num(row, col); return n === null ? 0 : n; }
function str(row, col) {
  var v = row && row[col];
  return (v === undefined || v === null) ? '' : String(v).trim();
}
function isTrue(row, col) { return str(row, col).toLowerCase() === 'true'; }

/* A count that was never measured is not zero. */
function dash(n) { return (n === null || n === undefined) ? '—' : fmt(n); }

function humanBytes(b) {
  var n = Number(b) || 0;
  if (n < 1024) { return n + ' B'; }
  var units = ['KB', 'MB', 'GB', 'TB', 'PB'], i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + units[i];
}

/* ── payload ─────────────────────────────────────────────────────────────
   Accepts the shapes build-sharepoint-payload.py emits. A tenant pulled
   before scan.py started returning the group and team reports simply has no
   such key — that is an awaiting-data state, not an error. */
function loadUsage(cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', USAGE_URL + '?v=' + Date.now(), true);
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) { cb(null, 'no-file'); return; }
    var raw;
    try { raw = JSON.parse(xhr.responseText); }
    catch (e) { cb(null, 'unparseable'); return; }
    cb(normalizeUsage(raw), null);
  };
  xhr.onerror = function () { cb(null, 'no-file'); };
  xhr.send();
}

function normalizeUsage(raw) {
  var list = [];
  if (!raw) { return null; }
  if (raw.tenants) { list = raw.tenants; }
  else if (Object.prototype.toString.call(raw) === '[object Array]') { list = raw; }
  else if (raw.sites || raw.groups || raw.teams) { list = [raw]; }

  var out = {
    generated: raw.generated || '',
    peopleRedacted: raw.people_redacted !== false,
    ownersRedacted: raw.owners_redacted !== false,
    tenants: [], refresh: '', period: null,
    sites: [], groups: [], teams: [], people: {}
  };
  list.forEach(function (t) {
    if (t.tenant && out.tenants.indexOf(t.tenant) === -1) { out.tenants.push(t.tenant); }
    if (!out.refresh && t.refresh_date) { out.refresh = t.refresh_date; }
    if (out.period === null && t.period_days) { out.period = t.period_days; }
    (t.sites  || []).forEach(function (r) { out.sites.push(r); });
    (t.groups || []).forEach(function (r) { r.__tenant = t.tenant; out.groups.push(r); });
    (t.teams  || []).forEach(function (r) { r.__tenant = t.tenant; out.teams.push(r); });
    var p = t.people || {};
    Object.keys(p).forEach(function (k) {
      out.people[k] = (out.people[k] || []).concat(p[k] || []);
    });
  });
  /* Deleted rows stay in the report; they are not current usage. */
  out.groups = out.groups.filter(function (r) { return !isTrue(r, 'Is Deleted'); });
  out.teams  = out.teams.filter(function (r) { return !isTrue(r, 'Is Deleted'); });
  return out;
}

function windowChipFor(p) {
  if (!p) { return 'no export received'; }
  if (p.period && p.refresh) { return 'last ' + p.period + ' days · to ' + p.refresh; }
  if (p.refresh) { return 'as at ' + p.refresh; }
  return 'window not stated in payload';
}

/* ── meter ───────────────────────────────────────────────────────────────
   The "gauge" form, used ONLY where a real denominator exists — active users
   out of members, replies out of all messages. A share of a number that is not
   a true ceiling is a lie dressed as a measurement: the tenant's pooled 25TB
   storage quota is repeated identically on every site, so a storage gauge
   would read <1% everywhere and tell you nothing. Those stay bars.

   items: [{ label, value, total, note }]  — value/total in the same unit. */
function meters(items, color) {
  if (!items || !items.length) { return ''; }
  return '<div class="meters">' + items.map(function (d) {
    var has = d.value !== null && d.value !== undefined &&
              d.total !== null && d.total !== undefined && d.total > 0;
    var pct = has ? Math.max(0, Math.min(100, d.value / d.total * 100)) : 0;
    /* Round only for display; a sub-1% share still shows a sliver of fill so
       the row does not read as an empty track, which looks like no data. */
    var shown = has ? (pct >= 1 ? Math.round(pct) : (pct > 0 ? '<1' : 0)) : null;
    return '<div class="meter">' +
      '<div class="meter-top">' +
        '<span class="meter-lab">' + esc(d.label) + '</span>' +
        '<span class="meter-val">' +
          (has ? fmt(d.value) + ' <span class="meter-of">of ' + fmt(d.total) + '</span>' +
                 ' <b>' + shown + '%</b>'
               : '<span class="meter-of">not measured</span>') +
        '</span>' +
      '</div>' +
      '<div class="meter-track">' +
        (has ? '<div class="meter-fill" style="width:' + Math.max(pct, pct > 0 ? 1.5 : 0) +
               '%;background:' + color + '"></div>' : '') +
      '</div>' +
      (d.note ? '<div class="meter-note">' + esc(d.note) + '</div>' : '') +
    '</div>';
  }).join('') + '</div>';
}

/* ── gauges ──────────────────────────────────────────────────────────────
   A 180° arc, same rule as the bar meter it replaces: only where a real
   denominator exists. The arc is the form people mean by "gauge" — the value
   reads as a position on a fixed sweep, so a glance says "barely started" or
   "nearly full" without reading the number.

   Kept deliberately plain: one track arc, one value arc, the percentage in the
   middle, the raw counts underneath. No needle, no tick marks, no coloured
   zones — those spend pixels on decoration and imply thresholds the data has
   not earned. Rounded stroke caps give the 4px data-end the mark spec wants. */
function arcPath(cx, cy, r, fromDeg, toDeg) {
  var rad = function (d) { return (d - 180) * Math.PI / 180; };
  var x1 = cx + r * Math.cos(rad(fromDeg)), y1 = cy + r * Math.sin(rad(fromDeg));
  var x2 = cx + r * Math.cos(rad(toDeg)),   y2 = cy + r * Math.sin(rad(toDeg));
  var large = (toDeg - fromDeg) > 180 ? 1 : 0;
  return 'M' + r1(x1) + ' ' + r1(y1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' +
         r1(x2) + ' ' + r1(y2);
}

function gauges(items, color) {
  if (!items || !items.length) { return ''; }
  var W = 150, H = 96, cx = 75, cy = 82, r = 60, sw = 13;
  return '<div class="gauges">' + items.map(function (d, i) {
    var has = d.value !== null && d.value !== undefined &&
              d.total !== null && d.total !== undefined && d.total > 0;
    var frac = has ? Math.max(0, Math.min(1, d.value / d.total)) : 0;
    var pct = has ? frac * 100 : null;
    /* Below 1% still draws a visible sliver: an arc identical to the empty
       track would read as "no data" rather than "almost none". */
    var sweep = has && frac > 0 ? Math.max(180 * frac, 2.5) : 0;
    var gid = 'g' + i + '-' + Math.random().toString(36).slice(2, 7);
    return '<figure class="gauge">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
        esc(d.label) + ': ' + (has ? Math.round(pct) + ' percent' : 'not measured') + '">' +
        '<path d="' + arcPath(cx, cy, r, 0, 180) + '" fill="none" stroke="var(--line)" ' +
          'stroke-width="' + sw + '" stroke-linecap="round"/>' +
        (sweep ? '<path d="' + arcPath(cx, cy, r, 0, sweep) + '" fill="none" stroke="' + color +
          '" stroke-width="' + sw + '" stroke-linecap="round"/>' : '') +
        '<text x="' + cx + '" y="' + (cy - 14) + '" text-anchor="middle" class="gauge-num">' +
          (has ? (pct >= 1 ? Math.round(pct) : (pct > 0 ? '<1' : '0')) + '%' : '—') + '</text>' +
        '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" class="gauge-sub">' +
          (has ? fmt(d.value) + ' of ' + fmt(d.total) : 'not measured') + '</text>' +
      '</svg>' +
      '<figcaption class="gauge-lab">' + esc(d.label) + '</figcaption>' +
      (d.note ? '<div class="gauge-note">' + esc(d.note) + '</div>' : '') +
    '</figure>';
  }).join('') + '</div>';
}

/* ── ranked bars ─────────────────────────────────────────────────────────
   Top n rows by a column, as an hbar series. Rows with no value are dropped
   rather than plotted as zero. */
function rankSeries(rows, labelCol, valueCol, n) {
  return rows.map(function (r) {
      return { label: str(r, labelCol) || '—', value: num(r, valueCol) };
    })
    .filter(function (d) { return d.value !== null && d.value > 0; })
    .sort(function (a, b) { return b.value - a.value; })
    .slice(0, n || 10);
}

/* ── the awaiting-data state ─────────────────────────────────────────────
   Shown when the payload predates the widened pull. Says exactly which
   command fills it, because "no data" without a next step is a dead end. */
function awaitingUsage(area, what) {
  return '<div class="placeholder" style="padding:30px">' +
    '<b style="color:var(--teal)">No ' + esc(what) + ' in the current pull.</b><br>' +
    'The published <code>sharepoint-usage.json</code> was built before scan.py ' +
    'started returning the ' + esc(area) + ' report. Re-run the pull and rebuild ' +
    'the payload:<br><br>' +
    '<code>python3 tools/scan.py --config config.json --enrich --out out/</code><br>' +
    '<code>python3 tools/build-sharepoint-payload.py --in out/ --out sharepoint-usage.json</code>' +
    '<br><br>Nothing on this page is estimated — it stays empty until a real ' +
    'pull fills it.</div>';
}
