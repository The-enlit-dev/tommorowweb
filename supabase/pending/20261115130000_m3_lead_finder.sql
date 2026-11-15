-- M3: Lead Finder (administrator only). Leads, contact points with provenance, saved searches,
-- duplicate review, website audits and findings, locality cache, deletion-on-request suppression,
-- optional Google settings (key in Vault, off by default) and API usage caps.

-- ── Leads ───────────────────────────────────────────────────────────────────
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 200),
  industry text,
  category text,
  city text,
  locality text,
  address text,
  lat double precision,
  lon double precision,
  osm_ref text unique,
  place_ref text unique,
  sources text[] not null default '{}',
  website_url text,
  website_domain text,
  website_state text not null default 'none_listed'
    check (website_state in ('none_listed', 'unverified', 'broken', 'live', 'redirects_elsewhere')),
  website_checked_at timestamptz,
  website_note text,
  primary_phone text,
  primary_email text,
  contact_person text check (length(contact_person) <= 120),
  research_status text not null default 'to_research'
    check (research_status in ('to_research', 'researching', 'verified', 'not_suitable')),
  research_checklist jsonb not null default '{}',
  research_notes text check (length(research_notes) <= 8000),
  evidence_links text[] not null default '{}',
  do_not_contact boolean not null default false,
  dnc_reason text,
  dnc_at timestamptz,
  score int check (score between 0 and 100),
  score_reasons jsonb not null default '[]',
  scored_at timestamptz,
  pagespeed_performance int,
  extra jsonb not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index leads_score_idx on public.leads (score desc nulls last);
create index leads_locality_idx on public.leads (lower(locality));
create index leads_industry_idx on public.leads (industry);
comment on column public.leads.website_state is 'none_listed = no source lists a website; unverified = listed but not reachable/confirmed (never "no website").';

create table public.lead_contact_points (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  kind text not null check (kind in ('phone', 'email', 'website', 'social', 'whatsapp')),
  value text not null check (length(value) <= 500),
  value_norm text not null check (length(value_norm) <= 500),
  source text not null check (source in ('osm', 'google_places', 'manual', 'website', 'csv')),
  source_ref text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_verified_at timestamptz,
  verified_by text check (verified_by in ('check', 'person')),
  verified_by_user uuid,
  expires_at timestamptz,
  note text check (length(note) <= 300),
  unique (lead_id, kind, value_norm)
);
create index lead_contacts_lookup_idx on public.lead_contact_points (kind, value_norm);
comment on column public.lead_contact_points.expires_at is 'Google Places details are cached at most 30 days unless verified by a person.';

