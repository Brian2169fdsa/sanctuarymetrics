/* ============================================================================
   /api/social — event photos from the team, turned into social posts.

   Staff send photos and a few words about an event (social.html). On submit:
     - it becomes a task on the Projects page (so it shows in their "My
       requests" with a message thread), owned by marketing
     - the admins get a bell alert, and a Teams message if TEAMS_WEBHOOK_URL
       is set (a Teams "Workflows" webhook — see SOCIAL.md)
     - Claude looks at the photos and the description and drafts a Facebook,
       Instagram and LinkedIn post, hashtags, alt text and a privacy check
   Admins review the drafts, edit, copy, post, and mark it posted.

   Photos live in the PRIVATE storage bucket "social" (supabase/social.sql):
   <id>/p<n>.webp full size, <id>/t<n>.webp thumbnail. Reads hand back
   short-lived signed links, only to signed-in people who may see the post.

   Routes (signed in):
     GET    ?count=1          admins: how many posts are waiting
     GET                      admins: every post; staff: their own
     GET    ?id=…             one post with signed links for every photo
     POST   {event_title, event_date, location, description, consent, photo_count}
                              start a submission → {post}; it stays "uploading"
     PUT    ?id=…&n=…&kind=p|t   upload one photo (raw image body)
     POST   ?id=…&action=submit   finish: task, alerts, Teams, Claude's draft
     POST   ?id=…&action=draft {instructions?}   admins: redraft
     PATCH  ?id=… {draft?, status?, posted_where?, post_url?}   admins
     DELETE ?id=…             admins, or the submitter before it's posted
     POST   ?id=…&action=publish {facebook?:{text, photos:[n]}, linkedin?:{text, photo:n}, checked:true}
                              admins: hand the post to the Make scenario that
                              publishes it on the Facebook Page and the
                              LinkedIn company page (SOCIAL.md → "Publishing")
     POST   ?id=…&action=published {token, platform, ok, id?, error?}
                              the Make scenario reporting back, one call per
                              platform; no sign-in, checked against the
                              one-time token sent with that publish

   Photos are also kept as JPEG (<id>/j<n>.jpg) for publishing: Facebook and
   LinkedIn don't reliably take WebP.

   Environment variables:
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
     ANTHROPIC_API_KEY   required for the drafts (submissions work without it)
     SOCIAL_MODEL        optional; defaults to claude-opus-5-5
     TEAMS_WEBHOOK_URL   optional; a Teams Workflows webhook for the heads-up
     SITE_URL            optional; the site's address for links in Teams
                         (defaults to the address the request came in on)
     PRINT_OWNER         optional; who the task is assigned to (Brian Reinhart)
     SOCIAL_PUBLISH_WEBHOOK_URL  optional; the Make webhook that publishes to
                         Facebook and LinkedIn. Without it, posting is by hand.
   ========================================================================== */

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const { sendJSON, readBody, supabase, projectWrite, addedBy } = require('../lib/db');
const A = require('../lib/auth');
const S = require('../lib/storage');

const BUCKET = 'social';
const TABLE = 'social_posts';
const ID = /^[0-9a-f-]{36}$/i;
const MAX_PHOTOS = 10;
const MAX_IMAGE = 3 * 1024 * 1024;
const MAX_TO_CLAUDE = 6;
const MODEL = process.env.SOCIAL_MODEL || 'claude-opus-5-5';
const PLATFORMS = ['Facebook', 'Instagram', 'LinkedIn', 'Other'];
const bad = S.bad;

