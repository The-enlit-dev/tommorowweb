-- M6: business-type configurations — restaurant tables, kitchen display (KDS), appointments.

-- ── Restaurant tables ───────────────────────────────────────────────────────
create table public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 40),
  area text check (length(area) <= 40),
  seats int check (seats between 1 and 50),
  sort int not null default 100,
  active boolean not null default true,
  unique (business_id, label)
);

-- ── Kitchen display ─────────────────────────────────────────────────────────
alter table public.order_items
  add column kds_status text not null default 'queued' check (kds_status in ('queued', 'preparing', 'ready', 'served')),
  add column kds_prev_status text,
  add column kds_bumped_at timestamptz,
  add column kds_bumped_by uuid;

create or replace function private.kds_order_sync(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_open int; v_preparing int;
begin
  select * into o from public.orders where id = p_order for update;
  if o.status not in ('new', 'accepted', 'processing') then return; end if;
  select count(*) filter (where kds_status in ('queued', 'preparing')), count(*) filter (where kds_status = 'preparing')
    into v_open, v_preparing from public.order_items where order_id = p_order;
  if v_open = 0 then
    update public.orders set status = 'ready', ready_at = now(), version = version + 1, status_changed_by = auth.uid(), status_changed_at = now() where id = p_order returning * into o;
    perform private.order_event(o, 'status', 'processing', 'ready', 'all items ready (kitchen)', 'kitchen display');
  elsif v_preparing > 0 and o.status in ('new', 'accepted') then
    update public.orders set status = 'processing', version = version + 1, status_changed_by = auth.uid(), status_changed_at = now() where id = p_order returning * into o;
    perform private.order_event(o, 'status', 'accepted', 'processing', 'kitchen started', 'kitchen display');
  end if;
end;
$$;

/* Bump one item to the next kitchen state (queued → preparing → ready → served), or to p_to. */
create or replace function public.kds_bump(p_item uuid, p_to text default null)
returns public.order_items language plpgsql security definer set search_path = '' as $$
declare i public.order_items; v_next text;
begin
  select * into i from public.order_items where id = p_item for update;
  if i.id is null or not private.can_orders(i.business_id, 'orders.update') or not private.module_on(i.business_id, 'kitchen_display') then
    raise exception 'Item not found' using errcode = '42501';
  end if;
  v_next := coalesce(p_to, case i.kds_status when 'queued' then 'preparing' when 'preparing' then 'ready' when 'ready' then 'served' else 'served' end);
  if v_next not in ('queued', 'preparing', 'ready', 'served') then raise exception 'Unknown kitchen state' using errcode = '22023'; end if;
  update public.order_items set kds_prev_status = kds_status, kds_status = v_next, kds_bumped_at = clock_timestamp(), kds_bumped_by = auth.uid() where id = p_item returning * into i;
  perform private.kds_order_sync(i.order_id);
  return i;
end;
$$;

/* Bump every open item of a ticket (optionally only one station). */
create or replace function public.kds_bump_order(p_order uuid, p_to text, p_station text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_biz uuid; n int;
begin
  select business_id into v_biz from public.orders where id = p_order;
  if v_biz is null or not private.can_orders(v_biz, 'orders.update') or not private.module_on(v_biz, 'kitchen_display') then raise exception 'Order not found' using errcode = '42501'; end if;
  if p_to not in ('preparing', 'ready', 'served') then raise exception 'Unknown kitchen state' using errcode = '22023'; end if;
  update public.order_items set kds_prev_status = kds_status, kds_status = p_to, kds_bumped_at = clock_timestamp(), kds_bumped_by = auth.uid()
  where order_id = p_order and (p_station is null or coalesce(station, '') = p_station)
    and array_position(array['queued', 'preparing', 'ready', 'served'], kds_status) < array_position(array['queued', 'preparing', 'ready', 'served'], p_to);
  get diagnostics n = row_count;
  perform private.kds_order_sync(p_order);
  return n;
end;
$$;

/* Undo the most recent bump in this business (the "recall" button). */
create or replace function public.kds_recall(p_business uuid, p_station text default null)
returns public.order_items language plpgsql security definer set search_path = '' as $$
declare i public.order_items; o public.orders;
begin
  if not private.can_orders(p_business, 'orders.update') then raise exception 'Not allowed' using errcode = '42501'; end if;
  select it.* into i from public.order_items it join public.orders ord on ord.id = it.order_id
  where it.business_id = p_business and it.kds_bumped_at is not null and it.kds_prev_status is not null
    and (p_station is null or coalesce(it.station, '') = p_station) and ord.status not in ('completed', 'cancelled', 'refunded', 'failed')
  order by it.kds_bumped_at desc limit 1 for update of it;
  if i.id is null then raise exception 'Nothing to recall' using errcode = 'P0001'; end if;
  update public.order_items set kds_status = kds_prev_status, kds_prev_status = null, kds_bumped_at = clock_timestamp() where id = i.id returning * into i;
  select * into o from public.orders where id = i.order_id for update;
  if o.status = 'ready' and i.kds_status in ('queued', 'preparing') then
    update public.orders set status = 'processing', version = version + 1, status_changed_by = auth.uid(), status_changed_at = now() where id = o.id returning * into o;
    perform private.order_event(o, 'status', 'ready', 'processing', 'recalled on kitchen display', 'kitchen display');
  end if;
  return i;
end;
$$;

-- ── Appointments ────────────────────────────────────────────────────────────
alter table public.products add column duration_min int check (duration_min between 5 and 720);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  service_id uuid references public.products (id) on delete set null,
  service_name text not null,
  staff_id uuid references public.profiles (id) on delete set null,
  customer_name text not null check (length(trim(customer_name)) between 1 and 120),
  customer_phone text check (customer_phone ~ '^\+?[0-9]{8,15}$'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked', 'confirmed', 'in_progress', 'done', 'cancelled', 'no_show')),
  notes text check (length(notes) <= 1000),
  price numeric(10, 2),
  order_id uuid references public.orders (id) on delete set null,
  version int not null default 1,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appointments_biz_time_idx on public.appointments (business_id, starts_at);
create index appointments_staff_idx on public.appointments (staff_id, starts_at);

create or replace function private.appointment_before()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_clash record; p public.products;
begin
  if new.service_id is not null then
    select * into p from public.products where id = new.service_id;
    if p.business_id is distinct from new.business_id then raise exception 'Service belongs to another business' using errcode = '22023'; end if;
    new.service_name := coalesce(nullif(new.service_name, ''), p.name);
    if tg_op = 'INSERT' and new.ends_at is null then new.ends_at := new.starts_at + make_interval(mins => coalesce(p.duration_min, 30)); end if;
  end if;
  if new.staff_id is not null and not exists (select 1 from public.business_members where business_id = new.business_id and user_id = new.staff_id and active) then
    raise exception 'That staff member is not part of this business' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then new.version := old.version + 1; end if;
  -- No double-booking a staff member (serialised per staff member).
  if new.staff_id is not null and new.status not in ('cancelled', 'no_show') then
    perform pg_advisory_xact_lock(hashtextextended(new.staff_id::text, 0));
    select a.* into v_clash from public.appointments a
    where a.staff_id = new.staff_id and a.id <> new.id and a.status not in ('cancelled', 'no_show')
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(new.starts_at, new.ends_at) limit 1;
    if v_clash.id is not null then
      raise exception 'Already booked % – % (%)', to_char(v_clash.starts_at at time zone 'Asia/Kolkata', 'HH24:MI'), to_char(v_clash.ends_at at time zone 'Asia/Kolkata', 'HH24:MI'), v_clash.service_name using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
create trigger appointments_before before insert or update on public.appointments for each row execute function private.appointment_before();
create trigger appointments_touch before update on public.appointments for each row execute function private.touch_updated_at();

-- ── Grants & RLS ────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['kds_bump(uuid, text)', 'kds_bump_order(uuid, text, text)', 'kds_recall(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on public.restaurant_tables, public.appointments from anon;

alter table public.restaurant_tables enable row level security;
create policy restaurant_tables_select on public.restaurant_tables for select to authenticated
  using ((select private.orders_member(business_id)) and (select private.module_on(business_id, 'restaurant')) or (select private.is_admin()));
create policy restaurant_tables_write on public.restaurant_tables for all to authenticated
  using ((select private.can_orders(business_id, 'products.manage')) and (select private.module_on(business_id, 'restaurant')) or (select private.is_admin()))
  with check ((select private.can_orders(business_id, 'products.manage')) and (select private.module_on(business_id, 'restaurant')) or (select private.is_admin()));

create or replace function private.can_appointments(biz uuid, perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'appointments') and private.has_perm(biz, perm));
$$;
alter table public.appointments enable row level security;
create policy appointments_select on public.appointments for select to authenticated
  using ((select private.can_appointments(business_id, 'orders.view')) or staff_id = (select auth.uid()) and (select private.can_appointments(business_id, 'pos.sell')));
create policy appointments_insert on public.appointments for insert to authenticated with check ((select private.can_appointments(business_id, 'orders.update')));
create policy appointments_update on public.appointments for update to authenticated
  using ((select private.can_appointments(business_id, 'orders.update'))) with check ((select private.can_appointments(business_id, 'orders.update')));
create policy appointments_delete on public.appointments for delete to authenticated using ((select private.can_appointments(business_id, 'settings.manage')));
create trigger appointments_audit after delete on public.appointments for each row execute function private.audit_row();

alter publication supabase_realtime add table public.appointments;
