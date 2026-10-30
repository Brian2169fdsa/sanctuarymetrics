/* ============================================================================
   The AI cost review: once a day, after the Microsoft pull, Claude reads the
   rule findings (lib/m365-findings.js), the license table, renewals, the
   trend and what people already approved or declined, and writes
     - a ranked list of recommendations, each tied to a rule and to the exact
       accounts it covers, with why / action / HIPAA notes
     - the "Recommendations by lane" text on microsoft.html
   Real cuts it recommends go into the Cost cutting approval queue
   (cost_recommendations, source 'ai'). PEOPLE decide what gets cut: approving
   one makes a task on the Projects page; nothing changes in Microsoft here.

   Guard rails, enforced in code, not just asked of the model:
     - dollar figures are computed here from the accounts and the price list,
       never taken from the model
     - accounts must come from the rule's own candidate list (keep-listed and
       recently declined accounts are already out of it)
     - one open AI proposal per rule: tomorrow's run updates it in place
       instead of adding another; a rule with nobody left withdraws it

   Environment: ANTHROPIC_API_KEY (required), M365_MODEL (optional).
   ========================================================================== */

const Anthropic = require('@anthropic-ai/sdk');
const { supabase } = require('./db');
const A = require('./auth');
const F = require('./m365-findings');

const MODEL = process.env.M365_MODEL || 'claude-opus-5-5';
const TABLE = 'cost_recommendations';
const CATS = ['Cut now', 'Downgrade', 'Review', 'Watch', 'Keep'];
const MAX_ACCOUNTS = 60;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'recommendations', 'lanes'],
  properties: {
    headline: { type: 'string' },
    recommendations: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['finding', 'title', 'category', 'urgency', 'accounts', 'why', 'action', 'hipaa', 'send_for_approval'],
      properties: {
        finding: { type: 'string' }, title: { type: 'string' }, category: { type: 'string', enum: CATS },
        urgency: { type: 'string' }, accounts: { type: 'array', items: { type: 'string' } },
        why: { type: 'string' }, action: { type: 'string' }, hipaa: { type: 'string' }, send_for_approval: { type: 'boolean' }
      } } },
    lanes: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['k', 't', 's', 'saw', 'now', 'next', 'hip'],
      properties: {
        k: { type: 'string' }, t: { type: 'string' }, s: { type: 'string' },
        saw: { type: 'array', items: { type: 'string' } }, now: { type: 'array', items: { type: 'string' } },
        next: { type: 'array', items: { type: 'string' } }, hip: { type: 'string' }
      } } }
  }
};

const SYSTEM = [
  'You are the Microsoft 365 cost analyst for a behavioral-health treatment organisation (a HIPAA covered entity).',
  'Each day you get the latest license and usage data, a set of rule-based findings with candidate accounts, and the',
  'decisions people have already made. Your job: keep the Microsoft bill down without weakening security or compliance.',
  '',
  'Write `recommendations`, ranked by monthly dollars and urgency:',
  '- `finding` is the id of the rule finding it comes from, or "other" for something the rules don\'t cover.',
  '- `accounts` must be chosen from that finding\'s candidate list (user principal names, exactly as given). Leave out',
  '  any you have a concrete reason to doubt, and say why in `why`. Use [] for "other" and for seat-count findings.',
  '- Never state a dollar figure that isn\'t in the data; the site computes each recommendation\'s saving itself.',
  '- `send_for_approval`: true only for a concrete cut or downgrade someone should approve now. A finding already open',
  '  in the approval queue stays true (it is updated, not duplicated). Never true for Review, Watch or Keep.',
  '- Don\'t re-propose accounts people declined unless the data shows something new, and say what changed.',
  '- Business Premium is the security tier; cutting it is a compliance decision. Flag it, never send it for approval.',
  '- `why` cites the numbers; `action` is the concrete next step in the admin centre; `hipaa` is one sentence.',
  '',
  'Write `lanes`: 6–8 workload lanes (k is a 3-letter code: LIC, EML, TMS, SPT, OND, APP, SEC, GOV). For each, `t` the',
  'name, `s` a short headline figure from the data, `saw` 2–4 observations with numbers from the data, `now` 2–4 actions',
  'for this billing cycle, `next` 1–3 for the next 90 days, `hip` one HIPAA sentence. Bullets under 35 words.',
  '`headline`: one or two sentences on where the money is going and the single biggest lever today.',
  'Plain, direct language for a non-technical executive. No markdown.'
].join('\n');

function round(n) { return Math.round(n * 100) / 100; }
function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function short(l) { return l.replace('Microsoft 365 Business ', '').replace('Exchange Online (Plan 2)', 'EXO P2').replace('Microsoft ', ''); }

/* the facts Claude sees: totals, licenses, renewals, trend, findings with
   their candidate accounts, open/decided proposals, the keep list */