function str(v, max) { return v === null || v === undefined ? '' : String(v).trim().slice(0, max); }
function photoPath(id, kind, n) { return id + '/' + kind + n + (kind === 'j' ? '.jpg' : '.webp'); }
function publishUrl() { const u = str(process.env.SOCIAL_PUBLISH_WEBHOOK_URL, 500); return /^https:\/\/\S+$/.test(u) ? u : ''; }
const PUBLISH_TO = { facebook: 'Facebook', linkedin: 'LinkedIn' };
const PUBLISH_WAIT_MS = 5 * 60 * 1000;   /* a publish with no answer after this can be tried again */
function siteUrl(req) {
  const env = str(process.env.SITE_URL, 200).replace(/\/+$/, '');
  if (env) { return env; }
  return 'https://' + String(req.headers['x-forwarded-host'] || req.headers.host || 'sanctuarymetrics.vercel.app').split(',')[0].trim();
}
function canSee(me, post) { return A.access(me).admin || post.created_by === me.id; }

/* ── Claude's draft ───────────────────────────────────────────────────── */
const SYSTEM = [
  'You write social media posts for Sanctuary Recovery Centers, an addiction treatment and mental health provider in',
  'Phoenix, Arizona (tagline: "True Healing & Continued Care"; website SanctuaryRC.com). Staff send photos and a short',
  'description of something that happened — a community event, a resource fair, a staff training, a milestone — and',
  'you turn it into ready-to-post copy.',
  '',
  'Voice: warm, hopeful, grounded and community-minded. Recovery-positive, person-first language ("people in',
  'recovery", "people we serve", never "addicts" or "abusers"). No clinical or outcome claims, no promises, no',
  'fundraising asks unless the description asks for one.',
  '',
  'Privacy comes first. Sanctuary serves people in treatment: never say or imply that anyone pictured is a client,',
  'patient or in recovery, never name anyone the description does not name, and never mention diagnoses. If a',
  'photo shows anything that could identify a client — a face the description doesn\'t identify as staff or a',
  'partner, a name badge, paperwork, a screen, a house number — say so plainly in privacy_check so a person',
  'reviews it before posting. If nothing stands out, privacy_check says so in one short sentence.',
  '',
  'Write, from the same facts:',
  '- facebook: 2–4 short paragraphs, friendly, may end with SanctuaryRC.com',
  '- instagram: a caption with a strong first line, short lines, a few relevant emoji at most, no links (say "link in bio" only if useful)',
  '- linkedin: professional and community-focused, 1–3 short paragraphs, credits partners by name when the description names them',
  '- hashtags: 5–10 relevant hashtags without spaces, each starting with #',
  '- alt_text: one plain description per photo, in the order given, without naming people',
  'Use only the facts given and what the photos plainly show; never invent names, numbers, dates or quotes.'
].join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facebook', 'instagram', 'linkedin', 'hashtags', 'alt_text', 'privacy_check'],
  properties: {
    facebook: { type: 'string' },
    instagram: { type: 'string' },
    linkedin: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
    alt_text: { type: 'array', items: { type: 'string' } },
    privacy_check: { type: 'string' }
  }
};

