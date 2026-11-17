-- M7: online store (catalogue, checkout, tracking), Razorpay per business, Printify per brand,
-- fulfilment orders, de-duplicated webhooks and a per-order charge breakdown.

create table public.store_settings (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  enabled boolean not null default false,
  store_name text check (length(store_name) <= 120),
  shipping_flat numeric(10, 2) not null default 0 check (shipping_flat >= 0),
  free_shipping_above numeric(10, 2) check (free_shipping_above >= 0),
  contact_email text check (length(contact_email) <= 200),
  policies text check (length(policies) <= 4000),
  manual_upi boolean not null default true,
  razorpay_enabled boolean not null default false,
  razorpay_mode text not null default 'test' check (razorpay_mode in ('test', 'live')),
  razorpay_key_id text check (razorpay_key_id ~ '^rzp_(test|live)_[A-Za-z0-9]{6,32}$'),
  razorpay_secret_id uuid,
  razorpay_webhook_secret_id uuid,
  printify_shop_id text check (printify_shop_id ~ '^[0-9]{1,15}$'),
  printify_token_secret_id uuid,
  printify_webhook_secret_id uuid,
  printify_connected_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.store_settings is 'Each business uses its own Razorpay and Printify accounts. Secrets are Vault ids, never values.';

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  product_id uuid not null references public.products (id) on delete cascade,
  path text not null,
  alt text check (length(alt) <= 200),
  sort int not null default 100
);
create index product_images_product_idx on public.product_images (product_id);

create table public.printify_mappings (
  variant_id uuid primary key references public.product_variants (id) on delete cascade,
  business_id uuid not null,
  printify_product_id text not null,
  printify_variant_id bigint not null,
  cost_cents int,
  synced_at timestamptz not null default now()
);

create table public.fulfilment_orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null references public.orders (id) on delete cascade,
  provider text not null check (provider in ('printify')),
  external_id text,
  status text not null default 'pending' check (status in ('pending', 'submitted', 'in_production', 'shipped', 'delivered', 'failed', 'on_hold', 'cancelled')),
  error text check (length(error) <= 1000),
  attempts int not null default 0,
  carrier text,
  tracking_number text,
  tracking_url text,
  production_cost numeric(10, 2),
  shipping_cost numeric(10, 2),
  currency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, provider)
);
comment on table public.fulfilment_orders is 'At most one fulfilment order per (order, provider): retries re-use it, so an order is never sent twice.';

create table public.webhook_events (
  provider text not null,
  event_id text not null,
  business_id uuid,
  received_at timestamptz not null default now(),
  outcome text,
  primary key (provider, event_id)
);

create table public.order_charges (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null references public.orders (id) on delete cascade,
  kind text not null check (kind in ('printify_production', 'printify_shipping', 'printify_plan', 'gateway_fee')),
  amount numeric(10, 2) not null,
  currency text not null default 'INR',
  source text not null,
  created_at timestamptz not null default now(),
  unique (order_id, kind, source)
);

create table public.order_tracking (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  business_id uuid not null,
  at timestamptz not null default now(),
  status text not null,
  message text check (length(message) <= 300),
  tracking_url text
);
create index order_tracking_order_idx on public.order_tracking (order_id, at);

create trigger store_settings_touch before update on public.store_settings for each row execute function private.touch_updated_at();
create trigger fulfilment_orders_touch before update on public.fulfilment_orders for each row execute function private.touch_updated_at();
create trigger store_settings_audit after update on public.store_settings for each row execute function private.audit_row();

-- Customer-visible tracking entries for order status changes.
create or replace function private.order_tracking_from_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_channel text;
begin
  select channel into v_channel from public.orders where id = new.order_id;
  if v_channel <> 'online' then return null; end if;
  if new.kind in ('created', 'status') or (new.kind = 'payment' and new.to_status = 'paid') then
    insert into public.order_tracking (order_id, business_id, status, message)
    values (new.order_id, new.business_id, coalesce(new.to_status, new.kind),
      case coalesce(new.to_status, '') when 'pending_payment' then 'Order placed — waiting for payment' when 'paid' then 'Payment received'
        when 'new' then 'Order confirmed' when 'accepted' then 'Order accepted' when 'processing' then 'Being prepared' when 'ready' then 'Ready to ship'
        when 'completed' then 'Completed' when 'cancelled' then 'Cancelled' when 'failed' then 'Payment not received in time' else null end);
  end if;
  return null;
