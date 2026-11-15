-- Tomorrow Web platform — M0 foundation, part 2: security helpers, triggers, RPCs and Row-Level Security.
-- ── Security helpers (SECURITY DEFINER, fixed search_path) ───────────────────
-- A user only counts as "active" once they have changed their temporary password
-- and are not disabled. Every permission check goes through this.
create or replace function private.is_active_user(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and not p.disabled and not p.must_change_password
  );
$$;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and not p.disabled and not p.must_change_password
  );
$$;

create or replace function private.member_role(biz uuid)
returns public.member_role language sql stable security definer set search_path = '' as $$
  select m.role from public.business_members m
  where m.business_id = biz and m.user_id = auth.uid() and m.active
    and private.is_active_user(auth.uid());
$$;

create or replace function private.is_member(biz uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.member_role(biz) is not null;
$$;

create or replace function private.has_perm(biz uuid, perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or exists (
    select 1 from public.business_members m
    where m.business_id = biz and m.user_id = auth.uid() and m.active
      and private.is_active_user(auth.uid())
      and (m.role = 'owner' or perm = any (m.permissions))
  );
$$;

create or replace function private.module_on(biz uuid, mod text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_modules bm
    where bm.business_id = biz and bm.module_key = mod and bm.enabled
  );
$$;

-- Owners and managers may see the profiles of people in their business.
create or replace function private.can_see_profile(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select target = auth.uid() or private.is_admin() or exists (
    select 1
    from public.business_members me
    join public.business_members them on them.business_id = me.business_id
    where me.user_id = auth.uid() and me.active and me.role in ('owner', 'manager')
      and private.is_active_user(auth.uid())
      and them.user_id = target
  );
$$;

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated, anon, service_role;

-- ── Audit logging ────────────────────────────────────────────────────────────
create or replace function private.write_audit(p_action text, p_entity text, p_entity_id text, p_business uuid, p_details jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  select email into v_email from public.profiles where id = auth.uid();
  insert into public.audit_logs (actor_id, actor_email, business_id, action, entity, entity_id, details)
  values (auth.uid(), v_email, p_business, p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb));
end;
$$;

create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_biz uuid;
  v_id text;
begin
  v_biz := case
    when tg_table_name = 'businesses' then (v_row ->> 'id')::uuid
    when v_row ? 'business_id' then (v_row ->> 'business_id')::uuid
  end;
  v_id := coalesce(v_row ->> 'id', concat_ws(':', v_row ->> 'business_id', v_row ->> 'user_id', v_row ->> 'module_key'));
  -- Skip no-op updates.
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new;
  end if;
  perform private.write_audit(
    lower(tg_op) || ':' || tg_table_name, tg_table_name, v_id, v_biz,
    jsonb_strip_nulls(jsonb_build_object('before', v_old, 'after', v_new))
  );
  return coalesce(new, old);
end;
$$;

-- ── Generic triggers ─────────────────────────────────────────────────────────
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger businesses_touch before update on public.businesses for each row execute function private.touch_updated_at();
create trigger members_touch before update on public.business_members for each row execute function private.touch_updated_at();
create trigger sites_touch before update on public.sites for each row execute function private.touch_updated_at();
create trigger business_modules_touch before update on public.business_modules for each row execute function private.touch_updated_at();

create trigger businesses_audit after insert or update or delete on public.businesses for each row execute function private.audit_row();
create trigger members_audit after insert or update or delete on public.business_members for each row execute function private.audit_row();
create trigger sites_audit after insert or update or delete on public.sites for each row execute function private.audit_row();
create trigger business_modules_audit after insert or update or delete on public.business_modules for each row execute function private.audit_row();

-- Profiles: audit only security-relevant changes (role, disabled).
create or replace function private.audit_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.role is distinct from old.role or new.disabled is distinct from old.disabled then
    perform private.write_audit('update:profiles', 'profiles', new.id::text, null,
      jsonb_build_object('role', jsonb_build_object('before', old.role, 'after', new.role),
                         'disabled', jsonb_build_object('before', old.disabled, 'after', new.disabled)));
  end if;
  return new;
end;
$$;
create trigger profiles_audit after update on public.profiles for each row execute function private.audit_profile();

-- New auth users get a profile automatically.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, phone, must_change_password)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    coalesce((new.raw_user_meta_data ->> 'must_change_password')::boolean, true)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();

-- Members: owners cannot create or change owners, or edit themselves; only admins can.
create or replace function private.guard_members()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.is_admin() or auth.uid() is null then
    return coalesce(new, old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.role = 'owner' then
    raise exception 'Only Tomorrow Web can add or change business owners.' using errcode = '42501';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner' then
    raise exception 'Owner accounts can only be changed by Tomorrow Web.' using errcode = '42501';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.user_id = auth.uid() then
    raise exception 'You cannot change your own membership.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger members_guard before insert or update or delete on public.business_members for each row execute function private.guard_members();

-- ── RPCs used by the portal ──────────────────────────────────────────────────
-- Called after the user has set a new password through Supabase Auth.
create or replace function public.mark_password_changed()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  update public.profiles set must_change_password = false where id = auth.uid();
end;
$$;

-- Everything the portal shell needs for the signed-in user, in one call.
create or replace function public.my_context()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'profile', (select jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'phone', p.phone,
                  'role', p.role, 'must_change_password', p.must_change_password, 'disabled', p.disabled)
                from public.profiles p where p.id = auth.uid()),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'business_id', b.id, 'business_name', b.name, 'role', m.role, 'permissions', m.permissions,
        'modules', coalesce((select jsonb_agg(bm.module_key order by mo.sort)
                             from public.business_modules bm join public.modules mo on mo.key = bm.module_key
                             where bm.business_id = b.id and bm.enabled), '[]'::jsonb)
      ) order by b.name)
      from public.business_members m join public.businesses b on b.id = m.business_id
      where m.user_id = auth.uid() and m.active
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

