-- M5 tests: POS orders, totals, idempotency, stock, optimistic locking, UPI rule, refunds, isolation.
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
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@m5.invalid', 'x', now(),
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
  ((select id from t_ids where k = 'siteA'), (select id from t_ids where k = 'bizA'), 'Site A', 'm5-test-key-a'),
  ((select id from t_ids where k = 'siteB'), (select id from t_ids where k = 'bizB'), 'Site B', 'm5-test-key-b');
insert into public.business_modules (business_id, module_key)
select pg_temp_bz.id, m from (select id from t_ids where k in ('bizA', 'bizB')) pg_temp_bz, unnest(array['orders', 'pos', 'inventory']) m;

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





-- ── Catalogue (manager with products.manage) ──────────────────────────────
select pg_temp.act_as('mgrA');
insert into public.tax_rates (business_id, name, rate_pct) values (pg_temp.id('bizA'), 'GST 5%', 5);
insert into public.products (business_id, name, tax_rate_id, station, hsn_sac) select pg_temp.id('bizA'), 'Masala Dosa', id, 'kitchen', '996331' from public.tax_rates where business_id = pg_temp.id('bizA');
insert into public.products (business_id, name, tax_rate_id) select pg_temp.id('bizA'), 'Filter Coffee', id from public.tax_rates where business_id = pg_temp.id('bizA');
insert into public.product_variants (product_id, name, price, stock) select id, 'Standard', 105, 50 from public.products where name = 'Masala Dosa';
insert into public.product_variants (product_id, name, price, track_stock, sku) select id, 'Regular', 42, true, 'COF-R' from public.products where name = 'Filter Coffee';
insert into t_ids select 'dosa', v.id from public.product_variants v join public.products p on p.id = v.product_id where p.name = 'Masala Dosa';
insert into t_ids select 'coffee', id from public.product_variants where sku = 'COF-R';
insert into t_results (check_name, ok, detail) select 'stock can’t be set on insert (must use adjustments)', stock = 0, stock::text from public.product_variants where id = pg_temp.id('dosa');
insert into t_results (check_name, ok) values
  ('stock can’t be edited directly', pg_temp.fails(format('update public.product_variants set stock = 99 where id = %L', pg_temp.id('coffee'))));
select public.adjust_stock(pg_temp.id('coffee'), 3, 'receive', 'opening delivery');
insert into t_results (check_name, ok, detail) select 'stock adjustment recorded', stock = 3, stock::text from public.product_variants where id = pg_temp.id('coffee');
insert into public.discounts (business_id, code, kind, value) values (pg_temp.id('bizA'), 'WELCOME10', 'percent', 10);
update public.product_variants set price = 110 where id = pg_temp.id('dosa');
reset role;
insert into t_results (check_name, ok, detail) select 'price change audited', count(*) = 1, count(*)::text from public.audit_logs where action = 'price:change' and entity_id = pg_temp.id('dosa')::text;

-- ── Selling (employee with pos.sell) ──────────────────────────────────────
select pg_temp.act_as('empA');
update public.products set name = 'Hacked' where business_id = pg_temp.id('bizA');
insert into t_results (check_name, ok, detail) select 'employee cannot edit products', count(*) = 0, count(*)::text from public.products where name = 'Hacked';
insert into t_results (check_name, ok, detail) select 'employee can see the catalogue for the POS', count(*) = 2, count(*)::text from public.product_variants;
insert into t_ids select 'o1', id from public.create_order(pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('dosa'), 'qty', 2), jsonb_build_object('variant_id', pg_temp.id('coffee'), 'qty', 1)),
  'idem-0001-aaaa', 'pos', '{"name":"Ravi","phone":"+919800000001"}', 'welcome10', null, null, 'tablet-1');
insert into t_results (check_name, ok, detail)
select 'server computes totals (inclusive 5% GST, 10% off)', subtotal = 262 and discount_total = 26.2 and total = 235.8 and tax_total = 11.23 and status = 'new' and payment_status = 'pending',
  concat_ws(' ', subtotal, discount_total, tax_total, total) from public.orders where id = pg_temp.id('o1');
