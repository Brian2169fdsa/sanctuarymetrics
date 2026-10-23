/* ==========================================================================
   Account bar + alerts bell, shared by every page.

   Adds a slim bar above the page (outside #sheet, so page re-renders never
   wipe it): your name, the bell with the unread count, Account, Sign out —
   or a Sign in link. The bell checks for new alerts every 30 seconds while
   the tab is visible.

   Pages use window.SM:
     SM.ready            promise → the signed-in user, or null
     SM.me               same, once known
     SM.onUser(fn)       called now and whenever sign-in state changes
     SM.api(method, url, body)   JSON fetch that sends the session cookie
     SM.login(email, password)   → user
     SM.refreshBell()
   ========================================================================== */
(function () {
  var POLL_MS = 30000;
  var listeners = [];
  var SM = window.SM = { me: null, unread: 0 };

  function h(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ago(iso) {
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) { return 'just now'; }
    if (s < 3600) { return Math.floor(s / 60) + 'm ago'; }
    if (s < 86400) { return Math.floor(s / 3600) + 'h ago'; }
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  SM.h = h; SM.ago = ago;

  SM.api = function (method, url, body) {
    return fetch(url, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || ('Request failed (' + r.status + ')')); e.code = j.error; e.status = r.status; throw e; }
        return j;
      });
    });
  };
  /* hide what this person can't open (middleware.js blocks the pages
     themselves): classes on <html> switch off [data-need] links */
  function applyAccess() {
    var acc = (SM.me && SM.me.access) || { admin: false, reports: true, costs: false };
    var root = document.documentElement.classList;
    root.toggle('sm-no-reports', !acc.reports);
    root.toggle('sm-no-costs', !acc.costs);
    root.toggle('sm-no-admin', !acc.admin);
    root.toggle('sm-no-cpao-mail', !acc.cpao_mail);
    /* managers: only Home, HEAplus, Print orders and Social media */
    root.toggle('sm-limited', !!acc.limited_nav);
  }
  SM.can = function (what) { return !!(SM.me && SM.me.access && SM.me.access[what]); };
  function setUser(u) {
    SM.me = u || null;
    applyAccess();
    drawBar();
    listeners.forEach(function (fn) { try { fn(SM.me); } catch (e) { /* page bug */ } });
    if (SM.me) { SM.refreshBell(); }
  }
  SM.onUser = function (fn) { listeners.push(fn); };
  SM.login = function (email, password) {
    return SM.api('POST', '/api/auth', { action: 'login', email: email, password: password })
      .then(function (j) { setUser(j.user); return j.user; });
  };
  SM.logout = function () {
    setViewAs('');
    return SM.api('POST', '/api/auth', { action: 'logout' }).then(function () { setUser(null); }, function () { setUser(null); });
  };
  /* "View as" (admins): the whole site answers as that person, read-only.
     The server only honours it for a signed-in admin (lib/auth.js viewAs). */
  function setViewAs(email) {
    document.cookie = 'sm_view_as=' + encodeURIComponent(email || '') + '; Path=/; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '') + (email ? '; Max-Age=28800' : '; Max-Age=0');
  }
  SM.viewAs = function (email) { setViewAs(email); location.reload(); };
  var PEOPLE = null;
  function loadPeople() {
    if (PEOPLE) { return Promise.resolve(PEOPLE); }
    return SM.api('GET', '/api/auth?viewas=list').then(function (j) { PEOPLE = j.people || []; return PEOPLE; });
  }
  SM.setUser = setUser;

  /* ── styles ── */
  var css = document.createElement('style');
  css.textContent =
    '.sm-no-reports [data-need="reports"],.sm-no-costs [data-need="costs"],.sm-no-admin [data-need="admin"],.sm-no-cpao-mail [data-need="cpao-mail"],' +
      'html:not(.sm-no-reports) [data-need="staff-only"]{display:none!important}' +
    '.sm-limited .topnav a:not([href="home.html"]):not([href="cpao-admin.html"]):not([href="print.html"]):not([href="social.html"]){display:none!important}' +
    '#smbar{display:flex;justify-content:flex-end;align-items:center;gap:6px;padding:8px 20px;font:500 13px Inter,sans-serif;' +
      'background:#16263B;color:#dfe8ee;position:relative;z-index:50;flex-wrap:wrap}' +
    '#smbar a,#smbar button.l{all:unset;cursor:pointer;color:#dfe8ee;padding:4px 9px;border-radius:7px}' +
    '#smbar a:hover,#smbar button.l:hover{background:rgba(255,255,255,.1)}' +
    '#smbar a:focus-visible,#smbar button:focus-visible{outline:2px solid #1C9AD6;outline-offset:2px}' +
    '#smbar .who{color:#fff;font-weight:600;margin-right:4px}' +
    '#smbar .role{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#E17F55;margin-left:6px}' +
    '#smbell{all:unset;cursor:pointer;position:relative;display:grid;place-items:center;width:34px;height:30px;border-radius:8px}' +
    '#smbell:hover{background:rgba(255,255,255,.1)}' +
    '#smbell svg{width:19px;height:19px;fill:none;stroke:#fff;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}' +
    '#smbell b{position:absolute;top:0;right:0;min-width:17px;height:17px;padding:0 4px;box-sizing:border-box;border-radius:9px;' +
      'background:#E17F55;color:#fff;font-size:10.5px;font-weight:700;display:grid;place-items:center}' +
    '#smbell b[hidden]{display:none}' +
    '#smpanel{position:absolute;right:16px;top:calc(100% + 6px);width:min(400px,calc(100vw - 32px));max-height:min(560px,calc(100vh - 80px));' +
      'overflow:auto;background:#fff;color:#22323B;border-radius:14px;box-shadow:0 20px 50px rgba(22,38,59,.3);z-index:60}' +
    '#smpanel[hidden]{display:none}' +
    '#smpanel .hd{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #E4EBEF;' +
      'position:sticky;top:0;background:#fff}' +
    '#smpanel .hd b{font:600 17px Fraunces,serif}' +
    '#smpanel .hd button{all:unset;cursor:pointer;font-size:12px;font-weight:600;color:#1C9AD6}' +
    '#smpanel .al{all:unset;box-sizing:border-box;display:block;width:100%;cursor:pointer;padding:12px 16px;border-bottom:1px solid #E4EBEF}' +
    '#smpanel .al:hover{background:#f3f8fb}' +
    '#smpanel .al.new{background:#fdf6f1;box-shadow:inset 3px 0 0 #E17F55}' +
    '#smpanel .al .t{font-weight:600;font-size:13.5px;line-height:1.35}' +
    '#smpanel .al .b{font-size:12.5px;color:#4b5b65;margin-top:3px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;' +
      '-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line}' +
    '#smpanel .al .m{font-size:11.5px;color:#6C7C86;margin-top:4px}' +
    '#smpanel .empty{padding:26px 16px;text-align:center;color:#6C7C86;font-size:13px}' +
    '#smpanel .ft{padding:10px 16px;text-align:center}#smpanel .ft a{color:#1C9AD6;font-size:12.5px;font-weight:600}' +
    '.smms{display:inline-flex;align-items:center;gap:12px;height:41px;padding:0 14px;box-sizing:border-box;background:#fff;' +
      'border:1px solid #8c8c8c;border-radius:4px;color:#5e5e5e;font:600 15px "Segoe UI",Inter,sans-serif;text-decoration:none;cursor:pointer}' +
    '.smms:hover{background:#f3f3f3}.smms:focus-visible{outline:2px solid #1C9AD6;outline-offset:2px}' +
    '.smms svg{width:21px;height:21px;flex:none}' +
    '.smcard{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}' +
    '.smcard h3{margin:0 0 4px}.smcard p{margin:0;font-size:14px;line-height:1.5;max-width:560px}' +
    '.smgo{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 20px;border-radius:8px;background:#16263B;' +
      'color:#fff!important;font:700 14px Inter,sans-serif;text-decoration:none;white-space:nowrap}' +
    '.smgo:hover{background:#0f1b2b}.smgo:focus-visible{outline:2px solid #1C9AD6;outline-offset:2px}' +
    '#smbar .va{display:flex;align-items:center;gap:6px;color:#9fb3c2;margin-right:8px}' +
    '#smbar .va select{font:500 13px Inter,sans-serif;max-width:240px;padding:4px 6px;border-radius:7px;border:1px solid #3d5266;background:#1f3347;color:#fff}' +
    '#smview-bar{background:#5b2a86;color:#fff;font:500 13.5px Inter,sans-serif;padding:9px 20px;text-align:center}' +
    '#smview-bar button{all:unset;cursor:pointer;margin-left:8px;padding:3px 10px;border-radius:7px;background:#fff;color:#5b2a86;font-weight:700}' +
    '@media (max-width:640px){#smbar .va span{display:none}#smbar .va select{max-width:130px}}' +
    '#smnag{background:#fdf3e0;color:#7a4a24;font:500 13px Inter,sans-serif;padding:9px 20px;text-align:center}' +
    '#smnag a{color:#B23A1B;font-weight:700}';
  document.head.appendChild(css);

  /* ── the bar ── */
  var bar = document.createElement('div');
  bar.id = 'smbar';
  bar.setAttribute('role', 'navigation');
  bar.setAttribute('aria-label', 'Account');
  document.body.insertBefore(bar, document.body.firstChild);
  var nag = null;

  var BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
  function here() { return location.pathname.split('/').pop() || 'index.html'; }

  function drawBar() {
    var u = SM.me;
    if (!u) {
      bar.innerHTML = here() === 'account.html' ? '' :
        '<a href="' + h(SM.signInUrl()) + '">Sign in</a>';
    } else {
      bar.innerHTML =
        (SM.canViewAs ? '<label class="va"><span>View as</span><select id="smview" aria-label="View the site as">' +
          '<option value="">' + h(u.view_as ? (u.real_name || 'Me') + ' (me)' : 'Me') + '</option>' +
          (u.view_as ? '<option value="' + h(u.email) + '" selected>' + h(u.name) + '</option>' : '') +
          '</select></label>' : '') +
        '<span class="who">' + h(u.name) + (u.role === 'admin' ? '<span class="role">Admin</span>' : '') + '</span>' +
        '<button type="button" id="smbell" aria-haspopup="true" aria-expanded="false" aria-controls="smpanel" aria-label="Alerts">' +
          BELL + '<b id="smcount"' + (SM.unread ? '' : ' hidden') + '>' + (SM.unread > 99 ? '99+' : SM.unread) + '</b></button>' +
        '<a href="account.html">' + (u.role === 'admin' ? 'Admin' : 'Account') + '</a>' +
        '<button type="button" class="l" id="smout">Sign out</button>' +
        '<div id="smpanel" role="dialog" aria-label="Alerts" hidden></div>';
      document.getElementById('smbell').addEventListener('click', togglePanel);
      var sel = document.getElementById('smview');
      if (sel) {
        var filled = false;
        var fill = function () {
          if (filled) { return; }
          filled = true;
          loadPeople().then(function (list) {
            list.forEach(function (p) {
              if (u.view_as && p.email === u.email) { return; }
              var o = document.createElement('option'); o.value = p.email; o.textContent = p.name + ' — ' + p.sees; sel.appendChild(o);
            });
          }, function (e) {
            filled = false;
            var o = document.createElement('option'); o.disabled = true; o.textContent = 'Couldn\'t load people — ' + (e.message || 'try again'); sel.appendChild(o);
          });
        };
        fill();
        sel.addEventListener('change', function () { SM.viewAs(sel.value); });
      }
      document.getElementById('smout').addEventListener('click', function () {
        /* every page needs a sign-in now, so signing out goes back to the front door */
        SM.logout().then(function () { location.replace('login.html'); });
      });
    }
    /* first sign-in with a temporary password: nudge to choose a real one */
    if (nag) { nag.remove(); nag = null; }
    if (u && u.view_as) {
      nag = document.createElement('div');
      nag.id = 'smview-bar';
      nag.innerHTML = '👁 You\'re viewing the site as <b>' + h(u.name) + '</b> (' + h(u.email) + ') — exactly what they see. Read-only: nothing you do here saves. ' +
        '<button type="button" id="smview-off">Back to me</button>';
      bar.after(nag);
      document.getElementById('smview-off').addEventListener('click', function () { SM.viewAs(''); });
    } else if (u && u.must_change_password && here() !== 'account.html') {
      nag = document.createElement('div');
      nag.id = 'smnag';
      nag.innerHTML = 'You\'re using a temporary password. <a href="account.html#password">Choose your own</a>.';
      bar.after(nag);
    }
  }

  function setCount(n) {
    SM.unread = n;
    var b = document.getElementById('smcount');
    if (b) { b.textContent = n > 99 ? '99+' : n; b.hidden = !n; }
    document.title = document.title.replace(/^\(\d+\+?\) /, '') ;
    if (n) { document.title = '(' + (n > 99 ? '99+' : n) + ') ' + document.title; }
  }
  SM.refreshBell = function () {
    if (!SM.me) { return Promise.resolve(); }
    return SM.api('GET', '/api/alerts?count=1').then(function (j) { setCount(j.unread || 0); }, function () { /* offline */ });
  };

  /* ── the alerts panel ── */
  function panelOpen() { var p = document.getElementById('smpanel'); return p && !p.hidden; }
  function closePanel() {
    var p = document.getElementById('smpanel');
    if (p) { p.hidden = true; document.getElementById('smbell').setAttribute('aria-expanded', 'false'); }
  }
  function togglePanel(e) {
    e.stopPropagation();
    if (panelOpen()) { closePanel(); return; }
    var p = document.getElementById('smpanel');
    p.hidden = false;
    document.getElementById('smbell').setAttribute('aria-expanded', 'true');
    p.innerHTML = '<div class="hd"><b>Alerts</b></div><div class="empty">Loading…</div>';
    SM.api('GET', '/api/alerts').then(function (j) {
      setCount(j.unread || 0);
      var list = j.alerts || [];
      p.innerHTML = '<div class="hd"><b>Alerts</b>' + (j.unread ? '<button type="button" id="small">Mark all read</button>' : '') + '</div>' +
        (list.length ? list.map(function (a) {
          return '<button type="button" class="al' + (a.read_at ? '' : ' new') + '" data-id="' + h(a.id) + '" data-link="' + h(a.link || '') + '">' +
            '<div class="t">' + (a.kind === 'message' ? '💬 ' : a.kind === 'mention' ? '📣 ' : a.kind === 'request' ? '📝 ' : '') + h(a.title) + '</div>' +
            (a.body ? '<div class="b">' + h(a.body) + '</div>' : '') +
            '<div class="m">' + (a.from && a.from.name ? h(a.from.name) + ' · ' : '') + ago(a.created_at) + '</div></button>';
        }).join('') : '<div class="empty">No alerts yet.</div>') +
        '<div class="ft"><a href="account.html#alerts">See all</a></div>';
      var all = document.getElementById('small');
      if (all) {
        all.addEventListener('click', function () {
          SM.api('PATCH', '/api/alerts', { all: true }).then(function () {
            setCount(0);
            p.querySelectorAll('.al.new').forEach(function (x) { x.classList.remove('new'); });
            all.remove();
          });
        });
      }
      p.querySelectorAll('.al').forEach(function (el) {
        el.addEventListener('click', function () { openAlert(el.getAttribute('data-id'), el.getAttribute('data-link'), el); });
      });
    }, function (err) { p.innerHTML = '<div class="hd"><b>Alerts</b></div><div class="empty">' + h(err.message) + '</div>'; });
  }
  function openAlert(id, link, el) {
    var wasNew = el.classList.contains('new');
    el.classList.remove('new');
    var done = wasNew ? SM.api('PATCH', '/api/alerts', { ids: [id] }).then(SM.refreshBell, function () {}) : Promise.resolve();
    if (!link) { return; }
    done.then(function () {
      var target = new URL(link, location.href);
      if (target.pathname === location.pathname) {
        closePanel();
        location.hash = target.hash;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else {
        location.href = link;
      }
    });
  }
  document.addEventListener('click', function (e) {
    var p = document.getElementById('smpanel');
    if (p && !p.hidden && !p.contains(e.target)) { closePanel(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panelOpen()) { closePanel(); document.getElementById('smbell').focus(); } });

  setInterval(function () { if (document.visibilityState === 'visible') { SM.refreshBell(); } }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { SM.refreshBell(); } });

  /* Every sign-in button goes to Microsoft. SM.msConfigured says whether the
     server has its keys yet; until then /api/microsoft explains on account.html. */
  SM.microsoft = true;
  SM.msConfigured = false;
  /* the Microsoft button: four squares, per Microsoft's sign-in branding */
  SM.msButton = function (next, label) {
    return '<a class="smms" href="/api/microsoft?start=1&next=' + encodeURIComponent(next || 'projects.html') + '">' +
      '<svg viewBox="0 0 21 21" aria-hidden="true"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/>' +
      '<path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>' + h(label || 'Sign in with Microsoft') + '</a>';
  };
  /* every "Sign in" on the site goes to the one sign-in page, login.html,
     which offers Sign in with Microsoft (and a password only as a fallback) */
  SM.signInUrl = function (next) {
    next = next || (here() + location.hash);
    return 'login.html?next=' + encodeURIComponent(next);
  };
  /* the card a page shows when you need to be signed in */
  SM.signInCard = function (next, why) {
    return '<div class="card smcard"><div><h3>Sign in to continue</h3>' +
      '<p>' + h(why || 'Use your Sanctuary Microsoft account — the same login as Outlook and Teams.') + '</p></div>' +
      '<a class="smgo" href="' + h(SM.signInUrl(next)) + '">Sign in →</a></div>';
  };
  SM.ready = SM.api('GET', '/api/auth').then(function (j) { SM.msConfigured = !!j.microsoft; SM.canViewAs = !!j.can_view_as; return j.user; }, function () { return null; })
    .then(function (u) { setUser(u); return u; });
  drawBar();
})();
