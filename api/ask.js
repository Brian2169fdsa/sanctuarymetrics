/* ============================================================================
   /api/ask — the "ask the data" endpoint behind the chat popover.

   Reads the site's own data files, hands them to Claude as context, and
   streams the answer back as Server-Sent Events.

   Environment variables (set in Vercel → Settings → Environment Variables):

     ANTHROPIC_API_KEY   required. Server-side only — never reaches the browser.
     CHAT_PASSCODE       required unless CHAT_ALLOW_PUBLIC=true. A shared word
                         the widget asks for once. Without it this endpoint
                         refuses to run, because the production site is
                         reachable without a login and an open endpoint is an
                         open tab on your API bill.
     CHAT_ALLOW_PUBLIC   set to "true" to deliberately run with no passcode.
     CHAT_EFFORT         low (default) | medium | high. Chat Q&A does well at
                         low; raise it if answers feel shallow.

   It fails closed: missing key or missing passcode returns a clear message
   rather than running.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5';
const MAX_QUESTION = 2000;     /* characters */
const MAX_HISTORY = 20;        /* turns kept from the client */
const MAX_TOKENS = 8000;

/* ── load the site's data ──────────────────────────────────────────────────
   data.js is browser JavaScript — plain `var` declarations, no DOM access at
   the top level — so it runs safely in a throwaway VM context and we lift the
   globals straight out. Reading it this way means the chat can never drift
   out of sync with what the pages render: there is one copy of the data.     */
let CACHE = null;

function loadSiteData() {
  if (CACHE) { return CACHE; }
  const root = process.cwd();
  const sandbox = {};

  const dataPath = path.join(root, 'data.js');
  vm.runInNewContext(fs.readFileSync(dataPath, 'utf8'), sandbox, { timeout: 5000 });

  /* LOGO is a base64 PNG — hundreds of KB of no analytical value. */
  delete sandbox.LOGO;

  const parts = [];
  parts.push('## Reporting snapshots (the Report, Compare and Two-weeks pages)\n' +
    JSON.stringify({
      windows: sandbox.WINDOWS,
      reportOrder: sandbox.REPORT_ORDER,
      reports: sandbox.REPORTS,
      series: sandbox.SERIES,
      twoWeekOrder: sandbox.TWOWEEK_ORDER,
      twoWeekSets: sandbox.TWOWEEK_SETS,
      competitors: sandbox.COMPETITORS,
      biziq: sandbox.BIZIQ,
      l10: sandbox.L10
    }, null, 1));

  /* The SharePoint payload is a separate static file and may not exist yet. */
  let sharepoint = null;
  try {
    sharepoint = JSON.parse(fs.readFileSync(path.join(root, 'sharepoint-usage.json'), 'utf8'));
  } catch (e) { /* absent — that is a normal state, not an error */ }

  parts.push(sharepoint
    ? '## SharePoint / Teams usage\n' + JSON.stringify(sharepoint, null, 1)
    : '## SharePoint / Teams usage\nNo pull has been done yet — sharepoint-usage.json does not exist. ' +
      'If asked about SharePoint or Teams usage, say the data has not been connected yet rather than guessing.');

  CACHE = parts.join('\n\n');
  return CACHE;
}

const INSTRUCTIONS = `You answer questions about Sanctuary Recovery Centers' marketing performance data for the internal team at PHX Creative Works.

The complete dataset behind the report site is given to you below. It is the only source you have; you have no other access.

How to answer:
- Answer from the data. If a figure is not in it, say so plainly — never estimate, extrapolate or fill a gap.
- ALWAYS state the source window with any figure. This dataset deliberately runs different windows per channel (Facebook and Instagram on Meta's 28 days, LinkedIn lagging ~2 days, the website on Duda's 30-day preset), and a number without its window is misleading.
- Never add figures from different windows together, and never stack overlapping snapshots. The Sep 17 Meta window overlaps the Sep 3 one by about two weeks — they are separate snapshots of overlapping time, not two periods to sum.
- Unique/reach metrics are deduplicated by the platform and cannot be summed from daily rows.
- Be direct and brief. Lead with the answer, then the supporting figure and its window. Short paragraphs or tight bullets; no preamble.
- Where a number has a caveat recorded in the data (idle-session artifacts on two website pages, benchmark shifts, single-post inflation), carry the caveat with the number.
- If a question is ambiguous about which period or channel, say which one you used.
- You are read-only. You cannot change the site, run a data pull, or take any action.`;

