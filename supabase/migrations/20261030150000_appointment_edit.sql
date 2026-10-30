-- =====================================================================
-- 일정 수정 · 삭제 ① 회차 예외 표시 (L1 PR 4b, 이슈 #276 — 설계 메모 L1_PR3_설계메모.md 6절 "PR 4(이번만 / 이후 모두)와 맞물림")
--   ① 예외 칸      appointments.exception_kind — 반복 일정에서 "이번만" 고친(EDITED) · 지운(CANCELED) 회차 표시
--   ② 기준 회차    roll_due_series가 예외 회차를 기준 회차(이어받는 쪽)로 안 씀 — "이번만 고친" 값이 다음 회차들로 번지지 않게
-- 서버 함수 appointment-edit · 앱 화면(L5) · 앱 실서버 연결은 이 파일 밖. 이 파일만 먼저 들어가도 지금 동작은 그대로 (모든 행의 exception_kind가 NULL)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 예외 칸
-- ---------------------------------------------------------------------
-- 값: NULL = 보통 회차 · 'EDITED' = 이번만 고친 회차 · 'CANCELED' = 이번만 지운 회차(행은 두고 알람만 지움)
-- 행을 안 지우는 이유: 지우면 alarm-roll이 그 날짜(occurrence_on)를 다시 만듦 → 행을 두고 날짜 자리를 차지하게 함 (유니크 (creator_id, series_id, occurrence_on))
-- 읽는 쪽 약속: 앱 H01 · H02는 CANCELED 회차를 숨김 (exception_kind is distinct from 'CANCELED'). 알람 행은 이미 지워져서 알람에서 읽는 곳(기상 판정 · 그룹 기상 · R02)은 영향 없음
-- 기존 행은 모두 NULL (기본값 없음 = NULL이라 안전). text + check로 둔 이유: 값을 더할 때 enum 타입 변경(트랜잭션 제약) 없이 check만 바꾸면 됨
-- L6 안건후보: 예외 표시 칸 이름 · 값 기본안 = appointments.exception_kind ('EDITED' | 'CANCELED'), 회차 행에 직접 (별도 표 없음 — roll이 이미 가진 키 (series_id, occurrence_on)로 충분)

alter table public.appointments
  add column if not exists exception_kind text
  constraint appointments_exception_kind_check check (exception_kind in ('EDITED', 'CANCELED'));

comment on column public.appointments.exception_kind is '반복 일정의 이번만 예외 표시 — NULL 보통 회차 · EDITED 이번만 고친 회차(다음 회차의 기준 · 이후 모두 고치기에서 빠짐) · CANCELED 이번만 지운 회차(행은 두고 알람만 지움, 앱 H01 · H02는 숨김, alarm-roll이 그 날짜를 다시 안 만듦)';


-- ---------------------------------------------------------------------
-- 2. roll_due_series — 기준 회차에서 예외 회차를 뺌
-- ---------------------------------------------------------------------
-- 20261029075743_alarm_roll.sql의 함수와 같고, APPOINTMENT 줄의 두 군데만 다름 (create or replace — 이전 파일은 그대로 둠):
--   · 기준 회차(template_id · 규칙 · 공동 약속 여부) = 예외 아닌 회차 중 occurrence_on이 가장 늦은 행. 없으면 이번만 고친(EDITED) 회차 중 가장 늦은 행(예외뿐인 묶음이 멈추지 않게),
--     이번만 지운(CANCELED) 회차는 기준이 되지 않음 (알람이 없어서 이어받을 것이 없음)
--   · 다음 회차 시각(due_at)을 세는 기준은 예외까지 포함한 가장 늦은 행 — 이미 14일치가 차 있는 묶음을 매번 후보로 안 올리려고
-- 나머지(STANDALONE · ROUTINE · 재시도 · 정렬 · 한도)는 이전 정의 그대로

create or replace function public.roll_due_series(p_now timestamptz default now(), p_limit integer default 50)
returns table (
  user_id     uuid,
  series_id   uuid,
  kind        text,
  template_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with latest_appointment as (
    select distinct on (a.creator_id, a.series_id)
           a.creator_id, a.series_id, a.appointment_at, a.occurrence_on
    from public.appointments a
    order by a.creator_id, a.series_id, a.occurrence_on desc, a.appointment_at desc, a.appointment_id
  ),
  base_appointment as (
    select distinct on (a.creator_id, a.series_id)
           a.creator_id, a.series_id, a.appointment_id, a.recurrence_rule, a.group_id
    from public.appointments a
    where a.exception_kind is distinct from 'CANCELED'
    order by a.creator_id, a.series_id, (a.exception_kind is not null), a.occurrence_on desc, a.appointment_at desc, a.appointment_id
  ),
  latest_standalone as (
    select distinct on (al.user_id, al.series_id)
           al.user_id, al.series_id, al.alarm_id, al.scheduled_at, al.occurrence_on, al.recurrence_rule
    from public.alarms al
    where al.series_id is not null   -- 일정 없는 알람만 series_id를 가짐
    order by al.user_id, al.series_id, al.occurrence_on desc, al.scheduled_at desc, al.alarm_id
  ),
  pending as (
    select ra.user_id,
           ra.series_id,
           bool_or(ra.next_try_at > p_now) as waiting,
           bool_or(ra.next_try_at <= p_now and ra.occurrence_on >= (p_now at time zone 'UTC')::date - 1) as retry_due
    from public.roll_attempts ra
    where not ra.skipped
    group by ra.user_id, ra.series_id
  ),
  due as (
    select l.creator_id as user_id,
           l.series_id,
           'APPOINTMENT'::text as kind,
           b.appointment_id as template_id,
           l.appointment_at + g.gap * interval '1 day' as due_at
    from latest_appointment l
    join base_appointment b on b.creator_id = l.creator_id and b.series_id = l.series_id
    cross join lateral (select private.roll_next_gap(b.recurrence_rule, l.occurrence_on) as gap) g
    left join pending pd on pd.user_id = l.creator_id and pd.series_id = l.series_id
    where g.gap is not null
      and b.group_id is null
      and not coalesce(pd.waiting, false)
      and (l.appointment_at + g.gap * interval '1 day' < p_now + interval '14 days' or coalesce(pd.retry_due, false))

    union all

    select s.user_id,
           s.series_id,
           'STANDALONE'::text,
           s.alarm_id,
           s.scheduled_at + g.gap * interval '1 day'
    from latest_standalone s
    cross join lateral (select private.roll_next_gap(s.recurrence_rule, s.occurrence_on) as gap) g
    where g.gap is not null
      and s.scheduled_at + g.gap * interval '1 day' < p_now + interval '14 days'

    union all

    select r.user_id,
           r.routine_id,
           'ROUTINE'::text,
           r.routine_id,
           min(al.scheduled_at)
    from public.routines r
    join public.alarms al on al.routine_id = r.routine_id
    where r.is_active
      and private.roll_has_days(r.repeat_days)
      and al.is_enabled
      and al.scheduled_at < p_now
    group by r.user_id, r.routine_id
  )
  select d.user_id, d.series_id, d.kind, d.template_id
  from due d
  order by d.due_at, d.user_id, d.series_id
  limit p_limit;
$$;

-- 실행 권한은 create or replace가 이전 그대로 이어 가지만, 이 파일만 봐도 알 수 있게 다시 적음 (서비스 키만)
revoke execute on function public.roll_due_series(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.roll_due_series(timestamptz, integer) to service_role;
