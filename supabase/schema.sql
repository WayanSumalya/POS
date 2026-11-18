-- EPOS shared database. Safe to run again at any time (it only adds what is missing).
-- Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- One generic table keeps the app simple and easy to move to another database later
-- (Postgres on a VPS, or MySQL: same columns).

create table if not exists public.docs (
  store text   not null,            -- products, sales, moves, customers, suppliers, pos, counts, grn, log, meta, vault
  id    text   not null,
  data  jsonb,                      -- the record itself (null when deleted)
  upd   bigint not null,            -- last change time set by the device (ms); newest wins
  del   boolean not null default false,
  primary key (store, id)
);
-- server-side change time: devices ask "what changed since X" with this, so a wrong device clock cannot hide changes
alter table public.docs add column if not exists srv timestamptz not null default clock_timestamp();
create index if not exists docs_srv_idx on public.docs (srv);

-- Only the signed-in shop account can read/write. Anonymous visitors get nothing.
alter table public.docs enable row level security;
drop policy if exists "shop access" on public.docs;
create policy "shop access" on public.docs for all to authenticated using (true) with check (true);

-- 1) never overwrite a newer version with an older one (two devices saving at the same time)
create or replace function public.docs_keep_newest() returns trigger language plpgsql as $$
begin
  if new.upd < old.upd then return null; end if;
  return new;
end $$;
drop trigger if exists docs_a_keep_newest on public.docs;
drop trigger if exists docs_keep_newest on public.docs;
create trigger docs_a_keep_newest before update on public.docs for each row execute function public.docs_keep_newest();

-- 2) stamp every insert/update with the server time
create or replace function public.docs_stamp() returns trigger language plpgsql as $$
begin
  new.srv := clock_timestamp();
  return new;
end $$;
drop trigger if exists docs_b_stamp on public.docs;
create trigger docs_b_stamp before insert or update on public.docs for each row execute function public.docs_stamp();

-- Live updates to every open device (skipped if already enabled).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
