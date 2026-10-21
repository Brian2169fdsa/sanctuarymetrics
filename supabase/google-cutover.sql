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

alter table public.google_accounts enable row level security;

notify pgrst, 'reload schema';
