-- M5: POS, orders, inventory, customers, discounts, payments, refunds, invoices, reports.
-- Writes to orders/payments/stock happen ONLY through the security-definer functions below
-- (the browser has no insert/update grants), which enforce permissions, idempotency, stock
-- locking, optimistic locking and the UPI rule: a UPI payment becomes "paid" only when a staff
-- member confirms it, or when a verified payment-gateway webhook confirms it (service role).

-- ── Helpers ─────────────────────────────────────────────────────────────────
create or replace function private.can_orders(biz uuid, perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'orders') and private.has_perm(biz, perm));
$$;
create or replace function private.orders_member(biz uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'orders') and private.is_member(biz) and private.is_active_user(auth.uid()));
$$;
create or replace function private.money(n numeric) returns numeric language sql immutable set search_path = '' as $$
  select round(coalesce(n, 0), 2);
$$;
create or replace function private.actor_name() returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(full_name, ''), email) from public.profiles where id = auth.uid();
$$;

-- ── Settings ────────────────────────────────────────────────────────────────
create table public.commerce_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  legal_name text check (length(legal_name) <= 200),
  address text check (length(address) <= 500),
  gstin text check (gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  state_code text check (state_code ~ '^[0-9]{2}$'),
  prices_include_tax boolean not null default true,
  invoice_prefix text not null default 'INV-' check (length(invoice_prefix) <= 12),
  next_invoice_no int not null default 1,
  next_order_no int not null default 1,
  upi_id text check (upi_id ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
  upi_name text check (length(upi_name) <= 60),
  receipt_footer text check (length(receipt_footer) <= 300),
  unpaid_online_expiry_minutes int not null default 30 check (unpaid_online_expiry_minutes between 5 and 1440),
  updated_at timestamptz not null default now()
);
comment on table public.commerce_settings is 'Per-business POS/invoice settings. GST-aware, not certified GST-compliant (no e-invoicing/IRN).';

create table public.tax_rates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  rate_pct numeric(5, 2) not null check (rate_pct between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index tax_rates_biz_idx on public.tax_rates (business_id);

-- ── Catalogue ───────────────────────────────────────────────────────────────
create table public.product_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  sort int not null default 100,
  active boolean not null default true
);
create index product_categories_biz_idx on public.product_categories (business_id);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  category_id uuid references public.product_categories (id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 160),
  description text check (length(description) <= 4000),
  kind text not null default 'good' check (kind in ('good', 'service')),
  hsn_sac text check (hsn_sac ~ '^[0-9]{4,8}$'),
  tax_rate_id uuid references public.tax_rates (id) on delete set null,
  station text check (length(station) <= 40),
  image_path text,
  fulfilment text not null default 'own_stock' check (fulfilment in ('own_stock', 'printify')),
  online boolean not null default false,
  slug text check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  active boolean not null default true,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, slug)
);
create index products_biz_idx on public.products (business_id, active);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  name text not null default 'Standard' check (length(trim(name)) between 1 and 120),
  options jsonb not null default '{}',
  sku text check (length(sku) between 1 and 64),
  barcode text check (barcode ~ '^[0-9A-Za-z-]{4,32}$'),
  price numeric(10, 2) not null check (price >= 0),
  track_stock boolean not null default false,
  stock int not null default 0,
  low_stock_at int check (low_stock_at >= 0),
  active boolean not null default true,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, sku),
  unique (business_id, barcode)
);
create index product_variants_product_idx on public.product_variants (product_id);
comment on column public.product_variants.stock is 'Cached on-hand quantity; changed only together with a stock_movements row (see check_stock_integrity).';

create table public.stock_movements (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  qty int not null check (qty <> 0),
  reason text not null check (reason in ('sale', 'cancel', 'refund', 'adjust', 'receive', 'expired', 'opening')),
  order_id uuid,
  note text check (length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index stock_movements_variant_idx on public.stock_movements (variant_id, created_at desc);

-- ── Customers & discounts ───────────────────────────────────────────────────
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text check (length(name) <= 120),
  phone text check (phone ~ '^\+?[0-9]{8,15}$'),
  email text check (length(email) <= 200),
  notes text check (length(notes) <= 2000),
  created_at timestamptz not null default now(),
  unique (business_id, phone)
);

create table public.discounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{2,30}$'),
  kind text not null check (kind in ('percent', 'amount')),
  value numeric(10, 2) not null check (value > 0),
  min_subtotal numeric(10, 2) not null default 0,
  max_uses int check (max_uses > 0),
  uses int not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (business_id, code),
  check (kind <> 'percent' or value <= 100)
);