insert into t_results (check_name, ok, detail) select 'same idempotency key returns the same order', (public.create_order(pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('coffee'), 'qty', 1)), 'idem-0001-aaaa')).id = pg_temp.id('o1'), 'idem';
insert into t_results (check_name, ok, detail) select 'no duplicate order created', count(*) = 1, count(*)::text from public.orders;
insert into t_results (check_name, ok, detail) select 'stock reduced in the same transaction', stock = 2, stock::text from public.product_variants where id = pg_temp.id('coffee');
insert into t_results (check_name, ok) values
  ('selling more than stock fails with a clear message', pg_temp.fails(format('select public.create_order(%L, %L::jsonb, %L)', pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('coffee'), 'qty', 3)), 'idem-0002-bbbb'))),
  ('online orders can’t be created from the POS', pg_temp.fails(format('select public.create_order(%L, %L::jsonb, %L, %L)', pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('dosa'), 'qty', 1)), 'idem-0003-cccc', 'online'))),
  ('employee cannot insert orders directly', pg_temp.fails(format($$insert into public.orders (business_id, number, channel, status, subtotal, total, idempotency_key) values (%L, 99, 'pos', 'new', 0, 0, 'direct-insert')$$, pg_temp.id('bizA')))),
  ('employee cannot write payments directly', pg_temp.fails(format($$insert into public.payments (business_id, order_id, method, amount, status, idempotency_key) values (%L, %L, 'upi', 1, 'paid', 'x12345678')$$, pg_temp.id('bizA'), pg_temp.id('o1'))));
do $$ begin
  perform public.create_order((select id from t_ids where k = 'bizA'), jsonb_build_array(jsonb_build_object('variant_id', (select id from t_ids where k = 'coffee'), 'qty', 3)), 'idem-0004-dddd');
exception when others then insert into t_results (check_name, ok, detail) values ('stock message names the item and quantity', sqlerrm = 'Only 2 left of Filter Coffee (Regular)', sqlerrm);
end $$;
insert into t_results (check_name, ok, detail) select 'employee sees the customer name on the order', customer_name = 'Ravi', customer_name from public.orders where id = pg_temp.id('o1');
insert into t_results (check_name, ok, detail) select 'employee without customers.view cannot read the customer list', count(*) = 0, count(*)::text from public.customers;
insert into t_results (check_name, ok, detail) select 'employee cannot read discount codes', count(*) = 0, count(*)::text from public.discounts;

-- ── Optimistic locking (two devices) ──────────────────────────────────────
select public.order_transition(pg_temp.id('o1'), 1, 'accepted', null, 'tablet-1');
do $$ begin
  perform public.order_transition((select id from t_ids where k = 'o1'), 1, 'accepted', null, 'phone-2');
  insert into t_results (check_name, ok) values ('second device cannot accept the same order', false);
exception when others then insert into t_results (check_name, ok, detail) values ('second device cannot accept the same order', sqlerrm like 'Already accepted by empA at %', sqlerrm);
end $$;
insert into t_results (check_name, ok) values ('invalid transition rejected', pg_temp.fails(format('select public.order_transition(%L, 2, %L)', pg_temp.id('o1'), 'pending_payment')));

