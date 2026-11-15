-- M6 tests: restaurant tables, kitchen display, appointments.
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
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@m6.invalid', 'x', now(),
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
  ((select id from t_ids where k = 'siteA'), (select id from t_ids where k = 'bizA'), 'Site A', 'm6-test-key-a'),
  ((select id from t_ids where k = 'siteB'), (select id from t_ids where k = 'bizB'), 'Site B', 'm6-test-key-b');
insert into public.business_modules (business_id, module_key)
select pg_temp_bz.id, m from (select id from t_ids where k in ('bizA', 'bizB')) pg_temp_bz, unnest(array['orders', 'pos', 'inventory', 'restaurant', 'kitchen_display', 'appointments']) m;

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
insert into public.restaurant_tables (business_id, label, seats) values (pg_temp.id('bizA'), 'T1', 4), (pg_temp.id('bizA'), 'T2', 2);
insert into public.products (business_id, name, station) values (pg_temp.id('bizA'), 'Dosa', 'kitchen'), (pg_temp.id('bizA'), 'Lassi', 'bar');
insert into public.product_variants (product_id, price) select id, 80 from public.products where business_id = pg_temp.id('bizA');
insert into t_ids select 'dosa', v.id from public.product_variants v join public.products p on p.id = v.product_id where p.name = 'Dosa';
insert into t_ids select 'lassi', v.id from public.product_variants v join public.products p on p.id = v.product_id where p.name = 'Lassi';

select pg_temp.act_as('empA');
insert into t_results (check_name, ok, detail) select 'staff see tables', count(*) = 2, count(*)::text from public.restaurant_tables;
insert into t_results (check_name, ok) values ('employee cannot edit tables', pg_temp.fails(format($$insert into public.restaurant_tables (business_id, label) values (%L, 'T9')$$, pg_temp.id('bizA'))));
insert into t_ids select 'o', id from public.create_order(pg_temp.id('bizA'), jsonb_build_array(jsonb_build_object('variant_id', pg_temp.id('dosa'), 'qty', 2), jsonb_build_object('variant_id', pg_temp.id('lassi'), 'qty', 1)), 'kds-0001-aaaa', 'table', '{}', null, 'T1');
insert into t_ids select 'item_dosa', id from public.order_items where order_id = pg_temp.id('o') and product_name = 'Dosa';
insert into t_ids select 'item_lassi', id from public.order_items where order_id = pg_temp.id('o') and product_name = 'Lassi';
insert into t_results (check_name, ok, detail) select 'items arrive queued with their station', bool_and(kds_status = 'queued') and count(distinct station) = 2, string_agg(station, ',') from public.order_items where order_id = pg_temp.id('o');
select public.kds_bump(pg_temp.id('item_dosa'));
insert into t_results (check_name, ok, detail) select 'starting an item moves the order to preparing', status = 'processing', status from public.orders where id = pg_temp.id('o');
select public.kds_bump(pg_temp.id('item_dosa'));
insert into t_results (check_name, ok, detail) select 'order not ready while the bar item is open', status = 'processing', status from public.orders where id = pg_temp.id('o');
select public.kds_bump_order(pg_temp.id('o'), 'ready', 'bar');
insert into t_results (check_name, ok, detail) select 'all items ready → order ready automatically', status = 'ready' and ready_at is not null, status from public.orders where id = pg_temp.id('o');
select public.kds_recall(pg_temp.id('bizA'));
insert into t_results (check_name, ok, detail) select 'recall undoes the last bump and reopens the order', (select kds_status from public.order_items where id = pg_temp.id('item_lassi')) = 'queued' and status = 'processing', status from public.orders where id = pg_temp.id('o');
insert into t_results (check_name, ok, detail) select 'kitchen changes are in the order history', count(*) >= 3, count(*)::text from public.order_events where order_id = pg_temp.id('o') and device = 'kitchen display';
insert into t_results (check_name, ok) values ('items cannot be edited directly', pg_temp.fails(format($$update public.order_items set kds_status = 'served' where id = %L$$, pg_temp.id('item_dosa'))));

select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok) values ('other business cannot bump', pg_temp.fails(format('select public.kds_bump(%L)', pg_temp.id('item_dosa'))));
insert into t_results (check_name, ok, detail) select 'other business sees no tables', count(*) = 0, count(*)::text from public.restaurant_tables;

-- ── Appointments ──────────────────────────────────────────────────────────
select pg_temp.act_as('mgrA');
insert into public.products (business_id, name, kind, duration_min) values (pg_temp.id('bizA'), 'Haircut', 'service', 45);
insert into t_ids select 'cut', id from public.products where name = 'Haircut';
insert into public.appointments (business_id, service_id, service_name, staff_id, customer_name, customer_phone, starts_at)
values (pg_temp.id('bizA'), pg_temp.id('cut'), '', pg_temp.id('empA'), 'Meera', '+919800000005', '2026-12-01 10:00+05:30');
insert into t_results (check_name, ok, detail) select 'end time from service duration', ends_at = '2026-12-01 10:45+05:30'::timestamptz and service_name = 'Haircut', ends_at::text from public.appointments where customer_name = 'Meera';
insert into t_results (check_name, ok) values
  ('no double booking for the same staff member', pg_temp.fails(format($$insert into public.appointments (business_id, service_name, staff_id, customer_name, starts_at, ends_at) values (%L, 'Colour', %L, 'Ria', '2026-12-01 10:30+05:30', '2026-12-01 11:30+05:30')$$, pg_temp.id('bizA'), pg_temp.id('empA')))),
  ('back-to-back is fine', not pg_temp.fails(format($$insert into public.appointments (business_id, service_name, staff_id, customer_name, starts_at, ends_at) values (%L, 'Colour', %L, 'Ria', '2026-12-01 10:45+05:30', '2026-12-01 11:30+05:30')$$, pg_temp.id('bizA'), pg_temp.id('empA')))),
  ('staff must belong to the business', pg_temp.fails(format($$insert into public.appointments (business_id, service_name, staff_id, customer_name, starts_at, ends_at) values (%L, 'Cut', %L, 'X', '2026-12-02 10:00+05:30', '2026-12-02 10:30+05:30')$$, pg_temp.id('bizA'), pg_temp.id('ownerB'))));
update public.appointments set status = 'cancelled' where customer_name = 'Meera';
insert into t_results (check_name, ok) values ('cancelled slot can be rebooked', not pg_temp.fails(format($$insert into public.appointments (business_id, service_name, staff_id, customer_name, starts_at, ends_at) values (%L, 'Cut', %L, 'Zoya', '2026-12-01 10:00+05:30', '2026-12-01 10:40+05:30')$$, pg_temp.id('bizA'), pg_temp.id('empA'))));
insert into t_results (check_name, ok, detail) select 'updates bump the version', max(version) >= 2, max(version)::text from public.appointments where customer_name = 'Meera';
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees no appointments', count(*) = 0, count(*)::text from public.appointments;
reset role;
update public.business_modules set enabled = false where business_id = pg_temp.id('bizA') and module_key = 'appointments';
select pg_temp.act_as('mgrA');
insert into t_results (check_name, ok, detail) select 'appointments module off hides them', count(*) = 0, count(*)::text from public.appointments;

reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
