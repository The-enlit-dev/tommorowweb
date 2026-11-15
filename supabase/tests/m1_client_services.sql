-- M1 security tests: change requests, comments, attachments, CMS, blog, build hooks.
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
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', k || '@m1.invalid', 'x', now(),
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
  ((select id from t_ids where k = 'siteA'), (select id from t_ids where k = 'bizA'), 'Site A', 'm1-test-key-a'),
  ((select id from t_ids where k = 'siteB'), (select id from t_ids where k = 'bizB'), 'Site B', 'm1-test-key-b');
insert into public.business_modules (business_id, module_key)
select (select id from t_ids where k = 'bizA'), m from unnest(array['change_requests', 'cms', 'blog']) m
union all select (select id from t_ids where k = 'bizB'), 'change_requests';

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

-- ── Change requests: create ────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into public.change_requests (business_id, title, description) values (pg_temp.id('bizA'), 'Change the hero text', 'New tagline please');
insert into t_ids select 'reqA', id from public.change_requests where title = 'Change the hero text';
insert into t_results (check_name, ok, detail)
select 'new request starts submitted, unpriced, owned by creator', status = 'submitted' and price_inr is null and created_by = pg_temp.id('ownerA'), status::text
from public.change_requests where id = pg_temp.id('reqA');
insert into t_results (check_name, ok) values
  ('client cannot send a price', pg_temp.fails(format('insert into public.change_requests (business_id, title, price_inr) values (%L, %L, 0)', pg_temp.id('bizA'), 'Free please'))),
  ('client cannot create for another business', pg_temp.fails(format('insert into public.change_requests (business_id, title) values (%L, %L)', pg_temp.id('bizB'), 'Sneaky'))),
  ('client cannot attach another business''s site', pg_temp.fails(format('insert into public.change_requests (business_id, site_id, title) values (%L, %L, %L)', pg_temp.id('bizA'), pg_temp.id('siteB'), 'Wrong site'))),
  ('client cannot write history directly', pg_temp.fails(format('insert into public.change_request_events (request_id, business_id, kind) values (%L, %L, %L)', pg_temp.id('reqA'), pg_temp.id('bizA'), 'status')));
update public.change_requests set status = 'done' where id = pg_temp.id('reqA');
insert into t_results (check_name, ok, detail)
select 'client cannot change status directly', status = 'submitted', status::text from public.change_requests where id = pg_temp.id('reqA');

-- ── Visibility ─────────────────────────────────────────────────────────────
select pg_temp.act_as('empA');
insert into t_results (check_name, ok, detail) select 'employee without settings permission sees no requests', count(*) = 0, count(*)::text from public.change_requests;
select pg_temp.act_as('mgrA');
insert into t_results (check_name, ok, detail) select 'manager with settings permission sees requests', count(*) = 1, count(*)::text from public.change_requests;
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees none of A''s requests', count(*) = 0, count(*)::text from public.change_requests where business_id = pg_temp.id('bizA');
select pg_temp.act_as('anon');
insert into t_results (check_name, ok) values ('anon cannot read requests', pg_temp.fails('select count(*) from public.change_requests'));

-- ── Admin quote, client approve ────────────────────────────────────────────
select pg_temp.act_as('admin');
insert into t_results (check_name, ok) values
  ('quote needs a price', pg_temp.fails(format('update public.change_requests set status = %L where id = %L', 'quoted', pg_temp.id('reqA'))));
update public.change_requests set price_inr = 400, status = 'quoted', quote_note = 'One section' where id = pg_temp.id('reqA');
insert into t_results (check_name, ok, detail)
select 'admin can quote', status = 'quoted' and quoted_at is not null, status::text from public.change_requests where id = pg_temp.id('reqA');
insert into t_results (check_name, ok, detail)
select 'price change is audited', count(*) = 1, count(*)::text from public.audit_logs where action = 'change_request:price' and entity_id = pg_temp.id('reqA')::text;

select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok) values
  ('other business cannot approve', pg_temp.fails(format('select public.change_request_action(%L, %L)', pg_temp.id('reqA'), 'approve')));