function brief(review, history, decided) {
  const P = {};
  review.people.forEach(function (p) { P[p.upn] = p; });
  const soon = new Date(Date.parse(review.ref) + 120 * 86400000).toISOString().slice(0, 10);
  return {
    organisation: review.org || '', data_as_of: review.ref, currency: 'USD per month, before tax',
    totals: review.totals, savings_if_all_rules_acted_on: review.savings,
    licenses: review.sku.map(function (k) { return { name: k.name, price: k.price, term: k.term, bought: k.total, assigned: k.assigned,
      unassigned: k.unassigned, used_30d: k.active30, blocked_or_idle_90d: k.wasted, monthly: k.monthly }; }),
    renewals_next_120_days: review.subs.filter(function (s) { return s.renew && s.renew <= soon; }),
    adoption_of_enabled_licensed: review.adoption, activity_buckets: review.buckets,
    sharepoint: { group_sites: review.sp.length, total_gb: review.sp_gb, dormant_180d: review.sp_dormant },
    teams: { teams: review.teams.length, with_no_channel_messages: review.teams_dormant, people_in_meetings_30d: review.teams_meet, people_chatting_30d: review.teams_chat },
    trend: history,
    keep_list: review.keep,
    findings: review.findings.map(function (f) {
      return { id: f.id, title: f.title, category: f.cat, monthly: f.monthly, rule_why: f.why, kept_by_keep_list: f.kept,
        candidates: f.users.slice(0, MAX_ACCOUNTS).map(function (u) {
          const p = P[u] || {};
          return { upn: u, name: p.name, title: p.title || undefined, licenses: (p.paid || []).map(short), days_idle: p.idle,
            blocked: p.blocked || undefined, mailbox: p.mbx_type || undefined, mailbox_gb: p.mbx_gb, sent_180d: p.sent, received_180d: p.recv,
            desktop_office: p.desktop, created: p.created };
        }), more_candidates_not_shown: Math.max(0, f.users.length - MAX_ACCOUNTS) };
    }),
    decisions_by_people: decided
  };
}

async function ask(review, history, decided) {
  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(brief(review, history, decided)) }]
  });
  if (response.stop_reason === 'refusal') { throw new Error('Claude declined the review.'); }
  if (response.stop_reason === 'max_tokens') { throw new Error('The review ran too long.'); }
  const text = response.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return { out: JSON.parse(text), model: response.model };
}

/* Claude's answer, checked against the rules: accounts limited to each
   finding's candidates, savings recomputed here */
function settle(review, out) {
  const byId = {}, P = {};
  review.findings.forEach(function (f) { byId[f.id] = f; });
  review.people.forEach(function (p) { P[p.upn] = p; });
  const recs = (out.recommendations || []).map(function (r) {
    const f = byId[r.finding];
    const cat = CATS.indexOf(r.category) >= 0 ? r.category : 'Review';
    let users = (r.accounts || []).map(function (u) { return String(u).trim().toLowerCase(); });
    users = f ? users.filter(function (u, i) { return f.users.indexOf(u) >= 0 && users.indexOf(u) === i; })
      : users.filter(function (u, i) { return P[u] && users.indexOf(u) === i; });
    let monthly = null;
    if (f && f.id === 'unassigned') { monthly = f.monthly; }
    else if (f) { monthly = round(users.reduce(function (s, u) { return s + F.perAccount(f.id, P[u], review.price); }, 0)); }
    const cuts = cat === 'Cut now' || cat === 'Downgrade';
    const queue = !!(r.send_for_approval && cuts && f && f.id !== 'premium' && monthly > 0 && (users.length || f.id === 'unassigned'));
    return { id: f ? f.id : 'other', title: String(r.title || (f && f.title) || '').slice(0, 200), cat: cat, urgency: String(r.urgency || '').slice(0, 80),
      users: users, monthly: monthly, why: String(r.why || '').slice(0, 1500), action: String(r.action || '').slice(0, 1000),
      hipaa: String(r.hipaa || '').slice(0, 500), queue: queue };
  });
  const lanes = (out.lanes || []).slice(0, 10).map(function (l) {
    const list = function (a, n) { return (a || []).slice(0, n).map(function (x) { return String(x).slice(0, 400); }); };
    return { k: String(l.k || '').slice(0, 4).toUpperCase(), t: String(l.t || '').slice(0, 80), s: String(l.s || '').slice(0, 60),
      saw: list(l.saw, 5), now: list(l.now, 5), next: list(l.next, 4), hip: String(l.hip || '').slice(0, 400) };
  });
  return { headline: String(out.headline || '').slice(0, 600), recommendations: recs, lanes: lanes };
}

/* ── the approval queue ──────────────────────────────────────────────────── */

