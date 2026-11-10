-- Optional self-reported survey answers; these are NOT official CatBoost category codes.
-- User-controlled data is isolated from server-owned prepare_ml_verified_profiles.
-- Never mark survey answers as verified without a separate, audited mapping workflow.
alter table public.profiles
  add column ml_age_years smallint,
  add column ml_school_status text,
  add column ml_work_status text,
  add column ml_profile_consented_at timestamptz,
  add constraint profiles_ml_age_years_check check (ml_age_years between 14 and 100),
  add constraint profiles_ml_school_status_check check
    (ml_school_status in ('MIDDLE_HIGH', 'UNIVERSITY', 'GRADUATE_SCHOOL', 'NOT_ENROLLED', 'OTHER')),
  add constraint profiles_ml_work_status_check check
    (ml_work_status in ('WORKING', 'NOT_WORKING', 'OTHER')),
  add constraint profiles_ml_survey_consistency check (
    (ml_age_years is null and ml_school_status is null and ml_work_status is null and ml_profile_consented_at is null)
    or
    (ml_age_years is not null and ml_school_status is not null and ml_work_status is not null and ml_profile_consented_at is not null)
  );

comment on column public.profiles.ml_age_years is
  'Optional consented self-reported age; not the survey 연령코드.';
comment on column public.profiles.ml_school_status is
  'Optional self-reported current school attendance; not the official 교육재학코드.';
comment on column public.profiles.ml_work_status is
  'Optional self-reported work status; not the official 경제활동상태코드.';
comment on column public.profiles.ml_profile_consented_at is
  'Timestamp of optional ML survey data collection consent; revoke by clearing all four fields.';

-- Changing/revoking self-reported answers invalidates any prior verified mapping.
-- Run under migration owner privileges so end users cannot bypass revocation
-- via the RLS-protected server-only verified-profile table.
create or replace function public.invalidate_prepare_ml_verification_on_survey_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (old.ml_age_years, old.ml_school_status, old.ml_work_status, old.ml_profile_consented_at)
    is distinct from
     (new.ml_age_years, new.ml_school_status, new.ml_work_status, new.ml_profile_consented_at)
  then
    delete from public.prepare_ml_verified_profiles where user_id = new.user_id;
  end if;
  return new;
end;
$$;

revoke all on function public.invalidate_prepare_ml_verification_on_survey_change() from public, anon, authenticated;
create trigger profiles_ml_survey_verification_invalidate
  after update of ml_age_years, ml_school_status, ml_work_status, ml_profile_consented_at
  on public.profiles
  for each row execute function public.invalidate_prepare_ml_verification_on_survey_change();
