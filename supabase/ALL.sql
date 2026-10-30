-- ============================================================================
-- Sanctuary metrics: every table and function in one paste.
-- Supabase → SQL Editor → New query → paste all of this → Run. Safe to re-run.
-- Built from supabase/accounts, site-analytics, cost-cutting, google-cutover, presentations, social, print-orders, cpao, pal-email and m365 .sql.
-- ============================================================================


-- ────────────────────────────── accounts.sql ──────────────────────────────
-- ============================================================================
-- Accounts, alerts and project messages. Run once in Supabase → SQL Editor.
-- Safe to re-run.
--
-- Every table has row level security on and no policies: only the site's
-- server functions (service-role key) can read or write them.
-- ============================================================================

create table if not exists public.app_users (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique check (email = lower(email)),
  name                 text not null,
  role                 text not null default 'member' check (role in ('admin', 'member')),
  password_hash        text,
  must_change_password boolean not null default true,
  disabled             boolean not null default false,
  failed_logins        integer not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now()
);

-- Microsoft sign-in links an account to its Entra object ID on first use
alter table public.app_users add column if not exists ms_oid text unique;

-- What each person may open, beyond the staff pages everyone gets (admins get
-- everything). Accounts that existed before these columns keep seeing the
-- reports; new staff start with neither until an admin turns one on.
alter table public.app_users add column if not exists access_reports boolean;
alter table public.app_users add column if not exists access_costs   boolean;
update public.app_users set access_reports = true  where access_reports is null;
update public.app_users set access_costs   = false where access_costs   is null;
alter table public.app_users alter column access_reports set default false;
alter table public.app_users alter column access_reports set not null;
alter table public.app_users alter column access_costs   set default false;
alter table public.app_users alter column access_costs   set not null;

create table if not exists public.app_sessions (
  token_hash  text primary key,             -- sha256 of the cookie token, never the token itself
  user_id     uuid not null references public.app_users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);
create index if not exists app_sessions_user on public.app_sessions (user_id);

create table if not exists public.alerts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.app_users (id) on delete cascade,
  from_user_id  uuid references public.app_users (id) on delete set null,
  kind          text not null default 'alert',   -- alert | message | request
  title         text not null,
  body          text,
  link          text,
  project_ref   text,                            -- 'row:<uuid>' or 'seed:<L10 title>'
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);
create index if not exists alerts_user_time on public.alerts (user_id, created_at desc);

create table if not exists public.project_messages (
  id           uuid primary key default gen_random_uuid(),
  project_ref  text not null,
  user_id      uuid references public.app_users (id) on delete set null,
  author_name  text not null,
  body         text not null check (length(body) between 1 and 4000),
  created_at   timestamptz not null default now()
);
create index if not exists project_messages_ref_time on public.project_messages (project_ref, created_at);

create table if not exists public.project_reads (
  user_id       uuid not null references public.app_users (id) on delete cascade,
  project_ref   text not null,
  last_read_at  timestamptz not null default now(),
  primary key (user_id, project_ref)
);

alter table public.app_users        enable row level security;
alter table public.app_sessions     enable row level security;
alter table public.alerts           enable row level security;
alter table public.project_messages enable row level security;
alter table public.project_reads    enable row level security;

-- message counts per project for one user: total, unread, last message time
create or replace function public.message_summary(p_user uuid)
returns table (project_ref text, total bigint, unread bigint, last_at timestamptz)
language sql stable security invoker as $$
  select m.project_ref,
         count(*) as total,
         count(*) filter (where m.user_id is distinct from p_user
                          and m.created_at > coalesce(r.last_read_at, '-infinity')) as unread,
         max(m.created_at) as last_at
  from public.project_messages m
  left join public.project_reads r on r.project_ref = m.project_ref and r.user_id = p_user
  group by m.project_ref
$$;
revoke all on function public.message_summary(uuid) from public, anon, authenticated;
grant execute on function public.message_summary(uuid) to service_role;

-- who added and who last changed each project on the Projects page
do $$
begin
  if to_regclass('public.projects') is not null then
    alter table public.projects
      add column if not exists created_by      uuid references public.app_users (id) on delete set null,
      add column if not exists created_by_name text,
      add column if not exists updated_by_name text;
  end if;
end $$;



