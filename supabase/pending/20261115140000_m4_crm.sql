-- M4: Sales CRM on top of Lead Finder leads (administrator only; clients never see it).

alter table public.leads
  add column stage text not null default 'new'
    check (stage in ('new', 'researched', 'contacted', 'interested', 'meeting', 'proposal_sent', 'negotiation', 'won', 'lost')),
  add column stage_changed_at timestamptz not null default now(),
  add column estimated_value_inr numeric(10, 2) check (estimated_value_inr >= 0),
  add column last_contacted_at timestamptz,
  add column next_follow_up_at timestamptz,
  add column lost_reason text check (length(lost_reason) <= 300),
  add column converted_business_id uuid references public.businesses (id) on delete set null;
create index leads_stage_idx on public.leads (stage);
create index leads_follow_up_idx on public.leads (next_follow_up_at) where next_follow_up_at is not null;

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  kind text not null check (kind in ('call', 'whatsapp', 'email', 'meeting', 'note', 'stage_change', 'proposal')),
  body text check (length(body) <= 4000),
  outcome text check (length(outcome) <= 200),
  happened_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index lead_activities_lead_idx on public.lead_activities (lead_id, happened_at desc);

create table public.lead_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  due_at timestamptz not null,
  done_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index lead_tasks_due_idx on public.lead_tasks (due_at) where done_at is null;

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  amount_inr numeric(10, 2) not null check (amount_inr >= 0),
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected')),
  notes text check (length(notes) <= 4000),
  sent_at timestamptz,
  decided_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index proposals_lead_idx on public.proposals (lead_id);

create or replace function private.stage_rank(s text) returns int language sql immutable set search_path = '' as $$
  select array_position(array['new', 'researched', 'contacted', 'interested', 'meeting', 'proposal_sent', 'negotiation', 'won', 'lost'], s);
$$;

-- Stage history.
create or replace function private.lead_stage_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.stage is distinct from old.stage then
    new.stage_changed_at := now();
    if new.stage <> 'lost' then new.lost_reason := null; end if;
    insert into public.lead_activities (lead_id, kind, body, outcome)
    values (new.id, 'stage_change', case when new.stage = 'lost' then new.lost_reason end, old.stage || ' → ' || new.stage);
  end if;
  return new;
end;
$$;
create trigger leads_stage_changed before update of stage on public.leads for each row execute function private.lead_stage_changed();

-- Contact attempts: blocked for do-not-contact leads; update last contacted; move "new/researched" to "contacted".
create or replace function private.lead_activity_before()
returns trigger language plpgsql security definer set search_path = '' as $$
declare l public.leads;
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  if new.kind in ('call', 'whatsapp', 'email', 'meeting') then
    select * into l from public.leads where id = new.lead_id;
    if l.do_not_contact then
      raise exception 'This business asked not to be contacted' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger lead_activities_before before insert on public.lead_activities for each row execute function private.lead_activity_before();

create or replace function private.lead_activity_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind in ('call', 'whatsapp', 'email', 'meeting') then
    update public.leads set
      last_contacted_at = greatest(coalesce(last_contacted_at, new.happened_at), new.happened_at),
      stage = case when stage in ('new', 'researched') then 'contacted' else stage end
    where id = new.lead_id;
  end if;
  return null;
end;
$$;
create trigger lead_activities_after after insert on public.lead_activities for each row execute function private.lead_activity_after();

-- Next follow-up = earliest open task.
create or replace function private.lead_tasks_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_lead uuid := coalesce(new.lead_id, old.lead_id);
begin
  update public.leads set next_follow_up_at = (select min(due_at) from public.lead_tasks where lead_id = v_lead and done_at is null) where id = v_lead;
  return null;
end;
$$;
create trigger lead_tasks_changed after insert or update or delete on public.lead_tasks for each row execute function private.lead_tasks_changed();

-- Proposals: timestamps, history, and pipeline advance.
create or replace function private.proposal_before()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'sent' and new.sent_at is null then new.sent_at := now(); end if;
    if new.status in ('accepted', 'rejected') then new.decided_at := now(); new.sent_at := coalesce(new.sent_at, now()); end if;
    if new.status = 'draft' then new.decided_at := null; end if;
  end if;
  return new;
end;
$$;
create trigger proposals_before before insert or update on public.proposals for each row execute function private.proposal_before();
create trigger proposals_touch before update on public.proposals for each row execute function private.touch_updated_at();

create or replace function private.proposal_after()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.lead_activities (lead_id, kind, body, outcome)
    values (new.lead_id, 'proposal', new.title || ' — ₹' || new.amount_inr, 'proposal ' || new.status);
    if new.status = 'sent' then
      update public.leads set stage = 'proposal_sent', estimated_value_inr = coalesce(estimated_value_inr, new.amount_inr)
      where id = new.lead_id and private.stage_rank(stage) < private.stage_rank('proposal_sent');
    elsif new.status = 'accepted' then
      update public.leads set stage = 'won', estimated_value_inr = new.amount_inr where id = new.lead_id and stage <> 'won';
    end if;
  end if;
  return null;
end;
$$;
create trigger proposals_after after insert or update on public.proposals for each row execute function private.proposal_after();

create or replace function private.lead_converted_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.converted_business_id is distinct from old.converted_business_id and new.converted_business_id is not null then
    perform private.write_audit('lead:converted', 'leads', new.id::text, new.converted_business_id, jsonb_build_object('lead', new.name));
  end if;
  return new;
end;
$$;
create trigger leads_converted_audit after update of converted_business_id on public.leads for each row execute function private.lead_converted_audit();

-- ── Security ────────────────────────────────────────────────────────────────
revoke all on public.lead_activities, public.lead_tasks, public.proposals from anon;
revoke update on public.lead_activities from authenticated; -- history is append-only (deleting a mistaken note is allowed)
do $$
declare t text;
begin
  foreach t in array array['lead_activities', 'lead_tasks', 'proposals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t || '_admin', t);
  end loop;
end $$;
create policy lead_activities_no_history_delete on public.lead_activities as restrictive for delete to authenticated
  using (kind in ('note', 'call', 'whatsapp', 'email', 'meeting'));
