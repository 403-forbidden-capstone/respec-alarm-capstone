-- 알람 음성 브리핑 정책 변경 (feat/AI-alarm-voice-briefing)
-- ① 새 일정 중요도 기본값 NORMAL → LOW(약). 시험 · 면접 같은 명확한 중요 일정만 서버 · 앱이 제목으로 HIGH (_shared/calc/importance.ts)
--    이미 있는 일정의 중요도는 그대로 (기본값만 바뀜). 알람 세기 · 배경음 · 진동 규칙(D69)도 그대로
alter table public.appointments alter column importance set default 'LOW';

-- ② ai_calls.point에 'AV'(알람 긴급 음성 Gemini TTS, alarm-briefing) 추가 — 한도를 기존 대화 · Live와 따로 세려고 지점을 나눔
--    주의: 'LV'(Live 토큰) 지점을 더하는 다른 브랜치(feat/37-DB-ai-calls-point-live)와 같은 제약을 고침 — 나중에 머지하는 쪽이 두 값을 모두 넣어야 함
alter table public.ai_calls drop constraint ai_calls_point_check;
alter table public.ai_calls
  add constraint ai_calls_point_check check (point in ('T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4', 'TT', 'AV'));
comment on column public.ai_calls.point is '호출 지점: T1 대화 답 · T2F 빠른 추출 · T2 끝 추출 · T3 이유 태그 · T4 일기(대화 없는 날) · T5 일기 · 코칭 · 응원 · E4 추천 비서 · TT 시간표 사진 읽기 · AV 알람 긴급 음성(Gemini TTS)';
