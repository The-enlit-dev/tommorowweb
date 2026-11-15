-- Minimal stand-ins for the Supabase platform objects our schema depends on, so a backup
-- (or the migrations) can be restored into a plain PostgreSQL server for verification.
-- Used by .github/workflows/backup.yml (restore test) and scripts/verify-migrations.sh.
-- NOT for production: on a real Supabase project these objects already exist.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_realtime_admin') then create role supabase_realtime_admin nologin; end if;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists vault;
create schema if not exists realtime;

create or replace function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create or replace function auth.role() returns text language sql stable as
$$ select auth.jwt() ->> 'role' $$;

-- A backup restores the real auth.users/auth.identities definitions; the migrations test needs a stand-in.
do $$ begin
  if current_setting('tw.shim_auth_tables', true) = 'on' and to_regclass('auth.users') is null then
    create table auth.users (
      instance_id uuid, id uuid primary key, aud text, role text, email text, email_confirmed_at timestamptz, encrypted_password text, raw_user_meta_data jsonb default '{}',
      raw_app_meta_data jsonb default '{}', banned_until timestamptz, created_at timestamptz default now(),
      updated_at timestamptz default now(), last_sign_in_at timestamptz
    );
  end if;
end $$;

-- Storage stand-ins (buckets/objects) so storage policies in migrations can be created.
do $$ begin
  if current_setting('tw.shim_auth_tables', true) = 'on' and to_regclass('storage.buckets') is null then
    create table storage.buckets (id text primary key, name text not null, public boolean default false,
      file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz default now(), updated_at timestamptz default now());
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
      name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    alter table storage.objects enable row level security;
  end if;
end $$;
create or replace function storage.foldername(name text) returns text[] language sql immutable as
$$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;

-- Vault stand-in: secrets stored in plain text ONLY inside the throwaway verification database.
do $$ begin
  if to_regclass('vault.secrets') is null then
    create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text,
      secret text, created_at timestamptz default now(), updated_at timestamptz default now());
    create view vault.decrypted_secrets as select *, secret as decrypted_secret from vault.secrets;
  end if;
end $$;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name), updated_at = now() where id = secret_id $$;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;

-- Supabase's default privileges: the API roles get table access in public, and RLS decides rows.
grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