-- ────────────────────────────── site-analytics.sql ──────────────────────────────
-- ============================================================================
-- Site analytics for sanctuaryci.org (and any other site added later).
-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- Events arrive through /api/collect (api/collect.js), which holds the
-- service-role key. The table has row level security on and no policies, so
-- the public anon key can neither read nor write it.
--
-- Nothing personal is stored: no IP address, no form contents, no names or
-- emails. Visitors are a random ID kept in their own browser; location is
-- the coarse country / region / city Vercel derives from the request.
-- ============================================================================

create table if not exists public.site_events (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  site         text not null,
  type         text not null,          -- pageview | engage | click | form | vital
  path         text,
  title        text,
  visitor_id   text,
  session_id   text,
  pageview_id  text,
  new_visitor  boolean,
  referrer     text,
  ref_domain   text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_content  text,
  utm_term     text,
  device       text,                   -- mobile | tablet | desktop
  browser      text,
  os           text,
  country      text,
  region       text,
  city         text,
  lang         text,
  tz           text,
  screen       text,
  scroll_pct   smallint,               -- engage: deepest point reached, 0–100
  engaged_ms   integer,                -- engage: time the tab was visible and in use
  target       text,                   -- click: link / form id
  label        text,                   -- click: button or link text
  props        jsonb                   -- anything else (vitals, click kind…)
);

create index if not exists site_events_site_time on public.site_events (site, created_at desc);
create index if not exists site_events_pageview on public.site_events (pageview_id) where type = 'engage';

alter table public.site_events enable row level security;