select pg_temp.act_as('ownerA');
select public.change_request_action(pg_temp.id('reqA'), 'approve');
insert into t_results (check_name, ok, detail)
select 'client approves quote', status = 'approved' and approved_at is not null, status::text from public.change_requests where id = pg_temp.id('reqA');
select pg_temp.act_as('admin');
update public.change_requests set status = 'in_progress' where id = pg_temp.id('reqA');
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok) values
  ('client cannot cancel once work started', pg_temp.fails(format('select public.change_request_action(%L, %L)', pg_temp.id('reqA'), 'cancel')));
select pg_temp.act_as('admin');
update public.change_requests set status = 'done', payment_status = 'paid', upi_ref = 'UTR123' where id = pg_temp.id('reqA');
insert into t_results (check_name, ok) values
  ('invalid transition rejected (done → quoted)', pg_temp.fails(format('update public.change_requests set status = %L where id = %L', 'quoted', pg_temp.id('reqA'))));
insert into t_results (check_name, ok, detail)
select 'history records every step', count(*) >= 6, count(*)::text from public.change_request_events where request_id = pg_temp.id('reqA');

-- ── Comments ──────────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into public.change_request_comments (request_id, body) values (pg_temp.id('reqA'), 'Thanks!');
insert into t_results (check_name, ok) values
  ('client cannot post internal notes', pg_temp.fails(format('insert into public.change_request_comments (request_id, body, internal) values (%L, %L, true)', pg_temp.id('reqA'), 'x')));
select pg_temp.act_as('admin');
insert into public.change_request_comments (request_id, body, internal) values (pg_temp.id('reqA'), 'Internal: took 40 min', true);
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail)
select 'client sees comments but not internal notes', count(*) = 1 and bool_and(not internal), count(*)::text from public.change_request_comments;
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees no comments', count(*) = 0, count(*)::text from public.change_request_comments;
insert into t_results (check_name, ok) values
  ('other business cannot comment', pg_temp.fails(format('insert into public.change_request_comments (request_id, body) values (%L, %L)', pg_temp.id('reqA'), 'hi')));

-- ── Attachments ───────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok) values
  ('attachment with correct path accepted', not pg_temp.fails(format('insert into public.change_request_attachments (request_id, path, name, size_bytes) values (%L, %L, %L, 10)',
     pg_temp.id('reqA'), pg_temp.id('bizA') || '/' || pg_temp.id('reqA') || '/a.png', 'a.png'))),
  ('attachment path into another business rejected', pg_temp.fails(format('insert into public.change_request_attachments (request_id, path, name, size_bytes) values (%L, %L, %L, 10)',
     pg_temp.id('reqA'), pg_temp.id('bizB') || '/' || pg_temp.id('reqA') || '/b.png', 'b.png')));

-- ── CMS ───────────────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok) values
  ('client cannot define content blocks', pg_temp.fails(format('insert into public.content_blocks (site_id, key, label, kind) values (%L, %L, %L, %L)', pg_temp.id('siteA'), 'hero.title', 'Hero', 'text')));
select pg_temp.act_as('admin');
insert into public.content_blocks (site_id, key, label, kind, max_length, draft) values (pg_temp.id('siteA'), 'hero.title', 'Hero title', 'text', 60, '{"text":"Old"}');
select pg_temp.act_as('ownerA');
update public.content_blocks set draft = '{"text":"Fresh coffee daily"}' where key = 'hero.title';
insert into t_results (check_name, ok, detail)
select 'client edits draft text', draft ->> 'text' = 'Fresh coffee daily' and published is null, draft::text from public.content_blocks where key = 'hero.title';
insert into t_results (check_name, ok) values
  ('client cannot rename a block', pg_temp.fails($$update public.content_blocks set label = 'X' where key = 'hero.title'$$)),
  ('client cannot set published directly', pg_temp.fails($$update public.content_blocks set published = '{"text":"hack"}' where key = 'hero.title'$$)),
  ('length limit enforced', pg_temp.fails($$update public.content_blocks set draft = jsonb_build_object('text', repeat('x', 61)) where key = 'hero.title'$$));
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail) select 'nothing public before publishing', public.site_content('m1-test-key-a') = '{}'::jsonb, public.site_content('m1-test-key-a')::text;
select pg_temp.act_as('empA');
insert into t_results (check_name, ok) values
  ('employee cannot publish', pg_temp.fails(format('select public.publish_site_content(%L)', pg_temp.id('siteA'))));
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'owner publishes', public.publish_site_content(pg_temp.id('siteA')) = 1, 'published';
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail)
select 'published content is public by site key', public.site_content('m1-test-key-a') -> 'hero.title' ->> 'text' = 'Fresh coffee daily', public.site_content('m1-test-key-a')::text;
insert into t_results (check_name, ok) values ('anon cannot read content table', pg_temp.fails('select count(*) from public.content_blocks'));
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok, detail) select 'other business sees no blocks', count(*) = 0, count(*)::text from public.content_blocks;

