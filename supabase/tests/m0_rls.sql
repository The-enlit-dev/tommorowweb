-- M0 security tests. Run as the postgres role (Supabase SQL editor or MCP execute_sql).
-- Everything runs in one transaction and is rolled back: no test data is left behind.
-- Output: the run ends with an error "TEST_RESULTS [...]" holding one JSON entry per check
-- (ok = true/false). Raising the error is deliberate: it rolls everything back.
begin;

create temp table t_results (n serial, check_name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon;
grant usage, select on sequence t_results_n_seq to authenticated, anon;

-- ── Fixtures ────────────────────────────────────────────────────────────────
create temp table t_ids (k text primary key, id uuid) on commit drop;
grant select on t_ids to authenticated, anon;
insert into t_ids values
  ('admin', gen_random_uuid()), ('ownerA', gen_random_uuid()), ('empA', gen_random_uuid()),
  ('ownerB', gen_random_uuid()), ('newbie', gen_random_uuid()), ('bizA', gen_random_uuid()), ('bizB', gen_random_uuid());

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@test.invalid',
       extensions.crypt('x', extensions.gen_salt('bf')), now(), jsonb_build_object('full_name', k), now(), now()
from t_ids where k in ('admin', 'ownerA', 'empA', 'ownerB', 'newbie');

update public.profiles set must_change_password = false where id in (select id from t_ids where k <> 'newbie');
update public.profiles set role = 'admin' where id = (select id from t_ids where k = 'admin');

insert into public.businesses (id, name) values ((select id from t_ids where k = 'bizA'), 'Biz A'), ((select id from t_ids where k = 'bizB'), 'Biz B');
insert into public.business_members (business_id, user_id, role, permissions) values
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'ownerA'), 'owner', '{}'),
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'empA'), 'employee', '{orders.view}'),
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'newbie'), 'manager', '{orders.view}'),
  ((select id from t_ids where k = 'bizB'), (select id from t_ids where k = 'ownerB'), 'owner', '{}');
insert into public.sites (business_id, name) values ((select id from t_ids where k = 'bizA'), 'Site A'), ((select id from t_ids where k = 'bizB'), 'Site B');
insert into public.business_modules (business_id, module_key) values ((select id from t_ids where k = 'bizA'), 'cms');

-- Helper: act as a fixture user (or anon).
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

-- Helper: true if the statement raises an error.
create or replace function pg_temp.fails(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  return true;
end $$;

-- ── Anonymous ───────────────────────────────────────────────────────────────
select pg_temp.act_as('anon');
insert into t_results (check_name, ok) values
  ('anon cannot read businesses', pg_temp.fails('select count(*) from public.businesses')),
  ('anon cannot read profiles', pg_temp.fails('select count(*) from public.profiles')),
  ('anon cannot read audit log', pg_temp.fails('select count(*) from public.audit_logs'));

-- ── Owner A ─────────────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail)
select 'ownerA sees only Biz A', count(*) = 1 and bool_and(name = 'Biz A'), count(*)::text from public.businesses;
insert into t_results (check_name, ok, detail)
select 'ownerA sees only Site A', count(*) = 1 and bool_and(name = 'Site A'), count(*)::text from public.sites;
insert into t_results (check_name, ok, detail)
select 'ownerA sees all 3 Biz A members', count(*) = 3, count(*)::text from public.business_members;
insert into t_results (check_name, ok, detail)
select 'ownerA sees profiles of own team only', count(*) = 3, count(*)::text from public.profiles;
insert into t_results (check_name, ok) values
  ('ownerA cannot create a business', pg_temp.fails($q$insert into public.businesses (name) values ('Sneaky')$q$)),
  ('ownerA cannot make self admin', pg_temp.fails($q$update public.profiles set role = 'admin' where id = auth.uid()$q$)),
  ('ownerA cannot add another owner', pg_temp.fails(format($q$insert into public.business_members (business_id, user_id, role) values (%L, %L, 'owner')$q$,
      (select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'ownerB')))),
  ('ownerA cannot switch modules on', pg_temp.fails(format($q$insert into public.business_modules (business_id, module_key) values (%L, 'pos')$q$, (select id from t_ids where k = 'bizA')))),
  ('ownerA cannot read audit log rows', (select count(*) = 0 from public.audit_logs)),
  ('ownerA can rename own business', not pg_temp.fails(format($q$update public.businesses set name = 'Biz A Renamed' where id = %L$q$, (select id from t_ids where k = 'bizA'))));