-- ── Orders ──────────────────────────────────────────────────────────────────
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  number int not null,
  channel text not null check (channel in ('pos', 'online', 'table', 'takeaway', 'delivery')),
  status text not null check (status in ('pending_payment', 'new', 'accepted', 'processing', 'ready', 'completed', 'cancelled', 'refunded', 'payment_failed', 'failed')),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded')),
  customer_id uuid references public.customers (id) on delete set null,
  customer_name text check (length(customer_name) <= 120),
  customer_phone text check (length(customer_phone) <= 20),
  customer_email text check (length(customer_email) <= 200),
  table_label text check (length(table_label) <= 40),
  notes text check (length(notes) <= 1000),
  subtotal numeric(10, 2) not null,
  discount_total numeric(10, 2) not null default 0,
  tax_total numeric(10, 2) not null default 0,
  shipping_total numeric(10, 2) not null default 0,
  total numeric(10, 2) not null,
  discount_code text,
  tax_breakdown jsonb not null default '[]',
  place_of_supply text,
  idempotency_key text not null check (length(idempotency_key) between 8 and 100),
  version int not null default 1,
  invoice_no text,
  invoiced_at timestamptz,
  expires_at timestamptz,
  failure_reason text check (length(failure_reason) <= 300),
  cancel_reason text check (length(cancel_reason) <= 300),
  shipping_address jsonb,
  tracking_token text unique default encode(extensions.gen_random_bytes(16), 'hex'),
  created_by uuid default auth.uid(),
  accepted_by uuid, accepted_at timestamptz,
  ready_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  status_changed_by uuid, status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, number),
  unique (business_id, idempotency_key)
);
create index orders_biz_idx on public.orders (business_id, created_at desc);
create index orders_status_idx on public.orders (business_id, status);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  business_id uuid not null,
  variant_id uuid references public.product_variants (id) on delete set null,
  product_name text not null,
  variant_name text,
  sku text,
  hsn_sac text,
  qty int not null check (qty between 1 and 999),
  unit_price numeric(10, 2) not null,
  tax_rate_pct numeric(5, 2) not null default 0,
  line_subtotal numeric(10, 2) not null,
  line_discount numeric(10, 2) not null default 0,
  line_tax numeric(10, 2) not null default 0,
  line_total numeric(10, 2) not null,
  station text,
  notes text check (length(notes) <= 200),
  restocked boolean not null default false,
  fulfilment text not null default 'own_stock'
);
create index order_items_order_idx on public.order_items (order_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  business_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_name text,
  kind text not null check (kind in ('created', 'status', 'payment', 'refund', 'note', 'fulfilment')),
  from_status text,
  to_status text,
  reason text,
  device text check (length(device) <= 80)
);
create index order_events_order_idx on public.order_events (order_id, id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null references public.orders (id) on delete cascade,
  method text not null check (method in ('cash', 'upi', 'razorpay', 'card_manual')),
  amount numeric(10, 2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired', 'cancelled')),
  idempotency_key text not null,
  upi_ref text check (length(upi_ref) <= 40),
  cash_tendered numeric(10, 2),
  change_due numeric(10, 2),
  gateway_order_id text,
  gateway_payment_id text unique,
  gateway_verified boolean not null default false,
  gateway_fee numeric(10, 2),
  failure_reason text check (length(failure_reason) <= 300),
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (business_id, idempotency_key)
);
create index payments_order_idx on public.payments (order_id);

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null references public.orders (id) on delete cascade,
  payment_id uuid references public.payments (id) on delete set null,
  amount numeric(10, 2) not null check (amount > 0),
  reason text not null check (length(trim(reason)) between 2 and 300),
  restocked boolean not null default false,
  idempotency_key text not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (business_id, idempotency_key)
);

create table public.member_prefs (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  channels text[] not null default '{pos,online,table,takeaway,delivery}',
  stations text[] not null default '{}',
  sound boolean not null default true,
  primary key (business_id, user_id)
);

-- The UPI / payment rule, enforced at the table level as a last line of defence.
create or replace function private.payment_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status <> 'paid') then
    if new.method in ('cash', 'card_manual') and new.confirmed_by is null then
      raise exception 'Cash/card payments must be recorded by a staff member' using errcode = '42501';
    elsif new.method = 'upi' and (new.confirmed_by is null or new.confirmed_at is null) then
      raise exception 'UPI payments are marked paid only when a staff member confirms them' using errcode = '42501';
    elsif new.method = 'razorpay' and not (coalesce(new.gateway_verified, false) and coalesce(current_setting('tw.gateway_webhook', true), '') = 'verified') then
      raise exception 'Online payments are marked paid only by a verified payment-gateway webhook' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'paid' and new.status <> 'paid' then
    raise exception 'A paid payment can’t be changed; issue a refund instead' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger payments_guard before insert or update on public.payments for each row execute function private.payment_guard();

create trigger commerce_settings_touch before update on public.commerce_settings for each row execute function private.touch_updated_at();
create trigger products_touch before update on public.products for each row execute function private.touch_updated_at();
create trigger variants_touch before update on public.product_variants for each row execute function private.touch_updated_at();
create trigger orders_touch before update on public.orders for each row execute function private.touch_updated_at();

-- Price, discount and refund changes are audited.
create or replace function private.audit_price()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.price is distinct from old.price then
    perform private.write_audit('price:change', 'product_variants', new.id::text, new.business_id, jsonb_build_object('before', old.price, 'after', new.price, 'variant', new.name));
  end if;
  return new;
end;
$$;
create trigger variants_audit_price after update on public.product_variants for each row execute function private.audit_price();
create trigger discounts_audit after insert or update or delete on public.discounts for each row execute function private.audit_row();
create trigger tax_rates_audit after insert or update or delete on public.tax_rates for each row execute function private.audit_row();

-- Business/product consistency.
create or replace function private.catalogue_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'product_variants' then
    new.business_id := (select business_id from public.products where id = new.product_id);
    if tg_op = 'UPDATE' and new.stock is distinct from old.stock and current_setting('tw.stock', true) is distinct from 'on' then
      raise exception 'Change stock with a stock adjustment so it is recorded' using errcode = '42501';
    end if;
    if tg_op = 'INSERT' and new.stock <> 0 and current_setting('tw.stock', true) is distinct from 'on' then
      new.stock := 0;
    end if;
  elsif tg_table_name = 'products' then
    if new.category_id is not null and (select business_id from public.product_categories where id = new.category_id) is distinct from new.business_id then
      raise exception 'Category belongs to another business' using errcode = '22023';
    end if;
    if new.tax_rate_id is not null and (select business_id from public.tax_rates where id = new.tax_rate_id) is distinct from new.business_id then
      raise exception 'Tax rate belongs to another business' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger variants_before_write before insert or update on public.product_variants for each row execute function private.catalogue_before_write();
