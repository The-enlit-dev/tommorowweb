-- M1: change requests, CMS content blocks, blog posts, media/attachment storage, build hooks.

-- ── Helpers ────────────────────────────────────────────────────────────────
create or replace function private.try_uuid(t text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return t::uuid;
exception when others then
  return null;
end;
$$;

-- Who may use change requests / CMS / blog for a business.
create or replace function private.can_requests(biz uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'change_requests') and private.has_perm(biz, 'settings.manage'));
$$;
create or replace function private.can_cms(biz uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'cms') and private.has_perm(biz, 'settings.manage'));
$$;
create or replace function private.can_blog(biz uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.module_on(biz, 'blog') and private.has_perm(biz, 'settings.manage'));
$$;
create or replace function private.site_business(p_site uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select business_id from public.sites where id = p_site;
$$;

-- ── Businesses / sites additions ───────────────────────────────────────────
alter table public.businesses add column is_internal boolean not null default false;
comment on column public.businesses.is_internal is 'Tomorrow Web''s own business (its website, blog).';

alter table public.sites
  add column content_published_at timestamptz,
  add column build_hook_secret_id uuid,
  add column last_build_at timestamptz,
  add column last_build_status text;
comment on column public.sites.build_hook_secret_id is 'Vault secret id of the site''s deploy/build hook URL (never stored in plain text).';

-- ── Change requests ─────────────────────────────────────────────────────────
create type public.cr_status as enum ('submitted', 'quoted', 'approved', 'in_progress', 'done', 'cancelled');
create type public.cr_payment as enum ('unpaid', 'paid', 'waived', 'not_applicable');

create table public.change_requests (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  business_id uuid not null references public.businesses (id) on delete cascade,
  site_id uuid references public.sites (id) on delete set null,
  title text not null check (length(trim(title)) between 3 and 160),
  description text not null default '' check (length(description) <= 8000),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'urgent')),
  status public.cr_status not null default 'submitted',
  price_inr numeric(10, 2) check (price_inr >= 0),
  payment_status public.cr_payment not null default 'unpaid',
  upi_ref text check (length(upi_ref) <= 60),
  quote_note text check (length(quote_note) <= 2000),
  ai_spec text check (length(ai_spec) <= 12000),
  cancel_reason text check (length(cancel_reason) <= 500),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  quoted_at timestamptz,
  approved_at timestamptz,
  done_at timestamptz,
  cancelled_at timestamptz
);
create index change_requests_biz_idx on public.change_requests (business_id, created_at desc);
create index change_requests_status_idx on public.change_requests (status, created_at desc);
comment on column public.change_requests.ai_spec is 'AI-drafted specification (labelled AI-generated in the UI; review before use).';

create table public.change_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.change_requests (id) on delete cascade,
  business_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  kind text not null,
  from_value text,
  to_value text,
  note text
);
create index cr_events_request_idx on public.change_request_events (request_id, at);

create table public.change_request_comments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.change_requests (id) on delete cascade,
  business_id uuid not null,
  author_id uuid default auth.uid() references public.profiles (id) on delete set null,
  body text not null check (length(trim(body)) between 1 and 4000),
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index cr_comments_request_idx on public.change_request_comments (request_id, created_at);

create table public.change_request_attachments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.change_requests (id) on delete cascade,
  business_id uuid not null,
  path text not null unique,
  name text not null check (length(name) <= 200),
  size_bytes bigint not null check (size_bytes between 0 and 10485760),
  mime text,
  uploaded_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index cr_attachments_request_idx on public.change_request_attachments (request_id);

-- New requests: fixed starting state no matter what the browser sends.
create or replace function private.cr_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := auth.uid();
  new.status := 'submitted';
  new.price_inr := null;
  new.payment_status := 'unpaid';
  new.upi_ref := null;
  new.quote_note := null;
  new.quoted_at := null; new.approved_at := null; new.done_at := null; new.cancelled_at := null;
  if new.site_id is not null and private.site_business(new.site_id) is distinct from new.business_id then
    raise exception 'That website belongs to another business' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger change_requests_before_insert before insert on public.change_requests
  for each row execute function private.cr_before_insert();