-- ── the numbers the dashboard shows, in one call ─────────────────────────────
-- select public.site_stats('sanctuaryci.org', 30);
-- Days are counted in Phoenix time.
create or replace function public.site_stats(p_site text, p_days int default 30)
returns jsonb
language sql
stable
security invoker
as $$
with
win as (
  select now() - make_interval(days => p_days) as since,
         now() - make_interval(days => p_days * 2) as prev_since
),
ev as (
  select e.* from public.site_events e, win
  where e.site = p_site and e.created_at >= win.since
),
eng as (
  select pageview_id, max(scroll_pct) as scroll, max(engaged_ms) as ms
  from ev where type = 'engage' group by pageview_id
),
pv as (
  select p.*, coalesce(eng.scroll, 0) as scroll, coalesce(eng.ms, 0) as ms,
         case
           when p.utm_medium ilike any (array['cpc','ppc','paid%','display','paidsocial']) then 'Paid'
           when p.utm_medium ilike 'email' or p.utm_source ilike '%newsletter%' then 'Email'
           when p.utm_medium ilike any (array['social','social-media','organic_social']) then 'Social'
           when p.ref_domain is null or p.ref_domain = '' then 'Direct'
           when p.ref_domain ~* '(^|\.)(google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|search\.brave)\.' then 'Organic search'
           when p.ref_domain ~* '(^|\.)(facebook|fb|instagram|linkedin|lnkd|t|twitter|x|youtube|tiktok|pinterest|reddit|threads|nextdoor)\.(com|co|in|net)$' then 'Social'
           when p.ref_domain ~* '(chatgpt|openai|perplexity|claude|gemini|copilot)\.' then 'AI assistants'
           else 'Referral'
         end as channel
  from ev p left join eng using (pageview_id)
  where p.type = 'pageview'
),
sess as (
  select session_id, count(*) as views, sum(ms) as ms,
         (array_agg(path order by created_at))[1] as landing,
         (array_agg(path order by created_at desc))[1] as exit_path
  from pv group by session_id
),
prev as (
  select count(*) as pageviews, count(distinct visitor_id) as visitors, count(distinct session_id) as sessions
  from public.site_events e, win
  where e.site = p_site and e.type = 'pageview' and e.created_at >= win.prev_since and e.created_at < win.since
),
vit as (
  select props->>'name' as name, (props->>'value')::numeric as value
  from ev where type = 'vital' and props ? 'name' and (props->>'value') ~ '^[0-9.]+$'
)
select jsonb_build_object(
  'site', p_site,
  'days', p_days,
  'generated', now(),
  'live_visitors', (select count(distinct visitor_id) from public.site_events
                    where site = p_site and created_at >= now() - interval '5 minutes'),
  'totals', (select jsonb_build_object(
      'pageviews', count(*),
      'visitors', count(distinct visitor_id),
      'sessions', count(distinct session_id),
      'new_visitors', count(distinct visitor_id) filter (where new_visitor),
      'avg_scroll', round(avg(scroll)),
      'avg_engaged_s', round(avg(ms) / 1000.0),
      'pages_per_session', round(count(*)::numeric / nullif(count(distinct session_id), 0), 2))
    from pv),
  'sessions', (select jsonb_build_object(
      'bounce_rate', round(100.0 * count(*) filter (where views = 1 and ms < 10000) / nullif(count(*), 0)),
      'avg_session_s', round(avg(ms) / 1000.0))
    from sess),
  'prev', (select to_jsonb(prev) from prev),
  'daily', coalesce((select jsonb_agg(d order by d.day) from (
      select (created_at at time zone 'America/Phoenix')::date as day,
             count(*) as pageviews, count(distinct visitor_id) as visitors
      from pv group by 1) d), '[]'),
  'hours', coalesce((select jsonb_agg(h order by h.hour) from (
      select extract(hour from created_at at time zone 'America/Phoenix')::int as hour, count(*) as pageviews
      from pv group by 1) h), '[]'),
  'pages', coalesce((select jsonb_agg(x) from (
      select path, max(title) as title, count(*) as views, count(distinct visitor_id) as visitors,
             round(avg(scroll)) as avg_scroll, round(avg(ms) / 1000.0) as avg_s,
             round(100.0 * count(*) filter (where scroll >= 75) / count(*)) as read_75
      from pv group by path order by views desc limit 60) x), '[]'),
  'landing', coalesce((select jsonb_agg(x) from (
      select landing as path, count(*) as sessions,
             round(100.0 * count(*) filter (where views = 1 and ms < 10000) / count(*)) as bounce_rate
      from sess group by landing order by sessions desc limit 20) x), '[]'),
  'exits', coalesce((select jsonb_agg(x) from (
      select exit_path as path, count(*) as sessions from sess group by exit_path order by sessions desc limit 15) x), '[]'),
  'scroll', (select jsonb_build_object(
      'p25', round(100.0 * count(*) filter (where scroll >= 25) / nullif(count(*), 0)),
      'p50', round(100.0 * count(*) filter (where scroll >= 50) / nullif(count(*), 0)),
      'p75', round(100.0 * count(*) filter (where scroll >= 75) / nullif(count(*), 0)),
      'p90', round(100.0 * count(*) filter (where scroll >= 90) / nullif(count(*), 0)),
      'p100', round(100.0 * count(*) filter (where scroll >= 100) / nullif(count(*), 0)))
    from pv),
  'channels', coalesce((select jsonb_agg(x) from (
      select channel, count(distinct session_id) as sessions, count(distinct visitor_id) as visitors
      from pv group by channel order by sessions desc) x), '[]'),
  'referrers', coalesce((select jsonb_agg(x) from (
      select ref_domain, count(distinct session_id) as sessions
      from pv where ref_domain is not null and ref_domain <> '' group by ref_domain order by sessions desc limit 25) x), '[]'),
  'campaigns', coalesce((select jsonb_agg(x) from (
      select utm_source, utm_medium, utm_campaign, count(distinct session_id) as sessions
      from pv where utm_source is not null or utm_campaign is not null
      group by 1, 2, 3 order by sessions desc limit 25) x), '[]'),
  'devices', coalesce((select jsonb_agg(x) from (
      select coalesce(device, 'unknown') as name, count(distinct visitor_id) as visitors from pv group by 1 order by 2 desc) x), '[]'),
  'browsers', coalesce((select jsonb_agg(x) from (
      select coalesce(browser, 'Other') as name, count(distinct visitor_id) as visitors from pv group by 1 order by 2 desc limit 10) x), '[]'),
  'os', coalesce((select jsonb_agg(x) from (
      select coalesce(os, 'Other') as name, count(distinct visitor_id) as visitors from pv group by 1 order by 2 desc limit 10) x), '[]'),
  'countries', coalesce((select jsonb_agg(x) from (
      select coalesce(country, '—') as name, count(distinct visitor_id) as visitors from pv group by 1 order by 2 desc limit 15) x), '[]'),
  'cities', coalesce((select jsonb_agg(x) from (
      select city || coalesce(', ' || region, '') as name, count(distinct visitor_id) as visitors
      from pv where city is not null group by 1 order by 2 desc limit 20) x), '[]'),
  'clicks', coalesce((select jsonb_agg(x) from (
      select coalesce(props->>'kind', 'click') as kind, target, max(label) as label,
             count(*) as clicks, count(distinct visitor_id) as visitors
      from ev where type = 'click' group by 1, 2 order by clicks desc limit 40) x), '[]'),
  'forms', coalesce((select jsonb_agg(x) from (
      select target as form, max(path) as path,
             count(*) filter (where props->>'stage' = 'start') as started,
             count(*) filter (where props->>'stage' = 'submit') as submitted,
             count(*) filter (where props->>'stage' = 'success') as succeeded
      from ev where type = 'form' group by target order by submitted desc, started desc) x), '[]'),
  'vitals', coalesce((select jsonb_object_agg(name, p75) from (
      select name, round(percentile_cont(0.75) within group (order by value)::numeric, 3) as p75
      from vit group by name) x), '{}')
);
$$;