create trigger products_before_write before insert or update on public.products for each row execute function private.catalogue_before_write();

-- ── Stock ───────────────────────────────────────────────────────────────────
create or replace function private.move_stock(p_variant uuid, p_qty int, p_reason text, p_order uuid, p_note text)
returns int language plpgsql security definer set search_path = '' as $$
declare v public.product_variants; n int;
begin
  select * into v from public.product_variants where id = p_variant for update;
  if not v.track_stock then return v.stock; end if;
  insert into public.stock_movements (business_id, variant_id, qty, reason, order_id, note, created_by)
  values (v.business_id, p_variant, p_qty, p_reason, p_order, left(p_note, 300), auth.uid());
  perform set_config('tw.stock', 'on', true);
  update public.product_variants set stock = stock + p_qty where id = p_variant returning stock into n;
  perform set_config('tw.stock', 'off', true);
  return n;
end;
$$;

create or replace function public.adjust_stock(p_variant uuid, p_delta int, p_reason text default 'adjust', p_note text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare v_biz uuid; v_track boolean;
begin
  select business_id, track_stock into v_biz, v_track from public.product_variants where id = p_variant;
  if v_biz is null or not private.can_orders(v_biz, 'inventory.manage') then raise exception 'You don’t have permission to change stock' using errcode = '42501'; end if;
  if p_delta = 0 then raise exception 'Enter a quantity' using errcode = '22023'; end if;
  if p_reason not in ('adjust', 'receive', 'opening', 'expired') then raise exception 'Unknown reason' using errcode = '22023'; end if;
  if not v_track then
    perform set_config('tw.stock', 'on', true);
    update public.product_variants set track_stock = true where id = p_variant;
    perform set_config('tw.stock', 'off', true);
  end if;
  return private.move_stock(p_variant, p_delta, p_reason, null, p_note);
end;
$$;

create or replace function public.check_stock_integrity(p_business uuid)
returns table (variant_id uuid, name text, cached int, from_movements int)
language sql stable security definer set search_path = '' as $$
  select v.id, p.name || ' — ' || v.name, v.stock, coalesce(sum(m.qty), 0)::int
  from public.product_variants v join public.products p on p.id = v.product_id
  left join public.stock_movements m on m.variant_id = v.id
  where v.business_id = p_business and v.track_stock and private.can_orders(p_business, 'inventory.manage')
  group by v.id, p.name, v.name, v.stock
  having v.stock <> coalesce(sum(m.qty), 0);
$$;

-- ── Orders ──────────────────────────────────────────────────────────────────
create or replace function private.order_event(p_order public.orders, p_kind text, p_from text, p_to text, p_reason text, p_device text)
returns void language sql security definer set search_path = '' as $$
  insert into public.order_events (order_id, business_id, actor_id, actor_name, kind, from_status, to_status, reason, device)
  values (p_order.id, p_order.business_id, auth.uid(), private.actor_name(), p_kind, p_from, p_to, left(p_reason, 300), left(p_device, 80));
$$;

/*
  create_order: p_items = [{"variant_id": uuid, "qty": int, "notes": text?}]
  Prices, discounts and taxes are recalculated here; totals from the browser are never trusted.
  A retried call with the same idempotency key returns the original order.
*/
create or replace function public.create_order(
  p_business uuid, p_items jsonb, p_idempotency_key text, p_channel text default 'pos',
  p_customer jsonb default '{}', p_discount_code text default null, p_table text default null,
  p_notes text default null, p_device text default null, p_shipping numeric default 0, p_shipping_address jsonb default null)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare
  s public.commerce_settings; o public.orders; existing public.orders; d public.discounts;
  it record; v record; v_sub numeric := 0; v_disc numeric := 0; v_tax numeric := 0; v_lines jsonb := '[]';
  v_status text; v_cust uuid; v_ratio numeric; line jsonb; v_line_disc numeric; v_line_tax numeric; v_line_total numeric;
  v_service boolean := auth.role() = 'service_role';
begin
  if p_channel not in ('pos', 'online', 'table', 'takeaway', 'delivery') then raise exception 'Unknown channel' using errcode = '22023'; end if;
  if p_channel = 'online' and not v_service then raise exception 'Online orders come from the store checkout' using errcode = '42501'; end if;
  if not v_service and not private.can_orders(p_business, 'pos.sell') then raise exception 'You don’t have permission to take orders' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then raise exception 'Missing idempotency key' using errcode = '22023'; end if;

  select * into existing from public.orders where business_id = p_business and idempotency_key = p_idempotency_key;
  if existing.id is not null then return existing; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'The order is empty' using errcode = '22023'; end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Too many items' using errcode = '22023'; end if;

  -- Lock the settings row (order numbers) and every variant row (stock) in a stable order.
  insert into public.commerce_settings (business_id) values (p_business) on conflict do nothing;
  select * into s from public.commerce_settings where business_id = p_business for update;
  perform 1 from public.product_variants where id in (select (x ->> 'variant_id')::uuid from jsonb_array_elements(p_items) x) order by id for update;

  for it in select (x ->> 'variant_id')::uuid as variant_id, sum((x ->> 'qty')::int)::int as qty, max(x ->> 'notes') as notes
            from jsonb_array_elements(p_items) x group by 1 loop
    if it.qty is null or it.qty < 1 or it.qty > 999 then raise exception 'Invalid quantity' using errcode = '22023'; end if;
    select pv.*, p.name as product_name, p.hsn_sac, p.station, p.fulfilment, p.online, p.active as product_active, coalesce(t.rate_pct, 0) as rate
      into v from public.product_variants pv join public.products p on p.id = pv.product_id left join public.tax_rates t on t.id = p.tax_rate_id
      where pv.id = it.variant_id;
    if v.id is null or v.business_id <> p_business then raise exception 'An item is not available' using errcode = '22023'; end if;
    if not v.active or not v.product_active or (p_channel = 'online' and not v.online) then raise exception '% is not available right now', v.product_name using errcode = '22023'; end if;
    if v.track_stock and v.stock < it.qty then
      raise exception 'Only % left of %', greatest(v.stock, 0), v.product_name || case when v.name <> 'Standard' then ' (' || v.name || ')' else '' end using errcode = 'P0001';
    end if;
    v_lines := v_lines || jsonb_build_object('variant_id', v.id, 'product_name', v.product_name, 'variant_name', v.name, 'sku', v.sku, 'hsn_sac', v.hsn_sac,
      'qty', it.qty, 'unit_price', v.price, 'rate', v.rate, 'station', v.station, 'notes', left(it.notes, 200), 'fulfilment', v.fulfilment,
      'line_subtotal', private.money(v.price * it.qty));
    v_sub := v_sub + private.money(v.price * it.qty);
  end loop;

  if nullif(trim(p_discount_code), '') is not null then
    select * into d from public.discounts where business_id = p_business and code = upper(trim(p_discount_code)) for update;
    if d.id is null or not d.active or (d.starts_at is not null and now() < d.starts_at) or (d.ends_at is not null and now() > d.ends_at)
       or (d.max_uses is not null and d.uses >= d.max_uses) then
      raise exception 'That discount code isn’t valid' using errcode = 'P0001';
    end if;
    if v_sub < d.min_subtotal then raise exception 'That code needs a minimum order of ₹%', d.min_subtotal using errcode = 'P0001'; end if;
    v_disc := least(v_sub, private.money(case when d.kind = 'percent' then v_sub * d.value / 100 else d.value end));
    update public.discounts set uses = uses + 1 where id = d.id;
  end if;

  -- Customer (optional).
  if coalesce(p_customer ->> 'phone', '') ~ '^\+?[0-9]{8,15}$' then
    insert into public.customers (business_id, name, phone, email) values (p_business, nullif(left(p_customer ->> 'name', 120), ''), p_customer ->> 'phone', nullif(left(p_customer ->> 'email', 200), ''))
    on conflict (business_id, phone) do update set name = coalesce(excluded.name, public.customers.name), email = coalesce(excluded.email, public.customers.email)
    returning id into v_cust;
  end if;

  v_status := case when p_channel = 'online' then 'pending_payment' else 'new' end;
  insert into public.orders (business_id, number, channel, status, customer_id, customer_name, customer_phone, customer_email, table_label, notes,
    subtotal, discount_total, tax_total, shipping_total, total, discount_code, place_of_supply, idempotency_key, expires_at, shipping_address, created_by, status_changed_by)
  values (p_business, s.next_order_no, p_channel, v_status, v_cust, nullif(left(p_customer ->> 'name', 120), ''), nullif(left(p_customer ->> 'phone', 20), ''),
    nullif(left(p_customer ->> 'email', 200), ''), nullif(left(p_table, 40), ''), nullif(left(p_notes, 1000), ''),
    v_sub, v_disc, 0, private.money(greatest(coalesce(p_shipping, 0), 0)), 0, case when d.id is not null then d.code end, s.state_code, p_idempotency_key,
    case when p_channel = 'online' then now() + make_interval(mins => s.unpaid_online_expiry_minutes) end, p_shipping_address, auth.uid(), auth.uid())
  returning * into o;
  update public.commerce_settings set next_order_no = next_order_no + 1 where business_id = p_business;

  -- Lines: spread the discount proportionally; tax per line (inclusive or exclusive prices).
  v_ratio := case when v_sub > 0 then v_disc / v_sub else 0 end;
  for line in select * from jsonb_array_elements(v_lines) loop
    v_line_disc := private.money((line ->> 'line_subtotal')::numeric * v_ratio);
    if s.prices_include_tax then
      v_line_total := (line ->> 'line_subtotal')::numeric - v_line_disc;
      v_line_tax := private.money(v_line_total - v_line_total / (1 + (line ->> 'rate')::numeric / 100));
    else
      v_line_tax := private.money(((line ->> 'line_subtotal')::numeric - v_line_disc) * (line ->> 'rate')::numeric / 100);
      v_line_total := (line ->> 'line_subtotal')::numeric - v_line_disc + v_line_tax;
    end if;
    v_tax := v_tax + v_line_tax;
    insert into public.order_items (order_id, business_id, variant_id, product_name, variant_name, sku, hsn_sac, qty, unit_price, tax_rate_pct,
      line_subtotal, line_discount, line_tax, line_total, station, notes, fulfilment)
    values (o.id, p_business, (line ->> 'variant_id')::uuid, line ->> 'product_name', line ->> 'variant_name', line ->> 'sku', line ->> 'hsn_sac',
      (line ->> 'qty')::int, (line ->> 'unit_price')::numeric, (line ->> 'rate')::numeric, (line ->> 'line_subtotal')::numeric, v_line_disc, v_line_tax,
      v_line_total, line ->> 'station', line ->> 'notes', line ->> 'fulfilment');
    perform private.move_stock((line ->> 'variant_id')::uuid, -(line ->> 'qty')::int, 'sale', o.id, null);
  end loop;

  update public.orders set tax_total = v_tax,
    total = private.money(case when s.prices_include_tax then v_sub - v_disc else v_sub - v_disc + v_tax end + shipping_total)
  where id = o.id returning * into o;
  perform private.order_event(o, 'created', null, o.status, null, p_device);
  return o;
end;
$$;

-- Allowed transitions for staff (payment-driven ones happen in the payment functions).
create or replace function private.order_next_ok(p_from text, p_to text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_from
    when 'new' then p_to in ('accepted', 'processing', 'ready', 'completed', 'cancelled')
    when 'accepted' then p_to in ('processing', 'ready', 'completed', 'cancelled')
    when 'processing' then p_to in ('ready', 'completed', 'cancelled')
    when 'ready' then p_to in ('completed', 'processing', 'cancelled')
    when 'pending_payment' then p_to in ('cancelled')
    when 'payment_failed' then p_to in ('cancelled')
    else false end;
$$;

create or replace function private.restock_order(p_order uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare i record;
begin
  for i in select * from public.order_items where order_id = p_order and not restocked and variant_id is not null for update loop
    perform private.move_stock(i.variant_id, i.qty, p_reason, p_order, null);
    update public.order_items set restocked = true where id = i.id;
  end loop;
end;
$$;

create or replace function private.assign_invoice(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; s public.commerce_settings; v_breakdown jsonb;
begin
  select * into o from public.orders where id = p_order for update;
  if o.invoice_no is not null or o.payment_status <> 'paid' then return; end if;
  select * into s from public.commerce_settings where business_id = o.business_id for update;
  -- Intra-state (same state code or unknown) → CGST + SGST halves; otherwise IGST.
  select coalesce(jsonb_agg(jsonb_build_object('rate', tax_rate_pct, 'taxable', taxable, 'tax', tax,
           'cgst', case when intra then round(tax / 2, 2) end, 'sgst', case when intra then tax - round(tax / 2, 2) end, 'igst', case when not intra then tax end)), '[]')
    into v_breakdown
  from (select tax_rate_pct, sum(line_total - line_tax) as taxable, sum(line_tax) as tax,
          (o.place_of_supply is null or s.state_code is null or o.place_of_supply = s.state_code) as intra
        from public.order_items where order_id = p_order group by tax_rate_pct) t;
  update public.orders set invoice_no = s.invoice_prefix || lpad(s.next_invoice_no::text, 5, '0'), invoiced_at = now(), tax_breakdown = v_breakdown where id = p_order;
  update public.commerce_settings set next_invoice_no = next_invoice_no + 1 where business_id = o.business_id;
end;
$$;

/* Optimistic locking: succeeds only if the order is still at p_expected_version. */
create or replace function public.order_transition(p_order uuid, p_expected_version int, p_to text, p_reason text default null, p_device text default null)
returns public.orders language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_who text; v_from text;
begin
  select * into o from public.orders where id = p_order for update;
  v_from := o.status;
  if o.id is null or not private.can_orders(o.business_id, 'orders.update') then raise exception 'Order not found' using errcode = '42501'; end if;
  if o.version <> p_expected_version then
    select coalesce(nullif(full_name, ''), email) into v_who from public.profiles where id = o.status_changed_by;
    raise exception 'Already % by % at %', replace(o.status, '_', ' '), coalesce(v_who, 'someone'), to_char(o.status_changed_at at time zone 'Asia/Kolkata', 'HH24:MI')
      using errcode = '40001', hint = 'refresh';
  end if;
  if not private.order_next_ok(o.status, p_to) then raise exception 'An order can’t go from % to %', o.status, p_to using errcode = '22023'; end if;
  if p_to = 'cancelled' and length(trim(coalesce(p_reason, ''))) < 2 then raise exception 'Give a reason for cancelling' using errcode = '22023'; end if;
  update public.orders set status = p_to, version = version + 1, status_changed_by = auth.uid(), status_changed_at = now(),
    accepted_by = case when p_to = 'accepted' then auth.uid() else accepted_by end, accepted_at = case when p_to = 'accepted' then now() else accepted_at end,
    ready_at = case when p_to = 'ready' then now() else ready_at end, completed_at = case when p_to = 'completed' then now() else completed_at end,
    cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end, cancel_reason = case when p_to = 'cancelled' then left(p_reason, 300) else cancel_reason end
  where id = p_order returning * into o;
  perform private.order_event(o, 'status', v_from, p_to, p_reason, p_device);
  if p_to = 'cancelled' then
    perform private.restock_order(p_order, 'cancel');
    update public.payments set status = 'cancelled' where order_id = p_order and status = 'pending';
    perform private.write_audit('order:cancel', 'orders', p_order::text, o.business_id, jsonb_build_object('number', o.number, 'reason', p_reason, 'paid', o.payment_status));
  end if;
  return o;
end;
$$;

create or replace function private.refresh_payment_status(p_order uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_paid numeric; v_refunded numeric; v_new text;
begin
  select * into o from public.orders where id = p_order for update;
  select coalesce(sum(amount), 0) into v_paid from public.payments where order_id = p_order and status = 'paid';
  select coalesce(sum(amount), 0) into v_refunded from public.refunds where order_id = p_order;
  v_new := case when v_refunded > 0 and v_refunded >= v_paid then 'refunded' when v_refunded > 0 then 'partially_refunded'
                when v_paid >= o.total then 'paid' else o.payment_status end;
  if v_new = 'paid' and o.payment_status <> 'paid' then
    update public.orders set payment_status = 'paid', version = version + 1,
      status = case when status in ('pending_payment', 'payment_failed') then 'new' else status end, expires_at = null,
      status_changed_at = case when status in ('pending_payment', 'payment_failed') then now() else status_changed_at end
    where id = p_order returning * into o;
    perform private.order_event(o, 'payment', null, 'paid', null, null);
    perform private.assign_invoice(p_order);
  elsif v_new is distinct from o.payment_status then
    update public.orders set payment_status = v_new, version = version + 1,
      status = case when v_new = 'refunded' and status in ('completed', 'cancelled', 'ready', 'new', 'accepted', 'processing') then 'refunded' else status end
    where id = p_order returning * into o;
    perform private.order_event(o, 'payment', null, v_new, null, null);
  end if;
end;
$$;

/*
  record_payment: cash/card are confirmed on the spot by the staff member. UPI creates a PENDING
  payment that only becomes paid through confirm_upi_payment (a person) or a verified gateway.
*/
create or replace function public.record_payment(p_order uuid, p_method text, p_amount numeric, p_idempotency_key text,
  p_cash_tendered numeric default null, p_device text default null)
returns public.payments language plpgsql security definer set search_path = '' as $$
declare o public.orders; p public.payments; v_due numeric;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or not (private.can_orders(o.business_id, 'pos.sell') or private.can_orders(o.business_id, 'orders.update')) then raise exception 'Order not found' using errcode = '42501'; end if;
  select * into p from public.payments where business_id = o.business_id and idempotency_key = p_idempotency_key;
  if p.id is not null then return p; end if;
  if p_method not in ('cash', 'upi', 'card_manual') then raise exception 'Use the online checkout for card/UPI gateway payments' using errcode = '22023'; end if;
  if o.status in ('cancelled', 'refunded', 'failed') then raise exception 'This order is %', o.status using errcode = '22023'; end if;
  select o.total - coalesce(sum(amount), 0) into v_due from public.payments where order_id = p_order and status = 'paid';
  if v_due <= 0 then raise exception 'This order is already paid' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or private.money(p_amount) > v_due then raise exception 'Amount must be between ₹0.01 and ₹%', v_due using errcode = '22023'; end if;
  if p_method = 'cash' and coalesce(p_cash_tendered, p_amount) < p_amount then raise exception 'Cash received is less than the amount' using errcode = '22023'; end if;
  insert into public.payments (business_id, order_id, method, amount, status, idempotency_key, cash_tendered, change_due, confirmed_by, confirmed_at, created_by)
  values (o.business_id, p_order, p_method, private.money(p_amount),
    case when p_method = 'upi' then 'pending' else 'paid' end, p_idempotency_key,
    case when p_method = 'cash' then private.money(coalesce(p_cash_tendered, p_amount)) end,
    case when p_method = 'cash' then private.money(coalesce(p_cash_tendered, p_amount) - p_amount) end,
    case when p_method <> 'upi' then auth.uid() end, case when p_method <> 'upi' then now() end, auth.uid())
  returning * into p;
  perform private.order_event(o, 'payment', null, p_method || ':' || p.status, null, p_device);
  perform private.refresh_payment_status(p_order);
  return p;
end;
$$;

create or replace function public.confirm_upi_payment(p_payment uuid, p_utr text default null, p_device text default null)
returns public.payments language plpgsql security definer set search_path = '' as $$
declare p public.payments; o public.orders;
begin
  select * into p from public.payments where id = p_payment for update;
  if p.id is null or not (private.can_orders(p.business_id, 'pos.sell') or private.can_orders(p.business_id, 'orders.update')) then raise exception 'Payment not found' using errcode = '42501'; end if;
  if p.method <> 'upi' then raise exception 'Only UPI payments are confirmed this way' using errcode = '22023'; end if;
  if p.status = 'paid' then return p; end if;
  if p.status <> 'pending' then raise exception 'This payment is %', p.status using errcode = '22023'; end if;
  update public.payments set status = 'paid', confirmed_by = auth.uid(), confirmed_at = now(), upi_ref = nullif(left(trim(p_utr), 40), '')
  where id = p_payment returning * into p;
  select * into o from public.orders where id = p.order_id;
  perform private.order_event(o, 'payment', null, 'upi:confirmed', coalesce('UTR ' || p.upi_ref, 'confirmed by staff'), p_device);
  perform private.refresh_payment_status(p.order_id);
  return p;
end;
$$;

create or replace function public.fail_payment(p_payment uuid, p_reason text)
returns public.payments language plpgsql security definer set search_path = '' as $$
declare p public.payments; o public.orders;
begin
  select * into p from public.payments where id = p_payment for update;
  if p.id is null or not (private.can_orders(p.business_id, 'pos.sell') or private.can_orders(p.business_id, 'orders.update')) then raise exception 'Payment not found' using errcode = '42501'; end if;
  if p.status <> 'pending' then raise exception 'Only pending payments can be marked failed' using errcode = '22023'; end if;
  update public.payments set status = 'failed', failure_reason = left(coalesce(p_reason, 'not received'), 300) where id = p_payment returning * into p;
  select * into o from public.orders where id = p.order_id;
  perform private.order_event(o, 'payment', null, p.method || ':failed', p.failure_reason, null);
  return p;
end;
$$;

create or replace function public.issue_refund(p_order uuid, p_amount numeric, p_reason text, p_restock boolean, p_idempotency_key text)
returns public.refunds language plpgsql security definer set search_path = '' as $$
declare o public.orders; r public.refunds; v_paid numeric; v_refunded numeric; v_pay uuid;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or not private.can_orders(o.business_id, 'refunds.issue') then raise exception 'You don’t have permission to issue refunds' using errcode = '42501'; end if;
  select * into r from public.refunds where business_id = o.business_id and idempotency_key = p_idempotency_key;
  if r.id is not null then return r; end if;
  select coalesce(sum(amount), 0) into v_paid from public.payments where order_id = p_order and status = 'paid';
  select coalesce(sum(amount), 0) into v_refunded from public.refunds where order_id = p_order;
  if p_amount is null or p_amount <= 0 or private.money(p_amount) > v_paid - v_refunded then raise exception 'Refund can be at most ₹%', v_paid - v_refunded using errcode = '22023'; end if;
  select id into v_pay from public.payments where order_id = p_order and status = 'paid' order by created_at desc limit 1;
  insert into public.refunds (business_id, order_id, payment_id, amount, reason, restocked, idempotency_key, created_by)
  values (o.business_id, p_order, v_pay, private.money(p_amount), p_reason, coalesce(p_restock, false), p_idempotency_key, auth.uid()) returning * into r;
  if p_restock then perform private.restock_order(p_order, 'refund'); end if;
  perform private.order_event(o, 'refund', null, '₹' || r.amount, p_reason, null);
  perform private.write_audit('order:refund', 'orders', p_order::text, o.business_id, jsonb_build_object('number', o.number, 'amount', r.amount, 'reason', p_reason, 'restock', p_restock));
  perform private.refresh_payment_status(p_order);
  return r;
end;
$$;

-- Unpaid online orders release their stock after the configured time.
create or replace function public.expire_unpaid_orders(p_business uuid default null)
returns int language plpgsql security definer set search_path = '' as $$
declare o public.orders; n int := 0;
begin
  if auth.role() <> 'service_role' and (p_business is null or not private.orders_member(p_business)) then return 0; end if;
  for o in select * from public.orders where status in ('pending_payment', 'payment_failed') and expires_at < now()
           and (p_business is null or business_id = p_business) for update skip locked loop
    update public.orders set status = 'failed', payment_status = 'expired', failure_reason = 'Payment not received in time', version = version + 1, status_changed_at = now()
    where id = o.id returning * into o;
    update public.payments set status = 'expired' where order_id = o.id and status = 'pending';
    perform private.restock_order(o.id, 'cancel');
    perform private.order_event(o, 'status', 'pending_payment', 'failed', 'Payment not received in time', null);
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.add_order_note(p_order uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null or not private.can_orders(o.business_id, 'orders.update') then raise exception 'Order not found' using errcode = '42501'; end if;
  perform private.order_event(o, 'note', null, null, p_note, null);
end;
$$;

-- ── Reports ─────────────────────────────────────────────────────────────────
create or replace function public.sales_report(p_business uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_orders(p_business, 'reports.view') then raise exception 'You don’t have permission to see reports' using errcode = '42501'; end if;
  return jsonb_build_object(
    'totals', (select jsonb_build_object('orders', count(*), 'gross', coalesce(sum(total), 0), 'tax', coalesce(sum(tax_total), 0), 'discounts', coalesce(sum(discount_total), 0),
                 'average', coalesce(round(avg(total), 2), 0), 'cancelled', (select count(*) from public.orders c where c.business_id = p_business and c.status = 'cancelled' and (c.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to))
               from public.orders where business_id = p_business and payment_status in ('paid', 'partially_refunded') and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    'refunds', (select coalesce(sum(amount), 0) from public.refunds where business_id = p_business and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to),
    'by_day', (select coalesce(jsonb_agg(x order by x ->> 'day'), '[]') from (select jsonb_build_object('day', (created_at at time zone 'Asia/Kolkata')::date, 'orders', count(*), 'total', sum(total)) x
               from public.orders where business_id = p_business and payment_status in ('paid', 'partially_refunded') and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to group by (created_at at time zone 'Asia/Kolkata')::date) d),
    'by_method', (select coalesce(jsonb_object_agg(method, total), '{}') from (select method, sum(amount) total from public.payments
               where business_id = p_business and status = 'paid' and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to group by method) m),
    'by_channel', (select coalesce(jsonb_object_agg(channel, n), '{}') from (select channel, count(*) n from public.orders
               where business_id = p_business and (created_at at time zone 'Asia/Kolkata')::date between p_from and p_to group by channel) c),
    'top_products', (select coalesce(jsonb_agg(x), '[]') from (select jsonb_build_object('name', i.product_name || coalesce(' (' || nullif(i.variant_name, 'Standard') || ')', ''), 'qty', sum(i.qty), 'total', sum(i.line_total)) x
               from public.order_items i join public.orders o on o.id = i.order_id
               where o.business_id = p_business and o.payment_status in ('paid', 'partially_refunded') and (o.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
               group by i.product_name, i.variant_name order by sum(i.line_total) desc limit 10) t)
  );
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array['create_order(uuid, jsonb, text, text, jsonb, text, text, text, text, numeric, jsonb)',
    'order_transition(uuid, int, text, text, text)', 'record_payment(uuid, text, numeric, text, numeric, text)', 'confirm_upi_payment(uuid, text, text)',
    'fail_payment(uuid, text)', 'issue_refund(uuid, numeric, text, boolean, text)', 'expire_unpaid_orders(uuid)', 'add_order_note(uuid, text)',
    'adjust_stock(uuid, int, text, text)', 'check_stock_integrity(uuid)', 'sales_report(uuid, date, date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

revoke all on public.commerce_settings, public.tax_rates, public.product_categories, public.products, public.product_variants, public.stock_movements,
  public.customers, public.discounts, public.orders, public.order_items, public.order_events, public.payments, public.refunds, public.member_prefs from anon;
-- Money and stock tables: no direct writes from the browser at all.
revoke insert, update, delete on public.orders, public.order_items, public.order_events, public.payments, public.refunds, public.stock_movements from authenticated;
revoke update on public.discounts from authenticated;
grant update (code, kind, value, min_subtotal, max_uses, starts_at, ends_at, active) on public.discounts to authenticated;
revoke update on public.commerce_settings from authenticated;
grant update (legal_name, address, gstin, state_code, prices_include_tax, invoice_prefix, upi_id, upi_name, receipt_footer, unpaid_online_expiry_minutes) on public.commerce_settings to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.commerce_settings enable row level security;
alter table public.tax_rates enable row level security;
alter table public.product_categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.stock_movements enable row level security;
alter table public.customers enable row level security;
alter table public.discounts enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
alter table public.payments enable row level security;
alter table public.refunds enable row level security;
alter table public.member_prefs enable row level security;

create policy commerce_settings_select on public.commerce_settings for select to authenticated using ((select private.orders_member(business_id)));
create policy commerce_settings_insert on public.commerce_settings for insert to authenticated with check ((select private.can_orders(business_id, 'settings.manage')));
create policy commerce_settings_update on public.commerce_settings for update to authenticated using ((select private.can_orders(business_id, 'settings.manage'))) with check ((select private.can_orders(business_id, 'settings.manage')));

do $$
declare t text;
begin
  foreach t in array array['tax_rates', 'product_categories', 'products', 'product_variants'] loop
    execute format('create policy %I on public.%I for select to authenticated using ((select private.orders_member(business_id)))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.can_orders(business_id, %L)))', t || '_insert', t, 'products.manage');
    execute format('create policy %I on public.%I for update to authenticated using ((select private.can_orders(business_id, %L))) with check ((select private.can_orders(business_id, %L)))', t || '_update', t, 'products.manage', 'products.manage');
    execute format('create policy %I on public.%I for delete to authenticated using ((select private.can_orders(business_id, %L)))', t || '_delete', t, 'products.manage');
  end loop;
end $$;
-- Variant inserts carry business_id from the product (trigger), so check the product's business.
drop policy product_variants_insert on public.product_variants;
create policy product_variants_insert on public.product_variants for insert to authenticated
  with check ((select private.can_orders((select business_id from public.products where id = product_id), 'products.manage')));

create policy stock_movements_select on public.stock_movements for select to authenticated
  using ((select private.can_orders(business_id, 'inventory.manage')) or (select private.can_orders(business_id, 'reports.view')));

create policy customers_select on public.customers for select to authenticated using ((select private.can_orders(business_id, 'customers.view')));
create policy customers_write on public.customers for update to authenticated using ((select private.can_orders(business_id, 'customers.view'))) with check ((select private.can_orders(business_id, 'customers.view')));
create policy customers_insert on public.customers for insert to authenticated with check ((select private.can_orders(business_id, 'customers.view')));

create policy discounts_select on public.discounts for select to authenticated using ((select private.can_orders(business_id, 'discounts.manage')));
create policy discounts_insert on public.discounts for insert to authenticated with check ((select private.can_orders(business_id, 'discounts.manage')));
create policy discounts_update on public.discounts for update to authenticated using ((select private.can_orders(business_id, 'discounts.manage'))) with check ((select private.can_orders(business_id, 'discounts.manage')));
create policy discounts_delete on public.discounts for delete to authenticated using ((select private.can_orders(business_id, 'discounts.manage')));

create policy orders_select on public.orders for select to authenticated
  using ((select private.can_orders(business_id, 'orders.view')) or (select private.can_orders(business_id, 'pos.sell')));
create policy order_items_select on public.order_items for select to authenticated
  using ((select private.can_orders(business_id, 'orders.view')) or (select private.can_orders(business_id, 'pos.sell')));
create policy order_events_select on public.order_events for select to authenticated using ((select private.can_orders(business_id, 'orders.view')));
create policy payments_select on public.payments for select to authenticated
  using ((select private.can_orders(business_id, 'orders.view')) or (select private.can_orders(business_id, 'pos.sell')));
create policy refunds_select on public.refunds for select to authenticated using ((select private.can_orders(business_id, 'orders.view')));

create policy member_prefs_own on public.member_prefs for all to authenticated
  using (user_id = (select auth.uid()) and (select private.orders_member(business_id))) with check (user_id = (select auth.uid()) and (select private.orders_member(business_id)));

-- Live updates for the orders board, kitchen display and new-order alerts (RLS applies to Realtime).
alter publication supabase_realtime add table public.orders, public.order_items;
