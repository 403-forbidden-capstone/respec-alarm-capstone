-- ML 관리자가 명시적으로 지정한 시험 계정 한 명만 승인합니다.
-- 앱 저장/동의만으로 자동 승인하지 않습니다. 운영 ML 플래그는 계속 0입니다.
-- private 스키마는 Data API에 노출하지 않습니다. service_role/DB 관리자 전용.
create or replace function private.approve_prepare_ml_test_profile(
  p_user_id uuid,
  p_expected_email text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_age smallint;
  v_holiday text;
  v_school text;
  v_work text;
  v_consent timestamptz;
  v_age_code text;
begin
  if p_user_id is null or nullif(btrim(p_expected_email), '') is null then
    raise exception '테스트 사용자 UUID와 확인용 이메일이 필요함' using errcode = '22023';
  end if;

  -- 사용자 입력 변경/동의 철회와 승인 INSERT를 같은 트랜잭션에서 직렬화.
  -- 업데이트는 프로필 행 잠금이 끝나야 진행되며, 변경 트리거가 승인을 삭제함.
  select lower(u.email), p.ml_age_years, p.ml_holiday_code,
         p.ml_school_status, p.ml_work_status, p.ml_profile_consented_at
    into v_email, v_age, v_holiday, v_school, v_work, v_consent
    from public.profiles p
    join auth.users u on u.id = p.user_id
   where p.user_id = p_user_id
   for update of p;

  if not found or v_email is null or
     v_email <> lower(btrim(p_expected_email)) or
     v_email !~ '^demo-[a-z0-9._+-]+@example[.]com$' then
    raise exception '등록된 데모 시험 계정과 이메일이 정확히 일치해야 함'
      using errcode = '42501';
  end if;

  if v_consent is null or v_consent > statement_timestamp() or
     v_age is null or v_age not between 14 and 100 or
     v_school is not null or v_work is not null or
     (v_holiday is not null and v_holiday !~ '^[1-6]$') then
    raise exception '유효한 ML 연구 동의/연령/휴무 응답이 없음'
      using errcode = '22023';
  end if;

  -- 2024 생활시간조사 코드북: 10대=1, ... 70대=7, 80대 이상=8.
  -- 휴일종류코드는 약속일 공휴일 여부가 아니라 평소 정기 휴무 형태.
  v_age_code := least(8, (v_age / 10))::text;

  insert into public.prepare_ml_verified_profiles
    (user_id, ml_age_code, ml_holiday_code, codebook_version, consent_at, verified_at)
  values
    (p_user_id, v_age_code, v_holiday,
     '2024-time-use-age-holiday-v1', v_consent, statement_timestamp())
  on conflict (user_id) do update
    set ml_age_code = excluded.ml_age_code,
        ml_holiday_code = excluded.ml_holiday_code,
        codebook_version = excluded.codebook_version,
        consent_at = excluded.consent_at,
        verified_at = excluded.verified_at;

  return true;
end;
$$;

-- SECURITY DEFINER는 기본 PUBLIC EXECUTE를 반드시 차단.
revoke all on function private.approve_prepare_ml_test_profile(uuid, text)
  from public, anon, authenticated;
grant execute on function private.approve_prepare_ml_test_profile(uuid, text)
  to service_role;

comment on function private.approve_prepare_ml_test_profile(uuid, text) is
  '수동 승인 전용: 현재 동의한 demo-*@example.com 시험 계정 1명만 2024 연령/휴무 코드로 매핑. 일반 사용자 자동 승인 금지.';

-- 실제 추론은 별도 PREPARE_ML_ENABLED=1 + 정확한 UUID allowlist +
-- PREPARE_ML_CODEBOOK_VERSION 일치 + EC2 HTTPS 모델 연결을 모두 요구함.
