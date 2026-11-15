-- M7 tests: online store, checkout via service role, Razorpay webhook-only payment, tracking, Printify records.
-- Rolled back at the end (see m0_rls.sql for the reporting convention).
begin;

create temp table t_results (n serial, check_name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon, service_role;
grant usage, select on sequence t_results_n_seq to authenticated, anon, service_role;
create temp table t_ids (k text primary key, id uuid) on commit drop;
grant select, insert, update on t_ids to authenticated, anon, service_role;
insert into t_ids values
  ('admin', gen_random_uuid()), ('ownerA', gen_random_uuid()), ('empA', gen_random_uuid()), ('mgrA', gen_random_uuid()),
  ('ownerB', gen_random_uuid()), ('bizA', gen_random_uuid()), ('bizB', gen_random_uuid()), ('siteA', gen_random_uuid()), ('siteB', gen_random_uuid());

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@m7.invalid', 'x', now(),
       jsonb_build_object('full_name', k), now(), now()
from t_ids where k in ('admin', 'ownerA', 'empA', 'mgrA', 'ownerB');
update public.profiles set must_change_password = false where id in (select id from t_ids);
update public.profiles set role = 'admin' where id = (select id from t_ids where k = 'admin');

insert into public.businesses (id, name) select id, k from t_ids where k in ('bizA', 'bizB');
insert into public.business_members (business_id, user_id, role, permissions) values
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'ownerA'), 'owner', '{}'),
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'empA'), 'employee', '{orders.view,orders.update,pos.sell}'),
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'mgrA'), 'manager', '{orders.view,orders.update,pos.sell,products.manage,inventory.manage,customers.view,discounts.manage,reports.view}'),
  ((select id from t_ids where k = 'bizB'), (select id from t_ids where k = 'ownerB'), 'owner', '{}');
insert into public.sites (id, business_id, name, public_key) values
  ((select id from t_ids where k = 'siteA'), (select id from t_ids where k = 'bizA'), 'Site A', 'm7-test-key-a'),
  ((select id from t_ids where k = 'siteB'), (select id from t_ids where k = 'bizB'), 'Site B', 'm7-test-key-b');
insert into public.business_modules (business_id, module_key)
select pg_temp_bz.id, m from (select id from t_ids where k in ('bizA', 'bizB')) pg_temp_bz, unnest(array['orders', 'pos', 'inventory', 'ecommerce', 'razorpay', 'printify']) m;

create or replace function pg_temp.act_as(who text) returns void language plpgsql as $$
begin
  reset role;
  if who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    set local role anon;
  else
    perform set_config('request.jwt.claims', json_build_object('sub', (select id from t_ids where k = who), 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end $$;
create or replace function pg_temp.fails(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  return true;
end $$;
create or replace function pg_temp.id(k text) returns uuid language sql as $$ select id from t_ids where t_ids.k = $1 $$;







select pg_temp.act_as('mgrA');
insert into public.products (business_id, name, online, slug) values (pg_temp.id('bizA'), 'Logo Tee', true, 'logo-tee'), (pg_temp.id('bizA'), 'Secret Item', false, null);
insert into public.product_variants (product_id, name, price, track_stock, options) select id, 'Black / M', 799, true, '{"colour":"Black","size":"M"}' from public.products where name = 'Logo Tee';
insert into public.product_variants (product_id, name, price) select id, 'Standard', 10 from public.products where name = 'Secret Item';
insert into t_ids select 'tee', v.id from public.product_variants v where v.name = 'Black / M';
select public.adjust_stock(pg_temp.id('tee'), 5, 'receive');

select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail) select 'store hidden until enabled', public.store_catalog('m7-test-key-a') is null, coalesce(public.store_catalog('m7-test-key-a')::text, 'null');

select pg_temp.act_as('ownerA');
insert into public.store_settings (business_id, enabled, store_name, shipping_flat, free_shipping_above) values (pg_temp.id('bizA'), true, 'QA Tees', 60, 1500);
insert into t_results (check_name, ok) values
  ('online payments can’t be enabled without keys', pg_temp.fails(format('update public.store_settings set razorpay_enabled = true where business_id = %L', pg_temp.id('bizA'))));
select public.set_razorpay_keys(pg_temp.id('bizA'), 'rzp_test_ABCDEF123456', 'secret_test_value', 'whsec_test_value');
update public.store_settings set razorpay_enabled = true where business_id = pg_temp.id('bizA');
insert into t_results (check_name, ok, detail) select 'Razorpay keys stored in Vault, enabled in test mode', razorpay_enabled and razorpay_mode = 'test' and razorpay_secret_id is not null, razorpay_mode from public.store_settings where business_id = pg_temp.id('bizA');
insert into t_results (check_name, ok) values ('owner cannot read secrets back', pg_temp.fails(format('select public.svc_store_secrets(%L)', pg_temp.id('bizA'))));

select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail) select 'catalogue lists only online products, never stock counts', jsonb_array_length(public.store_catalog('m7-test-key-a') -> 'products') = 1
  and public.store_catalog('m7-test-key-a')::text not like '%Secret Item%' and public.store_catalog('m7-test-key-a')::text not like '%"stock"%', left(public.store_catalog('m7-test-key-a')::text, 80);
insert into t_results (check_name, ok) values
  ('anon cannot create orders', pg_temp.fails(format('select public.create_order(%L, %L::jsonb, %L, %L)', pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('tee'), 'qty', 1)), 'anon-0001-aaaa', 'online'))),
  ('anon cannot read store settings', pg_temp.fails('select count(*) from public.store_settings'));

