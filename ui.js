/* ==========================================================================
   Sanctuary Recovery Centers — shared render helpers
   Chart geometry matches the original hand-built SVGs: 560-wide viewBox,
   18px bar gap, 176 baseline, value label 7px above the bar, x-labels at 192.
   ========================================================================== */

function esc(s) {
  return String(s).replace(/&(?![a-zA-Z#][a-zA-Z0-9]{0,7};)/g, '&amp;')
                  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function r1(n) { return (Math.round(n * 10) / 10).toFixed(1); }

/* ── vertical bar chart (weekly / monthly series) ─────────────────────── */
function vbar(series, color) {
  var n = series.length; if (!n) { return ''; }
  var gap = 18, w = (560 - gap * (n - 1)) / n, base = 176, H = 140;
  var max = 0;
  series.forEach(function (d) { if (d.value > max) { max = d.value; } });
  if (!max) { max = 1; }
  var s = '<svg viewBox="0 0 560 200" class="chart" role="img" aria-label="bar chart">' +
          '<line x1="0" y1="176" x2="560" y2="176" stroke="#E4EBEF"/>';
  series.forEach(function (d, i) {
    var h = d.value / max * H, x = i * (w + gap), y = base - h, cx = x + w / 2;
    s += '<rect x="' + r1(x) + '" y="' + r1(y) + '" width="' + r1(w) + '" height="' + r1(h) +
         '" rx="3" fill="' + color + '"/>' +
         '<text x="' + r1(cx) + '" y="' + r1(y - 7) + '" text-anchor="middle" class="bval">' + fmt(d.value) + '</text>' +
         '<text x="' + r1(cx) + '" y="192.0" text-anchor="middle" class="blab">' + esc(d.label) + '</text>';
  });
  return s + '</svg>';
}

/* ── horizontal bar chart (reach volume / content format) ─────────────── */
function hbar(series, opts) {
  opts = opts || {};
  var n = series.length; if (!n) { return ''; }
  var barX = opts.barX || 150, maxW = 490 - barX, rowH = 34, top = 10, bh = 20;
  var max = 0;
  series.forEach(function (d) { if (d.value > max) { max = d.value; } });
  if (!max) { max = 1; }
  var vh = n * rowH + 8;
  var s = '<svg viewBox="0 0 560 ' + vh + '" class="chart" role="img" aria-label="bar chart">';
  series.forEach(function (d, i) {
    var y = top + i * rowH, w = d.value / max * maxW, tb = y + 15;
    s += '<text x="0" y="' + tb + '" class="hlab">' + esc(d.label) + '</text>' +
         '<rect x="' + barX + '" y="' + y + '" width="' + r1(w) + '" height="' + bh + '" rx="3" fill="' +
         (d.color || opts.color || '#2C5468') + '"/>' +
         '<text x="' + r1(barX + w + 8) + '" y="' + tb + '" class="hval">' + fmt(d.value) + '</text>';
  });
  return s + '</svg>';
}

/* ── trend line chart (compare page) ──────────────────────────────────── */
function trend(points, color) {
  var n = points.length; if (n < 2) { return ''; }
  var padX = 46, base = 176, H = 140, top = 26;
  var max = 0;
  points.forEach(function (d) { if (d.value > max) { max = d.value; } });
  if (!max) { max = 1; }
  var xs = function (i) { return padX + i * ((560 - padX * 2) / (n - 1)); };
  var ys = function (v) { return base - (v / max) * H; };
  var s = '<svg viewBox="0 0 560 200" class="chart" role="img" aria-label="trend chart">' +
          '<line x1="0" y1="176" x2="560" y2="176" stroke="#E4EBEF"/>';
  var d = '';
  points.forEach(function (p, i) { d += (i ? ' L' : 'M') + r1(xs(i)) + ' ' + r1(ys(p.value)); });
  var area = d + ' L' + r1(xs(n - 1)) + ' 176 L' + r1(xs(0)) + ' 176 Z';
  s += '<path d="' + area + '" fill="' + color + '" opacity=".10"/>';
  s += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
  points.forEach(function (p, i) {
    var x = xs(i), y = ys(p.value);
    s += '<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="4.5" fill="#fff" stroke="' + color + '" stroke-width="2.5"/>' +
         '<text x="' + r1(x) + '" y="' + r1(Math.max(top - 8, y - 13)) + '" text-anchor="middle" class="bval">' + fmt(p.value) + '</text>' +
         '<text x="' + r1(x) + '" y="192.0" text-anchor="middle" class="blab">' + esc(p.label) + '</text>';
  });
  return s + '</svg>';
}

/* ── table (always emits a <thead> so the mobile stacker works) ───────── */
function table(head, rows, opts) {
  opts = opts || {};
  var numeric = opts.numeric || function (i) { return i > 0; };
  var s = '<div class="tw"><table><thead><tr>';
  head.forEach(function (h, i) { s += '<th' + (numeric(i) && !opts.plainHead ? ' class="n"' : '') + '>' + esc(h) + '</th>'; });
  s += '</tr></thead><tbody>';
  rows.forEach(function (row, ri) {
    s += '<tr' + (opts.highlight === ri ? ' style="background:#fbf3ec"' : '') + '>';
    row.forEach(function (cell, i) {
      if (cell && typeof cell === 'object' && cell.tag) {
        s += '<td><span class="tag ' + cell.tag + '">' + esc(cell.text) + '</span></td>';
      } else {
        s += '<td' + (numeric(i) ? ' class="n"' : '') + '>' + cell + '</td>';
      }
    });
    s += '</tr>';
  });
  return s + '</tbody></table></div>';
}

/* ── KPI card row ─────────────────────────────────────────────────────── */
function kpis(list, cols) {
  var style = cols ? ' style="grid-template-columns:repeat(' + cols + ',1fr)"' : '';
  var s = '<div class="kpis"' + style + '>';
  list.forEach(function (k) {
    s += '<div class="kpi"><div class="lab">' + esc(k.lab) + '</div><div class="num">' + esc(k.num) + '</div>';
    if (k.chg) {
      s += '<span class="chg" style="color:' + (k.dir === 'up' ? '#2E8B6F' : '#C0492B') + '">' + esc(k.chg) + '</span> ';
    }
    if (k.note) { s += '<div class="note">' + esc(k.note) + '</div>'; }
    if (k.w) { s += '<div class="note" style="margin-top:4px;opacity:.85">' + esc(k.w) + '</div>'; }
    s += '</div>';
  });
  return s + '</div>';
}

/* ── section header with dot + source window chip ─────────────────────── */
function sechead(name, color, source, window) {
  return '<div class="sechead"><span class="dot" style="background:' + color + '"></span><h2>' + esc(name) + '</h2></div>' +
         '<p class="sub">' + source + (window ? ' &nbsp;·&nbsp; <span class="win-chip">' + esc(window) + '</span>' : '') + '</p>';
}

/* ── "no new export" muted state — never carries values forward ───────── */
function noExport(lastWindow) {
  return '<div class="noexport"><b>No new export this period</b>' +
         'Last measured <span class="win">' + esc(lastWindow) + '</span>. ' +
         'Figures from that window are intentionally not repeated here — they belong to the Aug 6 snapshot, ' +
         'not to this one. Switch the period selector to see them.</div>';
}

/* ── page chrome shared by both pages ─────────────────────────────────── */
function pageHeader(titleText, line1, line2, current) {
  return '<header>' +
    '<img src="' + LOGO + '" alt="Sanctuary Recovery Centers">' +
    '<div class="rtitle">' +
      '<div class="k">' + esc(titleText) + '</div>' +
      '<div class="s">' + line1 + '</div>' +
      '<div class="s">' + line2 + '</div>' +
    '</div></header>' +
    '<nav class="topnav">' +
      '<a href="index.html"' + (current === 'report' ? ' aria-current="page"' : '') + '>Report</a>' +
      '<a href="compare.html"' + (current === 'compare' ? ' aria-current="page"' : '') + '>Compare</a>' +
    '</nav><hr class="phoenix">';
}

function pageFooter(dataLine) {
  return '<hr class="phoenix"><footer>' +
    'Sanctuary Recovery Centers · True Healing &amp; Continued Care™ · Phoenix, AZ · (480) 999-0353<br>' +
    'Internal report. Source data windows: ' + esc(dataLine) + '. ' +
    'Channels without a new export for a period are shown blank rather than carried forward.' +
    '</footer>';
}

/* ── mobile stacked-table labels (re-run after every render) ──────────── */
function applyDataLabels(root) {
  (root || document).querySelectorAll('table').forEach(function (t) {
    var hs = [].map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
    if (!hs.length) { return; }
    t.querySelectorAll('tbody tr').forEach(function (tr) {
      [].forEach.call(tr.children, function (td, i) { if (hs[i]) { td.setAttribute('data-label', hs[i]); } });
    });
  });
}

/* ── card block ───────────────────────────────────────────────────────── */
function card(title, inner, note) {
  return '<div class="card">' + (title ? '<h3>' + esc(title) + '</h3>' : '') + inner +
         (note ? '<p class="note" style="font-size:11.5px;color:var(--muted);margin:6px 0 0">' + note + '</p>' : '') +
         '</div>';
}
function grid2(a, b) { return '<div class="grid2">' + a + b + '</div>'; }
