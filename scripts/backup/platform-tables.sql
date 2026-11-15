-- Emits CREATE TABLE statements for plain stand-ins of the Supabase platform tables we back up,
-- built from the live column list (generated columns are skipped: pg_dump never dumps them;
-- custom enum types become text). Used only to restore into a plain PostgreSQL for verification.
select format('create table if not exists %I.%I (%s);', table_schema, table_name,
  string_agg(format('%I %s', column_name,
    case when data_type = 'USER-DEFINED' then 'text'
         when data_type = 'ARRAY' then substr(udt_name, 2) || '[]'
         else data_type end), ', ' order by ordinal_position))
from information_schema.columns
where (table_schema, table_name) in (('auth','users'),('auth','identities'),('storage','buckets'),('storage','objects'))
  and is_generated = 'NEVER'
group by table_schema, table_name
union all select 'alter table auth.users add primary key (id);'
union all select 'alter table storage.buckets add primary key (id);';
