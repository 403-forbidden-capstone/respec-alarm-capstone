-- =====================================================================
-- 기상 뒤 할 일 계획 (PR #546 보완) — appointment_participants.activity_plan
--   기상 → 할 일(집에서 온라인 회의 등) → 준비 → 출발을 계산한 일정은 저장 뒤 다시 계산(일정 · 알람 수정, 7.1.3 재판정, 되돌리기)에서도
--   같은 할 일 순서를 복원해야 함. prepare_minutes(이날 기상~출발) · 알람 간격만으로는 할 일의 시각 · 순서를 되찾을 수 없어서 따로 둠
--   모양(서버 calc/day.ts activityPlanJson · activityPlanOf):
--     { "lead_minutes": 20,                      첫 할 일 전에 필요한 시간 (분)
--       "items": [ { "title": "온라인 회의",
--                    "start": "2026-11-19T01:00:00.000Z", "end": "2026-11-19T02:00:00.000Z",
--                    "before_prepare": true,         true = 기상 → 할 일 → 준비, false = 준비 → 할 일 → 출발
--                    "source": "USER" } ] }          USER(사용자가 말함) · ESTIMATED(짐작)
--   어느 일정의 계획인지 = 이 참여 조건 행(약속 · 사용자). 다른 사람 행은 기존 RLS(본인 행만)로 못 봄 · 참여 조건을 지우면 같이 사라짐
-- 왜 참여 조건의 칸인가 (별도 표가 아니라):
--   · 알람 계획 값(prepare_minutes · buffer_minutes · prepare_advance_minutes)이 모두 이 행에 있고, 저장(alarm_commit_apply)이 이 행을 칸 목록 그대로 씀 → DB 함수를 안 고침
--   · 재계산 경로(일정 수정 · 재판정 · 되돌리기 · 당김 적용)가 이미 이 행을 읽음 → 읽는 칸만 더함. 별도 표면 RLS · 지우기 · 저장 함수 표 목록을 새로 맞춰야 함
--   · 할 일은 한 계획에 몇 개(최대 5)뿐이고 따로 찾을 일이 없음
-- 반복 일정 + 할 일은 서버가 받지 않음(그날 시각이라 다음 회차로 옮길 규칙이 아직 없음) → alarm-roll은 이 칸을 읽지도 쓰지도 않음
-- 추가만 함: 칸은 null 허용 · 기본값 없음 → 기존 행은 null(할 일 없음) 그대로, 데이터를 고치거나 지우지 않음
-- =====================================================================

alter table public.appointment_participants
  add column activity_plan jsonb;

-- 모양 검사는 겉모양만 (객체 · items 배열 1~5개 · lead_minutes 0~240 숫자). 항목 칸은 서버가 요청을 읽을 때 검사함
--   coalesce(…, false): 칸이 빠지면 jsonb_typeof가 NULL이 되고 CHECK는 NULL을 통과로 보므로 거짓으로 바꿈
--   case로 순서를 정함 — 객체 · 배열 · 숫자인지 먼저 보고 나서 길이 · 값을 읽음 (and는 계산 순서를 보장하지 않아 배열이 아닌 값에 jsonb_array_length 오류가 날 수 있음)
alter table public.appointment_participants
  add constraint appointment_participants_activity_plan_shape check (
    activity_plan is null or coalesce(
      case
        when jsonb_typeof(activity_plan) = 'object'
         and jsonb_typeof(activity_plan -> 'items') = 'array'
         and jsonb_typeof(activity_plan -> 'lead_minutes') = 'number'
        then jsonb_array_length(activity_plan -> 'items') between 1 and 5
         and (activity_plan ->> 'lead_minutes')::numeric between 0 and 240
        else false
      end,
      false)
  );

comment on column public.appointment_participants.activity_plan is
  '기상 뒤 할 일 계획 { lead_minutes, items: [{ title, start, end, before_prepare, source }] } — 기상 → 할 일 → 준비 → 출발 계산(서버 calc/day.ts)을 다시 계산할 때 복원. null = 할 일 없음. 할 일이 걸친 날의 기상~출발 실측은 준비 학습에 안 씀(앱 participantTimes)';