-- Status flow. Allowed transitions; timestamps are set by the database.
create or replace function private.cr_before_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  if new.business_id is distinct from old.business_id or new.created_by is distinct from old.created_by
     or new.number is distinct from old.number then
    raise exception 'These fields can''t be changed' using errcode = '22023';
  end if;
  if new.status is distinct from old.status then
    ok := case old.status
      when 'submitted' then new.status in ('quoted', 'in_progress', 'cancelled')
      when 'quoted' then new.status in ('approved', 'submitted', 'cancelled')
      when 'approved' then new.status in ('in_progress', 'cancelled')
      when 'in_progress' then new.status in ('done', 'cancelled')
      when 'done' then new.status in ('in_progress')
      when 'cancelled' then new.status in ('submitted')
    end;
    if not ok then
      raise exception 'A request can''t go from % to %', old.status, new.status using errcode = '22023';
    end if;
    if new.status = 'quoted' then
      if new.price_inr is null then raise exception 'Set a price before sending the quote' using errcode = '22023'; end if;
      new.quoted_at := now();
    elsif new.status = 'approved' then new.approved_at := now();
    elsif new.status = 'done' then new.done_at := now();
    elsif new.status = 'cancelled' then new.cancelled_at := now();
    end if;
  end if;
  return new;
end;
$$;
create trigger change_requests_before_update before update on public.change_requests
  for each row execute function private.cr_before_update();
create trigger change_requests_touch before update on public.change_requests
  for each row execute function private.touch_updated_at();

-- History + audit of status, price and payment changes.
create or replace function private.cr_after_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.change_request_events (request_id, business_id, actor_id, kind, to_value)
    values (new.id, new.business_id, auth.uid(), 'status', 'submitted');
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into public.change_request_events (request_id, business_id, actor_id, kind, from_value, to_value, note)
    values (new.id, new.business_id, auth.uid(), 'status', old.status::text, new.status::text,
            case when new.status = 'cancelled' then new.cancel_reason end);
  end if;
  if new.price_inr is distinct from old.price_inr then
    insert into public.change_request_events (request_id, business_id, actor_id, kind, from_value, to_value)
    values (new.id, new.business_id, auth.uid(), 'price', old.price_inr::text, new.price_inr::text);
    perform private.write_audit('change_request:price', 'change_requests', new.id::text, new.business_id,
      jsonb_build_object('number', new.number, 'before', old.price_inr, 'after', new.price_inr));
  end if;
  if new.payment_status is distinct from old.payment_status or new.upi_ref is distinct from old.upi_ref then
    insert into public.change_request_events (request_id, business_id, actor_id, kind, from_value, to_value, note)
    values (new.id, new.business_id, auth.uid(), 'payment', old.payment_status::text, new.payment_status::text, new.upi_ref);
    perform private.write_audit('change_request:payment', 'change_requests', new.id::text, new.business_id,
      jsonb_build_object('number', new.number, 'before', old.payment_status, 'after', new.payment_status, 'upi_ref', new.upi_ref));
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform private.write_audit('change_request:cancel', 'change_requests', new.id::text, new.business_id,
      jsonb_build_object('number', new.number, 'reason', new.cancel_reason));
  end if;
  return new;
end;
$$;
create trigger change_requests_after_write after insert or update on public.change_requests
  for each row execute function private.cr_after_write();

-- Comments/attachments inherit the request's business.
create or replace function private.cr_child_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  select business_id into new.business_id from public.change_requests where id = new.request_id;
  if new.business_id is null then raise exception 'Request not found' using errcode = '22023'; end if;
  if tg_table_name = 'change_request_comments' then
    new.author_id := auth.uid();
  else
    new.uploaded_by := auth.uid();
    if split_part(new.path, '/', 1) <> new.business_id::text or split_part(new.path, '/', 2) <> new.request_id::text then
      raise exception 'Attachment path must start with business/request' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger cr_comments_before_insert before insert on public.change_request_comments
  for each row execute function private.cr_child_before_insert();
