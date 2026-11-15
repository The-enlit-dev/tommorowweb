-- M4 security tests: CRM pipeline, activities, follow-ups, proposals; administrator only.
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
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@m4.invalid', 'x', now(),
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
  ((select id from t_ids where k = 'siteA'), (select id from t_ids where k = 'bizA'), 'Site A', 'm4-test-key-a'),
  ((select id from t_ids where k = 'siteB'), (select id from t_ids where k = 'bizB'), 'Site B', 'm4-test-key-b');
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




select pg_temp.act_as('admin');
insert into public.leads (name, locality) values ('QA CRM Café', 'Baner');
insert into t_ids select 'L', id from public.leads where name = 'QA CRM Café';
insert into t_results (check_name, ok, detail) select 'new leads start in stage "new"', stage = 'new', stage from public.leads where id = pg_temp.id('L');

-- Logging a call moves new → contacted and records last contact.
insert into public.lead_activities (lead_id, kind, body, outcome) values (pg_temp.id('L'), 'call', 'Spoke to owner', 'interested later');
insert into t_results (check_name, ok, detail) select 'a call marks the lead contacted', stage = 'contacted' and last_contacted_at is not null, stage from public.leads where id = pg_temp.id('L');
insert into t_results (check_name, ok, detail) select 'stage change is recorded in history', count(*) = 1, count(*)::text from public.lead_activities where lead_id = pg_temp.id('L') and kind = 'stage_change' and outcome = 'new → contacted';

-- Follow-ups.
insert into public.lead_tasks (lead_id, title, due_at) values (pg_temp.id('L'), 'Call back', now() + interval '2 days'), (pg_temp.id('L'), 'Send samples', now() + interval '1 day');
insert into t_results (check_name, ok, detail) select 'next follow-up = earliest open task', next_follow_up_at::date = (now() + interval '1 day')::date, next_follow_up_at::text from public.leads where id = pg_temp.id('L');
update public.lead_tasks set done_at = now() where title = 'Send samples';
insert into t_results (check_name, ok, detail) select 'completing a task moves the follow-up', next_follow_up_at::date = (now() + interval '2 days')::date, next_follow_up_at::text from public.leads where id = pg_temp.id('L');

-- Proposals advance the pipeline.
insert into public.proposals (lead_id, title, amount_inr, status) values (pg_temp.id('L'), 'Café website', 8000, 'sent');
insert into t_results (check_name, ok, detail) select 'sending a proposal moves to proposal_sent and sets value', stage = 'proposal_sent' and estimated_value_inr = 8000, stage from public.leads where id = pg_temp.id('L');
update public.leads set stage = 'negotiation' where id = pg_temp.id('L');
insert into public.proposals (lead_id, title, amount_inr, status) values (pg_temp.id('L'), 'Revised', 9500, 'draft');
insert into t_results (check_name, ok, detail) select 'a later sent proposal does not move a lead backwards', (select stage from public.leads where id = pg_temp.id('L')) = 'negotiation', 'negotiation';
update public.proposals set status = 'sent' where title = 'Revised';
insert into t_results (check_name, ok, detail) select 'still negotiation after second send', stage = 'negotiation', stage from public.leads where id = pg_temp.id('L');
update public.proposals set status = 'accepted' where title = 'Revised';
insert into t_results (check_name, ok, detail) select 'accepting a proposal wins the lead at its amount', stage = 'won' and estimated_value_inr = 9500, stage || ' ' || estimated_value_inr from public.leads where id = pg_temp.id('L');
insert into t_results (check_name, ok, detail) select 'proposal timestamps set', sent_at is not null and decided_at is not null, 'ts' from public.proposals where title = 'Revised';

-- Lost reason only kept for lost.
update public.leads set stage = 'lost', lost_reason = 'Went with a cousin' where id = pg_temp.id('L');
update public.leads set stage = 'interested' where id = pg_temp.id('L');
insert into t_results (check_name, ok, detail) select 'lost reason cleared when reopened', lost_reason is null, coalesce(lost_reason, 'null') from public.leads where id = pg_temp.id('L');

-- History protections + do-not-contact.
insert into t_results (check_name, ok) values
  ('history entries cannot be edited', pg_temp.fails(format($$update public.lead_activities set body = 'x' where lead_id = %L$$, pg_temp.id('L'))));
delete from public.lead_activities where lead_id = pg_temp.id('L') and kind = 'stage_change';
insert into t_results (check_name, ok, detail) select 'stage history cannot be deleted', count(*) >= 3, count(*)::text from public.lead_activities where lead_id = pg_temp.id('L') and kind = 'stage_change';
update public.leads set do_not_contact = true where id = pg_temp.id('L');
insert into t_results (check_name, ok) values
  ('cannot log a call to a do-not-contact lead', pg_temp.fails(format($$insert into public.lead_activities (lead_id, kind) values (%L, 'call')$$, pg_temp.id('L')))),
  ('notes still allowed on do-not-contact leads', not pg_temp.fails(format($$insert into public.lead_activities (lead_id, kind, body) values (%L, 'note', 'asked to stop')$$, pg_temp.id('L'))));

-- Conversion audit.
update public.leads set converted_business_id = pg_temp.id('bizA') where id = pg_temp.id('L');
insert into t_results (check_name, ok, detail) select 'conversion audited', count(*) = 1, count(*)::text from public.audit_logs where action = 'lead:converted' and entity_id = pg_temp.id('L')::text;

-- Clients see nothing.
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'client sees no activities', count(*) = 0, count(*)::text from public.lead_activities;
insert into t_results (check_name, ok, detail) select 'client sees no tasks', count(*) = 0, count(*)::text from public.lead_tasks;
insert into t_results (check_name, ok, detail) select 'client sees no proposals', count(*) = 0, count(*)::text from public.proposals;
insert into t_results (check_name, ok) values ('client cannot add proposals', pg_temp.fails(format($$insert into public.proposals (lead_id, title, amount_inr) values (%L, 'x', 1)$$, pg_temp.id('L'))));
select pg_temp.act_as('anon');
insert into t_results (check_name, ok) values ('anon cannot read proposals', pg_temp.fails('select count(*) from public.proposals'));

reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
