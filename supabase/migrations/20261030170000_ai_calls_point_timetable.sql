-- ai_calls.point에 'TT'(시간표 사진 읽기) 추가 — 서버 함수 timetable-extract (D66-1 A 캡처)
-- 대화에 속하지 않는 호출이라 session_id는 NULL로 남김. 사진도 읽은 글도 저장하지 않으므로 io는 늘 NULL
-- 기존 줄은 그대로 통과하는 제약 완화라 되돌릴 때는 'TT' 줄을 먼저 지우고 옛 제약을 다시 걸면 됨

alter table public.ai_calls drop constraint ai_calls_point_check;
alter table public.ai_calls
  add constraint ai_calls_point_check check (point in ('T1', 'T2F', 'T2', 'T3', 'T4', 'T5', 'E4', 'TT'));

comment on column public.ai_calls.point is '호출 지점: T1 대화 답 · T2F 빠른 추출 · T2 끝 추출 · T3 이유 태그 · T4 일기(대화 없는 날) · T5 일기 · 코칭 · 응원 · E4 추천 비서 · TT 시간표 사진 읽기';