/* ── helpers ──────────────────────────────────────────────────────────────── */
function sendJSON(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sse(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function readBody(req) {
  if (req.body) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }
  return new Promise(function (resolve, reject) {
    let raw = '';
    req.on('data', function (c) {
      raw += c;
      if (raw.length > 200000) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', function () {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ── handler ──────────────────────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    /* the widget calls this on open to find out whether it can be used */
    return sendJSON(res, 200, {
      ready: !!process.env.ANTHROPIC_API_KEY &&
             (!!process.env.CHAT_PASSCODE || process.env.CHAT_ALLOW_PUBLIC === 'true'),
      needsPasscode: !!process.env.CHAT_PASSCODE,
      reason: !process.env.ANTHROPIC_API_KEY
        ? 'ANTHROPIC_API_KEY is not set on this deployment.'
        : (!process.env.CHAT_PASSCODE && process.env.CHAT_ALLOW_PUBLIC !== 'true'
            ? 'No CHAT_PASSCODE is set. This site is reachable without a login, so the chat stays off until a passcode is set (or CHAT_ALLOW_PUBLIC=true).'
            : '')
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return sendJSON(res, 503, { error: 'Chat is not configured: ANTHROPIC_API_KEY is not set on this deployment.' });
  }
  if (!process.env.CHAT_PASSCODE && process.env.CHAT_ALLOW_PUBLIC !== 'true') {
    return sendJSON(res, 503, {
      error: 'Chat is not configured: no CHAT_PASSCODE is set. This site is reachable without a login, so the ' +
             'endpoint stays closed rather than leaving your API key open to anyone who finds the URL.'
    });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: 'Could not read the request.' }); }

  if (process.env.CHAT_PASSCODE && body.passcode !== process.env.CHAT_PASSCODE) {
    return sendJSON(res, 401, { error: 'Wrong passcode.' });
  }

  const question = String(body.question || '').trim();
  if (!question) { return sendJSON(res, 400, { error: 'No question given.' }); }
  if (question.length > MAX_QUESTION) {
    return sendJSON(res, 400, { error: 'Question is too long — keep it under ' + MAX_QUESTION + ' characters.' });
  }

  /* Only role and text survive from the client; nothing else is trusted. */
  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
  const messages = history
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
    .map(function (m) { return { role: m.role, content: m.content.slice(0, MAX_QUESTION) }; });
  messages.push({ role: 'user', content: question });

  let siteData;
  try { siteData = loadSiteData(); }
  catch (e) { return sendJSON(res, 500, { error: 'Could not read the site data: ' + e.message }); }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const client = new Anthropic();

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: process.env.CHAT_EFFORT || 'low' },
      system: [
        { type: 'text', text: INSTRUCTIONS },
        /* The dataset is identical on every request — cache it so repeat
           questions read the cached prefix instead of paying for it again. */
        { type: 'text', text: siteData, cache_control: { type: 'ephemeral' } }
      ],
      messages: messages
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        sse(res, 'delta', { text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      sse(res, 'error', { error: 'The model declined to answer that one.' });
    } else if (final.stop_reason === 'max_tokens') {
      sse(res, 'error', { error: 'Answer was cut off at the length limit — try a narrower question.' });
    }
    sse(res, 'done', { usage: final.usage || null });
    res.end();
  } catch (error) {
    let msg = 'Something went wrong talking to the model.';
    if (error instanceof Anthropic.AuthenticationError) {
      msg = 'The API key on this deployment was rejected.';
    } else if (error instanceof Anthropic.RateLimitError) {
      msg = 'Rate limited — wait a moment and ask again.';
    } else if (error instanceof Anthropic.BadRequestError) {
      msg = 'The request was rejected: ' + error.message;
    } else if (error instanceof Anthropic.APIError) {
      msg = 'API error ' + error.status + ': ' + error.message;
    }
    if (res.headersSent) { sse(res, 'error', { error: msg }); res.end(); }
    else { sendJSON(res, 500, { error: msg }); }
  }
};
