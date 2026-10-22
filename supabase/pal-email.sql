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