create trigger cr_attachments_before_insert before insert on public.change_request_attachments
  for each row execute function private.cr_child_before_insert();

-- Client actions (approve a quote, cancel). Everything else is the administrator's.
create or replace function public.change_request_action(p_id uuid, p_action text, p_reason text default null)
returns public.change_requests language plpgsql security definer set search_path = '' as $$
declare r public.change_requests;
begin
  select * into r from public.change_requests where id = p_id for update;
  if r.id is null or not private.can_requests(r.business_id) then
    raise exception 'Request not found' using errcode = '42501';
  end if;
  if p_action = 'approve' then
    if r.status <> 'quoted' then raise exception 'Only a quoted request can be approved' using errcode = '22023'; end if;
    update public.change_requests set status = 'approved' where id = p_id returning * into r;
  elsif p_action = 'cancel' then
    if r.status not in ('submitted', 'quoted') then
      raise exception 'Work has started; ask Tomorrow Web to cancel it' using errcode = '22023';
    end if;
    update public.change_requests set status = 'cancelled', cancel_reason = left(nullif(trim(p_reason), ''), 500)
    where id = p_id returning * into r;
  else
    raise exception 'Unknown action' using errcode = '22023';
  end if;
  return r;
end;
$$;

-- ── CMS content blocks ──────────────────────────────────────────────────────
create table public.content_blocks (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  business_id uuid not null,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  label text not null check (length(trim(label)) between 1 and 120),
  kind text not null check (kind in ('text', 'richtext', 'image', 'link')),
  help text check (length(help) <= 300),
  max_length int check (max_length between 1 and 20000),
  sort int not null default 100,
  draft jsonb not null default '{}' check (octet_length(draft::text) <= 40000),
  published jsonb,
  published_at timestamptz,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, key)
);
create index content_blocks_biz_idx on public.content_blocks (business_id);

create or replace function private.content_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_len int;
begin
  new.business_id := private.site_business(new.site_id);
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' and current_setting('tw.publishing', true) is distinct from 'on' then
    new.published := null; new.published_at := null;
  end if;
  if tg_op = 'UPDATE' and not private.is_admin() then
    if (new.key, new.label, new.kind, new.help, new.max_length, new.sort, new.site_id)
       is distinct from (old.key, old.label, old.kind, old.help, old.max_length, old.sort, old.site_id) then
      raise exception 'Only Tomorrow Web can change how a content block is set up' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.published is distinct from old.published or new.published_at is distinct from old.published_at)
     and current_setting('tw.publishing', true) is distinct from 'on' then
    raise exception 'Use Publish to make content live' using errcode = '42501';
  end if;
  -- Shape check per kind.
  v_len := case new.kind
    when 'text' then length(coalesce(new.draft ->> 'text', ''))
    when 'richtext' then length(coalesce(new.draft ->> 'md', ''))
    else 0 end;
  if new.max_length is not null and v_len > new.max_length then
    raise exception '% is limited to % characters', new.label, new.max_length using errcode = '22023';
  end if;
  if new.kind = 'link' and coalesce(new.draft ->> 'href', '') !~ '^(https?://|/|#|mailto:|tel:|$)' then
    raise exception 'Links must start with https://, /, mailto: or tel:' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger content_blocks_before_write before insert or update on public.content_blocks
  for each row execute function private.content_before_write();
create trigger content_blocks_touch before update on public.content_blocks
  for each row execute function private.touch_updated_at();

