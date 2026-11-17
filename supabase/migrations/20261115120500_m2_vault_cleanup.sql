-- Remove Vault secrets together with the rows that own them (AI provider tokens, site deploy hooks).
create or replace function private.delete_owned_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when tg_table_name = 'ai_providers' then old.token_secret_id else old.build_hook_secret_id end;
begin
  if v_id is not null then delete from vault.secrets where id = v_id; end if;
  return old;
end;
$$;
create trigger ai_providers_delete_secret after delete on public.ai_providers
  for each row execute function private.delete_owned_secret();
create trigger sites_delete_secret after delete on public.sites
  for each row execute function private.delete_owned_secret();

-- One-time cleanup of secrets whose owner no longer exists.
delete from vault.secrets
where (name like 'ai_provider_token:%' and id not in (select token_secret_id from public.ai_providers where token_secret_id is not null))
   or (name like 'site_build_hook:%' and id not in (select build_hook_secret_id from public.sites where build_hook_secret_id is not null));