end;
$$;
create trigger order_events_tracking after insert on public.order_events for each row execute function private.order_tracking_from_events();

-- ── Secret setters (Vault) ──────────────────────────────────────────────────
create or replace function private.vault_put(p_existing uuid, p_value text, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if nullif(trim(p_value), '') is null then
    if p_existing is not null then delete from vault.secrets where id = p_existing; end if;
    return null;
  end if;
  if p_existing is null then return vault.create_secret(trim(p_value), p_name, ''); end if;
  perform vault.update_secret(p_existing, trim(p_value));
  return p_existing;
end;
$$;

create or replace function public.set_razorpay_keys(p_business uuid, p_key_id text, p_key_secret text, p_webhook_secret text)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.store_settings;
begin
  if not (private.is_admin() or (private.module_on(p_business, 'razorpay') and private.has_perm(p_business, 'settings.manage'))) then
    raise exception 'You don’t have permission to change payment settings' using errcode = '42501';
  end if;
  insert into public.store_settings (business_id) values (p_business) on conflict do nothing;
  select * into s from public.store_settings where business_id = p_business for update;
  update public.store_settings set
    razorpay_key_id = nullif(trim(p_key_id), ''),
    razorpay_mode = case when p_key_id like 'rzp_live_%' then 'live' else 'test' end,
    razorpay_secret_id = case when p_key_secret is null then razorpay_secret_id else private.vault_put(s.razorpay_secret_id, p_key_secret, 'razorpay_secret:' || p_business) end,
    razorpay_webhook_secret_id = case when p_webhook_secret is null then razorpay_webhook_secret_id else private.vault_put(s.razorpay_webhook_secret_id, p_webhook_secret, 'razorpay_webhook:' || p_business) end,
    razorpay_enabled = case when nullif(trim(p_key_id), '') is null then false else razorpay_enabled end
  where business_id = p_business;
  perform private.write_audit('store:razorpay_keys', 'store_settings', p_business::text, p_business, jsonb_build_object('key_id', p_key_id, 'secret_changed', p_key_secret is not null, 'webhook_secret_changed', p_webhook_secret is not null));
end;
$$;

-- Service role only: store secrets for Edge Functions.
create or replace function public.svc_store_secrets(p_business uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('razorpay_key_id', s.razorpay_key_id, 'razorpay_secret', a.decrypted_secret, 'razorpay_webhook_secret', b.decrypted_secret,
    'printify_token', c.decrypted_secret, 'printify_shop_id', s.printify_shop_id, 'printify_webhook_secret', d.decrypted_secret)
  from public.store_settings s
  left join vault.decrypted_secrets a on a.id = s.razorpay_secret_id
  left join vault.decrypted_secrets b on b.id = s.razorpay_webhook_secret_id
  left join vault.decrypted_secrets c on c.id = s.printify_token_secret_id
  left join vault.decrypted_secrets d on d.id = s.printify_webhook_secret_id
  where s.business_id = p_business;
$$;

create or replace function public.svc_set_printify(p_business uuid, p_token text, p_shop_id text, p_webhook_secret text)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.store_settings;
begin
  insert into public.store_settings (business_id) values (p_business) on conflict do nothing;
  select * into s from public.store_settings where business_id = p_business for update;
  update public.store_settings set
    printify_token_secret_id = private.vault_put(s.printify_token_secret_id, p_token, 'printify_token:' || p_business),
    printify_webhook_secret_id = private.vault_put(s.printify_webhook_secret_id, p_webhook_secret, 'printify_webhook:' || p_business),
    printify_shop_id = nullif(p_shop_id, ''),
    printify_connected_at = case when nullif(p_token, '') is null then null else now() end
  where business_id = p_business;
end;
$$;

/*
  Called only by the Razorpay webhook Edge Function after it has verified the webhook signature.
  This is the only path that can mark an online payment paid.
*/
create or replace function public.svc_gateway_paid(p_gateway_order_id text, p_gateway_payment_id text, p_fee_inr numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.payments; o public.orders;
begin
  if auth.role() <> 'service_role' then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into p from public.payments where gateway_order_id = p_gateway_order_id and method = 'razorpay' for update;
  if p.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown order'); end if;
  if p.status = 'paid' then return jsonb_build_object('ok', true, 'already', true, 'order_id', p.order_id); end if;
  perform set_config('tw.gateway_webhook', 'verified', true);
  update public.payments set status = 'paid', gateway_verified = true, gateway_payment_id = p_gateway_payment_id, gateway_fee = p_fee_inr, confirmed_at = now()
  where id = p.id returning * into p;
  perform set_config('tw.gateway_webhook', '', true);
  select * into o from public.orders where id = p.order_id;
  perform private.order_event(o, 'payment', null, 'razorpay:paid', 'confirmed by Razorpay webhook', 'razorpay');
  if coalesce(p_fee_inr, 0) > 0 then
    insert into public.order_charges (business_id, order_id, kind, amount, source) values (p.business_id, p.order_id, 'gateway_fee', p_fee_inr, 'razorpay')
    on conflict do nothing;
  end if;
  perform private.refresh_payment_status(p.order_id);
  return jsonb_build_object('ok', true, 'order_id', p.order_id);
end;
$$;

create or replace function public.svc_gateway_failed(p_gateway_order_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.payments; o public.orders;
begin
  if auth.role() <> 'service_role' then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into p from public.payments where gateway_order_id = p_gateway_order_id and method = 'razorpay' for update;
  if p.id is null or p.status <> 'pending' then return jsonb_build_object('ok', false); end if;
  update public.payments set status = 'failed', failure_reason = left(p_reason, 300) where id = p.id;
  update public.orders set status = 'payment_failed', payment_status = 'failed', failure_reason = left(p_reason, 300), version = version + 1, status_changed_at = now()
  where id = p.order_id and status = 'pending_payment' returning * into o;
  if o.id is not null then perform private.order_event(o, 'status', 'pending_payment', 'payment_failed', p_reason, 'razorpay'); end if;
  return jsonb_build_object('ok', true, 'order_id', p.order_id);
end;
$$;

-- ── Public store API (anonymous, read-only) ─────────────────────────────────
create or replace function private.store_business(p_key text)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.business_id from public.sites s join public.store_settings st on st.business_id = s.business_id and st.enabled
  where s.public_key = p_key and private.module_on(s.business_id, 'ecommerce');
$$;

create or replace function public.store_catalog(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with b as (select private.store_business(p_key) as id)
  select jsonb_build_object(
    'store', (select jsonb_build_object('name', coalesce(st.store_name, bz.name), 'shipping_flat', st.shipping_flat, 'free_shipping_above', st.free_shipping_above,
               'policies', st.policies, 'contact_email', st.contact_email, 'online_payment', st.razorpay_enabled, 'manual_upi', st.manual_upi)
              from public.store_settings st join public.businesses bz on bz.id = st.business_id where st.business_id = (select id from b)),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.sort), '[]') from public.product_categories c where c.business_id = (select id from b) and c.active),
    'products', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'slug', p.slug, 'name', p.name, 'description', p.description, 'category_id', p.category_id, 'image', p.image_path,
        'images', (select coalesce(jsonb_agg(jsonb_build_object('path', i.path, 'alt', i.alt) order by i.sort), '[]') from public.product_images i where i.product_id = p.id),
        'variants', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'options', v.options, 'price', v.price,
            'in_stock', (not v.track_stock or v.stock > 0) or p.fulfilment = 'printify', 'low', v.track_stock and v.stock between 1 and 3) order by v.sort, v.price), '[]')
          from public.product_variants v where v.product_id = p.id and v.active)) order by p.sort, p.name), '[]')
      from public.products p where p.business_id = (select id from b) and p.active and p.online)
  ) where (select id from b) is not null;
