-- One-time token for creating the first administrator. Single use, and refused once any admin exists.
create or replace function public.consume_bootstrap_token(p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_hash text;
begin
  if exists (select 1 from public.profiles where role = 'admin') then
    return false;
  end if;
  select value into v_hash from private.settings where key = 'bootstrap_token_sha256';
  if v_hash is null or encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') <> v_hash then
    return false;
  end if;
  delete from private.settings where key = 'bootstrap_token_sha256';
  return true;
end;
$$;
revoke all on function public.consume_bootstrap_token(text) from public, anon, authenticated;
grant execute on function public.consume_bootstrap_token(text) to service_role;
