-- ============================================================================
-- Sanctuary metrics: every table and function in one paste.
-- Supabase → SQL Editor → New query → paste all of this → Run. Safe to re-run.
-- Built from supabase/accounts.sql, site-analytics.sql and cost-cutting.sql.
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


notify pgrst, 'reload schema';
