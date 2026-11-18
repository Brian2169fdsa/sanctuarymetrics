-- ============================================================================
-- SCI donors and the member-gift tracker (donors.html, "Who's giving").
-- Run once in Supabase → SQL Editor (it's also in ALL.sql). Safe to re-run.
--
-- PRIVATE DATA. Donor names, gift history and staff-entered mailing
-- addresses live only in these tables. Row level security is on with no
-- policies: only the site's server function (service-role key) can read or
-- write them, and it hands them only to signed-in staff with Reports access
-- (lib/donors.js). No emails, phone numbers or payment details are stored.
-- Never copy these rows into the repo, data/, or any static file.
-- ============================================================================

create table if not exists public.sci_donors (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (length(name) between 1 and 200),
  name_key           text not null unique,                 -- lower-cased, trimmed name: the seed/sync match key
  donorbox_ids       bigint[] not null default '{}',       -- one person can have several supporter records
  -- flags the team sets; the import and the sync never change them on an existing donor
  staff              boolean not null default false,
  anonymous          boolean not null default false,
  offline            boolean not null default false,
  notes              text not null default '',
  address            text not null default '',             -- optional, staff-entered, shown only on the detail panel
  -- giving figures
  seed_total         numeric(12,2) not null default 0,     -- from the CSV import, used until the donor is synced
  seed_gifts         integer not null default 0,
  seed_last          date,
  monthly_amount     numeric(10,2) not null default 0,     -- base monthly amount (before covered fees); 0 = not monthly
  monthly_source     text not null default 'none' check (monthly_source in ('none', 'import', 'team', 'donorbox')),
  synced_at          timestamptz,                          -- set once Donorbox gift history has replaced the seed figures
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  updated_by_name    text
);
create index if not exists sci_donors_ids on public.sci_donors using gin (donorbox_ids);

create table if not exists public.sci_gifts (
  id                    uuid primary key default gen_random_uuid(),
  donor_id              uuid not null references public.sci_donors (id) on delete cascade,
  gift_date             date not null,
  amount                numeric(12,2) not null check (amount > 0),
  campaign              text not null default '',
  kind                  text not null check (kind in ('one-time', 'recurring', 'offline')),
  source                text not null check (source in ('donorbox', 'manual')),
  donorbox_donation_id  bigint unique,
  note                  text not null default '',
  created_by_name       text,
  created_at            timestamptz not null default now()
);
create index if not exists sci_gifts_donor on public.sci_gifts (donor_id, gift_date);

create table if not exists public.sci_fulfillment (
  id                uuid primary key default gen_random_uuid(),
  donor_id          uuid not null references public.sci_donors (id) on delete cascade,
  item              text not null,
  apparel           boolean not null default false,
  reason            text not null default '',                -- e.g. "Cactus Wren tier", "Thank-you rule"
  status            text not null default 'owed'
                    check (status in ('not-owed', 'owed', 'packed', 'sent', 'delivered', 'declined')),
  size              text not null default '',
  method            text not null default 'mail' check (method in ('mail', 'hand-delivered')),
  sent_on           date,
  sent_by           text,
  tracking          text not null default '',
  updated_by_name   text,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (donor_id, item)
);

-- who changed what, and when
create table if not exists public.sci_donor_log (
  id          bigserial primary key,
  donor_id    uuid references public.sci_donors (id) on delete cascade,
  at          timestamptz not null default now(),
  by_name     text,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists sci_donor_log_donor on public.sci_donor_log (donor_id, at desc);

-- Donorbox supporter records the sync couldn't match to a donor, for a person to resolve
create table if not exists public.sci_donorbox_unmatched (
  donorbox_id   bigint primary key,
  name          text not null default '',
  total         numeric(12,2) not null default 0,
  gifts         integer not null default 0,
  last_gift     date,
  resolution    text check (resolution in ('ignored')),
  seen_at       timestamptz not null default now()
);

-- team settings (the thank-you rule, the last sync)
create table if not exists public.sci_donor_settings (
  key              text primary key,
  value            jsonb not null default '{}'::jsonb,
  updated_by_name  text,
  updated_at       timestamptz not null default now()
);

alter table public.sci_donors enable row level security;
alter table public.sci_gifts enable row level security;
alter table public.sci_fulfillment enable row level security;
alter table public.sci_donor_log enable row level security;
alter table public.sci_donorbox_unmatched enable row level security;
alter table public.sci_donor_settings enable row level security;

notify pgrst, 'reload schema';