-- Checkout (the store-checkout Edge Function runs as the service role).
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into t_ids select 'o', id from public.create_order(pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('tee'), 'qty', 2)), 'web-0001-aaaa', 'online',
  '{"name":"Asha Rao","phone":"+919800000009","email":"asha@example.com"}', null, null, null, 'store', 0, '{"line1":"12 MG Road","city":"Pune","pin":"411001"}');
insert into public.payments (business_id, order_id, method, amount, status, idempotency_key, gateway_order_id)
select pg_temp.id('bizA'), pg_temp.id('o'), 'razorpay', total, 'pending', 'rzp-attempt-0001', 'order_QA123' from public.orders where id = pg_temp.id('o');
reset role;
insert into t_results (check_name, ok, detail) select 'online order: server total, waits for payment', status = 'pending_payment' and total = 1598 and tracking_token is not null, status || ' ' || total from public.orders where id = pg_temp.id('o');

create temp table t_tok on commit drop as select tracking_token as tok from public.orders where id = pg_temp.id('o');
grant select on t_tok to anon;
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail) select 'tracking link shows status and items, no phone/address/email', (public.store_track((select tok from t_tok)) ->> 'status') = 'pending_payment'
  and public.store_track((select tok from t_tok))::text not like '%9800000009%'
  and public.store_track((select tok from t_tok))::text not like '%MG Road%'
  and public.store_track((select tok from t_tok))::text not like '%asha@%', 'tracked';
insert into t_results (check_name, ok, detail) select 'wrong token finds nothing', public.store_track(repeat('a', 32)) is null, 'null';

-- Only a verified webhook (service role) can mark a gateway payment paid.
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok) values
  ('owner cannot call the webhook function', pg_temp.fails($$select public.svc_gateway_paid('order_QA123', 'pay_X', 0)$$)),
  ('owner cannot confirm a Razorpay payment as UPI', pg_temp.fails(format('select public.confirm_upi_payment(%L)', (select id from public.payments where gateway_order_id = 'order_QA123'))));
reset role;
insert into t_results (check_name, ok) values
  ('even the database owner can’t mark it paid without the webhook path', pg_temp.fails($$update public.payments set status = 'paid', gateway_verified = true where gateway_order_id = 'order_QA123'$$));
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.svc_gateway_paid('order_QA123', 'pay_QA999', 37.70);
insert into t_results (check_name, ok, detail) select 'repeat webhook is a no-op', (public.svc_gateway_paid('order_QA123', 'pay_QA999', 37.70) ->> 'already')::boolean, 'already';
insert into public.webhook_events (provider, event_id, business_id) values ('razorpay', 'evt_1', pg_temp.id('bizA'));
insert into t_results (check_name, ok) values ('duplicate webhook events rejected', pg_temp.fails($$insert into public.webhook_events (provider, event_id) values ('razorpay', 'evt_1')$$));
insert into public.fulfilment_orders (business_id, order_id, provider, status) values (pg_temp.id('bizA'), pg_temp.id('o'), 'printify', 'submitted');
insert into t_results (check_name, ok) values ('one fulfilment order per order and provider', pg_temp.fails(format($$insert into public.fulfilment_orders (business_id, order_id, provider) values (%L, %L, 'printify')$$, pg_temp.id('bizA'), pg_temp.id('o'))));
insert into public.order_charges (business_id, order_id, kind, amount, currency, source) values (pg_temp.id('bizA'), pg_temp.id('o'), 'printify_production', 820, 'INR', 'printify');
reset role;
insert into t_results (check_name, ok, detail) select 'webhook marks order paid, invoices it, records the fee', o.payment_status = 'paid' and o.status = 'new' and o.invoice_no is not null and p.gateway_verified,
  o.payment_status || ' ' || o.status from public.orders o join public.payments p on p.order_id = o.id where o.id = pg_temp.id('o');
insert into t_results (check_name, ok, detail) select 'charge breakdown kept per order', count(*) = 2, count(*)::text from public.order_charges where order_id = pg_temp.id('o');
insert into t_results (check_name, ok, detail) select 'customer tracking shows payment received', count(*) >= 2, count(*)::text from public.order_tracking where order_id = pg_temp.id('o');

-- Failed gateway payment.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into t_ids select 'o2', id from public.create_order(pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('tee'), 'qty', 1)), 'web-0002-bbbb', 'online', '{"name":"B"}');
insert into public.payments (business_id, order_id, method, amount, status, idempotency_key, gateway_order_id) select pg_temp.id('bizA'), pg_temp.id('o2'), 'razorpay', total, 'pending', 'rzp-attempt-0002', 'order_QA456' from public.orders where id = pg_temp.id('o2');
select public.svc_gateway_failed('order_QA456', 'Card declined');
reset role;
insert into t_results (check_name, ok, detail) select 'failed payment shown with reason', status = 'payment_failed' and failure_reason = 'Card declined', status from public.orders where id = pg_temp.id('o2');

-- Isolation.
select pg_temp.act_as('empA');
insert into t_results (check_name, ok, detail) select 'staff without settings cannot see store settings', count(*) = 0, count(*)::text from public.store_settings;
insert into t_results (check_name, ok, detail) select 'staff without reports cannot see charges', count(*) = 0, count(*)::text from public.order_charges;
insert into t_results (check_name, ok, detail) select 'staff with orders.view see fulfilment', count(*) = 1, count(*)::text from public.fulfilment_orders;
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees no fulfilment', count(*) = 0, count(*)::text from public.fulfilment_orders;
insert into t_results (check_name, ok) values ('other business cannot set our Razorpay keys', pg_temp.fails(format('select public.set_razorpay_keys(%L, %L, %L, %L)', pg_temp.id('bizA'), 'rzp_test_EVIL12345678', 'x', 'y')));

reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