function detailOf(r, review, P) {
  const lines = [r.why, '', 'Action: ' + r.action, 'HIPAA: ' + r.hipaa];
  if (r.users.length) {
    lines.push('', r.users.length + ' account' + (r.users.length === 1 ? '' : 's') + ':');
    r.users.forEach(function (u) {
      const p = P[u] || {};
      lines.push('• ' + (p.name || u) + ' — ' + u + ' — ' + (p.paid || []).map(short).join(' + ') +
        (p.blocked ? ' — sign-in blocked' : '') + (p.idle === null ? ' — no activity on record' : ' — idle ' + p.idle + 'd'));
    });
  }
  lines.push('', 'Proposed by the daily AI cost review from Microsoft data as of ' + review.ref +
    '. Approving makes a task; nothing changes in Microsoft until someone does it.');
  return lines.join('\n').slice(0, 3000);
}

/* proposals in, open AI rows updated or withdrawn; returns what changed */
async function syncQueue(review, settled) {
  const P = {};
  review.people.forEach(function (p) { P[p.upn] = p; });
  const open = await supabase('GET', '?source=eq.ai&status=eq.proposed&select=id,ai_key,title,monthly_saving,accounts', null, null, TABLE);
  const openBy = {};
  open.forEach(function (o) { openBy[o.ai_key] = o; });
  const now = new Date().toISOString();
  const made = [], updated = [], withdrawn = [];

  for (const r of settled.recommendations.filter(function (x) { return x.queue; })) {
    const key = 'm365:' + r.id;
    const row = { title: r.title, detail: detailOf(r, review, P), monthly_saving: r.monthly, accounts: r.users, updated_at: now };
    const cur = openBy[key];
    if (cur) {
      if (cur.title !== row.title || Number(cur.monthly_saving) !== r.monthly || JSON.stringify(cur.accounts || []) !== JSON.stringify(r.users)) {
        await supabase('PATCH', '?id=eq.' + cur.id + '&status=eq.proposed', row, { Prefer: 'return=minimal' }, TABLE);
        updated.push(cur.id);
      }
      delete openBy[key];
    } else {
      const rec = (await supabase('POST', '', Object.assign({ vendor: 'Microsoft', department: null, created_by: null, source: 'ai', ai_key: key }, row), null, TABLE))[0];
      made.push(rec);
    }
  }
  /* an open proposal whose rule has nobody left: withdraw it. One the model
     merely didn't mention today stays open. */
  const byId = {};
  review.findings.forEach(function (f) { byId[f.id] = f; });
  for (const key of Object.keys(openBy)) {
    const f = byId[key.replace(/^m365:/, '')];
    if (f && !f.users.length && !(f.id === 'unassigned' && f.monthly > 0)) {
      await supabase('PATCH', '?id=eq.' + openBy[key].id + '&status=eq.proposed', { status: 'withdrawn', decided_at: now,
        decision_note: 'No longer applies in the ' + review.ref + ' Microsoft data.', updated_at: now }, { Prefer: 'return=minimal' }, TABLE);
      withdrawn.push(openBy[key].id);
    }
  }
  if (made.length) {
    const ids = (await A.admins()).map(function (u) { return u.id; });
    await A.sendAlerts(ids, { kind: 'request', title: 'AI cost review: ' + made.length + ' new Microsoft cut' + (made.length === 1 ? '' : 's') + ' to approve',
      body: made.map(function (m) { return m.title + (m.monthly_saving ? ' (' + money(m.monthly_saving) + '/mo)' : ''); }).join('\n'), link: 'costs.html' });
  }
  return { created: made.length, updated: updated.length, withdrawn: withdrawn.length };
}

/* what people decided on earlier AI proposals, for the brief and for the
   rules' exclude list (approved = in hand; declined = don't ask again soon) */
async function decisions() {
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const rows = await supabase('GET', '?source=eq.ai&status=in.(approved,declined,proposed)&or=(status.eq.proposed,decided_at.gte."' + since + '")' +
    '&select=ai_key,title,status,decided_by_name,decided_at,decision_note,accounts&order=created_at.desc&limit=100', null, null, TABLE);
  const exclude = {};
  rows.forEach(function (r) {
    if (r.status === 'proposed' || !r.ai_key) { return; }
    const id = r.ai_key.replace(/^m365:/, '');
    const fresh = r.status === 'approved' ? Date.parse(r.decided_at) > Date.now() - 60 * 86400000 : true;
    if (fresh) { exclude[id] = (exclude[id] || []).concat(r.accounts || []); }
  });
  const brief = rows.map(function (r) {
    return { rule: (r.ai_key || '').replace(/^m365:/, ''), title: r.title, status: r.status === 'proposed' ? 'open, awaiting approval' : r.status,
      by: r.decided_by_name || undefined, on: r.decided_at ? r.decided_at.slice(0, 10) : undefined, note: r.decision_note || undefined,
      accounts: (r.accounts || []).length };
  });
  return { exclude: exclude, brief: brief };
}

module.exports = { MODEL: MODEL, SCHEMA: SCHEMA, brief: brief, ask: ask, settle: settle, syncQueue: syncQueue, decisions: decisions, detailOf: detailOf };
