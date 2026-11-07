-- ai_calls.point에 'LV'(Gemini Live 음성 대화 토큰 발급) 추가 — 서버 함수 voice-live-token (D7 실시간 음성, #37)
-- 토큰 발급 한 번이 한 줄: 사용자별 하루 발급 한도(10번)를 이 줄 수로 셈. 토큰 · 대화 글은 남기지 않으므로 io는 늘 NULL, session_id도 NULL
-- 기존 줄은 그대로 통과하는 제약 완화라 되돌릴 때는 'LV' 줄을 먼저 지우고 옛 제약을 다시 걸면 됨

alter table public.ai_calls drop constraint ai_calls_point_check;
alter table public.ai_calls
  add constraint ai_calls_point_check check (point in ('T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4', 'TT', 'LV'));

comment on column public.ai_calls.point is '호출 지점: T1 대화 답 · T2F 빠른 추출 · T2 끝 추출 · T3 이유 태그 · T4 일기(대화 없는 날) · T5 일기 · 코칭 · 응원 · E4 추천 비서 · TT 시간표 사진 읽기 · LV 실시간 음성(Gemini Live) 토큰 발급';