-- ── UPI rule ──────────────────────────────────────────────────────────────
insert into t_ids select 'p_upi', id from public.record_payment(pg_temp.id('o1'), 'upi', 235.8, 'pay-upi-0001');
insert into t_results (check_name, ok, detail) select 'UPI payment starts pending', p.status = 'pending' and o.payment_status = 'pending', p.status
from public.payments p join public.orders o on o.id = p.order_id where p.id = pg_temp.id('p_upi');
insert into t_results (check_name, ok) values ('UPI cannot be marked paid by editing the row', pg_temp.fails(format($$update public.payments set status = 'paid' where id = %L$$, pg_temp.id('p_upi'))));
reset role;
insert into t_results (check_name, ok) values ('even the database owner can’t mark UPI paid without a confirmer', pg_temp.fails(format($$update public.payments set status = 'paid' where id = %L$$, pg_temp.id('p_upi'))));
select pg_temp.act_as('empA');
select public.confirm_upi_payment(pg_temp.id('p_upi'), 'UTR123456');
insert into t_results (check_name, ok, detail) select 'staff confirmation marks UPI paid, records who/when/UTR', p.status = 'paid' and p.confirmed_by = pg_temp.id('empA') and p.upi_ref = 'UTR123456' and o.payment_status = 'paid', o.payment_status
from public.payments p join public.orders o on o.id = p.order_id where p.id = pg_temp.id('p_upi');
insert into t_results (check_name, ok, detail) select 'paid order gets an invoice number and GST split', invoice_no = 'INV-00001' and (tax_breakdown -> 0 ->> 'cgst') is not null, invoice_no from public.orders where id = pg_temp.id('o1');
insert into t_results (check_name, ok) values ('cannot overpay', pg_temp.fails(format('select public.record_payment(%L, %L, 1, %L)', pg_temp.id('o1'), 'cash', 'pay-cash-0009')));
reset role;
insert into t_results (check_name, ok) values
  ('gateway payments need a verified webhook', pg_temp.fails(format($$insert into public.payments (business_id, order_id, method, amount, status, idempotency_key, gateway_verified) values (%L, %L, 'razorpay', 1, 'paid', 'rzp-0001', true)$$, pg_temp.id('bizA'), pg_temp.id('o1'))));

-- ── Cash with change + cancel + refund ────────────────────────────────────
select pg_temp.act_as('empA');
insert into t_ids select 'o2', id from public.create_order(pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('coffee'), 'qty', 2)), 'idem-0005-eeee');
insert into t_results (check_name, ok, detail) select 'cash payment computes change', change_due = 16 and status = 'paid', change_due::text from public.record_payment(pg_temp.id('o2'), 'cash', 84, 'pay-cash-0001', 100);
insert into t_results (check_name, ok, detail) select 'coffee sold out', stock = 0, stock::text from public.product_variants where id = pg_temp.id('coffee');
insert into t_results (check_name, ok) values
  ('employee without refunds.issue cannot refund', pg_temp.fails(format('select public.issue_refund(%L, 10, %L, false, %L)', pg_temp.id('o2'), 'cold', 'ref-0001'))),
  ('cancel needs a reason', pg_temp.fails(format('select public.order_transition(%L, %s, %L)', pg_temp.id('o2'), (select version from public.orders where id = pg_temp.id('o2')), 'cancelled')));
select public.order_transition(pg_temp.id('o2'), (select version from public.orders where id = pg_temp.id('o2')), 'cancelled', 'Customer left', 'tablet-1');
insert into t_results (check_name, ok, detail) select 'cancelling restocks', stock = 2, stock::text from public.product_variants where id = pg_temp.id('coffee');
select pg_temp.act_as('ownerA');
select public.issue_refund(pg_temp.id('o2'), 84, 'Order cancelled', false, 'ref-0002');
insert into t_results (check_name, ok, detail) select 'owner refund marks payment refunded', payment_status = 'refunded', payment_status from public.orders where id = pg_temp.id('o2');
insert into t_results (check_name, ok, detail) select 'refund is idempotent', (public.issue_refund(pg_temp.id('o2'), 84, 'Order cancelled', false, 'ref-0002')).amount = 84, 'idem';
insert into t_results (check_name, ok) values ('cannot refund more than paid', pg_temp.fails(format('select public.issue_refund(%L, 1, %L, false, %L)', pg_temp.id('o2'), 'extra', 'ref-0003')));
reset role;
insert into t_results (check_name, ok, detail) select 'refund and cancel audited', count(*) = 2, count(*)::text from public.audit_logs where business_id = pg_temp.id('bizA') and action in ('order:refund', 'order:cancel');
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'order history kept', count(*) >= 5, count(*)::text from public.order_events where order_id = pg_temp.id('o2');
insert into t_results (check_name, ok, detail) select 'stock integrity check finds no drift', count(*) = 0, count(*)::text from public.check_stock_integrity(pg_temp.id('bizA'));
insert into t_results (check_name, ok, detail) select 'sales report works for owner', (public.sales_report(pg_temp.id('bizA'), current_date - 1, current_date + 1) -> 'totals' ->> 'orders')::int = 1, 'report';
select pg_temp.act_as('empA');
insert into t_results (check_name, ok) values ('employee cannot see reports', pg_temp.fails(format('select public.sales_report(%L, current_date, current_date)', pg_temp.id('bizA'))));
insert into t_results (check_name, ok, detail) select 'employee cannot see stock movements', count(*) = 0, count(*)::text from public.stock_movements;

