-- ============================================================================
-- Print shop order tracking: what's been ordered, where each order is, and
-- where the team handed the materials out. Run once in Supabase → SQL Editor
-- (it's also in ALL.sql). Safe to re-run.
--
--   print_orders    one row per order (a flyer version, business cards, …)
--                   moving Requested → Ordered → Shipped → Delivered →
--                   All handed out (or Cancelled)
--   print_handouts  one row each time someone hands materials out: what,
--                   how many, where / which event, and who
--
-- Print requests from the shop (api/requests.js) that ask for prints add a
-- "Requested" order here automatically. Row level security is on with no
-- policies: only the site's server function can read or write.
-- ============================================================================

create table if not exists public.print_orders (
  id               uuid primary key default gen_random_uuid(),
  item             text not null check (length(item) between 1 and 200),   -- "Change Your Life Story"
  kind             text not null default 'flyer' check (kind in ('flyer', 'business_cards', 'presentation', 'other')),
  item_ref         text,                 -- flyer version id from flyers.js, e.g. 'adolescent-b'
  quantity         integer check (quantity is null or quantity >= 0),
  status           text not null default 'requested' check (status in (
                     'requested', 'ordered', 'shipped', 'delivered', 'handed_out', 'cancelled')),
  vendor           text,
  expected_on      date,                 -- when it should arrive
  delivered_on     date,
  stored_at        text,                 -- where the boxes are once delivered
  notes            text,
  project_id       uuid,                 -- the request on the Projects page, if it came from one
  requested_by_name text,
  updated_by_name  text,
  seed_key         text unique,          -- rows this file adds, so a re-run doesn't duplicate them
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists print_orders_status on public.print_orders (status, created_at desc);

create table if not exists public.print_handouts (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid references public.print_orders (id) on delete set null,
  item             text not null check (length(item) between 1 and 200),
  quantity         integer not null check (quantity between 1 and 100000),
  handed_out_on    date not null default current_date,
  location         text not null check (length(location) between 1 and 300),  -- where / which event
  audience         text,                 -- who got them: referral partners, a hospital, a school…
  notes            text,
  created_by       uuid references public.app_users (id) on delete set null,
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index if not exists print_handouts_order on public.print_handouts (order_id);
create index if not exists print_handouts_when on public.print_handouts (handed_out_on desc, created_at desc);

alter table public.print_orders   enable row level security;
alter table public.print_handouts enable row level security;

-- the first orders: every flyer in the shop, ordered, arriving Friday 10/23/2026.
-- Set each quantity on the print shop page (Order status → Edit).
insert into public.print_orders (item, kind, item_ref, status, expected_on, notes, requested_by_name, seed_key)
values
  ('Change Your Life Story',                  'flyer', 'life-story',          'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:life-story'),
  ('Addiction Treatment For All',             'flyer', 'treatment-for-all',   'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:treatment-for-all'),
  ('Let''s Take Next Steps Together',         'flyer', 'next-steps-together', 'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:next-steps-together'),
  ('Careers — Grow Here',                     'flyer', 'careers-grow-here',   'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:careers-grow-here'),
  ('Male Adolescent Program — Version A',     'flyer', 'adolescent-a',        'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:adolescent-a'),
  ('Male Adolescent Program — Version B',     'flyer', 'adolescent-b',        'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:adolescent-b'),
  ('Male Adolescent Program — Version C',     'flyer', 'adolescent-c',        'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:adolescent-c'),
  ('Women''s Program',                        'flyer', 'womens-program',      'ordered', '2026-10-23', 'First flyer order — delivery Friday.', 'Brian Reinhart', 'flyers-2026-10-23:womens-program')
on conflict (seed_key) do nothing;

notify pgrst, 'reload schema';
