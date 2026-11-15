-- M2: AI providers (self-hosted + optional OpenRouter, ₹0 spend limit by default), per-site
-- assistant settings, FAQ/knowledge base with an AI-independent FAQ fallback, usage and rate limits.

create or replace function private.can_ai(biz uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'ai_assistant') and private.has_perm(biz, 'settings.manage'));
$$;

-- ── Providers (administrator only) ──────────────────────────────────────────
create table public.ai_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  kind text not null check (kind in ('ollama', 'llamacpp', 'openrouter')),
  base_url text not null,
  model text not null check (length(model) between 1 and 200),
  enabled boolean not null default false,
  priority int not null default 100,
  timeout_ms int not null default 20000 check (timeout_ms between 2000 and 60000),
  max_tokens int not null default 400 check (max_tokens between 16 and 4000),
  -- Spending policy. 0 = free models only (default). Paid models need an explicit, audited limit.
  max_spend_inr numeric(10, 2) not null default 0 check (max_spend_inr >= 0),
  spent_inr numeric(12, 4) not null default 0,
  usd_inr_rate numeric(8, 2) not null default 90 check (usd_inr_rate > 0),
  rpm_limit int not null default 20 check (rpm_limit between 1 and 600),
  daily_limit int not null default 200 check (daily_limit between 1 and 100000),
  token_secret_id uuid,
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_ms int,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.ai_providers.max_spend_inr is 'Spending limit in rupees. 0 (default) means paid models are always refused.';

create or replace function private.ai_provider_validate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_host text;
begin
  new.base_url := regexp_replace(trim(new.base_url), '/+$', '');
  if new.kind = 'openrouter' then
    new.base_url := 'https://openrouter.ai/api/v1';
  elsif new.base_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/.*)?$' then
    raise exception 'Self-hosted AI servers must be reached over https (e.g. through a Cloudflare Tunnel)' using errcode = '22023';
  end if;
  v_host := lower(split_part(split_part(new.base_url, '://', 2), '/', 1));
  -- Hosted paid AI APIs are never allowed. OpenRouter is the only hosted API, under the spending policy.
  if v_host ~ '(^|\.)(openai\.com|anthropic\.com|googleapis\.com|mistral\.ai|groq\.com|together\.xyz|together\.ai|deepseek\.com|cohere\.(com|ai)|perplexity\.ai|x\.ai|fireworks\.ai|replicate\.com|azure\.com|amazonaws\.com)$' then
    raise exception 'Paid AI APIs (%) are not allowed. Use a self-hosted server or OpenRouter.', v_host using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.max_spend_inr is distinct from old.max_spend_inr then
    perform private.write_audit('ai:spend_limit', 'ai_providers', new.id::text, null,
      jsonb_build_object('name', new.name, 'before_inr', old.max_spend_inr, 'after_inr', new.max_spend_inr));
  end if;
  return new;
end;
$$;
create trigger ai_providers_validate before insert or update on public.ai_providers
  for each row execute function private.ai_provider_validate();
create trigger ai_providers_touch before update on public.ai_providers
  for each row execute function private.touch_updated_at();
create trigger ai_providers_audit after insert or delete on public.ai_providers
  for each row execute function private.audit_row();

-- ── Per-site assistant settings ─────────────────────────────────────────────
create table public.ai_site_settings (
  site_id uuid primary key references public.sites (id) on delete cascade,
  business_id uuid not null,
  enabled boolean not null default false,
  greeting text check (length(greeting) <= 300),
  business_facts text check (length(business_facts) <= 6000),
  handoff_whatsapp text check (handoff_whatsapp ~ '^[0-9]{8,15}$'),
  handoff_url text check (handoff_url ~ '^(https://|/)'),
  -- Administrator-only controls:
  ai_enabled boolean not null default true,
  provider_id uuid references public.ai_providers (id) on delete set null,
  daily_cap int not null default 100 check (daily_cap between 0 and 10000),
  per_ip_per_hour int not null default 20 check (per_ip_per_hour between 1 and 500),
  updated_at timestamptz not null default now()
);
comment on column public.ai_site_settings.ai_enabled is 'false = this site only ever uses FAQ answers (no AI calls).';

