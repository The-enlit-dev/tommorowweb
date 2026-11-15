-- Removes test data created by the API and browser tests (run in the Supabase SQL editor).
-- Only touches businesses named "QA …" and accounts with emails ending in @tomorrowweb.test.
-- Review the preview first; the delete is irreversible.

-- Preview
select 'business' as kind, name from public.businesses where name like 'QA %' and not is_internal
union all
select 'account', email from auth.users where email like '%@tomorrowweb.test' and email <> 'qa-admin@tomorrowweb.test';

-- Delete (uncomment to run)
-- begin;
-- delete from storage.objects where bucket_id in ('media', 'attachments')
--   and private.try_uuid(split_part(name, '/', 1)) in (select id from public.businesses where name like 'QA %' and not is_internal);
-- delete from public.businesses where name like 'QA %' and not is_internal;
-- delete from auth.users where email like '%@tomorrowweb.test' and email <> 'qa-admin@tomorrowweb.test';
-- commit;
