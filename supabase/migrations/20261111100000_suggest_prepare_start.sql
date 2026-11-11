-- 알람 조정 제안 (ALG-07) 1단계 — 준비 시작 시각 · 일정별 적용분 · 제안 종류
--   근거: 기록 · 제안 문서 "알람 조정 제안 · 기록 이해하기" 안건 초안 D111 (1 당기는 알람 = 준비 알람, 3 준비 시작 = 루틴 첫 단계)
--         docs/decisions.md D6 A (제안 종류에 시각 조정 추가) · D25 A (적용분은 자동 예측과 따로 일정 단위) · D24 C (무시 뒤 실측 3번)
--   규칙 계산은 supabase/functions/_shared/calc/suggest.ts (#464). 이 파일은 저장 자리만 — 새벽 배치(#49) · 알람 계산 반영 · 앱 기록은 다음 PR
--
-- 1. 준비 시작 시각 — 제안 근거의 "실제 준비" = 출발(departed_at) − 준비 시작
--    출처: ROUTINE_STEP = 루틴 첫 단계를 시작한 시각, PREPARE_ALARM = 루틴이 없을 때 준비 알람을 끈 시각. 둘 다 없으면 비워 두고 그날은 근거에서 뺌
--    쓰기: 주인이 앱에서 바로 씀 (departed_at과 같음 — appointment_participants_update_own 정책 그대로, 새 정책 없음)
-- 2. 일정별 적용분 (D25 A) — 받아들인 준비 알람 당김 분의 합. 자동 예측(prepare_minutes · P80)과 따로 둠
--    알람 계산: 준비 알람 = 출발 − (예측 준비 + 적용분). 준비 전 시간이 모자라면 모자란 만큼 기상도 (D111 2번 B) — plan-core 반영은 다음 PR
--    반복 일정은 회차마다 행이 따로라(series_id · occurrence_on), alarm-roll이 새 회차를 만들 때 이 값을 이어받아야 함 — 다음 PR
-- 3. 제안 종류 PREPARE_ADVANCE (D6 A) — current_value · suggested_value · result_value = 적용분(분, 글자)
--    evidence = 근거 잔차 배열(분, 오래된 → 최근) — S01 "최근 3번 +10 · +14 · +12분"
--    무시 뒤 다시 제안(D24 C)은 칸 없이 배치가 셈: 마지막 IGNORED 제안의 responded_at 뒤에 준비 시작이 기록된 회차가 3번 쌓였는지

-- ---------------------------------------------------------------------
-- 1. 준비 시작 시각 · 출처
-- ---------------------------------------------------------------------
create type public.prepare_start_source as enum ('ROUTINE_STEP', 'PREPARE_ALARM');

alter table public.appointment_participants
  add column prepare_started_at      timestamptz,
  add column prepare_started_source  public.prepare_start_source,
  add column prepare_advance_minutes integer not null default 0;

alter table public.appointment_participants
  add constraint appointment_participants_prepare_source_needs_time check (prepare_started_source is null or prepare_started_at is not null),
  add constraint appointment_participants_prepare_time_needs_source check (prepare_started_at is null or prepare_started_source is not null),
  -- 0 ~ 120분: 한 번에 D62 상한(하루 10분 · 주 5분)만큼씩만 쌓이므로 넉넉한 방어 상한 (근거 없음 — 작성자 판단)
  add constraint appointment_participants_prepare_advance_range check (prepare_advance_minutes between 0 and 120);

comment on column public.appointment_participants.prepare_started_at is '준비 시작 시각 — 루틴 첫 단계 시작, 없으면 준비 알람을 끈 시각 (안건 초안 D111 3번). 실제 준비 = departed_at − 이 값';
comment on column public.appointment_participants.prepare_started_source is 'ROUTINE_STEP · PREPARE_ALARM';
comment on column public.appointment_participants.prepare_advance_minutes is '받아들인 준비 알람 당김 분의 합 — 자동 예측과 따로 (D25 A). 반복 새 회차가 이어받음';

-- ---------------------------------------------------------------------
-- 3. 제안 종류 · 근거
-- ---------------------------------------------------------------------
alter type public.alarm_suggestion_type add value if not exists 'PREPARE_ADVANCE';

alter table public.alarm_suggestions
  add column evidence jsonb;

alter table public.alarm_suggestions
  add constraint alarm_suggestions_evidence_is_array check (evidence is null or jsonb_typeof(evidence) = 'array');

comment on column public.alarm_suggestions.evidence is '근거 잔차(분) 배열, 오래된 → 최근 — PREPARE_ADVANCE의 "최근 3번 +10 · +14 · +12분"';