-- Heartbeat from GitHub Actions (keep-alive / backup). Requires a shared token whose
-- SHA-256 hash is stored in private.settings, so status cannot be faked.
create or replace function public.record_heartbeat(p_kind text, p_token text, p_details jsonb default '{}')
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_hash text;
begin
  if p_kind not in ('keepalive', 'backup') then
    return false;
  end if;
  select value into v_hash from private.settings where key = 'heartbeat_token_sha256';
  if v_hash is null or encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') <> v_hash then
    return false;
  end if;
  insert into public.system_status (key, last_ok_at, details) values (p_kind, now(), coalesce(p_details, '{}'))
  on conflict (key) do update set last_ok_at = excluded.last_ok_at, details = excluded.details;
  return true;
end;
$$;

-- Database size for the admin infrastructure panel.
create or replace function public.admin_usage()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'storage_bytes', coalesce((select sum((metadata ->> 'size')::bigint) from storage.objects), 0),
    'auth_users', (select count(*) from auth.users),
    'status', coalesce((select jsonb_object_agg(key, jsonb_build_object('last_ok_at', last_ok_at, 'details', details)) from public.system_status), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.mark_password_changed() from public, anon;
revoke all on function public.my_context() from public, anon;
revoke all on function public.admin_usage() from public, anon;
grant execute on function public.mark_password_changed() to authenticated;
grant execute on function public.my_context() to authenticated;
grant execute on function public.admin_usage() to authenticated;
revoke all on function public.record_heartbeat(text, text, jsonb) from public;
grant execute on function public.record_heartbeat(text, text, jsonb) to anon, authenticated;

-- ── Row-Level Security ───────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.sites enable row level security;
alter table public.modules enable row level security;
alter table public.module_presets enable row level security;
alter table public.business_modules enable row level security;
alter table public.audit_logs enable row level security;
alter table public.system_status enable row level security;

-- profiles: read self / admin / owners+managers of the same business.
-- Users may only edit their own name and phone (column privileges below).
create policy profiles_select on public.profiles for select to authenticated
  using ((select private.can_see_profile(id)));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke insert, update, delete on public.profiles from authenticated, anon;
grant update (full_name, phone) on public.profiles to authenticated;

-- businesses
create policy businesses_select on public.businesses for select to authenticated
  using ((select private.is_admin()) or (select private.is_member(id)));
create policy businesses_insert on public.businesses for insert to authenticated
  with check ((select private.is_admin()));
create policy businesses_update on public.businesses for update to authenticated
  using ((select private.has_perm(id, 'settings.manage'))) with check ((select private.has_perm(id, 'settings.manage')));
create policy businesses_delete on public.businesses for delete to authenticated
  using ((select private.is_admin()));
revoke update on public.businesses from authenticated;
grant update (name, industry, city, locality) on public.businesses to authenticated;

-- business_members: you see your own row; owners and admins see and manage the team.
create policy members_select on public.business_members for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()) or (select private.member_role(business_id)) = 'owner');
create policy members_insert on public.business_members for insert to authenticated
  with check ((select private.is_admin()) or (select private.member_role(business_id)) = 'owner');
create policy members_update on public.business_members for update to authenticated
  using ((select private.is_admin()) or (select private.member_role(business_id)) = 'owner')
  with check ((select private.is_admin()) or (select private.member_role(business_id)) = 'owner');
create policy members_delete on public.business_members for delete to authenticated
  using ((select private.is_admin()) or (select private.member_role(business_id)) = 'owner');

-- sites: members read; admins manage.
create policy sites_select on public.sites for select to authenticated
  using ((select private.is_admin()) or (select private.is_member(business_id)));
create policy sites_insert on public.sites for insert to authenticated with check ((select private.is_admin()));
create policy sites_update on public.sites for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy sites_delete on public.sites for delete to authenticated using ((select private.is_admin()));

-- module catalogue: readable by signed-in users; changed only by migrations.
create policy modules_select on public.modules for select to authenticated using (true);
create policy presets_select on public.module_presets for select to authenticated using (true);
revoke insert, update, delete on public.modules, public.module_presets from authenticated, anon;

-- business_modules: members read; admins switch modules on and off.
create policy bmods_select on public.business_modules for select to authenticated
  using ((select private.is_admin()) or (select private.is_member(business_id)));
create policy bmods_insert on public.business_modules for insert to authenticated with check ((select private.is_admin()));
create policy bmods_update on public.business_modules for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy bmods_delete on public.business_modules for delete to authenticated using ((select private.is_admin()));

-- audit_logs: admins read; nobody edits or deletes (writes only via SECURITY DEFINER triggers).
create policy audit_select on public.audit_logs for select to authenticated using ((select private.is_admin()));
revoke insert, update, delete, truncate on public.audit_logs from authenticated, anon;

-- system_status: admins read; written only by record_heartbeat().
create policy status_select on public.system_status for select to authenticated using ((select private.is_admin()));
revoke insert, update, delete on public.system_status from authenticated, anon;

-- Anonymous visitors get nothing from these tables.
revoke all on public.profiles, public.businesses, public.business_members, public.sites,
  public.business_modules, public.audit_logs, public.system_status from anon;
