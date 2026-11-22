-- Preserve provenance of the LEGACY whole wake-to-departure prepare_minutes
-- while old clients continue to send manual-looking numeric snapshots.
-- Existing rows: LEGACY, never reclassify as AUTO without user confirmation.
alter table public.appointment_participants
  add column if not exists prepare_value_source text not null default 'LEGACY',
  add constraint appointment_participants_prepare_value_source_check
  check (prepare_value_source in ('LEGACY','AUTO','MANUAL'));
comment on column public.appointment_participants.prepare_value_source is
  'Source of legacy wake-to-departure prepare_minutes; LEGACY means historical unknown. Separate from outing_prep_source (pure preparation).';
