-- M3 security tests: Lead Finder is administrator-only; merge, delete-on-request and suppression.
-- Rolled back at the end (see m0_rls.sql for the reporting convention).
begin;

create temp table t_results (n serial, check_name text, ok boolean, detail text) on commit drop;
grant all on t_results to authenticated, anon;
grant usage, select on sequence t_results_n_seq to authenticated, anon;
create temp table t_ids (k text primary key, id uuid) on commit drop;
grant select, insert, update on t_ids to authenticated, anon;
insert into t_ids values
  ('admin', gen_random_uuid()), ('ownerA', gen_random_uuid()), ('empA', gen_random_uuid()), ('mgrA', gen_random_uuid()),
  ('ownerB', gen_random_uuid()), ('bizA', gen_random_uuid()), ('bizB', gen_random_uuid()), ('siteA', gen_random_uuid()), ('siteB', gen_random_uuid());

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@m3.invalid', 'x', now(),
       jsonb_build_object('full_name', k), now(), now()
from t_ids where k in ('admin', 'ownerA', 'empA', 'mgrA', 'ownerB');
update public.profiles set must_change_password = false where id in (select id from t_ids);
update public.profiles set role = 'admin' where id = (select id from t_ids where k = 'admin');

insert into public.businesses (id, name) select id, k from t_ids where k in ('bizA', 'bizB');
insert into public.business_members (business_id, user_id, role, permissions) values
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'ownerA'), 'owner', '{}'),
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'empA'), 'employee', '{orders.view}'),
  ((select id from t_ids where k = 'bizA'), (select id from t_ids where k = 'mgrA'), 'manager', '{settings.manage}'),
  ((select id from t_ids where k = 'bizB'), (select id from t_ids where k = 'ownerB'), 'owner', '{}');
insert into public.sites (id, business_id, name, public_key) values
  ((select id from t_ids where k = 'siteA'), (select id from t_ids where k = 'bizA'), 'Site A', 'm3-test-key-a'),
  ((select id from t_ids where k = 'siteB'), (select id from t_ids where k = 'bizB'), 'Site B', 'm3-test-key-b');
insert into public.business_modules (business_id, module_key)
select (select id from t_ids where k = 'bizA'), 'ai_assistant'
union all select (select id from t_ids where k = 'bizB'), 'cms';

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



-- ── Fixtures: two leads that are the same business ────────────────────────
select pg_temp.act_as('admin');
insert into public.leads (name, locality, osm_ref, sources) values ('QA Café X', 'Baner', 'way/9001', '{osm}');
insert into public.leads (name, locality, place_ref, sources, research_notes) values ('QA Cafe X', 'Baner', 'ChIJqa', '{google_places}', 'Owner is Ravi');
insert into t_ids select 'L1', id from public.leads where osm_ref = 'way/9001';
insert into t_ids select 'L2', id from public.leads where place_ref = 'ChIJqa';
insert into t_results (check_name, ok, detail) select 'new lead starts with no website listed', website_state = 'none_listed', website_state from public.leads where id = pg_temp.id('L1');
insert into public.lead_contact_points (lead_id, kind, value, value_norm, source) values
  (pg_temp.id('L1'), 'phone', '+919822012345', '+919822012345', 'osm'),
  (pg_temp.id('L2'), 'phone', '+919822012345', '+919822012345', 'google_places'),
  (pg_temp.id('L2'), 'website', 'https://qacafex.in', 'qacafex.in', 'google_places');
insert into t_results (check_name, ok, detail)
select 'adding a website makes it unverified, not live', website_state = 'unverified' and website_domain = 'qacafex.in' and primary_phone = '+919822012345', website_state
from public.leads where id = pg_temp.id('L2');
delete from public.lead_contact_points where lead_id = pg_temp.id('L2') and kind = 'website';
insert into t_results (check_name, ok, detail)
select 'removing the only website returns to none_listed', website_state = 'none_listed' and website_url is null, website_state from public.leads where id = pg_temp.id('L2');
insert into public.lead_contact_points (lead_id, kind, value, value_norm, source) values (pg_temp.id('L2'), 'website', 'https://qacafex.in', 'qacafex.in', 'google_places');
insert into public.lead_duplicates (lead_id, other_id, reason, similarity) values (pg_temp.id('L2'), pg_temp.id('L1'), 'similar_name_nearby', 0.95);
insert into public.lead_audits (lead_id, status) values (pg_temp.id('L2'), 'done');