-- ── Online order expiry (service role) ────────────────────────────────────
reset role;
update public.products set online = true where business_id = pg_temp.id('bizA');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into t_ids select 'o3', id from public.create_order(pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('coffee'), 'qty', 1)), 'idem-0006-ffff', 'online', '{"name":"Web"}');
reset role;
insert into t_results (check_name, ok, detail) select 'online order waits for payment with an expiry', status = 'pending_payment' and expires_at is not null, status from public.orders where id = pg_temp.id('o3');
update public.orders set expires_at = now() - interval '1 minute' where id = pg_temp.id('o3');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
select public.expire_unpaid_orders(null);
reset role;
insert into t_results (check_name, ok, detail) select 'unpaid online order expires and releases stock', o.status = 'failed' and o.payment_status = 'expired' and v.stock = 2, o.status || ' ' || v.stock
from public.orders o, public.product_variants v where o.id = pg_temp.id('o3') and v.id = pg_temp.id('coffee');

-- ── Isolation ─────────────────────────────────────────────────────────────
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees no orders', count(*) = 0, count(*)::text from public.orders;
insert into t_results (check_name, ok, detail) select 'other business sees no products', count(*) = 0, count(*)::text from public.product_variants;
insert into t_results (check_name, ok) values
  ('cannot sell another business’s items', pg_temp.fails(format('select public.create_order(%L, %L::jsonb, %L)', pg_temp.id('bizB'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('dosa'), 'qty', 1)), 'idem-0007-gggg'))),
  ('cannot change another business’s order', pg_temp.fails(format('select public.order_transition(%L, 3, %L)', pg_temp.id('o1'), 'ready'))),
  ('cannot confirm another business’s payment', pg_temp.fails(format('select public.confirm_upi_payment(%L)', pg_temp.id('p_upi'))));
-- UPI ID check constraint (regression: a repetition count over 255 made every save fail).
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'owner saves a valid UPI ID', not pg_temp.fails(format('update public.commerce_settings set upi_id = %L where business_id = %L', 'qacafe@okicici', pg_temp.id('bizA'))), null;
insert into t_results (check_name, ok, detail) select 'UPI ID was stored', upi_id = 'qacafe@okicici', upi_id from public.commerce_settings where business_id = pg_temp.id('bizA');
insert into t_results (check_name, ok) values ('an invalid UPI ID is refused', pg_temp.fails(format('update public.commerce_settings set upi_id = %L where business_id = %L', 'not a upi id', pg_temp.id('bizA'))));
reset role;
select pg_temp.act_as('anon');
insert into t_results (check_name, ok) values ('anon cannot read orders', pg_temp.fails('select count(*) from public.orders'));
reset role;
update public.business_modules set enabled = false where business_id = pg_temp.id('bizA') and module_key = 'orders';
select pg_temp.act_as('empA');
insert into t_results (check_name, ok, detail) select 'orders module off hides everything', count(*) = 0, count(*)::text from public.orders;

reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