revoke all on function public.site_stats(text, int) from public, anon, authenticated;
grant execute on function public.site_stats(text, int) to service_role;



-- ────────────────────────────── cost-cutting.sql ──────────────────────────────
-- ============================================================================
-- Cost cutting: recommended cuts and their approvals. Run once in Supabase →
-- SQL Editor (after accounts.sql). Safe to re-run.
--
-- An admin recommends a cut on costs.html; whoever approves it gets a thank-you
-- and the cut becomes a task on the Projects page (public.projects). Row level
-- security is on with no policies: only the site's server functions can read
-- or write it.
-- ============================================================================

create table if not exists public.cost_recommendations (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  created_by      uuid references public.app_users (id) on delete set null,
  vendor          text not null,                         -- Microsoft, Google, Other
  department      text,
  title           text not null check (length(title) between 1 and 200),
  detail          text,
  monthly_saving  numeric(10,2) check (monthly_saving is null or monthly_saving >= 0),
  status          text not null default 'proposed' check (status in ('proposed', 'approved', 'declined')),
  decided_by      uuid references public.app_users (id) on delete set null,
  decided_by_name text,
  decided_at      timestamptz,
  decision_note   text,
  project_id      uuid                                   -- the task created on approval
);
create index if not exists cost_recommendations_status on public.cost_recommendations (status, created_at desc);

alter table public.cost_recommendations enable row level security;



-- ────────────────────────────── google-cutover.sql ──────────────────────────────
-- ============================================================================
-- Google Workspace cutover: one row per Google account, with its usage on both
-- sides and the team's keep / cut choice. Run once in Supabase → SQL Editor
-- (after accounts.sql and cost-cutting.sql). Safe to re-run.
--
-- The account rows themselves (names, addresses, sizes) are NOT in this public
-- repo: they're loaded with a separate insert kept out of git. Row level
-- security is on with no policies, so only the site's server functions —
-- behind sign-in — can read them.
-- ============================================================================

create table if not exists public.google_accounts (
  account            text primary key,                  -- the Google address
  name               text,
  google_status      text,                              -- Active | Suspended
  last_sign_in       text,
  gmail_mb           numeric,
  drive_mb           numeric,
  photos_mb          numeric,
  google_total_mb    numeric,
  emails_30d         integer,
  gmail_last_used    text,
  m365_mailbox       text,
  m365_type          text,
  m365_items         integer,
  m365_mb            numeric,
  m365_last_activity text,
  verdict            text check (verdict in ('Ready to cut', 'Verify', 'Keep')),   -- the review's recommendation
  note               text,
  must_keep          boolean not null default false,    -- locked: can never be sent for cutting
  must_keep_reason   text,
  decision           text check (decision in ('keep', 'cut')),                     -- the team's choice
  decided_by_name    text,
  decided_at         timestamptz,
  cut_rec_id         uuid,                              -- the cost_recommendations row it was sent in
  checked_on         date,                              -- when the usage figures were collected
  updated_at         timestamptz not null default now()
);

-- Migration proof (Oct 21 follow-up): what actually reached Microsoft 365
alter table public.google_accounts
  add column if not exists onedrive_mb          numeric,
  add column if not exists gmail_items_imported integer,
  add column if not exists gmail_folders_gb     numeric,
  add column if not exists m365_history_starts  date,
  add column if not exists mail_migrated        text,       -- Yes | No | Nothing to move
  add column if not exists drive_migrated       text;

alter table public.google_accounts enable row level security;

-- The Microsoft 365 mailboxes these accounts map to, with every address on them
create table if not exists public.google_m365_mailboxes (
  mailbox     text primary key,
  created     date,
  items       integer,
  mb          numeric,
  aliases     text[],
  checked_on  date
);
alter table public.google_m365_mailboxes enable row level security;