async function draftPost(post, instructions) {
  if (!process.env.ANTHROPIC_API_KEY) { throw new Error('Claude isn\'t connected yet — add ANTHROPIC_API_KEY in Vercel.'); }
  const n = Math.min(post.photo_count, MAX_TO_CLAUDE);
  const images = [];
  for (let i = 1; i <= n; i++) {
    const buf = await S.download(BUCKET, photoPath(post.id, 'p', i));
    images.push({ type: 'image', source: { type: 'base64', media_type: S.imageType(buf) || 'image/webp', data: buf.toString('base64') } });
  }
  const facts = [
    'Event: ' + post.event_title,
    post.event_date ? 'Date: ' + post.event_date : null,
    post.location ? 'Where: ' + post.location : null,
    'Sent in by: ' + (post.created_by_name || 'a staff member'),
    '',
    'What happened (from the staff member):',
    post.description,
    post.photo_count > n ? '\n(' + post.photo_count + ' photos were sent; the first ' + n + ' are attached.)' : null,
    instructions ? '\nMarketing asked for this redraft: ' + instructions : null
  ].filter(function (l) { return l !== null; }).join('\n');

  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: images.concat([{ type: 'text', text: facts }]) }]
  });
  if (response.stop_reason === 'refusal') { throw new Error('Claude declined to draft this one — write it by hand, or redraft with more detail.'); }
  if (response.stop_reason === 'max_tokens') { throw new Error('The draft ran too long — try redrafting.'); }
  const text = response.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  const d = JSON.parse(text);
  return {
    draft: {
      facebook: str(d.facebook, 5000), instagram: str(d.instagram, 2200), linkedin: str(d.linkedin, 3000),
      hashtags: (d.hashtags || []).map(function (h) { return str(h, 60); }).filter(Boolean).slice(0, 15),
      alt_text: (d.alt_text || []).map(function (h) { return str(h, 400); }).slice(0, MAX_PHOTOS),
      privacy_check: str(d.privacy_check, 1000)
    },
    model: response.model
  };
}
/* draft and save; a failure is stored on the post, never thrown */
async function draftAndSave(post, instructions) {
  try {
    const r = await draftPost(post, instructions);
    return (await supabase('PATCH', '?id=eq.' + post.id, { draft: r.draft, draft_model: r.model, drafted_at: new Date().toISOString(),
      draft_error: null, updated_at: new Date().toISOString() }, null, TABLE))[0];
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? 'Claude couldn\'t draft it right now (' + (e.status || 'error') + '). Try Redraft in a minute.'
      : e instanceof SyntaxError ? 'Claude\'s draft came back garbled. Try Redraft.' : str(e.message, 300);
    return (await supabase('PATCH', '?id=eq.' + post.id, { draft_error: msg, updated_at: new Date().toISOString() }, null, TABLE))[0];
  }
}

/* ── the Teams heads-up ───────────────────────────────────────────────── */
async function notifyTeams(post, link) {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url || !/^https?:\/\//.test(url)) { return false; }
  const facts = [{ title: 'Event', value: post.event_title }, { title: 'From', value: post.created_by_name || '—' },
                 { title: 'Photos', value: String(post.photo_count) }];
  if (post.event_date) { facts.push({ title: 'Date', value: post.event_date }); }
  if (post.location) { facts.push({ title: 'Where', value: post.location }); }
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: [
          { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: '📸 New social post to create', wrap: true },
          { type: 'FactSet', facts: facts },
          { type: 'TextBlock', text: post.description.length > 400 ? post.description.slice(0, 397) + '…' : post.description, wrap: true }
        ],
        actions: [{ type: 'Action.OpenUrl', title: 'Review & post', url: link }]
      }
    }]
  };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) });
    return r.ok;
  } catch (e) { return false; }
}

/* ── helpers ──────────────────────────────────────────────────────────── */
async function withPhotos(post, all) {
  const n = all ? post.photo_count : Math.min(post.photo_count, 4);
  const paths = [];
  for (let i = 1; i <= n; i++) {
    paths.push(photoPath(post.id, 't', i));
    if (all) { paths.push(photoPath(post.id, 'p', i), photoPath(post.id, 'j', i)); }
  }
  const urls = await S.sign(BUCKET, paths);
  post.photos = [];
  for (let i = 1; i <= n; i++) {
    post.photos.push({ n: i, thumb: urls[photoPath(post.id, 't', i)] || null, full: all ? urls[photoPath(post.id, 'p', i)] || null : null,
                       jpeg: all ? !!urls[photoPath(post.id, 'j', i)] : undefined });
  }
  /* the one-time token stays on the server */
  if (post.publish) { post.publish = Object.assign({}, post.publish); delete post.publish.token; }
  return post;
}
function cleanSubmission(b) {
  const out = {
    event_title: str(b.event_title, 200), location: str(b.location, 200) || null,
    description: str(b.description, 3000), event_date: str(b.event_date, 10) || null
  };
  if (!out.event_title) { throw bad('Give the event a name.'); }
  if (!out.description) { throw bad('Say a few words about what happened.'); }
  if (out.event_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.event_date)) { throw bad('The date doesn\'t look right.'); }
  if (b.consent !== true) { throw bad('Please confirm the photos are OK to share.'); }
  const n = Number(b.photo_count);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PHOTOS) { throw bad('Add 1–' + MAX_PHOTOS + ' photos.'); }
  out.photo_count = n;
  out.consent = true;
  return out;
}
function cleanDraft(d) {
  d = d || {};
  return {
    facebook: str(d.facebook, 5000), instagram: str(d.instagram, 2200), linkedin: str(d.linkedin, 3000),
    hashtags: (Array.isArray(d.hashtags) ? d.hashtags : []).map(function (h) { return str(h, 60); }).filter(Boolean).slice(0, 15),
    alt_text: (Array.isArray(d.alt_text) ? d.alt_text : []).map(function (h) { return str(h, 400); }).slice(0, MAX_PHOTOS),
    privacy_check: str(d.privacy_check, 1000)
  };
}

