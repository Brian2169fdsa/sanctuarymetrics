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

notify pgrst, 'reload schema';