create or replace function public.publish_site_content(p_site uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare v_biz uuid := private.site_business(p_site); n int;
begin
  if v_biz is null or not private.can_cms(v_biz) then
    raise exception 'You don''t have permission to publish this site' using errcode = '42501';
  end if;
  perform set_config('tw.publishing', 'on', true);
  update public.content_blocks set published = draft, published_at = now()
  where site_id = p_site and published is distinct from draft;
  get diagnostics n = row_count;
  perform set_config('tw.publishing', 'off', true);
  update public.sites set content_published_at = now() where id = p_site;
  perform private.write_audit('cms:publish', 'sites', p_site::text, v_biz, jsonb_build_object('blocks_changed', n));
  return n;
end;
$$;

-- ── Blog posts ──────────────────────────────────────────────────────────────
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  business_id uuid not null,
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  title text not null check (length(trim(title)) between 1 and 160),
  excerpt text check (length(excerpt) <= 300),
  body_md text not null default '' check (length(body_md) <= 100000),
  cover_path text,
  cover_alt text check (length(cover_alt) <= 200),
  tags text[] not null default '{}',
  seo_title text check (length(seo_title) <= 70),
  seo_description text check (length(seo_description) <= 170),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  ai_assisted boolean not null default false,
  author_id uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, slug)
);
create index posts_site_idx on public.posts (site_id, status, published_at desc);
create index posts_biz_idx on public.posts (business_id);

create or replace function private.posts_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.business_id := private.site_business(new.site_id);
  if tg_op = 'INSERT' then new.author_id := auth.uid(); end if;
  if new.status = 'published' and new.published_at is null then new.published_at := now(); end if;
  if new.cover_path is not null and split_part(new.cover_path, '/', 1) <> new.business_id::text then
    raise exception 'Cover image must be one of this business''s uploads' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger posts_before_write before insert or update on public.posts
  for each row execute function private.posts_before_write();
create trigger posts_touch before update on public.posts
  for each row execute function private.touch_updated_at();

create or replace function private.posts_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform private.write_audit('blog:delete', 'posts', old.id::text, old.business_id, jsonb_build_object('slug', old.slug, 'title', old.title));
    return old;
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    perform private.write_audit('blog:' || case when new.status = 'published' then 'publish' else 'unpublish' end,
      'posts', new.id::text, new.business_id, jsonb_build_object('slug', new.slug));
  end if;
  return new;
end;
$$;
create trigger posts_audit after update or delete on public.posts
  for each row execute function private.posts_audit();

-- ── Public read-only API for websites (published content only) ──────────────
create or replace function public.site_content(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(cb.key, cb.published || jsonb_build_object('kind', cb.kind)), '{}'::jsonb)
  from public.sites s
  join public.content_blocks cb on cb.site_id = s.id
  where s.public_key = p_key and cb.published is not null and private.module_on(s.business_id, 'cms');
$$;

create or replace function public.site_posts(p_key text, p_slug text default null, p_limit int default 100)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x ->> 'published_at' desc), '[]'::jsonb) from (
    select jsonb_strip_nulls(jsonb_build_object(
      'slug', p.slug, 'title', p.title, 'excerpt', p.excerpt, 'cover_path', p.cover_path, 'cover_alt', p.cover_alt,
      'tags', p.tags, 'seo_title', p.seo_title, 'seo_description', p.seo_description,
      'published_at', p.published_at, 'updated_at', p.updated_at,
      'body_md', case when p_slug is not null or p_limit <= 0 then p.body_md end)) as x
    from public.sites s
    join public.posts p on p.site_id = s.id
    where s.public_key = p_key and p.status = 'published' and private.module_on(s.business_id, 'blog')
      and (p_slug is null or p.slug = p_slug)
    order by p.published_at desc
    limit case when p_limit <= 0 then 500 else least(p_limit, 500) end
  ) q;
$$;
comment on function public.site_posts(text, text, int) is 'Published posts for a site key. p_limit <= 0 returns full bodies (for static builds).';

