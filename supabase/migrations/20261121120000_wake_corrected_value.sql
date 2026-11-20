-- 기상 정정 기록 종류 — 알람 이벤트에 WAKE_CORRECTED 추가 (11/20 지형님: D61 '판정마다 1탭 정정', 앱 [아니에요])
--   값만 더함. 이 값을 쓰는 규칙(확정 지우기 · 자동 판정 재시도 막기 · 하루 기록 비우기 · 새로 고침 신호)은 다음 파일(wake_correction)이 함
--   같은 트랜잭션에서는 새 값을 쓸 수 없어서 파일을 나눔
alter type public.alarm_event_type add value if not exists 'WAKE_CORRECTED';
