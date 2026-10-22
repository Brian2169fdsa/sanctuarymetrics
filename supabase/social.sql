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

notify pgrst, 'reload schema';
