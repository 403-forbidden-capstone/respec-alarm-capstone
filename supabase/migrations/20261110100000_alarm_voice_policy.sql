-- 알람 음성 브리핑 정책 변경 (feat/AI-alarm-voice-briefing)
-- ① 새 일정 중요도 기본값 NORMAL → LOW(약). 시험 · 면접 같은 명확한 중요 일정만 서버 · 앱이 제목으로 HIGH (_shared/calc/importance.ts)
--    이미 있는 일정의 중요도는 그대로 (기본값만 바뀜). 알람 세기 · 배경음 · 진동 규칙(D69)도 그대로
alter table public.appointments alter column importance set default 'LOW';

-- ② ai_calls.point에 'AV'(알람 긴급 음성 Gemini TTS, alarm-briefing) 추가 — 한도를 기존 대화 · Live와 따로 세려고 지점을 나눔
--    'LV'(Live 토큰 발급)도 같이 허용: feat/37-DB-ai-calls-point-live의 20261107120000_ai_calls_point_live.sql이 같은 제약을 'LV'까지로 다시 걸므로,
--    이 파일(시각이 더 늦어 그 뒤에 돎)이 'LV'를 빼면 Live 기록이 막힘. 그 브랜치가 머지되기 전 · 후 어느 쪽이어도 결과는 같은 목록
--    (그 파일만 이 파일보다 나중에 돌리면(--include-all 등 순서 어긋남) 'AV'가 빠짐 → 예약 함수가 실패해 Gemini 없이 Android TTS로만 읽음 — 알람은 그대로)
alter table public.ai_calls drop constraint if exists ai_calls_point_check;
alter table public.ai_calls
  add constraint ai_calls_point_check check (point in ('T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4', 'TT', 'LV', 'AV'));
comment on column public.ai_calls.point is '호출 지점: T1 대화 답 · T2F 빠른 추출 · T2 끝 추출 · T3 이유 태그 · T4 일기(대화 없는 날) · T5 일기 · 코칭 · 응원 · E4 추천 비서 · TT 시간표 사진 읽기 · LV 실시간 음성(Gemini Live) 토큰 발급 · AV 알람 긴급 음성(Gemini TTS)';

-- ③ 알람 긴급 음성 호출 예약 — 한도 확인과 기록을 한 트랜잭션에서 (동시 요청이 함께 통과하지 않게)
--    전역 자문 잠금으로 예약을 한 줄씩 처리 → 세기 → 넘으면 null, 아니면 'RESERVED' 줄(ok = false, attempts 0)을 넣고 call_id
--    이 줄도 한도에 셈(실패 · 429 포함). 호출이 끝나면 서버가 같은 줄을 결과로 고침(ok · error_code · latency_ms · attempts 1)
--    모델 이름과 상관없이 'AV' 지점 전체로 셈 (모든 Gemini TTS 모델 통합 한도). 서버(service_role)만 부름
create or replace function public.reserve_alarm_tts(
  p_user_id uuid,
  p_model text,
  p_day_limit integer,
  p_minute_limit integer,
  p_user_day_limit integer
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('reserve_alarm_tts'));
  if (select count(*) from public.ai_calls where point = 'AV' and created_at >= now() - interval '24 hours') >= p_day_limit
    or (select count(*) from public.ai_calls where point = 'AV' and created_at >= now() - interval '1 minute') >= p_minute_limit
    or (select count(*) from public.ai_calls where point = 'AV' and user_id = p_user_id and created_at >= now() - interval '24 hours') >= p_user_day_limit
  then
    return null;
  end if;
  insert into public.ai_calls (user_id, point, prompt_id, prompt_version, model, ok, error_code, latency_ms, attempts)
  values (p_user_id, 'AV', 'ALARM_TTS', 'v1', p_model, false, 'RESERVED', 0, 0)
  returning call_id into v_id;
  return v_id;
end;
$$;

revoke all on function public.reserve_alarm_tts(uuid, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_alarm_tts(uuid, text, integer, integer, integer) to service_role;

create index if not exists idx_ai_calls_av_time on public.ai_calls (created_at) where point = 'AV';
