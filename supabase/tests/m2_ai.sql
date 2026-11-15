-- M2 security tests: AI providers, assistant settings, knowledge, FAQ fallback, usage.
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
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@m2.invalid', 'x', now(),
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
  ((select id from t_ids where k = 'siteA'), (select id from t_ids where k = 'bizA'), 'Site A', 'm2-test-key-a'),
  ((select id from t_ids where k = 'siteB'), (select id from t_ids where k = 'bizB'), 'Site B', 'm2-test-key-b');
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


-- ── Providers are admin-only ──────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'client sees no AI providers', count(*) = 0, count(*)::text from public.ai_providers;
insert into t_results (check_name, ok) values
  ('client cannot add a provider', pg_temp.fails($$insert into public.ai_providers (name, kind, base_url, model) values ('x', 'ollama', 'https://ai.example.com', 'm')$$)),
  ('client cannot read provider secrets', pg_temp.fails('select public.svc_ai_providers()'));
select pg_temp.act_as('admin');
insert into t_results (check_name, ok) values
  ('paid API host refused (OpenAI)', pg_temp.fails($$insert into public.ai_providers (name, kind, base_url, model) values ('x', 'llamacpp', 'https://api.openai.com/v1', 'gpt')$$)),
  ('paid API host refused (Gemini)', pg_temp.fails($$insert into public.ai_providers (name, kind, base_url, model) values ('x', 'ollama', 'https://generativelanguage.googleapis.com', 'g')$$)),
  ('plain http refused', pg_temp.fails($$insert into public.ai_providers (name, kind, base_url, model) values ('x', 'ollama', 'http://my-pc.local:11434', 'q')$$));
insert into public.ai_providers (name, kind, base_url, model) values ('OR', 'openrouter', 'https://evil.example.com', 'x/y:free');
insert into t_ids select 'prov', id from public.ai_providers where name = 'OR';
insert into t_results (check_name, ok, detail)
select 'openrouter URL pinned, disabled and ₹0 by default', base_url = 'https://openrouter.ai/api/v1' and not enabled and max_spend_inr = 0, base_url
from public.ai_providers where id = pg_temp.id('prov');
select public.set_ai_provider_token(pg_temp.id('prov'), 'sk-or-test-123');
update public.ai_providers set max_spend_inr = 50 where id = pg_temp.id('prov');
insert into t_results (check_name, ok, detail)
select 'spend-limit change is audited', count(*) = 1, count(*)::text from public.audit_logs where action = 'ai:spend_limit' and entity_id = pg_temp.id('prov')::text;
insert into t_results (check_name, ok) values
  ('admin cannot write spent amount', pg_temp.fails(format('update public.ai_providers set spent_inr = 0 where id = %L', pg_temp.id('prov')))),
  ('admin cannot write token reference', pg_temp.fails(format('update public.ai_providers set token_secret_id = null where id = %L', pg_temp.id('prov'))));
reset role;
insert into t_results (check_name, ok, detail)
select 'token kept in Vault, readable only by the service function', (public.svc_ai_providers() -> 0 ->> 'token') = 'sk-or-test-123', 'vault';

-- ── Site settings ─────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into public.ai_site_settings (site_id, enabled, greeting, daily_cap, provider_id) values (pg_temp.id('siteA'), false, 'Hi! Ask me anything.', 9999, null);
insert into t_results (check_name, ok, detail)
select 'client cannot raise AI limits on insert', daily_cap = 100 and per_ip_per_hour = 20, daily_cap::text from public.ai_site_settings where site_id = pg_temp.id('siteA');
insert into t_results (check_name, ok) values
  ('client cannot change AI limits', pg_temp.fails(format('update public.ai_site_settings set daily_cap = 5000 where site_id = %L', pg_temp.id('siteA')))),
  ('client cannot pick a provider', pg_temp.fails(format('update public.ai_site_settings set provider_id = %L where site_id = %L', pg_temp.id('prov'), pg_temp.id('siteA')))),
  ('client can edit greeting', not pg_temp.fails(format($$update public.ai_site_settings set greeting = 'Namaste!' where site_id = %L$$, pg_temp.id('siteA'))));
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok) values
  ('module off: cannot configure assistant', pg_temp.fails(format('insert into public.ai_site_settings (site_id) values (%L)', pg_temp.id('siteB')))),
  ('cannot configure another business''s site', pg_temp.fails(format('insert into public.ai_knowledge (site_id, question, answer) values (%L, %L, %L)', pg_temp.id('siteA'), 'Hack?', 'Yes')));