$$;

/* Order tracking by the secret link token. Returns no addresses or contact details. */
create or replace function public.store_track(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('number', o.number, 'store', coalesce(st.store_name, bz.name), 'status', o.status, 'payment_status', o.payment_status,
    'total', o.total, 'shipping_total', o.shipping_total, 'created_at', o.created_at, 'name', split_part(coalesce(o.customer_name, ''), ' ', 1),
    'items', (select jsonb_agg(jsonb_build_object('name', i.product_name, 'variant', nullif(i.variant_name, 'Standard'), 'qty', i.qty, 'total', i.line_total)) from public.order_items i where i.order_id = o.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', t.at, 'status', t.status, 'message', t.message, 'tracking_url', t.tracking_url) order by t.at), '[]') from public.order_tracking t where t.order_id = o.id),
    'shipments', (select coalesce(jsonb_agg(jsonb_build_object('status', f.status, 'carrier', f.carrier, 'tracking_number', f.tracking_number, 'tracking_url', f.tracking_url)), '[]') from public.fulfilment_orders f where f.order_id = o.id))
  from public.orders o join public.businesses bz on bz.id = o.business_id left join public.store_settings st on st.business_id = o.business_id
  where length(p_token) = 32 and o.tracking_token = p_token and o.channel = 'online';
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function public.set_razorpay_keys(uuid, text, text, text) from public, anon;
grant execute on function public.set_razorpay_keys(uuid, text, text, text) to authenticated;
do $$
declare f text;
begin
  foreach f in array array['svc_store_secrets(uuid)', 'svc_set_printify(uuid, text, text, text)', 'svc_gateway_paid(text, text, numeric)', 'svc_gateway_failed(text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
grant execute on function public.store_catalog(text) to anon, authenticated;
grant execute on function public.store_track(text) to anon, authenticated;

revoke all on public.store_settings, public.product_images, public.printify_mappings, public.fulfilment_orders, public.webhook_events, public.order_charges, public.order_tracking from anon;
revoke insert, update, delete on public.fulfilment_orders, public.webhook_events, public.order_charges, public.order_tracking, public.printify_mappings from authenticated;
revoke update on public.store_settings from authenticated;
grant update (enabled, store_name, shipping_flat, free_shipping_above, contact_email, policies, manual_upi, razorpay_enabled) on public.store_settings to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.store_settings enable row level security;
alter table public.product_images enable row level security;
alter table public.printify_mappings enable row level security;
alter table public.fulfilment_orders enable row level security;
alter table public.webhook_events enable row level security;
alter table public.order_charges enable row level security;
alter table public.order_tracking enable row level security;

create or replace function private.can_store(biz uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'ecommerce') and private.has_perm(biz, 'settings.manage'));
$$;
create policy store_settings_select on public.store_settings for select to authenticated using ((select private.can_store(business_id)));
create policy store_settings_insert on public.store_settings for insert to authenticated with check ((select private.can_store(business_id)));
create policy store_settings_update on public.store_settings for update to authenticated using ((select private.can_store(business_id))) with check ((select private.can_store(business_id)));
-- Enabling Razorpay needs the razorpay module and saved keys.
create or replace function private.store_settings_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.razorpay_enabled and (not private.module_on(new.business_id, 'razorpay') or new.razorpay_key_id is null or new.razorpay_secret_id is null or new.razorpay_webhook_secret_id is null) then
    raise exception 'Add Razorpay keys and the webhook secret before turning on online payments' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger store_settings_guard before insert or update on public.store_settings for each row execute function private.store_settings_guard();

create policy product_images_select on public.product_images for select to authenticated using ((select private.orders_member(business_id)));
create policy product_images_write on public.product_images for all to authenticated
  using ((select private.can_orders(business_id, 'products.manage'))) with check ((select private.can_orders(business_id, 'products.manage')));
create policy printify_mappings_select on public.printify_mappings for select to authenticated using ((select private.can_store(business_id)));
create policy fulfilment_select on public.fulfilment_orders for select to authenticated using ((select private.can_orders(business_id, 'orders.view')));
create policy charges_select on public.order_charges for select to authenticated using ((select private.can_orders(business_id, 'reports.view')));
create policy tracking_select on public.order_tracking for select to authenticated using ((select private.can_orders(business_id, 'orders.view')));
create policy webhook_events_admin on public.webhook_events for select to authenticated using ((select private.is_admin()));
