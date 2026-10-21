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
