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