-- ── Nobody but the administrator sees anything ────────────────────────────
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'client sees no leads', count(*) = 0, count(*)::text from public.leads;
insert into t_results (check_name, ok, detail) select 'client sees no contact points', count(*) = 0, count(*)::text from public.lead_contact_points;
insert into t_results (check_name, ok, detail) select 'client sees no audits', count(*) = 0, count(*)::text from public.lead_audits;
insert into t_results (check_name, ok, detail) select 'client sees no lead settings', count(*) = 0, count(*)::text from public.lead_settings;
insert into t_results (check_name, ok) values
  ('client cannot add leads', pg_temp.fails($$insert into public.leads (name) values ('Sneaky')$$)),
  ('client cannot merge', pg_temp.fails(format('select public.merge_leads(%L, %L)', pg_temp.id('L1'), pg_temp.id('L2')))),
  ('client cannot delete on request', pg_temp.fails(format('select public.delete_lead_on_request(%L)', pg_temp.id('L1')))),
  ('client cannot set Google key', pg_temp.fails($$select public.set_google_api_key('x')$$)),
  ('client cannot read Google key', pg_temp.fails('select public.svc_lead_settings()'));
select pg_temp.act_as('mgrA');
insert into t_results (check_name, ok, detail) select 'manager with settings permission still sees no leads', count(*) = 0, count(*)::text from public.leads;
select pg_temp.act_as('anon');
insert into t_results (check_name, ok) values ('anon cannot read leads', pg_temp.fails('select count(*) from public.leads'));

-- ── Settings: Places off by default; key in Vault ─────────────────────────
select pg_temp.act_as('admin');
insert into t_results (check_name, ok, detail) select 'Google Places is off with a 0 cap by default', not places_enabled and places_monthly_cap = 0, places_enabled::text from public.lead_settings;
select public.set_google_api_key('AIza-test-key');
insert into t_results (check_name, ok) values ('admin cannot write key reference directly', pg_temp.fails('update public.lead_settings set google_key_secret_id = null'));
reset role;
insert into t_results (check_name, ok, detail) select 'Google key stored in Vault', public.svc_lead_settings() ->> 'google_key' = 'AIza-test-key', 'vault';
insert into t_results (check_name, ok, detail) select 'API cap blocks when 0', public.svc_lead_api_hit('places', 0) = -1, 'cap0';
insert into t_results (check_name, ok, detail) select 'API cap counts up to the limit', public.svc_lead_api_hit('places_t', 2) = 1 and public.svc_lead_api_hit('places_t', 2) = 2 and public.svc_lead_api_hit('places_t', 2) = -1, 'cap2';

-- ── Merge ─────────────────────────────────────────────────────────────────
select pg_temp.act_as('admin');
select public.merge_leads(pg_temp.id('L1'), pg_temp.id('L2'));
insert into t_results (check_name, ok, detail)
select 'merge keeps both source ids, notes and website', osm_ref = 'way/9001' and place_ref = 'ChIJqa' and sources @> '{osm,google_places}' and research_notes = 'Owner is Ravi' and website_domain = 'qacafex.in', concat_ws(',', osm_ref, place_ref, array_to_string(sources, '+'))
from public.leads where id = pg_temp.id('L1');
insert into t_results (check_name, ok, detail) select 'merge de-duplicates contact points', count(*) = 2, count(*)::text from public.lead_contact_points where lead_id = pg_temp.id('L1');
insert into t_results (check_name, ok, detail) select 'merge moves audits', count(*) = 1, count(*)::text from public.lead_audits where lead_id = pg_temp.id('L1');
insert into t_results (check_name, ok, detail) select 'merged lead is gone', count(*) = 0, count(*)::text from public.leads where id = pg_temp.id('L2');
insert into t_results (check_name, ok, detail) select 'merge audited', count(*) = 1, count(*)::text from public.audit_logs where action = 'lead:merge' and entity_id = pg_temp.id('L1')::text;

-- ── Do not contact + delete on request ────────────────────────────────────
update public.leads set do_not_contact = true, dnc_reason = 'Asked not to be contacted' where id = pg_temp.id('L1');
insert into t_results (check_name, ok, detail) select 'do-not-contact timestamped and audited', l.dnc_at is not null and exists (select 1 from public.audit_logs a where a.action = 'lead:do_not_contact' and a.entity_id = l.id::text), 'dnc'
from public.leads l where id = pg_temp.id('L1');
insert into t_results (check_name, ok, detail) select 'delete on request suppresses phone, domain, OSM and Places ids', public.delete_lead_on_request(pg_temp.id('L1'), 'Owner request') = 4, 'keys';
insert into t_results (check_name, ok, detail) select 'lead deleted', count(*) = 0, count(*)::text from public.leads where id = pg_temp.id('L1');
insert into t_results (check_name, ok, detail) select 'suppression stores only hashes', count(*) = 1, count(*)::text from public.lead_suppressions where key_hash = encode(extensions.digest('phone:+919822012345', 'sha256'), 'hex');
insert into t_results (check_name, ok, detail) select 'deletion audit holds no contact details', count(*) = 1 and bool_and(details::text not like '%9822012345%' and details::text not like '%QA Caf%'), count(*)::text
from public.audit_logs where action = 'lead:delete_on_request' and entity_id = pg_temp.id('L1')::text;

reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