/* ── publishing to Facebook and LinkedIn (through Make) ───────────────── */
/* mark it posted: the task is ticked off and the sender is told */
async function markPosted(post, fields, by) {
  const now = new Date().toISOString();
  const saved = (await supabase('PATCH', '?id=eq.' + post.id + '&select=*', Object.assign({ status: 'posted', posted_at: now,
    posted_by_name: by.name, updated_at: now }, fields), null, TABLE))[0];
  if (post.project_id) {
    try { await projectWrite('PATCH', '?id=eq.' + post.project_id, { status: 'Complete', updated_at: now, updated_by_name: by.name }); }
    catch (e) { /* the task may have been removed */ }
  }
  if (post.status !== 'posted' && post.created_by && post.created_by !== by.id) {
    await A.sendAlerts([post.created_by], { from_user_id: by.id || null, kind: 'alert',
      title: 'Your photos are posted: ' + post.event_title,
      body: 'Thanks for sending them in!' + (saved.posted_where ? ' Live on ' + saved.posted_where + '.' : ''),
      link: saved.post_url || 'social.html' });
  }
  return saved;
}
function postLink(platform, id) {
  id = str(id, 200);
  if (!id) { return null; }
  if (platform === 'facebook') { return /^[0-9_]+$/.test(id) ? 'https://www.facebook.com/' + id : null; }
  return /^urn:li:(share|ugcPost|activity):[0-9]+$/.test(id) ? 'https://www.linkedin.com/feed/update/' + id + '/' : null;
}
/* LinkedIn reads post text as "little text format": ( ) [ ] { } < > @ | ~ _ * # and \
   are codes, and an unescaped one can cut the post short. Escape them all,
   then turn #words back into real, clickable hashtags. */
