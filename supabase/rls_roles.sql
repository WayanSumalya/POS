-- EPOS role-based security (server-side). Run AFTER schema.sql, and ONLY after step 1 below.
-- Why: until now any signed-in shop account could read/write everything through the Supabase API,
-- so "cashier" limits existed only in the app. This file makes the database enforce them.
--
-- HOW ROLES WORK
--   The role lives in the Supabase user's app_metadata ("role": "admin" or "cashier").
--   app_metadata can only be changed from the dashboard / service key, never by the user.
--   Use TWO shop accounts: one for the owner's devices (admin), one for cashier tablets (cashier).
--   (The server cannot tell individual cashiers apart, only admin vs cashier. A user with no role gets nothing.)
--
-- STEP 1 (do first, or you lock yourself out): give your existing shop account the admin role.
--   update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
--   where email = 'YOUR-SHOP-EMAIL';
-- STEP 2: Authentication -> Users -> Add user (auto confirm) for the cashier account, then:
--   update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"cashier"}'::jsonb
--   where email = 'CASHIER-SHOP-EMAIL';
-- STEP 3: run this whole file. STEP 4: on every device, Settings -> disconnect, then sign in again
--   (the role is read from the sign-in token, which refreshes at the next sign-in or within about an hour).
-- Keep "Allow new users to sign up" OFF.
--
-- WHAT A CASHIER ACCOUNT CAN DO
--   read      everything (the app needs it; the app only shows cashiers their own sales)
--   sales     add new sales; cannot edit, void or delete existing ones
--   moves     add stock movements that REMOVE stock only (a sale); cannot add stock
--   log       add entries only
--   customers add and edit (loyalty points); cannot delete
--   vault     only the invoice counter can move forward; settings stay untouched
--   everything else (products, prices, users/meta, suppliers, purchase orders, counts, receipts): ignored
-- Writes a cashier is not allowed to make are silently skipped (not an error), so a cashier tablet
-- never gets stuck on a sync error. An admin account can do everything. Nobody but admin can delete rows.
--
-- CREDENTIALS: app version 2026.11.18-17 and later keeps the PIN/password verifiers in separate 'creds' rows
-- (not in 'meta'). Administrator rows are hidden from cashier accounts; cashier PIN rows stay readable by
-- cashier accounts (6-digit PINs are weak, so treat them as a convenience, not a secret).
-- Update every device to that version, and sign in once with the ADMIN shop account: the first admin sign-in
-- uploads the 'creds' rows and overwrites the old shared 'meta' row (which used to contain the verifiers).
-- Old copies of that row may still exist in Supabase backups/logs, so CHANGE THE ADMIN PASSWORD afterwards.

create or replace function public.shop_role() returns text language sql stable as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')
$$;

-- table access: signed-in users with a role only; anonymous gets nothing
revoke all on public.docs from anon;
alter table public.docs enable row level security;
drop policy if exists "shop access" on public.docs;
drop policy if exists "docs read" on public.docs;
drop policy if exists "docs insert" on public.docs;
drop policy if exists "docs update" on public.docs;
drop policy if exists "docs delete" on public.docs;
-- 'creds' rows hold each user's salted password/PIN verifier. A cashier account may only read the cashier ones
-- (needed so a cashier can sign in on a tablet); administrator verifiers never leave an admin account.
create policy "docs read"   on public.docs for select to authenticated using (
  public.shop_role() = 'admin'
  or (public.shop_role() = 'cashier' and (store <> 'creds' or data ->> 'role' = 'cashier'))
);
create policy "docs insert" on public.docs for insert to authenticated with check (public.shop_role() in ('admin', 'cashier'));
create policy "docs update" on public.docs for update to authenticated using (public.shop_role() in ('admin', 'cashier')) with check (public.shop_role() in ('admin', 'cashier'));
create policy "docs delete" on public.docs for delete to authenticated using (public.shop_role() = 'admin');

-- per-row rules for the cashier role (runs before the "keep newest" and "stamp" triggers)
create or replace function public.docs_role_guard() returns trigger language plpgsql as $$
declare r text;
begin
  if auth.role() is distinct from 'authenticated' then return new; end if;  -- dashboard / SQL editor / service key
  r := public.shop_role();
  if r = 'admin' then return new; end if;
  if r <> 'cashier' then raise exception 'EPOS: this account has no role'; end if;

  if new.store = 'sales' then
    if tg_op = 'INSERT' then
      if new.del or coalesce(new.data ->> 'void', '') = 'true' then return null; end if;
      return new;
    end if;
    if old.data is distinct from new.data or old.del <> new.del then return null; end if; -- re-sending the same sale is fine, changing it is not
    return new;
  elsif new.store = 'moves' then
    if tg_op = 'INSERT' then
      if new.del or coalesce((new.data ->> 'd')::numeric, 0) >= 0 then return null; end if;  -- only stock going out
      return new;
    end if;
    if old.data is distinct from new.data or old.del <> new.del then return null; end if;
    return new;
  elsif new.store = 'log' then
    if tg_op = 'INSERT' then return new; end if;
    if old.data is distinct from new.data or old.del <> new.del then return null; end if;
    return new;
  elsif new.store = 'customers' then
    if new.del or (tg_op = 'UPDATE' and old.del) then return null; end if;
    return new;
  elsif new.store = 'vault' and tg_op = 'INSERT' then
    -- an upsert tries INSERT first: let it through only when the row exists, so the UPDATE rule below decides
    if exists (select 1 from public.docs d where d.store = new.store and d.id = new.id) then return new; end if;
    return null;
  elsif new.store = 'vault' and tg_op = 'UPDATE' and old.data is not null then
    -- only the invoice counter may advance; settings and the row's change time stay as the admin left them
    new.data := jsonb_set(old.data, '{seq}', to_jsonb(greatest(coalesce((old.data ->> 'seq')::bigint, 0), coalesce((new.data ->> 'seq')::bigint, 0))));
    new.upd := old.upd;
    new.del := old.del;
    return new;
  end if;
  return null; -- products, prices, meta (users), suppliers, purchase orders, counts, receipts: admin only
end $$;
drop trigger if exists docs_a0_role on public.docs;
create trigger docs_a0_role before insert or update on public.docs for each row execute function public.docs_role_guard();