-- ── Build hooks (Vault) ─────────────────────────────────────────────────────
create or replace function public.can_manage_site(p_site uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_cms(private.site_business(p_site)) or private.can_blog(private.site_business(p_site));
$$;

create or replace function public.set_site_build_hook(p_site uuid, p_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_biz uuid := private.site_business(p_site); v_id uuid;
begin
  if v_biz is null or not (private.is_admin() or private.has_perm(v_biz, 'settings.manage')) then
    raise exception 'You don''t have permission to change this website' using errcode = '42501';
  end if;
  select build_hook_secret_id into v_id from public.sites where id = p_site;
  if nullif(trim(p_url), '') is null then
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
    update public.sites set build_hook_secret_id = null where id = p_site;
    perform private.write_audit('site:clear_build_hook', 'sites', p_site::text, v_biz, '{}');
    return;
  end if;
  if p_url !~ '^https://(api\.netlify\.com/build_hooks/|api\.vercel\.com/v1/integrations/deploy/|api\.cloudflare\.com/client/v4/pages/webhooks/deploy_hooks/)[A-Za-z0-9/_-]+$' then
    raise exception 'Use a Netlify, Vercel or Cloudflare Pages deploy hook URL' using errcode = '22023';
  end if;
  if v_id is null then
    v_id := vault.create_secret(p_url, 'site_build_hook:' || p_site::text, 'Deploy hook for site ' || p_site::text);
    update public.sites set build_hook_secret_id = v_id where id = p_site;
  else
    perform vault.update_secret(v_id, p_url);
  end if;
  perform private.write_audit('site:set_build_hook', 'sites', p_site::text, v_biz, jsonb_build_object('host', split_part(p_url, '/', 3)));
end;
$$;

-- Service-role only: lets the site-publish Edge Function read a hook URL.
create or replace function public.svc_site_build_hook(p_site uuid)
returns text language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret from public.sites s join vault.decrypted_secrets ds on ds.id = s.build_hook_secret_id where s.id = p_site;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function public.change_request_action(uuid, text, text) from public, anon;
revoke all on function public.publish_site_content(uuid) from public, anon;
revoke all on function public.can_manage_site(uuid) from public, anon;
revoke all on function public.set_site_build_hook(uuid, text) from public, anon;
revoke all on function public.svc_site_build_hook(uuid) from public, anon, authenticated;
grant execute on function public.change_request_action(uuid, text, text) to authenticated;
grant execute on function public.publish_site_content(uuid) to authenticated;
grant execute on function public.can_manage_site(uuid) to authenticated;
grant execute on function public.set_site_build_hook(uuid, text) to authenticated;
grant execute on function public.svc_site_build_hook(uuid) to service_role;
grant execute on function public.site_content(text) to anon, authenticated;
grant execute on function public.site_posts(text, text, int) to anon, authenticated;

-- Column-level write access: the browser can only send these columns.
revoke insert, update on public.change_requests from anon, authenticated;
grant insert (business_id, site_id, title, description, priority) on public.change_requests to authenticated;
grant update (site_id, title, description, priority, status, price_inr, payment_status, upi_ref, quote_note, ai_spec, cancel_reason)
  on public.change_requests to authenticated;
revoke insert, update, delete on public.change_request_events from anon, authenticated;
revoke insert, update on public.change_request_comments, public.change_request_attachments from anon, authenticated;
grant insert (request_id, body, internal) on public.change_request_comments to authenticated;
grant insert (request_id, path, name, size_bytes, mime) on public.change_request_attachments to authenticated;
revoke update on public.content_blocks from anon, authenticated;
grant update (key, label, kind, help, max_length, sort, draft) on public.content_blocks to authenticated;
revoke all on public.change_requests, public.change_request_events, public.change_request_comments,
  public.change_request_attachments, public.content_blocks, public.posts from anon;

-- ── Row-Level Security ──────────────────────────────────────────────────────
alter table public.change_requests enable row level security;
alter table public.change_request_events enable row level security;
alter table public.change_request_comments enable row level security;
alter table public.change_request_attachments enable row level security;
alter table public.content_blocks enable row level security;
alter table public.posts enable row level security;

create policy cr_select on public.change_requests for select to authenticated using ((select private.can_requests(business_id)));
create policy cr_insert on public.change_requests for insert to authenticated with check ((select private.can_requests(business_id)));
create policy cr_update on public.change_requests for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy cr_delete on public.change_requests for delete to authenticated using ((select private.is_admin()));

create policy cr_events_select on public.change_request_events for select to authenticated using ((select private.can_requests(business_id)));

create policy cr_comments_select on public.change_request_comments for select to authenticated
  using ((select private.is_admin()) or (not internal and (select private.can_requests(business_id))));
create policy cr_comments_insert on public.change_request_comments for insert to authenticated
  with check ((select private.is_admin()) or (not internal and (select private.can_requests(business_id))));

create policy cr_attachments_select on public.change_request_attachments for select to authenticated using ((select private.can_requests(business_id)));
create policy cr_attachments_insert on public.change_request_attachments for insert to authenticated with check ((select private.can_requests(business_id)));
create policy cr_attachments_delete on public.change_request_attachments for delete to authenticated using ((select private.is_admin()));

create policy content_select on public.content_blocks for select to authenticated using ((select private.can_cms(business_id)));
create policy content_insert on public.content_blocks for insert to authenticated with check ((select private.is_admin()));
create policy content_update on public.content_blocks for update to authenticated
  using ((select private.can_cms(business_id))) with check ((select private.can_cms(business_id)));
create policy content_delete on public.content_blocks for delete to authenticated using ((select private.is_admin()));

create policy posts_select on public.posts for select to authenticated using ((select private.can_blog(business_id)));
create policy posts_insert on public.posts for insert to authenticated with check ((select private.can_blog(business_id)));
create policy posts_update on public.posts for update to authenticated
  using ((select private.can_blog(business_id))) with check ((select private.can_blog(business_id)));
create policy posts_delete on public.posts for delete to authenticated using ((select private.can_blog(business_id)));

-- ── Storage buckets and policies ────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']),
  ('attachments', 'attachments', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'])
on conflict (id) do nothing;

-- media/<business_id>/…  (public read through the public URL; writes by CMS/blog editors)
create policy media_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and (select private.can_cms(private.try_uuid((storage.foldername(name))[1])) or private.can_blog(private.try_uuid((storage.foldername(name))[1]))));
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (select private.can_cms(private.try_uuid((storage.foldername(name))[1])) or private.can_blog(private.try_uuid((storage.foldername(name))[1]))));
create policy media_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and (select private.can_cms(private.try_uuid((storage.foldername(name))[1])) or private.can_blog(private.try_uuid((storage.foldername(name))[1]))));
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (select private.can_cms(private.try_uuid((storage.foldername(name))[1])) or private.can_blog(private.try_uuid((storage.foldername(name))[1]))));

-- attachments/<business_id>/<request_id>/…  (private; only people who can see the request)
create policy attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments' and (select private.can_requests(private.try_uuid((storage.foldername(name))[1]))));
create policy attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and (select private.can_requests(private.try_uuid((storage.foldername(name))[1])))
    and exists (select 1 from public.change_requests r where r.id = private.try_uuid((storage.foldername(name))[2])
                and r.business_id = private.try_uuid((storage.foldername(name))[1])));
create policy attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (select private.is_admin()));

-- ── Tomorrow Web's own website (for /blog and CMS on this site) ─────────────
with b as (
  insert into public.businesses (name, industry, city, is_internal) values ('Tomorrow Web', 'Web studio', 'Pune', true) returning id
), s as (
  insert into public.sites (business_id, name, public_key, allowed_origins)
  select id, 'tomorrowweb website', 'tw-site-7f3c9a2e5b1d', '{}' from b returning business_id
)
insert into public.business_modules (business_id, module_key, enabled)
select business_id, m, true from s, unnest(array['cms', 'blog', 'ai_assistant', 'change_requests']) m;