insert into t_results (check_name, ok) values
  ('ownerA can update employee permissions', not pg_temp.fails(format($q$update public.business_members set permissions = '{orders.view,orders.update}' where user_id = %L$q$, (select id from t_ids where k = 'empA'))));
insert into t_results (check_name, ok, detail)
select 'employee permissions were saved', permissions = '{orders.view,orders.update}', permissions::text
from public.business_members where user_id = (select id from t_ids where k = 'empA');
insert into t_results (check_name, ok) values
  ('ownerA cannot change own membership', pg_temp.fails(format($q$update public.business_members set permissions = '{x}' where user_id = %L$q$, (select id from t_ids where k = 'ownerA'))));

-- ── Employee A ──────────────────────────────────────────────────────────────
select pg_temp.act_as('empA');
insert into t_results (check_name, ok, detail)
select 'empA sees own business', count(*) = 1, count(*)::text from public.businesses;
insert into t_results (check_name, ok, detail)
select 'empA sees only own membership row', count(*) = 1, count(*)::text from public.business_members;
insert into t_results (check_name, ok, detail)
select 'empA sees only own profile', count(*) = 1, count(*)::text from public.profiles;
with u as (update public.businesses set name = 'Hacked' where id = (select id from t_ids where k = 'bizA') returning 1)
insert into t_results (check_name, ok, detail) select 'empA cannot rename business (0 rows)', count(*) = 0, count(*)::text from u;
insert into t_results (check_name, ok) values
  ('empA cannot add members', pg_temp.fails(format($q$insert into public.business_members (business_id, user_id, role) values (%L, %L, 'employee')$q$,
      (select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'ownerB'))));
insert into t_results (check_name, ok, detail)
select 'empA my_context lists 1 membership with cms module',
  jsonb_array_length(c -> 'memberships') = 1 and (c -> 'memberships' -> 0 -> 'modules') ? 'cms', c::text
from (select public.my_context() c) s;

-- ── Owner B (other tenant) ──────────────────────────────────────────────────
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail)
select 'ownerB cannot see Biz A', count(*) = 0, count(*)::text from public.businesses where name like 'Biz A%';
insert into t_results (check_name, ok, detail)
select 'ownerB cannot see Site A', count(*) = 0, count(*)::text from public.sites where name = 'Site A';
insert into t_results (check_name, ok, detail)
select 'ownerB cannot see Biz A members', count(*) = 0, count(*)::text from public.business_members where business_id = (select id from t_ids where k = 'bizA');

-- ── New user who has not changed the temporary password ────────────────────
select pg_temp.act_as('newbie');
insert into t_results (check_name, ok, detail)
select 'temp-password user gets no business access', count(*) = 0, count(*)::text from public.businesses;
insert into t_results (check_name, ok)
values ('temp-password user can mark password changed', not pg_temp.fails('select public.mark_password_changed()'));
insert into t_results (check_name, ok, detail)
select 'after change, access is granted', count(*) = 1, count(*)::text from public.businesses;

-- ── Admin ───────────────────────────────────────────────────────────────────
select pg_temp.act_as('admin');
insert into t_results (check_name, ok, detail)
select 'admin sees both businesses', count(*) >= 2, count(*)::text from public.businesses where id in (select id from t_ids);
insert into t_results (check_name, ok, detail)
select 'audit log recorded member/module/business changes', count(*) >= 5, count(*)::text
from public.audit_logs where business_id in (select id from t_ids);
insert into t_results (check_name, ok, detail)
select 'audit captured the rename by ownerA', count(*) >= 1, count(*)::text
from public.audit_logs where action = 'update:businesses' and actor_id = (select id from t_ids where k = 'ownerA');
insert into t_results (check_name, ok) values
  ('admin cannot edit audit log', pg_temp.fails('update public.audit_logs set action = $$x$$'));
insert into t_results (check_name, ok) values
  ('admin_usage works for admin', not pg_temp.fails('select public.admin_usage()'));

-- Report by raising an error: this guarantees the whole transaction (all fixtures) is rolled back.
reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
