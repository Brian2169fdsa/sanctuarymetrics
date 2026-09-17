/* ============================================================================
   Ask the data — floating chat popover, loaded on every page.

   Talks to /api/ask, which holds the API key server-side. Nothing sensitive
   lives here; this file is public.

   Degrades honestly: if the endpoint is missing (a plain static preview) or
   not configured, the panel opens and says exactly what is missing instead of
   failing silently.
   ========================================================================== */
(function () {
  'use strict';

  var PASS_KEY = 'src_chat_pass';
  var state = {
    open: false,
    status: 'unknown',    /* unknown | ready | needs-passcode | unavailable */
    reason: '',
    busy: false,
    history: [],          /* {role, content} — sent back for context */
    error: ''
  };

  /* ── styles ─────────────────────────────────────────────────────────── */
  var css = '' +
    '#srcchat-btn{position:fixed;right:20px;bottom:20px;z-index:9998;border:0;cursor:pointer;' +
      'background:var(--teal,#2C5468);color:#fff;border-radius:26px;padding:13px 20px;font:600 14px/1 Inter,sans-serif;' +
      'box-shadow:0 6px 24px rgba(34,50,59,.28);display:flex;align-items:center;gap:9px}' +
    '#srcchat-btn:hover{background:#22434f}' +
    '#srcchat-btn .dot{width:8px;height:8px;border-radius:50%;background:#7FD1AE;display:inline-block}' +
    '#srcchat{position:fixed;right:20px;bottom:20px;z-index:9999;width:420px;max-width:calc(100vw - 32px);' +
      'height:620px;max-height:calc(100vh - 40px);background:#fff;border-radius:14px;display:flex;flex-direction:column;' +
      'overflow:hidden;box-shadow:0 16px 60px rgba(34,50,59,.30);border:1px solid var(--line,#E4EBEF)}' +
    '#srcchat header{background:var(--teal,#2C5468);color:#fff;padding:14px 16px;display:flex;align-items:center;' +
      'justify-content:space-between;gap:10px;flex:0 0 auto}' +
    '#srcchat header .t{font:600 15px/1.2 Fraunces,Georgia,serif}' +
    '#srcchat header .s{font:400 11.5px/1.3 Inter,sans-serif;opacity:.82;margin-top:2px}' +
    '#srcchat header button{background:transparent;border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer;' +
      'padding:4px 6px;border-radius:6px;opacity:.85}' +
    '#srcchat header button:hover{background:rgba(255,255,255,.16);opacity:1}' +
    '#srcchat .log{flex:1 1 auto;overflow-y:auto;padding:16px;background:var(--paper,#F6F9FB)}' +
    '#srcchat .msg{margin:0 0 12px;font:400 13.5px/1.55 Inter,sans-serif;white-space:pre-wrap;word-wrap:break-word}' +
    '#srcchat .msg.u{background:var(--teal,#2C5468);color:#fff;padding:9px 13px;border-radius:13px 13px 3px 13px;' +
      'margin-left:auto;max-width:86%;width:fit-content}' +
    '#srcchat .msg.a{background:#fff;color:var(--ink,#22323B);padding:11px 13px;border-radius:13px 13px 13px 3px;' +
      'border:1px solid var(--line,#E4EBEF);max-width:94%}' +
    '#srcchat .msg.a b{font-weight:700}' +
    '#srcchat .note{font:400 12px/1.5 Inter,sans-serif;color:var(--muted,#6C7C86);background:#fff;border:1px dashed #cbd8df;' +
      'border-radius:10px;padding:12px 13px;margin:0 0 12px}' +
    '#srcchat .note b{display:block;color:var(--teal,#2C5468);margin-bottom:3px}' +
    '#srcchat .err{border-color:#e8b4a6;background:#fdf6f3;color:#8C2A14}' +
    '#srcchat .tips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 12px}' +
    '#srcchat .tips button{font:600 11.5px/1 Inter,sans-serif;background:#fff;border:1px solid var(--line,#E4EBEF);' +
      'color:var(--teal,#2C5468);border-radius:20px;padding:7px 11px;cursor:pointer;text-align:left}' +
    '#srcchat .tips button:hover{border-color:#cfdbe2;background:#fbfdfe}' +
    '#srcchat form{flex:0 0 auto;border-top:1px solid var(--line,#E4EBEF);padding:11px;display:flex;gap:8px;background:#fff}' +
    '#srcchat textarea{flex:1;resize:none;border:1px solid var(--line,#E4EBEF);border-radius:9px;padding:9px 11px;' +
      'font:400 13.5px/1.45 Inter,sans-serif;color:var(--ink,#22323B);max-height:110px;min-height:40px}' +
    '#srcchat textarea:focus{outline:2px solid var(--blue,#1C9AD6);outline-offset:-1px}' +
    '#srcchat form button{background:var(--teal,#2C5468);color:#fff;border:0;border-radius:9px;padding:0 16px;' +
      'font:600 13px/1 Inter,sans-serif;cursor:pointer;min-height:40px}' +
    '#srcchat form button:disabled{opacity:.45;cursor:default}' +
    '#srcchat .foot{font:400 10.5px/1.4 Inter,sans-serif;color:var(--muted,#6C7C86);padding:0 11px 10px;background:#fff}' +
    '#srcchat .cursor{display:inline-block;width:7px;height:14px;background:var(--blue,#1C9AD6);' +
      'vertical-align:-2px;animation:srcblink 1s steps(2) infinite}' +
    '@keyframes srcblink{50%{opacity:0}}' +
    '@media (max-width:560px){#srcchat{right:8px;left:8px;bottom:8px;width:auto;height:calc(100vh - 16px)}' +
      '#srcchat-btn{right:14px;bottom:14px}}' +
    '@media print{#srcchat,#srcchat-btn{display:none}}';

  var PROMPTS = [
    'What changed most this period?',
    'Why did Facebook reach drop?',
    'How is the website converting?',
    'What should we do about Instagram?'
  ];

  /* ── helpers ────────────────────────────────────────────────────────── */
  function h(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /* Minimal, deliberately narrow: **bold** and bullet lines only. Everything
     else is escaped and shown literally — no HTML from the model reaches the
     DOM unescaped. */
  function fmt(text) {
    return h(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^[-*]\s+/gm, '• ');
  }
  function el(id) { return document.getElementById(id); }
  function scroll() { var l = el('srcchat-log'); if (l) { l.scrollTop = l.scrollHeight; } }

  function pass() {
    try { return sessionStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; }
  }
  function setPass(v) {
    try { sessionStorage.setItem(PASS_KEY, v); } catch (e) { /* private mode */ }
  }

  /* ── render ─────────────────────────────────────────────────────────── */
  function render() {
    var root = el('srcchat');
    if (!root) { return; }
    var log = el('srcchat-log');

    var body = '';
    if (state.status === 'unavailable') {
      body += '<div class="note err"><b>Chat is not switched on yet</b>' + h(state.reason) +
              '<br><br>Set the environment variables in Vercel and redeploy — the steps are in CHAT.md.</div>';
    } else if (state.status === 'needs-passcode' && !pass()) {
      body += '<div class="note"><b>Passcode needed</b>This site is reachable without a login, so the chat is behind ' +
              'a shared passcode. Enter it below — it is remembered for this browser tab only.</div>';
    } else if (!state.history.length) {
      body += '<div class="note"><b>Ask about the data on this site</b>Every snapshot, channel, two-week cut and ' +
              'SharePoint pull is loaded. Answers come with their source window, and anything not in the data gets ' +
              'a straight "not in the data" rather than a guess.</div>';
      body += '<div class="tips">';
      PROMPTS.forEach(function (p) { body += '<button type="button" data-p="' + h(p) + '">' + h(p) + '</button>'; });
      body += '</div>';
    }

    state.history.forEach(function (m) {
      body += '<div class="msg ' + (m.role === 'user' ? 'u' : 'a') + '">' +
              (m.role === 'user' ? h(m.content) : fmt(m.content)) +
              (m.streaming ? '<span class="cursor"></span>' : '') + '</div>';
    });

    if (state.error) { body += '<div class="note err"><b>Error</b>' + h(state.error) + '</div>'; }

    log.innerHTML = body;
    scroll();

    var ta = el('srcchat-input');
    var send = el('srcchat-send');
    var needPass = state.status === 'needs-passcode' && !pass();
    ta.placeholder = needPass ? 'Enter the passcode…'
      : (state.status === 'unavailable' ? 'Unavailable' : 'Ask about the data…');
    ta.disabled = state.status === 'unavailable';
    send.disabled = state.busy || state.status === 'unavailable';
    send.textContent = state.busy ? '…' : (needPass ? 'Unlock' : 'Ask');
  }

  /* ── network ────────────────────────────────────────────────────────── */
  function probe() {
    fetch('/api/ask', { method: 'GET' })
      .then(function (r) {
        if (!r.ok) { throw new Error('HTTP ' + r.status); }
        return r.json();
      })
      .then(function (info) {
        if (info.ready) { state.status = info.needsPasscode ? 'needs-passcode' : 'ready'; }
        else { state.status = 'unavailable'; state.reason = info.reason || 'Not configured.'; }
      })
      .catch(function () {
        state.status = 'unavailable';
        state.reason = 'No /api/ask endpoint responded. On a static preview with no serverless functions ' +
                       'that is expected; on the live site it means the deployment has not picked up the function yet.';
      })
      .then(render);
  }

  function ask(question) {
    state.busy = true;
    state.error = '';
    state.history.push({ role: 'user', content: question });
    var reply = { role: 'assistant', content: '', streaming: true };
    state.history.push(reply);
    render();

    var sent = state.history.slice(0, -2).map(function (m) {
      return { role: m.role, content: m.content };
    });

    fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question, history: sent, passcode: pass() })
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); },
                             function () { throw new Error('HTTP ' + r.status); });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) { return; }
          buf += dec.decode(res.value, { stream: true });
          var chunks = buf.split('\n\n');
          buf = chunks.pop();
          chunks.forEach(function (chunk) {
            var ev = '', data = '';
            chunk.split('\n').forEach(function (line) {
              if (line.indexOf('event: ') === 0) { ev = line.slice(7); }
              else if (line.indexOf('data: ') === 0) { data += line.slice(6); }
            });
            if (!data) { return; }
            var parsed;
            try { parsed = JSON.parse(data); } catch (e) { return; }
            if (ev === 'delta') { reply.content += parsed.text; render(); }
            else if (ev === 'error') { state.error = parsed.error; }
          });
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      state.error = e.message || String(e);
      if (/passcode/i.test(state.error)) { setPass(''); state.status = 'needs-passcode'; }
    }).then(function () {
      reply.streaming = false;
      if (!reply.content) { state.history.pop(); }
      state.busy = false;
      render();
      var ta = el('srcchat-input');
      if (ta) { ta.focus(); }
    });
  }

  function submit() {
    var ta = el('srcchat-input');
    var value = (ta.value || '').trim();
    if (!value || state.busy) { return; }

    if (state.status === 'needs-passcode' && !pass()) {
      setPass(value);
      ta.value = '';
      state.error = '';
      render();
      return;
    }
    ta.value = '';
    ask(value);
  }

  /* ── mount ──────────────────────────────────────────────────────────── */
  function openPanel() {
    state.open = true;
    el('srcchat-btn').style.display = 'none';

    var panel = document.createElement('div');
    panel.id = 'srcchat';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Ask about the data');
    panel.innerHTML =
      '<header><div><div class="t">Ask the data</div>' +
      '<div class="s">Answers come from this site\'s own figures</div></div>' +
      '<button type="button" id="srcchat-close" aria-label="Close">&times;</button></header>' +
      '<div class="log" id="srcchat-log"></div>' +
      '<form id="srcchat-form">' +
        '<textarea id="srcchat-input" rows="1" aria-label="Your question"></textarea>' +
        '<button type="submit" id="srcchat-send">Ask</button>' +
      '</form>' +
      '<div class="foot">Read-only. Nothing here changes the site or the source data.</div>';
    document.body.appendChild(panel);

    el('srcchat-close').addEventListener('click', closePanel);
    el('srcchat-form').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    el('srcchat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    el('srcchat-log').addEventListener('click', function (e) {
      var p = e.target.getAttribute && e.target.getAttribute('data-p');
      if (p) { ask(p); }
    });
    document.addEventListener('keydown', escClose);

    render();
    if (state.status === 'unknown') { probe(); }
    el('srcchat-input').focus();
  }

  function closePanel() {
    state.open = false;
    var p = el('srcchat');
    if (p) { p.parentNode.removeChild(p); }
    el('srcchat-btn').style.display = '';
    document.removeEventListener('keydown', escClose);
  }

  function escClose(e) { if (e.key === 'Escape') { closePanel(); } }

  function mount() {
    if (el('srcchat-btn')) { return; }
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'srcchat-btn';
    btn.type = 'button';
    btn.innerHTML = '<span class="dot"></span>Ask the data';
    btn.addEventListener('click', openPanel);
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
