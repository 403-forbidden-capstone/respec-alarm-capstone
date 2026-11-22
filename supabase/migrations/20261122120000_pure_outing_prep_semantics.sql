-- Pure outing preparation time is distinct from legacy wake -> departure time.
-- Additive-only migration. Existing rows intentionally remain NULL; never
-- backfill from default_prepare_minutes or appointment_participants.prepare_minutes.
-- This migration must be applied BEFORE clients select the new columns.
alter table public.profiles
  add column if not exists default_outing_prep_minutes integer,
  add constraint profiles_outing_prep_minutes_range
    check (default_outing_prep_minutes is null
           or default_outing_prep_minutes between 5 and 240);

comment on column public.profiles.default_outing_prep_minutes is
  'User-confirmed pure outing preparation duration (prepare start -> physical departure), minutes. NULL means not yet supplied. Do not infer from legacy wake-to-departure default_prepare_minutes.';

alter table public.appointment_participants
  add column if not exists outing_prep_minutes integer,
  add column if not exists outing_prep_source text,
  add column if not exists outing_prep_model text,
  add constraint appointment_participants_outing_prep_minutes_range
    check (outing_prep_minutes is null or outing_prep_minutes between 5 and 240),
  add constraint appointment_participants_outing_prep_source_valid
    check (outing_prep_source is null or outing_prep_source in ('PROFILE','MANUAL','MODEL','HISTORY')),
  add constraint appointment_participants_outing_prep_pair
    check ((outing_prep_minutes is null) = (outing_prep_source is null));

comment on column public.appointment_participants.outing_prep_minutes is
  'Pure preparation interval, separate from legacy prepare_minutes (wake-to-departure). NULL = no new-semantics value.';
comment on column public.appointment_participants.outing_prep_source is
  'Source provenance for outing_prep_minutes: PROFILE, MANUAL, MODEL or HISTORY.';
comment on column public.appointment_participants.outing_prep_model is
  'Model identifier for MODEL-sourced pure prep duration; no model artifact stored here.';

-- Existing RLS policies on profiles/appointment_participants remain in force.
-- No permission grants, no historical data backfill, no model rollout.