function linkedinText(t) {
  return String(t || '').replace(/[\\|{}@\[\]()<>#*_~]/g, function (c) { return '\\' + c; })
    .replace(/\\#([A-Za-z0-9][A-Za-z0-9_\\]*)/g, function (m, tag) { return '{hashtag|\\#|' + tag.replace(/\\_/g, '_') + '}'; });
}
function sameToken(a, b) {
  a = Buffer.from(String(a || '')); b = Buffer.from(String(b || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/* the admin pressed "Publish now": check it, then hand it to Make */
async function startPublish(req, post, me, b) {
  const hook = publishUrl();
  if (!hook) { throw bad('Automatic posting isn\'t connected yet: add SOCIAL_PUBLISH_WEBHOOK_URL in Vercel (see SOCIAL.md).'); }
  if (b.checked !== true) { throw bad('Tick the box to confirm you\'ve checked the photos and the privacy note.'); }
  const pub = post.publish || {};
  if (pub.state === 'sending' && Date.now() - new Date(pub.at).getTime() < PUBLISH_WAIT_MS) {
    throw bad('This post is already being published — give it a minute.');
  }
  const done = pub.results || {};
  const want = {};
  const fb = b.facebook, li = b.linkedin;
  if (fb) {
    const photos = (Array.isArray(fb.photos) ? fb.photos : []).map(Number)
      .filter(function (n, i, a) { return Number.isInteger(n) && n >= 1 && n <= post.photo_count && a.indexOf(n) === i; }).slice(0, MAX_PHOTOS);
    if (!str(fb.text, 5000)) { throw bad('The Facebook post has no text.'); }
    if (!photos.length) { throw bad('Pick at least one photo for Facebook.'); }
    want.facebook = { text: str(fb.text, 5000), photos: photos };
  }
  if (li) {
    const n = Number(li.photo);
    if (!str(li.text, 3000)) { throw bad('The LinkedIn post has no text.'); }
    if (!(Number.isInteger(n) && n >= 1 && n <= post.photo_count)) { throw bad('Pick the photo for LinkedIn.'); }
    want.linkedin = { text: str(li.text, 3000), photo: n };
  }
  if (!Object.keys(want).length) { throw bad('Tick Facebook, LinkedIn or both.'); }
  /* never post the same thing twice to a platform */
  Object.keys(want).forEach(function (k) {
    if (done[k] && done[k].ok && b.again !== true) { throw bad('It\'s already on ' + PUBLISH_TO[k] + '. Untick ' + PUBLISH_TO[k] + ' to post only to the other one.'); }
  });
  /* hour-long links to the JPEG copies, for Make to fetch */
  const nums = [].concat(want.facebook ? want.facebook.photos : [], want.linkedin ? [want.linkedin.photo] : []);
  const urls = await S.sign(BUCKET, nums.map(function (n) { return photoPath(post.id, 'j', n); }), 3600);
  const missing = nums.filter(function (n) { return !urls[photoPath(post.id, 'j', n)]; });
  if (missing.length) { throw bad('Photo ' + missing.join(', ') + ' hasn\'t been prepared for posting yet — reload the page and try again.'); }
  const alt = (post.draft && post.draft.alt_text) || [];
  const token = crypto.randomBytes(24).toString('base64url');
  const now = new Date().toISOString();
  const keep = {};
  Object.keys(done).forEach(function (k) { if (!want[k]) { keep[k] = done[k]; } });
  const publish = { state: 'sending', at: now, by: me.name, by_id: me.id, platforms: Object.keys(want), token: token, results: keep };
  let saved = (await supabase('PATCH', '?id=eq.' + post.id + '&select=*', { publish: publish, updated_at: now }, null, TABLE))[0];
  const payload = {
    post_id: post.id, token: token, event: post.event_title,
    callback_url: siteUrl(req) + '/api/social?id=' + post.id + '&action=published',
    facebook: want.facebook ? { enabled: true, text: want.facebook.text,
      photos: want.facebook.photos.map(function (n) { return { type: 'url', url: urls[photoPath(post.id, 'j', n)], caption: '' }; }) }
      : { enabled: false, text: '', photos: [] },
    linkedin: want.linkedin ? { enabled: true, text: linkedinText(want.linkedin.text), image_url: urls[photoPath(post.id, 'j', want.linkedin.photo)],
      alt_text: str(alt[want.linkedin.photo - 1], 300) || post.event_title }
      : { enabled: false, text: '', image_url: '', alt_text: '' }
  };
  let failed = null;
  try {
    const r = await fetch(publishUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
                                          signal: AbortSignal.timeout(20000) });
    if (!r.ok) { failed = 'Make didn\'t accept it (' + r.status + '). Check the scenario is switched on in Make.'; }
  } catch (e) { failed = 'Couldn\'t reach Make. Check SOCIAL_PUBLISH_WEBHOOK_URL, then try again.'; }
  if (failed) {
    saved = (await supabase('PATCH', '?id=eq.' + post.id + '&select=*', { publish: Object.assign(publish, { state: 'failed', error: failed }),
      updated_at: new Date().toISOString() }, null, TABLE))[0];
  }
  return saved;
}

/* the Make scenario reporting back, once per platform */
async function finishPublish(req, res, id) {
  const b = await readBody(req);
  const post = (await supabase('GET', '?id=eq.' + id + '&select=*', null, null, TABLE))[0];
  const pub = post && post.publish;
  if (!pub || !sameToken(b.token, pub.token)) { return sendJSON(res, 403, { error: 'token', message: 'Unknown or expired publish.' }); }
  const platform = b.platform === 'facebook' || b.platform === 'linkedin' ? b.platform : null;
  if (!platform || pub.platforms.indexOf(platform) < 0) { return sendJSON(res, 400, { error: 'platform', message: 'Which platform?' }); }
  const ok = b.ok === true || b.ok === 'true';
  const results = Object.assign({}, pub.results || {});
  results[platform] = { ok: ok, id: ok ? str(b.id, 200) || null : null, url: ok ? postLink(platform, b.id) : null,
                        error: ok ? null : str(b.error, 500) || 'It didn\'t post.', at: new Date().toISOString() };
  const waiting = pub.platforms.filter(function (k) { return !results[k]; });
  const allOk = pub.platforms.every(function (k) { return results[k] && results[k].ok; });
  const next = Object.assign({}, pub, { results: results,
    state: waiting.length ? 'sending' : allOk ? 'done' : pub.platforms.some(function (k) { return results[k].ok; }) ? 'partial' : 'failed' });
  let saved = (await supabase('PATCH', '?id=eq.' + id + '&select=*', { publish: next, updated_at: new Date().toISOString() }, null, TABLE))[0];
  /* everything that went out is live: mark it posted */
  const live = Object.keys(results).filter(function (k) { return results[k].ok; });
  if (!waiting.length && live.length) {
    const urlOf = function (k) { return results[k] && results[k].url; };
    saved = await markPosted(saved, { posted_where: live.map(function (k) { return PUBLISH_TO[k]; }).join(', '),
      post_url: urlOf('facebook') || urlOf('linkedin') || null }, { id: pub.by_id, name: pub.by });
  }
  return sendJSON(res, 200, { ok: true, state: next.state });
}

module.exports = async function handler(req, res) {
  return main(req, res);
};
module.exports.linkedinText = linkedinText;
async function main(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return sendJSON(res, 503, { error: 'not_configured', message: 'Social media isn\'t set up yet.' });
  }
  try {
    /* Make reporting back: checked by the post's one-time token, not a sign-in */
    const q0 = new URL(req.url, 'http://x').searchParams;
    if (req.method === 'POST' && q0.get('action') === 'published' && ID.test(q0.get('id') || '')) {
      return await finishPublish(req, res, q0.get('id'));
    }
    const me = await A.currentUser(req);
    if (!me) { return sendJSON(res, 401, { error: 'signin', message: 'Sign in to share photos.' }); }
    const admin = A.access(me).admin;
    const q = new URL(req.url, 'http://x').searchParams;
    const id = q.get('id');
    if (id && !ID.test(id)) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
    const one = async function () { return (await supabase('GET', '?id=eq.' + id + '&select=*', null, null, TABLE))[0] || null; };

    if (req.method === 'GET') {
      if (q.get('count')) {
        if (!admin) { return sendJSON(res, 200, { waiting: 0 }); }
        const rows = await supabase('GET', '?status=eq.new&select=id', null, null, TABLE);
        return sendJSON(res, 200, { waiting: rows.length });
      }
      if (id) {
        const post = await one();
        if (!post || !canSee(me, post)) { return sendJSON(res, 404, { error: 'not_found', message: 'That post isn\'t here.' }); }
        return sendJSON(res, 200, { post: await withPhotos(post, true), admin: admin, publish_ready: admin && !!publishUrl() });
      }
      const rows = await supabase('GET', '?select=*' + (admin ? '&status=neq.uploading' : '&created_by=eq.' + me.id) +
                                  '&order=created_at.desc&limit=200', null, null, TABLE);
      for (const p of rows) { await withPhotos(p, false); }
      return sendJSON(res, 200, { posts: rows, admin: admin });
    }

    if (req.method === 'POST' && !id) {
      const fields = cleanSubmission(await readBody(req));
      const rows = await supabase('POST', '?select=*', Object.assign(fields, {
        status: 'uploading', created_by: me.id, created_by_name: me.name }), null, TABLE);
      return sendJSON(res, 201, { post: rows[0] });
    }

    if (!id) { return sendJSON(res, 400, { error: 'id', message: 'Missing or bad id.' }); }
    const post = await one();
    if (!post || !canSee(me, post)) { return sendJSON(res, 404, { error: 'not_found', message: 'That post isn\'t here.' }); }

    if (req.method === 'PUT') {
      const n = Number(q.get('n')), kind = q.get('kind');
      /* the JPEG copy for posting can also be added later, by an admin */
      if (post.status !== 'uploading' && !(kind === 'j' && admin)) { throw bad('This one has already been sent.'); }
      if (!Number.isInteger(n) || n < 1 || n > post.photo_count) { throw bad('That photo number is out of range.'); }
      if (kind !== 'p' && kind !== 't' && kind !== 'j') { throw bad('Unknown image kind.'); }
      const buf = await S.readRaw(req, MAX_IMAGE);
      const type = S.imageType(buf);
      if (!type) { throw bad('Photos must be JPEG, PNG or WebP images.'); }
      if (kind === 'j' && type !== 'image/jpeg') { throw bad('The posting copy must be a JPEG.'); }
      await S.upload(BUCKET, photoPath(post.id, kind, n), buf, type);
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && q.get('action') === 'submit') {
      if (post.status !== 'uploading') { return sendJSON(res, 200, { post: post }); }
      /* the task on the Projects page, so it shows in the sender's "My requests" */
      const ref = { project: null };
      try {
        const lines = ['SOCIAL POST — ' + post.event_title,
          post.event_date ? 'Date: ' + post.event_date : null, post.location ? 'Where: ' + post.location : null,
          'Photos: ' + post.photo_count, '', post.description, '', 'Review and post: social.html#post=' + post.id,
          '', 'Sent by: ' + me.name + ' <' + me.email + '>'].filter(function (l) { return l !== null; });
        ref.project = (await projectWrite('POST', '', Object.assign({
          title: ('Social post: ' + post.event_title).slice(0, 300),
          owner: str(process.env.PRINT_OWNER, 120) || 'Brian Reinhart', status: 'New', importance: 'Med',
          notes: lines.join('\n').slice(0, 4000),
          source: 'Social media · ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' }),
          seed_key: null }, addedBy(me))))[0];
      } catch (e) { /* the post still goes to the queue */ }
      let saved = (await supabase('PATCH', '?id=eq.' + post.id, { status: 'new', project_id: ref.project ? ref.project.id : null,
        updated_at: new Date().toISOString() }, null, TABLE))[0];
      const link = siteUrl(req) + '/social.html#post=' + post.id;
      await A.sendAlerts((await A.admins()).map(function (u) { return u.id; }).filter(function (x) { return x !== me.id; }), {
        from_user_id: me.id, kind: 'request', project_ref: ref.project ? 'row:' + ref.project.id : null,
        title: 'New social post to create: ' + post.event_title,
        body: me.name + ' sent ' + post.photo_count + ' photo' + (post.photo_count === 1 ? '' : 's') + '. ' + post.description.slice(0, 200),
        link: 'social.html#post=' + post.id });
      const teams = await notifyTeams(saved, link);
      saved = await draftAndSave(saved);
      return sendJSON(res, 200, { post: saved, teams: teams });
    }

    if (!admin) {
      if (req.method === 'DELETE' && post.created_by === me.id && post.status !== 'posted') { /* their own, not yet posted */ }
      else { return sendJSON(res, 403, { error: 'admin', message: 'Only admins can change posts.' }); }
    }

    if (req.method === 'POST' && q.get('action') === 'publish') {
      const saved = await startPublish(req, post, me, await readBody(req));
      return sendJSON(res, 200, { post: await withPhotos(saved, true), publish_ready: true });
    }

    if (req.method === 'POST' && q.get('action') === 'draft') {
      const b = await readBody(req);
      const saved = await draftAndSave(post, str(b.instructions, 500));
      return sendJSON(res, 200, { post: await withPhotos(saved, true) });
    }

    if (req.method === 'PATCH') {
      const b = await readBody(req);
      const fields = { updated_at: new Date().toISOString() };
      if ('draft' in b) { fields.draft = cleanDraft(b.draft); }
      if ('status' in b) {
        if (['new', 'posted', 'archived'].indexOf(b.status) < 0) { throw bad('Unknown status.'); }
        fields.status = b.status;
        if (b.status === 'posted') {
          const where = (Array.isArray(b.posted_where) ? b.posted_where : []).filter(function (p) { return PLATFORMS.indexOf(p) >= 0; });
          const url = str(b.post_url, 500);
          if (url && !/^https:\/\/\S+$/.test(url)) { throw bad('The post link should start with https://'); }
          Object.assign(fields, { posted_where: where.join(', ') || null, post_url: url || null,
                                  posted_at: new Date().toISOString(), posted_by_name: me.name });
        }
      }
      if (fields.status === 'posted') {
        const keep = { posted_where: fields.posted_where, post_url: fields.post_url };
        if (fields.draft) { keep.draft = fields.draft; }
        const done = await markPosted(post, keep, me);
        return sendJSON(res, 200, { post: await withPhotos(done, true) });
      }
      const saved = (await supabase('PATCH', '?id=eq.' + post.id + '&select=*', fields, null, TABLE))[0];
      /* keep the task in step */
      if (fields.status && post.project_id) {
        try {
          await projectWrite('PATCH', '?id=eq.' + post.project_id, { status: fields.status === 'posted' ? 'Complete' :
            fields.status === 'archived' ? 'On Hold' : 'New', updated_at: fields.updated_at, updated_by_name: me.name });
        } catch (e) { /* the task may have been removed */ }
      }
      return sendJSON(res, 200, { post: await withPhotos(saved, true) });
    }

    if (req.method === 'DELETE') {
      const paths = [];
      for (let n = 1; n <= post.photo_count; n++) { paths.push(photoPath(post.id, 'p', n), photoPath(post.id, 't', n), photoPath(post.id, 'j', n)); }
      await S.remove(BUCKET, paths);
      await supabase('DELETE', '?id=eq.' + post.id, null, { Prefer: 'return=minimal' }, TABLE);
      return sendJSON(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, PATCH, DELETE');
    return sendJSON(res, 405, { error: 'method', message: 'Method not allowed.' });
  } catch (e) {
    if (e.bad || /JSON|body too large/.test(e.message)) {
      return sendJSON(res, 400, { error: 'bad_request', message: e.bad ? e.message : 'Could not read the request.' });
    }
    if (/PGRST204|42703/.test(e.message) && /publish/.test(e.message)) {
      return sendJSON(res, 502, { error: 'schema', message: 'Run the latest supabase/social.sql in Supabase first — it adds the publishing column.' });
    }
    const noTable = /PGRST20[25]|42P01|public\.social_posts/i.test(e.message);
    const noBucket = /Bucket not found/i.test(e.message);
    return sendJSON(res, 502, {
      error: noTable || noBucket ? 'schema' : 'storage',
      message: noTable ? 'Supabase can\'t see the social posts table yet. In the SQL Editor, run supabase/social.sql, then refresh.'
        : noBucket ? 'The private "social" storage bucket is missing in Supabase. Run supabase/social.sql again.'
        : 'Could not reach the social media storage. Try again shortly.'
    });
  }
}
