-- ============================================================================
-- Projects page: drag-and-drop priority order. Run once in Supabase →
-- SQL Editor (it's also in ALL.sql). Safe to re-run.
--
-- rank is the position on the tracker, 1 = top priority. Dragging a row
-- rewrites the ranks of the open items; done and cancelled items sit below.
-- L10 rocks keep theirs on their edit row (seed_key), like status edits.
-- ============================================================================
do $$
begin
  if to_regclass('public.projects') is not null then
    alter table public.projects add column if not exists rank double precision;
  end if;
end $$;

notify pgrst, 'reload schema';
