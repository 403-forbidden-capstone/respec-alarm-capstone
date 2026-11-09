-- A developer reset must also remove optional ML survey answers and any
-- service-only verification tied to that identity. The pre-existing reset
-- implementation was split into private.dev_reset_my_data_core() and
-- private.dev_reset_friend_data(uuid) in 20261109050000_friend_abuse_closing.sql.
-- Preserve the later X-SEED-03 @example.com-only guard exactly.
-- This migration is additive: never edit a previously merged migration.

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
  -- experimental codes. Updating the four survey columns also triggers
  -- invalidate_prepare_ml_verification_on_survey_change.
  update public.profiles p
     set ml_age_years = null,
         ml_school_status = null,
         ml_work_status = null,
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