-- ── Knowledge + FAQ fallback ──────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into public.ai_knowledge (site_id, question, answer) values
  (pg_temp.id('siteA'), 'What are your opening hours?', 'We open at 9am and close at 9pm, every day.'),
  (pg_temp.id('siteA'), 'Do you deliver?', 'Yes, we deliver within 5 km of Baner.'),
  (pg_temp.id('siteA'), 'Do you have parking?', 'There is street parking outside.');
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail) select 'FAQ off until the assistant is enabled', public.faq_answer('m2-test-key-a', 'when do you open') = '[]'::jsonb, public.faq_answer('m2-test-key-a', 'when do you open')::text;
select pg_temp.act_as('ownerA');
update public.ai_site_settings set enabled = true where site_id = pg_temp.id('siteA');
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail)
select 'FAQ answers by meaning-ish match (open → opening hours)', public.faq_answer('m2-test-key-a', 'What time do you open?') -> 0 ->> 'question' = 'What are your opening hours?', left(public.faq_answer('m2-test-key-a', 'What time do you open?')::text, 80);
insert into t_results (check_name, ok, detail)
select 'FAQ finds delivery', public.faq_answer('m2-test-key-a', 'can you deliver to my home') -> 0 ->> 'answer' like 'Yes, we deliver%', 'deliver';
insert into t_results (check_name, ok, detail)
select 'unrelated question gets no FAQ', public.faq_answer('m2-test-key-a', 'quantum physics') = '[]'::jsonb, public.faq_answer('m2-test-key-a', 'quantum physics')::text;
insert into t_results (check_name, ok, detail)
select 'widget config is public and minimal', (public.ai_widget_config('m2-test-key-a') ->> 'enabled')::boolean and public.ai_widget_config('m2-test-key-a') ->> 'greeting' = 'Namaste!'
  and not (public.ai_widget_config('m2-test-key-a') ? 'business_facts'), public.ai_widget_config('m2-test-key-a')::text;
insert into t_results (check_name, ok) values
  ('anon cannot read knowledge table', pg_temp.fails('select count(*) from public.ai_knowledge')),
  ('anon cannot read settings table', pg_temp.fails('select count(*) from public.ai_site_settings'));
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees no knowledge', count(*) = 0, count(*)::text from public.ai_knowledge;

-- ── Usage counters ────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok) values
  ('client cannot write usage', pg_temp.fails($$insert into public.ai_usage (scope) values ('dashboard')$$)),
  ('client cannot call rate counter', pg_temp.fails($$select public.svc_ai_hit('x', 60)$$));
reset role;
select public.svc_ai_record('site:' || pg_temp.id('siteA'), pg_temp.id('bizA'), pg_temp.id('prov')::text, 'ai', 100, 50, 0.002);
select public.svc_ai_record('site:' || pg_temp.id('siteA'), pg_temp.id('bizA'), '', 'faq');
insert into t_results (check_name, ok, detail)
select 'paid usage adds to spend in rupees', spent_inr = 0.18, spent_inr::text from public.ai_providers where id = pg_temp.id('prov');
insert into t_results (check_name, ok, detail)
select 'rate counter increments then resets after expiry', public.svc_ai_hit('t:1', 60) = 1 and public.svc_ai_hit('t:1', 60) = 2, 'ok';
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'owner sees own site usage', count(*) = 2, count(*)::text from public.ai_usage where business_id = pg_temp.id('bizA');
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees no usage', count(*) = 0, count(*)::text from public.ai_usage;

-- ── Module switch ─────────────────────────────────────────────────────────
reset role;
update public.business_modules set enabled = false where business_id = pg_temp.id('bizA') and module_key = 'ai_assistant';
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail) select 'module off disables FAQ fallback', public.faq_answer('m2-test-key-a', 'opening hours') = '[]'::jsonb, 'off';

reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