create or replace function private.ai_settings_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.business_id := private.site_business(new.site_id);
  if not private.is_admin() then
    if tg_op = 'INSERT' then
      new.ai_enabled := true; new.provider_id := null; new.daily_cap := 100; new.per_ip_per_hour := 20;
    elsif (new.ai_enabled, new.provider_id, new.daily_cap, new.per_ip_per_hour)
          is distinct from (old.ai_enabled, old.provider_id, old.daily_cap, old.per_ip_per_hour) then
      raise exception 'Only Tomorrow Web can change AI limits and providers' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger ai_settings_before_write before insert or update on public.ai_site_settings
  for each row execute function private.ai_settings_before_write();
create trigger ai_settings_touch before update on public.ai_site_settings
  for each row execute function private.touch_updated_at();
create trigger ai_settings_audit after insert or update or delete on public.ai_site_settings
  for each row execute function private.audit_row();

-- ── Knowledge: FAQs and facts (full-text search, no AI needed) ──────────────
create table public.ai_knowledge (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  business_id uuid not null,
  question text not null check (length(trim(question)) between 3 and 300),
  answer text not null check (length(trim(answer)) between 1 and 2000),
  active boolean not null default true,
  sort int not null default 100,
  tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(question, '')), 'A') || setweight(to_tsvector('english', coalesce(answer, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(question, '')), 'A')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_knowledge_site_idx on public.ai_knowledge (site_id) where active;
create index ai_knowledge_tsv_idx on public.ai_knowledge using gin (tsv);

create or replace function private.ai_knowledge_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.business_id := private.site_business(new.site_id);
  return new;
end;
$$;
create trigger ai_knowledge_before_write before insert or update on public.ai_knowledge
  for each row execute function private.ai_knowledge_before_write();
create trigger ai_knowledge_touch before update on public.ai_knowledge
  for each row execute function private.touch_updated_at();

-- ── Usage and rate limiting ─────────────────────────────────────────────────
create table public.ai_usage (
  day date not null default (now() at time zone 'Asia/Kolkata')::date,
  scope text not null,              -- 'site:<uuid>' or 'dashboard'
  provider text not null default '', -- provider id, '' for FAQ-only answers
  business_id uuid,
  requests int not null default 0,
  ai_answers int not null default 0,
  faq_answers int not null default 0,
  failures int not null default 0,
  refusals int not null default 0,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  primary key (day, scope, provider)
);
create index ai_usage_biz_idx on public.ai_usage (business_id, day desc);

create table private.ai_rate (
  key text primary key,
  count int not null default 0,
  expires_at timestamptz not null
);

-- ── Service-role functions used by the `ai` Edge Function ───────────────────
create or replace function public.svc_ai_providers()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'kind', p.kind, 'base_url', p.base_url, 'model', p.model, 'enabled', p.enabled,
    'priority', p.priority, 'timeout_ms', p.timeout_ms, 'max_tokens', p.max_tokens, 'max_spend_inr', p.max_spend_inr,
    'spent_inr', p.spent_inr, 'usd_inr_rate', p.usd_inr_rate, 'rpm_limit', p.rpm_limit, 'daily_limit', p.daily_limit,
    'token', ds.decrypted_secret) order by p.priority, p.created_at), '[]'::jsonb)
  from public.ai_providers p left join vault.decrypted_secrets ds on ds.id = p.token_secret_id;
$$;

