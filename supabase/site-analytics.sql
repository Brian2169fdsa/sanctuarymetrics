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

notify pgrst, 'reload schema';
