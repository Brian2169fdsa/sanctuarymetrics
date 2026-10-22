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
-- personal-email invites (no Sanctuary Microsoft account): they open the link
-- with a 6-digit access code Brian gives them; only its hash is stored
alter table public.cpao_staff add column if not exists sign_in text not null default 'microsoft';
alter table public.cpao_staff add column if not exists invite_code_hash text;
alter table public.cpao_staff drop constraint if exists cpao_staff_sign_in_check;
alter table public.cpao_staff add constraint cpao_staff_sign_in_check check (sign_in in ('microsoft', 'code'));
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

notify pgrst, 'reload schema';