-- Atomic counter with expiry. Returns the new count.
create or replace function public.svc_ai_hit(p_key text, p_ttl_seconds int)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into private.ai_rate as r (key, count, expires_at) values (p_key, 1, now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update set
    count = case when r.expires_at < now() then 1 else r.count + 1 end,
    expires_at = case when r.expires_at < now() then excluded.expires_at else r.expires_at end
  returning count into n;
  -- Opportunistic cleanup of expired counters.
  if random() < 0.02 then delete from private.ai_rate where expires_at < now() - interval '1 day'; end if;
  return n;
end;
$$;

create or replace function public.svc_ai_record(p_scope text, p_business uuid, p_provider text, p_outcome text,
  p_prompt_tokens int default 0, p_completion_tokens int default 0, p_cost_usd numeric default 0)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ai_usage as u (scope, provider, business_id, requests, ai_answers, faq_answers, failures, refusals, prompt_tokens, completion_tokens, cost_usd)
  values (p_scope, coalesce(p_provider, ''), p_business, 1,
    (p_outcome = 'ai')::int, (p_outcome = 'faq')::int, (p_outcome = 'fail')::int, (p_outcome = 'refused')::int,
    coalesce(p_prompt_tokens, 0), coalesce(p_completion_tokens, 0), coalesce(p_cost_usd, 0))
  on conflict (day, scope, provider) do update set
    requests = u.requests + 1,
    ai_answers = u.ai_answers + excluded.ai_answers,
    faq_answers = u.faq_answers + excluded.faq_answers,
    failures = u.failures + excluded.failures,
    refusals = u.refusals + excluded.refusals,
    prompt_tokens = u.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = u.completion_tokens + excluded.completion_tokens,
    cost_usd = u.cost_usd + excluded.cost_usd;
  if coalesce(p_cost_usd, 0) > 0 and p_provider ~ '^[0-9a-f-]{36}$' then
    update public.ai_providers set spent_inr = spent_inr + p_cost_usd * usd_inr_rate where id = p_provider::uuid;
  end if;
end;
$$;

create or replace function public.svc_ai_check(p_provider uuid, p_ok boolean, p_ms int, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.ai_providers set last_check_at = now(), last_check_ok = p_ok, last_check_ms = p_ms, last_error = left(p_error, 500)
  where id = p_provider;
$$;

-- Admin: store a provider's access token in Vault (write-only).
create or replace function public.set_ai_provider_token(p_provider uuid, p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text;
begin
  if not private.is_admin() then raise exception 'Admins only' using errcode = '42501'; end if;
  select token_secret_id, name into v_id, v_name from public.ai_providers where id = p_provider;
  if v_name is null then raise exception 'Provider not found' using errcode = '22023'; end if;
  if nullif(trim(p_token), '') is null then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
    update public.ai_providers set token_secret_id = null where id = p_provider;
  elsif v_id is null then
    v_id := vault.create_secret(trim(p_token), 'ai_provider_token:' || p_provider::text, 'Access token for AI provider ' || v_name);
    update public.ai_providers set token_secret_id = v_id where id = p_provider;
  else
    perform vault.update_secret(v_id, trim(p_token));
  end if;
  perform private.write_audit(case when nullif(trim(p_token), '') is null then 'ai:clear_token' else 'ai:set_token' end,
    'ai_providers', p_provider::text, null, jsonb_build_object('name', v_name));
end;
$$;

-- ── Public functions (anon): widget configuration and FAQ fallback ──────────
create or replace function public.ai_widget_config(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('enabled', coalesce(st.enabled, false) and private.module_on(s.business_id, 'ai_assistant'),
    'name', b.name, 'greeting', st.greeting, 'whatsapp', st.handoff_whatsapp, 'contact_url', st.handoff_url)
  from public.sites s join public.businesses b on b.id = s.business_id
  left join public.ai_site_settings st on st.site_id = s.id
  where s.public_key = p_key;
$$;

-- FAQ fallback: full-text search over the site's FAQs. Needs no AI provider and no Edge Function.
create or replace function public.faq_answer(p_key text, p_question text, p_limit int default 3)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_site uuid; v_q_en tsquery; v_q_simple tsquery; v_terms text[];
begin
  select s.id into v_site from public.sites s
  join public.ai_site_settings st on st.site_id = s.id and st.enabled
  where s.public_key = p_key and private.module_on(s.business_id, 'ai_assistant');
  if v_site is null or length(trim(coalesce(p_question, ''))) < 2 then return '[]'::jsonb; end if;
  -- OR together the meaningful words of the question (english stems + raw words).
  v_terms := tsvector_to_array(to_tsvector('english', left(p_question, 500)));
  if array_length(v_terms, 1) > 0 then
    v_q_en := to_tsquery('english', array_to_string(array(select quote_literal(t) from unnest(v_terms) t), ' | '));
  end if;
  v_terms := tsvector_to_array(to_tsvector('simple', left(p_question, 500)));
  if array_length(v_terms, 1) > 0 then
    v_q_simple := to_tsquery('simple', array_to_string(array(select quote_literal(t) from unnest(v_terms) t), ' | '));
  end if;
  if v_q_en is null and v_q_simple is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('question', question, 'answer', answer, 'score', round(score::numeric, 3)) order by score desc)
    from (
      select k.question, k.answer,
        coalesce(ts_rank_cd(k.tsv, v_q_en, 1), 0) + coalesce(ts_rank_cd(k.tsv, v_q_simple, 1), 0) as score
      from public.ai_knowledge k
      where k.site_id = v_site and k.active
        and ((v_q_en is not null and k.tsv @@ v_q_en) or (v_q_simple is not null and k.tsv @@ v_q_simple))
      order by score desc, k.sort
      limit least(greatest(p_limit, 1), 5)
    ) m
  ), '[]'::jsonb);
end;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function public.svc_ai_providers() from public, anon, authenticated;
revoke all on function public.svc_ai_hit(text, int) from public, anon, authenticated;
revoke all on function public.svc_ai_record(text, uuid, text, text, int, int, numeric) from public, anon, authenticated;
revoke all on function public.svc_ai_check(uuid, boolean, int, text) from public, anon, authenticated;
grant execute on function public.svc_ai_providers() to service_role;
grant execute on function public.svc_ai_hit(text, int) to service_role;
grant execute on function public.svc_ai_record(text, uuid, text, text, int, int, numeric) to service_role;
grant execute on function public.svc_ai_check(uuid, boolean, int, text) to service_role;
revoke all on function public.set_ai_provider_token(uuid, text) from public, anon;
grant execute on function public.set_ai_provider_token(uuid, text) to authenticated;
grant execute on function public.ai_widget_config(text) to anon, authenticated;
grant execute on function public.faq_answer(text, text, int) to anon, authenticated;

revoke all on public.ai_providers, public.ai_site_settings, public.ai_knowledge, public.ai_usage from anon;
-- The token reference and spend counters are never written from the browser.
revoke insert, update on public.ai_providers from authenticated;
grant insert (name, kind, base_url, model, enabled, priority, timeout_ms, max_tokens, max_spend_inr, usd_inr_rate, rpm_limit, daily_limit)
  on public.ai_providers to authenticated;
grant update (name, kind, base_url, model, enabled, priority, timeout_ms, max_tokens, max_spend_inr, usd_inr_rate, rpm_limit, daily_limit)
  on public.ai_providers to authenticated;
revoke insert, update, delete on public.ai_usage from authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.ai_providers enable row level security;
alter table public.ai_site_settings enable row level security;
alter table public.ai_knowledge enable row level security;
alter table public.ai_usage enable row level security;

create policy ai_providers_admin on public.ai_providers for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy ai_settings_select on public.ai_site_settings for select to authenticated using ((select private.can_ai(business_id)));
create policy ai_settings_insert on public.ai_site_settings for insert to authenticated with check ((select private.can_ai(private.site_business(site_id))));
create policy ai_settings_update on public.ai_site_settings for update to authenticated
  using ((select private.can_ai(business_id))) with check ((select private.can_ai(business_id)));
create policy ai_settings_delete on public.ai_site_settings for delete to authenticated using ((select private.is_admin()));

create policy ai_knowledge_select on public.ai_knowledge for select to authenticated using ((select private.can_ai(business_id)));
create policy ai_knowledge_insert on public.ai_knowledge for insert to authenticated with check ((select private.can_ai(private.site_business(site_id))));
create policy ai_knowledge_update on public.ai_knowledge for update to authenticated
  using ((select private.can_ai(business_id))) with check ((select private.can_ai(private.site_business(site_id))));
create policy ai_knowledge_delete on public.ai_knowledge for delete to authenticated using ((select private.can_ai(business_id)));

create policy ai_usage_select on public.ai_usage for select to authenticated
  using ((select private.is_admin()) or (business_id is not null and (select private.can_ai(business_id))));