-- Keep the lead's summary fields in step with its contact points.
create or replace function private.lead_sync(p_lead uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_site record; v_phone text; v_email text;
begin
  select value, value_norm into v_site from public.lead_contact_points
  where lead_id = p_lead and kind = 'website' order by (verified_by is not null) desc, last_seen_at desc limit 1;
  select value into v_phone from public.lead_contact_points where lead_id = p_lead and kind in ('phone', 'whatsapp')
  order by (verified_by = 'person') desc nulls last, (verified_by is not null) desc, first_seen_at limit 1;
  select value into v_email from public.lead_contact_points where lead_id = p_lead and kind = 'email'
  order by (verified_by is not null) desc, first_seen_at limit 1;
  update public.leads l set
    primary_phone = v_phone,
    primary_email = v_email,
    website_url = v_site.value,
    website_domain = v_site.value_norm,
    website_state = case
      when v_site.value is null then 'none_listed'
      when l.website_state = 'none_listed' or l.website_domain is distinct from v_site.value_norm then 'unverified'
      else l.website_state end,
    website_checked_at = case when v_site.value is null or l.website_domain is distinct from v_site.value_norm then null else l.website_checked_at end
  where l.id = p_lead;
end;
$$;

create or replace function private.lead_contacts_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.lead_sync(coalesce(new.lead_id, old.lead_id));
  return null;
end;
$$;
create trigger lead_contacts_sync after insert or update or delete on public.lead_contact_points
  for each row execute function private.lead_contacts_changed();
create trigger leads_touch before update on public.leads for each row execute function private.touch_updated_at();

create or replace function private.lead_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.do_not_contact and (tg_op = 'INSERT' or not old.do_not_contact) then new.dnc_at := now(); end if;
  if not new.do_not_contact then new.dnc_at := null; new.dnc_reason := null; end if;
  return new;
end;
$$;
create trigger leads_before_write before insert or update on public.leads for each row execute function private.lead_before_write();

create or replace function private.lead_audit_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('tw.lead_delete', true) = 'request' then return old; end if; -- logged by delete_lead_on_request
  if current_setting('tw.lead_delete', true) = 'merge' then return old; end if;   -- logged by merge_leads
  perform private.write_audit('lead:delete', 'leads', old.id::text, null, jsonb_build_object('name', old.name, 'locality', old.locality));
  return old;
end;
$$;
create trigger leads_audit_delete after delete on public.leads for each row execute function private.lead_audit_delete();

create or replace function private.lead_audit_dnc()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.do_not_contact is distinct from old.do_not_contact then
    perform private.write_audit(case when new.do_not_contact then 'lead:do_not_contact' else 'lead:contact_allowed' end,
      'leads', new.id::text, null, jsonb_build_object('reason', new.dnc_reason));
  end if;
  return new;
end;
$$;
create trigger leads_audit_dnc after update on public.leads for each row execute function private.lead_audit_dnc();

-- ── Searches ────────────────────────────────────────────────────────────────
create table public.lead_searches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  source text not null default 'osm' check (source in ('osm', 'google_places')),
  city text not null default 'Pune',
  locality text,
  lat double precision,
  lon double precision,
  radius_m int not null default 1000 check (radius_m between 100 and 5000),
  industries text[] not null check (cardinality(industries) between 1 and 12),
  runs int not null default 0,
  last_run_at timestamptz,
  last_run_found int,
  last_run_new int,
  last_run_merged int,
  last_run_possible int,
  last_error text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.lead_search_hits (
  search_id uuid not null references public.lead_searches (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (search_id, lead_id)
);
create index lead_hits_lead_idx on public.lead_search_hits (lead_id);

create table public.lead_duplicates (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  other_id uuid not null references public.leads (id) on delete cascade,
  reason text not null,
  similarity numeric(4, 2),
  status text not null default 'open' check (status in ('open', 'merged', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (lead_id, other_id),
  check (lead_id <> other_id)
);

-- ── Audits ──────────────────────────────────────────────────────────────────
create table public.lead_audits (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  url text,
  final_url text,
  http_status int,
  response_ms int,
  page_bytes int,
  redirects text[] not null default '{}',
  analysis jsonb,
  pagespeed jsonb,
  links_checked int,
  error text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid default auth.uid()
);
create index lead_audits_lead_idx on public.lead_audits (lead_id, queued_at desc);
create index lead_audits_queue_idx on public.lead_audits (queued_at) where status = 'queued';

create table public.lead_findings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  audit_id uuid references public.lead_audits (id) on delete cascade,
  source text not null check (source in ('check', 'pagespeed', 'ai')),
  code text not null,
  severity text not null check (severity in ('high', 'medium', 'low', 'info')),
  title text not null,
  evidence text,
  created_at timestamptz not null default now()
);
create index lead_findings_lead_idx on public.lead_findings (lead_id, created_at desc);

-- ── Supporting tables ───────────────────────────────────────────────────────
create table public.lead_localities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text not null,
  lat double precision not null,
  lon double precision not null,
  display_name text,
  source text not null default 'nominatim',
  fetched_at timestamptz not null default now()
);
create unique index lead_localities_key on public.lead_localities (lower(name), lower(city));

create table public.lead_suppressions (
  key_hash text primary key,
  kind text not null,
  reason text,
  created_at timestamptz not null default now()
);
comment on table public.lead_suppressions is 'SHA-256 of phone/domain/OSM/Places keys of businesses deleted on request, so searches never re-add them. No readable personal data.';

create table public.lead_settings (
  id int primary key default 1 check (id = 1),
  pagespeed_enabled boolean not null default true,
  places_enabled boolean not null default false,
  places_monthly_cap int not null default 0 check (places_monthly_cap between 0 and 100000),
  google_key_secret_id uuid,
  updated_at timestamptz not null default now()
);
insert into public.lead_settings (id) values (1);
create trigger lead_settings_touch before update on public.lead_settings for each row execute function private.touch_updated_at();
create trigger lead_settings_audit after update on public.lead_settings for each row execute function private.audit_row();

create table public.lead_api_usage (
  month text not null,
  api text not null,
  requests int not null default 0,
  primary key (month, api)
);

-- ── Functions ───────────────────────────────────────────────────────────────
create or replace function private.lead_key_hash(p_kind text, p_value text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p_kind || ':' || lower(p_value), 'sha256'), 'hex');
$$;

-- Merge p_drop into p_keep (all contact points, history, audits); p_drop is deleted.
create or replace function public.merge_leads(p_keep uuid, p_drop uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare k public.leads; d public.leads;
begin
  if not private.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  if p_keep = p_drop then raise exception 'Choose two different leads' using errcode = '22023'; end if;
  select * into k from public.leads where id = p_keep for update;
  select * into d from public.leads where id = p_drop for update;
  if k.id is null or d.id is null then raise exception 'Lead not found' using errcode = '22023'; end if;

  insert into public.lead_contact_points (lead_id, kind, value, value_norm, source, source_ref, first_seen_at, last_seen_at, last_verified_at, verified_by, verified_by_user, expires_at, note)
  select p_keep, kind, value, value_norm, source, source_ref, first_seen_at, last_seen_at, last_verified_at, verified_by, verified_by_user, expires_at, note
  from public.lead_contact_points where lead_id = p_drop
  on conflict (lead_id, kind, value_norm) do update set
    last_seen_at = greatest(public.lead_contact_points.last_seen_at, excluded.last_seen_at),
    last_verified_at = coalesce(greatest(public.lead_contact_points.last_verified_at, excluded.last_verified_at), public.lead_contact_points.last_verified_at, excluded.last_verified_at),
    verified_by = coalesce(public.lead_contact_points.verified_by, excluded.verified_by);
  insert into public.lead_search_hits (search_id, lead_id, first_seen_at, last_seen_at)
  select search_id, p_keep, first_seen_at, last_seen_at from public.lead_search_hits where lead_id = p_drop
  on conflict (search_id, lead_id) do update set first_seen_at = least(public.lead_search_hits.first_seen_at, excluded.first_seen_at);
  update public.lead_audits set lead_id = p_keep where lead_id = p_drop;
  update public.lead_findings set lead_id = p_keep where lead_id = p_drop;
  update public.lead_duplicates set status = 'merged', resolved_at = now()
  where status = 'open' and ((lead_id = p_drop and other_id = p_keep) or (lead_id = p_keep and other_id = p_drop));

  perform set_config('tw.lead_delete', 'merge', true);
  delete from public.leads where id = p_drop;
  perform set_config('tw.lead_delete', '', true);

  update public.leads set
    osm_ref = coalesce(k.osm_ref, d.osm_ref),
    place_ref = coalesce(k.place_ref, d.place_ref),
    sources = (select array_agg(distinct x) from unnest(k.sources || d.sources) x),
    industry = coalesce(k.industry, d.industry), category = coalesce(k.category, d.category),
    locality = coalesce(k.locality, d.locality), city = coalesce(k.city, d.city), address = coalesce(k.address, d.address),
    lat = coalesce(k.lat, d.lat), lon = coalesce(k.lon, d.lon), contact_person = coalesce(k.contact_person, d.contact_person),
    research_notes = nullif(concat_ws(E'\n\n', k.research_notes, d.research_notes), ''),
    evidence_links = (select coalesce(array_agg(distinct x), '{}') from unnest(k.evidence_links || d.evidence_links) x),
    do_not_contact = k.do_not_contact or d.do_not_contact,
    dnc_reason = coalesce(k.dnc_reason, d.dnc_reason)
  where id = p_keep;
  perform private.lead_sync(p_keep);
  perform private.write_audit('lead:merge', 'leads', p_keep::text, null, jsonb_build_object('kept', k.name, 'merged', d.name, 'merged_id', p_drop));
end;
$$;

-- Delete a business on its request and make sure future searches never add it again.
create or replace function public.delete_lead_on_request(p_lead uuid, p_reason text default null)
returns int language plpgsql security definer set search_path = '' as $$
declare l public.leads; n int;
begin
  if not private.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  select * into l from public.leads where id = p_lead;
  if l.id is null then raise exception 'Lead not found' using errcode = '22023'; end if;
  insert into public.lead_suppressions (key_hash, kind, reason)
  select private.lead_key_hash(k, v), k, left(p_reason, 200) from (
    select 'phone' k, value_norm v from public.lead_contact_points where lead_id = p_lead and kind in ('phone', 'whatsapp')
    union select 'domain', value_norm from public.lead_contact_points where lead_id = p_lead and kind = 'website'
    union select 'email', value_norm from public.lead_contact_points where lead_id = p_lead and kind = 'email'
    union select 'osm', l.osm_ref where l.osm_ref is not null
    union select 'place', l.place_ref where l.place_ref is not null
  ) keys
  on conflict (key_hash) do nothing;
  get diagnostics n = row_count;
  perform set_config('tw.lead_delete', 'request', true);
  delete from public.leads where id = p_lead;
  perform set_config('tw.lead_delete', '', true);
  perform private.write_audit('lead:delete_on_request', 'leads', p_lead::text, null, jsonb_build_object('suppressed_keys', n, 'reason', left(p_reason, 200)));
  return n;
end;
$$;

create or replace function public.set_google_api_key(p_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  select google_key_secret_id into v_id from public.lead_settings where id = 1;
  if nullif(trim(p_key), '') is null then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
    update public.lead_settings set google_key_secret_id = null where id = 1;
  elsif v_id is null then
    v_id := vault.create_secret(trim(p_key), 'google_api_key', 'Google Cloud API key (PageSpeed / optional Places)');
    update public.lead_settings set google_key_secret_id = v_id where id = 1;
  else
    perform vault.update_secret(v_id, trim(p_key));
  end if;
  perform private.write_audit(case when nullif(trim(p_key), '') is null then 'leads:clear_google_key' else 'leads:set_google_key' end, 'lead_settings', '1', null, '{}');
end;
$$;

create or replace function public.svc_lead_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('pagespeed_enabled', s.pagespeed_enabled, 'places_enabled', s.places_enabled,
    'places_monthly_cap', s.places_monthly_cap, 'google_key', ds.decrypted_secret)
  from public.lead_settings s left join vault.decrypted_secrets ds on ds.id = s.google_key_secret_id where s.id = 1;
$$;

-- Counts a paid-API request against this month's cap. Returns the new count, or -1 if over the cap.
create or replace function public.svc_lead_api_hit(p_api text, p_cap int)
returns int language plpgsql security definer set search_path = '' as $$
declare v_month text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM'); n int;
begin
  insert into public.lead_api_usage as u (month, api, requests) values (v_month, p_api, 0) on conflict do nothing;
  update public.lead_api_usage set requests = requests + 1 where month = v_month and api = p_api and requests < p_cap returning requests into n;
  return coalesce(n, -1);
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function public.merge_leads(uuid, uuid) from public, anon;
revoke all on function public.delete_lead_on_request(uuid, text) from public, anon;
revoke all on function public.set_google_api_key(text) from public, anon;
revoke all on function public.svc_lead_settings() from public, anon, authenticated;
revoke all on function public.svc_lead_api_hit(text, int) from public, anon, authenticated;
grant execute on function public.merge_leads(uuid, uuid) to authenticated;
grant execute on function public.delete_lead_on_request(uuid, text) to authenticated;
grant execute on function public.set_google_api_key(text) to authenticated;
grant execute on function public.svc_lead_settings() to service_role;
grant execute on function public.svc_lead_api_hit(text, int) to service_role;

revoke all on public.leads, public.lead_contact_points, public.lead_searches, public.lead_search_hits, public.lead_duplicates,
  public.lead_audits, public.lead_findings, public.lead_localities, public.lead_suppressions, public.lead_settings, public.lead_api_usage from anon;
revoke insert, update, delete on public.lead_suppressions, public.lead_api_usage from authenticated;
revoke insert, delete on public.lead_settings from authenticated;
revoke update on public.lead_settings from authenticated;
grant update (pagespeed_enabled, places_enabled, places_monthly_cap) on public.lead_settings to authenticated;

-- ── RLS: administrator only ─────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['leads', 'lead_contact_points', 'lead_searches', 'lead_search_hits', 'lead_duplicates', 'lead_audits',
    'lead_findings', 'lead_localities', 'lead_suppressions', 'lead_settings', 'lead_api_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t || '_admin', t);
  end loop;
end $$;
