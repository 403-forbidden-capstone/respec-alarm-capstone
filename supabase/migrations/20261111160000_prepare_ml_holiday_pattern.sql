-- Optional self-reported weekly rest-day pattern for C1/W4.
-- The official 2024 Time Use Survey's 휴일종류코드 describes regular days off,
-- NOT the requested appointment date's public holiday status.
-- Client answers must NEVER directly populate protected verified codes.
alter table public.profiles
  add column ml_holiday_code text
  constraint profiles_ml_holiday_code_check
  check (ml_holiday_code in ('1','2','3','4','5','6'));

-- Any change to the self-report/consent invalidates previous server approval.
create or replace function public.invalidate_prepare_ml_verification_on_survey_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (old.ml_age_years, old.ml_school_status, old.ml_work_status,
      old.ml_holiday_code, old.ml_profile_consented_at)
    is distinct from
     (new.ml_age_years, new.ml_school_status, new.ml_work_status,
      new.ml_holiday_code, new.ml_profile_consented_at)
  then
    delete from public.prepare_ml_verified_profiles where user_id = new.user_id;
  end if;
  return new;
end;
$$;

revoke all on function public.invalidate_prepare_ml_verification_on_survey_change()
  from public, anon, authenticated;

-- The trigger was created with the previous column list; update its firing
-- conditions to cover the new optional holiday field too.
drop trigger if exists profiles_ml_survey_verification_invalidate on public.profiles;
create trigger profiles_ml_survey_verification_invalidate
  after update of ml_age_years, ml_school_status, ml_work_status,
                  ml_holiday_code, ml_profile_consented_at
  on public.profiles
  for each row execute function public.invalidate_prepare_ml_verification_on_survey_change();

-- A holiday response is allowed only with the age survey and explicit consent.
alter table public.profiles drop constraint if exists profiles_ml_survey_consistency;
alter table public.profiles
  add constraint profiles_ml_survey_consistency check (
    (ml_age_years is null and ml_school_status is null and ml_work_status is null
      and ml_holiday_code is null and ml_profile_consented_at is null)
    or
    (ml_age_years is not null and ml_profile_consented_at is not null)
  );

-- Service-only approved holiday code; nullable for users without an answer.
alter table public.prepare_ml_verified_profiles
  add column ml_holiday_code text
  constraint prepare_ml_verified_holiday_code_check
  check (ml_holiday_code in ('1','2','3','4','5','6'));

comment on column public.profiles.ml_holiday_code is
  'Optional user response: 2024 Time Use Survey weekly rest-day type (1–6), NOT official verified model input.';
comment on column public.prepare_ml_verified_profiles.ml_holiday_code is
  'Service-only verified rest-day code; null uses CatBoost __MISSING__ after separate consent/codebook approval.';
