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

-- The developer reset must also clear the new field. Otherwise the
-- profiles_ml_survey_consistency CHECK rejects the all-null age/consent reset
-- for test users who previously answered the holiday pattern question.
-- Keep the historical test-account guard, other-user scoping and grants.
create or replace function public.dev_reset_my_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text;
  v_friend  jsonb;
  v_result  jsonb;
begin
  if v_uid is null then
    raise exception '로그인이 필요함' using errcode = '42501';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null or v_email not like '%@example.com' then
    raise exception '시험 계정만 쓸 수 있음' using errcode = '42501';
  end if;

  -- Keep the existing relationship/alarm/profile reset order and JSON shape.
  v_friend := private.dev_reset_friend_data(v_uid);
  v_result := private.dev_reset_my_data_core();

  -- Drop the trusted server-side mapping regardless of whether the client
  -- survey was ever filled in; do not modify any other user's mapping.
  delete from public.prepare_ml_verified_profiles where user_id = v_uid;

  -- Reset voluntary consented answers and the obsolete client-writable
  -- experimental codes. Updating the survey columns also triggers
  -- invalidate_prepare_ml_verification_on_survey_change.
  update public.profiles p
     set ml_age_years = null,
         ml_school_status = null,
         ml_work_status = null,
         ml_holiday_code = null,
         ml_profile_consented_at = null,
         ml_age_code = null,
         ml_education_code = null,
         ml_economic_code = null,
         ml_codes_verified = false
   where p.user_id = v_uid;

  return v_result || jsonb_build_object('friend_data', v_friend);
end;
$$;

comment on function public.dev_reset_my_data() is
  '시험 계정 전용: 기존 내 시험 데이터·관계 초기화에 ML 사용자 설문·동의·검증 정보 삭제를 추가. 다른 사용자 행은 유지.';

revoke all on function public.dev_reset_my_data() from public, anon;
grant execute on function public.dev_reset_my_data() to authenticated;
