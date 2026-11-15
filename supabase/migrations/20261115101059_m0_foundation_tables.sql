-- ─────────────────────────────────────────────────────────────────────────────
-- Tomorrow Web platform — M0 foundation
-- Roles, tenants (businesses), members, sites, module switches, audit log,
-- system status, security helpers and Row-Level Security.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

-- Helper functions live in a schema the API does not expose.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, anon, service_role;

-- ── Types ────────────────────────────────────────────────────────────────────
create type public.platform_role as enum ('admin', 'user');
create type public.member_role as enum ('owner', 'manager', 'employee');

-- ── Tables ───────────────────────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text,
  role public.platform_role not null default 'user',
  must_change_password boolean not null default true,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'One row per login. role=admin is the Tomorrow Web administrator.';

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  industry text,
  preset text,
  city text,
  locality text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.businesses is 'Tenants: each client business. All client data hangs off a business.';

create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.member_role not null,
  permissions text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members (user_id);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  url text,
  repo text,
  public_key text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  allowed_origins text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sites_business_idx on public.sites (business_id);

create table public.modules (
  key text primary key,
  name text not null,
  description text not null default '',
  category text not null default 'core',
  requires text[] not null default '{}',
  -- true when the module depends on a third-party account, payment provider or billing.
  external_dependency boolean not null default false,
  dependency_note text,
  sort int not null default 100
);

create table public.module_presets (
  key text primary key,
  name text not null,
  modules text[] not null default '{}',
  sort int not null default 100
);

create table public.business_modules (
  business_id uuid not null references public.businesses (id) on delete cascade,
  module_key text not null references public.modules (key) on delete restrict,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  primary key (business_id, module_key)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  business_id uuid,
  action text not null,
  entity text,
  entity_id text,
  details jsonb not null default '{}'
);
create index audit_logs_at_idx on public.audit_logs (at desc);
create index audit_logs_business_idx on public.audit_logs (business_id, at desc);

-- Heartbeats from keep-alive and backup jobs (shown on the admin dashboard).
create table public.system_status (
  key text primary key,
  last_ok_at timestamptz,
  details jsonb not null default '{}'
);

-- Secrets that must never be readable through the API (hashes only).
create table private.settings (
  key text primary key,
  value text not null
);

-- ── Seed: modules and presets ────────────────────────────────────────────────
insert into public.modules (key, name, description, category, requires, external_dependency, dependency_note, sort) values
  ('change_requests', 'Change requests', 'Clients request changes; you quote and track them.', 'core', '{}', false, null, 10),
  ('cms', 'Content editing', 'Clients edit marked text and images on their site.', 'website', '{}', false, null, 20),
  ('blog', 'Blog', 'Blog posts written in the portal and published to the site.', 'website', '{cms}', false, null, 30),
  ('enquiries', 'Enquiry forms', 'Enquiry forms with email alerts.', 'website', '{}', false, null, 40),
  ('booking_requests', 'Booking requests', 'Visitors request a day and time; staff confirm.', 'website', '{}', false, null, 50),
  ('ai_assistant', 'AI assistant', 'Self-hosted AI chat with FAQ fallback.', 'website', '{}', true, 'Needs a self-hosted AI server for AI replies (FAQ answers work without one).', 60),
  ('orders', 'Orders', 'Order board for staff.', 'operations', '{}', false, null, 100),
  ('pos', 'Point of sale', 'Counter / tablet POS.', 'operations', '{orders}', false, null, 110),
  ('inventory', 'Inventory', 'Stock levels and movements.', 'operations', '{}', false, null, 120),
  ('restaurant', 'Restaurant tools', 'Tables, takeaway and menu management.', 'operations', '{orders}', false, null, 130),
  ('kitchen_display', 'Kitchen display', 'Live kitchen tickets by station.', 'operations', '{restaurant}', false, null, 140),
  ('retail', 'Retail tools', 'Variants, SKU/barcode and stock alerts.', 'operations', '{inventory}', false, null, 150),
  ('appointments', 'Appointments', 'Services, appointments and staff assignments.', 'operations', '{}', false, null, 160),
  ('registrations', 'Registrations', 'Sign-ups for classes, batches and events.', 'operations', '{}', false, null, 170),
  ('schedules', 'Schedules', 'Timetables and batches.', 'operations', '{}', false, null, 180),
  ('ecommerce', 'Online store', 'Catalogue, cart, checkout and order tracking.', 'commerce', '{orders,inventory}', false, null, 200),
  ('razorpay', 'Razorpay payments', 'Online payments through the client''s own Razorpay account.', 'commerce', '{orders}', true, 'Needs the client''s Razorpay account; Razorpay charges transaction fees.', 210),
  ('printify', 'Printify fulfilment', 'Print-on-demand through the brand''s own Printify account.', 'commerce', '{ecommerce}', true, 'Needs the brand''s Printify account; Printify charges production, shipping and plan fees.', 220);

insert into public.module_presets (key, name, modules, sort) values
  ('restaurant', 'Restaurant / café', '{change_requests,cms,orders,pos,restaurant,kitchen_display,inventory}', 10),
  ('clothing', 'Clothing brand', '{change_requests,cms,blog,ecommerce,inventory,orders,retail}', 20),
  ('salon', 'Salon / beauty', '{change_requests,cms,appointments,enquiries,booking_requests,ai_assistant}', 30),
  ('tutor', 'Tutor / coaching', '{change_requests,cms,blog,enquiries,booking_requests}', 40),
  ('sports_academy', 'Sports academy', '{change_requests,cms,registrations,schedules,enquiries}', 50),
  ('website_only', 'Website only', '{change_requests,cms}', 60);

