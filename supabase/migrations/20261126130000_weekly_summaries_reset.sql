-- 내 시험 데이터 지우기(dev_reset_my_data)에 주간 AI 요약 캐시(weekly_summaries)를 더함
-- 20261126120000_weekly_summaries.sql은 이미 운영에 적용돼 고치지 않고 새 마이그레이션으로 함수만 다시 만듦
-- 나머지 본문은 20261120090000_routine_suggestions.sql 4절과 같음
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

  -- 루틴 제안(20261120090000)도 시험 데이터로 지움 — 알람 조정 제안과 같음. 받아들여 만든 루틴은 그대로(루틴은 남기는 표)
  delete from public.routine_suggestions where user_id = v_uid;

  -- 주간 AI 요약 캐시(20261126120000)도 시험 데이터로 지움 — 일기를 지우므로 그 요약도 남기지 않음
  delete from public.weekly_summaries where user_id = v_uid;

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

revoke all on function public.dev_reset_my_data() from public, anon;
grant execute on function public.dev_reset_my_data() to authenticated;