-- Every folder in those mailboxes; from_gmail marks the imported [Gmail] folders
create table if not exists public.google_m365_folders (
  mailbox     text not null,
  folder      text not null,
  items       integer,
  mb          numeric,
  oldest      date,
  newest      date,
  from_gmail  boolean not null default false,
  checked_on  date,
  primary key (mailbox, folder)
);
alter table public.google_m365_folders enable row level security;



-- ────────────────────────────── presentations.sql ──────────────────────────────
-- ============================================================================
-- Presentations: PowerPoint decks shown on presentations.html. Run once in
-- Supabase → SQL Editor (it's also in ALL.sql). Safe to re-run.
--
-- The slides are images in a PRIVATE storage bucket, "presentations", one
-- folder per deck: <deck id>/s<n>.webp (full size) and <deck id>/t<n>.webp
-- (thumbnail). Nothing in it is public: the site's server function signs
-- short-lived links for signed-in staff only. The deck itself stays in
-- SharePoint; sharepoint_url links to it.
-- ============================================================================

create table if not exists public.presentations (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (length(title) between 1 and 200),
  description      text,
  category         text,
  sharepoint_url   text,
  slide_count      integer not null default 0,
  status           text not null default 'uploading' check (status in ('uploading', 'ready')),
  created_by       uuid references public.app_users (id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists presentations_time on public.presentations (created_at desc);
alter table public.presentations enable row level security;

-- the private bucket for the slide images
insert into storage.buckets (id, name, public)
values ('presentations', 'presentations', false)
on conflict (id) do update set public = false;



-- ────────────────────────────── social.sql ──────────────────────────────
-- ============================================================================
-- Social media: event photos the team sends in, Claude's draft posts, and
-- what got published. Run once in Supabase → SQL Editor (it's also in
-- ALL.sql). Safe to re-run.
--
-- Photos are images in a PRIVATE storage bucket, "social", one folder per
-- submission: <post id>/p<n>.webp (full size) and <post id>/t<n>.webp
-- (thumbnail). The site's server function (api/social.js) signs short-lived
-- links for signed-in staff only.
-- ============================================================================

create table if not exists public.social_posts (
  id               uuid primary key default gen_random_uuid(),
  event_title      text not null check (length(event_title) between 1 and 200),
  event_date       date,
  location         text,
  description      text not null check (length(description) between 1 and 3000),
  photo_count      integer not null default 0,
  consent          boolean not null default false,   -- submitter confirmed the photos are OK to share
  status           text not null default 'uploading'
                   check (status in ('uploading', 'new', 'posted', 'archived')),
  created_by       uuid references public.app_users (id) on delete set null,
  created_by_name  text,
  project_id       uuid,                              -- the task on the Projects page
  draft            jsonb,                             -- {facebook, instagram, linkedin, hashtags[], alt_text[], privacy_check}
  draft_model      text,
  drafted_at       timestamptz,
  draft_error      text,
  posted_where     text,
  post_url         text,
  posted_at        timestamptz,
  posted_by_name   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists social_posts_time on public.social_posts (created_at desc);
create index if not exists social_posts_status on public.social_posts (status);
alter table public.social_posts enable row level security;

-- the private bucket for the photos
insert into storage.buckets (id, name, public)
values ('social', 'social', false)
on conflict (id) do update set public = false;



-- ────────────────────────────── print-orders.sql ──────────────────────────────
-- ============================================================================
-- Print shop order tracking: what's been ordered, where each order is, and
-- where the team handed the materials out. Run once in Supabase → SQL Editor
-- (it's also in ALL.sql). Safe to re-run.
--
--   print_orders    one row per order (a flyer version, business cards, …)
--                   moving Requested → Ordered → Shipped → Delivered →
--                   All handed out (or Cancelled)
--   print_handouts  one row each time someone hands materials out: what,
--                   how many, where / which event, and who
--
-- Print requests from the shop (api/requests.js) that ask for prints add a
-- "Requested" order here automatically. Row level security is on with no
-- policies: only the site's server function can read or write.
-- ============================================================================

create table if not exists public.print_orders (
  id               uuid primary key default gen_random_uuid(),
  item             text not null check (length(item) between 1 and 200),   -- "Change Your Life Story"
  kind             text not null default 'flyer' check (kind in ('flyer', 'business_cards', 'presentation', 'other')),
  item_ref         text,                 -- flyer version id from flyers.js, e.g. 'adolescent-b'
  quantity         integer check (quantity is null or quantity >= 0),
  status           text not null default 'requested' check (status in (
                     'requested', 'ordered', 'shipped', 'delivered', 'handed_out', 'cancelled')),
  vendor           text,
  expected_on      date,                 -- when it should arrive
  delivered_on     date,
  stored_at        text,                 -- where the boxes are once delivered
  notes            text,
  project_id       uuid,                 -- the request on the Projects page, if it came from one
  requested_by_name text,
  updated_by_name  text,
  seed_key         text unique,          -- rows this file adds, so a re-run doesn't duplicate them
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists print_orders_status on public.print_orders (status, created_at desc);

create table if not exists public.print_handouts (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid references public.print_orders (id) on delete set null,
  item             text not null check (length(item) between 1 and 200),
  quantity         integer not null check (quantity between 1 and 100000),
  handed_out_on    date not null default current_date,
  location         text not null check (length(location) between 1 and 300),  -- where / which event
  audience         text,                 -- who got them: referral partners, a hospital, a school…
  notes            text,
  created_by       uuid references public.app_users (id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index if not exists print_handouts_order on public.print_handouts (order_id);
create index if not exists print_handouts_when on public.print_handouts (handed_out_on desc, created_at desc);

alter table public.print_orders   enable row level security;
alter table public.print_handouts enable row level security;

-- the first orders: every flyer in the shop, ordered, arriving Friday 10/23/2026.
-- Set each quantity on the print shop page (Order status → Edit).
insert into public.print_orders (item, kind, item_ref, status, expected_on, notes, requested_by_name, seed_key)
values
  ('Change Your Life Story',                  'flyer', 'life-story',          'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:life-story'),
  ('Addiction Treatment For All',             'flyer', 'treatment-for-all',   'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:treatment-for-all'),
  ('Let''s Take Next Steps Together',         'flyer', 'next-steps-together', 'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:next-steps-together'),
  ('Careers — Grow Here',                     'flyer', 'careers-grow-here',   'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:careers-grow-here'),
  ('Male Adolescent Program — Version A',     'flyer', 'adolescent-a',        'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:adolescent-a'),
  ('Male Adolescent Program — Version B',     'flyer', 'adolescent-b',        'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:adolescent-b'),
  ('Male Adolescent Program — Version C',     'flyer', 'adolescent-c',        'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:adolescent-c'),
  ('Women''s Program',                        'flyer', 'womens-program',      'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:womens-program')
on conflict (seed_key) do nothing;



-- ────────────────────────────── cpao.sql ──────────────────────────────
-- ============================================================================
-- CP-AO Assistor Portal: AHCCCS HEAplus access (CP-101 Individual User
-- Applications and the weekly Organization User Application). Run once in
-- Supabase → SQL Editor (it's also in ALL.sql). Safe to re-run.
--
-- Treat everything here like PHI:
--   - date of birth, SSN and home address are AES-256-GCM encrypted by the
--     server (env CPAO_PII_KEY) before they reach this database — the
--     sensitive_ciphertext column never holds plaintext
--   - signatures and generated PDFs live in the PRIVATE "cpao" storage
--     bucket and are only handed out as 5-minute signed links
--   - row level security is on with no policies: only the site's server
--     function (service-role key) can read or write
-- ============================================================================

create table if not exists public.cpao_staff (
  id                 uuid primary key default gen_random_uuid(),
  first_name         text not null,
  last_name          text not null,
  email              text not null,
  title_position     text,
  worker_type        text not null default 'Employee' check (worker_type in ('Employee', 'Contractor', 'Volunteer')),
  is_site_admin      boolean not null default false,
  hire_date          date,
  work_address       text,
  status             text not null default 'invited' check (status in (
                       'invited', 'in_progress', 'needs_fix', 'ready_for_countersign', 'countersigned',
                       'queued_for_batch', 'sent_to_cpao', 'cpao_correction_requested',
                       'approved_training_assigned', 'training_complete', 'certs_sent_to_cpao',
                       'final_approved', 'active', 'denied', 'remove_requested', 'removed')),
  heaplus_username   text,
  notes              text,
  invite_token_hash  text,                 -- sha256 of the invite link token; cleared once submitted
  invite_expires_at  timestamptz,
  invite_failures    integer not null default 0,  -- wrong-account tries; the link locks at 5
  last_action        text,
  last_action_at     timestamptz,
  project_id         uuid,                 -- the open task for Brian, if any
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists cpao_staff_status on public.cpao_staff (status);
create index if not exists cpao_staff_email on public.cpao_staff (lower(email));
alter table public.cpao_staff add column if not exists invite_failures integer not null default 0;

-- the full process: when each stage happened, and follow-ups (CPAO questions,
-- corrections, reminders). Also widens the status list for tables made by an
-- earlier version of this file.
alter table public.cpao_staff add column if not exists stage_dates jsonb not null default '{}'::jsonb;
alter table public.cpao_staff add column if not exists followups   jsonb not null default '[]'::jsonb;
alter table public.cpao_staff drop constraint if exists cpao_staff_status_check;
alter table public.cpao_staff add constraint cpao_staff_status_check check (status in (
  'invited', 'in_progress', 'needs_fix', 'ready_for_countersign', 'countersigned',
  'queued_for_batch', 'sent_to_cpao', 'cpao_correction_requested',
  'approved_training_assigned', 'training_complete', 'certs_sent_to_cpao',
  'final_approved', 'active', 'denied', 'remove_requested', 'removed'));

create table if not exists public.cpao_applications (
  id                    uuid primary key default gen_random_uuid(),
  staff_id              uuid not null references public.cpao_staff (id) on delete cascade,
  form_version          text not null default 'CP-101 rev 12/2024',
  answers               jsonb not null default '{}'::jsonb,   -- non-sensitive answers only
  sensitive_ciphertext  text,                                 -- AES-256-GCM {date_of_birth, ssn, home_address}
  step                  integer not null default 1,           -- where the staff member is in the form
  user_signature_key    text,                                 -- private storage path of the signature PNG
  wet_signed_upload_key text,                                 -- CPAO_REQUIRE_WET_SIGNATURE: the uploaded scan
  user_signed_at        timestamptz,
  user_ip               text,
  conditions_agreed_at  timestamptz,
  ai_check_result       jsonb,
  sa_signed_at          timestamptz,
  pdf_storage_key       text,
  batch_id              uuid,
  submitted_at          timestamptz,
  purged_at             timestamptz,                          -- PII + signatures removed under the retention rule
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists cpao_applications_staff on public.cpao_applications (staff_id, created_at desc);

create table if not exists public.cpao_batches (
  id                    uuid primary key default gen_random_uuid(),
  week_of               date not null,
  org_form_storage_key  text,
  bundle_storage_key    text,
  status                text not null default 'draft' check (status in ('draft', 'sent', 'acknowledged')),
  rows                  jsonb not null default '[]'::jsonb,    -- [{staff_id, name, action}]
  sent_at               timestamptz,
  project_id            uuid,
  created_at            timestamptz not null default now()
);

create table if not exists public.cpao_audit_log (
  id         bigint generated always as identity primary key,
  actor      text not null,          -- email of the signed-in person, or 'system' / 'cron'
  action     text not null,
  staff_id   uuid,
  detail     jsonb,                  -- never PII
  ip         text,
  at         timestamptz not null default now()
);
create index if not exists cpao_audit_staff on public.cpao_audit_log (staff_id, at desc);

create table if not exists public.cpao_settings (
  id                        integer primary key default 1 check (id = 1),
  site_admin_phone          text,
  site_admin_signature_key  text,    -- private storage path of Brian's signature PNG
  batch_weekday             integer not null default 1 check (batch_weekday between 0 and 6),  -- 1 = Monday
  pdf_retention_days        integer not null default 365,
  updated_at                timestamptz not null default now()
);
insert into public.cpao_settings (id) values (1) on conflict (id) do nothing;

alter table public.cpao_staff        enable row level security;
alter table public.cpao_applications enable row level security;
alter table public.cpao_batches      enable row level security;
alter table public.cpao_audit_log    enable row level security;
alter table public.cpao_settings     enable row level security;

-- the private bucket for signatures and generated PDFs
insert into storage.buckets (id, name, public)
values ('cpao', 'cpao', false)
on conflict (id) do update set public = false;



-- ────────────────────────────── pal-email.sql ──────────────────────────────
-- ============================================================================
-- PAL Forward 2026 outreach email tracker (pal-email.html). Run once in
-- Supabase → SQL Editor (it's also in ALL.sql). Safe to re-run.
--
-- The contact list itself is NOT in this file — the repository is public.
-- Load it from the page (PAL Email Send → Import CSV, admins) or with the
-- private seed file you were given. Row level security is on with no
-- policies: only the site's server functions can read or write.
-- ============================================================================

create table if not exists public.pal_contacts (
  email            text primary key check (length(email) between 3 and 200),
  domain           text not null,
  grp              integer not null check (grp between 1 and 999),
  status           text not null default 'pending' check (status in ('pending', 'sent')),
  sent_date        date,
  updated_by_name  text,
  updated_at       timestamptz not null default now()
);
create index if not exists pal_contacts_grp on public.pal_contacts (grp);

-- one row: the notes box and the Replies / Bounces / RSVPs counters
create table if not exists public.pal_campaign (
  id               integer primary key default 1 check (id = 1),
  notes            text not null default '',
  replies          integer not null default 0 check (replies >= 0),
  bounces          integer not null default 0 check (bounces >= 0),
  rsvps            integer not null default 0 check (rsvps >= 0),
  updated_by_name  text,
  updated_at       timestamptz not null default now()
);
insert into public.pal_campaign (id) values (1) on conflict (id) do nothing;

alter table public.pal_contacts enable row level security;
alter table public.pal_campaign enable row level security;


notify pgrst, 'reload schema';


-- ─────────────────────────────── m365.sql ───────────────────────────────
-- ============================================================================
-- Microsoft 365 daily refresh + AI cost review. Run once in Supabase → SQL
-- Editor (after accounts.sql and cost-cutting.sql; it's also in ALL.sql).
-- Safe to re-run.
--
-- m365_snapshots  one row a day from /api/m365?action=sync: the full review
--                 and usage payloads (kept 14 days), the headline numbers
--                 (kept forever) and the AI review of that day.
-- m365_keep       accounts the AI may never propose cutting.
-- cost_recommendations gains source / ai_key / accounts so the AI's proposals
--                 sit in the same approval queue as everyone else's.
--
-- Row level security is on with no policies: only the site's server
-- functions can read or write these.
-- ============================================================================

create table if not exists public.m365_snapshots (
  taken_on     date primary key,                 -- Phoenix date of the pull
  refreshed_at timestamptz not null default now(),
  report_date  date,                             -- Microsoft's report refresh date
  review       jsonb,                            -- microsoft.html's data (null after 14 days)
  usage        jsonb,                            -- SharePoint/Teams/Groups/Email tabs (null after 14 days)
  summary      jsonb not null,                   -- headline numbers, kept for the trend
  warnings     jsonb not null default '[]',
  ai           jsonb,                            -- {headline, recommendations, lanes, queue}
  ai_model     text,
  ai_at        timestamptz,
  ai_error     text
);
alter table public.m365_snapshots enable row level security;

create table if not exists public.m365_keep (
  upn      text primary key check (upn = lower(upn)),
  reason   text,
  added_at timestamptz not null default now()
);
alter table public.m365_keep enable row level security;

-- Kept live at Elyssa's request (Oct 1, 2026: Custer, Schall, Maguire, Ulonda).
-- Two accounts match "Schall" and two match "Ulonda"; both of each are listed
-- so neither gets proposed. Delete the row that shouldn't be here.
insert into public.m365_keep (upn, reason) values
  ('hcuster@sanctuaryrecoverycenters.com',  'Kept live per Elyssa, 2026-10-01'),
  ('kmaguire@sanctuaryrecoverycenters.com', 'Kept live per Elyssa, 2026-10-01'),
  ('jschall@sanctuaryrecoverycenters.com',  'Kept live per Elyssa, 2026-10-01 (Schall — confirm which account)'),
  ('jasons@sanctuaryrecoverycenters.com',   'Kept live per Elyssa, 2026-10-01 (Schall — confirm which account)'),
  ('ulonda@sanctuaryrecoverycenters.com',   'Kept live per Elyssa, 2026-10-01 (Ulonda — confirm which account)'),
  ('uoc@sanctuaryrecoverycenters.com',      'Kept live per Elyssa, 2026-10-01 (Ulonda — confirm which account)')
on conflict (upn) do nothing;

alter table public.cost_recommendations add column if not exists source     text not null default 'person';
alter table public.cost_recommendations add column if not exists ai_key     text;
alter table public.cost_recommendations add column if not exists accounts   jsonb;
alter table public.cost_recommendations add column if not exists updated_at timestamptz;
alter table public.cost_recommendations drop constraint if exists cost_recommendations_status_check;
alter table public.cost_recommendations add constraint cost_recommendations_status_check
  check (status in ('proposed', 'approved', 'declined', 'withdrawn'));
-- one open AI proposal per rule
create unique index if not exists cost_recommendations_ai_open
  on public.cost_recommendations (ai_key) where status = 'proposed' and ai_key is not null;

notify pgrst, 'reload schema';
