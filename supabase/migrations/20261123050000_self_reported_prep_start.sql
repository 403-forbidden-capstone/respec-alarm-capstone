-- Optional self-reported physical preparation-start pilot.
-- This self-report is not independently verified physical activity.
-- Keep existing PREPARE_ALARM data untouched.
alter table public.appointment_participants
  add column if not exists self_reported_prep_started_at timestamptz;

comment on column public.appointment_participants.self_reported_prep_started_at is
  'Server-received time of user "I am starting preparation now" tap. Self-reported, not device-verified. Independent of PREPARE_ALARM dismissal.';

-- Existing authenticated users can update their own appointment participant
-- rows through PostgREST. A public RPC alone cannot prevent a direct REST
-- column update. The trigger protects BOTH RPC and direct writes.
create or replace function private.guard_self_reported_prep_start()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $guard$
declare
  v_user uuid := (select auth.uid());
  v_now timestamptz := now();
begin
  if tg_op = 'INSERT' then
    if new.self_reported_prep_started_at is not null then
      raise exception 'self_report_insert_not_allowed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.self_reported_prep_started_at is not distinct from old.self_reported_prep_started_at then
    return new;
  end if;
  if old.self_reported_prep_started_at is not null then
    raise exception 'self_report_immutable' using errcode = '42501';
  end if;
  if new.self_reported_prep_started_at is null
    or v_user is null
    or v_user <> 'f60d371e-63a5-4fb9-9d92-0743392325ec'::uuid
    or new.user_id <> v_user
    or old.user_id <> v_user
    or new.appointment_id <> old.appointment_id
    or old.departed_at is not null
    or new.departed_at is not null
    or not exists (
      select 1 from public.appointments as a
      where a.appointment_id = old.appointment_id
        and a.group_id is null
        and a.appointment_at between v_now - interval '1 hour' and v_now + interval '3 hours'
    )
    or not exists (
      select 1 from public.alarms as al
      where al.participant_id = old.participant_id
        and al.user_id = v_user
        and al.alarm_type = 'PREPARE'
        and al.is_enabled
    )
  then
    raise exception 'self_report_not_eligible' using errcode = '42501';
  end if;
  -- Any client-supplied timestamp is discarded. Original first tap wins.
  new.self_reported_prep_started_at := v_now;
  return new;
end;
$guard$;

-- Trigger helper is never a public RPC. A trigger can invoke this function
-- without granting external users EXECUTE on the helper.
revoke all on function private.guard_self_reported_prep_start()
  from public, anon, authenticated;

create trigger guard_self_reported_prep_start
before insert or update of self_reported_prep_started_at
on public.appointment_participants
for each row
execute function private.guard_self_reported_prep_start();

-- SECURITY INVOKER inherits appointment_participants RLS and never bypasses
-- participant ownership. Extra pilot UUID restriction is a defense in depth.
create or replace function public.confirm_prep_start_self_report(
  p_appointment_id uuid
) returns timestamptz
language plpgsql
security invoker
set search_path to ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_now timestamptz := now();
  v_time timestamptz;
begin
  if v_user is null or v_user <> 'f60d371e-63a5-4fb9-9d92-0743392325ec'::uuid then
    raise exception 'pilot_not_available' using errcode = '42501';
  end if;
  if p_appointment_id is null then
    raise exception 'invalid_appointment' using errcode = '22023';
  end if;
  update public.appointment_participants as p
  set self_reported_prep_started_at = v_now
  from public.appointments as a
  where a.appointment_id = p.appointment_id
    and p.appointment_id = p_appointment_id
    and p.user_id = v_user
    and a.group_id is null
    and a.appointment_at between v_now - interval '1 hour' and v_now + interval '3 hours'
    and p.departed_at is null
    and p.self_reported_prep_started_at is null
    and exists (
      select 1 from public.alarms as al
      where al.participant_id = p.participant_id
        and al.user_id = v_user
        and al.alarm_type = 'PREPARE'
        and al.is_enabled
    )
  returning p.self_reported_prep_started_at into v_time;
  if v_time is not null then return v_time; end if;

  -- Repeated taps are idempotent; never reveal other users' appointments.
  select p.self_reported_prep_started_at into v_time
  from public.appointment_participants as p
  join public.appointments as a on a.appointment_id = p.appointment_id
  where p.appointment_id = p_appointment_id and p.user_id = v_user
    and a.group_id is null;
  if v_time is not null then return v_time; end if;
  raise exception 'prep_start_not_eligible' using errcode = '22023';
end;
$$;
revoke all on function public.confirm_prep_start_self_report(uuid) from public, anon;
grant execute on function public.confirm_prep_start_self_report(uuid) to authenticated;