-- ── Blog ──────────────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into public.posts (site_id, slug, title, body_md, excerpt) values (pg_temp.id('siteA'), 'hello-pune', 'Hello Pune', '# Hi', 'First post');
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail) select 'draft posts are not public', jsonb_array_length(public.site_posts('m1-test-key-a')) = 0, public.site_posts('m1-test-key-a')::text;
select pg_temp.act_as('ownerA');
update public.posts set status = 'published' where slug = 'hello-pune';
select pg_temp.act_as('anon');
insert into t_results (check_name, ok, detail)
select 'published post listed without body', jsonb_array_length(public.site_posts('m1-test-key-a')) = 1 and not (public.site_posts('m1-test-key-a') -> 0 ? 'body_md'), public.site_posts('m1-test-key-a')::text;
insert into t_results (check_name, ok, detail)
select 'single post includes body', public.site_posts('m1-test-key-a', 'hello-pune') -> 0 ->> 'body_md' = '# Hi', 'ok';
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok) values
  ('blog module off: cannot post', pg_temp.fails(format('insert into public.posts (site_id, slug, title) values (%L, %L, %L)', pg_temp.id('siteB'), 'x', 'X'))),
  ('cannot post on another business''s site', pg_temp.fails(format('insert into public.posts (site_id, slug, title) values (%L, %L, %L)', pg_temp.id('siteA'), 'y', 'Y')));
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok) values
  ('cover must be own upload', pg_temp.fails(format($$update public.posts set cover_path = %L where slug = 'hello-pune'$$, pg_temp.id('bizB') || '/x.png'))),
  ('bad slug rejected', pg_temp.fails(format('insert into public.posts (site_id, slug, title) values (%L, %L, %L)', pg_temp.id('siteA'), 'Bad Slug!', 'X')));

-- ── Build hooks ───────────────────────────────────────────────────────────
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok) values
  ('non-hook URL rejected', pg_temp.fails(format('select public.set_site_build_hook(%L, %L)', pg_temp.id('siteA'), 'https://evil.example.com/x'))),
  ('Netlify hook saved', not pg_temp.fails(format('select public.set_site_build_hook(%L, %L)', pg_temp.id('siteA'), 'https://api.netlify.com/build_hooks/abc123'))),
  ('browser cannot read hook secret', pg_temp.fails(format('select public.svc_site_build_hook(%L)', pg_temp.id('siteA'))));
select pg_temp.act_as('ownerB');
insert into t_results (check_name, ok) values
  ('other business cannot set hook', pg_temp.fails(format('select public.set_site_build_hook(%L, %L)', pg_temp.id('siteA'), 'https://api.netlify.com/build_hooks/zzz')));
reset role;
insert into t_results (check_name, ok, detail)
select 'hook stored in Vault, not in sites', s.build_hook_secret_id is not null and ds.decrypted_secret = 'https://api.netlify.com/build_hooks/abc123', 'vault'
from public.sites s join vault.decrypted_secrets ds on ds.id = s.build_hook_secret_id where s.id = pg_temp.id('siteA');

-- ── Module switch enforced in the database ────────────────────────────────
update public.business_modules set enabled = false where business_id = pg_temp.id('bizA') and module_key = 'change_requests';
select pg_temp.act_as('ownerA');
insert into t_results (check_name, ok, detail) select 'module off hides requests', count(*) = 0, count(*)::text from public.change_requests;
insert into t_results (check_name, ok) values
  ('module off blocks new requests', pg_temp.fails(format('insert into public.change_requests (business_id, title) values (%L, %L)', pg_temp.id('bizA'), 'Off')));

reset role;
do $$ begin
  raise exception 'TEST_RESULTS %', (select json_agg(json_build_object('n', n, 'check', check_name, 'ok', ok, 'detail', left(detail, 80)) order by n) from t_results);
end $$;
rollback;
