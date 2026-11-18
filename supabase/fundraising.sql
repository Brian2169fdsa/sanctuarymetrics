-- ============================================================================
-- SCI Fundraising page (fundraising.html): the team's shared edits.
-- Run once in Supabase → SQL Editor (it's also in ALL.sql). Safe to re-run.
--
-- One row per edited item, keyed by the item's id in
-- data/sci-fundraising-data.json, prefixed by kind:
--   check:<id>      build checklist status          {status}
--   decision:<id>   open decision                   {status, notes}
--   post:<id>       social post                     {status, finalLink, publishedUrl, release, approvedBy}
--   copy:<id>       a dated copy of a template post {template, date, ...post fields}
--   campaign:<id>   campaign extras                 {link}
--   run:<id>        an automation's last run, reported by n8n {lastRun, lastStatus, message}
--   setting:<name>  page settings (admins)          e.g. setting:autopost {on}, setting:qco {confirmed, code}
--
-- No donor data ever lands here: the page and n8n only write statuses,
-- links and notes. Row level security on, no policies: only the site's
-- server function (service-role key) reads or writes it.
-- ============================================================================

create table if not exists public.fundraising_state (
  item_id          text primary key check (length(item_id) between 3 and 120),
  kind             text not null check (kind in ('check', 'decision', 'post', 'copy', 'campaign', 'run', 'setting')),
  data             jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  updated_by_name  text
);
create index if not exists fundraising_state_kind on public.fundraising_state (kind);
alter table public.fundraising_state enable row level security;

notify pgrst, 'reload schema';
