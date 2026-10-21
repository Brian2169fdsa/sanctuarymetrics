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

notify pgrst, 'reload schema';
